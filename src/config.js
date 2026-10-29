import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env (simple KEY=VALUE parser, no dependency needed)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, ''); // inline comment: KEY=value  # note
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const int = (k, d) => {
  const n = parseInt(env(k, ''), 10);
  return Number.isFinite(n) ? n : d;
};
const bool = (k, d) => {
  const v = env(k, '').toLowerCase();
  return v ? ['1', 'true', 'yes', 'on'].includes(v) : d;
};

const DATA_DIR = path.resolve(ROOT, env('DATA_DIR', 'data'));

export const config = {
  dataDir: DATA_DIR,
  mediaDir: path.join(DATA_DIR, 'media'),
  uploadDir: path.join(DATA_DIR, 'uploads'),

  ts: {
    host: env('TS_HOST', '127.0.0.1'),
    nickname: env('TS_NICKNAME', 'MusicBot'),
    serverPassword: env('TS_SERVER_PASSWORD'),
    channel: env('TS_CHANNEL'),
    channelPassword: env('TS_CHANNEL_PASSWORD'),
    identityLevel: int('TS_IDENTITY_LEVEL', 8),
    returnToChannel: bool('TS_RETURN_TO_CHANNEL', true),
  },

  web: {
    host: env('WEB_HOST', '127.0.0.1'),
    port: int('WEB_PORT', 8090),
    password: env('WEB_PASSWORD'),
    publicUrl: env('PUBLIC_URL', 'https://music.example.com'),
    maxUploadMb: int('MAX_UPLOAD_MB', 200),
  },

  audio: {
    bitrate: int('AUDIO_BITRATE', 96),
    defaultVolume: int('DEFAULT_VOLUME', 50),
  },

  ytdlp: {
    bin: env('YTDLP_BIN', 'yt-dlp'),
    extraArgs: env('YTDLP_EXTRA_ARGS', '--js-runtimes node').split(/\s+/).filter(Boolean),
    cookiesFile: path.join(DATA_DIR, 'cookies.txt'),
  },

  spotify: {
    clientId: env('SPOTIFY_CLIENT_ID'),
    clientSecret: env('SPOTIFY_CLIENT_SECRET'),
  },

  prefetch: int('PREFETCH', 3),
  maxPlaylistItems: int('MAX_PLAYLIST_ITEMS', 200),
  maxSongMinutes: int('MAX_SONG_MINUTES', 0),
  commandPrefix: env('COMMAND_PREFIX', '/'),
};

for (const dir of [config.dataDir, config.mediaDir, config.uploadDir]) fs.mkdirSync(dir, { recursive: true });

if (!config.web.password) {
  const pwFile = path.join(DATA_DIR, 'web-password.txt');
  if (!fs.existsSync(pwFile)) fs.writeFileSync(pwFile, crypto.randomBytes(9).toString('base64url') + '\n', { mode: 0o600 });
  config.web.password = fs.readFileSync(pwFile, 'utf8').trim();
  console.warn(`[config] WEB_PASSWORD not set - using generated password from ${pwFile}: ${config.web.password}`);
}
