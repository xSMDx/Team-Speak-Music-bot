import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  Client,
  generateIdentity,
  identityFromString,
  sendTextMessage,
  getClientInfo,
  clientMove,
} from '@honeybbq/teamspeak-client';
import { config } from './config.js';

const CODEC_OPUS_MUSIC = 5;
const MAX_MSG = 900; // TeamSpeak caps text messages at 1024 chars; leave room for BBCode

const log = (...a) => console.log('[ts]', ...a);
const tsLogger = {
  debug() {},
  info() {},
  warn: (m, ...a) => console.warn('[ts-lib]', m, ...a.map((x) => x?.message ?? x)),
  error: (m, ...a) => console.error('[ts-lib]', m, ...a.map((x) => x?.message ?? x)),
};

/**
 * Keeps the bot connected to the TeamSpeak server. Reconnects with backoff on
 * any disconnect, kick or failed keep-alive, forever.
 */
export class TeamSpeakBot extends EventEmitter {
  constructor() {
    super();
    this.identity = this.#loadIdentity();
    this.client = null;
    this.state = 'disconnected'; // disconnected | connecting | connected | reconnecting
    this.lastError = '';
    this.attempt = 0;
    this.reconnectTimer = null;
    this.watchdogTimer = null;
    this.watchdogFails = 0;
    this.homeChannel = null; // channel id we want to stay in
    this.connectedSince = null;
    this.stopped = false;
  }

