import { config } from './config.js';
import { findSongs, findProvider, getResult, searchProviders } from './search.js';

export const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

const parseTime = (str) => {
  if (!str) return NaN;
  const parts = str.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};

// strip BBCode so titles can't break the chat formatting
const esc = (s) => String(s ?? '').replace(/[[\]]/g, '');

const HELP = [
  ['play <link | search>', 'add a YouTube/Spotify/direct link or search YouTube  (alias /p)'],
  ['playnext <link | search>', 'add to the front of the queue  (alias /pn)'],
  ['search <words>', 'show search results to choose from  (alias /find, /f)'],
  ['pick <n> [n ...]', 'add result #n of your last search, e.g. /pick 2 or /pick 1 3 5  (alias /choose)'],
  ['picknext <n>', 'like /pick, but plays next'],
  ['pause / resume', 'pause or continue playback'],
  ['skip', 'skip the current song  (alias /s)'],
  ['stop', 'stop and clear the whole queue'],
  ['np', 'show the song that is playing now'],
  ['queue [page]', 'show the queue  (alias /q)'],
  ['remove <n>', 'remove song #n from the queue  (alias /rm)'],
  ['move <from> <to>', 'move a song to a new position'],
  ['up <n> / down <n> / top <n>', 'move song #n up, down or to the top'],
  ['shuffle', 'shuffle the queue'],
  ['clear', 'remove all upcoming songs'],
  ['vol [0-100]', 'show or set the volume  (alias /volume)'],
  ['seek <m:ss>', 'jump to a time in the song'],
  ['join', 'make the bot come to your channel'],
  ['web', 'link to the web interface'],
];

