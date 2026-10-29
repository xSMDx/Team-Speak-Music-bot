import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { OggOpusDemuxer } from './ogg.js';
import { config } from './config.js';

const FRAME_MS = 20;
const BUFFER_HIGH = 250; // ~5s of audio buffered ahead
const BUFFER_LOW = 100;

/**
 * Decodes a file/URL with ffmpeg into Opus frames and sends them to TeamSpeak
 * in real time (one 20ms frame every 20ms). Holds while the bot is offline so
 * a reconnect resumes the song where it stopped.
 */
export class Player extends EventEmitter {
  constructor(ts) {
    super();
    this.ts = ts;
    this.volume = config.audio.defaultVolume;
    this.track = null;
    this.paused = false;
    this.#reset();
  }

  #reset() {
    this.ffmpeg = null;
    this.demux = null;
    this.packets = [];
    this.sourceEnded = false;
    this.offset = 0; // seconds into the track where the current ffmpeg run started
    this.sent = 0; // frames sent in the current run
    this.timer = null;
    this.baseTime = 0;
    this.gen = (this.gen ?? 0) + 1;
  }

  get playing() {
    return !!this.track;
  }

  get position() {
    return this.offset + (this.sent * FRAME_MS) / 1000;
  }

  play(track, startAt = 0) {
    this.#kill();
    this.track = track;
    this.paused = false;
    this.#start(startAt);
  }

  #start(startAt) {
    this.#reset();
    const gen = this.gen;
    const track = this.track;
    this.offset = startAt;
    const input = track.file || track.streamUrl;
    const isHttp = /^https?:\/\//i.test(input);

    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (isHttp) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    if (startAt > 0) args.push('-ss', String(startAt));
    args.push(
      '-i', input,
      '-vn',
      '-af', `volume=${(this.volume / 100) ** 2 * 2}`,
      '-c:a', 'libopus', '-b:a', `${config.audio.bitrate}k`, '-vbr', 'on',
      '-application', 'audio', '-frame_duration', String(FRAME_MS),
      '-ar', '48000', '-ac', '2',
      '-f', 'ogg', 'pipe:1',
    );

    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.ffmpeg = ff;
    let stderr = '';
    ff.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    ff.on('error', (e) => {
      if (gen === this.gen) this.#fail(`ffmpeg failed to start: ${e.message}`);
    });
    ff.on('close', (code) => {
      if (gen !== this.gen) return;
      if (code && code !== 255 && this.sent === 0 && this.packets.length === 0) {
        this.#fail(stderr.trim().split('\n').pop() || `ffmpeg exited with code ${code}`);
      }
    });

    const demux = new OggOpusDemuxer();
    this.demux = demux;
    ff.stdout.pipe(demux);
    demux.on('data', (pkt) => {
      if (gen !== this.gen) return;
      this.packets.push(pkt);
      if (this.packets.length >= BUFFER_HIGH) demux.pause();
    });
    demux.on('end', () => {
      if (gen === this.gen) this.sourceEnded = true;
    });
    demux.on('error', () => {
      if (gen === this.gen) this.sourceEnded = true;
    });

    this.baseTime = Date.now();
    this.#schedule(gen);
  }

  #schedule(gen) {
    this.timer = setTimeout(() => this.#tick(gen), 10);
  }

  #tick(gen) {
    if (gen !== this.gen) return;
    const now = Date.now();

    if (this.paused || !this.ts.connected) {
      // hold position: keep the clock aligned so no catch-up burst on resume
      this.baseTime = now - this.sent * FRAME_MS;
      return this.#schedule(gen);
    }

    let due = Math.floor((now - this.baseTime) / FRAME_MS) - this.sent;
    if (due > 10) {
      // event loop stalled; skip ahead instead of flooding the server
      this.baseTime = now - this.sent * FRAME_MS;
      due = 1;
    }
    while (due-- > 0 && this.packets.length) {
      this.ts.sendVoice(this.packets.shift());
      this.sent++;
    }
    if (this.packets.length < BUFFER_LOW && this.demux?.isPaused()) this.demux.resume();

    if (!this.packets.length && this.sourceEnded) {
      // nothing decoded yet: let ffmpeg's exit code decide between "error" and "end"
      if (this.sent === 0 && this.ffmpeg?.exitCode === null) return this.#schedule(gen);
      if (this.sent === 0 && this.ffmpeg?.exitCode) return; // close handler reports the error
      this.ts.endVoice();
      const track = this.track;
      this.#kill();
      this.track = null;
      this.emit('end', track);
      return;
    }
    if (!this.packets.length && due >= 0) {
      // buffer underrun (slow stream): resync clock so we don't speed up later
      this.baseTime = now - this.sent * FRAME_MS;
    }
    this.#schedule(gen);
  }

  #fail(reason) {
    const track = this.track;
    this.#kill();
    this.track = null;
    this.emit('error', track, reason);
  }

  #kill() {
    clearTimeout(this.timer);
    if (this.ffmpeg && this.ffmpeg.exitCode === null) this.ffmpeg.kill('SIGKILL');
    this.demux?.destroy();
    this.gen++;
  }

  stop() {
    if (!this.track) return;
    this.#kill();
    this.ts.endVoice();
    this.track = null;
    this.paused = false;
  }

  pause() {
    if (!this.track || this.paused) return false;
    this.paused = true;
    this.ts.endVoice();
    return true;
  }

  resume() {
    if (!this.track || !this.paused) return false;
    this.paused = false;
    return true;
  }

  seek(seconds) {
    if (!this.track || this.track.isLive) return false;
    const max = this.track.duration || Infinity;
    const pos = Math.max(0, Math.min(seconds, max - 1));
    this.#kill();
    this.#start(pos);
    return true;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(100, Math.round(v)));
    // restart ffmpeg at the current position with the new volume filter
    if (this.track) {
      const pos = this.track.isLive ? 0 : this.position;
      this.#kill();
      this.#start(pos);
    }
    return this.volume;
  }
}
