import { PoseLandmarker, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@18.0.14/lib/marked.esm.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.4.16/dist/purify.es.mjs';
import { BONES, pickSide, joints as toJoints, computeAngles, Tracker, TARGETS, status } from './angles.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (v) => (Number.isFinite(v) ? Math.round(v) : '–');

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body instanceof Blob ? {} : { 'Content-Type': 'application/json' },
    body: opts.body instanceof Blob ? opts.body : opts.body && JSON.stringify(opts.body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------- Session state ----------
let session = null;
let saveTimer = null;

async function loadSession(id) {
  session = await api(`/api/sessions/${id}`);
  localStorage.setItem('bikefit.session', id);
  $('#session-label').textContent = session.label;
  renderMeasurements();
  renderRecorded();
  renderSnapshots();
  renderLive({});
  loadChat();
  renderSessions();
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  await api(`/api/sessions/${session.id}`, { method: 'PUT', body: session });
}

// ---------- Tabs ----------
document.querySelectorAll('nav [data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('nav [data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b));
    document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'sessions') renderSessions();
  }),
);

// ---------- Measurements ----------
const GROUPS = [
  { title: 'Bike', obj: 'bike', fields: [
    ['type', 'Bike type', 'select', ['road', 'tt', 'gravel', 'mtb']],
    ['brand', 'Brand', 'text'], ['model', 'Model', 'text'], ['year', 'Year', 'text'], ['size', 'Frame size', 'text'],
  ] },
  { title: 'Core contact points', obj: 'measurements', fields: [
    ['saddle_height', 'A · Saddle height', 'mm', 'A'], ['saddle_setback', 'B · Saddle setback', 'mm', 'B'],
    ['saddle_bar_reach', 'C · Saddle nose → hoods', 'mm', 'C'], ['saddle_bar_drop', 'D · Saddle-to-bar drop', 'mm', 'D'],
    ['crank_length', 'Crank length', 'mm'], ['saddle_tilt', 'Saddle tilt (+ nose up)', '°'], ['saddle_model', 'Saddle model', 'text'],
  ] },
  { title: 'Frame', obj: 'measurements', fields: [
    ['frame_stack', 'E · Frame stack', 'mm', 'E'], ['frame_reach', 'F · Frame reach', 'mm', 'F'],
    ['seat_tube_angle', 'Seat tube angle', '°'], ['stem_length', 'Stem length', 'mm'],
    ['stem_angle', 'Stem angle', '°'], ['spacers', 'Spacers under stem', 'mm'],
  ] },
  { title: 'Cockpit & cleats', obj: 'measurements', fields: [
    ['bar_width', 'Bar width (c-c)', 'mm'], ['bar_reach', 'Bar reach', 'mm'], ['bar_drop', 'Bar drop', 'mm'],
    ['hood_angle', 'Hood angle (vs horizontal)', '°'], ['cleat_fore_aft', 'Cleat: ball of foot → pedal axle', 'mm'],
    ['cleat_rotation', 'Cleat rotation (+ heel in)', '°'], ['stance_width', 'Stance width / Q-factor', 'mm'],
    ['shoe', 'Shoe & size', 'text'],
  ] },
  { title: 'Body', obj: 'measurements', fields: [
    ['height', 'Height', 'cm'], ['inseam', 'Inseam (book method)', 'cm'], ['arm_length', 'Arm length', 'cm'],
    ['torso_length', 'Torso length', 'cm'], ['shoulder_width', 'Shoulder width', 'cm'], ['weight', 'Weight', 'kg'],
    ['flexibility', 'Flexibility (e.g. fingertips to floor?)', 'text'],
    ['pain', 'Pain, numbness, injuries', 'area'], ['goals', 'Goals & riding (hours/week, events)', 'area'],
  ] },
];

