'use strict';

const $ = (id) => document.getElementById(id);
const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/></svg>',
  skip: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 6.1v11.8a1 1 0 0 0 1.55.83L15 13v4.9a1 1 0 0 0 2 0V6.1a1 1 0 0 0-2 0V11L6.55 5.27A1 1 0 0 0 5 6.1Z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  vol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 18.5A3.5 3.5 0 1 1 7 15.34V5.6a1 1 0 0 1 .76-.97l10-2.5A1 1 0 0 1 19 3.1v12.4a3.5 3.5 0 1 1-2-3.16V7.4l-8 2v9.1Z"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  top: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 5h12M7 15l5-5 5 5M12 10v10"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
};
const SRC_LABEL = { youtube: 'YouTube', spotify: 'Spotify', upload: 'Upload', url: 'Link', search: 'Search' };

$('btnSkip').innerHTML = ICON.skip;
$('btnStop').innerHTML = ICON.stop;
$('volIcon').innerHTML = ICON.vol;

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), err ? 6000 : 3500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'POST',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) return location.replace('/login');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const act = (path, body, method) => api(path, { body, method }).catch((e) => toast(e.message, true));

// ------------------------------------------------------------------ state
let state = null;
let posBase = { pos: 0, at: 0 };
let volDragging = false;
let dragId = null;

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => render(JSON.parse(e.data));
  es.onerror = () => {
    es.close();
    $('status').className = 'status bad';
    $('statusText').textContent = 'Web connection lost…';
    // check whether the session expired, then retry
    fetch('/api/state').then((r) => (r.status === 401 ? location.replace('/login') : null)).catch(() => {});
    setTimeout(connectEvents, 3000);
  };
}

function render(s) {
  const prevQueue = state ? JSON.stringify(state.queue) : '';
  state = s;

  // bot status
  const b = s.bot;
  const st = $('status');
  st.className = 'status ' + (b.state === 'connected' ? 'ok' : b.state === 'reconnecting' ? 'bad' : '');
  $('statusText').textContent =
    b.state === 'connected' ? `Connected · ${b.nickname}` :
    b.state === 'reconnecting' ? `Reconnecting… ${b.lastError ? '(' + b.lastError + ')' : ''}` : 'Connecting…';
  st.title = `Server: ${b.server}`;

  // now playing
  const c = s.current;
  $('btnToggle').innerHTML = c && !c.paused ? ICON.pause : ICON.play;
  $('btnToggle').disabled = $('btnSkip').disabled = !c;
  const art = $('art');
  art.classList.toggle('playing', !!c && !c.paused);
  if (c?.thumbnail) {
    art.style.backgroundImage = `url("${c.thumbnail.replace(/"/g, '%22')}")`;
    art.innerHTML = '';
  } else {
    art.style.backgroundImage = '';
    art.innerHTML = ICON.note;
  }
  $('nowLabel').textContent = c ? (c.paused ? 'Paused' : 'Now playing') : s.loading ? 'Loading next song…' : 'Nothing playing';
  const t = $('nowTitle');
  t.textContent = c ? c.title : s.loading ? s.queue[0]?.title || '' : 'Add a song to get started';
  if (c?.url) t.href = c.url; else t.removeAttribute('href');
  $('nowMeta').textContent = c ? [SRC_LABEL[c.source], c.addedBy && `added by ${c.addedBy}`].filter(Boolean).join(' · ') : '';
  $('progress').classList.toggle('live', !!c?.isLive);
  posBase = { pos: c?.position || 0, at: performance.now() };
  $('dur').textContent = c ? (c.isLive ? 'LIVE' : fmt(c.duration)) : '0:00';

  if (!volDragging) {
    $('vol').value = s.volume;
    $('volVal').textContent = s.volume + '%';
  }

  // queue
  $('qCount').textContent = s.queue.length;
  const total = s.queue.reduce((a, i) => a + (i.duration || 0), 0);
  $('qTotal').textContent = total ? fmt(total) + ' total' : '';
  $('qEmpty').style.display = s.queue.length ? 'none' : '';
  if (dragId === null && JSON.stringify(s.queue) !== prevQueue) renderQueue(s.queue);
}