  #loadIdentity() {
    const file = path.join(config.dataDir, 'identity.txt');
    if (fs.existsSync(file)) {
      try {
        return identityFromString(fs.readFileSync(file, 'utf8').trim());
      } catch (e) {
        console.warn('[ts] identity.txt is invalid, generating a new one:', e.message);
      }
    }
    log(`generating identity (security level ${config.ts.identityLevel}) ...`);
    const id = generateIdentity(config.ts.identityLevel);
    fs.writeFileSync(file, id.toString(), { mode: 0o600 });
    return id;
  }

  get connected() {
    return this.state === 'connected' && this.client?.status === 2;
  }

  #setState(s, err) {
    this.state = s;
    if (err !== undefined) this.lastError = err;
    this.emit('state', this.status());
  }

  status() {
    return {
      state: this.state,
      server: config.ts.host,
      nickname: config.ts.nickname,
      lastError: this.lastError,
      attempt: this.attempt,
      connectedSince: this.connectedSince,
    };
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  async #connect() {
    clearTimeout(this.reconnectTimer);
    this.#teardown();
    this.#setState(this.attempt ? 'reconnecting' : 'connecting');
    log(`connecting to ${config.ts.host} as "${config.ts.nickname}" (attempt ${this.attempt + 1})`);

    const client = new Client(this.identity, config.ts.host, config.ts.nickname, {
      logger: tsLogger,
      serverPassword: config.ts.serverPassword || undefined,
      defaultChannel: config.ts.channel || undefined,
      defaultChannelPassword: config.ts.channelPassword || undefined,
    });
    this.client = client;

    client.on('disconnected', (err) => {
      if (this.client !== client) return;
      this.#lost(`disconnected${err?.message ? ': ' + err.message : ''}`);
    });
    client.on('kicked', (reason) => {
      if (this.client !== client) return;
      this.#lost(`kicked from server${reason ? ': ' + reason : ''}`);
    });
    client.on('textMessage', (msg) => {
      if (this.client !== client) return;
      if (msg.invokerID === client.clientID()) return;
      this.emit('text', msg);
    });
    client.on('clientMoved', (ev) => {
      if (this.client !== client || ev.id !== client.clientID()) return;
      // reasonID 4 = kicked from channel -> walk back home
      if (ev.reasonID === 4 && config.ts.returnToChannel && this.homeChannel) {
        const home = this.homeChannel;
        log('kicked from channel, returning in 3s');
        setTimeout(() => this.moveTo(home).catch(() => {}), 3000);
      } else {
        this.homeChannel = ev.targetChannelID;
      }
    });

    try {
      await client.connect();
      await client.waitConnected(AbortSignal.timeout(20_000));
    } catch (e) {
      if (this.client === client) this.#lost(`connect failed: ${e.message}`);
      return;
    }
    if (this.client !== client) return;

    this.attempt = 0;
    this.watchdogFails = 0;
    this.connectedSince = Date.now();
    this.homeChannel = client.channelID() || null;
    this.#watchdog(client); // learns our real channel id
    log(`connected (clid ${client.clientID()})`);
    this.#setState('connected', '');
    this.watchdogTimer = setInterval(() => this.#watchdog(client), 15_000);
  }

  async #watchdog(client) {
    if (this.client !== client) return;
    try {
      const r = await client.execCommandWithResponse('whoami', 8_000);
      this.watchdogFails = 0;
      const cid = r?.[0]?.client_channel_id;
      if (cid) this.homeChannel = BigInt(cid);
      // after a timeout our old "ghost" can hold the nickname for a while (we become "MusicBot1");
      // take the real name back once it is free
      const nick = r?.[0]?.client_nickname;
      if (nick && nick !== config.ts.nickname) {
        client.execCommand(`clientupdate client_nickname=${tsEscape(config.ts.nickname)}`, 8_000).catch(() => {});
      }
    } catch (e) {
      if (this.client !== client) return;
      // a command error (not a timeout) still means the server answered
      if (!/timeout/i.test(e.message)) return;
      if (++this.watchdogFails >= 2) this.#lost('connection timed out');
    }
  }

  #lost(reason) {
    if (this.stopped) return;
    log(reason);
    this.#teardown();
    this.connectedSince = null;
    this.attempt++;
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.attempt - 1, 5));
    this.lastError = reason;
    this.#setState('reconnecting');
    log(`reconnecting in ${Math.round(delay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => this.#connect(), delay);
  }

  #teardown() {
    clearInterval(this.watchdogTimer);
    const old = this.client;
    this.client = null;
    if (old) old.disconnect().catch(() => {});
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdogTimer);
    if (this.client) await this.client.disconnect().catch(() => {});
    this.client = null;
    this.#setState('disconnected');
  }

  sendVoice(packet) {
    if (!this.connected) return false;
    try {
      this.client.sendVoice(packet, CODEC_OPUS_MUSIC);
      return true;
    } catch {
      return false;
    }
  }

  /** Signals "stopped talking" so clients don't hear a cut-off tail. */
  endVoice() {
    this.sendVoice(new Uint8Array(0));
  }

  /** Reply to a message in the same place it came from (private, channel or server chat). */
  async reply(msg, text) {
    const mode = msg.targetMode === 1 ? 1 : msg.targetMode === 3 ? 3 : 2;
    const target = mode === 1 ? BigInt(msg.invokerID) : mode === 2 ? this.client?.channelID() ?? 0n : 0n;
    return this.send(mode, target, text);
  }

  async send(mode, target, text) {
    if (!this.connected) return;
    for (const chunk of splitMessage(text)) {
      try {
        await sendTextMessage(this.client, mode, target, chunk);
      } catch (e) {
        console.warn('[ts] failed to send message:', e.message);
        return;
      }
    }
  }

  async channelOf(clid) {
    const info = await getClientInfo(this.client, clid);
    return BigInt(info.cid);
  }

  async moveTo(channelId, password) {
    if (!this.connected) throw new Error('not connected');
    await clientMove(this.client, this.client.clientID(), BigInt(channelId), password);
    this.homeChannel = BigInt(channelId);
  }
}

const tsEscape = (s) =>
  String(s).replace(/[\\/ |\n\r\t]/g, (c) => ({ '\\': '\\\\', '/': '\\/', ' ': '\\s', '|': '\\p', '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c]);

function splitMessage(text) {
  const out = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    if (cur && cur.length + line.length + 1 > MAX_MSG) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? cur + '\n' + line : line;
    while (cur.length > MAX_MSG) {
      out.push(cur.slice(0, MAX_MSG));
      cur = cur.slice(MAX_MSG);
    }
  }
  if (cur) out.push(cur);
  return out;
}