function renderMeasurements() {
  $('#measure-forms').innerHTML = GROUPS.map((g, gi) => `
    <div class="card"><h2>${g.title}</h2><div class="fields">
      ${g.fields.map(([key, label, kind, extra]) => {
        const id = `f-${gi}-${key}`;
        const val = esc(session[g.obj]?.[key]);
        const attrs = `id="${id}" data-obj="${g.obj}" data-key="${key}" ${extra && kind !== 'select' ? `data-dim="${extra}"` : ''}`;
        let input;
        if (kind === 'select') input = `<select ${attrs}>${extra.map((o) => `<option ${o === session[g.obj]?.[key] ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
        else if (kind === 'area') input = `<textarea ${attrs} rows="2">${val}</textarea>`;
        else if (kind === 'text') input = `<input ${attrs} value="${val}">`;
        else input = `<div class="unit"><input ${attrs} type="number" step="any" inputmode="decimal" value="${val}"><span>${kind}</span></div>`;
        return `<div class="field ${kind === 'area' ? 'wide' : ''}"><label for="${id}">${label}</label>${input}</div>`;
      }).join('')}
    </div></div>`).join('') + `
    <div class="card"><h2>Notes</h2><div class="field wide"><textarea id="notes" rows="3">${esc(session.notes)}</textarea></div></div>`;
}

$('#measure-forms').addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'notes') session.notes = t.value;
  else if (t.dataset.key) {
    const v = t.type === 'number' ? (t.value === '' ? undefined : Number(t.value)) : t.value;
    (session[t.dataset.obj] ??= {})[t.dataset.key] = v;
    if (t.dataset.key === 'type') renderRecorded();
  }
  saveSoon();
});
$('#measure-forms').addEventListener('focusin', (e) => highlightDim(e.target.dataset?.dim));
$('#measure-forms').addEventListener('focusout', () => highlightDim(null));
function highlightDim(letter) {
  document.querySelectorAll('#bike-diagram .dim').forEach((g) => g.classList.toggle('hl', g.id === `dim-${letter}`));
}

// ---------- Pose capture ----------
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const video = $('#video');
const frame = document.createElement('canvas'); // last source frame, kept while frozen
const fctx = frame.getContext('2d');
let landmarker = null;
let source = null; // 'camera' | 'video' | 'image'
let image = null;
let joints = null; // pixel coords of the visible side
let side = null;
let frozen = false;
let lastVideoTime = -1;
let tracker = null;
let recordUntil = 0;
let recorder = null;
let chunks = [];

async function initPose() {
  $('#cap-status').textContent = 'Loading pose model…';
  const fileset = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm');
  const create = (delegate) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task',
      delegate,
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  landmarker = await create('GPU').catch(() => create('CPU')); // CPU when WebGL is unavailable
  $('#cap-status').textContent = 'Pose model ready. Film from the side with your whole body and the bike in frame.';
}

async function startCamera(deviceId) {
  stopCamera();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } } : { width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  });
  video.srcObject = stream;
  video.controls = false;
  video.hidden = true;
  await video.play();
  setSource('camera');
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const active = stream.getVideoTracks()[0].getSettings().deviceId;
  $('#cam-select').innerHTML = cams.map((c, i) => `<option value="${c.deviceId}" ${c.deviceId === active ? 'selected' : ''}>${esc(c.label || `Camera ${i + 1}`)}</option>`).join('');
  $('#cam-select').hidden = false;
}

function stopCamera() {
  video.srcObject?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

function setSource(kind) {
  source = kind;
  frozen = false;
  canvas.classList.remove('frozen');
  $('#freeze-btn').textContent = 'Freeze';
  $('#stage-empty').hidden = true;
  $('#rec-btn').disabled = kind === 'image';
  $('#freeze-btn').disabled = kind === 'image';
  $('#snap-btn').disabled = false;
  if (kind === 'image') frozen = true;
}

$('#cam-start').addEventListener('click', () => startCamera().catch((e) => ($('#cap-status').textContent = `Camera error: ${e.message}`)));
$('#cam-select').addEventListener('change', (e) => startCamera(e.target.value));

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  stopCamera();
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('image/')) {
    image = new Image();
    image.src = url;
    await image.decode();
    setSource('image');
    grabFrame(image, image.naturalWidth, image.naturalHeight);
    detect(frame);
    renderLive(joints ? computeAngles(joints) : {});
    canvas.classList.add('frozen');
    draw();
  } else {
    video.srcObject = null;
    video.src = url;
    video.loop = true;
    await video.play();
    setSource('video');
  }
  $('#cap-status').textContent = source === 'image' && !joints
    ? `${file.name}: no body detected. Use a sharper side view with the whole rider in frame.`
    : `${file.name}: ${source === 'image' ? 'drag joints to correct them, then save a snapshot.' : 'press Record while it plays, or Freeze on a key frame.'}`;
});

