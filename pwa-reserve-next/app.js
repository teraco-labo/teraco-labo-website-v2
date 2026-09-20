'use strict';
/* TERACO予約（新デザイン試作）
   サーバー(GAS)は現行と同じ。既存の overview / batch_reserve / batch_cancel / admin_* をそのまま使う。
   ?demo=1 を付けると「おためしモード」：予約・取消・変更をサーバーに書き込まず画面内だけで再現する。 */

const API_BASE = 'https://script.google.com/macros/s/AKfycbz2_NXN-VuAo2iCFu-jQ-nT5k9Bk3eCoIYBGXAtfDtneNJS7La8vLxS5T7p4Xo3iUIy/exec';
const TEL = '090-6738-1469';
const DEMO = new URLSearchParams(location.search).has('demo');
const MONTHLY_LIMIT = 8;
const ADMIN_RANGE_MONTHS = 12;
const DAYS = ['日', '月', '火', '水', '木', '金', '土'];

// 時間割（2026年10月からの正式版）。グループ講座は曜日と時間が固定。A=水曜／B=金曜
const TIMES_PRIVATE = ['10:00', '11:00', '14:00', '15:00', '16:00', '17:00']; // 個人レッスン（火・木）
const ADMIN_TIMES   = ['09:00','10:00','11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00'];
const CATEGORIES = { smartphone: 'スマホ', pc_ai: 'パソコンAI' };
const COURSES = {
  'sp-intro': { cat: 'smartphone', label: 'スマホ入門',   short: '入門', min: 45, color: '#F8DDB0', classes: { A: { dow: 3, time: '16:00' }, B: { dow: 5, time: '14:00' } } },
  'sp-adv':   { cat: 'smartphone', label: 'スマホ応用',   short: '応用', min: 90, color: '#C9E2C0', classes: { A: { dow: 3, time: '14:00' }, B: { dow: 5, time: '10:00' } } },
  'pc-intro': { cat: 'pc_ai',      label: 'パソコン入門', short: '入門', min: 45, color: '#E6CDF5', classes: { A: { dow: 3, time: '10:00' }, B: { dow: 5, time: '15:00' } } },
  'pc-adv':   { cat: 'pc_ai',      label: 'パソコン応用', short: '応用', min: 45, color: '#A9DCFB', classes: { A: { dow: 3, time: '11:00' }, B: { dow: 5, time: '16:00' } } },
  'private':  { cat: null,         label: '個人レッスン', short: '個人レッスン', min: 50, color: '#FDF3C4', classes: null }
};
const OLD_COURSE_KEYS = { intro: 'sp-intro', applied: 'sp-adv', basic: 'pc-intro', advance: 'pc-adv' };

// 講座カレンダー（正本）。いまは試作用にアプリ内に仮置き。次の段階でサーバーに保存し、管理者画面から編集する
const SCHEDULE = {
  published: ['2026-10'],                                                  // 日程が確定している月
  off: ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'],           // 講座のない日
  events: [                                                                // 体験会など特別な予定（その時間は個人レッスン不可）
    { day: '2026-10-06', time: '10:00', label: '体験会スマホ', min: 45 },
    { day: '2026-10-06', time: '11:00', label: '体験会パソコン', min: 45 }
  ]
};

// ---------- 保存（端末が覚える） ----------
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};

const S = {
  view: 'loading',
  profile: store.get('tr_profile', null),   // {name, category, course, usual:{dow,time}}
  proxy: null,                               // 管理者が代理操作中の生徒 {name, category, course, usual}
  slots: [], daySlots: new Map(), slotIndex: new Map(),
  existing: [], syncing: false, loaded: false,
  propOff: new Set(), propOn: new Set(),
  picked: new Map(), viewMonth: null, pickDay: null,
  mode: 'add', changing: null, pending: null, done: null, error: null,
  edit: null,                                // 'name' | 'class'（設定変更中）
  draft: {},                                 // 初回登録の途中経過
  admin: { summary: null, names: [], query: '', history: null, historyMonths: 3 },
  demo: { added: [], removed: new Set() }
};

const adminCode = () => sessionStorage.getItem('teraco_admin_code') || '';
const isAdmin = () => !!adminCode();
const me = () => S.proxy || S.profile;

// ---------- 小道具 ----------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const dayKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const parseDayKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const addMonths = (mk, n) => { const [y, m] = mk.split('-').map(Number); return monthKeyOf(new Date(y, m - 1 + n, 1)); };
const monthDiff = (a, b) => { const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + (bm - am); };
const fmtDay = (d) => `${d.getMonth() + 1}月${d.getDate()}日（${DAYS[d.getDay()]}）`;
const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtWhen = (iso) => { const d = new Date(iso); return `${fmtDay(d)} ${fmtTime(d)}`; };
const normName = (s) => String(s || '').replace(/\s+/g, '');

const dowTimeText = (c) => `${DAYS[c.dow]}曜 ${c.time}`;
function classText(p) {
  if (!p || !p.course || !COURSES[p.course]) return '';
  const c = COURSES[p.course];
  if (!c.classes) return `${c.label}（${c.min}分）`;
  return `${c.label} ${p.klass || ''}（${p.klass ? dowTimeText(c.classes[p.klass]) : ''}）`;
}
// サーバーに渡すクラス名。予約イベントのタイトル先頭「スマホ 」「パソコンAI 」は他の仕組みが目印にしているので維持する
function classDetails(p, klass) {
  const c = COURSES[p.course];
  const cat = CATEGORIES[c.cat || p.category] || 'スマホ';
  return { category: cat, course: c.classes ? `${c.short}${klass || p.klass}(${c.min}分)` : `${c.label}(${c.min}分)` };
}
// 予約イベントのタイトルからクラスを推定（旧コース名にも対応。A/Bの記載が無ければ曜日から判断）
function inferClass(e) {
  const t = (e && (e.class_title || e.label || e.title)) || ''; if (!t) return null;
  const pc = /パソコン|PC|ベーシック|アドバンス/.test(t);
  let course = null;
  if (/個人/.test(t)) course = 'private';
  else if (/応用|アドバンス/.test(t)) course = pc ? 'pc-adv' : 'sp-adv';
  else if (/入門|ベーシック/.test(t)) course = pc ? 'pc-intro' : 'sp-intro';
  if (!course) return null;
  let klass = null;
  if (course !== 'private') { const m = t.match(/([AB])\s*[\(（]/); klass = m ? m[1] : (new Date(e.start).getDay() === 5 ? 'B' : 'A'); }
  return { course, klass, category: COURSES[course].cat || (pc ? 'pc_ai' : 'smartphone') };
}
const rowClassText = (e) => { const g = inferClass(e); return g ? COURSES[g.course].label + (g.klass || '') : ''; };

// ---------- 通信 ----------
async function post(payload, timeoutMs = 45000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(API_BASE, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload), signal: ctl.signal, redirect: 'follow', cache: 'no-cache' });
      clearTimeout(t);
      if (!res.ok) throw new Error('server');
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      if (attempt === 1) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}
async function getJson(params) {
  const url = new URL(API_BASE); Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const res = await fetch(url.toString()); return await res.json();
}

