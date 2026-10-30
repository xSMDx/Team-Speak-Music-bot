import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { config } from './config.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** Strip TeamSpeak BBCode like [URL]...[/URL] and surrounding whitespace. */
export function cleanInput(s) {
  return String(s || '')
    .replace(/\[URL=([^\]]+)\][^[]*\[\/URL\]/gi, '$1')
    .replace(/\[\/?[A-Z]+[^\]]*\]/gi, '')
    .trim();
}

const isUrl = (s) => /^https?:\/\//i.test(s);
const SPOTIFY_RE = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?|spotify:)(track|album|playlist)[/:]([A-Za-z0-9]+)/i;
const YT_RE = /^https?:\/\/(?:[a-z0-9-]+\.)?(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\//i;

export function detectSource(input) {
  if (SPOTIFY_RE.test(input)) return 'spotify';
  if (YT_RE.test(input)) return 'youtube';
  if (isUrl(input)) return 'url';
  return 'search';
}

/**
 * Turns user input into one or more queue entries (not downloaded yet).
 * Entries: { title, source, input, duration?, url?, thumbnail?, isLive? , streamUrl? }
 */
export async function resolve(rawInput) {
  const input = cleanInput(rawInput);
  if (!input) throw new Error('Nothing to play');
  const source = detectSource(input);

  if (source === 'spotify') return resolveSpotify(input);

  if (source === 'search') {
    return [{ title: input, source: 'search', input: `ytsearch1:${input}`, url: null }];
  }

  if (source === 'youtube') {
    const u = new URL(input);
    const isPlaylist = u.searchParams.has('list') && (u.pathname === '/playlist' || !u.searchParams.has('v'));
    if (isPlaylist) return resolveYtPlaylist(input);
    return [{ title: input, source: 'youtube', input, url: input }];
  }

  // generic URL: direct audio file, internet radio, or any site yt-dlp supports
  const probe = await probeUrl(input).catch(() => null);
  if (probe?.media) {
    const name = decodeURIComponent(new URL(input).pathname.split('/').pop() || '') || input;
    if (probe.live) {
      return [{ title: probe.icyName || name, source: 'url', input, url: input, streamUrl: input, isLive: true }];
    }
    return [{ title: stripExt(name), source: 'url', input, url: input, direct: true }];
  }
  return [{ title: input, source: 'url', input, url: input }];
}

const stripExt = (n) => n.replace(/\.[a-z0-9]{2,5}$/i, '');

async function probeUrl(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Icy-MetaData': '0', Range: 'bytes=0-0' },
    signal: AbortSignal.timeout(10_000),
    redirect: 'follow',
  });
  res.body?.cancel().catch(() => {});
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const media = /^(audio|video)\//.test(type) || type === 'application/ogg' || /mpegurl/.test(type);
  const hasLength = res.headers.has('content-range') || res.headers.has('content-length');
  const live = media && (!hasLength || res.headers.has('icy-name') || /mpegurl/.test(type));
  return { media, live, icyName: res.headers.get('icy-name') };
}

// ---------------------------------------------------------------- YouTube

async function resolveYtPlaylist(url) {
  const json = await ytdlpJson(['--flat-playlist', '-J', '--playlist-end', String(config.maxPlaylistItems), url]);
  const entries = (json.entries || []).filter((e) => e && (e.url || e.id));
  if (!entries.length) throw new Error('Playlist is empty or private');
  return entries.map((e) => {
    const link = e.url?.startsWith('http') ? e.url : `https://www.youtube.com/watch?v=${e.id}`;
    return {
      title: e.title || link,
      source: 'youtube',
      input: link,
      url: link,
      duration: e.duration || 0,
      thumbnail: e.thumbnails?.at(-1)?.url,
    };
  });
}

function ytdlpBaseArgs() {
  const args = ['--no-warnings', '--no-progress', ...config.ytdlp.extraArgs];
  if (fs.existsSync(config.ytdlp.cookiesFile)) args.push('--cookies', config.ytdlp.cookiesFile);
  return args;
}

function ytdlpJson(args) {
  return new Promise((resolve, reject) => {
    execFile(config.ytdlp.bin, [...ytdlpBaseArgs(), ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(ytdlpError(stderr) || err.message));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('yt-dlp returned invalid data'));
      }
    });
  });
}