function grabFrame(src, w, h) {
  if (frame.width !== w || frame.height !== h) {
    frame.width = canvas.width = w;
    frame.height = canvas.height = h;
  }
  fctx.drawImage(src, 0, 0, w, h);
}

function detect(src) {
  if (!landmarker) return;
  const lm = landmarker.detectForVideo(src, performance.now()).landmarks[0];
  if (!lm) { joints = null; return; }
  side = pickSide(lm);
  joints = toJoints(lm, side, frame.width, frame.height);
}

function tick() {
  if (!frozen && (source === 'camera' || source === 'video') && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    grabFrame(video, video.videoWidth, video.videoHeight);
    detect(frame);
    const angles = joints ? computeAngles(joints) : {};
    renderLive(angles);
    if (tracker && joints) tracker.add(angles);
    if (tracker && performance.now() > recordUntil) finishRecording();
    draw();
  }
  requestAnimationFrame(tick);
}

function draw() {
  ctx.drawImage(frame, 0, 0);
  if (!joints) return;
  const s = canvas.width / 900; // scale strokes to resolution
  ctx.lineWidth = 4 * s;
  ctx.strokeStyle = 'rgba(198,244,50,.9)';
  ctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    ctx.beginPath();
    ctx.moveTo(joints[a].x, joints[a].y);
    ctx.lineTo(joints[b].x, joints[b].y);
    ctx.stroke();
  }
  for (const p of Object.values(joints)) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, (frozen ? 9 : 6) * s, 0, Math.PI * 2);
    ctx.fillStyle = '#0f1113';
    ctx.fill();
    ctx.lineWidth = 3 * s;
    ctx.stroke();
  }
  const a = computeAngles(joints);
  ctx.font = `600 ${22 * s}px -apple-system, system-ui, sans-serif`;
  ctx.lineWidth = 5 * s;
  ctx.strokeStyle = 'rgba(0,0,0,.75)';
  ctx.fillStyle = '#fff';
  const label = (txt, p) => {
    ctx.strokeText(txt, p.x + 14 * s, p.y - 10 * s);
    ctx.fillText(txt, p.x + 14 * s, p.y - 10 * s);
  };
  label(`knee ${fmt(a.knee)}°`, joints.knee);
  label(`hip ${fmt(a.hip)}°`, joints.hip);
  label(`elbow ${fmt(a.elbow)}°`, joints.elbow);
  label(`torso ${fmt(a.torso)}° · shoulder ${fmt(a.shoulder)}°`, joints.shoulder);
  ctx.strokeStyle = 'rgba(198,244,50,.9)';
}

const LIVE = ['knee', 'hip', 'torso', 'elbow', 'shoulder', 'ankle'];
function renderLive(angles) {
  const targets = TARGETS[session?.bike?.type] ?? {};
  $('#live-angles').innerHTML = LIVE.map((k) => {
    const t = Object.values(targets).find((x) => x.angle === k && x.live);
    const st = t ? status(angles[k], t.range) : '';
    return `<div class="tile ${st}"><div class="k">${k}</div><div class="v">${fmt(angles[k])}°</div><div class="r">${t ? `target ${t.range[0]}–${t.range[1]}°` : '&nbsp;'}</div></div>`;
  }).join('');
}