function indexSlots() {
  S.slotIndex = new Map(S.slots.map(s => [String(s.slot_id), s]));
  S.daySlots = new Map();
  S.slots.forEach(s => { if (!S.daySlots.has(s.day_key)) S.daySlots.set(s.day_key, []); S.daySlots.get(s.day_key).push(s); });
}
function applyDemo() {
  if (!DEMO) return;
  S.existing = S.existing.filter(e => !S.demo.removed.has(e.event_id)).concat(S.demo.added);
}

// 予約状況の読み込み。前回の内容を先に出し、裏で最新にする
async function loadData({ quiet = false } = {}) {
  const p = me(); const name = p ? p.name : '';
  const cacheKey = 'tr_cache_' + name;
  if (!S.loaded) {
    const c = store.get(cacheKey, null);
    if (c && c.slots) { S.slots = c.slots; S.existing = c.existing || []; indexSlots(); applyDemo(); S.loaded = true; }
  }
  S.syncing = true; if (!quiet) render();
  try {
    const d = await post({ action: 'overview', name: name, days: 60, email: null });
    if (me() && me().name !== name) return;            // 途中で人が切り替わった
    S.slots = d.slots || []; S.existing = d.existing || []; indexSlots(); applyDemo(); S.loaded = true;
    store.set(cacheKey, { t: Date.now(), slots: S.slots, existing: d.existing || [] });
    S.error = null;
  } catch (e) {
    if (!S.loaded) S.error = '予約状況を読み込めませんでした。電波のよい場所で、もう一度ためしてください。';
  } finally { S.syncing = false; render(); }
}
// 初めての人が名前を入れている間に、空き枠だけ先に読んでおく
async function prefetchSlots() {
  try { const d = await post({ action: 'overview', name: '', days: 60, email: null });
    if (!S.slots.length && d && d.slots) { S.slots = d.slots; indexSlots(); if (S.view === 'calendar') render(); } } catch (e) {}
}

// ---------- ルール ----------
const isOff = (dayKey) => SCHEDULE.off.includes(dayKey);
const eventAt = (dayKey, time) => SCHEDULE.events.find(ev => ev.day === dayKey && ev.time === time) || null;
// その日に受けられる講座の一覧 [{time, klass, own}]。own=自分のクラス、false=同じコースの別クラス（振替）
function lessonsOn(p, date) {
  const dk = dayKeyOf(date); const dow = date.getDay();
  if (!p || !p.course || isOff(dk)) return [];
  // 日程がまだ決まっていない先の月は、生徒からは予約できない（今月は従来どおり可）
  const mk = monthKeyOf(date); if (!SCHEDULE.published.includes(mk) && mk !== monthKeyOf(new Date())) return [];
  const c = COURSES[p.course];
  if (!c.classes) return [2, 4].includes(dow) ? TIMES_PRIVATE.filter(t => !eventAt(dk, t)).map(t => ({ time: t, klass: null, own: true })) : [];
  return Object.keys(c.classes).filter(k => c.classes[k].dow === dow).map(k => ({ time: c.classes[k].time, klass: k, own: k === p.klass }));
}
// 生徒が予約・変更・取消できる日か（明日以降。明日分は今日の17時まで）
function withinDeadline(date) {
  if (isAdmin()) return true;
  const t = today0(); const d = new Date(date); d.setHours(0, 0, 0, 0);
  const tomorrow = new Date(t); tomorrow.setDate(t.getDate() + 1);
  if (d < tomorrow) return false;
  if (d.getTime() === tomorrow.getTime() && new Date().getHours() >= 17) return false;
  return true;
}
// 日付と時刻から枠を作る。サーバーに同じ枠があれば人数つきのそれを使う
function makeSlot(date, time, extra) {
  const [hh, mm] = time.split(':').map(Number);
  const st = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hh, mm, 0, 0);
  const hit = S.slotIndex.get(String(st.getTime()));
  const base = hit || { slot_id: String(st.getTime()), iso: st.toISOString(), day_key: dayKeyOf(date), start_time: time,
                        month_key: monthKeyOf(date), capacity: 8, reserved_count: 0, virtual: true };
  return Object.assign({}, base, extra || {});
}
function slotsForDay(dayKey) {
  const date = parseDayKey(dayKey);
  if (isAdmin()) return ADMIN_TIMES.map(t => makeSlot(date, t, { klass: null, own: true }));
  return lessonsOn(me(), date).map(l => makeSlot(date, l.time, { klass: l.klass, own: l.own }));
}
const existingIds = () => new Set(S.existing.map(e => String(e.slot_id)));
const existingDays = () => new Set(S.existing.map(e => dayKeyOf(new Date(e.start))));
function slotState(slot) {
  if (existingIds().has(String(slot.slot_id))) return 'mine';
  if (Number(slot.reserved_count) >= Number(slot.capacity)) return 'full';
  return 'open';
}
function monthCount(mk) {
  return S.existing.filter(e => monthKeyOf(new Date(e.start)) === mk).length
       + Array.from(S.picked.values()).filter(s => s.month_key === mk).length;
}