function ytdlpError(stderr) {
  const lines = String(stderr || '').split('\n').filter((l) => /ERROR/.test(l));
  const last = (lines.at(-1) || '').replace(/^ERROR:\s*/, '').replace(/\[[^\]]+\]\s*[\w-]+:\s*/, '');
  if (/Sign in to confirm/i.test(last)) return 'YouTube is asking for a sign-in (bot check). Put a cookies.txt into the data folder.';
  return last.slice(0, 300);
}

// ---------------------------------------------------------------- Spotify

let spotifyToken = null;
async function spotifyApi(pathname) {
  if (!spotifyToken || spotifyToken.expires < Date.now()) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${config.spotify.clientId}:${config.spotify.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Spotify auth failed (${res.status})`);
    const j = await res.json();
    spotifyToken = { value: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 };
  }
  const res = await fetch(`https://api.spotify.com/v1${pathname}`, {
    headers: { Authorization: `Bearer ${spotifyToken.value}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Spotify API error (${res.status})`);
  return res.json();
}

async function spotifyViaApi(type, id) {
  const fmt = (t) => ({ title: t.name, artist: (t.artists || []).map((a) => a.name).join(', '), duration: Math.round((t.duration_ms || 0) / 1000) });
  if (type === 'track') return [fmt(await spotifyApi(`/tracks/${id}`))];
  const out = [];
  let next = type === 'album' ? `/albums/${id}/tracks?limit=50` : `/playlists/${id}/tracks?limit=100`;
  while (next && out.length < config.maxPlaylistItems) {
    const page = await spotifyApi(next);
    for (const it of page.items || []) {
      const t = type === 'album' ? it : it.track;
      if (t?.name) out.push(fmt(t));
    }
    next = page.next ? page.next.replace('https://api.spotify.com/v1', '') : null;
  }
  return out;
}

/** No API keys: read the public embed page, which carries the track list as JSON. */
async function spotifyViaEmbed(type, id) {
  const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Spotify returned ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('Could not read Spotify page');
  const data = JSON.parse(m[1]);
  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new Error('Spotify item not found');
  if (type === 'track') {
    const artist = (entity.artists || []).map((a) => a.name).join(', ') || entity.subtitle || '';
    return [{ title: entity.name || entity.title, artist, duration: Math.round((entity.duration || 0) / 1000) }];
  }
  return (entity.trackList || []).slice(0, config.maxPlaylistItems).map((t) => ({
    title: t.title,
    artist: (t.subtitle || '').replace(/ /g, ' '),
    duration: Math.round((t.duration || 0) / 1000),
  }));
}

async function resolveSpotify(input) {
  const [, typeRaw, id] = input.match(SPOTIFY_RE);
  const type = typeRaw.toLowerCase();
  let tracks;
  if (config.spotify.clientId && config.spotify.clientSecret) {
    tracks = await spotifyViaApi(type, id).catch((e) => {
      console.warn('[spotify] API failed, falling back to embed page:', e.message);
      return null;
    });
  }
  if (!tracks) {
    tracks = await spotifyViaEmbed(type, id).catch((e) => {
      throw new Error(`${e.message}. Setting SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET makes Spotify links more reliable.`);
    });
  }
  if (!tracks.length) throw new Error('No tracks found on that Spotify link');
  const link = `https://open.spotify.com/${type}/${id}`;
  return tracks.map((t) => {
    const title = t.artist ? `${t.artist} - ${t.title}` : t.title;
    return {
      title,
      source: 'spotify',
      // Spotify audio is DRM-protected, so the song is played from YouTube
      input: `ytsearch1:${title} audio`,
      url: link,
      duration: t.duration,
    };
  });
}

// ---------------------------------------------------------------- search

/** Sites the search box and /search can look through. Spotify search needs API keys. */
export function searchProviders() {
  const list = [{ id: 'youtube', label: 'YouTube', aliases: ['yt', 'youtube'] }];
  if (config.spotify.clientId && config.spotify.clientSecret) list.push({ id: 'spotify', label: 'Spotify', aliases: ['sp', 'spotify'] });
  return list;
}

/** Returns up to `limit` queue entries for `query`, best match first. */
export async function search(provider, query, limit = 10) {
  const q = cleanInput(query);
  if (!q) throw new Error('Type something to search for');
  if (provider === 'spotify') return searchSpotify(q, limit);
  if (provider === 'youtube') return searchYoutube(q, limit);
  throw new Error(`Unknown search provider "${provider}"`);
}

async function searchYoutube(q, limit) {
  const json = await ytdlpJson(['--flat-playlist', '-J', `ytsearch${limit}:${q}`]);
  return (json.entries || []).filter((e) => e?.id).map((e) => {
    const link = `https://www.youtube.com/watch?v=${e.id}`;
    return {
      title: e.title || link,
      artist: e.channel || e.uploader || '',
      source: 'youtube',
      input: link,
      url: link,
      duration: Math.round(e.duration || 0),
      thumbnail: e.thumbnails?.at(-1)?.url || `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
    };
  });
}

async function searchSpotify(q, limit) {
  const res = await spotifyApi(`/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}`);
  return (res.tracks?.items || []).filter(Boolean).map((t) => {
    const artist = (t.artists || []).map((a) => a.name).join(', ');
    const title = artist ? `${artist} - ${t.name}` : t.name;
    return {
      title,
      artist,
      source: 'spotify',
      // Spotify audio is DRM-protected, so the song is played from YouTube
      input: `ytsearch1:${title} audio`,
      url: t.external_urls?.spotify || null,
      duration: Math.round((t.duration_ms || 0) / 1000),
      thumbnail: t.album?.images?.at(-2)?.url || t.album?.images?.[0]?.url,
    };
  });
}

// ---------------------------------------------------------------- download

/**
 * Downloads an entry into the media folder. Calls onInfo({title,duration,...})
 * as soon as metadata is known. Returns the downloaded file path.
 */
export function download(item, onInfo, signal) {
  if (item.direct) return downloadDirect(item, signal);
  return new Promise((resolve, reject) => {
    const outTpl = path.join(config.mediaDir, `${item.id}.%(ext)s`);
    const args = [
      ...ytdlpBaseArgs(),
      '--no-playlist',
      '-f', 'bestaudio/best',
      '--no-part',
      '--no-mtime',
      '--max-filesize', `${config.web.maxUploadMb * 4}M`,
      '-o', outTpl,
      '--no-simulate',
      '--print', '%(.{title,duration,uploader,thumbnail,webpage_url,is_live})j',
      '--print', 'after_move:filepath',
    ];
    if (config.maxSongMinutes > 0) args.push('--match-filter', `duration <= ${config.maxSongMinutes * 60}`);
    args.push('--', item.input);

    const proc = spawn(config.ytdlp.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    let out = '';
    let err = '';
    let file = null;
    proc.stdout.on('data', (d) => {
      out += d;
      let nl;
      while ((nl = out.indexOf('\n')) !== -1) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (line.startsWith('{')) {
          try {
            const info = JSON.parse(line);
            if (info.is_live) {
              proc.kill('SIGKILL');
              return reject(new Error('Live streams are not supported from this source'));
            }
            onInfo?.(info);
          } catch {}
        } else if (line) file = line;
      }
    });
    proc.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    proc.on('error', (e) => reject(new Error(`yt-dlp not found (${e.message})`)));
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('cancelled'));
      if (code === 0 && file && fs.existsSync(file)) return resolve(file);
      if (code === 0 && !file) return reject(new Error(config.maxSongMinutes ? `No result (or longer than ${config.maxSongMinutes} min)` : 'No result found'));
      reject(new Error(ytdlpError(err) || `yt-dlp exited with code ${code}`));
    });
  });
}

async function downloadDirect(item, signal, url = item.input, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const limit = config.web.maxUploadMb * 4 * 1024 * 1024;
  const ext = (path.extname(new URL(res.url || url).pathname) || '.bin').slice(0, 6);
  const file = path.join(config.mediaDir, `${item.id}${ext}`);
  let size = 0;
  const guard = new Transform({
    transform(chunk, _e, cb) {
      size += chunk.length;
      cb(size > limit ? new Error('File is too large') : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), guard, fs.createWriteStream(file));
  } catch (e) {
    fs.rm(file, { force: true }, () => {});
    throw e;
  }
  return file;
}

/** Reads duration + tags of a local file with ffprobe. */
export function probeFile(file) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type:format=duration:format_tags=title,artist', '-of', 'json', file];
    execFile('ffprobe', args, { timeout: 20_000 }, (err, stdout) => {
      if (err) return resolve({ ok: false });
      try {
        const j = JSON.parse(stdout);
        const f = j.format || {};
        const tags = Object.fromEntries(Object.entries(f.tags || {}).map(([k, v]) => [k.toLowerCase(), v]));
        const hasAudio = (j.streams || []).length > 0;
        resolve({ ok: hasAudio, duration: Math.round(parseFloat(f.duration) || 0), title: tags.title, artist: tags.artist });
      } catch {
        resolve({ ok: false });
      }
    });
  });
}