// Recording: angle stats over 10s of pedalling, plus a webm clip of the annotated view.
$('#rec-btn').addEventListener('click', () => {
  tracker = new Tracker();
  recordUntil = performance.now() + 10000;
  $('#rec-btn').classList.add('recording');
  $('#rec-btn').textContent = '● Recording…';
  chunks = [];
  const mimeType = ['video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(canvas.captureStream(30), { mimeType });
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.start();
});

async function finishRecording() {
  const stats = tracker.stats();
  const frames = tracker.frames;
  tracker = null;
  $('#rec-btn').classList.remove('recording');
  $('#rec-btn').textContent = '● Record 10s';
  const stopped = new Promise((r) => (recorder.onstop = r));
  recorder.stop();
  await stopped;
  if (!stats.knee) {
    $('#cap-status').textContent = 'No body detected during the recording. Check framing and light, then try again.';
    return;
  }
  const type = recorder.mimeType.split(';')[0];
  const clip = `clip-${Date.now()}.${type === 'video/mp4' ? 'mp4' : 'webm'}`;
  await api(`/api/sessions/${session.id}/files/${clip}`, { method: 'POST', body: new Blob(chunks, { type }) });
  session.angles = { stats, side, frames, clip, recorded_at: new Date().toISOString() };
  await saveNow();
  renderRecorded();
  $('#cap-status').textContent = `Recorded ${frames} frames (${side} side). Ask the coach about it →`;
}

function renderRecorded() {
  const a = session?.angles;
  if (!a) {
    $('#recorded').className = 'muted';
    $('#recorded').textContent = 'Nothing recorded yet. Start pedalling at steady effort, then press Record.';
    return;
  }
  const targets = TARGETS[session.bike?.type] ?? {};
  const judged = Object.values(targets).map((t) => {
    const v = a.stats[t.angle]?.[t.stat];
    return `<tr><td>${t.label}</td><td class="${status(v, t.range)}">${fmt(v)}°</td><td class="muted">${t.range[0]}–${t.range[1]}°</td></tr>`;
  }).join('');
  const raw = Object.entries(a.stats).map(([k, s]) => `<tr><td>${k}</td><td>${s.min}</td><td>${s.max}</td><td>${s.mean}</td></tr>`).join('');
  $('#recorded').classList.remove('muted');
  $('#recorded').innerHTML = `
    ${judged ? `<table><thead><tr><th>Check</th><th>Value</th><th>Target</th></tr></thead><tbody>${judged}</tbody></table>`
      : `<p class="muted">No target ranges for ${esc(session.bike?.type)} bikes yet.</p>`}
    <h3>All angles (min / max / mean)</h3>
    <table><thead><tr><th>Angle</th><th>Min</th><th>Max</th><th>Mean</th></tr></thead><tbody>${raw}</tbody></table>
    <p class="muted small">${a.frames} frames, ${a.side} side, ${new Date(a.recorded_at).toLocaleString()} · <a href="/data/${session.id}/${a.clip}" target="_blank">clip</a></p>`;
}

// Freeze, then drag joints to correct detection errors.
$('#freeze-btn').addEventListener('click', () => {
  frozen = !frozen;
  canvas.classList.toggle('frozen', frozen);
  $('#freeze-btn').textContent = frozen ? 'Resume' : 'Freeze';
  if (source === 'video') frozen ? video.pause() : video.play();
  draw();
});

let dragging = null;
function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * canvas.width) / r.width, y: ((e.clientY - r.top) * canvas.height) / r.height, scale: canvas.width / r.width };
}
canvas.addEventListener('pointerdown', (e) => {
  if (!frozen || !joints) return;
  const p = canvasPoint(e);
  let best = null, bestD = 30 * p.scale;
  for (const [name, j] of Object.entries(joints)) {
    const d = Math.hypot(j.x - p.x, j.y - p.y);
    if (d < bestD) { best = name; bestD = d; }
  }
  dragging = best;
  if (best) canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const p = canvasPoint(e);
  joints[dragging] = { x: p.x, y: p.y };
  renderLive(computeAngles(joints));
  draw();
});
canvas.addEventListener('pointerup', () => (dragging = null));

$('#snap-btn').addEventListener('click', async () => {
  draw();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const file = `snap-${Date.now()}.png`;
  await api(`/api/sessions/${session.id}/files/${file}`, { method: 'POST', body: blob });
  const angles = joints ? Object.fromEntries(Object.entries(computeAngles(joints)).map(([k, v]) => [k, Math.round(v)])) : null;
  (session.snapshots ??= []).push({ file, angles, at: new Date().toISOString() });
  await saveNow();
  renderSnapshots();
});

