'use strict';
/* ===== core ===== */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let ME = null, S = null, P = null;
const ACT = {}, FORM = {};
const speechOK = 'speechSynthesis' in window;

function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', err ? 4500 : 2200);
}
let RT = 0;
class Stale extends Error {}
async function api(path, opt = {}) {
  const tok = RT;
  const o = {method: opt.method || 'GET', headers: {}, credentials: 'same-origin'};
  if (opt.json !== undefined) { o.body = JSON.stringify(opt.json); o.headers['Content-Type'] = 'application/json'; if (!opt.method) o.method = 'POST'; }
  if (opt.form) { o.body = opt.form; o.method = 'POST'; }
  const r = await fetch('/api' + path, o);
  if (r.status === 401 && path !== '/login') { ME = null; location.hash = '#/login'; throw new Error('Please log in'); }
  if (!r.ok) {
    let m = r.statusText; try { const j = await r.json(); m = typeof j.detail === 'string' ? j.detail : (j.detail || []).map(e => (e.loc || []).slice(-1) + ': ' + e.msg).join('; '); } catch (e) {}
    throw new Error(m);
  }
  const data = await r.json();
  if (o.method === 'GET' && tok !== RT) throw new Stale('navigated away');  // a page is no longer waiting for this answer
  return data;
}
const speak = t => { if (!speechOK) return; speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(t.replace(/…|\.\.\./g, ' ')); u.lang = 'en-US'; u.rate = .9; speechSynthesis.speak(u); };
function fmtDue(iso) {
  if (!iso) return '—';
  const d = new Date(iso), ms = d - Date.now();
  if (ms <= 0) return 'Due now';
  const m = ms / 60000;
  if (m < 60) return `in ${Math.max(1, Math.round(m))} min`;
  if (m < 1440) return `in ${Math.round(m / 60)} h`;
  return `in ${Math.round(m / 1440)} d (${d.toLocaleDateString(undefined, {day: 'numeric', month: 'short'})})`;
}
function bar(c) {
  const t = c.total || 1, l = c.learning + c.relearning;
  return `<div class="bar" title="New ${c.new} · Learning ${l} · Review ${c.review} · Mature ${c.mature}"><i class="m" style="width:${100*c.mature/t}%"></i><i class="r" style="width:${100*c.review/t}%"></i><i class="l" style="width:${100*l/t}%"></i><i class="n" style="width:${100*c.new/t}%"></i></div>`;
}
const legend = `<div class="legend"><span><i style="background:var(--mat)"></i>Mature</span><span><i style="background:var(--rev)"></i>Review</span><span><i style="background:var(--learn)"></i>Learning</span><span><i style="background:var(--new);opacity:.4"></i>New</span></div>`;
const badge = s => `<span class="badge b-${s}">${s}</span>`;
function applyTheme(t) { document.documentElement.dataset.theme = t || 'light'; try { localStorage.setItem('theme', t); } catch (e) {} }
try { applyTheme(localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')); } catch (e) {}

function modal(html) {
  closeModal();
  const bg = document.createElement('div'); bg.className = 'modal-bg'; bg.id = 'modal';
  bg.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  bg.addEventListener('mousedown', e => { if (e.target === bg) closeModal(); });
  document.body.appendChild(bg);
  const f = bg.querySelector('input,select,textarea'); if (f) f.focus();
}
function closeModal() { const m = $('#modal'); if (m) m.remove(); }

/* ===== shell & router ===== */
const STUDENT_NAV = [['dash','🏠','Dashboard'],['vocab','📚','My Vocabulary'],['learn','✨','Learn'],['review','🔁','Review'],['practice','🎯','Practice'],['progress','📈','Progress'],['settings','⚙️','Settings']];
const TEACHER_NAV = [['t/overview','🗂️','Levels & topics'],['t/vocab','📚','Vocabulary'],['t/students','👩‍🎓','Students'],['t/assign','📌','Assignments'],['t/difficult','⚠️','Difficult words'],['t/data','⇅','Import / export'],['t/settings','⚙️','Settings']];
function shell(active, html) {
  const nav = (ME.role === 'teacher' ? TEACHER_NAV : STUDENT_NAV).map(([k, ic, l]) => `<a href="#/${k}" class="${active === k ? 'on' : ''}"><span class="ic">${ic}</span>${l}</a>`).join('');
  return `<div class="shell"><aside class="side"><div class="brand"><i></i>Vocabulary Trainer</div><nav class="nav">${nav}</nav><div class="who">${ME.role === 'student' ? esc(ME.name) + '<br>Level ' + esc(ME.level) : 'Teacher account<br>@' + esc(ME.username)}</div></aside><main>${html}</main></div>`;
}
const view = html => { $('#app').innerHTML = html; window.scrollTo(0, 0); };

async function route() {
  RT++; closeModal();
  const h = (location.hash.replace(/^#\/?/, '') || '').split('?')[0];
  if (S && !h.startsWith('session')) S = null;
  if (!ME) { try { ME = await api('/me'); applyTheme(ME.theme); } catch (e) { ME = null; } }
  if (!ME) return loginView();
  if (h === 'login' || h === '') return (location.hash = ME.role === 'teacher' ? '#/t/overview' : '#/dash');
  try {
    if (ME.role === 'teacher') {
      if (!h.startsWith('t/')) return (location.hash = '#/t/overview');
      const fn = {'t/overview': tOverview, 't/vocab': tVocab, 't/students': tStudents, 't/assign': tAssign, 't/difficult': tDifficult, 't/data': tData, 't/settings': settingsView}[h.split('/').slice(0, 2).join('/')];
      return fn ? await fn(h) : (location.hash = '#/t/overview');
    }
    if (h.startsWith('t/')) return (location.hash = '#/dash');
    if (h.startsWith('session/')) return await sessionView(h);
    const fn = {dash: dashView, vocab: vocabView, learn: learnView, review: reviewView, practice: practiceView, progress: progressView, settings: settingsView}[h];
    return fn ? await fn() : (location.hash = '#/dash');
  } catch (e) { if (ME && !(e instanceof Stale)) { toast(e.message, true); } }
}
window.addEventListener('hashchange', route);
// clicking a link to the page you are already on (e.g. "Practise again") should re-open it
document.addEventListener('click', e => { const a = e.target.closest('a[href^="#/"]'); if (a && a.getAttribute('href') === location.hash && !e.defaultPrevented) { e.preventDefault(); P = P && P.running ? P : null; route(); } });

function loginView() {
  view(`<div class="login"><div class="card"><div class="brand" style="padding:0 0 14px"><i></i>Vocabulary Trainer</div><h2>Log in</h2>
  <form data-form="login"><label for="u">Username</label><input id="u" name="username" autocomplete="username" required><label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
  <button class="btn pri big" style="width:100%;margin-top:18px">Log in</button></form><p class="muted small mt">Your teacher creates your account. Ask them if you forgot your password.</p></div></div>`);
}
FORM.login = async f => {
  ME = await api('/login', {json: {username: f.username.value, password: f.password.value}});
  applyTheme(ME.theme); location.hash = ME.role === 'teacher' ? '#/t/overview' : '#/dash'; route();
};
ACT.logout = async () => { await api('/logout', {method: 'POST'}); ME = null; location.hash = '#/login'; route(); };

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = ACT[el.dataset.act]; if (!fn) return;
  try { await fn(el, e); } catch (err) { if (!(err instanceof Stale)) toast(err.message, true); }
});
document.addEventListener('submit', async e => {
  const f = e.target.closest('[data-form]'); if (!f) return;
  e.preventDefault();
  try { await FORM[f.dataset.form](f, e); } catch (err) { if (!(err instanceof Stale)) toast(err.message, true); }
});
ACT.speak = el => speak(el.dataset.t);
ACT.close = closeModal;

/* ===== student: dashboard ===== */
async function dashView() {
  const d = await api('/student/dashboard'), t = d.totals;
  if (!t.total) return view(shell('dash', `<h1>Welcome, ${esc(ME.name.split(' ')[0])}</h1><div class="card empty"><h2>No vocabulary yet</h2><p>Your teacher has not published or assigned any topics to you yet. Check back soon.</p></div>`));
  const idle = !d.due && !d.new_recommended;
  const btns = [];
  if (d.due) btns.push(`<a class="btn big" href="#/session/review/0">Review ${d.due} due</a>`);
  if (d.new_recommended) btns.push(`<a class="btn ${d.due ? 'ghost' : 'big'}" href="#/session/learn/0">Learn ${d.new_recommended} new</a>`);
  if (idle) btns.push(`<a class="btn big" href="#/session/extra/0">Practise extra words</a>`);
  const mx = Math.max(1, ...d.week.map(w => w.reviews));
  view(shell('dash', `<h1>Hello, ${esc(ME.name.split(' ')[0])} 👋</h1>
  <div class="hero mb"><div class="card today"><div class="small muted" style="letter-spacing:.06em;text-transform:uppercase;font-weight:700">Today</div>
    <div class="nums"><div><b>${d.due}</b>reviews due</div><div><b>${d.new_recommended}</b>new words</div><div><b>${d.est_minutes}</b>min (est.)</div></div>
    <div class="row">${btns.join('')}</div>
    <p class="small muted mt" style="margin-bottom:0">${idle ? (t.new ? 'You have reached today\'s goal. Come back tomorrow for new words.' : 'Nothing due right now. 🎉') : `Daily goal: ${d.daily_new >= 1000 ? 'no limit' : d.daily_new + ' new words'} (${d.new_today} started today). Reviews come first.`}</p></div>
    <div class="card"><div class="row between"><h3 style="margin:0">Streak</h3><span class="badge ${d.studied_today ? 'b-mature' : ''}">${d.studied_today ? 'studied today' : 'not yet today'}</span></div>
    <div style="font-size:3rem;font-weight:800;letter-spacing:-.03em">🔥 ${d.streak}<span class="muted" style="font-size:1rem;font-weight:500"> day${d.streak === 1 ? '' : 's'}</span></div>
    <p class="muted small">${d.reviews_today} reviews today · Level ${esc(d.level)}</p></div></div>
  <div class="grid g4 keep mb"><div class="card stat"><b>${t.seen}</b><span>words learned (started)</span></div><div class="card stat"><b>${t.due}</b><span>due now</span></div>
    <div class="card stat"><b>${t.learning + t.relearning + t.review}</b><span>in learning / review</span></div><div class="card stat"><b>${t.mature}</b><span>mastered (mature)</span></div></div>
  <div class="grid g2"><div class="card"><h2>This week</h2><div class="chart">${d.week.map(w => `<div><b>${w.reviews || ''}</b><i style="height:${Math.max(2, 100 * w.reviews / mx)}%"></i>${w.date.split(' ')[0]}</div>`).join('')}</div></div>
  <div class="card"><h2>All words</h2>${bar(t)}<div class="mt">${legend}</div><p class="small muted mt">${t.new} new · ${t.learning + t.relearning} learning · ${t.review} review · ${t.mature} mature, of ${t.total}.</p><p class="small muted">Mature = remembered for 21+ days.</p></div></div>
  <div class="card mt"><h2>Topics</h2>${d.topics.map(tp => `<div class="topic"><div><b>${esc(tp.title)}</b> <span class="badge">${tp.level}</span><div class="small muted">${tp.seen}/${tp.total} started · ${tp.due} due · ${tp.mature} mastered</div></div>
    <div>${bar(tp)}<div class="row mt">${tp.due ? `<a class="btn sm" href="#/session/review/${tp.id}">Review ${tp.due}</a>` : ''}${tp.new ? `<a class="btn sm pri" href="#/session/learn/${tp.id}">Learn new</a>` : ''}</div></div></div>`).join('')}</div>`));
}

/* ===== student: vocabulary ===== */
async function vocabView() {
  const [d, all] = await Promise.all([api('/student/dashboard'), api('/student/vocabulary')]);
  window._V = all;
  view(shell('vocab', `<h1>My Vocabulary</h1><div class="card"><div class="row mb"><input id="vq" placeholder="Search English or Uzbek…" style="max-width:260px" data-input="vocab">
   <select id="vt" data-input="vocab" style="max-width:240px"><option value="">All topics</option>${d.topics.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}</select>
   <select id="vs" data-input="vocab" style="max-width:160px"><option value="">All statuses</option><option>new</option><option>learning</option><option>review</option><option>relearning</option><option>mature</option></select><span id="vcount" class="muted small right"></span></div>
   <div class="tablewrap"><table><thead><tr><th>English</th><th>Uzbek</th><th>Status</th><th>Next review</th></tr></thead><tbody id="vbody"></tbody></table></div></div>`));
  vocabFilter();
}
async function vocabFilter() {
  const q = $('#vq').value.toLowerCase(), t = $('#vt').value, s = $('#vs').value;
  let rows = window._V;
  if (t) { rows = await api('/student/vocabulary?topic_id=' + t); }
  rows = rows.filter(c => (!q || c.en.toLowerCase().includes(q) || c.uz.toLowerCase().includes(q)) && (!s || c.status === s));
  $('#vcount').textContent = rows.length + ' words';
  $('#vbody').innerHTML = rows.map(c => `<tr><td><b>${esc(c.en)}</b> ${speechOK ? `<button class="iconbtn" data-act="speak" data-t="${esc(c.en)}" aria-label="Pronounce ${esc(c.en)}">🔊</button>` : ''}${c.pos ? `<span class="small muted"> ${esc(c.pos)}</span>` : ''}<div class="small muted">${esc(c.ex)}</div></td><td>${esc(c.uz)}</td><td>${badge(c.status)}</td><td class="small">${c.status === 'new' ? '—' : fmtDue(c.due)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No words match.</td></tr>';
}
document.addEventListener('input', e => { if (e.target.dataset && e.target.dataset.input === 'vocab') vocabFilter(); });

/* ===== student: learn / review hubs ===== */
async function learnView() {
  const d = await api('/student/dashboard');
  const left = Math.max(0, d.daily_new - d.new_today);
  view(shell('learn', `<h1>Learn new vocabulary</h1><p class="muted">Daily goal: <b>${d.daily_new >= 1000 ? 'no limit (all words)' : d.daily_new + ' new words'}</b>${d.daily_new >= 1000 ? '' : ` · <b>${left}</b> left today`}. Change it in Settings.</p>
  <div class="grid g2">${d.topics.map(t => `<div class="card"><div class="row between"><h3 style="margin:0">${esc(t.title)}</h3><span class="badge">${t.level}</span></div>${bar(t)}
   <p class="small muted mt">${t.new} new · ${t.learning + t.relearning} learning · ${t.mature} mastered</p>
   <a class="btn pri ${t.new && left ? '' : 'hide'}" href="#/session/learn/${t.id}">Learn ${Math.min(t.new, left)} new word${Math.min(t.new, left) === 1 ? '' : 's'}</a>
   <span class="muted small ${t.new && left ? 'hide' : ''}">${t.new ? 'Daily goal reached' : 'All words started 🎉'}</span></div>`).join('') || '<div class="card empty">No topics assigned yet.</div>'}</div>`));
}
async function reviewView() {
  const d = await api('/student/dashboard');
  view(shell('review', `<h1>Review</h1><div class="card today mb"><h2 style="color:#fff">Mixed review</h2><p>Due cards from all the topics you have studied.</p>
   <div class="row"><a class="btn big ${d.due ? '' : 'hide'}" href="#/session/mixed/0">Review ${d.due} due cards</a><span class="${d.due ? 'hide' : ''}">Nothing is due right now. 🎉</span><a class="btn ghost" href="#/session/extra/0">Practise extra words</a></div>
   <p class="small muted" style="margin:10px 0 0">Extra practice uses words you started but that are not due yet. It also updates their schedule.</p></div>
  <div class="grid g2">${d.topics.filter(t => t.seen).map(t => `<div class="card"><h3>${esc(t.title)}</h3>${bar(t)}<p class="small muted mt">${t.seen} started · <b>${t.due}</b> due</p><a class="btn ${t.due ? 'pri' : ''}" ${t.due ? '' : 'aria-disabled="true" style="opacity:.5;pointer-events:none"'} href="#/session/review/${t.id}">Review ${t.due} due</a></div>`).join('') || '<div class="card empty">Learn some words first, then reviews will appear here.</div>'}</div>`));
}

/* ===== flashcard session ===== */
async function sessionView(h) {
  const [, mode, tid] = h.split('/');
  const r = await api(`/student/session?mode=${mode}&limit=200${+tid ? '&topic_id=' + tid : ''}`);
  if (!r.cards.length) {
    const why = mode === 'learn' ? (r.new_quota_left ? 'There are no new words left in this topic.' : 'You have reached today\'s new-word goal. Change the goal in Settings if you want more.') : mode === 'extra' ? 'You have not started any words yet.' : 'Nothing is due right now. Come back later!';
    return view(shell(mode === 'learn' ? 'learn' : 'review', `<div class="card empty"><h2>Nothing to study here</h2><p>${why}</p><a class="btn pri" href="#/dash">Back to dashboard</a></div>`));
  }
  S = {mode, tid, queue: r.cards.slice(), total: r.cards.length, done: 0, rates: {1: 0, 2: 0, 3: 0, 4: 0}, t0: Date.now(), flipped: false, paused: false, cur: null};
  nextCard();
}
function pickFace(c) {
  const d = ME.direction;
  const opts = ['en2uz', 'uz2en'].concat(c.cloze ? ['cloze'] : []);
  if (d === 'mixed') return opts[Math.floor(Math.random() * opts.length)];
  if (d === 'cloze' && !c.cloze) return 'en2uz';
  return d;
}
function nextCard() {
  if (!S.queue.length) return finish();
  const c = S.queue[0]; S.cur = c; S.flipped = false; c._m = c._m || pickFace(c); S.t1 = Date.now();
  const m = c._m, isNew = c.status === 'new';
  const front = m === 'en2uz' ? `<div class="tag">English → Uzbek</div><div class="big">${esc(c.en)}</div>${c.pos ? `<div class="sub">${esc(c.pos)}</div>` : ''}`
    : m === 'uz2en' ? `<div class="tag">Uzbek → English</div><div class="big">${esc(c.uz)}</div>`
    : `<div class="tag">Fill the gap</div><div class="big" style="font-size:1.55rem">${esc(c.cloze).replace('_____', '<span class="blank">_____</span>')}</div>${c.ex_uz ? `<div class="sub">${esc(c.ex_uz)}</div>` : ''}`;
  const back = `<div class="tag">Answer</div><div class="big">${esc(m === 'cloze' ? c.cloze_answer : c.en)} ${speechOK ? `<button class="iconbtn" data-act="speak" data-t="${esc(c.en)}" aria-label="Pronounce">🔊</button>` : ''}</div>
    <div class="big" style="font-size:1.35rem;color:var(--accent)">${esc(c.uz)}</div>${c.pos ? `<div class="sub">${esc(c.pos)}</div>` : ''}${c.definition ? `<div class="def">${esc(c.definition)}</div>` : ''}
    ${c.ex ? `<div class="exs">“${esc(c.ex)}”</div>` : ''}${c.ex_uz && m !== 'cloze' ? `<div class="sub small">${esc(c.ex_uz)}</div>` : ''}${c.note ? `<div class="small muted">📝 ${esc(c.note)}</div>` : ''}`;
  const pct = 100 * S.done / S.total;
  view(`<div class="study"><div class="top"><a class="iconbtn" href="#/dash" aria-label="Exit">✕</a><div class="bar"><i style="width:${pct}%"></i></div><b>${S.done} / ${S.total}</b><button class="iconbtn" data-act="pause" aria-label="Pause">⏸</button></div>
  <div class="row small muted" style="margin-bottom:8px"><span class="badge b-${c.status}">${isNew ? 'NEW' : c.status}</span><span>${esc(c.topic)}</span></div>
  <div class="scene"><div class="flip" id="flip" data-act="flip" tabindex="0" role="button" aria-label="Flip card"><div class="face">${front}<div class="hint">Space or click to show the answer</div></div><div class="face back">${back}</div></div></div>
  <button class="btn pri big showbtn" id="showbtn" data-act="flip">Show answer</button>
  <div class="rate hide" id="rate"><button class="r1" data-act="rate" data-r="1">Again<small id="iv1"></small></button><button class="r2" data-act="rate" data-r="2">Hard<small id="iv2"></small></button><button class="r3" data-act="rate" data-r="3">Good<small id="iv3"></small></button><button class="r4" data-act="rate" data-r="4">Easy<small id="iv4"></small></button></div>
  <p class="small muted" style="text-align:center;margin-top:12px">Keys: Space = flip · 1 Again · 2 Hard · 3 Good · 4 Easy · Esc = pause</p></div>`);
  if (S.mode === 'learn' || true) { /* focus for keyboard */ }
}
ACT.flip = async () => {
  if (!S || S.flipped || S.paused) return;
  S.flipped = true; $('#flip').classList.add('on'); $('#showbtn').classList.add('hide'); $('#rate').classList.remove('hide');
  try { const p = await api('/student/preview?card_id=' + S.cur.id); for (const k of [1, 2, 3, 4]) { const e = $('#iv' + k); if (e) e.textContent = p[k]; } } catch (e) {}
};
ACT.rate = async el => {
  if (!S || !S.flipped || S.busy) return;
  S.busy = true;
  const c = S.cur, r = +el.dataset.r;
  try {
    const res = await api('/student/answer', {json: {card_id: c.id, rating: r, mode: c._m, ms: Date.now() - S.t1}});
    S.rates[r]++; S.queue.shift(); c.status = res.status;
    if (res.requeue && (r < 3 || S.queue.length)) { S.queue.splice(r === 1 ? Math.min(3, S.queue.length) : S.queue.length, 0, c); }
    else S.done++;
    S.last = res;
  } finally { S.busy = false; }
  nextCard();
};
ACT.pause = () => {
  if (!S) return; S.paused = true;
  view(`<div class="done"><div class="big">⏸</div><h1>Paused</h1><p class="muted">Every answer so far is already saved. You have ${S.queue.length} card${S.queue.length === 1 ? '' : 's'} left in this session. If you leave, the cards that are still due will be waiting for you.</p>
  <div class="row" style="justify-content:center"><button class="btn pri big" data-act="resume">Continue</button><a class="btn big" href="#/dash">Leave</a></div></div>`);
};
ACT.resume = () => { S.paused = false; nextCard(); };
async function finish() {
  const n = S.total, r = S.rates, tot = r[1] + r[2] + r[3] + r[4], good = r[3] + r[4], secs = Math.round((Date.now() - S.t0) / 1000);
  const d = await api('/student/dashboard');
  view(`<div class="done"><div class="big">🎉</div><h1>Session complete</h1><p class="muted">${n} card${n === 1 ? '' : 's'} · ${tot} answers · ${Math.floor(secs / 60)}m ${secs % 60}s</p>
  <div class="grid g4 keep mt mb"><div class="card stat"><b style="color:var(--bad)">${r[1]}</b><span>Again</span></div><div class="card stat"><b style="color:var(--warn)">${r[2]}</b><span>Hard</span></div><div class="card stat"><b style="color:var(--good)">${r[3]}</b><span>Good</span></div><div class="card stat"><b style="color:#3b82d6">${r[4]}</b><span>Easy</span></div></div>
  <p>${tot ? Math.round(100 * good / tot) : 0}% recalled · ${d.due} still due · ${d.new_recommended} new words left for today</p>
  <div class="row" style="justify-content:center"><a class="btn pri big" href="#/dash">Dashboard</a>${d.due ? '<a class="btn big" href="#/session/review/0">Review more</a>' : ''}</div></div>`);
  S = null;
}
document.addEventListener('keydown', e => {
  if (!S || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (S.paused) { if (e.key === 'Enter' || e.key === 'Escape') ACT.resume(); return; }
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); ACT.flip(); }
  else if (['1', '2', '3', '4'].includes(e.key) && S.flipped) ACT.rate({dataset: {r: e.key}});
  else if (e.key === 'Escape') ACT.pause();
});

/* ===== practice activities ===== */
const ACTS = [['mc', 'Multiple choice', 'Pick the right translation'], ['type', 'Type the answer', 'Uzbek → type the English'], ['cloze', 'Fill in the blank', 'Complete the sentence'],
  ['match', 'Matching', 'Pair English and Uzbek'], ['reverse', 'Reverse translation', 'Uzbek sentence → English'], ['mixed', 'Mixed practice', 'A bit of everything']];
const rnd = a => a[Math.floor(Math.random() * a.length)];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const norm = s => String(s).toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
function variants(en) {
  const out = new Set([norm(en.replace(/…|\.\.\./g, ' '))]);   // the whole headword exactly as shown, e.g. "send / receive"
  en.split(/\s*\/\s*/).forEach(a => {
    let b = a.replace(/\(.*?\)/g, ' ').split(/\+|…|\.\.\./)[0];
    b = norm(b); if (b) { out.add(b); out.add(b.replace(/^to /, '')); }
    const full = norm(a.replace(/…|\.\.\./g, ' ')); if (full) out.add(full);
  });
  return [...out].filter(Boolean);
}
function lev(a, b) { const m = a.length, n = b.length, d = Array.from({length: m + 1}, (_, i) => [i]); for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)); return d[m][n]; }
const sim = (a, b) => { a = norm(a); b = norm(b); const L = Math.max(a.length, b.length); return L ? 1 - lev(a, b) / L : 1; };

async function practiceView() {
  if (P && P.running) { return runQ(); }
  const d = await api('/student/dashboard');
  window._pt = d.topics;
  view(shell('practice', `<h1>Practice</h1><p class="muted">Extra activities to strengthen your vocabulary. Results are saved to your activity record, but <b>they do not change your review schedule</b>; only flashcard reviews do.</p>
  <div class="card mb"><div class="row"><div style="flex:1;min-width:200px"><label for="pt">Topic</label><select id="pt"><option value="0">All my topics</option>${d.topics.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}</select></div>
  <div style="width:130px"><label for="pn">Questions</label><select id="pn"><option>10</option><option>20</option><option>30</option></select></div>
  <div style="flex:1;min-width:200px"><label>&nbsp;</label><label style="display:flex;gap:8px;align-items:center;font-weight:500;color:var(--text)"><input type="checkbox" id="pall" style="width:auto"> Include words I haven't started</label></div></div></div>
  <div class="grid g3">${ACTS.map(([k, t, s]) => `<button class="card" style="text-align:left;cursor:pointer" data-act="startprac" data-k="${k}"><h3>${t}</h3><p class="muted small" style="margin:0">${s}</p></button>`).join('')}</div>`));
}
ACT.startprac = async el => {
  const tid = +$('#pt').value, n = +$('#pn').value, inclNew = $('#pall').checked, kind = el.dataset.k;
  const all = await api('/student/vocabulary'); const pool0 = tid ? await api('/student/vocabulary?topic_id=' + tid) : all;
  let pool = pool0.filter(c => inclNew || c.status !== 'new');
  if (pool.length < 4) { if (!inclNew) return toast('Not enough started words yet. Tick “Include words I haven’t started” or learn some first.', true); return toast('Need at least 4 words for practice.', true); }
  P = {kind, all, pool, n: Math.min(n, kind === 'match' ? 40 : pool.length), i: 0, res: [], running: true};
  P.qs = buildQs(kind, pool, all, P.n);
  if (!P.qs.length) { P = null; return toast('No suitable words for this activity in the chosen set.', true); }
  runQ();
};
function distract(all, card, key, k = 3) {
  const seen = new Set([norm(card[key])]); const out = [];
  for (const c of shuffle(all)) { const v = norm(c[key]); if (!seen.has(v) && c.level === card.level) { seen.add(v); out.push(c[key]); if (out.length === k) break; } }
  return out;
}
function mkQ(kind, c, all) {
  if (kind === 'mc') { const dir = Math.random() < .5 ? 'en2uz' : 'uz2en'; const ans = dir === 'en2uz' ? c.uz : c.en, key = dir === 'en2uz' ? 'uz' : 'en';
    return {t: 'mc', c, prompt: dir === 'en2uz' ? c.en : c.uz, label: dir === 'en2uz' ? 'What does this mean in Uzbek?' : 'Choose the English word or phrase', opts: shuffle([ans, ...distract(all, c, key)]), ans}; }
  if (kind === 'type') return {t: 'type', c, prompt: c.uz, label: 'Type the English word or phrase', acc: variants(c.en), model: c.en};
  if (kind === 'cloze') return c.cloze ? {t: 'cloze', c, prompt: c.cloze, hint: c.ex_uz, label: 'Type the missing word(s)', acc: [norm(c.cloze_answer), ...variants(c.en)], model: c.cloze_answer} : null;
  if (kind === 'reverse') return c.ex && c.ex_uz ? {t: 'reverse', c, prompt: c.ex_uz, label: 'Translate into English', model: c.ex} : null;
}
function buildQs(kind, pool, all, n) {
  if (kind === 'match') { const sh = shuffle(pool), out = []; for (let i = 0; i + 4 < sh.length + 1 && out.length < Math.ceil(n / 5); i += 5) { const g = sh.slice(i, i + 5); if (g.length >= 3) out.push({t: 'match', cards: g}); } return out; }
  const kinds = kind === 'mixed' ? ['mc', 'type', 'cloze', 'reverse'] : [kind];
  const out = [];
  for (const c of shuffle(pool)) { if (out.length >= n) break; for (const k of shuffle(kinds)) { const q = mkQ(k, c, all); if (q) { out.push(q); break; } } }
  return out;
}
function runQ() {
  const q = P.qs[P.i]; if (!q) return endPractice();
  const head = `<div class="row between mb"><a class="muted" href="#/practice" data-act="quitprac">✕ Quit</a><b>${P.i + 1} / ${P.qs.length}</b></div><div class="bar mb"><i style="background:var(--accent);width:${100 * P.i / P.qs.length}%"></i></div>`;
  let body = '';
  if (q.t === 'mc') body = `<div class="muted small">${q.label}</div><div class="q-big">${esc(q.prompt)}</div>${q.opts.map((o, i) => `<button class="opt" data-act="mcpick" data-i="${i}">${esc(o)}</button>`).join('')}`;
  else if (q.t === 'match') body = `<div class="muted small">Match each English word with its Uzbek meaning</div><div class="match mt"><div id="mL">${shuffle(q.cards).map(c => `<button class="opt" data-act="mpick" data-s="L" data-id="${c.id}">${esc(c.en)}</button>`).join('')}</div><div id="mR">${shuffle(q.cards).map(c => `<button class="opt" data-act="mpick" data-s="R" data-id="${c.id}">${esc(c.uz)}</button>`).join('')}</div></div><p id="mfb" class="muted small mt"></p>`;
  else body = `<div class="muted small">${q.label}</div><div class="q-big">${esc(q.prompt).replace('_____', '<span style="color:var(--accent)">_____</span>')}</div>${q.hint ? `<p class="muted small">Hint: ${esc(q.hint)}</p>` : ''}<form data-form="tcheck"><input id="ans" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Your answer" aria-label="Your answer"><div class="row mt"><button class="btn pri" id="chk">Check</button></div></form>`;
  view(shell('practice', `<div style="max-width:680px">${head}<div class="card" id="qcard">${body}<div id="qfb"></div></div></div>`));
  const a = $('#ans'); if (a) a.focus();
  P.cur = {done: false, mrem: q.t === 'match' ? q.cards.length : 0, first: {}};
}
ACT.quitprac = () => { P = null; };
function record(c, ok) { P.res.push({card_id: c.id, activity: P.qs[P.i].t === 'match' ? 'match' : P.qs[P.i].t === 'type' ? 'type' : P.qs[P.i].t, correct: ok, en: c.en, uz: c.uz}); }
function nextBtn() { $('#qfb').insertAdjacentHTML('beforeend', `<div class="row mt"><button class="btn pri" data-act="qnext" id="qn">Next →</button></div>`); const b = $('#qn'); if (b) b.focus(); }
ACT.qnext = () => { P.i++; runQ(); };
ACT.mcpick = el => {
  if (P.cur.done) return; P.cur.done = true; const q = P.qs[P.i], pick = q.opts[+el.dataset.i], ok = pick === q.ans;
  document.querySelectorAll('.opt').forEach(b => { if (q.opts[+b.dataset.i] === q.ans) b.classList.add('ok'); });
  if (!ok) el.classList.add('no'); record(q.c, ok);
  $('#qfb').innerHTML = `<div class="fb ${ok ? 'ok' : 'no'}">${ok ? 'Correct!' : 'Not quite. Answer: <b>' + esc(q.ans) + '</b>'}</div>`; nextBtn();
};
FORM.tcheck = f => {
  if (P.cur.done) return ACT.qnext(); P.cur.done = true;
  const q = P.qs[P.i], v = f.ans.value; let ok, extra = '';
  if (q.t === 'reverse') { const s = sim(v, q.model); ok = s >= .9; if (!ok && s >= .75) extra = ' <span class="muted">(close, check the details)</span>'; }
  else { const nv = norm(v); ok = q.acc.includes(nv); if (!ok && nv.length > 4 && q.acc.some(a => lev(a, nv) === 1)) extra = ' <span class="muted">(almost, check the spelling)</span>'; }
  f.ans.readOnly = true; record(q.c, ok);
  $('#chk').remove();
  $('#qfb').innerHTML = `<div class="fb ${ok ? 'ok' : 'no'}">${ok ? 'Correct!' : 'Not quite.'}${extra}<div class="mt" style="color:var(--text)">${q.t === 'reverse' ? 'Model answer' : 'Answer'}: <b>${esc(q.model)}</b>${q.t !== 'reverse' ? ` · ${esc(q.c.uz)}` : ''}</div></div>`; nextBtn();
};
ACT.mpick = el => {
  const side = el.dataset.s, sel = document.querySelector(`.opt.sel[data-s="${side}"]`); if (sel) sel.classList.remove('sel'); el.classList.add('sel');
  const l = document.querySelector('.opt.sel[data-s="L"]'), r = document.querySelector('.opt.sel[data-s="R"]'); if (!l || !r) return;
  const q = P.qs[P.i], c = q.cards.find(x => x.id === l.dataset.id);
  if (l.dataset.id === r.dataset.id) { l.classList.remove('sel'); r.classList.remove('sel'); l.classList.add('lock'); r.classList.add('lock'); if (!(c.id in P.cur.first)) { P.cur.first[c.id] = true; record(c, true); } P.cur.mrem--; if (!P.cur.mrem) { $('#mfb').innerHTML = '<span class="fb ok">All matched!</span>'; nextBtn(); } }
  else { [l, r].forEach(b => { b.classList.add('shake'); setTimeout(() => b.classList.remove('shake', 'sel'), 300); }); [l.dataset.id, r.dataset.id].forEach(id => { if (!(id in P.cur.first)) { P.cur.first[id] = false; record(q.cards.find(x => x.id === id), false); } }); }
};
async function endPractice() {
  const res = P.res, ok = res.filter(r => r.correct).length, bad = res.filter(r => !r.correct);
  try { await api('/student/activity', {json: res.map(r => ({card_id: r.card_id, activity: r.activity, correct: r.correct}))}); } catch (e) { toast('Could not save results: ' + e.message, true); }
  const wrong = [...new Map(bad.map(r => [r.card_id, r])).values()];
  P.running = false;
  view(shell('practice', `<div class="done" style="margin-top:4vh"><div class="big">${ok === res.length ? '🏆' : '✅'}</div><h1>${ok} / ${res.length} correct</h1><p class="muted">${res.length ? Math.round(100 * ok / res.length) : 0}%</p>
  ${wrong.length ? `<div class="card" style="text-align:left"><h3>Words to revisit</h3>${wrong.map(w => `<div class="row between" style="padding:4px 0"><b>${esc(w.en)}</b><span class="muted">${esc(w.uz)}</span></div>`).join('')}</div>` : ''}
  <div class="row mt" style="justify-content:center"><a class="btn pri big" href="#/practice" data-act="quitprac">Practise again</a><a class="btn big" href="#/dash" data-act="quitprac">Dashboard</a></div></div>`));
  P = null;
}

/* ===== progress & settings ===== */
async function progressView() {
  const p = await api('/student/progress'), t = p.totals, mx = Math.max(1, ...p.days.map(d => d.reviews));
  const rc = p.recognition_reviews + p.recall_reviews;
  view(shell('progress', `<h1>Progress</h1><div class="grid g4 keep mb"><div class="card stat"><b>${p.reviews_total}</b><span>total reviews</span></div><div class="card stat"><b>${p.accuracy === null ? '—' : p.accuracy + '%'}</b><span>remembered (Hard/Good/Easy)</span></div>
   <div class="card stat"><b>${p.streak}</b><span>day streak</span></div><div class="card stat"><b>${t.mature}</b><span>mastered words</span></div></div>
  <div class="card mb"><h2>Last 30 days</h2><div class="chart" style="height:130px">${p.days.map(d => `<div title="${d.date}: ${d.reviews} reviews"><i style="height:${Math.max(2, 100 * d.reviews / mx)}%"></i></div>`).join('')}</div><p class="small muted">Reviews per day. Today is on the right.</p></div>
  <div class="grid g2"><div class="card"><h2>Your words</h2>${bar(t)}<div class="mt">${legend}</div><table class="mt"><tbody>${['new', 'learning', 'review', 'relearning', 'mature'].map(s => `<tr><td>${badge(s)}</td><td style="text-align:right"><b>${t[s]}</b></td></tr>`).join('')}</tbody></table></div>
  <div class="card"><h2>Recognising vs recalling</h2><p class="muted small">English → Uzbek checks recognition. Uzbek → English and fill-the-gap cards check active recall.</p>
   ${rc ? `<div class="bar"><i style="background:var(--accent);width:${100 * p.recognition_reviews / rc}%"></i><i style="background:var(--good);width:${100 * p.recall_reviews / rc}%"></i></div><div class="legend mt"><span><i style="background:var(--accent)"></i>Recognition ${p.recognition_reviews}</span><span><i style="background:var(--good)"></i>Recall ${p.recall_reviews}</span></div>` : '<p class="muted">No reviews yet.</p>'}
   <h3 class="mt">Practice activities</h3>${p.activities.length ? p.activities.map(a => `<div class="row between small"><span>${({mc: 'Multiple choice', type: 'Type the answer', cloze: 'Fill in the blank', match: 'Matching', reverse: 'Reverse translation'})[a.activity]}</span><b>${a.correct}/${a.n}</b></div>`).join('') : '<p class="muted small">No practice yet.</p>'}</div></div>
  <div class="card mt"><h2>Words you find hardest</h2>${p.hardest.length ? `<table><thead><tr><th>Word</th><th>Meaning</th><th>Forgotten</th></tr></thead><tbody>${p.hardest.map(h => `<tr><td><b>${esc(h.en)}</b></td><td>${esc(h.uz)}</td><td>${h.lapses}×</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing yet. Words you forget after learning them will show up here.</p>'}</div>`));
}
async function settingsView() {
  const tz = [['Tashkent (UTC+5)', 300], ['UTC', 0], ['Moscow (UTC+3)', 180], ['Istanbul (UTC+3)', 180], ['London (UTC+0/+1)', 0], ['Seoul (UTC+9)', 540], ['New York (UTC−5)', -300]];
  const isS = ME.role === 'student';
  view(shell(isS ? 'settings' : 't/settings', `<h1>Settings</h1><div class="grid g2"><div class="card"><h2>Preferences</h2><form data-form="settings">
   ${isS ? `<label for="sn">New words per day</label><select id="sn" name="daily_new">${[3, 5, 10, 15, 20, 30, 50, 100, 1000].map(n => `<option value="${n}" ${ME.daily_new === n ? 'selected' : ''}>${n === 1000 ? 'All words (no limit)' : n}</option>`).join('')}</select>
   <label for="sd">Flashcard direction</label><select id="sd" name="direction">${[['en2uz', 'English → Uzbek'], ['uz2en', 'Uzbek → English'], ['cloze', 'Context (fill the gap)'], ['mixed', 'Mixed']].map(([v, l]) => `<option value="${v}" ${ME.direction === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
   <label for="st">Theme</label><select id="st" name="theme"><option value="light" ${ME.theme === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${ME.theme === 'dark' ? 'selected' : ''}>Dark</option></select>
   <label for="sz">Your time zone (day starts at midnight here)</label><select id="sz" name="tz_offset">${tz.map(([l, v]) => `<option value="${v}" ${ME.tz_offset === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
   <button class="btn pri mt">Save</button></form></div>
  <div class="card"><h2>Password</h2><form data-form="pw"><label for="o">Current password</label><input id="o" name="old" type="password" autocomplete="current-password" required><label for="n">New password (6+ characters)</label><input id="n" name="new" type="password" minlength="6" autocomplete="new-password" required><button class="btn pri mt">Change password</button></form>
  <hr style="border:0;border-top:1px solid var(--line);margin:22px 0"><button class="btn" data-act="logout">Log out</button></div></div>`));
}
FORM.settings = async f => {
  const b = {theme: f.theme.value, tz_offset: +f.tz_offset.value}; if (f.daily_new) { b.daily_new = +f.daily_new.value; b.direction = f.direction.value; }
  ME = await api('/me/settings', {json: b, method: 'PATCH'}); applyTheme(ME.theme); toast('Saved'); settingsView();
};
FORM.pw = async f => { await api('/me/password', {json: {old: f.old.value, new: f.new.value}}); f.reset(); toast('Password changed'); };

/* ===== teacher: levels & topics ===== */
async function tOverview() {
  const o = await api('/teacher/overview');
  view(shell('t/overview', `<div class="row between mb"><h1 style="margin:0">Levels & topics</h1><span class="muted">${o.students} active student${o.students === 1 ? '' : 's'}</span></div>
  <p class="muted">New and imported words start as <b>draft</b>. Students only see <b>published</b> words in topics you have assigned to them.</p>
  ${o.levels.map(l => { const pub = l.topics.reduce((a, t) => a + t.pub, 0); return `<div class="card mb"><div class="row between"><h2 style="margin:0">${l.level} <span class="muted small">${l.cards} words · ${l.topics.length} topics</span></h2>
   <div class="row"><button class="btn sm" data-act="addtopic" data-l="${l.level}">+ Topic</button><button class="btn sm" data-act="publish" data-s="level" data-id="${l.level}" data-p="1">Publish all ${l.level}</button><button class="btn sm" data-act="publish" data-s="level" data-id="${l.level}" data-p="0">Unpublish all</button></div></div>
   <div class="tablewrap mt"><table><thead><tr><th>#</th><th>Topic</th><th>Words</th><th>Published</th><th>No definition</th><th></th></tr></thead><tbody>
   ${l.topics.map(t => `<tr><td>${t.no}</td><td><a href="#/t/vocab?topic=${t.id}"><b>${esc(t.title)}</b></a></td><td>${t.n}</td><td>${t.pub === t.n && t.n ? '<span class="badge b-published">all</span>' : t.pub ? `<span class="badge b-draft">${t.pub}/${t.n}</span>` : '<span class="badge b-draft">draft</span>'}</td><td class="muted">${t.nodef}</td>
   <td style="white-space:nowrap"><button class="btn sm" data-act="publish" data-s="topic" data-id="${t.id}" data-p="${t.pub === t.n && t.n ? 0 : 1}">${t.pub === t.n && t.n ? 'Unpublish' : 'Publish'}</button> <button class="btn sm" data-act="renametopic" data-id="${t.id}" data-t="${esc(t.title)}">Rename</button> ${t.n ? '' : `<button class="btn sm danger" data-act="deltopic" data-id="${t.id}">Delete</button>`}</td></tr>`).join('')}
   </tbody></table></div></div>`; }).join('')}`));
}
ACT.publish = async el => { const r = await api('/teacher/publish', {json: {scope: el.dataset.s, id: el.dataset.id, publish: el.dataset.p === '1'}}); toast(`${r.updated} words ${el.dataset.p === '1' ? 'published' : 'set to draft'}`); route(); };
ACT.addtopic = el => modal(`<h2>New topic (${el.dataset.l})</h2><form data-form="addtopic"><input type="hidden" name="level" value="${el.dataset.l}"><label for="tt">Topic name</label><input id="tt" name="title" required maxlength="100"><div class="row mt"><button class="btn pri">Create</button><button type="button" class="btn" data-act="close">Cancel</button></div></form>`);
FORM.addtopic = async f => { await api('/teacher/topics', {json: {level: f.level.value, title: f.title.value}}); closeModal(); toast('Topic created'); route(); };
ACT.renametopic = el => modal(`<h2>Rename topic</h2><form data-form="renametopic"><input type="hidden" name="id" value="${el.dataset.id}"><input name="title" value="${esc(el.dataset.t)}" required maxlength="100"><div class="row mt"><button class="btn pri">Save</button><button type="button" class="btn" data-act="close">Cancel</button></div></form>`);
FORM.renametopic = async f => { await api('/teacher/topics/' + f.id.value, {method: 'PATCH', json: {title: f.title.value}}); closeModal(); route(); };
ACT.deltopic = async el => { if (!confirm('Delete this empty topic?')) return; await api('/teacher/topics/' + el.dataset.id, {method: 'DELETE'}); route(); };

/* ===== teacher: vocabulary ===== */
let TV = {sel: new Set()};
async function tVocab(h) {
  const qs = new URLSearchParams(location.hash.split('?')[1] || ''); TV.sel = new Set();
  const o = await api('/teacher/overview'); TV.o = o;
  const topicId = qs.get('topic') || '', level = qs.get('level') || (topicId ? '' : 'A2');
  const topics = o.levels.flatMap(l => l.topics.map(t => ({...t, level: l.level})));
  TV.topics = topics; TV.topicId = topicId; TV.level = level; TV.q = qs.get('q') || ''; TV.status = qs.get('status') || '';
  const cur = topics.find(t => String(t.id) === topicId);
  view(shell('t/vocab', `<div class="row between mb"><h1 style="margin:0">${cur ? esc(cur.level + ' · ' + cur.title) : 'Vocabulary'}</h1><button class="btn pri" data-act="addcard">+ Add word</button></div>
  <div class="card"><div class="row mb"><select id="fl" style="max-width:120px"><option value="">All levels</option>${['A2', 'B1', 'B2'].map(l => `<option ${l === level ? 'selected' : ''}>${l}</option>`).join('')}</select>
  <select id="ft" style="max-width:300px"><option value="">All topics</option>${topics.map(t => `<option value="${t.id}" ${String(t.id) === topicId ? 'selected' : ''}>${t.level} · ${esc(t.title)}</option>`).join('')}</select>
  <select id="fs" style="max-width:150px"><option value="">Any status</option><option value="draft" ${TV.status === 'draft' ? 'selected' : ''}>Draft</option><option value="published" ${TV.status === 'published' ? 'selected' : ''}>Published</option></select>
  <input id="fq" placeholder="Search…" value="${esc(TV.q)}" style="max-width:220px"><button class="btn" data-act="tfilter">Apply</button></div>
  <div class="row mb small"><span id="tcount" class="muted"></span><span class="right row"><select id="mv" style="max-width:260px"><option value="">Move selected to…</option></select><button class="btn sm" data-act="moveSel">Move</button><button class="btn sm" data-act="pubSel" data-p="1">Publish selected</button></span></div>
  <div class="tablewrap"><table><thead><tr><th><input type="checkbox" data-act="selall" aria-label="Select all"></th><th>English</th><th>Uzbek</th><th>Example</th><th>Status</th><th></th></tr></thead><tbody id="tbody"></tbody></table></div></div>`));
  await loadCards();
}
async function loadCards() {
  const p = new URLSearchParams(); if (TV.topicId) p.set('topic_id', TV.topicId); if (TV.level && !TV.topicId) p.set('level', TV.level); if (TV.status) p.set('status', TV.status); if (TV.q) p.set('q', TV.q);
  const rows = await api('/teacher/cards?' + p); TV.rows = rows;
  const cur = TV.topics.find(t => String(t.id) === TV.topicId);
  const lvl = cur ? cur.level : TV.level;
  $('#mv').innerHTML = '<option value="">Move selected to…</option>' + TV.topics.filter(t => (!lvl || t.level === lvl) && String(t.id) !== TV.topicId).map(t => `<option value="${t.id}">${t.level} · ${esc(t.title)}</option>`).join('');
  $('#tcount').textContent = rows.length + ' words' + (rows.length >= 500 ? ' (showing first 500, narrow the filter)' : '');
  $('#tbody').innerHTML = rows.map(c => `<tr><td><input type="checkbox" data-act="selone" data-id="${c.id}" aria-label="Select ${esc(c.en)}"></td><td><b>${esc(c.en)}</b><div class="small muted">${c.level} · ${c.topics.map(t => esc(t.title)).join(' + ')}</div>${c.needs_review.length ? `<div class="small" style="color:var(--warn)">⚠ ${esc(c.needs_review.join(', '))}</div>` : ''}</td><td>${esc(c.uz)}</td><td class="small muted">${esc(c.ex)}</td><td><span class="badge b-${c.status}">${c.status}</span></td>
    <td style="white-space:nowrap"><button class="btn sm" data-act="editcard" data-id="${c.id}">Edit</button> <button class="btn sm danger" data-act="delcard" data-id="${c.id}" aria-label="Delete ${esc(c.en)}">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No words match.</td></tr>';
}
ACT.tfilter = () => { const p = new URLSearchParams(); const t = $('#ft').value, l = $('#fl').value, s = $('#fs').value, q = $('#fq').value; if (t) p.set('topic', t); else if (l) p.set('level', l); if (s) p.set('status', s); if (q) p.set('q', q); location.hash = '#/t/vocab?' + p; if (location.hash.includes(p.toString())) route(); };
ACT.selall = el => { document.querySelectorAll('[data-act=selone]').forEach(c => { c.checked = el.checked; el.checked ? TV.sel.add(c.dataset.id) : TV.sel.delete(c.dataset.id); }); };
ACT.selone = el => { el.checked ? TV.sel.add(el.dataset.id) : TV.sel.delete(el.dataset.id); };
ACT.moveSel = async () => {
  const to = +$('#mv').value; if (!to) return toast('Choose a target topic', true); if (!TV.sel.size) return toast('Select words first', true);
  if (!TV.topicId) return toast('Open a single topic first (moving needs a source topic)', true);
  const r = await api('/teacher/cards/move', {json: {card_ids: [...TV.sel], from_topic_id: +TV.topicId, to_topic_id: to}}); toast(r.moved + ' moved'); route();
};
ACT.pubSel = async el => { for (const id of TV.sel) await api('/teacher/publish', {json: {scope: 'card', id, publish: true}}); toast('Published'); route(); };
ACT.delcard = async el => { if (!confirm('Delete this word for everyone? Student progress on it will be lost.')) return; await api('/teacher/cards/' + el.dataset.id, {method: 'DELETE'}); loadCards(); };
function cardForm(c) {
  const o = TV.topics || [];
  return `<form data-form="card"><input type="hidden" name="id" value="${c ? c.id : ''}">
  ${c && c.needs_review.length ? `<div class="flagbox">⚠ Needs review: ${esc(c.needs_review.join(', '))}</div>` : ''}
  ${c ? '' : `<div class="field-row"><div><label for="cl">Level</label><select id="cl" name="level" data-act="lvlchg">${['A2', 'B1', 'B2'].map(l => `<option>${l}</option>`).join('')}</select></div><div><label for="ctp">Topic</label><select id="ctp" name="topic_id"></select></div></div>`}
  <div class="field-row"><div><label for="ce">English</label><input id="ce" name="en" required maxlength="200" value="${esc(c && c.en)}"></div><div><label for="cu">Uzbek translation</label><input id="cu" name="uz" required maxlength="300" value="${esc(c && c.uz)}"></div></div>
  <label for="cd">English definition</label><input id="cd" name="definition" maxlength="500" value="${esc(c && c.definition)}">
  <div class="field-row"><div><label for="cp">Part of speech</label><input id="cp" name="pos" list="poslist" maxlength="40" value="${esc(c && c.pos)}"><datalist id="poslist"><option>noun<option>verb<option>adjective<option>adverb<option>phrasal verb<option>phrase<option>idiom<option>collocation<option>preposition<option>conjunction</datalist></div>
  <div><label for="cpr">Pronunciation (optional)</label><input id="cpr" name="pron" maxlength="100" value="${esc(c && c.pron)}"></div></div>
  <label for="cx">Example sentence</label><input id="cx" name="ex" maxlength="400" value="${esc(c && c.ex)}"><label for="cxu">Example in Uzbek</label><input id="cxu" name="ex_uz" maxlength="400" value="${esc(c && c.ex_uz)}">
  <label for="cn">Personal note</label><input id="cn" name="note" maxlength="500" value="${esc(c && c.note)}">
  <div class="row mt"><label style="display:flex;gap:8px;align-items:center;margin:0"><input type="checkbox" name="productive" style="width:auto" ${c && c.productive ? 'checked' : ''}> Productive (to say/write)</label>
  ${c ? `<label style="display:flex;gap:8px;align-items:center;margin:0"><input type="checkbox" name="published" style="width:auto" ${c.status === 'published' ? 'checked' : ''}> Published</label>` : ''}</div>
  <div class="row mt"><button class="btn pri">${c ? 'Save changes' : 'Add word (as draft)'}</button><button type="button" class="btn" data-act="close">Cancel</button></div></form>`;
}
function fillTopics() { const l = $('#cl'); if (!l) return; $('#ctp').innerHTML = (TV.topics || []).filter(t => t.level === l.value).map(t => `<option value="${t.id}" ${String(t.id) === TV.topicId ? 'selected' : ''}>${esc(t.title)}</option>`).join(''); }
ACT.lvlchg = fillTopics;
ACT.addcard = () => { modal(`<h2>Add word</h2>${cardForm(null)}`); const cur = TV.topics.find(t => String(t.id) === TV.topicId); if (cur) $('#cl').value = cur.level; fillTopics(); };
ACT.editcard = el => { const c = TV.rows.find(r => r.id === el.dataset.id); modal(`<h2>Edit word</h2>${cardForm(c)}`); };
FORM.card = async f => {
  const b = {en: f.en.value, uz: f.uz.value, definition: f.definition.value, pos: f.pos.value, pron: f.pron.value, ex: f.ex.value, ex_uz: f.ex_uz.value, note: f.note.value, productive: f.productive.checked};
  if (f.id.value) { b.status = f.published.checked ? 'published' : 'draft'; await api('/teacher/cards/' + f.id.value, {method: 'PATCH', json: b}); }
  else { b.level = f.level.value; b.topic_id = +f.topic_id.value; await api('/teacher/cards', {json: b}); }
  closeModal(); toast('Saved'); loadCards();
};

/* ===== teacher: students ===== */
async function tStudents() {
  const [st, groups] = await Promise.all([api('/teacher/students'), api('/teacher/groups')]); window._G = groups;
  view(shell('t/students', `<div class="row between mb"><h1 style="margin:0">Students</h1><div class="row"><button class="btn" data-act="addgroup">+ Group</button><button class="btn pri" data-act="addstudent">+ Add student</button></div></div>
  <div class="card"><div class="tablewrap"><table><thead><tr><th>Student</th><th>Level / group</th><th>Learned</th><th>Due</th><th>Mastered</th><th>7-day reviews</th><th>Accuracy</th><th>Streak</th><th></th></tr></thead><tbody>
  ${st.map(s => `<tr><td><b>${esc(s.name)}</b><div class="small muted">@${esc(s.username)}${s.active ? '' : ' · inactive'}</div></td><td>${s.level}${s.group ? ' · ' + esc(s.group) : ''}</td><td>${s.totals.seen}/${s.totals.total}</td><td>${s.totals.due}</td><td>${s.totals.mature}</td><td>${s.reviews_7d}</td><td>${s.accuracy === null ? '—' : s.accuracy + '%'}</td><td>${s.streak}</td><td><button class="btn sm" data-act="studentdetail" data-id="${s.id}">Open</button></td></tr>`).join('') || '<tr><td colspan="9" class="empty">No students yet. Click “Add student”.</td></tr>'}</tbody></table></div></div>
  ${groups.length ? `<p class="muted small mt">Groups: ${groups.map(g => `${esc(g.name)} (${g.members})`).join(' · ')}</p>` : ''}`));
}
ACT.addgroup = () => modal(`<h2>New group</h2><form data-form="addgroup"><label for="gn">Group name</label><input id="gn" name="name" required maxlength="60"><div class="row mt"><button class="btn pri">Create</button><button type="button" class="btn" data-act="close">Cancel</button></div></form>`);
FORM.addgroup = async f => { await api('/teacher/groups', {json: {name: f.name.value}}); closeModal(); route(); };
ACT.addstudent = () => modal(`<h2>Add student</h2><form data-form="addstudent"><div class="field-row"><div><label for="sn1">Full name</label><input id="sn1" name="name" required maxlength="60"></div><div><label for="su">Username (login)</label><input id="su" name="username" required minlength="3" pattern="[A-Za-z0-9_.\\-]+" autocapitalize="off"></div></div>
  <div class="field-row"><div><label for="sp">Starting password (6+)</label><input id="sp" name="password" required minlength="6" value="${Math.random().toString(36).slice(2, 10)}"></div><div><label for="sl">CEFR level</label><select id="sl" name="level"><option>A2</option><option>B1</option><option>B2</option></select></div></div>
  <label for="sg">Group (optional)</label><select id="sg" name="group_id"><option value="">No group</option>${(window._G || []).map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select>
  <label for="sdn">New words per day</label><select id="sdn" name="daily_new">${[3, 5, 10, 15, 20, 30, 50, 100, 1000].map(n => `<option value="${n}" ${n === 1000 ? 'selected' : ''}>${n === 1000 ? 'All words (no limit)' : n}</option>`).join('')}</select>
  <label style="display:flex;gap:8px;align-items:center;font-weight:500;color:var(--text)"><input type="checkbox" name="assign_level" checked style="width:auto"> Assign all topics of this level now</label>
  <p class="small muted">Write down the password to give to the student. They can change it in Settings.</p><div class="row mt"><button class="btn pri">Create student</button><button type="button" class="btn" data-act="close">Cancel</button></div></form>`);
FORM.addstudent = async f => { await api('/teacher/students', {json: {name: f.name.value, username: f.username.value, password: f.password.value, level: f.level.value, group_id: f.group_id.value ? +f.group_id.value : null, assign_level: f.assign_level.checked, daily_new: +f.daily_new.value}});
  closeModal(); toast(`Created. Username: ${f.username.value} · Password: ${f.password.value}`); route(); };
ACT.studentdetail = async el => {
  const s = await api('/teacher/students/' + el.dataset.id), t = s.totals;
  modal(`<div class="row between"><h2 style="margin:0">${esc(s.name)} <span class="muted small">@${esc(s.username)}</span></h2><button class="iconbtn" data-act="close" aria-label="Close">✕</button></div>
  <div class="grid g4 keep mt"><div class="card stat"><b>${t.seen}</b><span>started</span></div><div class="card stat"><b>${t.due}</b><span>due</span></div><div class="card stat"><b>${t.mature}</b><span>mastered</span></div><div class="card stat"><b>${s.streak}</b><span>streak</span></div></div>
  <h3 class="mt">Topics</h3>${s.topics.map(tp => `<div class="small row between"><span>${esc(tp.title)}</span><span class="muted">${tp.seen}/${tp.total} · ${tp.due} due</span></div>${bar(tp)}`).join('') || '<p class="muted small">No topics assigned.</p>'}
  <h3 class="mt">Hardest words</h3>${s.hardest.length ? s.hardest.map(h => `<div class="small row between"><b>${esc(h.en)}</b><span class="muted">${esc(h.uz)} · Again ×${h.agains}</span></div>`).join('') : '<p class="muted small">None yet.</p>'}
  <h3 class="mt">Recent activity</h3>${s.recent.slice(0, 8).map(r => `<div class="small muted">${new Date(r.ts).toLocaleString()} · ${esc(r.en)} · ${['', 'Again', 'Hard', 'Good', 'Easy'][r.rating]}</div>`).join('') || '<p class="muted small">No reviews yet.</p>'}
  <hr style="border:0;border-top:1px solid var(--line);margin:18px 0"><form data-form="editstudent"><input type="hidden" name="id" value="${s.id}"><div class="field-row"><div><label>Level</label><select name="level">${['A2', 'B1', 'B2'].map(l => `<option ${s.level === l ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
  <div><label>Group</label><select name="group_id"><option value="">No group</option>${(window._G || []).map(g => `<option value="${g.id}" ${s.group_id === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div></div>
  <div class="field-row"><div><label>New password (leave blank to keep)</label><input name="password" minlength="6" placeholder="••••••"></div><div><label>New words per day</label><select name="daily_new">${[3, 5, 10, 15, 20, 30, 50, 100, 1000].map(n => `<option value="${n}" ${s.daily_new === n ? 'selected' : ''}>${n === 1000 ? 'All (no limit)' : n}</option>`).join('')}</select></div></div>
  <div class="field-row"><div><label>Account</label><select name="active"><option value="1" ${s.active ? 'selected' : ''}>Active</option><option value="0" ${s.active ? '' : 'selected'}>Deactivated</option></select></div></div>
  <div class="row mt"><button class="btn pri">Save</button></div><p class="small muted">Changing level does not change assigned topics. Use Assignments.</p></form>`);
};
FORM.editstudent = async f => { const b = {level: f.level.value, group_id: f.group_id.value ? +f.group_id.value : null, active: f.active.value === '1', daily_new: +f.daily_new.value}; if (f.password.value) b.password = f.password.value;
  await api('/teacher/students/' + f.id.value, {method: 'PATCH', json: b}); closeModal(); toast('Saved'); route(); };

/* ===== teacher: assignments, difficult words, import/export ===== */
async function tAssign() {
  const [o, st, groups, asg] = await Promise.all([api('/teacher/overview'), api('/teacher/students'), api('/teacher/groups'), api('/teacher/assignments')]);
  view(shell('t/assign', `<h1>Assignments</h1><div class="grid g2"><div class="card"><h2>Assign topics</h2><form data-form="assign">
  <label>Topics</label><div style="max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px">${o.levels.map(l => `<div class="small muted" style="margin-top:6px"><b>${l.level}</b></div>${l.topics.map(t => `<label style="display:flex;gap:8px;align-items:center;margin:2px 0;font-weight:500;color:var(--text)"><input type="checkbox" name="topic" value="${t.id}" style="width:auto"> ${esc(t.title)} <span class="muted small">(${t.pub}/${t.n} published)</span></label>`).join('')}`).join('')}</div>
  <label>Students</label><div style="max-height:150px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:8px">${st.map(s => `<label style="display:flex;gap:8px;align-items:center;margin:2px 0;font-weight:500;color:var(--text)"><input type="checkbox" name="student" value="${s.id}" style="width:auto"> ${esc(s.name)} <span class="muted small">${s.level}</span></label>`).join('') || '<span class="muted small">No students yet</span>'}</div>
  <label>Groups</label><div>${groups.map(g => `<label style="display:flex;gap:8px;align-items:center;margin:2px 0;font-weight:500;color:var(--text)"><input type="checkbox" name="group" value="${g.id}" style="width:auto"> ${esc(g.name)} <span class="muted small">(${g.members})</span></label>`).join('') || '<span class="muted small">No groups</span>'}</div>
  <button class="btn pri mt">Assign</button></form></div>
  <div class="card"><h2>Current assignments</h2><select id="af" data-act="afilter" style="margin-bottom:10px"><option value="">Everyone</option>${st.map(s => `<option value="s${s.id}">${esc(s.name)}</option>`).join('')}${groups.map(g => `<option value="g${g.id}">Group: ${esc(g.name)}</option>`).join('')}</select>
  <div style="max-height:420px;overflow:auto"><table id="atable"><tbody>${asg.map(a => `<tr data-k="${a.student_id ? 's' + a.student_id : 'g' + a.group_id}"><td>${a.level} · ${esc(a.topic)}</td><td class="small muted">${esc(a.student || 'Group: ' + a.grp)}</td><td><button class="btn sm danger" data-act="unassign" data-id="${a.id}" aria-label="Remove assignment">✕</button></td></tr>`).join('') || '<tr><td class="empty">Nothing assigned yet.</td></tr>'}</tbody></table></div></div></div>`));
  $('#af').addEventListener('change', () => { const v = $('#af').value; document.querySelectorAll('#atable tr[data-k]').forEach(r => r.classList.toggle('hide', !!v && r.dataset.k !== v)); });
}
FORM.assign = async f => {
  const v = n => [...f.querySelectorAll(`[name=${n}]:checked`)].map(x => +x.value);
  const r = await api('/teacher/assignments', {json: {topic_ids: v('topic'), student_ids: v('student'), group_ids: v('group')}}); toast(`${r.created} new assignments`); route();
};
ACT.unassign = async el => { await api('/teacher/assignments/' + el.dataset.id, {method: 'DELETE'}); el.closest('tr').remove(); };
async function tDifficult() {
  const [d, st] = await Promise.all([api('/teacher/difficult'), api('/teacher/students')]);
  view(shell('t/difficult', `<h1>Difficult words</h1><p class="muted">Words most often answered “Again” (at least 2 reviews). Use this to plan extra practice.</p><div class="card"><select id="ds" data-act="dfilter" style="max-width:260px;margin-bottom:12px"><option value="">All students</option>${st.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
  <div class="tablewrap"><table><thead><tr><th>Word</th><th>Meaning</th><th>Level</th><th>Reviews</th><th>“Again”</th><th>Students</th></tr></thead><tbody id="dbody">${drows(d)}</tbody></table></div></div>`));
  $('#ds').addEventListener('change', async () => { const v = $('#ds').value; $('#dbody').innerHTML = drows(await api('/teacher/difficult' + (v ? '?student_id=' + v : ''))); });
}
const drows = d => d.map(w => `<tr><td><b>${esc(w.en)}</b></td><td>${esc(w.uz)}</td><td>${w.level}</td><td>${w.reviews}</td><td>${w.agains} (${w.pct_again}%)</td><td>${w.students}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No data yet. It appears once students start reviewing.</td></tr>';
async function tData() {
  view(shell('t/data', `<h1>Import / export</h1><div class="grid g2"><div class="card"><h2>Import vocabulary</h2><p class="muted small">CSV (UTF-8) or JSON. Required columns: <b>level, topic, english, uzbek</b>. Optional: category, definition, pos, example, example_uzbek, note, productive. New words are added as drafts. Missing topics are created.</p>
  <form data-form="import"><input type="file" name="file" accept=".csv,.json" required aria-label="File"><label for="im">If the word already exists</label><select id="im" name="mode"><option value="skip">Skip it (just link the topic)</option><option value="update">Update translation and fill empty fields</option></select>
  <div class="row mt"><button class="btn pri" name="go" value="preview">Preview (changes nothing)</button><button class="btn" name="go" value="apply">Import now</button></div></form><div id="impres" class="mt"></div></div>
  <div class="card"><h2>Export</h2><p class="muted small">Download your vocabulary or your students’ progress. Open the CSV in Excel or Google Sheets.</p>
  <div class="row"><a class="btn" href="/api/teacher/export/vocab.csv">Vocabulary (CSV)</a><a class="btn" href="/api/teacher/export/vocab.json">Vocabulary (JSON)</a><a class="btn" href="/api/teacher/export/progress.csv">Student progress (CSV)</a></div></div></div>`));
}
FORM.import = async (f, e) => {
  const go = (e.submitter && e.submitter.value) || 'preview'; const fd = new FormData(); fd.append('file', f.file.files[0]); fd.append('mode', f.mode.value); fd.append('dry_run', go === 'preview' ? 'true' : 'false');
  const r = await api('/teacher/import', {form: fd});
  $('#impres').innerHTML = `<div class="fb ${r.errors.length ? 'no' : 'ok'}"><b>${r.dry_run ? 'Preview' : 'Imported'}:</b> ${r.rows} rows · ${r.added} added · ${r.updated} updated · ${r.skipped} skipped · ${r.topics_created} new topics${r.errors.length ? `<ul>${r.errors.slice(0, 15).map(x => `<li>${esc(x)}</li>`).join('')}</ul>${r.errors.length > 15 ? `…and ${r.errors.length - 15} more` : ''}` : ''}</div>`;
  if (!r.dry_run) toast('Import finished');
};

route();