function tickProgress() {
  const c = state?.current;
  if (c) {
    const pos = c.paused || state.bot.state !== 'connected' ? posBase.pos : posBase.pos + (performance.now() - posBase.at) / 1000;
    const p = c.duration ? Math.min(pos, c.duration) : pos;
    $('pos').textContent = fmt(p);
    $('bar').style.width = c.duration ? (p / c.duration) * 100 + '%' : '0';
  } else {
    $('pos').textContent = '0:00';
    $('bar').style.width = '0';
  }
  requestAnimationFrame(tickProgress);
}
requestAnimationFrame(tickProgress);

function renderQueue(queue) {
  const list = $('qlist');
  list.innerHTML = queue.map((item, i) => {
    const thumb = item.thumbnail ? ` style="background-image:url(&quot;${esc(item.thumbnail)}&quot;)"` : '';
    const status = item.status === 'downloading' ? '<span class="badge st-downloading">downloading…</span>'
      : item.status === 'error' ? `<span class="badge st-error" title="${esc(item.error)}">error</span>`
      : item.status === 'ready' && item.source !== 'upload' ? '<span class="badge st-ready">ready</span>' : '';
    return `<li class="qitem" draggable="true" data-id="${item.id}">
      <span class="handle" title="Drag to reorder">${ICON.grip}</span>
      <span class="qnum">${i + 1}</span>
      <span class="qthumb"${thumb}>${item.thumbnail ? '' : ICON.note}</span>
      <div class="qmain">
        <div class="qtitle" title="${esc(item.title)}">${esc(item.title)}</div>
        <div class="qmeta">
          <span class="badge src-${item.source}">${SRC_LABEL[item.source] || item.source}</span>
          <span>${item.isLive ? 'LIVE' : item.duration ? fmt(item.duration) : '–:––'}</span>
          ${status}
          ${item.addedBy ? `<span>by ${esc(item.addedBy)}</span>` : ''}
        </div>
      </div>
      <div class="qactions">
        <button class="top" data-op="top" title="Move to top" ${i === 0 ? 'disabled' : ''}>${ICON.top}</button>
        <button data-op="up" title="Move up" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
        <button data-op="down" title="Move down" ${i === queue.length - 1 ? 'disabled' : ''}>${ICON.down}</button>
        <button class="rm" data-op="remove" title="Remove">${ICON.x}</button>
      </div>
    </li>`;
  }).join('');
}

// ------------------------------------------------------------------ queue actions
$('qlist').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-op]');
  if (!btn) return;
  const id = btn.closest('.qitem').dataset.id;
  const op = btn.dataset.op;
  if (op === 'remove') act(`/api/queue/${id}`, null, 'DELETE');
  else act(`/api/queue/${id}/${op}`);
});

// drag & drop reordering
const list = $('qlist');
let dropTarget = null;
list.addEventListener('dragstart', (e) => {
  const li = e.target.closest('.qitem');
  if (!li) return;
  dragId = li.dataset.id;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});
list.addEventListener('dragover', (e) => {
  if (dragId === null) return;
  e.preventDefault();
  const li = e.target.closest('.qitem');
  list.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  if (!li || li.dataset.id === dragId) return (dropTarget = null);
  const r = li.getBoundingClientRect();
  const after = e.clientY > r.top + r.height / 2;
  li.classList.add(after ? 'drop-after' : 'drop-before');
  dropTarget = { id: li.dataset.id, after };
});
list.addEventListener('drop', (e) => {
  e.preventDefault();
  if (dragId === null || !dropTarget) return;
  const ids = state.queue.map((q) => q.id);
  const from = ids.indexOf(dragId);
  let to = ids.indexOf(dropTarget.id) + (dropTarget.after ? 1 : 0);
  if (from < to) to--;
  const id = dragId;
  // re-rendering detaches the dragged element so its dragend never fires: end the drag here
  dragId = null;
  dropTarget = null;
  if (from !== to && from >= 0) {
    // move locally right away so the list doesn't jump back
    const [moved] = state.queue.splice(from, 1);
    state.queue.splice(to, 0, moved);
    act(`/api/queue/${id}/move`, { to });
  }
  renderQueue(state.queue);
});
list.addEventListener('dragend', () => {
  dragId = null;
  dropTarget = null;
  list.querySelectorAll('.dragging,.drop-before,.drop-after').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after'));
  if (state) renderQueue(state.queue);
});