function renderSnapshots() {
  const snaps = session?.snapshots ?? [];
  $('#snapshots').innerHTML = snaps.length
    ? snaps.map((s) => `<a href="/data/${session.id}/${s.file}" target="_blank"><img src="/data/${session.id}/${s.file}" alt="Snapshot"><span>${s.angles ? `knee ${s.angles.knee}° · torso ${s.angles.torso}°` : 'no pose'}</span></a>`).join('')
    : '<span class="muted">None yet. Freeze on a key frame (pedal at the bottom, or 3 o\'clock) and save one.</span>';
}

// ---------- Sessions ----------
let sessions = [];
let cmpA = null, cmpB = null;

async function renderSessions() {
  sessions = await api('/api/sessions');
  $('#session-rows').innerHTML = sessions.map((s) => `
    <tr class="${s.id === session?.id ? 'active' : ''}">
      <td><input type="radio" name="cmpA" value="${s.id}" ${s.id === cmpA ? 'checked' : ''} aria-label="Compare A"></td>
      <td><input type="radio" name="cmpB" value="${s.id}" ${s.id === cmpB ? 'checked' : ''} aria-label="Compare B"></td>
      <td><strong>${esc(s.label)}</strong><div class="muted small">${esc(s.created)}</div></td>
      <td>${esc([s.bike?.brand, s.bike?.model, s.bike?.size].filter(Boolean).join(' ') || s.bike?.type)}</td>
      <td>${s.id === session?.id ? '<span class="muted">current</span>' : `<button data-open="${s.id}">Open</button>`}</td>
    </tr>`).join('');
}

$('#session-rows').addEventListener('click', (e) => {
  if (e.target.dataset.open) loadSession(e.target.dataset.open);
});
$('#session-rows').addEventListener('change', (e) => {
  if (e.target.name === 'cmpA') cmpA = e.target.value;
  if (e.target.name === 'cmpB') cmpB = e.target.value;
  if (cmpA && cmpB) renderCompare();
});

$('#new-session').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (saveTimer) await saveNow();
  const s = await api('/api/sessions', { method: 'POST', body: { label: $('#new-label').value, copy_from: session?.id } });
  $('#new-label').value = '';
  await loadSession(s.id);
});

async function renderCompare() {
  const [a, b] = await Promise.all([api(`/api/sessions/${cmpA}`), api(`/api/sessions/${cmpB}`)]);
  const labels = Object.fromEntries(GROUPS.flatMap((g) => g.fields.map(([k, l, kind]) => [k, [l, kind]])));
  const delta = (x, y) => (typeof x === 'number' && typeof y === 'number' && x !== y ? `${y > x ? '+' : ''}${Math.round((y - x) * 10) / 10}` : '');
  const keys = [...new Set([...Object.keys(a.measurements || {}), ...Object.keys(b.measurements || {})])];
  const mRows = keys.map((k) => {
    const [x, y] = [a.measurements?.[k], b.measurements?.[k]];
    const d = delta(x, y);
    return `<tr><td>${esc(labels[k]?.[0] ?? k)}</td><td>${esc(x)}</td><td>${esc(y)}</td><td class="${d ? 'near' : ''}">${d}</td></tr>`;
  }).join('');
  const targets = TARGETS[b.bike?.type] ?? TARGETS.road;
  const aRows = Object.values(targets).map((t) => {
    const [x, y] = [a.angles?.stats?.[t.angle]?.[t.stat], b.angles?.stats?.[t.angle]?.[t.stat]];
    return `<tr><td>${t.label}</td><td class="${status(x, t.range)}">${fmt(x)}°</td><td class="${status(y, t.range)}">${fmt(y)}°</td><td>${delta(x, y)}</td></tr>`;
  }).join('');
  const snap = (s) => s.snapshots?.at(-1) ? `<img src="/data/${s.id}/${s.snapshots.at(-1).file}" alt="Latest snapshot of ${esc(s.label)}">` : '<span class="muted">no snapshot</span>';
  $('#compare').classList.remove('muted');
  $('#compare').innerHTML = `
    <table><thead><tr><th>Angle</th><th>${esc(a.label)}</th><th>${esc(b.label)}</th><th>Δ</th></tr></thead><tbody>${aRows}</tbody></table>
    <h3>Measurements</h3>
    <table><thead><tr><th>Field</th><th>${esc(a.label)}</th><th>${esc(b.label)}</th><th>Δ</th></tr></thead><tbody>${mRows || '<tr><td colspan="4" class="muted">No measurements</td></tr>'}</tbody></table>
    <h3>Latest snapshots</h3><div class="thumbs"><a>${snap(a)}</a><a>${snap(b)}</a></div>`;
}