// ---------- 「いつもの」 ----------
function usualOf(p) {
  if (!p || !p.course) return null;
  const c = COURSES[p.course];
  if (c.classes) return p.klass ? c.classes[p.klass] : null;            // グループ：クラスの曜日・時間そのもの
  if (p.usual && p.usual.time != null) return p.usual;                  // 個人：前回の曜日・時間
  const mine = S.existing.filter(e => { const g = inferClass(e); return g && g.course === 'private'; });
  if (!mine.length) return null;
  const tally = {}; mine.forEach(e => { const d = new Date(e.start); const k = d.getDay() + '|' + fmtTime(d); tally[k] = (tally[k] || 0) + 1; });
  const [dow, time] = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0].split('|');
  return { dow: Number(dow), time };
}
// 日程が確定している月について、これから取れる「いつもの」日を月ごとにまとめる
function proposals() {
  const p = me(); const u = usualOf(p); if (!p || !u) return [];
  const taken = existingDays(); const groups = new Map(); const t = today0();
  for (let i = 1; i <= 75; i++) {
    const d = new Date(t); d.setDate(t.getDate() + i); const mk = monthKeyOf(d);
    if (!SCHEDULE.published.includes(mk) || d.getDay() !== u.dow || !withinDeadline(d)) continue;
    const dk = dayKeyOf(d); if (taken.has(dk)) continue;
    const slot = slotsForDay(dk).find(x => x.start_time === u.time && x.own);
    if (!slot || slotState(slot) !== 'open') continue;
    if (!groups.has(mk)) groups.set(mk, []); groups.get(mk).push(slot);
  }
  const out = []; let first = true;
  Array.from(groups.keys()).sort().forEach(mk => {
    const room = Math.max(0, MONTHLY_LIMIT - S.existing.filter(e => monthKeyOf(new Date(e.start)) === mk).length);
    const items = groups.get(mk).slice(0, isAdmin() ? 99 : room); if (!items.length) return;
    out.push({ mk, label: `${Number(mk.split('-')[1])}月分`, items, preChecked: first }); first = false;
  });
  return out;
}
// まだ日程が決まっていない直近の月（お知らせ用）
function pendingMonthLabel() {
  const next = addMonths(monthKeyOf(new Date()), 1);
  return SCHEDULE.published.includes(next) ? '' : `${Number(next.split('-')[1])}月`;
}
function defaultOn(g, slot) { return g.preChecked; }
function proposalChecked(g, slot) {
  const id = String(slot.slot_id);
  return defaultOn(g, slot) ? !S.propOff.has(id) : S.propOn.has(id);
}
function checkedProposalSlots() {
  return proposals().flatMap(g => g.items.filter(s => proposalChecked(g, s)));
}

// ---------- 画面 ----------
const $app = () => document.getElementById('app');
function go(view) { S.view = view; render(); window.scrollTo(0, 0); }
function busy(on, text) { document.getElementById('busy').classList.toggle('on', !!on); if (text) document.getElementById('busyText').textContent = text; }

function render() {
  // 上の帯
  let bands = '';
  if (DEMO) bands += `<div class="band demo">おためしモード（じっさいには予約されません）</div>`;
  if (isAdmin() && S.proxy) bands += `<div class="band proxy">代理で操作中：${esc(S.proxy.name)}さん <button data-act="admin-home">別の人に切り替える</button></div>`;
  else if (isAdmin()) bands += `<div class="band proxy">管理者モード</div>`;
  document.getElementById('bands').innerHTML = bands;
  document.getElementById('tray').innerHTML = '';

  const v = S.view;
  const html = v === 'loading' ? `<div class="center muted" style="padding:60px 0;">読み込み中…</div>`
    : v === 'ob-name' ? viewName()
    : v === 'ob-cat' ? viewCategory()
    : v === 'ob-course' ? viewCourse()
    : v === 'ob-class' ? viewKlass()
    : v === 'home' ? viewHome()
    : v === 'calendar' ? viewCalendar()
    : v === 'times' ? viewTimes()
    : v === 'confirm' ? viewConfirm()
    : v === 'done' ? viewDone()
    : v === 'admin-login' ? viewAdminLogin()
    : v === 'admin-home' ? viewAdminHome()
    : '';
  $app().innerHTML = html;
  if (v === 'calendar' && S.mode === 'add' && S.picked.size) {
    document.getElementById('tray').innerHTML = `<div class="tray"><div class="in"><div class="n">${S.picked.size}件 えらんでいます</div><button class="btn" data-act="to-confirm-picked">予約にすすむ</button></div></div>`;
  }
  const f = document.querySelector('[data-focus]'); if (f) f.focus();
}

// --- 初回：名前 → 種別 → クラス ---
function viewName() {
  const editing = S.edit === 'name';
  return `<h1>${editing ? 'お名前をなおす' : 'はじめに、お名前をおしえてください'}</h1>
  <div class="card">
    <input class="txt" id="nameInput" data-focus type="text" placeholder="例：田中花子" value="${esc(S.draft.name || '')}" autocomplete="name">
    <p class="muted" style="margin-top:10px;">姓と名をつづけて入れてください。次からは入力しなくてすみます。</p>
  </div>
  <button class="btn" data-act="name-next">つぎへ</button>
  ${editing ? `<button class="btn quiet" data-act="home">やめる</button>` : ''}`;
}
function viewCategory() {
  return `<h1>どちらを習っていますか？</h1>
  <button class="choice" data-act="cat" data-v="smartphone"><b>スマホ</b><span>スマートフォンの教室</span></button>
  <button class="choice" data-act="cat" data-v="pc_ai"><b>パソコン・AI</b><span>パソコンやAIの教室</span></button>
  <button class="btn quiet" data-act="${S.proxy ? (S.proxy.course ? 'home' : 'admin-home') : (me() && me().course ? 'home' : 'ob-back-name')}">もどる</button>`;
}
function viewCourse() {
  const cat = S.draft.category;
  const keys = Object.keys(COURSES).filter(k => COURSES[k].cat === cat || COURSES[k].cat === null);
  return `<h1>コースをえらんでください</h1>
  ${keys.map(k => `<button class="choice" data-act="course" data-v="${k}" style="border-left:14px solid ${COURSES[k].color};"><b>${esc(COURSES[k].label)}</b><span>${COURSES[k].min}分${k === 'private' ? '・先生と1対1' : ''}</span></button>`).join('')}
  <p class="muted center" style="margin:6px 0 14px;">わからないときは、先生におたずねください。<br><a href="tel:${TEL}" style="color:var(--green-deep);font-weight:800;">電話で聞く</a></p>
  <button class="btn quiet" data-act="ob-cat">もどる</button>`;
}
function viewKlass() {
  const c = COURSES[S.draft.course];
  return `<h1>${esc(c.label)}<br>何曜日のクラスですか？</h1>
  ${Object.keys(c.classes).map(k => `<button class="choice" data-act="klass" data-v="${k}" style="border-left:14px solid ${c.color};"><b>${DAYS[c.classes[k].dow]}曜日 ${esc(c.classes[k].time)}</b><span>${k}クラス</span></button>`).join('')}
  <button class="btn quiet" data-act="ob-course-back">もどる</button>`;
}

