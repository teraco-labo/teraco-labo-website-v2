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
const TT = window.TERACO_TIMETABLE;
const TIMES_PRIVATE = TT.privateTimes;   // 個人レッスン（火・木）
const ADMIN_TIMES   = TT.adminTimes;
const CATEGORIES    = TT.categories;
const COURSES       = TT.courses;
const FURIKAE = false;   // 生徒が別クラスへ振り替える機能。今は混乱のもとになるため停止（管理者の代理操作では自由に入れられる）
const OLD_COURSE_KEYS = { intro: 'sp-intro', applied: 'sp-adv', basic: 'pc-intro', advance: 'pc-adv' };

// 講座カレンダー。正本はサーバー（管理者画面「講座カレンダー」で編集）。下はサーバーから受け取る前の予備の値
let SCHEDULE = {
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

const GOOGLE_CLIENT_ID = '962051135287-af9qpio58l2qt7cu3avip6qvk9269sl2.apps.googleusercontent.com';
const S = {
  view: 'loading',
  profile: store.get('tr_profile', null),   // {name, category, course, usual:{dow,time}}
  proxy: null,                               // 管理者が代理操作中の生徒 {name, category, course, usual}
  slots: [], daySlots: new Map(), slotIndex: new Map(),
  existing: [], syncing: false, loaded: false,
  picked: new Map(), viewMonth: null, pickDay: null,
  mode: 'add', changing: null, pending: null, done: null, error: null,
  edit: null,                                // 'name' | 'class'（設定変更中）
  editRsv: false,                            // 「予約を変更する」を押して、取り消しのボタンを出している間 true
  google: store.get('teraco_google_user', null),   // {name,email,picture}：ログインしている人だけ
  addToCal: store.get('tr_add_to_cal', true),
  myHistory: null, myHistoryMonths: 3,
  line: Object.assign({ userId: null, name: null, idToken: null, inClient: false, linkedFor: null }, store.get('tr_line', {})),
  override: null,                            // {course:'private'}：個人レッスン「も」予約するとき
  draft: {},                                 // 初回登録の途中経過
  admin: { summary: null, names: [], students: [], studentsMsg: '', query: '', history: null, historyMonths: 3, pendingRender: false },
  demo: { added: [], removed: new Set() }
};

const myEmail = () => (!S.proxy && S.google && S.google.email) ? S.google.email : null;
const adminCode = () => sessionStorage.getItem('teraco_admin_code') || '';
const isAdmin = () => !!adminCode();
const baseMe = () => S.proxy || S.profile;
// S.override があるあいだは、その人を「個人レッスンの生徒」として扱う（登録してあるクラスは変えない）
function applySchedule(sc) {
  if (!sc || !Array.isArray(sc.off)) return;
  SCHEDULE = { published: sc.published || [], off: sc.off || [], events: sc.events || [], updated: sc.updated || '' };
}
const me = () => { const b = baseMe(); return b && S.override ? Object.assign({}, b, S.override) : b; };

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
// クラス名には必ず分数を入れる（例：スマホ入門 A（45分）／個人レッスン（50分））
function courseName(course, klass) {
  const c = COURSES[course]; if (!c) return '';
  return c.classes && klass ? `${c.label} ${klass}（${c.min}分）` : `${c.label}（${c.min}分）`;
}
function classText(p) {
  if (!p || !p.course || !COURSES[p.course]) return '';
  const c = COURSES[p.course];
  return c.classes && p.klass ? `${courseName(p.course, p.klass)} ${dowTimeText(c.classes[p.klass])}` : courseName(p.course);
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
const rowClassText = (e) => { const g = inferClass(e); return g ? courseName(g.course, g.klass) : ''; };

// ---------- LINE（LIFF） ----------
const LINE_CFG = window.TERACO_LINE || {};
async function lineInit() {
  if (!LINE_CFG.liffId || !window.liff) return;
  try {
    await liff.init({ liffId: LINE_CFG.liffId });
    S.line.inClient = liff.isInClient();
    if (liff.isLoggedIn()) {
      S.line.idToken = liff.getIDToken() || null;
      const p = await liff.getProfile().catch(() => null);
      if (p) { S.line.userId = p.userId; S.line.name = p.displayName; }
      store.set('tr_line', { userId: S.line.userId, name: S.line.name, linkedFor: S.line.linkedFor });
      lineLink();
    } else if (liff.isInClient()) { liff.login(); }   // LINEの中で開いたときだけ自動ログイン
  } catch (e) { /* LINE連携が使えなくても予約は使える */ }
}
// 登録した名前とLINEを結びつける（一度結びつけば、先生が代理で入れた予約もその人のLINEに届く）
async function lineLink() {
  const p = baseMe(); if (!p || !p.name || !S.line.idToken || S.line.linkedFor === p.name || DEMO) return;
  try { const r = await post({ action: 'line_link', id_token: S.line.idToken, name: p.name });
    if (r && r.ok) { S.line.linkedFor = p.name; store.set('tr_line', { userId: S.line.userId, name: S.line.name, linkedFor: p.name }); if (S.view === 'more') render(); } } catch (e) {}
}
const lineLabelFor = (p, k) => { const c = COURSES[p.course]; return c.classes ? `${courseName(p.course, k || p.klass)} ${dowTimeText(c.classes[k || p.klass])}` : courseName(p.course); };

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
    if (c && c.slots) { S.slots = c.slots; S.existing = c.existing || []; applySchedule(c.schedule); indexSlots(); applyDemo(); S.loaded = true; }
  }
  S.syncing = true; if (!quiet) render();
  try {
    const d = await post({ action: 'next_data', name: name, days: 75, email: myEmail() });
    if (!d || !d.ok) throw new Error('load');
    if (me() && me().name !== name) return;            // 途中で人が切り替わった
    S.slots = d.slots || []; S.existing = d.existing || []; applySchedule(d.schedule); indexSlots(); applyDemo(); S.loaded = true;
    store.set(cacheKey, { t: Date.now(), slots: S.slots, existing: d.existing || [], schedule: d.schedule || null });
    S.error = null;
  } catch (e) {
    if (!S.loaded) S.error = '予約状況を読み込めませんでした。電波のよい場所で、もう一度ためしてください。';
  } finally { S.syncing = false; render(); }
}
// 初めての人が名前を入れている間に、空き枠だけ先に読んでおく
async function prefetchSlots() {
  try { const d = await post({ action: 'next_data', name: '', days: 75, email: null });
    if (!S.slots.length && d && d.slots) { S.slots = d.slots; applySchedule(d.schedule); indexSlots(); if (S.view === 'calendar') render(); } } catch (e) {}
}

