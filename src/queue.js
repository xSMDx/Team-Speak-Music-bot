import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { resolve, download, probeFile } from './sources.js';

const STATE_FILE = path.join(config.dataDir, 'state.json');
const MAX_PARALLEL_DOWNLOADS = 2;
const newId = () => crypto.randomBytes(6).toString('hex');

const PUBLIC_FIELDS = ['id', 'title', 'source', 'url', 'duration', 'thumbnail', 'status', 'error', 'addedBy', 'addedAt', 'isLive'];
const pick = (item) => Object.fromEntries(PUBLIC_FIELDS.map((k) => [k, item[k] ?? null]));

/**
 * The queue. Songs are downloaded shortly before they are needed, played,
 * and their file is deleted as soon as they finish (or are skipped/removed).
 */
export class MusicManager extends EventEmitter {
  constructor(ts, player) {
    super();
    this.ts = ts;
    this.player = player;
    this.queue = [];
    this.current = null;
    this.downloads = new Map(); // id -> AbortController
    this.saveTimer = null;

    player.on('end', (track) => this.#finished(track));
    player.on('error', (track, reason) => {
      console.warn(`[player] failed to play "${track?.title}": ${reason}`);
      this.emit('announce', `[color=red]Could not play[/color] ${track?.title}: ${reason}`);
      this.#finished(track);
    });

    this.#load();
  }

  // ---------------------------------------------------------- adding

  async add(input, { addedBy = 'web', next = false } = {}) {
    const entries = await resolve(input);
    const items = entries.map((e) => ({
      ...e,
      id: newId(),
      status: e.streamUrl ? 'ready' : 'pending',
      addedBy,
      addedAt: Date.now(),
    }));
    this.#insert(items, next);
    return items;
  }

  /** files: [{ path, originalname }] already stored in the upload folder */
  async addUploads(files, { addedBy = 'web', next = false } = {}) {
    const added = [];
    const failed = [];
    for (const f of files) {
      const info = await probeFile(f.path);
      if (!info.ok) {
        fs.rm(f.path, { force: true }, () => {});
        failed.push(f.originalname);
        continue;
      }
      const base = f.originalname.replace(/\.[^.]+$/, '');
      added.push({
        id: newId(),
        title: info.title ? (info.artist ? `${info.artist} - ${info.title}` : info.title) : base,
        source: 'upload',
        url: null,
        file: f.path,
        duration: info.duration,
        status: 'ready',
        addedBy,
        addedAt: Date.now(),
      });
    }
    if (added.length) this.#insert(added, next);
    return { added, failed };
  }

  #insert(items, next) {
    if (next) this.queue.unshift(...items);
    else this.queue.push(...items);
    this.#changed();
    this.#prefetch();
    this.#playNextIfIdle();
  }

  // ---------------------------------------------------------- downloading