// ---------- Chat ----------
// The coach ends each reply with "Next:" and a bullet list. Those bullets become clickable chips.
function splitNext(text) {
  const m = text.match(/\n[ \t]*\**Next:?\**:?[ \t]*\n((?:[ \t]*[-*•][ \t]+.+(?:\n|$))+)\s*$/i);
  if (!m) return [text, []];
  return [text.slice(0, m.index), m[1].split('\n').map((l) => l.replace(/^\s*[-*•]\s+/, '').trim()).filter(Boolean)];
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role === 'assistant') div.innerHTML = DOMPurify.sanitize(marked.parse(splitNext(text)[0]));
  else div.textContent = text;
  if (role === 'assistant') div.querySelectorAll('a').forEach((a) => (a.target = '_blank'));
  $('#messages').append(div);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return div;
}

function setChips(text) {
  const chips = text ? splitNext(text)[1] : [];
  $('#chips').innerHTML = '';
  for (const c of chips) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c;
    b.onclick = () => send(c);
    $('#chips').append(b);
  }
}

async function loadChat() {
  $('#messages').innerHTML = '';
  const { messages } = await api(`/api/sessions/${session.id}/chat`);
  messages.forEach((m) => addMessage(m.role, m.text));
  if (!messages.length) addMessage('assistant', 'Hi! I\'m your fit coach. Press **Start guided fit** and I\'ll take you from zero to a dialled position one step at a time, or just ask me anything.');
  setChips(messages.at(-1)?.role === 'assistant' ? messages.at(-1).text : null);
}

let busy = false;
async function send(message, fresh = false) {
  if (busy || !message.trim()) return;
  busy = true;
  document.querySelectorAll('#chat-form button, #guided-btn').forEach((b) => (b.disabled = true));
  if (saveTimer) await saveNow(); // the coach reads session.json, so flush pending edits first
  if (fresh) $('#messages').innerHTML = '';
  addMessage('user', message);
  setChips(null);
  const pending = addMessage('pending', 'Coach is thinking… (bike lookups on the web can take a minute)');
  try {
    const { reply } = await api('/api/chat', { method: 'POST', body: { session_id: session.id, message, fresh } });
    pending.remove();
    addMessage('assistant', reply);
    setChips(reply);
  } catch (e) {
    pending.remove();
    addMessage('error', `Chat failed: ${e.message}`);
  } finally {
    busy = false;
    document.querySelectorAll('#chat-form button, #guided-btn').forEach((b) => (b.disabled = false));
  }
}

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#chat-input').value;
  $('#chat-input').value = '';
  send(v);
});
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#chat-form').requestSubmit();
  }
});
$('#guided-btn').addEventListener('click', () => {
  const hasChat = $('#messages .msg.user');
  if (hasChat && !confirm('Start a new guided fit conversation for this session? The current chat is replaced.')) return;
  send('Start a guided bike fit. Begin at the first step that is not done yet, based on what is already in my session.', true);
});

// ---------- Boot ----------
(async () => {
  renderLive({});
  const list = await api('/api/sessions');
  const saved = localStorage.getItem('bikefit.session');
  const id = list.find((s) => s.id === saved)?.id ?? list[0]?.id ?? (await api('/api/sessions', { method: 'POST', body: { label: 'First fit' } })).id;
  await loadSession(id);
  requestAnimationFrame(tick);
  initPose().catch((e) => ($('#cap-status').textContent = `Pose model failed to load (needs internet the first time): ${e.message}`));
})();