// ---------- ルール ----------
const isOff = (dayKey) => SCHEDULE.off.includes(dayKey);
const eventAt = (dayKey, time) => SCHEDULE.events.find(ev => ev.day === dayKey && ev.time === time) || null;
// その日に受けられる講座の一覧 [{time, klass, own}]。own=自分のクラス、false=同じコースの別クラス（振替）
function lessonsOn(p, date) {
  const dk = dayKeyOf(date); const dow = date.getDay();
  if (!p || !p.course || isOff(dk)) return [];
  // 先生が日程を確定して公開した月だけ、生徒から予約できる（管理者の代理操作はいつでも可）
  if (!SCHEDULE.published.includes(monthKeyOf(date))) return [];
  const c = COURSES[p.course];
  if (!c.classes) return TT.privateDows.includes(dow) ? TIMES_PRIVATE.filter(t => !eventAt(dk, t)).map(t => ({ time: t, klass: null, own: true })) : [];
  return Object.keys(c.classes).filter(k => c.classes[k].dow === dow && (FURIKAE || k === p.klass)).map(k => ({ time: c.classes[k].time, klass: k, own: k === p.klass }));
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
  if (isAdmin()) { const p = me(); const c = p && COURSES[p.course];
    // 管理者：どの時間でも入れられる。時間割に合う枠はそのクラス名で登録する
    return ADMIN_TIMES.map(t => { let k = null;
      if (c && c.classes) k = Object.keys(c.classes).find(x => c.classes[x].dow === date.getDay() && c.classes[x].time === t) || p.klass;
      return makeSlot(date, t, { klass: k, own: true }); }); }
  const solo = !COURSES[me().course].classes;   // 個人レッスンは定員1人
  return lessonsOn(me(), date).map(l => makeSlot(date, l.time, Object.assign({ klass: l.klass, own: l.own }, solo ? { capacity: 1 } : {})));
}
const existingIds = () => new Set(S.existing.map(e => String(e.slot_id)));
const existingDays = () => new Set(S.existing.map(e => dayKeyOf(new Date(e.start))));
function slotState(slot) {
  if (existingIds().has(String(slot.slot_id))) return 'mine';
  if (Number(slot.capacity) === 1 && slot.busy) return 'full';
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
    : v === 'ob-name-confirm' ? viewNameConfirm()
    : v === 'ob-cat' ? viewCategory()
    : v === 'ob-course' ? viewCourse()
    : v === 'ob-class' ? viewKlass()
    : v === 'home' ? viewHome()
    : v === 'reserve' ? viewReserve()
    : v === 'extra' ? viewExtra()
    : v === 'calendar' ? viewCalendar()
    : v === 'times' ? viewTimes()
    : v === 'confirm' ? viewConfirm()
    : v === 'done' ? viewDone()
    : v === 'more' ? viewMore()
    : v === 'admin-login' ? viewAdminLogin()
    : v === 'admin-home' ? viewAdminHome()
    : v === 'admin-schedule' ? viewAdminSchedule()
    : '';
  $app().innerHTML = html;
  if (v === 'admin-schedule' && S.sched && S.sched.dirty) {
    document.getElementById('tray').innerHTML = `<div class="tray"><div class="in"><div class="n">まだ保存していない変更があります</div><button class="btn dark" data-act="sched-save">保存する</button></div></div>`;
  }
  if (v === 'more') mountGoogleButton();
  const f = document.querySelector('[data-focus]'); if (f) f.focus();
}

// --- 初回：名前 → 名前の確認 → 講座 → 曜日 ---
function viewName() {
  const editing = S.edit === 'name';
  return `<h1>${editing ? 'お名前をなおす' : 'はじめに、お名前をおしえてください'}</h1>
  <div class="card">
    <input class="txt" id="nameInput" data-focus type="text" placeholder="例：田中花子" value="${esc(S.draft.name || '')}" autocomplete="name" enterkeyhint="done">
    <p class="muted" style="margin-top:10px;">姓と名前の間にスペース（空白）を入れず、つづけて入れてください。<br>入れおわったら、下の「つぎへ」をおしてください。</p>
  </div>
  <button class="btn" data-act="name-next">つぎへ</button>
  ${editing ? `<button class="btn quiet" data-act="home">やめる</button>` : ''}`;
}
function viewNameConfirm() {
  return `<h1>このお名前で登録します</h1>
  <div class="card center"><p class="muted">お名前</p><p class="big" style="font-size:32px;margin:6px 0 4px;">${esc(S.draft.name)} さん</p></div>
  <button class="btn" data-act="name-ok">はい、登録する</button>
  <button class="btn quiet" data-act="ob-back-name">なおす</button>`;
}
function viewCourse() {
  const back = S.proxy ? (S.proxy.course ? 'home' : 'admin-home') : (S.edit === 'class' ? 'home' : 'ob-back-name');
  return `<h1>どの講座ですか？</h1>
  ${Object.keys(COURSES).map(k => `<button class="choice" data-act="course" data-v="${k}" style="border-left:16px solid ${COURSES[k].color};"><b>${esc(courseName(k))}</b>${k === 'private' ? '<span>先生と1対1</span>' : ''}</button>`).join('')}
  <p class="muted center" style="margin:6px 0 14px;">わからないときは、先生におたずねください。<br><a href="tel:${TEL}" style="color:var(--green-deep);font-weight:800;">電話で聞く</a></p>
  <button class="btn quiet" data-act="${back}">もどる</button>`;
}
function viewKlass() {
  const c = COURSES[S.draft.course];
  return `<h1>${esc(courseName(S.draft.course))}<br>何曜日のクラスですか？</h1>
  ${Object.keys(c.classes).map(k => `<button class="choice" data-act="klass" data-v="${k}" style="border-left:16px solid ${c.color};"><b>${DAYS[c.classes[k].dow]}曜日 ${esc(c.classes[k].time)}</b><span>${k}クラス</span></button>`).join('')}
  <button class="btn quiet" data-act="ob-course-back">もどる</button>`;
}
function viewCategory() {
  return `<h1>${esc(courseName('private'))}<br>何を習いますか？</h1>
  <button class="choice" data-act="cat" data-v="smartphone"><b>スマホ</b></button>
  <button class="choice" data-act="cat" data-v="pc_ai"><b>パソコン・AI</b></button>
  <button class="btn quiet" data-act="ob-course-back">もどる</button>`;
}