export function createCommandHandler(ts, music) {
  const P = config.commandPrefix;
  const lastSearch = new Map(); // invoker unique id -> result ids of their last /search

  const commands = {
    async help() {
      return '[b]Music bot commands:[/b]\n' + HELP.map(([c, d]) => `[b]${P}${c}[/b] - ${d}`).join('\n');
    },

    async play(args, msg) {
      if (!args) {
        if (music.player.paused) return music.resume(), 'Resumed.';
        return `Usage: ${P}play <YouTube / Spotify / direct link or search words>`;
      }
      return addSongs(args, msg, false);
    },

    async playnext(args, msg) {
      if (!args) return `Usage: ${P}playnext <link or search words>`;
      return addSongs(args, msg, true);
    },

    async search(args, msg) {
      const providers = searchProviders();
      let [first, ...rest] = (args || '').split(/\s+/);
      let provider = null;
      if (providers.length > 1 && rest.length && findProvider(first)) provider = first;
      else rest = [first, ...rest];
      const query = rest.join(' ').trim();
      if (!query) {
        const hint = providers.length > 1 ? ` (start with ${providers.map((p) => p.aliases?.[0] || p.id).join(' / ')} to choose the site)` : '';
        return `Usage: ${P}search <words>${hint}`;
      }
      const found = await findSongs(query, provider);
      if (!found.results.length) return `Nothing found on ${found.provider.label} for [b]${esc(query)}[/b].`;
      lastSearch.set(msg.invokerUID, found.results.map((r) => r.id));
      const lines = found.results.map((r, i) => `[b]${i + 1}.[/b] ${esc(r.title)} [${r.duration ? fmtTime(r.duration) : '?'}]`);
      return `[b]${found.provider.label} results for "${esc(query)}"[/b] - choose with ${P}pick <number>\n${lines.join('\n')}`;
    },

    async pick(args, msg) {
      return pickResults(args, msg, false);
    },

    async picknext(args, msg) {
      return pickResults(args, msg, true);
    },

    async pause() {
      return music.pause() ? 'Paused.' : 'Nothing is playing.';
    },

    async resume() {
      return music.resume() ? 'Resumed.' : 'Nothing is paused.';
    },

    async skip() {
      const t = music.skip();
      return t ? `Skipped [b]${esc(t.title)}[/b].` : 'Nothing is playing.';
    },

    async stop() {
      music.stop();
      return 'Stopped and cleared the queue.';
    },

    async np() {
      const s = music.state();
      if (!s.current) return s.loading ? 'Loading the next song...' : 'Nothing is playing.';
      const c = s.current;
      const dur = c.isLive ? 'live' : `${fmtTime(c.position)} / ${fmtTime(c.duration)}`;
      const link = c.url ? ` - [url=${c.url}]link[/url]` : '';
      return `${c.paused ? 'Paused' : 'Now playing'}: [b]${esc(c.title)}[/b] [${dur}]${link}`;
    },

    async queue(args) {
      const s = music.state();
      const per = 15;
      const pages = Math.max(1, Math.ceil(s.queue.length / per));
      const page = Math.min(pages, Math.max(1, parseInt(args, 10) || 1));
      const lines = [];
      if (s.current) lines.push(`[b]Now:[/b] ${esc(s.current.title)}`);
      if (!s.queue.length) lines.push('The queue is empty.');
      s.queue.slice((page - 1) * per, page * per).forEach((item, i) => {
        const n = (page - 1) * per + i + 1;
        const tag = item.status === 'downloading' ? ' (loading)' : item.status === 'error' ? ' (error)' : '';
        lines.push(`[b]${n}.[/b] ${esc(item.title)} [${item.duration ? fmtTime(item.duration) : '?'}]${tag}`);
      });
      if (pages > 1) lines.push(`Page ${page}/${pages} - ${s.queue.length} songs. Use ${P}queue <page>`);
      return lines.join('\n');
    },

    async remove(args) {
      const n = parseInt(args, 10);
      const item = music.remove(n);
      return item ? `Removed [b]${esc(item.title)}[/b].` : `Usage: ${P}remove <number from ${P}queue>`;
    },

    async move(args) {
      const [from, to] = (args || '').split(/\s+/).map((x) => parseInt(x, 10));
      if (!from || !to) return `Usage: ${P}move <from> <to>`;
      const r = music.move(from, to - 1);
      return r ? `Moved [b]${esc(r.item.title)}[/b] to #${r.to + 1}.` : 'No song at that position.';
    },

    async up(args) {
      const r = music.up(parseInt(args, 10));
      return r ? `Moved [b]${esc(r.item.title)}[/b] to #${r.to + 1}.` : `Usage: ${P}up <number>`;
    },

    async down(args) {
      const r = music.down(parseInt(args, 10));
      return r ? `Moved [b]${esc(r.item.title)}[/b] to #${r.to + 1}.` : `Usage: ${P}down <number>`;
    },

    async top(args) {
      const r = music.top(parseInt(args, 10));
      return r ? `[b]${esc(r.item.title)}[/b] plays next.` : `Usage: ${P}top <number>`;
    },

    async shuffle() {
      music.shuffle();
      return 'Shuffled the queue.';
    },

    async clear() {
      music.clear();
      return 'Cleared the queue.';
    },

    async vol(args) {
      if (!args) return `Volume: ${music.player.volume}%`;
      const v = parseInt(args.replace('%', ''), 10);
      if (!Number.isFinite(v) || v < 0 || v > 100) return `Usage: ${P}vol <0-100>`;
      return `Volume set to ${music.setVolume(v)}%.`;
    },

    async seek(args) {
      const t = parseTime(args);
      if (!Number.isFinite(t)) return `Usage: ${P}seek <m:ss>  (e.g. ${P}seek 1:30)`;
      return music.seek(t) ? `Jumped to ${fmtTime(t)}.` : 'Cannot seek right now.';
    },

    async join(_args, msg) {
      const cid = await ts.channelOf(msg.invokerID);
      await ts.moveTo(cid);
      return null;
    },

    async web() {
      return `Web interface: [url]${config.web.publicUrl}[/url]`;
    },
  };

  const aliases = {
    p: 'play', pn: 'playnext', find: 'search', f: 'search', choose: 'pick', next: 'skip', s: 'skip', continue: 'resume', unpause: 'resume',
    q: 'queue', list: 'queue', nowplaying: 'np', current: 'np', rm: 'remove', delete: 'remove',
    volume: 'vol', v: 'vol', come: 'join', summon: 'join', link: 'web', h: 'help', commands: 'help',
  };

  function pickResults(args, msg, next) {
    const ids = lastSearch.get(msg.invokerUID);
    if (!ids) return `Search first with ${P}search <words>, then pick a number.`;
    const nums = /^all$/i.test(args) ? ids.map((_, i) => i + 1) : (args || '').split(/[\s,]+/).map((x) => parseInt(x, 10)).filter(Boolean);
    if (!nums.length) return `Usage: ${P}${next ? 'picknext' : 'pick'} <number from your last ${P}search>`;
    const bad = nums.find((n) => n < 1 || n > ids.length);
    if (bad) return `There is no result #${bad}. Pick a number from 1 to ${ids.length}.`;
    const entries = nums.map((n) => getResult(ids[n - 1]));
    if (entries.some((e) => !e)) return `Those results expired. Search again with ${P}search.`;
    const items = music.addEntries(entries, { addedBy: msg.invokerName, next });
    return replyAdded(items, next);
  }

  async function addSongs(args, msg, next) {
    const items = await music.add(args, { addedBy: msg.invokerName, next });
    return replyAdded(items, next);
  }

  function replyAdded(items, next) {
    if (items.length === 1) {
      const pos = next ? 1 : music.queue.indexOf(items[0]) + 1;
      return pos > 0 && music.current
        ? `Added [b]${esc(items[0].title)}[/b] to the queue (#${pos}).`
        : `Loading [b]${esc(items[0].title)}[/b]...`;
    }
    return `Added [b]${items.length}[/b] songs to the queue.`;
  }

  return async function onText(msg) {
    const text = msg.message.trim();
    if (!text.startsWith(P)) return;
    const [, name, rest] = text.slice(P.length).match(/^(\S+)\s*([\s\S]*)$/) || [];
    if (!name) return;
    const cmd = aliases[name.toLowerCase()] || name.toLowerCase();
    const fn = commands[cmd];
    if (!fn) return ts.reply(msg, `Unknown command. Type ${P}help for a list.`);
    console.log(`[cmd] ${msg.invokerName}: ${text}`);
    try {
      const out = await fn(rest.trim(), msg);
      if (out) await ts.reply(msg, out);
    } catch (e) {
      await ts.reply(msg, `[color=red]Error:[/color] ${esc(e.message)}`);
    }
  };
}
