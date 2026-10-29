import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { config, ROOT } from './config.js';

const COOKIE = 'tsmb_session';
const SESSION_DAYS = 30;
const SESSIONS_FILE = path.join(config.dataDir, 'sessions.json');
const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|wma|webm|mp4|mkv|mka|aiff?|alac|amr|3gp|mov)$/i;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function startWeb(music) {
  const app = express();
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.disable('x-powered-by');

  // ---------------------------------------------------------- sessions
  let sessions = {};
  try {
    sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {}
  const saveSessions = () => fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), { mode: 0o600 }, () => {});
  const now = Date.now();
  for (const [k, exp] of Object.entries(sessions)) if (exp < now) delete sessions[k];

  const getToken = (req) => {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)`));
    return m?.[1];
  };
  const isAuthed = (req) => {
    const t = getToken(req);
    return !!t && (sessions[sha(t)] || 0) > Date.now();
  };

  // ---------------------------------------------------------- security headers
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    // keep CDNs like Cloudflare from caching pages behind the login (or the redirect to it)
    res.setHeader('Cache-Control', 'private, no-cache');
    // block cross-site requests that change things
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      let ok = false;
      try {
        ok = new URL(req.headers.origin).host === req.headers.host;
      } catch {}
      if (!ok) return res.status(403).json({ error: 'Cross-site request blocked' });
    }
    next();
  });

  // ---------------------------------------------------------- login
  const attempts = new Map();
  app.post('/api/login', express.json({ limit: '4kb' }), (req, res) => {
    const ip = req.ip;
    const a = attempts.get(ip) || { n: 0, reset: Date.now() + 15 * 60_000 };
    if (a.reset < Date.now()) Object.assign(a, { n: 0, reset: Date.now() + 15 * 60_000 });
    if (a.n >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });

    if (!safeEqual(req.body?.password ?? '', config.web.password)) {
      a.n++;
      attempts.set(ip, a);
      return res.status(401).json({ error: 'Wrong password' });
    }
    attempts.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions[sha(token)] = Date.now() + SESSION_DAYS * 86400_000;
    saveSessions();
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`,
    );
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    const t = getToken(req);
    if (t) delete sessions[sha(t)];
    saveSessions();
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  const pub = path.join(ROOT, 'public');
  app.get('/login', (req, res) => (isAuthed(req) ? res.redirect('/') : res.sendFile(path.join(pub, 'login.html'))));
  app.get(['/style.css', '/favicon.svg'], (req, res) => res.sendFile(path.join(pub, req.path)));

  // everything below needs a valid session
  app.use((req, res, next) => {
    if (isAuthed(req)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not logged in' });
    res.redirect('/login');
  });

  app.use(express.static(pub, { index: 'index.html', cacheControl: false }));

  // ---------------------------------------------------------- live updates (SSE)
  const clients = new Set();
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify(music.state())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });
  let pending = null;
  const broadcast = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const data = `data: ${JSON.stringify(music.state())}\n\n`;
      for (const c of clients) c.write(data);
    }, 100);
  };
  music.on('change', broadcast);
  music.ts.on('state', broadcast);
  setInterval(() => {
    if (music.current) broadcast();
    else for (const c of clients) c.write(': ping\n\n');
  }, 1000);

  // ---------------------------------------------------------- API
  const json = express.json({ limit: '64kb' });
  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  };

  app.get('/api/state', (req, res) => res.json(music.state()));

  app.post('/api/add', json, wrap(async (req) => {
    const input = String(req.body?.input || '').trim();
    if (!input) throw new Error('Paste a link or type something to search');
    const items = await music.add(input, { addedBy: 'Web', next: !!req.body?.next });
    return { added: items.length, title: items[0]?.title };
  }));

  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (_req, file, cb) => cb(null, crypto.randomBytes(8).toString('hex') + path.extname(file.originalname).slice(0, 6).toLowerCase()),
    }),
    limits: { fileSize: config.web.maxUploadMb * 1024 * 1024, files: 50 },
    fileFilter: (_req, file, cb) => cb(null, /^(audio|video)\//.test(file.mimetype) || AUDIO_EXT.test(file.originalname)),
  });

  app.post('/api/upload', (req, res) => {
    upload.array('files', 50)(req, res, async (err) => {
      if (err) {
        for (const f of req.files || []) fs.rm(f.path, { force: true }, () => {});
        const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${config.web.maxUploadMb} MB` : err.message;
        return res.status(400).json({ error: msg });
      }
      const files = (req.files || []).map((f) => ({ path: f.path, originalname: Buffer.from(f.originalname, 'latin1').toString('utf8') }));
      if (!files.length) return res.status(400).json({ error: 'No audio files received' });
      const { added, failed } = await music.addUploads(files, { addedBy: 'Web (upload)', next: req.query.next === '1' });
      res.json({ added: added.length, failed });
    });
  });

  const actions = {
    pause: () => music.pause(),
    resume: () => music.resume(),
    toggle: () => music.togglePause(),
    skip: () => music.skip(),
    stop: () => music.stop(),
    shuffle: () => music.shuffle(),
    clear: () => music.clear(),
  };
  app.post('/api/control/:action', wrap(async (req) => {
    const fn = actions[req.params.action];
    if (!fn) throw new Error('Unknown action');
    fn();
  }));

  app.post('/api/volume', json, wrap(async (req) => ({ volume: music.setVolume(Number(req.body?.volume)) })));

  app.post('/api/seek', json, wrap(async (req) => {
    if (!music.seek(Number(req.body?.seconds))) throw new Error('Cannot seek this track');
  }));

  app.post('/api/queue/:id/:op(up|down|top)', wrap(async (req) => {
    if (!music[req.params.op](req.params.id)) throw new Error('Song not found');
  }));

  app.post('/api/queue/:id/move', json, wrap(async (req) => {
    if (!music.move(req.params.id, Number(req.body?.to))) throw new Error('Song not found');
  }));

  app.delete('/api/queue/:id', wrap(async (req) => {
    if (!music.remove(req.params.id)) throw new Error('Song not found');
  }));

  const server = app.listen(config.web.port, config.web.host, () => {
    console.log(`[web] listening on http://${config.web.host}:${config.web.port}  (public: ${config.web.publicUrl})`);
  });
  server.requestTimeout = 0; // big uploads on slow connections
  return server;
}