// --- ホーム ---
function rsvRow(e) {
  const d = new Date(e.start); const can = withinDeadline(d);
  return `<div class="rsv"><div class="when"><div class="date">${fmtDay(d)} ${fmtTime(d)}</div>
    <div class="cls">${esc(rowClassText(e))}</div></div>
    <div class="ops">${can
      ? `<button class="mini" data-act="change" data-id="${esc(e.event_id)}">日時を変える</button><button class="mini del" data-act="cancel" data-id="${esc(e.event_id)}">取り消す</button>`
      : `<a class="mini" style="text-decoration:none;text-align:center;" href="tel:${TEL}">電話で相談</a>`}</div></div>`;
}
function viewHome() {
  const p = me(); if (!p) return '';
  const list = S.existing.slice().sort((a, b) => new Date(a.start) - new Date(b.start));
  const u = usualOf(p); const groups = S.loaded ? proposals() : [];
  const nChecked = groups.length ? checkedProposalSlots().length : 0;
  let h = `<h1>${S.proxy ? esc(p.name) + 'さんの予約を操作' : esc(p.name) + 'さん、こんにちは'}</h1><div class="sync">${S.syncing ? '最新の予約状況をたしかめています…' : ''}</div>`;
  if (S.error) h += `<div class="note" style="margin-bottom:16px;">${esc(S.error)}</div>`;

  h += `<div class="card"><h2>${S.proxy ? esc(p.name) + 'さんの予約' : 'あなたの予約'}</h2>`;
  if (!S.loaded) h += `<p class="muted">読み込み中…</p>`;
  else if (!list.length) h += `<p class="muted">いま入っている予約はありません。</p>`;
  else { h += list.map(rsvRow).join('');
         if (!isAdmin()) h += `<p class="muted" style="margin-top:8px;">変更・取り消しは前日の17時までできます。</p>`; }
  if (S.proxy) h += `<div style="margin-top:12px;"><button class="link" data-act="history">過去の予約を見る</button></div>${viewHistory()}`;
  h += `</div>`;

  const group = !!(COURSES[p.course] && COURSES[p.course].classes);
  const calLabel = group ? '行けない日を ほかの日にふりかえる' : 'ほかの日・時間をえらぶ';
  h += `<div class="card"><h2>つぎの予約をとる</h2>
        <p style="font-weight:800;border-left:12px solid ${COURSES[p.course].color};padding-left:10px;">${esc(classText(p))}</p>`;
  if (u && groups.length) {
    h += `<p class="muted" style="margin-top:8px;">行けない日は、おして外してください。</p>`;
    groups.forEach(g => {
      h += `<div class="month-label">${esc(g.label)}（${g.items.length}回）</div>` + g.items.map(s => {
        const on = proposalChecked(g, s); const d = parseDayKey(s.day_key); const n = Number(s.reserved_count) || 0;
        return `<button class="pick ${on ? 'on' : ''}" data-act="prop" data-id="${esc(s.slot_id)}" data-pre="${defaultOn(g, s) ? 1 : 0}">
          <span class="box"></span><span>${fmtDay(d)}${group ? '' : ' ' + esc(s.start_time)}</span>${n > 0 ? `<span class="cnt">${n}人</span>` : ''}</button>`;
      }).join('');
    });
    h += `<button class="btn" style="margin-top:8px;" data-act="to-confirm-prop" ${nChecked ? '' : 'disabled'}>${nChecked ? `この${nChecked}回を予約する` : '日にちをえらんでください'}</button>
          <button class="btn ghost" data-act="open-cal">${calLabel}</button>`;
  } else {
    const pm = pendingMonthLabel();
    if (S.loaded && pm) h += `<p class="muted" style="margin:8px 0 12px;">${pm}の日程は、まだ決まっていません。決まりしだい、ここに出ます。</p>`;
    h += `<button class="btn" style="margin-top:8px;" data-act="open-cal">日にちをえらぶ</button>`;
  }
  h += `</div>`;

  h += `<div class="links"><button class="link" data-act="edit-class">クラスを変える</button>
        ${S.proxy ? '' : `<button class="link" data-act="edit-name">お名前をなおす</button>`}
        <a class="link" href="tel:${TEL}">電話で聞く</a></div>
        <div class="links" style="margin-top:26px;"><button class="link" style="font-size:14px;color:#9AA8A0;" data-act="${isAdmin() ? 'admin-home' : 'admin-login'}">管理者</button></div>`;
  return h;
}
function viewHistory() {
  const hst = S.admin.history; if (!hst) return '';
  if (hst === 'loading') return `<p class="muted">読み込み中…</p>`;
  if (!hst.length) return `<p class="muted">過去${S.admin.historyMonths}か月の記録はありません。</p>`;
  return hst.map(e => { const d = new Date(e.start);
    return `<div class="rsv"><div class="when"><div class="date" style="font-size:20px;">${fmtDay(d)} ${fmtTime(d)}</div></div>
      <div class="ops"><button class="mini del" data-act="cancel-past" data-id="${esc(e.event_id)}">取り消す</button></div></div>`; }).join('');
}