// --- ホーム ---
function rsvRow(e) {
  const d = new Date(e.start); const can = withinDeadline(d);
  if (!S.editRsv) return `<div class="rsv"><div class="when"><div class="date">${fmtDay(d)} ${fmtTime(d)}</div><div class="cls">${esc(rowClassText(e))}</div></div></div>`;
  // 日時の変更：管理者はいつでも。生徒は個人レッスンだけ（グループ講座は曜日・時間が固定で、振替は今は使わないため）
  const g0 = inferClass(e); const canChange = isAdmin() || FURIKAE || (g0 && g0.course === 'private');
  return `<div class="rsv"><div class="when"><div class="date">${fmtDay(d)} ${fmtTime(d)}</div>
    <div class="cls">${esc(rowClassText(e))}</div></div>
    <div class="ops">${can
      ? `${canChange ? `<button class="mini" data-act="change" data-id="${esc(e.event_id)}">日時を変える</button>` : ''}<button class="mini del" data-act="cancel" data-id="${esc(e.event_id)}">取り消す</button>`
      : `<a class="mini" style="text-decoration:none;text-align:center;" href="tel:${TEL}">電話で相談</a>`}</div></div>`;
}
function viewHome() {
  const p = me(); if (!p) return '';
  const list = S.existing.slice().sort((a, b) => new Date(a.start) - new Date(b.start));
  let h = `<h1>${S.proxy ? esc(p.name) + 'さんの予約を操作' : esc(p.name) + 'さん、こんにちは'}</h1><div class="sync">${S.syncing ? '最新の予約状況をたしかめています…' : ''}</div>`;
  if (S.error) h += `<div class="note" style="margin-bottom:16px;">${esc(S.error)}</div>`;

  h += `<div class="card"><h2>${S.proxy ? esc(p.name) + 'さんの予約' : 'あなたの予約'}</h2>`;
  if (!S.loaded) h += `<p class="muted">読み込み中…</p>`;
  else if (!list.length) h += `<p class="muted">いま入っている予約はありません。</p>`;
  else { h += list.map(rsvRow).join('');
         if (S.editRsv && !isAdmin()) h += `<p class="muted" style="margin-top:8px;">変更・取り消しは前日の17時までできます。</p>`;
         h += `<button class="btn ${S.editRsv ? 'quiet' : 'ghost'}" style="margin-top:14px;" data-act="edit-rsv">${S.editRsv ? '変更をおわる' : '予約を変更する'}</button>`; }
  if (S.proxy) h += `<div style="margin-top:12px;"><button class="link" data-act="history" data-m="${S.admin.historyMonths}">過去の予約を見る</button></div>${S.admin.history ? periodButtons('history', S.admin.historyMonths) : ''}${viewHistory()}`;
  h += `</div>`;

  h += `<button class="btn" style="margin-bottom:18px;" data-act="reserve">予約をとる</button>`;
  if (COURSES[p.course].classes) h += `<div class="card"><h2>個人レッスンも受けるとき</h2>
    <p class="muted" style="margin-bottom:12px;">特典チケットや、個別に習いたいときはこちらから。</p>
    <button class="btn ghost" data-act="extra-private">${esc(courseName('private'))}も予約する</button></div>`;

  h += `<div class="links"><button class="link" data-act="edit-class">クラスを変える</button>
        ${S.proxy ? '' : `<button class="link" data-act="edit-name">お名前をなおす</button><button class="link" data-act="more">受講履歴・そのほか</button>`}
        <a class="link" href="tel:${TEL}">電話で聞く</a></div>
        <div class="links" style="margin-top:26px;"><button class="link" style="font-size:14px;color:#9AA8A0;" data-act="${isAdmin() ? 'admin-home' : 'admin-login'}">管理者</button></div>`;
  return h;
}
// 予約をとる画面（カレンダー）。「最初から」を押すと、えらんだものを全部消してこの画面になる
function viewReserve() {
  const p = me(); if (!p) return '';
  initHomePicks();
  let h = `<h1>${S.proxy ? esc(p.name) + 'さんの予約をとる' : '予約をとる'}</h1>`;
  if (S.error) h += `<div class="note" style="margin-bottom:16px;">${esc(S.error)}</div>`;
  const group = !!(COURSES[p.course] && COURSES[p.course].classes) && !isAdmin();
  h += `<div class="card" id="next">
        <p style="font-weight:800;border-left:14px solid ${COURSES[p.course].color};padding-left:10px;margin-bottom:12px;">${esc(classText(p))}</p>`;
  if (!S.loaded) h += `<p class="muted">予約できる日をしらべています…</p>`;
  else {
    h += calendarBlock();
    const picked = Array.from(S.picked.values());
    const rows = (group ? monthCandidates(S.viewMonth).concat(picked.filter(x => x.month_key !== S.viewMonth)) : picked)
      .sort((x, y) => Number(x.slot_id) - Number(y.slot_id));
    if (rows.length) h += `<div class="month-label">${group ? 'えらべる日' : 'えらんだ日時'}</div>` + rows.map(sl => {
      const on = S.picked.has(String(sl.slot_id)); const n = Number(sl.reserved_count) || 0;
      return `<button class="pick ${on ? 'on' : ''}" data-act="toggle-slot" data-id="${esc(sl.slot_id)}" data-day="${esc(sl.day_key)}">
        <span class="box"></span><span>${fmtDay(parseDayKey(sl.day_key))}${group ? '' : ' ' + esc(sl.start_time)}</span>${n > 0 ? `<span class="cnt">${n}人</span>` : ''}</button>`; }).join('');
    const n = S.picked.size;
    h += `<button class="btn" style="margin-top:10px;" data-act="to-confirm-picked" ${n ? '' : 'disabled'}>${n ? `この${n}回を予約する` : '日にちをえらんでください'}</button>`;
  }
  h += `</div><button class="btn quiet" data-act="home">やめて、はじめの画面にもどる</button>`;
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
// カレンダーを最初に開く月：生徒は「公開されている、いちばん近い月」。管理者は今月
function firstBookableMonth() {
  const cur = monthKeyOf(new Date()); if (isAdmin()) return cur;
  return [cur, addMonths(cur, 1), addMonths(cur, 2)].find(k => SCHEDULE.published.includes(k)) || cur;
}
// はじめてホームを出すとき、確定している月の「自分のクラスの日」を最初からえらんだ状態にする
function initHomePicks() {
  if (!S.loaded || S.pickInit || S.mode === 'change') return;
  S.pickInit = true;
  const g = proposals()[0];
  if (g) { g.items.forEach(sl => S.picked.set(String(sl.slot_id), sl)); S.viewMonth = g.mk; }
  else S.viewMonth = firstBookableMonth();
}
// その月の、自分が予約できる日（グループ講座用）
function monthCandidates(mk) {
  const [y, m] = mk.split('-').map(Number); const dim = new Date(y, m, 0).getDate(); const taken = existingDays(); const out = [];
  for (let d = 1; d <= dim; d++) { const date = new Date(y, m - 1, d); if (!withinDeadline(date)) continue;
    const dk = dayKeyOf(date); if (taken.has(dk)) continue;
    slotsForDay(dk).filter(sl => sl.own && slotState(sl) === 'open').forEach(sl => out.push(sl)); }
  return out;
}
function calendarBlock() {
  if (!S.viewMonth) S.viewMonth = monthKeyOf(new Date());
  const [minM, maxM] = monthRange(); const [y, m] = S.viewMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1); const dim = new Date(y, m, 0).getDate();
  let cells = ''; for (let i = 0; i < first.getDay(); i++) cells += '<td class="off"></td>';
  let rows = ''; let hasHol = false, hasEv = false;
  for (let d = 1; d <= dim; d++) {
    const date = new Date(y, m - 1, d); const st = dayStatus(date);
    const tap = ['ok', 'view', 'picked'].includes(st.cls);
    const tint = (!isAdmin() && st.own && ['ok', 'view'].includes(st.cls)) ? ` style="background:${COURSES[me().course].color};"` : '';
    // 講座カレンダー（先生が登録した休み・体験会など）を、そのまま日付のマスに出す
    const dk = dayKeyOf(date); const hol = isOff(dk); const ev = hol ? null : SCHEDULE.events.find(e => e.day === dk);
    if (hol) hasHol = true; if (ev) hasEv = true;
    const tag = hol ? '<small class="tag hol">休み</small>' : (ev ? `<small class="tag ev">${esc(evShort(ev.label))}</small>` : '');
    cells += `<td class="${st.cls}${st.mine ? ' mine' : ''}${hol ? ' hol' : ''}"${tint} ${tap ? `data-act="day" data-day="${dk}"` : ''}>${d}${tag}${isAdmin() && st.total ? `<span class="daycnt">${st.total}人</span>` : ''}</td>`;
    if ((first.getDay() + d) % 7 === 0) { rows += `<tr>${cells}</tr>`; cells = ''; }
  }
  if (cells) { while ((cells.match(/<td/g) || []).length < 7) cells += '<td class="off"></td>'; rows += `<tr>${cells}</tr>`; }
  const cur = monthKeyOf(new Date());
  const undecided = !isAdmin() && !SCHEDULE.published.includes(S.viewMonth) && S.viewMonth >= cur;
  const group = !isAdmin() && COURSES[me().course].classes;
  const legend = isAdmin() ? 'どの日でも選べます。数字はその日の予約人数です。'
    : group ? '<b>色のついた日</b>が、あなたのクラスの日です。<br>おすと、えらぶ・はずすができます。<b>緑の日</b>が、えらんでいる日です。'
    : '緑のわくの日をおして、時間をえらんでください。';
  return `<div class="cal-head"><button class="nav" data-act="month" data-d="-1" ${monthDiff(minM, S.viewMonth) <= 0 ? 'disabled' : ''} aria-label="前の月">‹</button>
      <div class="ttl">${y}年${m}月</div>
      <button class="nav" data-act="month" data-d="1" ${monthDiff(S.viewMonth, maxM) <= 0 ? 'disabled' : ''} aria-label="次の月">›</button></div>
    <table class="cal"><thead><tr>${DAYS.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    ${undecided ? `<div class="note">${m}月の日程は、まだ決まっていません。決まりしだい、ここに出ます。</div>` : ''}
    <div class="legend">${legend}<br>下に点がある日は、もう予約が入っています。${hasHol ? '<br>「休み」の日は、教室がお休みです。' : ''}${hasEv ? '<br>「体験会」は、はじめての方の見学・体験の会です。' : ''}</div>
    <div class="links" style="margin-top:10px;"><a class="link" target="_blank" rel="noopener" href="calendar.html?m=${S.viewMonth}">${m}月の講座カレンダーを見る</a></div>`;
}
// 体験会などの予定を、日付のマスに入る短い言葉にする
function evShort(label) { const s = String(label || ''); return /体験会/.test(s) ? '体験会' : s.slice(0, 4); }
// えらんだ日時の行（個人レッスン・管理者用）と予約ボタン
function pickedRowsAndButton() {
  const picked = Array.from(S.picked.values()).sort((x, y) => Number(x.slot_id) - Number(y.slot_id)); const n = picked.length;
  return (n ? `<div class="month-label">えらんだ日時</div>` + picked.map(sl => `<button class="pick on" data-act="toggle-slot" data-id="${esc(sl.slot_id)}" data-day="${esc(sl.day_key)}">
      <span class="box"></span><span>${fmtDay(parseDayKey(sl.day_key))} ${esc(sl.start_time)}</span></button>`).join('') : '')
    + `<button class="btn" style="margin-top:10px;" data-act="to-confirm-picked" ${n ? '' : 'disabled'}>${n ? `この${n}回を予約する` : '日にちをえらんでください'}</button>`;
}
// グループの生徒が、個人レッスン「も」予約するときの画面
function viewExtra() {
  return `<h1>${esc(courseName('private'))}<br>日にちをえらんでください</h1>
  <div class="card" id="next">${S.loaded ? calendarBlock() + pickedRowsAndButton() : '<p class="muted">予約できる日をしらべています…</p>'}</div>
  <button class="btn quiet" data-act="home">やめて、はじめの画面にもどる</button>`;
}
// 「日時を変える」で新しい日をえらぶ画面
function viewCalendar() {
  return `<h1>新しい日にちをえらんでください</h1>
  ${S.changing ? `<div class="info" style="margin:0 0 14px;">いまの予約：${esc(fmtWhen(S.changing.start))}<br>${esc(rowClassText(S.changing))}</div>` : ''}
  <div class="card">${calendarBlock()}</div>
  <button class="btn quiet" data-act="home">やめて、はじめの画面にもどる</button>`;
}
function viewTimes() {
  const dk = S.pickDay; const date = parseDayKey(dk); const slots = slotsForDay(dk);
  const viewOnly = !withinDeadline(date);
  const btns = slots.map(s => {
    const st = slotState(s); const n = Number(s.reserved_count) || 0; const sel = S.picked.has(String(s.slot_id));
    if (viewOnly) return `<button class="time" disabled>${esc(s.start_time)}<small>${st === 'full' ? (Number(s.capacity) === 1 ? 'うまっています' : '満席') : (n ? n + '人' : '')}</small></button>`;
    if (st === 'mine') return `<button class="time" disabled>${esc(s.start_time)}<small>予約ずみ</small></button>`;
    if (st === 'full' && !isAdmin()) return `<button class="time" disabled>${esc(s.start_time)}<small>${Number(s.capacity) === 1 ? 'うまっています' : '満席'}</small></button>`;
    return `<button class="time ${sel ? 'sel' : ''}" data-act="time" data-id="${esc(s.slot_id)}">${esc(s.start_time)}<small>${sel ? 'えらび中' : [s.klass && !s.own ? s.klass + 'クラスにふりかえ' : '', n ? n + '人' : ''].filter(Boolean).join('・')}</small></button>`;
  }).join('');
  return `<h1>${fmtDay(date)}<br>${viewOnly ? 'の予約のようす' : '何時にしますか？'}</h1>
  ${viewOnly ? `<div class="note" style="margin:0 0 14px;">この日は、もう予約の受付がおわっています。お急ぎのときはお電話ください。</div>` : ''}
  <div class="card"><div class="times">${btns}</div></div>
  <button class="btn quiet" data-act="back-cal">もどる</button>`;
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
function lineResultHtml(l) {
  if (!l || S.proxy) return '';
  if (l.sent) return `<div class="info">LINEにお知らせを送りました。</div>`;
  if (l.reason === 'not_friend') return `<div class="note">LINEのお知らせは、「${esc(LINE_CFG.accountName || 'スマホ教室TERACO')}」を友だち追加すると届きます。<br><a href="${esc(LINE_CFG.addFriendUrl || '#')}" style="color:#8E281D;font-weight:800;">友だち追加する</a></div>`;
  if (l.reason === 'limit') return `<div class="note">今月のLINEのお知らせは上限に達したため送れませんでした。予約はできています。</div>`;
  return '';
}
function viewDone() {
  const d = S.done; if (!d) return '';
  if (d.error) return `<h1>うまくいきませんでした</h1><div class="card"><p class="big" style="font-size:22px;">${esc(d.error)}</p>
      <p class="muted" style="margin-top:10px;">こまったときは、お電話ください。</p></div>
      <a class="btn ghost" style="text-decoration:none;text-align:center;line-height:40px;" href="tel:${TEL}">電話で聞く</a>
      <button class="btn" style="margin-top:12px;" data-act="home">はじめの画面にもどる</button>`;
  return `<div class="card center" style="padding-top:26px;"><div class="okmark"></div><h1 style="margin-bottom:6px;">${esc(d.title)}</h1>
      <ul class="list-big">${d.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      ${d.note ? `<div class="info">${esc(d.note)}</div>` : ''}
      ${lineResultHtml(d.line)}</div>
      <button class="btn" data-act="home">はじめの画面にもどる</button>`;
}

// --- そのほか：受講履歴・Googleログイン・登録のやりなおし ---
function historyListHtml(list) {
  if (!list.length) return `<p class="muted">この期間の記録はありません。</p>`;
  const by = {}; list.forEach(e => { const k = e.start.slice(0, 7); (by[k] = by[k] || []).push(e); });
  return Object.keys(by).sort().reverse().map(k => `<div class="month-label">${Number(k.slice(0, 4))}年${Number(k.slice(5))}月（${by[k].length}回）</div>` +
    by[k].map(e => { const d = new Date(e.start); return `<div class="sum-row"><span style="flex:1;font-weight:800;">${fmtDay(d)} ${fmtTime(d)}</span><span class="muted">${esc(rowClassText(e))}</span></div>`; }).join('')).join('');
}
function periodButtons(act, cur) {
  return `<div style="display:flex;gap:8px;margin:0 0 12px;">${[[1, '1か月'], [3, '3か月'], [6, '6か月'], [12, '1年']].map(([n, t]) =>
    `<button class="mini" style="flex:1;min-width:0;${n === cur ? 'background:var(--green);color:#fff;' : ''}" data-act="${act}" data-m="${n}">${t}</button>`).join('')}</div>`;
}
function viewMore() {
  const g = S.google;
  let h = `<h1>受講履歴・そのほか</h1>`;
  h += `<div class="card"><h2>これまでの受講履歴</h2>`;
  if (!g) h += `<p class="muted" style="margin-bottom:12px;">受講履歴は、Googleでログインすると見られます。<br>（予約や取り消しは、ログインしなくてもできます）</p><div id="gBtn" class="center"></div>`;
  else { h += periodButtons('my-history', S.myHistoryMonths);
    h += S.myHistory === 'loading' ? `<p class="muted">読み込み中…</p>` : Array.isArray(S.myHistory) ? historyListHtml(S.myHistory) : `<button class="btn ghost" data-act="my-history" data-m="${S.myHistoryMonths}">受講履歴を見る</button>`; }
  h += `</div>`;
  if (g) h += `<div class="card"><h2>Googleアカウント</h2><p style="font-weight:800;">${esc(g.name || '')}</p><p class="muted">${esc(g.email || '')}</p>
      <button class="pick ${S.addToCal ? 'on' : ''}" style="margin-top:12px;font-size:19px;" data-act="toggle-cal"><span class="box"></span><span>予約をGoogleカレンダーにも入れる</span></button>
      <button class="btn quiet" data-act="g-logout">Googleからログアウトする</button></div>`;
  if (LINE_CFG.liffId) h += `<div class="card"><h2>LINEのお知らせ</h2>${S.line.userId
      ? `<p style="font-weight:800;">受け取れる状態です</p><p class="muted">LINE名：${esc(S.line.name || '')}${S.line.linkedFor ? '（' + esc(S.line.linkedFor) + ' さんとして登録）' : ''}</p>`
      : `<p class="muted">公式LINEの「講座を予約」からこのアプリを開くと、予約のたびにLINEへお知らせが届くようになります。</p>`}</div>`;
  h += `<div class="card"><h2>登録のやりなおし</h2><p class="muted" style="margin-bottom:12px;">お名前とクラスを、最初から登録しなおします。入っている予約は消えません。</p>
      <button class="btn quiet" data-act="reset-all">登録をやりなおす</button></div>
      <button class="btn" data-act="home">はじめの画面にもどる</button>`;
  return h;
}
function decodeJwt(token) {
  const b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(atob(b).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')));
}
function onGoogleCredential(resp) {
  try { const p = decodeJwt(resp.credential); S.google = { sub: p.sub, name: p.name, email: p.email, picture: p.picture };
    store.set('teraco_google_user', S.google); S.myHistory = null; S.loaded = false; render(); loadData({ quiet: true }); } catch (e) {}
}
function mountGoogleButton() {
  const box = document.getElementById('gBtn'); if (!box) return;
  const draw = () => { try { google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onGoogleCredential });
    google.accounts.id.renderButton(box, { type: 'standard', size: 'large', theme: 'outline', text: 'signin_with', shape: 'rectangular', logo_alignment: 'left' }); } catch (e) {} };
  if (window.google && google.accounts && google.accounts.id) return draw();
  if (document.getElementById('gsiScript')) return;
  const sc = document.createElement('script'); sc.id = 'gsiScript'; sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.onload = () => { if (S.view === 'more') draw(); };
  document.head.appendChild(sc);
}
async function loadMyHistory(months) {
  S.myHistoryMonths = months; S.myHistory = 'loading'; render();
  try { const d = await post({ action: 'attendance_history', name: S.profile.name, months, email: S.google.email, passcode: null });
    S.myHistory = d && d.ok ? (d.history || []) : []; } catch (e) { S.myHistory = []; }
  render();
}