// ------------------------------------------------------------------ controls
$('btnToggle').onclick = () => act('/api/control/toggle');
$('btnSkip').onclick = () => act('/api/control/skip');
$('btnStop').onclick = () => confirm('Stop playback and clear the whole queue?') && act('/api/control/stop');
$('btnShuffle').onclick = () => act('/api/control/shuffle');
$('btnClear').onclick = () => state?.queue.length && confirm('Remove all songs from the queue?') && act('/api/control/clear');
$('logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.replace('/login');
};

const vol = $('vol');
vol.addEventListener('input', () => {
  volDragging = true;
  $('volVal').textContent = vol.value + '%';
});
vol.addEventListener('change', async () => {
  await act('/api/volume', { volume: Number(vol.value) });
  volDragging = false;
});

$('progress').addEventListener('click', (e) => {
  const c = state?.current;
  if (!c || !c.duration || c.isLive) return;
  const r = e.currentTarget.getBoundingClientRect();
  act('/api/seek', { seconds: ((e.clientX - r.left) / r.width) * c.duration });
});

// ------------------------------------------------------------------ add
async function addInput(next) {
  const input = $('addInput').value.trim();
  if (!input) return $('addInput').focus();
  const btns = document.querySelectorAll('#addForm .btn');
  btns.forEach((b) => (b.disabled = true));
  try {
    const r = await api('/api/add', { body: { input, next } });
    toast(r.added > 1 ? `Added ${r.added} songs` : `Added: ${r.title}`);
    $('addInput').value = '';
  } catch (e) {
    toast(e.message, true);
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}
$('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  addInput(false);
});
$('addNext').onclick = () => addInput(true);

// ------------------------------------------------------------------ uploads
// Files go up one per request: works behind proxies with body size limits
// (e.g. Cloudflare's 100 MB) and gives a progress bar per file.
const uploadQueue = [];
let uploading = false;

function queueFiles(files) {
  for (const f of files) {
    const el = document.createElement('div');
    el.className = 'up-item';
    el.innerHTML = `<div class="row"><span class="name">${esc(f.name)}</span><span class="pct">waiting</span></div><div class="ubar"><div></div></div>`;
    $('uploads').appendChild(el);
    uploadQueue.push({ file: f, el });
  }
  if (!uploading) pumpUploads();
}

async function pumpUploads() {
  uploading = true;
  while (uploadQueue.length) {
    const { file, el } = uploadQueue.shift();
    const pct = el.querySelector('.pct');
    const bar = el.querySelector('.ubar div');
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const fd = new FormData();
        fd.append('files', file, file.name);
        xhr.open('POST', '/api/upload');
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          const p = Math.round((e.loaded / e.total) * 100);
          bar.style.width = p + '%';
          pct.textContent = p < 100 ? p + '%' : 'processing…';
        };
        xhr.onload = () => {
          let data = {};
          try { data = JSON.parse(xhr.responseText); } catch {}
          if (xhr.status === 401) return location.replace('/login');
          if (xhr.status === 413) return reject(new Error('File too large for the server/proxy'));
          if (xhr.status >= 400) return reject(new Error(data.error || `Upload failed (${xhr.status})`));
          if (!data.added) return reject(new Error('Not a playable audio file'));
          resolve();
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(fd);
      });
      el.classList.add('done');
      bar.style.width = '100%';
      pct.textContent = 'added ✓';
      setTimeout(() => el.remove(), 2500);
    } catch (e) {
      el.classList.add('fail');
      bar.style.width = '100%';
      pct.textContent = e.message;
      setTimeout(() => el.remove(), 8000);
    }
  }
  uploading = false;
}

const drop = $('drop');
$('files').addEventListener('change', (e) => {
  queueFiles([...e.target.files]);
  e.target.value = '';
});
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
  if (dragId !== null) return;
  e.preventDefault();
  drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  if (dragId !== null) return;
  e.preventDefault();
  queueFiles([...e.dataTransfer.files]);
});
// allow dropping files anywhere on the page
window.addEventListener('dragover', (e) => dragId === null && e.dataTransfer.types.includes('Files') && e.preventDefault());
window.addEventListener('drop', (e) => {
  if (dragId !== null || !e.dataTransfer.files.length || e.defaultPrevented) return;
  e.preventDefault();
  queueFiles([...e.dataTransfer.files]);
});

connectEvents();