// --- カレンダー ---
function monthRange() {
  const cur = monthKeyOf(new Date());
  if (isAdmin()) return [addMonths(cur, -ADMIN_RANGE_MONTHS), addMonths(cur, ADMIN_RANGE_MONTHS)];
  const last = S.slots.length ? S.slots[S.slots.length - 1].month_key : cur;
  return [cur, last];
}
function dayStatus(date) {
  const dk = dayKeyOf(date); const slots = slotsForDay(dk);
  const mine = existingDays().has(dk);
  const picked = Array.from(S.picked.values()).some(s => s.day_key === dk);
  if (!slots.length) return { cls: 'off', mine };
  const own = slots.some(s => s.own);
  const total = slots.reduce((n, s) => n + (Number(s.reserved_count) || 0), 0);
  if (picked) return { cls: 'picked', mine, total, own };
  if (!withinDeadline(date)) return { cls: date >= today0() ? 'view' : 'off', mine, total, own };
  const open = slots.some(s => slotState(s) === 'open');
  return { cls: open ? 'ok' : (mine ? 'view' : 'full'), mine, total, own };
}
function viewCalendar() {
  if (!S.viewMonth) S.viewMonth = monthKeyOf(new Date());
  if (!isAdmin() && !S.slots.length) return `<h1>日にちをえらんでください</h1><div class="card center muted" style="padding:40px 0;">予約できる日をしらべています…<br>少しおまちください</div>
    <button class="btn quiet" data-act="home">はじめの画面にもどる</button>`;
  const [minM, maxM] = monthRange(); const [y, m] = S.viewMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1); const dim = new Date(y, m, 0).getDate();
  let cells = ''; for (let i = 0; i < first.getDay(); i++) cells += '<td class="off"></td>';
  let rows = '';
  for (let d = 1; d <= dim; d++) {
    const date = new Date(y, m - 1, d); const st = dayStatus(date);
    const tap = ['ok', 'view', 'picked'].includes(st.cls);
    const tint = (!isAdmin() && st.own && ['ok', 'view'].includes(st.cls)) ? ` style="background:${COURSES[me().course].color};"` : '';
    cells += `<td class="${st.cls}${st.mine ? ' mine' : ''}${!isAdmin() && st.cls === 'ok' && !st.own ? ' alt' : ''}"${tint} ${tap ? `data-act="day" data-day="${dayKeyOf(date)}"` : ''}>${d}${isAdmin() && st.total ? `<span class="daycnt">${st.total}人</span>` : ''}</td>`;
    if ((first.getDay() + d) % 7 === 0) { rows += `<tr>${cells}</tr>`; cells = ''; }
  }
  if (cells) { while ((cells.match(/<td/g) || []).length < 7) cells += '<td class="off"></td>'; rows += `<tr>${cells}</tr>`; }
  const title = S.mode === 'change' ? '新しい日にちをえらんでください' : '日にちをえらんでください';
  return `<h1>${title}</h1>
  ${S.mode === 'change' && S.changing ? `<div class="info" style="margin:0 0 14px;">いまの予約：${esc(fmtWhen(S.changing.start))}</div>` : ''}
  <div class="card">
    <div class="cal-head"><button class="nav" data-act="month" data-d="-1" ${monthDiff(minM, S.viewMonth) <= 0 ? 'disabled' : ''} aria-label="前の月">‹</button>
      <div class="ttl">${y}年${m}月</div>
      <button class="nav" data-act="month" data-d="1" ${monthDiff(S.viewMonth, maxM) <= 0 ? 'disabled' : ''} aria-label="次の月">›</button></div>
    <table class="cal"><thead><tr>${DAYS.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    <div class="legend">${isAdmin() ? 'どの日でも選べます。数字はその日の予約人数です。'
      : (COURSES[me().course].classes ? '<b>色のついた日</b>が、あなたのクラスの日です。<br>点線のわくの日は、同じコースの別クラスです（ふりかえ用）。' : '緑のわくの日が、予約できる日です。')}
      <br>下に点がある日は、もう予約が入っています。</div>
  </div>
  <p class="muted center" style="margin-bottom:14px;">${esc(classText(me()))}</p>
  <button class="btn quiet" data-act="home">はじめの画面にもどる</button>`;
}
function viewTimes() {
  const dk = S.pickDay; const date = parseDayKey(dk); const slots = slotsForDay(dk);
  const viewOnly = !withinDeadline(date);
  const btns = slots.map(s => {
    const st = slotState(s); const n = Number(s.reserved_count) || 0; const sel = S.picked.has(String(s.slot_id));
    if (viewOnly) return `<button class="time" disabled>${esc(s.start_time)}<small>${st === 'full' ? '満席' : (n ? n + '人' : '')}</small></button>`;
    if (st === 'mine') return `<button class="time" disabled>${esc(s.start_time)}<small>予約ずみ</small></button>`;
    if (st === 'full') return `<button class="time" disabled>${esc(s.start_time)}<small>満席</small></button>`;
    return `<button class="time ${sel ? 'sel' : ''}" data-act="time" data-id="${esc(s.slot_id)}">${esc(s.start_time)}<small>${sel ? 'えらび中' : [s.klass && !s.own ? s.klass + 'クラスにふりかえ' : '', n ? n + '人' : ''].filter(Boolean).join('・')}</small></button>`;
  }).join('');
  return `<h1>${fmtDay(date)}<br>${viewOnly ? 'の予約のようす' : '何時にしますか？'}</h1>
  ${viewOnly ? `<div class="note" style="margin:0 0 14px;">この日は、もう予約の受付がおわっています。お急ぎのときはお電話ください。</div>` : ''}
  <div class="card"><div class="times">${btns}</div></div>
  <button class="btn quiet" data-act="back-cal">カレンダーにもどる</button>`;
}