// --- 管理者 ---
function viewAdminLogin() {
  return `<h1>管理者ログイン</h1><div class="card"><input class="txt" id="passInput" data-focus type="password" inputmode="numeric" placeholder="パスコード" style="text-align:center;letter-spacing:.4em;"></div>
  <button class="btn dark" data-act="admin-do-login">ログイン</button><button class="btn quiet" data-act="home">もどる</button>`;
}
function viewAdminHome() {
  const a = S.admin; const q = normName(a.query);
  const recent = store.get('tr_admin_recent', []);
  let sum = '';
  if (a.summary) Object.keys(a.summary).sort().forEach(k => { const day = a.summary[k];
    const rows = (day.slots || []).filter(s => (s.names || []).length).map(s => `<div class="sum-row"><span class="t">${esc(s.time)}</span><span>${s.names.map(esc).join('、')}（${s.names.length}人）</span></div>`).join('');
    sum += `<div class="sum-day">${esc(day.label)}</div>${rows || '<p class="muted">予約なし</p>'}`; });
  const opts = a.students.map(st => `<option value="${esc(st.name)}">${esc(st.name)}${st.status === '休会' ? '（休会）' : ''}</option>`).join('');
  const selBlock = a.students.length
    ? `<select class="sel" id="whoSelect"><option value="">生徒さんをえらぶ（五十音順・${a.students.length}人）</option>${opts}</select>`
    : `<p class="muted">${esc(a.studentsMsg || '生徒さんの一覧を読み込み中…')}</p>`;
  return `<h1>だれの予約を操作しますか？</h1>
  <div class="card">${selBlock}
    <p class="muted" style="margin:14px 0 6px;">一覧にない人は、名前を入れてください</p>
    <input class="txt" id="whoInput" type="text" placeholder="生徒さんの名前" value="${esc(a.query)}" autocomplete="off">
    <div id="whoHits">${whoHitsHtml()}</div>
    ${recent.length ? `<p class="muted" style="margin-top:16px;">最近操作した人</p><div class="names">${recent.map(n => `<button data-act="pick-person" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
  </div>
  <div class="card"><h2 style="color:var(--admin);">講座カレンダー</h2>
    <p class="muted" style="margin-bottom:12px;">休みの日・週と体験会を登録します。生徒さんの予約画面と、印刷用カレンダーの両方に反映されます。</p>
    <button class="btn dark" data-act="admin-schedule">講座カレンダーを編集する</button>
    <a class="btn ghost" style="text-decoration:none;text-align:center;line-height:40px;margin-top:10px;" target="_blank" rel="noopener" href="calendar.html?m=${addMonths(monthKeyOf(new Date()), 1)}">講座カレンダーを見る（印刷用）</a></div>
  <div class="card"><h2 style="color:var(--admin);">今日・明日の予約</h2>${sum || '<p class="muted">読み込み中…</p>'}</div>
  <button class="btn quiet" data-act="admin-logout">管理者をおわる</button>`;
}

// --- 管理者：講座カレンダー（休み・体験会・公開）の編集 ---
const LESSON_DOWS = [2, 3, 4, 5];   // 火水木金
function schedInit() {
  S.sched = { draft: JSON.parse(JSON.stringify(SCHEDULE)), month: addMonths(monthKeyOf(new Date()), 1), dirty: false, form: { day: '', time: '10:00', label: '', min: 45 } };
}
function weekDaysOf(date) {           // その週の火〜金の日付キー
  const sun = new Date(date); sun.setDate(date.getDate() - date.getDay());
  return LESSON_DOWS.map(w => { const d = new Date(sun); d.setDate(sun.getDate() + w); return dayKeyOf(d); });
}
function viewAdminSchedule() {
  const sc = S.sched; const [y, m] = sc.month.split('-').map(Number);
  const first = new Date(y, m - 1, 1); const dim = new Date(y, m, 0).getDate();
  const off = new Set(sc.draft.off); const published = sc.draft.published.includes(sc.month);
  const cur = monthKeyOf(new Date());
  let cells = ''; for (let i = 0; i < first.getDay(); i++) cells += '<td class="off"></td>';
  let rows = ''; const counts = { 2: 0, 3: 0, 4: 0, 5: 0 }; const weeks = [];
  for (let d = 1; d <= dim; d++) {
    const date = new Date(y, m - 1, d); const dk = dayKeyOf(date); const dow = date.getDay();
    if (LESSON_DOWS.includes(dow)) {
      const isOffDay = off.has(dk); if (!isOffDay) counts[dow]++;
      const ev = sc.draft.events.filter(e => e.day === dk).length;
      const bg = isOffDay ? '#E9ECEA' : ([3, 5].includes(dow) ? '#DDF3E3' : '#FDF3C4');
      cells += `<td data-act="sched-day" data-day="${dk}" style="cursor:pointer;background:${bg};color:${isOffDay ? '#9AA8A0' : 'var(--ink)'};">${d}${isOffDay ? '<span class="daycnt" style="background:#9AA8A0;">休</span>' : (ev ? '<span class="daycnt" style="background:#B0561F;">催</span>' : '')}</td>`;
      const wk = weekDaysOf(date).join(','); if (!weeks.includes(wk)) weeks.push(wk);
    } else cells += `<td class="off">${d}</td>`;
    if ((first.getDay() + d) % 7 === 0) { rows += `<tr>${cells}</tr>`; cells = ''; }
  }
  if (cells) { while ((cells.match(/<td/g) || []).length < 7) cells += '<td class="off"></td>'; rows += `<tr>${cells}</tr>`; }

  // 裏で数えて、ひとことで伝える
  const names = { 2: '火', 3: '水', 4: '木', 5: '金' };
  const over = [3, 5].filter(w => counts[w] !== 4).map(w => `${names[w]}曜が${counts[w]}回`);
  const many = [3, 5].some(w => counts[w] > 4), few = [3, 5].some(w => counts[w] < 4);
  const advice = !over.length ? '水曜・金曜とも、ちょうど4回です。'
    : `${over.join('、')}です。` + (many && few ? '月4回にそろえるには、休みの週を見直してください。' : many ? '月4回にするなら、休みにする週をえらんでください。' : '月4回にするなら、休みを1つもどしてください。');
  const weekRows = weeks.map(wk => { const ds = wk.split(','); const allOff = ds.every(k => off.has(k));
    const a = parseDayKey(ds[0]), b = parseDayKey(ds[3]);
    return `<div class="sum-row" style="align-items:center;"><span style="flex:1;font-weight:800;">${a.getMonth() + 1}/${a.getDate()}〜${b.getMonth() + 1}/${b.getDate()} の週${allOff ? '（休み）' : ''}</span>
      <button class="mini ${allOff ? '' : 'del'}" data-act="sched-week" data-days="${wk}" data-off="${allOff ? 1 : 0}">${allOff ? '講座ありにもどす' : '週ごと休みにする'}</button></div>`; }).join('');
  const evRows = sc.draft.events.filter(e => e.day.slice(0, 7) === sc.month).sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time))
    .map(e => `<div class="sum-row" style="align-items:center;"><span style="flex:1;">${fmtDay(parseDayKey(e.day))} ${esc(e.time)}<br><b>${esc(e.label)}（${e.min}分）</b></span><button class="mini del" data-act="sched-ev-del" data-k="${esc(e.day + '|' + e.time + '|' + e.label)}">消す</button></div>`).join('');
  const dayOpts = Array.from({ length: dim }, (_, i) => new Date(y, m - 1, i + 1)).filter(d => LESSON_DOWS.includes(d.getDay()))
    .map(d => `<option value="${dayKeyOf(d)}" ${sc.form.day === dayKeyOf(d) ? 'selected' : ''}>${fmtDay(d)}</option>`).join('');
  const timeOpts = ADMIN_TIMES.map(t => `<option ${sc.form.time === t ? 'selected' : ''}>${t}</option>`).join('');
  const sel = 'style="font-size:20px;padding:12px;border:2px solid #B9C6BE;border-radius:12px;font-family:inherit;width:100%;margin-bottom:10px;background:#fff;"';

  return `<h1>講座カレンダー</h1>
  <div class="card">
    <div class="cal-head"><button class="nav" data-act="sched-month" data-d="-1" ${monthDiff(addMonths(cur, -2), sc.month) <= 0 ? 'disabled' : ''}>‹</button>
      <div class="ttl">${y}年${m}月</div><button class="nav" data-act="sched-month" data-d="1" ${monthDiff(sc.month, addMonths(cur, 12)) <= 0 ? 'disabled' : ''}>›</button></div>
    <table class="cal"><thead><tr>${DAYS.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    <div class="legend">日にちをおすと、<b>休み ⇄ 講座あり</b>が切りかわります。<br>緑＝グループ講座（水・金）／黄＝個人レッスン（火・木）／灰＝休み</div>
    <div class="${over.length ? 'note' : 'info'}">${esc(advice)}<br><span style="font-weight:600;">火${counts[2]}回・水${counts[3]}回・木${counts[4]}回・金${counts[5]}回</span></div>
    <div style="margin-top:14px;">${weekRows}</div>
  </div>
  <div class="card"><h2 style="color:var(--admin);">生徒さんへの公開</h2>
    <p style="font-weight:800;margin-bottom:10px;">${m}月の日程：${published ? '公開中（生徒さんが予約できます）' : 'まだ公開していません'}</p>
    <button class="btn ${published ? 'quiet' : 'dark'}" data-act="sched-publish">${published ? '公開をとりやめる' : `${m}月の日程を確定して公開する`}</button>
  </div>
  <div class="card"><h2 style="color:var(--admin);">体験会などの特別な予定</h2>
    ${evRows || '<p class="muted">この月の特別な予定はありません。</p>'}
    <p class="muted" style="margin:14px 0 8px;">予定をたす（個人レッスンの日のその時間は、予約できなくなります）</p>
    <select id="evDay" ${sel}><option value="">日にちをえらぶ</option>${dayOpts}</select>
    <select id="evTime" ${sel}>${timeOpts}</select>
    <input class="txt" id="evLabel" type="text" placeholder="例：体験会スマホ" value="${esc(sc.form.label)}" style="font-size:20px;padding:12px;margin-bottom:10px;">
    <select id="evMin" ${sel}>${[45, 50, 90].map(n => `<option value="${n}" ${Number(sc.form.min) === n ? 'selected' : ''}>${n}分</option>`).join('')}</select>
    <button class="btn ghost" data-act="sched-ev-add">この予定をたす</button>
  </div>
  <div class="card"><h2 style="color:var(--admin);">印刷用カレンダー</h2>
    <p class="muted" style="margin-bottom:12px;">保存した内容から、配布用のカレンダーを作ります。ひらいた画面で「印刷」をえらぶと、PDFにもできます。</p>
    <a class="btn ghost" style="text-decoration:none;text-align:center;line-height:40px;" target="_blank" href="calendar.html?m=${sc.month}">${m}月の印刷用カレンダーをひらく</a>
  </div>
  <button class="btn quiet" data-act="sched-back">管理者の画面にもどる</button>`;
}