  #prefetch() {
    const wanted = this.queue.slice(0, Math.max(1, config.prefetch));
    for (const item of wanted) {
      if (this.downloads.size >= MAX_PARALLEL_DOWNLOADS) break;
      if (item.status === 'pending') this.#download(item);
    }
  }

  async #download(item) {
    const ac = new AbortController();
    this.downloads.set(item.id, ac);
    item.status = 'downloading';
    this.#changed();
    try {
      const file = await download(
        item,
        (info) => {
          if (info.title && item.source !== 'spotify') item.title = info.title;
          if (info.duration) item.duration = Math.round(info.duration);
          if (info.thumbnail) item.thumbnail = info.thumbnail;
          if (info.webpage_url && item.source === 'search') item.url = info.webpage_url;
          this.#changed();
        },
        ac.signal,
      );
      if (!this.#exists(item)) {
        // removed while downloading
        fs.rm(file, { force: true }, () => {});
        return;
      }
      item.file = file;
      if (!item.duration) item.duration = (await probeFile(file)).duration || 0;
      item.status = 'ready';
    } catch (e) {
      if (!ac.signal.aborted) {
        console.warn(`[download] "${item.title}" failed: ${e.message}`);
        item.status = 'error';
        item.error = e.message;
      }
    } finally {
      this.downloads.delete(item.id);
      this.#changed();
      this.#prefetch();
      this.#playNextIfIdle();
    }
  }

  #exists(item) {
    return this.current === item || this.queue.includes(item);
  }

  // ---------------------------------------------------------- playback

  #playNextIfIdle() {
    if (this.current) return;
    while (this.queue.length) {
      const head = this.queue[0];
      if (head.status === 'error') {
        this.queue.shift();
        this.emit('announce', `[color=red]Skipped[/color] ${head.title}: ${head.error}`);
        this.#deleteMedia(head);
        continue;
      }
      if (head.status !== 'ready') {
        // wait for the download to finish; #download calls us again
        if (head.status === 'pending') this.#download(head);
        this.#changed();
        return;
      }
      this.queue.shift();
      this.current = head;
      this.current.startedAt = Date.now();
      this.player.play(head);
      this.emit('nowPlaying', head);
      this.#changed();
      this.#prefetch();
      return;
    }
    this.#changed();
  }

  #finished(track) {
    if (track) this.#deleteMedia(track);
    if (this.current === track) this.current = null;
    this.#changed();
    this.#playNextIfIdle();
  }

  skip() {
    if (!this.current) return null;
    const track = this.current;
    this.player.stop();
    this.#finished(track);
    return track;
  }

  stop() {
    this.player.stop();
    if (this.current) this.#deleteMedia(this.current);
    this.current = null;
    this.clear();
  }

  pause() {
    const ok = this.player.pause();
    this.#changed();
    return ok;
  }

  resume() {
    const ok = this.player.resume();
    this.#changed();
    return ok;
  }

  togglePause() {
    return this.player.paused ? this.resume() : this.pause();
  }

  seek(seconds) {
    const ok = this.player.seek(seconds);
    this.#changed();
    return ok;
  }

  setVolume(v) {
    const vol = this.player.setVolume(v);
    this.#changed();
    return vol;
  }

  // ---------------------------------------------------------- queue editing

  #index(ref) {
    if (typeof ref === 'number') return ref >= 1 && ref <= this.queue.length ? ref - 1 : -1;
    return this.queue.findIndex((i) => i.id === ref);
  }

  /** ref = item id or 1-based position */
  remove(ref) {
    const idx = this.#index(ref);
    if (idx < 0) return null;
    const [item] = this.queue.splice(idx, 1);
    this.#cancel(item);
    this.#changed();
    this.#prefetch();
    this.#playNextIfIdle();
    return item;
  }

  /** Move item to a 0-based position in the queue. */
  move(ref, toIndex) {
    const idx = this.#index(ref);
    if (idx < 0) return null;
    const to = Math.max(0, Math.min(this.queue.length - 1, toIndex));
    const [item] = this.queue.splice(idx, 1);
    this.queue.splice(to, 0, item);
    this.#changed();
    this.#prefetch();
    this.#playNextIfIdle();
    return { item, from: idx, to };
  }

  up(ref) {
    const idx = this.#index(ref);
    return idx < 0 ? null : this.move(ref, idx - 1);
  }

  down(ref) {
    const idx = this.#index(ref);
    return idx < 0 ? null : this.move(ref, idx + 1);
  }

  top(ref) {
    return this.move(ref, 0);
  }

  clear() {
    for (const item of this.queue) this.#cancel(item);
    this.queue = [];
    this.#changed();
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.#changed();
    this.#prefetch();
    this.#playNextIfIdle();
  }

  #cancel(item) {
    this.downloads.get(item.id)?.abort();
    this.downloads.delete(item.id);
    this.#deleteMedia(item);
  }

  /** Deletes the song's file - but only files we own (downloads/uploads). */
  #deleteMedia(item) {
    if (!item.file) return;
    const file = path.resolve(item.file);
    const owned = [config.mediaDir, config.uploadDir].some((d) => file.startsWith(path.resolve(d) + path.sep));
    if (owned) fs.rm(file, { force: true }, (e) => e && console.warn('[queue] could not delete', file, e.message));
    item.file = null;
  }

  // ---------------------------------------------------------- state

  state() {
    const cur = this.current;
    const loading = !cur && this.queue[0] && this.queue[0].status !== 'ready';
    return {
      current: cur ? { ...pick(cur), position: this.player.position, paused: this.player.paused } : null,
      loading: !!loading,
      queue: this.queue.map(pick),
      volume: this.player.volume,
      bot: this.ts.status(),
    };
  }

  #changed() {
    this.emit('change');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.#save(), 500);
  }

  #save() {
    const strip = ({ startedAt, ...rest }) => rest;
    const items = [...(this.current ? [this.current] : []), ...this.queue].map(strip);
    const data = { volume: this.player.volume, items };
    fs.writeFile(STATE_FILE + '.tmp', JSON.stringify(data), (err) => {
      if (!err) fs.rename(STATE_FILE + '.tmp', STATE_FILE, () => {});
    });
  }

  #load() {
    let data = { items: [] };
    try {
      data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {}
    if (Number.isFinite(data.volume)) this.player.volume = data.volume;

    for (const item of data.items || []) {
      if (item.file && !fs.existsSync(item.file)) item.file = null;
      if (item.status === 'downloading' || (item.status === 'ready' && !item.file && !item.streamUrl)) item.status = 'pending';
      if (item.source === 'upload' && !item.file) continue; // upload is gone, can't re-fetch
      this.queue.push(item);
    }

    // delete leftover files no queued song refers to
    const keep = new Set(this.queue.map((i) => i.file && path.resolve(i.file)).filter(Boolean));
    for (const dir of [config.mediaDir, config.uploadDir]) {
      for (const name of fs.readdirSync(dir)) {
        const f = path.resolve(dir, name);
        if (!keep.has(f)) fs.rmSync(f, { force: true, recursive: true });
      }
    }
    if (this.queue.length) console.log(`[queue] restored ${this.queue.length} queued song(s)`);
  }

  /** Start playing restored songs once the bot is connected. */
  startup() {
    this.#prefetch();
    this.#playNextIfIdle();
  }
}