// --- 確認・完了 ---
function viewConfirm() {
  const pd = S.pending; if (!pd) return '';
  const p = me(); const who = S.proxy ? `<p class="muted">${esc(p.name)}さんの予約として登録します。</p>` : '';
  if (pd.type === 'reserve') {
    return `<h1>この内容で予約しますか？</h1><div class="card">${who}<p class="muted">クラス</p><p class="big">${esc(classText(p))}</p>
      <p class="muted" style="margin-top:12px;">日時（${pd.slots.length}回）</p>
      <ul class="list-big">${pd.slots.map(s => `<li>${fmtDay(parseDayKey(s.day_key))} ${esc(s.start_time)}${s.klass && !s.own ? `<br><span class="muted">${s.klass}クラスにふりかえ</span>` : ''}</li>`).join('')}</ul></div>
      <button class="btn" data-act="do">はい、予約する</button><button class="btn quiet" data-act="cancel-pending">やめる</button>`;
  }
  if (pd.type === 'cancel') {
    return `<h1>この予約を取り消しますか？</h1><div class="card">${who}<ul class="list-big">${pd.items.map(e => `<li>${esc(fmtWhen(e.start))}</li>`).join('')}</ul></div>
      <button class="btn danger" data-act="do">はい、取り消す</button><button class="btn quiet" data-act="cancel-pending">やめる</button>`;
  }
  return `<h1>日時を変えますか？</h1><div class="card">${who}<p class="muted">いまの予約</p><p class="big">${esc(fmtWhen(pd.from.start))}</p>
    <p class="arrow">↓ 変更</p><p class="muted">新しい予約</p><p class="big" style="color:var(--green-deep);">${fmtDay(parseDayKey(pd.to.day_key))} ${esc(pd.to.start_time)}</p></div>
    <button class="btn" data-act="do">はい、変更する</button><button class="btn quiet" data-act="cancel-pending">やめる</button>`;
}
function viewDone() {
  const d = S.done; if (!d) return '';
  if (d.error) return `<h1>うまくいきませんでした</h1><div class="card"><p class="big" style="font-size:22px;">${esc(d.error)}</p>
      <p class="muted" style="margin-top:10px;">こまったときは、お電話ください。</p></div>
      <a class="btn ghost" style="text-decoration:none;text-align:center;line-height:40px;" href="tel:${TEL}">電話で聞く</a>
      <button class="btn" style="margin-top:12px;" data-act="home">はじめの画面にもどる</button>`;
  return `<div class="card center" style="padding-top:26px;"><div class="okmark"></div><h1 style="margin-bottom:6px;">${esc(d.title)}</h1>
      <ul class="list-big">${d.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      ${d.note ? `<div class="info">${esc(d.note)}</div>` : ''}</div>
      <button class="btn" data-act="home">はじめの画面にもどる</button>`;
}