// ---------- 操作 ----------
function saveUsual(slots) {
  if (!slots.length || S.override || COURSES[me().course].classes) return;
  const tally = {}; slots.forEach(s => { const k = parseDayKey(s.day_key).getDay() + '|' + s.start_time; tally[k] = (tally[k] || 0) + 1; });
  const [dow, time] = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0].split('|');
  baseMe().usual = { dow: Number(dow), time }; persistPerson();
}
function persistPerson() {
  if (S.proxy) { const all = store.get('tr_admin_people', {}); all[S.proxy.name] = { category: S.proxy.category, course: S.proxy.course, klass: S.proxy.klass || null, usual: S.proxy.usual || null }; store.set('tr_admin_people', all); }
  else store.set('tr_profile', S.profile);
}
function resetPicks() { S.override = null; S.pickInit = false; S.picked.clear(); S.pending = null; S.changing = null; S.mode = 'add'; S.pickDay = null; }

async function doReserve(slots) {
  const p = me();
  if (DEMO) { await new Promise(r => setTimeout(r, 700));
    slots.forEach(s => { const cd = classDetails(p, s.klass);
      S.demo.added.push({ event_id: 'demo_' + s.slot_id, slot_id: String(s.slot_id), start: s.iso, class_title: `${cd.category} ${cd.course}` }); });
    return { ok: true }; }
  const byKlass = new Map(); slots.forEach(s => { const k = s.klass || ''; if (!byKlass.has(k)) byKlass.set(k, []); byKlass.get(k).push(s); });
  let last = { ok: true };
  for (const [k, list] of byKlass) {
    last = await post({ action: 'batch_reserve', name: p.name, email: myEmail(), add_to_calendar: !!(myEmail() && S.addToCal),
      slots: list.map(s => String(s.slot_id)), class_details: classDetails(p, k || null), passcode: adminCode() || null,
      id_token: S.proxy ? null : (S.line.idToken || null), line_label: lineLabelFor(p, k || null) });
    if (!last || !last.ok) return last;
  }
  return last;
}
async function doCancel(items, silent) {
  const p = me();
  if (DEMO) { await new Promise(r => setTimeout(r, 700));
    items.forEach(e => { if (String(e.event_id).startsWith('demo_')) S.demo.added = S.demo.added.filter(x => x.event_id !== e.event_id); else S.demo.removed.add(e.event_id); });
    return { ok: true }; }
  return await post({ action: 'batch_cancel', name: p.name, email: myEmail(), event_ids: items.map(e => e.event_id), passcode: adminCode() || null,
    id_token: S.proxy ? null : (S.line.idToken || null), line_label: items.map(rowClassText).filter(Boolean)[0] || '', line_silent: !!silent });
}
async function runPending() {
  const pd = S.pending; if (!pd) return;
  try {
    if (pd.type === 'reserve') {
      busy(true, '予約しています…'); const r = await doReserve(pd.slots);
      if (!r || !r.ok) throw new Error((r && r.message) || '予約できませんでした。');
      saveUsual(pd.slots);
      const lines = pd.slots.map(s => `${fmtDay(parseDayKey(s.day_key))} ${s.start_time}`);
      S.done = { title: '予約できました', lines, note: `クラス：${classText(me())}`, line: r.line || null,
        share: `【スマホ教室TERACO 予約の控え】\n${me().name} さん\n${classText(me())}\n${lines.join('\n')}` };
    } else if (pd.type === 'cancel') {
      busy(true, '取り消しています…'); const r = await doCancel(pd.items);
      if (!r || !r.ok) throw new Error((r && r.message) || '取り消しできませんでした。');
      S.done = { title: '取り消しました', lines: pd.items.map(e => fmtWhen(e.start)), line: r.line || null };
    } else {
      // 変更：先に新しい枠を確保し、取れてから古い予約を消す（失敗しても予約が消えない順番）
      busy(true, '日時を変更しています…'); const r1 = await doReserve([pd.to]);
      if (!r1 || !r1.ok) throw new Error((r1 && r1.message) || '新しい日時を予約できませんでした。いまの予約はそのままです。');
      const r2 = await doCancel([pd.from], true);   // 変更のときは取消のお知らせを送らない（予約のお知らせに含める）
      if (!r2 || !r2.ok) { S.done = { title: '新しい日時は予約できました', lines: [`${fmtDay(parseDayKey(pd.to.day_key))} ${pd.to.start_time}`],
        note: '前の予約の取り消しができませんでした。お手数ですが、お電話でお知らせください。' }; }
      else S.done = { title: '日時を変更しました', lines: [`${fmtDay(parseDayKey(pd.to.day_key))} ${pd.to.start_time}`], note: `前の予約（${fmtWhen(pd.from.start)}）は取り消しました。`, line: r1.line || null };
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
    sessionStorage.setItem('teraco_admin_code', code); S.admin.summary = d.days; busy(false); go('admin-home'); loadAdminNames(); loadAdminStudents();
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
function whoHitsHtml() {
  const a = S.admin; const q = normName(a.query); if (!q) return '';
  const pool = Array.from(new Set(a.students.map(st => st.name).concat(a.names)));
  const hits = pool.filter(n => normName(n).includes(q)).slice(0, 12);
  return `<div class="names">${hits.map(n => `<button data-act="pick-person" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>
    <button class="btn dark" style="margin-top:14px;" data-act="pick-person" data-name="${esc(a.query)}">「${esc(q)}」さんで開く</button>`;
}
// 名前を打っている最中は画面を描き直さない（描き直すと日本語の変換が途中で切れる）。打ち終わってから描き直す
function renderKeepInput() {
  const el = document.activeElement;
  if (el && el.id === 'whoInput') { S.admin.pendingRender = true; return; }
  render();
}
async function loadAdminStudents() {
  try { const d = await post({ action: 'admin_students', passcode: adminCode() });
    S.admin.students = (d.ok ? d.students : []) || []; S.admin.studentsMsg = d.ok ? '' : (/権限/.test(d.message || '') ? '生徒さんの一覧は、Apps Script で authorizeMe を1回実行（承認）すると出ます。' : (d.message || '生徒さんの一覧を読めませんでした'));
  } catch (e) { S.admin.studentsMsg = '生徒さんの一覧を読めませんでした（通信）'; }
  if (S.view === 'admin-home') renderKeepInput();
}

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
  if (!pc) { S.draft = {}; go('ob-course'); }
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
  if (e.target.id === 'whoInput') { S.admin.query = e.target.value; const h = document.getElementById('whoHits'); if (h) h.innerHTML = whoHitsHtml(); }
  if (e.target.id === 'nameInput') S.draft.name = e.target.value;
});
document.addEventListener('change', (e) => { if (e.target.id === 'whoSelect' && e.target.value) pickPerson(e.target.value); });
document.addEventListener('focusout', (e) => { if (e.target.id === 'whoInput' && S.admin.pendingRender) { S.admin.pendingRender = false; setTimeout(() => { if (S.view === 'admin-home' && document.activeElement !== document.getElementById('whoInput')) render(); }, 150); } });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
  if (e.target.id === 'nameInput') { e.preventDefault(); e.target.blur(); return; }   // 変換確定のエンターで登録が進まないよう、キーボードを閉じるだけ
  if (e.target.id === 'passInput') act('admin-do-login', e.target);
});
document.addEventListener('click', (e) => { const el = e.target.closest('[data-act]'); if (el) act(el.dataset.act, el); });

// 選んだコース・クラスを保存してホームへ
function applyClass(klass) {
  const course = S.draft.course; const category = S.draft.category || COURSES[course].cat || 'smartphone';
  if (S.proxy) { Object.assign(S.proxy, { category, course, klass, usual: null }); persistPerson(); }
  else if (S.profile && S.edit === 'class') { Object.assign(S.profile, { category, course, klass, usual: null }); store.set('tr_profile', S.profile); }
  else { S.profile = { name: S.draft.name, category, course, klass, usual: null }; store.set('tr_profile', S.profile); S.loaded = false; }
  S.edit = null; resetPicks(); go('home'); if (!S.loaded) loadData(); lineLink();
}

function schedKeepForm() { const g = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
  if (document.getElementById('evDay')) S.sched.form = { day: g('evDay'), time: g('evTime') || '10:00', label: g('evLabel'), min: Number(g('evMin')) || 45 }; }
async function schedAct(a, d) {
  const sc = S.sched; schedKeepForm();
  if (a === 'sched-month') { sc.month = addMonths(sc.month, Number(d.d)); sc.form.day = ''; return renderKeepScroll(); }
  if (a === 'sched-day') { const i = sc.draft.off.indexOf(d.day); if (i >= 0) sc.draft.off.splice(i, 1); else sc.draft.off.push(d.day); sc.dirty = true; return renderKeepScroll(); }
  if (a === 'sched-week') { const ds = d.days.split(','); const set = new Set(sc.draft.off);
    ds.forEach(k => d.off === '1' ? set.delete(k) : set.add(k)); sc.draft.off = Array.from(set).sort(); sc.dirty = true; return renderKeepScroll(); }
  if (a === 'sched-publish') { const i = sc.draft.published.indexOf(sc.month); if (i >= 0) sc.draft.published.splice(i, 1); else sc.draft.published.push(sc.month); sc.dirty = true; return renderKeepScroll(); }
  if (a === 'sched-ev-add') { const f = sc.form; if (!f.day || !f.label.trim()) { alert('日にちと、予定の名前を入れてください。'); return; }
    sc.draft.events.push({ day: f.day, time: f.time, label: f.label.trim(), min: f.min }); sc.form.label = ''; sc.dirty = true; return renderKeepScroll(); }
  if (a === 'sched-ev-del') { sc.draft.events = sc.draft.events.filter(e => (e.day + '|' + e.time + '|' + e.label) !== d.k); sc.dirty = true; return renderKeepScroll(); }
  if (a === 'sched-back') { if (sc.dirty && !confirm('保存していない変更があります。保存せずにもどりますか？')) return; return act('admin-home', document.body); }
  if (a === 'sched-save') {
    // 3か月より前の休みは整理する（保存サイズを小さく保つ）
    const limit = dayKeyOf(new Date(new Date().getFullYear(), new Date().getMonth() - 3, 1));
    const body = { published: sc.draft.published.filter(mk => mk + '-31' >= limit), off: sc.draft.off.filter(k => k >= limit), events: sc.draft.events.filter(e => e.day >= limit) };
    if (DEMO) { applySchedule(body); sc.draft = JSON.parse(JSON.stringify(SCHEDULE)); sc.dirty = false; alert('おためしモードのため、この画面の中だけで反映しました（サーバーには保存していません）。'); return renderKeepScroll(); }
    busy(true, '保存しています…');
    try { const r = await post({ action: 'schedule_set', passcode: adminCode(), schedule: body });
      busy(false); if (!r || !r.ok) { alert((r && r.message) || '保存できませんでした。'); return; }
      applySchedule(r.schedule); sc.draft = JSON.parse(JSON.stringify(SCHEDULE)); sc.dirty = false; S.loaded = false; alert('保存しました。生徒さんの予約画面に反映されます。'); renderKeepScroll();
    } catch (e) { busy(false); alert('通信できませんでした。もう一度ためしてください。'); }
  }
}
function renderKeepScroll() { const y = window.scrollY; render(); window.scrollTo(0, y); }
function goHomeNext() { S.view = S.override ? 'extra' : 'reserve'; render(); const el = document.getElementById('next'); if (el) el.scrollIntoView(); }

function act(a, el) {
  const d = el.dataset || {};
  if (a === 'home') { S.edit = null; S.editRsv = false; resetPicks(); if (isAdmin() && !S.proxy) return go('admin-home'); return go(me() && me().course ? 'home' : 'ob-name'); }
  if (a === 'restart') { S.edit = null; S.editRsv = false; resetPicks(); if (isAdmin() && !S.proxy) return go('admin-home'); if (!(me() && me().course)) return go('ob-name'); S.viewMonth = firstBookableMonth(); return go('reserve'); }
  if (a === 'reserve') { S.editRsv = false; resetPicks(); S.viewMonth = firstBookableMonth(); return go('reserve'); }
  if (a === 'edit-rsv') { S.editRsv = !S.editRsv; return renderKeepScroll(); }
  if (a === 'name-next') { const n = normName((document.getElementById('nameInput') || {}).value); if (!n) { alert('お名前を入れてください。'); return; }
    S.draft.name = n; return go('ob-name-confirm'); }
  if (a === 'name-ok') {
    if (S.edit === 'name') { S.profile.name = S.draft.name; store.set('tr_profile', S.profile); S.edit = null; S.loaded = false; S.existing = []; resetPicks(); go('home'); return loadData(); }
    return go('ob-course'); }
  if (a === 'ob-back-name') return go('ob-name');
  if (a === 'cat') { S.draft.category = d.v; return applyClass(null); }
  if (a === 'ob-course-back') return go('ob-course');
  if (a === 'course') { S.draft.course = d.v; S.draft.category = COURSES[d.v].cat; return go(COURSES[d.v].classes ? 'ob-class' : 'ob-cat'); }
  if (a === 'klass') return applyClass(d.v);
  if (a === 'edit-class') { S.edit = 'class'; S.draft = {}; return go('ob-course'); }
  if (a === 'reset-all') { if (!confirm('お名前とクラスの登録を消して、最初からやりなおします。よろしいですか？\n（入っている予約は消えません）')) return;
    try { Object.keys(localStorage).filter(k => k === 'tr_profile' || k.indexOf('tr_cache_') === 0).forEach(k => localStorage.removeItem(k)); } catch (e) {}
    S.profile = null; S.loaded = false; S.existing = []; S.slots = []; resetPicks(); S.draft = {}; go('ob-name'); return prefetchSlots(); }
  if (a === 'more') return go('more');
  if (a === 'my-history') return loadMyHistory(Number(d.m) || 3);
  if (a === 'toggle-cal') { S.addToCal = !S.addToCal; store.set('tr_add_to_cal', S.addToCal); return renderKeepScroll(); }
  if (a === 'g-logout') { S.google = null; S.myHistory = null; try { localStorage.removeItem('teraco_google_user'); } catch (e) {} return renderKeepScroll(); }
  if (a === 'extra-private') { resetPicks(); S.override = { course: 'private', klass: null, usual: null }; S.pickInit = true; S.viewMonth = firstBookableMonth(); return go('extra'); }
  if (a === 'edit-name') { S.edit = 'name'; S.draft = { name: S.profile.name }; return go('ob-name'); }

  if (a === 'month') { S.viewMonth = addMonths(S.viewMonth, Number(d.d)); return renderKeepScroll(); }
  if (a === 'day') { S.pickDay = d.day; const date = parseDayKey(d.day); const list = slotsForDay(d.day);
    const open = list.filter(x => slotState(x) === 'open');
    if (!isAdmin() && withinDeadline(date) && list.length === 1 && open.length === 1) return act('time', { dataset: { id: open[0].slot_id } });
    return go('times'); }
  if (a === 'back-cal') return S.mode === 'change' ? go('calendar') : goHomeNext();
  if (a === 'toggle-slot') { S.pickDay = d.day; return act('time', { dataset: { id: d.id } }); }
  if (a === 'time') { const slot = slotsForDay(S.pickDay).find(x => String(x.slot_id) === String(d.id)) || S.picked.get(String(d.id)); if (!slot) return;
    if (S.mode === 'change') { S.pending = { type: 'change', from: S.changing, to: slot }; return go('confirm'); }
    const id = String(slot.slot_id);
    if (S.picked.has(id)) S.picked.delete(id);
    else { if (!isAdmin() && monthCount(slot.month_key) + 1 > MONTHLY_LIMIT) { alert(`${Number(slot.month_key.split('-')[1])}月の予約は${MONTHLY_LIMIT}回までです。`); return; } S.picked.set(id, slot); }
    return (S.view === 'reserve' || S.view === 'extra') ? renderKeepScroll() : goHomeNext(); }
  if (a === 'to-confirm-picked') { const slots = Array.from(S.picked.values()).sort((x, y) => Number(x.slot_id) - Number(y.slot_id)); S.pending = { type: 'reserve', slots }; return go('confirm'); }
  if (a === 'change') { const e = S.existing.find(x => x.event_id === d.id); if (!e) return; S.mode = 'change'; S.changing = e; S.picked.clear(); S.viewMonth = monthKeyOf(new Date(e.start)); return go('calendar'); }
  if (a === 'cancel') { const e = S.existing.find(x => x.event_id === d.id); if (!e) return; S.pending = { type: 'cancel', items: [e] }; return go('confirm'); }
  if (a === 'cancel-past') { const e = (Array.isArray(S.admin.history) ? S.admin.history : []).find(x => x.event_id === d.id); if (!e) return; S.pending = { type: 'cancel', items: [e] }; return go('confirm'); }
  if (a === 'cancel-pending') { const t = S.pending && S.pending.type; S.pending = null; if (t === 'change') return go('calendar'); if (t === 'cancel') { resetPicks(); return go('home'); } return go(S.override ? 'extra' : 'reserve'); }
  if (a === 'do') return runPending();
  if (a === 'history') { S.admin.historyMonths = Number(d.m) || 3; return loadHistory(); }

  if (a === 'admin-login') return go('admin-login');
  if (a === 'admin-do-login') { const c = (document.getElementById('passInput') || {}).value; if (c) adminLogin(c.trim()); return; }
  if (a === 'admin-home') { S.proxy = null; resetPicks(); S.loaded = false; go('admin-home');
    getJson({ action: 'admin_summary', passcode: adminCode() }).then(x => { if (x.ok) { S.admin.summary = x.days; if (S.view === 'admin-home') renderKeepInput(); } }).catch(() => {});
    if (!S.admin.names.length) loadAdminNames(); if (!S.admin.students.length) loadAdminStudents(); return; }
  if (a === 'pick-person') return pickPerson(d.name);
  if (a === 'admin-schedule') { schedInit(); return go('admin-schedule'); }
  if (a && a.indexOf('sched-') === 0) return schedAct(a, d);
  if (a === 'admin-logout') { sessionStorage.removeItem('teraco_admin_code'); S.proxy = null; resetPicks(); S.loaded = false; S.existing = [];
    if (S.profile && S.profile.course) { go('home'); loadData(); } else go('ob-name'); return; }
}

// ---------- 起動 ----------
(function start() {
  lineInit();
  if (S.profile && OLD_COURSE_KEYS[S.profile.course]) { S.profile.course = OLD_COURSE_KEYS[S.profile.course]; S.profile.usual = null; store.set('tr_profile', S.profile); }
  if (isAdmin()) { act('admin-home', document.body); return; }
  const c = S.profile && COURSES[S.profile.course];
  if (S.profile && S.profile.name && c && (!c.classes || S.profile.klass)) { S.view = 'home'; loadData(); }
  else if (S.profile && S.profile.name && c) { S.edit = 'class'; S.draft = { category: c.cat, course: S.profile.course }; go('ob-class'); prefetchSlots(); }
  else { S.draft = { name: (S.profile && S.profile.name) || normName(S.google && S.google.name) || '' }; go('ob-name'); prefetchSlots(); }
})();