// --- 管理者 ---
function viewAdminLogin() {
  return `<h1>管理者ログイン</h1><div class="card"><input class="txt" id="passInput" data-focus type="password" inputmode="numeric" placeholder="パスコード" style="text-align:center;letter-spacing:.4em;"></div>
  <button class="btn dark" data-act="admin-do-login">ログイン</button><button class="btn quiet" data-act="home">もどる</button>`;
}
function viewAdminHome() {
  const a = S.admin; const q = normName(a.query);
  const recent = store.get('tr_admin_recent', []);
  const hits = q ? a.names.filter(n => normName(n).includes(q)).slice(0, 12) : [];
  let sum = '';
  if (a.summary) Object.keys(a.summary).sort().forEach(k => { const day = a.summary[k];
    const rows = (day.slots || []).filter(s => (s.names || []).length).map(s => `<div class="sum-row"><span class="t">${esc(s.time)}</span><span>${s.names.map(esc).join('、')}（${s.names.length}人）</span></div>`).join('');
    sum += `<div class="sum-day">${esc(day.label)}</div>${rows || '<p class="muted">予約なし</p>'}`; });
  return `<h1>だれの予約を操作しますか？</h1>
  <div class="card"><input class="txt" id="whoInput" type="text" placeholder="生徒さんの名前" value="${esc(a.query)}" autocomplete="off">
    <div class="names">${hits.map(n => `<button data-act="pick-person" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>
    ${q ? `<button class="btn dark" style="margin-top:14px;" data-act="pick-person" data-name="${esc(a.query)}">「${esc(normName(a.query))}」さんで開く</button>` : ''}
    ${recent.length ? `<p class="muted" style="margin-top:16px;">最近操作した人</p><div class="names">${recent.map(n => `<button data-act="pick-person" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
  </div>
  <div class="card"><h2 style="color:var(--admin);">今日・明日の予約</h2>${sum || '<p class="muted">読み込み中…</p>'}</div>
  <button class="btn quiet" data-act="admin-logout">管理者をおわる</button>`;
}

// ---------- 操作 ----------
function saveUsual(slots) {
  if (!slots.length || COURSES[me().course].classes) return;
  const tally = {}; slots.forEach(s => { const k = parseDayKey(s.day_key).getDay() + '|' + s.start_time; tally[k] = (tally[k] || 0) + 1; });
  const [dow, time] = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0].split('|');
  me().usual = { dow: Number(dow), time }; persistPerson();
}
function persistPerson() {
  if (S.proxy) { const all = store.get('tr_admin_people', {}); all[S.proxy.name] = { category: S.proxy.category, course: S.proxy.course, klass: S.proxy.klass || null, usual: S.proxy.usual || null }; store.set('tr_admin_people', all); }
  else store.set('tr_profile', S.profile);
}
function resetPicks() { S.picked.clear(); S.propOff.clear(); S.propOn.clear(); S.pending = null; S.changing = null; S.mode = 'add'; S.pickDay = null; }

async function doReserve(slots) {
  const p = me();
  if (DEMO) { await new Promise(r => setTimeout(r, 700));
    slots.forEach(s => { const cd = classDetails(p, s.klass);
      S.demo.added.push({ event_id: 'demo_' + s.slot_id, slot_id: String(s.slot_id), start: s.iso, class_title: `${cd.category} ${cd.course}` }); });
    return { ok: true }; }
  const byKlass = new Map(); slots.forEach(s => { const k = s.klass || ''; if (!byKlass.has(k)) byKlass.set(k, []); byKlass.get(k).push(s); });
  let last = { ok: true };
  for (const [k, list] of byKlass) {
    last = await post({ action: 'batch_reserve', name: p.name, email: null, add_to_calendar: false,
      slots: list.map(s => String(s.slot_id)), class_details: classDetails(p, k || null), passcode: adminCode() || null });
    if (!last || !last.ok) return last;
  }
  return last;
}
async function doCancel(items) {
  const p = me();
  if (DEMO) { await new Promise(r => setTimeout(r, 700));
    items.forEach(e => { if (String(e.event_id).startsWith('demo_')) S.demo.added = S.demo.added.filter(x => x.event_id !== e.event_id); else S.demo.removed.add(e.event_id); });
    return { ok: true }; }
  return await post({ action: 'batch_cancel', name: p.name, email: null, event_ids: items.map(e => e.event_id), passcode: adminCode() || null });
}
async function runPending() {
  const pd = S.pending; if (!pd) return;
  try {
    if (pd.type === 'reserve') {
      busy(true, '予約しています…'); const r = await doReserve(pd.slots);
      if (!r || !r.ok) throw new Error((r && r.message) || '予約できませんでした。');
      saveUsual(pd.slots);
      S.done = { title: '予約できました', lines: pd.slots.map(s => `${fmtDay(parseDayKey(s.day_key))} ${s.start_time}`), note: `クラス：${classText(me())}` };
    } else if (pd.type === 'cancel') {
      busy(true, '取り消しています…'); const r = await doCancel(pd.items);
      if (!r || !r.ok) throw new Error((r && r.message) || '取り消しできませんでした。');
      S.done = { title: '取り消しました', lines: pd.items.map(e => fmtWhen(e.start)) };
    } else {
      // 変更：先に新しい枠を確保し、取れてから古い予約を消す（失敗しても予約が消えない順番）
      busy(true, '日時を変更しています…'); const r1 = await doReserve([pd.to]);
      if (!r1 || !r1.ok) throw new Error((r1 && r1.message) || '新しい日時を予約できませんでした。いまの予約はそのままです。');
      const r2 = await doCancel([pd.from]);
      if (!r2 || !r2.ok) { S.done = { title: '新しい日時は予約できました', lines: [`${fmtDay(parseDayKey(pd.to.day_key))} ${pd.to.start_time}`],
        note: '前の予約の取り消しができませんでした。お手数ですが、お電話でお知らせください。' }; }
      else S.done = { title: '日時を変更しました', lines: [`${fmtDay(parseDayKey(pd.to.day_key))} ${pd.to.start_time}`], note: `前の予約（${fmtWhen(pd.from.start)}）は取り消しました。` };
    }
  } catch (e) {
    S.done = { error: e && e.name === 'AbortError' ? '通信に時間がかかっています。はじめの画面で、予約が入ったかたしかめてください。' : (e.message || 'エラーがおきました。') };
  }
  resetPicks(); S.admin.history = null;
  await loadData({ quiet: true }); busy(false); go('done');
}

async function adminLogin(code) {
  busy(true, 'たしかめています…');
  try { const d = await getJson({ action: 'admin_summary', passcode: code });
    if (!d.ok) { busy(false); alert(d.message || 'パスコードが正しくありません'); return; }
    sessionStorage.setItem('teraco_admin_code', code); S.admin.summary = d.days; busy(false); go('admin-home'); loadAdminNames();
  } catch (e) { busy(false); alert('通信できませんでした。もう一度ためしてください。'); }
}
// 名前の候補：予約カレンダーの受講イベントに出てくる名前（私用の予定はタイトルで除外）
async function loadAdminNames() {
  try { const t = today0(); const a = new Date(t); a.setDate(t.getDate() - 75); const b = new Date(t); b.setDate(t.getDate() + 60);
    const d = await getJson({ action: 'admin_calendar_events', passcode: adminCode(), start: dayKeyOf(a), end: dayKeyOf(b) });
    const set = new Set(); (d.events || []).filter(e => /^(スマホ|パソコンAI|TERACO予約)/.test(e.title || '')).forEach(e => (e.names || []).forEach(n => { const x = normName(n); if (x && x.length <= 12) set.add(x); }));
    S.admin.names = Array.from(set).sort((x, y) => x.localeCompare(y, 'ja')); if (S.view === 'admin-home') renderKeepInput();
  } catch (e) {}
}
function renderKeepInput() { const el = document.getElementById('whoInput'); const pos = el ? el.selectionStart : null; render();
  const n = document.getElementById('whoInput'); if (n && pos != null) { n.focus(); n.setSelectionRange(pos, pos); } }

async function pickPerson(raw) {
  const name = normName(raw); if (!name) return;
  const saved = store.get('tr_admin_people', {})[name] || {};
  S.proxy = { name, category: saved.category || null, course: OLD_COURSE_KEYS[saved.course] || saved.course || null, klass: saved.klass || null, usual: saved.usual || null };
  const recent = [name].concat(store.get('tr_admin_recent', []).filter(n => n !== name)).slice(0, 10); store.set('tr_admin_recent', recent);
  resetPicks(); S.loaded = false; S.existing = []; S.admin.history = null; S.admin.query = '';
  busy(true, `${name}さんの予約を開いています…`); await loadData({ quiet: true }); busy(false);
  if (!S.proxy.course) { const g = S.existing.map(inferClass).find(Boolean);
    if (g) { S.proxy.category = g.category; S.proxy.course = g.course; S.proxy.klass = g.klass; persistPerson(); } }
  const pc = S.proxy.course && COURSES[S.proxy.course];
  if (!pc) { S.draft = {}; go('ob-cat'); }
  else if (pc.classes && !S.proxy.klass) { S.draft = { category: pc.cat, course: S.proxy.course }; go('ob-class'); }
  else go('home');
}
async function loadHistory() {
  S.admin.history = 'loading'; render();
  try { const d = await post({ action: 'attendance_history', name: S.proxy.name, months: S.admin.historyMonths, passcode: adminCode() });
    S.admin.history = (d.ok ? d.history : []) || []; } catch (e) { S.admin.history = []; }
  render();
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'whoInput') { S.admin.query = e.target.value; renderKeepInput(); }
  if (e.target.id === 'nameInput') S.draft.name = e.target.value;
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'nameInput') act('name-next', e.target);
  if (e.target.id === 'passInput') act('admin-do-login', e.target);
});
document.addEventListener('click', (e) => { const el = e.target.closest('[data-act]'); if (el) act(el.dataset.act, el); });

// 選んだコース・クラスを保存してホームへ
function applyClass(klass) {
  const course = S.draft.course; const category = S.draft.category || COURSES[course].cat || 'smartphone';
  if (S.proxy) { Object.assign(S.proxy, { category, course, klass, usual: null }); persistPerson(); }
  else if (S.profile && S.edit === 'class') { Object.assign(S.profile, { category, course, klass, usual: null }); store.set('tr_profile', S.profile); }
  else { S.profile = { name: S.draft.name, category, course, klass, usual: null }; store.set('tr_profile', S.profile); S.loaded = false; }
  S.edit = null; resetPicks(); go('home'); if (!S.loaded) loadData();
}

function act(a, el) {
  const d = el.dataset || {};
  if (a === 'home') { S.edit = null; resetPicks(); if (isAdmin() && !S.proxy) return go('admin-home'); return go(me() && me().course ? 'home' : 'ob-name'); }
  if (a === 'name-next') { const n = normName((document.getElementById('nameInput') || {}).value); if (!n) { alert('お名前を入れてください。'); return; }
    if (S.edit === 'name') { S.profile.name = n; S.profile.usual = S.profile.usual || null; store.set('tr_profile', S.profile); S.edit = null; S.loaded = false; S.existing = []; go('home'); return loadData(); }
    S.draft.name = n; return go('ob-cat'); }
  if (a === 'ob-back-name') return go('ob-name');
  if (a === 'ob-cat') return go('ob-cat');
  if (a === 'cat') { S.draft.category = d.v; return go('ob-course'); }
  if (a === 'ob-course-back') return go('ob-course');
  if (a === 'course') { S.draft.course = d.v; if (COURSES[d.v].classes) return go('ob-class'); return applyClass(null); }
  if (a === 'klass') return applyClass(d.v);
  if (a === 'edit-class') { S.edit = 'class'; S.draft = {}; return go('ob-cat'); }
  if (a === 'edit-name') { S.edit = 'name'; S.draft = { name: S.profile.name }; return go('ob-name'); }

  if (a === 'prop') { const id = String(d.id); const set = d.pre === '1' ? S.propOff : S.propOn; set.has(id) ? set.delete(id) : set.add(id); const y = window.scrollY; render(); window.scrollTo(0, y); return; }
  if (a === 'to-confirm-prop') { const slots = checkedProposalSlots(); if (!slots.length) return; S.pending = { type: 'reserve', slots }; return go('confirm'); }
  if (a === 'open-cal') { S.mode = 'add'; S.changing = null; S.viewMonth = monthKeyOf(new Date()); return go('calendar'); }
  if (a === 'month') { S.viewMonth = addMonths(S.viewMonth, Number(d.d)); return render(); }
  if (a === 'day') { S.pickDay = d.day; const date = parseDayKey(d.day); const list = slotsForDay(d.day);
    const open = list.filter(x => slotState(x) === 'open');
    if (!isAdmin() && withinDeadline(date) && list.length === 1 && open.length === 1) return act('time', { dataset: { id: open[0].slot_id } });
    return go('times'); }
  if (a === 'back-cal') return go('calendar');
  if (a === 'time') { const slot = slotsForDay(S.pickDay).find(s => String(s.slot_id) === String(d.id)); if (!slot) return;
    if (S.mode === 'change') { S.pending = { type: 'change', from: S.changing, to: slot }; return go('confirm'); }
    const id = String(slot.slot_id);
    if (S.picked.has(id)) S.picked.delete(id);
    else { if (!isAdmin() && monthCount(slot.month_key) + 1 > MONTHLY_LIMIT) { alert(`${Number(slot.month_key.split('-')[1])}月の予約は${MONTHLY_LIMIT}回までです。`); return; } S.picked.set(id, slot); }
    return go('calendar'); }
  if (a === 'to-confirm-picked') { const slots = Array.from(S.picked.values()).sort((x, y) => Number(x.slot_id) - Number(y.slot_id)); S.pending = { type: 'reserve', slots }; return go('confirm'); }
  if (a === 'change') { const e = S.existing.find(x => x.event_id === d.id); if (!e) return; S.mode = 'change'; S.changing = e; S.picked.clear(); S.viewMonth = monthKeyOf(new Date(e.start)); return go('calendar'); }
  if (a === 'cancel') { const e = S.existing.find(x => x.event_id === d.id); if (!e) return; S.pending = { type: 'cancel', items: [e] }; return go('confirm'); }
  if (a === 'cancel-past') { const e = (Array.isArray(S.admin.history) ? S.admin.history : []).find(x => x.event_id === d.id); if (!e) return; S.pending = { type: 'cancel', items: [e] }; return go('confirm'); }
  if (a === 'cancel-pending') { const back = S.pending && S.pending.type === 'change' ? 'times' : 'home'; S.pending = null; if (back === 'home') resetPicks(); return go(back); }
  if (a === 'do') return runPending();
  if (a === 'history') return loadHistory();

  if (a === 'admin-login') return go('admin-login');
  if (a === 'admin-do-login') { const c = (document.getElementById('passInput') || {}).value; if (c) adminLogin(c.trim()); return; }
  if (a === 'admin-home') { S.proxy = null; resetPicks(); S.loaded = false; go('admin-home');
    getJson({ action: 'admin_summary', passcode: adminCode() }).then(x => { if (x.ok) { S.admin.summary = x.days; if (S.view === 'admin-home') renderKeepInput(); } }).catch(() => {});
    if (!S.admin.names.length) loadAdminNames(); return; }
  if (a === 'pick-person') return pickPerson(d.name);
  if (a === 'admin-logout') { sessionStorage.removeItem('teraco_admin_code'); S.proxy = null; resetPicks(); S.loaded = false; S.existing = [];
    if (S.profile && S.profile.course) { go('home'); loadData(); } else go('ob-name'); return; }
}

// ---------- 起動 ----------
(function start() {
  if (S.profile && OLD_COURSE_KEYS[S.profile.course]) { S.profile.course = OLD_COURSE_KEYS[S.profile.course]; S.profile.usual = null; store.set('tr_profile', S.profile); }
  if (isAdmin()) { act('admin-home', document.body); return; }
  const c = S.profile && COURSES[S.profile.course];
  if (S.profile && S.profile.name && c && (!c.classes || S.profile.klass)) { S.view = 'home'; loadData(); }
  else if (S.profile && S.profile.name && c) { S.edit = 'class'; S.draft = { category: c.cat, course: S.profile.course }; go('ob-class'); prefetchSlots(); }
  else { S.draft = { name: (S.profile && S.profile.name) || '' }; go('ob-name'); prefetchSlots(); }
})();
