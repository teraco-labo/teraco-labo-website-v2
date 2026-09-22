const API_BASE = 'https://script.google.com/macros/s/AKfycbz2_NXN-VuAo2iCFu-jQ-nT5k9Bk3eCoIYBGXAtfDtneNJS7La8vLxS5T7p4Xo3iUIy/exec';

const nameInput = document.getElementById('nameInput');
const calendarWrap = document.getElementById('calendarWrap');
const selectedList = document.getElementById('selectedList');
const existingPanel = document.getElementById('existingPanel');
const existingList = document.getElementById('existingList');
const messageEl = document.getElementById('message');
const btnSubmit = document.getElementById('btnSubmit');
const btnClear = document.getElementById('btnClear');
const btnRefresh = document.getElementById('btnRefresh');
const btnCheckReservation = document.getElementById('btnCheckReservation');
const nameError = document.getElementById('nameError');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');
const syncBar = document.getElementById('syncBar');

function setLoading(isLoading, text) {
  if (isLoading) {
    loadingText.textContent = text || '処理中です...';
    loadingOverlay.classList.add('visible');
  } else {
    loadingOverlay.classList.remove('visible');
  }
}

function setSyncBar(visible, text) {
  if (visible) {
    syncBar.textContent = text || '予約状況を更新中...';
    syncBar.classList.add('visible');
  } else {
    syncBar.classList.remove('visible');
  }
}

const state = {
  displayName: '',
  normalizedName: '',
  months: [],
  monthMap: new Map(),
  slots: [],
  slotIndex: new Map(),
  daySlots: new Map(),
  existing: [],
  existingSet: new Set(),
  existingByDay: new Map(),
  selected: new Map(),
  activeDay: null,
  loading: false,
  classSelection: {
    category: 'smartphone', // smartphone | pc_ai
    course: 'intro'         // intro | applied | basic | advance | private
  },
  googleUser: null // Store Google User Info
};

// Global callback for Google Sign-In
window.handleCredentialResponse = function (response) {
  try {
    const responsePayload = decodeJwtResponse(response.credential);

    const user = {
      sub: responsePayload.sub,
      name: responsePayload.name,
      email: responsePayload.email,
      picture: responsePayload.picture
    };

    // Save to session
    setGoogleUser(user);

    // Trigger check
    loadOverview({ preserveSelection: true });

  } catch (e) {
    console.error("Error handling Google credential", e);
  }
};

function setGoogleUser(user) {
  state.googleUser = user;
  const wrapper = document.getElementById('googleBtnWrapper');

  if (user) {
    // Save to localStorage
    localStorage.setItem('teraco_google_user', JSON.stringify(user));

    // Auto-fill name and lock input
    nameInput.value = user.name;
    nameInput.disabled = true;
    state.displayName = user.name;

    // Show Profile
    wrapper.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:8px;background:#f1f8e9;border-radius:4px;border:1px solid #c5e1a5;">
        <img src="${user.picture}" style="width:32px;height:32px;border-radius:50%;">
        <div style="flex:1;">
          <div style="font-weight:bold;font-size:14px;">${user.name}</div>
          <div style="font-size:12px;color:#666;">${user.email}</div>
        </div>
        <button onclick="signOut()" style="background:none;border:none;color:#666;cursor:pointer;font-size:12px;text-decoration:underline;">ログアウト</button>
      </div>
    `;

    // Show Calendar Option
    document.getElementById('calendarOption').style.display = 'block';
    document.getElementById('addToCalendar').checked = true;

  } else {
    // Logout / Initial State
    // Restore original Google Button HTML
    // We need to re-render the button using GSI API if possible, or just reload page.
    // Since we reload page on signOut, this block is mostly for initial state if we were to do it dynamically.
    // But wait, if we reload, the HTML in index.html is used, which IS the button.
    // So we don't need to manually restore HTML here if we reload.
    // However, if we want to support dynamic switch without reload, we need to put back the div.

    // For now, signOut does location.reload(), so index.html's default button will show.
    // If the user request implies it's NOT showing, maybe it's because we are overwriting it somewhere else?
    // No, index.html has the button by default.

    // Let's ensure signOut clears everything and reloads.
    document.getElementById('calendarOption').style.display = 'none';
    document.getElementById('addToCalendar').checked = false;
  }
}

window.signOut = function () {
  state.googleUser = null;
  state.displayName = '';
  nameInput.value = '';
  nameInput.disabled = false;

  localStorage.removeItem('teraco_google_user');

  // Reload page to reset button and state completely
  location.reload();
};

function checkSavedSession() {
  const saved = localStorage.getItem('teraco_google_user');
  if (saved) {
    try {
      const user = JSON.parse(saved);
      setGoogleUser(user);
    } catch (e) {
      console.error("Failed to restore session", e);
      localStorage.removeItem('teraco_google_user');
    }
  }
}

function decodeJwtResponse(token) {
  var base64Url = token.split('.')[1];
  var base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  var jsonPayload = decodeURIComponent(window.atob(base64).split('').map(function (c) {
    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
  }).join(''));

  return JSON.parse(jsonPayload);
}

let overviewTimer = null;
/// コース・曜日別の予約可能時間
// 個人レッスン: 火(2)・木(4) = 1時間おき10〜17時（それ以外は選択不可）
// その他コース: 水(3)・金(5) = 10:00/14:00/16:00 の3択のみ
const TIMES_PRIVATE_FULL  = ['10:00', '11:00', '14:00', '15:00', '16:00', '17:00']; // 個人レッスン 火木
const TIMES_PRIVATE_SHORT = ['17:00'];                                                // 個人レッスン（現在未使用）
const TIMES_GROUP         = ['10:00', '14:00', '16:00'];                              // その他コース 水金
const ADMIN_TIMES         = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'];

// モック用スーパーセット（コース変更に対応できるよう全時間帯を保持）
const TIMES_MOCK_FULL  = ['10:00', '11:00', '14:00', '15:00', '16:00', '17:00']; // 月火木
const TIMES_MOCK_SHORT = ['10:00', '14:00', '16:00', '17:00'];                    // 水金

function getTimesForCourseAndDay(course, dayOfWeek, isAdmin) {
  if (isAdmin) return ADMIN_TIMES;
  if (course === 'private') {
    if ([2, 4].includes(dayOfWeek)) return TIMES_PRIVATE_FULL; // 火・木のみ
    return [];
  } else {
    // intro / applied / basic / advance
    if ([3, 5].includes(dayOfWeek)) return TIMES_GROUP;
    return [];
  }
}

// 後方互換のため残す（buildMockSlots内で使用）
function getTimesForDayOfWeek(dayOfWeek, isAdmin) {
  if (isAdmin) return ADMIN_TIMES;
  if ([1, 2, 4].includes(dayOfWeek)) return TIMES_MOCK_FULL;
  if ([3, 5].includes(dayOfWeek)) return TIMES_MOCK_SHORT;
  return [];
}

// --- 特別な予約不可日時 ---
// 個別の予定により、特定の日付・時間帯だけ予約を止めたいときにここへ追加する。
// match(startTime) が true の枠を予約不可にし、ホバー時に reason を表示する。
// 例: 2026-08-07 の午前中（12:00より前）は出張のため予約不可
const BLOCKED_SLOTS = [
  { day: '2026-08-07', reason: '出張のため予約できません（午前）', match: (t) => t < '12:00' }
];

// 指定の日付キー・開始時刻が予約不可なら理由文字列を、そうでなければ null を返す
function getBlockReason(dayKey, startTime) {
  for (const rule of BLOCKED_SLOTS) {
    if (rule.day === dayKey && rule.match(startTime)) return rule.reason;
  }
  return null;
}

// --- Initialization ---

// Class Selection Logic
function initClassSelection() {
  // Category
  document.querySelectorAll('#categoryGroup .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // Update UI
      document.querySelectorAll('#categoryGroup .toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Update State
      const val = btn.dataset.value;
      state.classSelection.category = val;

      // Toggle Course Options
      const smGroup = document.getElementById('courseSmartphone');
      const pcGroup = document.getElementById('coursePcAi');

      if (val === 'smartphone') {
        smGroup.classList.remove('hidden');
        pcGroup.classList.add('hidden');
        // Set default course for smartphone
        updateCourseSelection('intro');
        updateToggleUI(smGroup, 'intro');
      } else {
        smGroup.classList.add('hidden');
        pcGroup.classList.remove('hidden');
        // Set default course for pc_ai
        updateCourseSelection('basic');
        updateToggleUI(pcGroup, 'basic');
      }
    });
  });

  // Course (Smartphone)
  document.querySelectorAll('#courseSmartphone .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      updateToggleUI(document.getElementById('courseSmartphone'), btn.dataset.value);
      updateCourseSelection(btn.dataset.value);
      renderAll();
    });
  });

  // Course (PC/AI)
  document.querySelectorAll('#coursePcAi .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      updateToggleUI(document.getElementById('coursePcAi'), btn.dataset.value);
      updateCourseSelection(btn.dataset.value);
      renderAll();
    });
  });

}

function updateToggleUI(group, value) {
  group.querySelectorAll('.toggle-btn').forEach(b => {
    if (b.dataset.value === value) b.classList.add('active');
    else b.classList.remove('active');
  });
}

function updateCourseSelection(val) {
  state.classSelection.course = val;
}

initClassSelection();

// Restore name from local storage - REMOVED
// const savedName = localStorage.getItem('teraco_name');
// if (savedName) {
//   nameInput.value = savedName;
//   normalizeNameInput();
// }

nameInput.addEventListener('input', () => {
  normalizeNameInput();
  if (nameInput.value) {
    nameError.style.display = 'none';
  }
});

nameInput.addEventListener('blur', () => {
  normalizeNameInput();
  // if (state.displayName) {
  //   localStorage.setItem('teraco_name', state.displayName);
  // }
});

btnRefresh.addEventListener('click', () => {
  if (confirm('最初からやり直しますか？\n（Googleログイン状態は維持されます）')) {

    // ── 名前のリセット ──
    // Googleログイン中でない場合のみ名前をクリアして編集可能に
    if (!state.googleUser) {
      nameInput.value = '';
      nameInput.disabled = false;
      state.displayName = '';
      state.normalizedName = '';
    }
    // Googleログイン中の場合は名前はそのまま（ログイン情報は維持）

    // ── 選択中の予約枠をクリア ──
    state.selected.clear();

    // ── 予約確認で取得した既存予約リストをクリア ──
    state.existing = [];
    state.existingSet = new Set();
    state.existingByDay = new Map();

    // ── カレンダーの選択状態をリセット ──
    state.activeDay = null;

    // ── 予約確認パネルを非表示に ──
    existingPanel.classList.add('hidden');
    existingList.innerHTML = '';

    // ── 受講履歴パネルも非表示に ──
    const myHistoryPanel = document.getElementById('myHistoryPanel');
    if (myHistoryPanel) {
      myHistoryPanel.classList.add('hidden');
      document.getElementById('myHistoryContent').innerHTML = '';
    }

    // ── 時間パネルを非表示に ──
    const timePanelWrap = document.getElementById('timePanelWrap');
    if (timePanelWrap) {
      timePanelWrap.classList.add('hidden');
      timePanelWrap.innerHTML = '';
    }

    // ── 画面を再描画 ──
    renderAll();
    showMessage('リセットしました。最初からやり直せます。');
  }
});

// ポップアップ外クリックで閉じる
document.addEventListener('click', () => {
  const popup = document.getElementById('timePopup');
  if (popup && !popup.classList.contains('hidden')) {
    closeTimePopup();
    state.activeDay = null;
    renderCalendar();
  }
});

btnClear.addEventListener('click', () => {
  if (confirm('選択した内容をすべて取り消しますか？')) {
    state.selected.clear();
    state.activeDay = null;
    renderAll();
    showMessage('選択をクリアしました。');
  }
});

btnSubmit.addEventListener('click', submitSelection);

btnCheckReservation.addEventListener('click', checkReservations);

function normalizeNameInput() {
  const original = nameInput.value || '';
  const cleaned = original.replace(/\s+/g, '');
  state.displayName = cleaned;
  state.normalizedName = cleaned;
}

function scheduleOverview(force) {
  clearTimeout(overviewTimer);
  overviewTimer = setTimeout(() => loadOverview({ preserveSelection: true }), force ? 50 : 200);
}

async function checkReservations() {
  normalizeNameInput();
  if (!state.displayName) {
    alert('予約を確認するには、まず「STEP 1」でお名前を入力してください。');
    nameInput.focus();
    nameInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  setLoading(true, '予約状況を確認しています...');

  try {
    // Load real data with shorter timeout
    await loadOverview({ preserveSelection: true });

    // 1回の確認で「予約内容の確認」と「受講履歴」を両方表示する
    loadMyHistory();

    if (state.existing.length === 0) {
      existingPanel.classList.add('hidden');
      showMessage('現在、登録されている予約はありません。');
      document.getElementById('myHistoryPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      existingPanel.classList.remove('hidden');
      // Scroll to existing panel
      existingPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      showMessage('予約状況を表示しました。');
    }
  } finally {
    setLoading(false);
  }
}

async function loadOverview({ preserveSelection, silent = false }) {
  // 1. Initialize Slots (Local Mock for Grid)
  if (!state.slots.length) {
    applySlotList(buildMockSlots(60));
  }

  // Render calendar first for better UX
  if (!state.slots[0]?.reserved_count_updated) {
    renderAll();
  }

  // 2. Fetch Data from GAS (POSTで取得 - GETのクエリパラメータがリダイレクトで失われる問題を回避)
  const firstSlot = state.slots[0];
  const isFirstLoad = firstSlot && !firstSlot.reserved_count_updated;
  const TIMEOUT_MS = 30000; // GASコールドスタート対応で30秒

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!silent) {
          setSyncBar(true, attempt === 0 ? '予約状況を更新中...' : '再試行しています...');
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const res = await fetch(API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({
            action: 'overview',
            name: state.displayName || '',
            days: 60,
            // Googleログインしている場合はメールアドレスも送り、サーバー側で「ゲスト情報」からも紐付けられるようにする
            email: state.googleUser ? state.googleUser.email : null
          }),
          signal: controller.signal,
          mode: 'cors',
          cache: 'no-cache',
          redirect: 'follow'
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          throw new Error('サーバーが一時的に応答していません。');
        }

        const data = await res.json();
        console.log('📥 サーバーからのレスポンス:', data);

        if (data.existing) {
          state.existing = data.existing;
          state.existingSet = new Set(state.existing.map(e => e.slot_id));

          state.existingByDay = new Map();
          state.existing.forEach(ev => {
            const slot = state.slotIndex.get(ev.slot_id);
            const dayKey = slot ? slot.day_key : (ev.start ? ev.start.slice(0, 10) : '');
            if (!dayKey) return;
            state.existingByDay.set(dayKey, (state.existingByDay.get(dayKey) || 0) + 1);
          });
        }

        if (data.slots && Array.isArray(data.slots)) {
          applySlotList(data.slots);
        }
        break;
      } catch (e) {
        console.error("Failed to fetch reservations (attempt " + (attempt + 1) + "):", e);
        if (e.name === 'AbortError' && attempt === 0) {
          await new Promise(r => setTimeout(r, 2000));
          continue;
        }
        if (e.name === 'AbortError') {
          showMessage('接続がタイムアウトしました。しばらく待ってからもう一度お試しください。');
        } else {
          showMessage('予約データの読み込みに失敗しました。電波の良い場所で再度お試しいただくか、しばらくお待ちください。');
        }
        break;
      }
    }
  } finally {
    setLoading(false);
    setSyncBar(false);
  }

  renderAll();
}

function applySlotList(slots) {
  let list = Array.isArray(slots) ? slots : [];
  const isAdmin = !!sessionStorage.getItem('teraco_admin_code');

  if (isAdmin) {
    // 管理者は過去〜未来いつでも予約できるよう、広い範囲の枠を用意し、
    // サーバーから来た予約数(reserved_count)を同じ枠(slot_id)に重ねる。
    const base = buildMockSlots(ADMIN_SLOT_RANGE_DAYS * 2 + 1, {
      ignoreTimeFilter: true,
      startOffsetDays: -ADMIN_SLOT_RANGE_DAYS
    });
    const byId = new Map(base.map(s => [s.slot_id, s]));
    list.forEach(s => {
      const existing = byId.get(s.slot_id);
      if (existing) {
        existing.reserved_count = s.reserved_count;
        existing.capacity = s.capacity;
        if (s.label) existing.label = s.label;
      } else {
        byId.set(s.slot_id, s); // サーバーにしかない枠も保持
      }
    });
    list = Array.from(byId.values());
  } else if (!list.length) {
    list = buildMockSlots(60);
  }

  state.slots = list;
  state.slotIndex = new Map(state.slots.map(slot => [slot.slot_id, slot]));
  state.daySlots = new Map();
  state.slots.forEach(slot => {
    if (!state.daySlots.has(slot.day_key)) state.daySlots.set(slot.day_key, []);
    state.daySlots.get(slot.day_key).push(slot);
  });
}

function renderAll() {
  renderCalendar();
  renderSelected();
  renderExisting();
}

function renderCurrentDate() {
  const el = document.getElementById('current-date-display');
  if (!el) return;
  const today = new Date();
  const seconds = today.getSeconds();
  const colonVisible = (seconds % 2 === 0); // true for visible, false for hidden

  const datePart = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日(${['日', '月', '火', '水', '木', '金', '土'][today.getDay()]})`;
  const hours = String(today.getHours()).padStart(2, '0');
  const minutes = String(today.getMinutes()).padStart(2, '0');

  el.innerHTML = `現在日時: ${datePart} ${hours}<span style="visibility: ${colonVisible ? 'visible' : 'hidden'};">:</span>${minutes}`;
}

// --- 月ナビゲーション用ヘルパー ---
function monthKeyOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
function currentMonthKey() {
  return monthKeyOf(new Date());
}
// monthKey に delta ヶ月を加えた月キーを返す
function addMonths(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  return monthKeyOf(new Date(y, m - 1 + delta, 1));
}
// a から b までの月数（b が未来なら正）
function monthDiff(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}
const CAL_RANGE_MONTHS = 6;          // 一般利用者：当月から前後に表示できる範囲（月）
const CAL_RANGE_MONTHS_ADMIN = 12;   // 管理者：前後に表示できる範囲（月）
const ADMIN_SLOT_RANGE_DAYS = 400;   // 管理者：枠を生成する前後の日数（約13ヶ月）

// 現在の表示可能範囲（管理者ログイン中は広い）
function calRangeMonths() {
  return sessionStorage.getItem('teraco_admin_code') ? CAL_RANGE_MONTHS_ADMIN : CAL_RANGE_MONTHS;
}

function renderCalendar() {
  if (!state.slots.length) {
    applySlotList(buildMockSlots(60));
  }

  // 表示月の初期値は当月
  if (!state.viewMonth) state.viewMonth = currentMonthKey();

  calendarWrap.innerHTML = '';
  calendarWrap.appendChild(buildMonthCalendar(state.viewMonth));

  renderTimePanel();
}

// 表示月を delta ヶ月ずらす（前後 CAL_RANGE_MONTHS の範囲でクランプ）
function navigateMonth(delta) {
  const cur = currentMonthKey();
  const range = calRangeMonths();
  const minMonth = addMonths(cur, -range);
  const maxMonth = addMonths(cur, range);
  const target = addMonths(state.viewMonth, delta);
  if (monthDiff(minMonth, target) < 0 || monthDiff(target, maxMonth) < 0) return; // 範囲外は無視
  closeTimePopup();
  state.activeDay = null;
  state.viewMonth = target;
  renderCalendar();
}

// 日付マスの右下に予約人数バッジを表示する（0人や未定義は表示しない）
function appendDayCount(cell, count) {
  if (!count || count <= 0) return;
  const badge = document.createElement('span');
  badge.className = 'day-count';
  badge.textContent = `${count}人`;
  badge.title = `予約 ${count}人`;
  cell.appendChild(badge);
}

function buildMonthCalendar(monthKey) {
  const [yearStr, monthStr] = monthKey.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr) - 1;
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const wrapper = document.createElement('div');
  wrapper.className = 'calendar';

  // ヘッダー：‹ 前月  YYYY年M月  翌月 › の月ナビゲーション
  const cur = currentMonthKey();
  const range = calRangeMonths();
  const minMonth = addMonths(cur, -range);
  const maxMonth = addMonths(cur, range);

  const header = document.createElement('header');
  header.className = 'cal-header';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'cal-nav';
  prevBtn.textContent = '‹';
  prevBtn.setAttribute('aria-label', '前の月');
  prevBtn.disabled = monthDiff(minMonth, monthKey) <= 0; // これ以上過去へ行けない
  prevBtn.addEventListener('click', (e) => { e.stopPropagation(); navigateMonth(-1); });

  const title = document.createElement('span');
  title.className = 'cal-title';
  title.textContent = `${year}年${month + 1}月`;

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'cal-nav';
  nextBtn.textContent = '›';
  nextBtn.setAttribute('aria-label', '次の月');
  nextBtn.disabled = monthDiff(monthKey, maxMonth) <= 0; // これ以上未来へ行けない
  nextBtn.addEventListener('click', (e) => { e.stopPropagation(); navigateMonth(1); });

  header.append(prevBtn, title, nextBtn);
  wrapper.appendChild(header);

  const table = document.createElement('table');
  table.className = 'month-grid';
  table.innerHTML = `
    <thead>
      <tr><th>日</th><th>月</th><th>火</th><th>水</th><th>木</th><th>金</th><th>土</th></tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');
  let row = document.createElement('tr');

  for (let i = 0; i < first.getDay(); i++) {
    row.appendChild(Object.assign(document.createElement('td'), { className: 'disabled' }));
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let day = 1; day <= daysInMonth; day++) {
    if (row.children.length === 7) { tbody.appendChild(row); row = document.createElement('tr'); }

    const date = new Date(year, month, day);
    const dayKey = formatDayKey(date);
    const dayOfWeek = date.getDay();
    const cell = document.createElement('td');
    cell.textContent = String(day);

    const slots = state.daySlots.get(dayKey) || [];
    const hasReservation = state.existing.some(ev => (state.slotIndex.get(ev.slot_id)?.day_key || ev.start?.slice(0, 10)) === dayKey);
    const hasSelected = Array.from(state.selected.values()).some(s => s.day_key === dayKey);

    // 管理者ログイン中はすべての日付にアクセス可能
    const isAdmin = !!sessionStorage.getItem('teraco_admin_code');
    const isToday = !isAdmin && date.getTime() === today.getTime();
    if (!isAdmin) {
      // 過去（昨日以前）は完全に無効。当日は予約不可だが人数確認のため下で処理する
      if (date < today) { cell.classList.add('disabled'); row.appendChild(cell); continue; }
      // 土日
      if (dayOfWeek === 0 || dayOfWeek === 6) { cell.classList.add('disabled'); row.appendChild(cell); continue; }
      // コース別曜日制限
      const course = state.classSelection.course;
      if (course === 'private') {
        // 個人レッスン: 火(2)・木(4) のみ
        if (![2, 4].includes(dayOfWeek)) { cell.classList.add('disabled'); row.appendChild(cell); continue; }
      } else {
        // その他コース: 水(3)・金(5) のみ
        if (![3, 5].includes(dayOfWeek)) { cell.classList.add('disabled'); row.appendChild(cell); continue; }
      }
      // スロットなし
      if (!slots.length) { cell.classList.add('disabled'); row.appendChild(cell); continue; }
    }

    const { course } = state.classSelection;
    const allowedTimes = getTimesForCourseAndDay(course, dayOfWeek, isAdmin);
    const courseSlots = isAdmin
      ? slots
      : slots.filter(s => allowedTimes.includes(s.start_time) && !getBlockReason(dayKey, s.start_time));
    const hasSelectable = courseSlots.some(s => s.reserved_count < s.capacity && !state.existingSet.has(s.slot_id));

    // その日の合計予約人数（このコースで表示している時間帯の合計）
    const dayReserved = courseSlots.reduce((sum, s) => sum + (Number(s.reserved_count) || 0), 0);

    // 当日：予約は不可だが、タップすると各枠の人数だけ確認できる（ビュー専用）
    if (isToday) {
      cell.classList.add('today-view');
      if (hasReservation) cell.classList.add('has-reservation');
      appendDayCount(cell, dayReserved);
      cell.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasActive = state.activeDay === dayKey;
        closeTimePopup();
        if (!wasActive) {
          const cellRect = cell.getBoundingClientRect();
          state.activeDay = dayKey;
          renderCalendar();
          showTimePopup(dayKey, cellRect);
        } else {
          state.activeDay = null;
          renderCalendar();
        }
      });
      row.appendChild(cell);
      continue;
    }

    if (!hasSelectable && !hasReservation) {
      cell.classList.add('full');
      appendDayCount(cell, dayReserved);
      row.appendChild(cell);
      continue;
    }

    if (state.activeDay === dayKey) cell.classList.add('active');
    if (hasReservation) cell.classList.add('has-reservation');
    if (hasSelected) cell.classList.add('has-selected');

    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasActive = state.activeDay === dayKey;
      closeTimePopup();
      if (!wasActive) {
        // renderCalendar() でDOM再構築される前に座標を取得
        const cellRect = cell.getBoundingClientRect();
        state.activeDay = dayKey;
        renderCalendar();
        showTimePopup(dayKey, cellRect);
      } else {
        state.activeDay = null;
        renderCalendar();
      }
    });

    appendDayCount(cell, dayReserved);
    row.appendChild(cell);
  }

  while (row.children.length > 0 && row.children.length < 7) {
    row.appendChild(Object.assign(document.createElement('td'), { className: 'disabled' }));
  }
  if (row.children.length) tbody.appendChild(row);

  wrapper.appendChild(table);
  return wrapper;
}

function renderTimePanel() {
  // timePanelWrap は使用しない（ポップアップ方式に変更）
  const wrap = document.getElementById('timePanelWrap');
  if (wrap) { wrap.classList.add('hidden'); wrap.innerHTML = ''; }
}

function showTimePopup(dayKey, cellRect) {
  const popup = document.getElementById('timePopup');
  const content = document.getElementById('timePopupContent');
  if (!popup || !content) return;

  const allSlots = state.daySlots.get(dayKey) || [];
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const isAdmin = !!sessionStorage.getItem('teraco_admin_code');
  const { course } = state.classSelection;
  const allowedTimes = getTimesForCourseAndDay(course, date.getDay(), isAdmin);
  const slots = isAdmin ? allSlots : allSlots.filter(s => allowedTimes.includes(s.start_time));
  if (!slots.length) return;
  const _today = new Date(); _today.setHours(0, 0, 0, 0);
  const isToday = !isAdmin && date.getTime() === _today.getTime();
  const DAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const dayLabel = `${m}月${d}日（${DAYS[date.getDay()]}）`;

  content.innerHTML = `<div style="font-weight:700;color:var(--green-deep);margin-bottom:10px;font-size:15px;text-align:center;white-space:nowrap;">${dayLabel}</div>`
    + (isToday ? `<div style="color:#c97b7b;font-size:12px;text-align:center;margin-bottom:8px;line-height:1.4;">本日は予約できません<br>（現在の人数のみ表示）</div>` : '');

  const grid = document.createElement('div');
  grid.className = 'time-btn-grid';

  slots.forEach(slot => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'time-btn';

    const blockReason = isAdmin ? null : getBlockReason(dayKey, slot.start_time);
    const reserved = Number(slot.reserved_count) || 0;
    // 時間ボタンの中身（上＝時刻、下＝状態/人数の小さい行）を組み立てる
    const setBtn = (sub) => {
      btn.innerHTML = sub
        ? `<span class="t-time">${slot.start_time}</span><span class="t-sub">${sub}</span>`
        : `<span class="t-time">${slot.start_time}</span>`;
    };

    if (isToday) {
      // 当日：予約は不可。人数のみ確認できるビュー専用表示
      setBtn(reserved >= slot.capacity ? '満席' : (reserved > 0 ? `${reserved}人` : ''));
      btn.classList.add('time-btn-view');
      btn.disabled = true;
    } else if (blockReason) {
      setBtn('× 予約不可');
      btn.classList.add('time-btn-blocked');
      btn.title = blockReason;                 // PCでカーソルを合わせるとホバー表示
      btn.setAttribute('aria-disabled', 'true');
      btn.addEventListener('click', (e) => {   // タップ時は理由をメッセージ表示
        e.stopPropagation();
        if (messageEl) messageEl.textContent = blockReason;
      });
    } else if (state.existingSet.has(slot.slot_id)) {
      setBtn('✓ 予約済');
      btn.classList.add('time-btn-done');
      btn.disabled = true;
    } else if (state.selected.has(slot.slot_id)) {
      setBtn('✓ 選択中');
      btn.classList.add('time-btn-selected');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        state.selected.delete(slot.slot_id);
        closeTimePopup();
        state.activeDay = null;
        renderAll();
      });
    } else if (reserved >= slot.capacity) {
      setBtn('満席');
      btn.classList.add('time-btn-full');
      btn.disabled = true;
    } else {
      // 予約可能：1人以上のときだけ人数を表示（0人は何も出さない）
      setBtn(reserved > 0 ? `${reserved}人` : '');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTimePopup();
        state.activeDay = null;
        addSlot(slot);
      });
    }

    grid.appendChild(btn);
  });

  content.appendChild(grid);

  // 一時表示して寸法を確定させる
  popup.style.visibility = 'hidden';
  popup.classList.remove('hidden');

  requestAnimationFrame(() => {
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 4;

    let left, top;

    // ① セルの右に収まるか
    if (cellRect.right + margin + pw <= vw - margin) {
      left = cellRect.right + margin;
      top = cellRect.top;
    }
    // ② セルの左に収まるか
    else if (cellRect.left - margin - pw >= margin) {
      left = cellRect.left - margin - pw;
      top = cellRect.top;
    }
    // ③ どちらにも収まらない（スマホ等）→ セル直下・セル中央揃え
    else {
      left = cellRect.left + (cellRect.width - pw) / 2;
      top = cellRect.bottom + margin;
    }

    // 画面端クランプ
    left = Math.max(margin, Math.min(left, vw - pw - margin));
    if (top + ph > vh - margin) top = cellRect.top - ph - margin;
    top = Math.max(margin, top);

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.style.visibility = 'visible';
  });
}

function closeTimePopup() {
  const popup = document.getElementById('timePopup');
  if (popup) popup.classList.add('hidden');
}

function handleDayClick(dayKey, cell) {
  // Deprecated: Logic moved to inline select in buildMonthCalendar
}

function getMonthlyLimit() {
  return 8; // 月の最大予約数（固定）
}

function detectCategory(title) {
  if (!title) return 'unknown';
  if (title.includes('スマホ')) return 'smartphone';
  if (title.includes('パソコン') || title.includes('PC')) return 'pc_ai';
  return 'unknown';
}

function addSlot(slot) {
  const monthKey = slot.month_key;
  const limit = getMonthlyLimit();

  // この月の既存予約数
  const existingInMonth = state.existing.filter(ev => {
    const evSlot = state.slotIndex.get(ev.slot_id);
    return evSlot && evSlot.month_key === monthKey;
  }).length;

  // この月の現在選択中の数
  const selectedInMonth = (countSelectedByMonth()[monthKey] || 0);

  if (existingInMonth + selectedInMonth + 1 > limit) {
    alert(`${monthKey.replace('-', '年')}月の予約上限（${limit}回）に達しています。`);
    return;
  }

  state.selected.set(slot.slot_id, slot);
  renderAll();
  showMessage('追加しました。「予約を確定する」を押してください。');
}

function renderSelected() {
  selectedList.innerHTML = '';
  const sorted = Array.from(state.selected.values()).sort((a, b) => Number(a.slot_id) - Number(b.slot_id));

  if (!sorted.length) {
    selectedList.innerHTML = '<div style="font-size:19px; color:var(--muted); padding:12px 0;">まだ選択されていません。上のカレンダーから日付と時間を選んでください。</div>';
    btnSubmit.disabled = true;
    return;
  }

  const { category, course } = state.classSelection;
  const categoryLabel = category === 'smartphone' ? 'スマホ' : 'パソコンAI';
  let courseLabel = '';
  if (course === 'private') {
    courseLabel = '個人レッスン（50分）';
  } else if (category === 'smartphone') {
    courseLabel = course === 'intro' ? '入門まなび（45分）' : '応用てらこ（90分）';
  } else {
    courseLabel = course === 'basic' ? '基礎ベーシック（45分）' : '実践アドバンス（90分）';
  }

  sorted.forEach(slot => {
    const row = document.createElement('div');
    row.className = 'selected-item';
    row.innerHTML = `
      <div style="flex:1;">
        <div style="font-size:22px; font-weight:700; margin-bottom:4px;">${slot.day_label}</div>
        <div style="font-size:26px; color:var(--green-deep); font-weight:700; margin-bottom:4px;">${slot.start_time}〜</div>
        <div style="font-size:17px; color:#666;">${categoryLabel} / ${courseLabel}</div>
      </div>
    `;

    const btn = document.createElement('button');
    btn.className = 'soft';
    btn.textContent = '取消';
    btn.style.cssText = 'padding:14px 20px; font-size:18px;';
    btn.addEventListener('click', () => {
      state.selected.delete(slot.slot_id);
      renderAll();
    });

    row.appendChild(btn);
    selectedList.appendChild(row);
  });

  btnSubmit.disabled = false;
}

function countSelectedByMonth() {
  const counts = {};
  state.selected.forEach(slot => {
    counts[slot.month_key] = (counts[slot.month_key] || 0) + 1;
  });
  return counts;
}

function renderExisting() {
  existingList.innerHTML = '';
  if (!state.displayName || !state.existing.length) {
    existingPanel.classList.add('hidden');
    return;
  }

  existingPanel.classList.remove('hidden');

  const sortedExisting = state.existing.slice().sort((a, b) => Number(a.slot_id || 0) - Number(b.slot_id || 0));

  sortedExisting.forEach(ev => {
    let displayTitle = ev.label || '';
    if (displayTitle.startsWith('TERACO予約')) {
      displayTitle = '旧形式の予約';
    }

    const row = document.createElement('div');
    row.className = 'selected-item';
    row.style.borderColor = '#ccc';
    row.style.background = '#f9f9f9';
    row.dataset.slotId = ev.slot_id;
    row.dataset.eventId = ev.event_id;

    row.innerHTML = `
      <div style="flex:1;">
        <div style="font-size:22px; font-weight:700; margin-bottom:4px;">${formatDayLabelFromKey(ev.start.slice(0, 10))}</div>
        <div style="font-size:26px; color:#333; font-weight:700; margin-bottom:4px;">
          ${fmtTime_(new Date(ev.start))}〜
        </div>
        <div style="font-size:17px; color:#666;">${displayTitle}</div>
      </div>
    `;

    const btn = document.createElement('button');
    btn.className = 'soft toggle-cancel';
    btn.textContent = '選択';
    btn.style.minWidth = '60px';

    btn.addEventListener('click', () => {
      const isSelected = row.classList.toggle('to-be-cancelled');
      if (isSelected) {
        btn.textContent = '解除';
        btn.style.background = 'var(--error)';
        btn.style.color = '#fff';
        btn.style.borderColor = 'var(--error)';
        row.style.background = '#ffebee';
      } else {
        btn.textContent = '選択';
        btn.style.background = '';
        btn.style.color = '';
        btn.style.borderColor = '';
        row.style.background = '#f9f9f9';
      }
      updateBatchCancelButton();
    });

    row.appendChild(btn);
    existingList.appendChild(row);
  });

  updateBatchCancelButton();
}

function updateBatchCancelButton() {
  const btn = document.getElementById('btnCancelSelected');
  const selectedCount = document.querySelectorAll('.selected-item.to-be-cancelled').length;

  if (selectedCount > 0) {
    btn.textContent = `${selectedCount}件の予約を取り消す`;
    btn.disabled = false;
    btn.style.opacity = '1';
  } else {
    btn.textContent = '取り消す予約を選択してください';
    btn.disabled = true;
    btn.style.opacity = '0.5';
  }
}

// Bind the batch cancel button once (outside render loop or check existence)
// We'll just attach listener here since renderExisting is called repeatedly
// Better to attach to a static element or replace node to clear listeners
// We'll use the ID directly after checking it exists.
document.addEventListener('DOMContentLoaded', () => {
    const btnCancelSelected = document.getElementById('btnCancelSelected');
    if (btnCancelSelected) {
        const newBtn = btnCancelSelected.cloneNode(true);
        btnCancelSelected.parentNode.replaceChild(newBtn, btnCancelSelected);

        newBtn.addEventListener('click', async () => {
        const selectedRows = document.querySelectorAll('.selected-item.to-be-cancelled');
        if (selectedRows.length === 0) return;

        if (!confirm(`${selectedRows.length}件の予約を取り消しますか？`)) return;

        const itemsToCancel = [];
        selectedRows.forEach(row => {
            itemsToCancel.push({
            slot_id: row.dataset.slotId,
            event_id: row.dataset.eventId
            });
        });

        await batchCancelReservations(itemsToCancel);
        });
    }
});

async function submitSelection() {
  // Validate Name
  normalizeNameInput();
  if (!state.displayName) {
    nameError.style.display = 'block';
    nameInput.focus();
    // Scroll to input
    nameInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  if (!state.selected.size) return;

  const count = state.selected.size;

  // Get class selection details
  const { category, course } = state.classSelection;
  const categoryLabel = category === 'smartphone' ? 'スマホ' : 'パソコンAI';
  let courseLabel = '';
  if (course === 'private') {
    courseLabel = '個人レッスン(50分)';
  } else if (category === 'smartphone') {
    courseLabel = course === 'intro' ? '入門まなび(45分)' : '応用てらこ(90分)';
  } else {
    courseLabel = course === 'basic' ? '基礎ベーシック(45分)' : '実践アドバンス(90分)';
  }
  const confirmMsg = `${state.displayName}様\n\n` +
    `【クラス】${categoryLabel} / ${courseLabel}\n\n` +
    `${count}件の予約を確定します。よろしいですか？`;

  if (!confirm(confirmMsg)) return;

  // Save name for next time - REMOVED
  // localStorage.setItem('teraco_name', state.displayName);

  try {
    btnSubmit.disabled = true;
    // showMessage('予約を登録しています…');
    setLoading(true, '予約を登録しています...');

    const addToCalendar = document.getElementById('addToCalendar').checked;

    const selectedSlots = Array.from(state.selected.keys());
    console.log('🔍 予約しようとしているスロット:', selectedSlots);
    console.log('🔍 既存の予約:', Array.from(state.existingSet));
    console.log('🔍 名前:', state.displayName);

    // 管理者ログイン済みならパスコードを送信（締切チェックスキップ用）
    const adminCode = sessionStorage.getItem('teraco_admin_code');
    
    const payload = {
      action: 'batch_reserve',
      name: state.displayName,
      email: state.googleUser ? state.googleUser.email : null, // Send email if logged in
      add_to_calendar: addToCalendar, // User preference
      slots: selectedSlots,
      class_details: {
        category: categoryLabel,
        course: courseLabel
      },
      passcode: adminCode || null // 管理者の場合は締切チェックスキップ
    };

    console.log('📤 送信するペイロード:', payload);

    // Real API Call
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      redirect: 'follow' // Explicitly follow redirects
    });

    // Check response status
    if (!res.ok) {
      console.error('HTTP Error:', res.status, res.statusText);
      alert('申し訳ありません。サーバーが一時的に混み合っているため、予約を登録できませんでした。お手数ですが、少し時間をおいてから再度お試しください。');
      return;
    }

    const data = await res.json();

    console.log('📥 GASからのレスポンス:', data);

    if (!data.ok) {
      console.error('❌ API Error:', data);
      console.error('エラー詳細:', {
        message: data.message,
        existing: data.existing?.length || 0,
        slots: data.slots?.length || 0
      });
      alert(data.message || '予約の登録に失敗しました。');
      return;
    }

    // Success - 即座にUI更新（API待たない）
    state.selected.clear();
    state.activeDay = null;

    // 作成された予約をローカルに追加
    if (data.created) {
      data.created.forEach(ev => {
        state.existing.push(ev);
        state.existingSet.add(ev.slot_id);
      });
    }

    // 即座に画面更新
    renderAll();
    setLoading(false);

    showMessage(data.message || `${count}件の予約を登録しました。`);
    var alertMsg = '予約が完了しました！';
    if (data.calendar_added != null && data.created && data.calendar_added < data.created.length) {
      alertMsg += '\n（Googleカレンダーへの反映が一部のみの場合は、しばらくしてからカレンダーを確認してください）';
    }
    alert(alertMsg);

    // バックグラウンドで最新データを取得（ユーザーを待たせない、ローディング表示なし）
    setTimeout(() => {
      loadOverview({ preserveSelection: false, silent: true }).catch(console.error);
    }, 500);
    return;

  } catch (err) {
    console.error('予約エラー:', err);
    if (err.name === 'AbortError') {
      alert('サーバーへの接続がタイムアウトしました。予約が完了している可能性があるため、ページを再読み込みして確認してください。');
    } else {
      alert('予約の登録に失敗しました。時間をおいて再度お試しください。\nエラー: ' + err.message);
    }
  } finally {
    btnSubmit.disabled = false;
    setLoading(false);
  }
}

async function batchCancelReservations(items) {
  try {
    setLoading(true, '予約を取り消しています...');

    // Use batch_cancel action
    const eventIds = items.map(item => item.event_id);

    // 管理者ログイン済みならパスコードを送信（締切チェックスキップ用）
    const adminCode = sessionStorage.getItem('teraco_admin_code');
    
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'batch_cancel',
        name: state.displayName,
        email: state.googleUser ? state.googleUser.email : null,
        event_ids: eventIds,
        passcode: adminCode || null // 管理者の場合は締切チェックスキップ
      }),
      redirect: 'follow'
    });

    if (!res.ok) {
      console.error('HTTP Error:', res.status, res.statusText);
      const text = await res.text();
      console.error('Response body:', text.substring(0, 500));
      alert(`サーバーエラーが発生しました（ステータス: ${res.status}）`);
      return;
    }

    const data = await res.json();

    if (!data.ok) {
      console.error('API Error:', data);
      alert(data.message || '予約の取り消しに失敗しました。');
      return;
    }

    // 取り消した予約をローカルから削除
    items.forEach(item => {
      state.existingSet.delete(item.slot_id);
      state.existing = state.existing.filter(ev => ev.slot_id !== item.slot_id);
    });

    // 即座に画面更新
    renderAll();
    setLoading(false);

    alert(data.message || '予約を取り消しました。');
    showMessage('予約を取り消しました。');

    // バックグラウンドで最新データを取得（ローディング表示なし）
    setTimeout(() => {
      loadOverview({ preserveSelection: true, silent: true }).catch(console.error);
    }, 500);
    return;

  } catch (err) {
    console.error(err);
    alert('エラーが発生しました。');
  } finally {
    setLoading(false);
  }
}

async function cancelReservation(item) {
  // Deprecated single cancel, redirect to batch
  await batchCancelReservations([item]);
}

function showMessage(text) {
  messageEl.textContent = text || '';
}

function formatDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDayLabelFromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${m}/${d}(${['日', '月', '火', '水', '木', '金', '土'][date.getDay()]})`;
}

function fmtTime_(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function buildMockSlots(days, { ignoreTimeFilter = false, startOffsetDays = 0 } = {}) {
  const slots = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + startOffsetDays); // 過去から生成する場合は負の値
  const now = new Date();
  const isAdmin = !!sessionStorage.getItem('teraco_admin_code');
  for (let i = 0; i < days; i++) {
    const day = new Date(start.getTime());
    day.setDate(day.getDate() + i);
    const dayOfWeek = day.getDay();
    const times = getTimesForDayOfWeek(dayOfWeek, isAdmin);
    const dayKey = formatDayKey(day);
    const dayLabel = formatDayLabelFromKey(dayKey);
    times.forEach(time => {
      const [hh, mm] = time.split(':').map(Number);
      const startTime = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0, 0);
      if (!ignoreTimeFilter && startTime <= now) return;
      const endTime = new Date(startTime.getTime() + 45 * 60 * 1000);
      slots.push({
        slot_id: String(startTime.getTime()),
        iso: startTime.toISOString(),
        day_key: dayKey,
        day_label: dayLabel,
        start_time: time,
        end_time: fmtTime_(endTime),
        month_key: `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}`,
        capacity: 8,
        reserved_count: 0 // Initial mock count, will be overwritten by API
      });
    });
  }
  return slots;
}

// Initial Load
checkSavedSession();
loadOverview({ preserveSelection: false });
renderCurrentDate(); // Initial call
setInterval(renderCurrentDate, 1000);

// --- Admin Dashboard Logic ---

const adminTrigger = document.getElementById('adminTrigger');
const adminPanel = document.getElementById('adminPanel');
const adminLoginView = document.getElementById('adminLoginView');
const adminContentView = document.getElementById('adminContentView');
const adminPasscode = document.getElementById('adminPasscode');
const btnAdminLogin = document.getElementById('btnAdminLogin');
const btnAdminRefresh = document.getElementById('btnAdminRefresh');
const btnAdminLogout = document.getElementById('btnAdminLogout');
const adminSummaryList = document.getElementById('adminSummaryList');

adminTrigger.addEventListener('click', () => {
  console.log('Admin trigger clicked'); // 動作確認用ログ
  if (!adminPanel) {
    console.error('adminPanel not found');
    return;
  }
  adminPanel.classList.toggle('hidden');
  if (!adminPanel.classList.contains('hidden')) {
    adminPanel.scrollIntoView({ behavior: 'smooth' });
    adminPasscode.focus();
  }
});

btnAdminLogin.addEventListener('click', adminLogin);
btnAdminRefresh.addEventListener('click', loadAdminSummary);
btnAdminLogout.addEventListener('click', adminLogout);

async function adminLogin() {
  const code = adminPasscode.value;
  if (!code) return;
  
  setLoading(true, '認証中...');
  try {
    const ok = await loadAdminSummary();
    if (ok) {
      adminLoginView.classList.add('hidden');
      adminContentView.classList.remove('hidden');
      sessionStorage.setItem('teraco_admin_code', code);
      // 管理者は過去〜未来いつでも予約可。全範囲の枠を用意し、サーバーの予約数を重ねて再描画
      state.slots = [];
      state.viewMonth = currentMonthKey();
      await loadOverview({ preserveSelection: true });
    }
  } finally {
    setLoading(false);
  }
}

function adminLogout() {
  sessionStorage.removeItem('teraco_admin_code');
  adminPasscode.value = '';
  adminLoginView.classList.remove('hidden');
  adminContentView.classList.add('hidden');
  // カレンダーを通常表示（前後6ヶ月・未来のみ予約可）に戻す
  state.viewMonth = currentMonthKey();
  applySlotList(buildMockSlots(60));
  renderAll();
}

async function loadAdminSummary() {
  const code = adminPasscode.value || sessionStorage.getItem('teraco_admin_code');
  if (!code) return false;

  try {
    const url = new URL(API_BASE);
    url.searchParams.append('action', 'admin_summary');
    url.searchParams.append('passcode', code);

    const res = await fetch(url.toString());
    const data = await res.json();

    if (!data.ok) {
      alert(data.message || 'エラーが発生しました');
      return false;
    }

    renderAdminSummary(data.days);
    return true;
  } catch (e) {
    console.error(e);
    alert('通信エラーが発生しました');
    return false;
  }
}

function renderAdminSummary(days) {
  adminSummaryList.innerHTML = '';
  
  Object.keys(days).sort().forEach(dayKey => {
    const dayData = days[dayKey];
    const group = document.createElement('div');
    group.className = 'admin-day-group';
    
    group.innerHTML = `<div class="admin-day-label">${dayData.label}</div>`;
    
    dayData.slots.forEach(slot => {
      const item = document.createElement('div');
      item.className = 'admin-slot-item';
      
      const hasReservations = slot.count > 0;
      
      item.innerHTML = `
        <div class="admin-slot-header">
          <span class="admin-slot-time">${slot.time}〜</span>
          <span class="admin-slot-count">${slot.count}名 / 8</span>
        </div>
        <div class="admin-names-list">
          ${hasReservations ? slot.names.join('、') : '<span class="admin-empty-msg">予約なし</span>'}
        </div>
      `;
      group.appendChild(item);
    });
    
    adminSummaryList.appendChild(group);
  });
}

// --- 受講履歴検索 ---

let historyPeriodMonths = 3;    // 管理者側の受講履歴の期間
let myHistoryPeriodMonths = 3;  // 予約者側の受講履歴の期間

// 管理者側の期間ボタン
document.querySelectorAll('#adminHistoryPeriodGroup .history-period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#adminHistoryPeriodGroup .history-period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    historyPeriodMonths = Number(btn.dataset.months);
  });
});

// 予約者側の期間ボタン（押したその場で再取得）
document.querySelectorAll('#myHistoryPeriodGroup .history-period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#myHistoryPeriodGroup .history-period-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    myHistoryPeriodMonths = Number(btn.dataset.months);
    loadMyHistory();
  });
});

document.getElementById('btnHistorySearch').addEventListener('click', searchAttendanceHistory);

/**
 * 「受講履歴（過去）」と「今後の予約」を1回のリクエストでまとめて取得する。
 * 個人情報をURLに載せないため POST を使う。
 */
async function fetchAttendanceData({ name, email, months, passcode }) {
  const res = await fetch(API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      action: 'attendance_history',
      name: name,
      months: months,
      passcode: passcode || null,
      email: email || null
    }),
    mode: 'cors',
    cache: 'no-cache',
    redirect: 'follow'
  });
  if (!res.ok) throw new Error('サーバーが応答していません');
  return await res.json();
}

// 予約者向け：予約確認と一緒に受講履歴を表示する
async function loadMyHistory() {
  const panel = document.getElementById('myHistoryPanel');
  const content = document.getElementById('myHistoryContent');
  if (!panel || !content) return;

  if (!state.displayName) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const adminCode = sessionStorage.getItem('teraco_admin_code');
  const email = state.googleUser ? state.googleUser.email : '';

  // 受講履歴はGoogleログインが必要（管理者はパスコードで免除）
  if (!email && !adminCode) {
    content.innerHTML = `<div style="text-align:center; padding:18px; color:#555; font-size:17px; background:#f5f5f5; border-radius:10px; line-height:1.7;">
      受講履歴を見るには<br><strong>STEP 1 の「Google でログイン」</strong>を押してください。</div>`;
    return;
  }

  content.innerHTML = '<div style="text-align:center; padding:16px; color:#999;">受講履歴を読み込み中...</div>';
  try {
    const data = await fetchAttendanceData({
      name: state.displayName, email: email, months: myHistoryPeriodMonths, passcode: adminCode
    });
    content.innerHTML = '';
    if (!data.ok) {
      content.innerHTML = `<div style="text-align:center; padding:18px; color:#666; font-size:16px;">${data.message || '受講履歴を取得できませんでした。'}</div>`;
      return;
    }
    renderHistoryInto(content, data);
  } catch (e) {
    console.error(e);
    content.innerHTML = '<div style="text-align:center; padding:18px; color:#666; font-size:16px;">受講履歴の取得に失敗しました。電波の良い場所で再度お試しください。</div>';
  }
}

async function searchAttendanceHistory() {
  const name = (document.getElementById('historyNameInput').value || '').trim();
  if (!name) {
    alert('検索したい受講者のお名前を入力してください。');
    document.getElementById('historyNameInput').focus();
    return;
  }

  const code = sessionStorage.getItem('teraco_admin_code');
  if (!code) {
    alert('管理者としてログインしてください。');
    return;
  }

  setLoading(true, '予約と受講履歴を検索しています...');

  try {
    const data = await fetchAttendanceData({ name: name, months: historyPeriodMonths, passcode: code });

    if (!data.ok) {
      alert(data.message || 'エラーが発生しました。');
      return;
    }

    renderAttendanceHistory(data);

  } catch (e) {
    console.error(e);
    alert('通信エラーが発生しました。電波の良い場所で再試行してください。');
  } finally {
    setLoading(false);
  }
}

// 管理者向け：1回の検索で「今後の予約」と「受講履歴」を両方表示
function renderAttendanceHistory(data) {
  const panel = document.getElementById('historyResultPanel');
  const content = document.getElementById('historyResultContent');
  panel.classList.remove('hidden');
  content.innerHTML = '';

  renderUpcomingInto(content, data);
  renderHistoryInto(content, data);
}

// 今後の予約（予約内容の確認）を描画
function renderUpcomingInto(content, data) {
  // GAS未再デプロイ（旧版）では upcoming が返らない。誤って「0件」と出さないよう非表示にする
  if (!Array.isArray(data.upcoming)) return;
  const list = data.upcoming;

  const head = document.createElement('div');
  head.style.cssText = 'font-weight:bold; font-size:17px; margin-bottom:4px; padding:12px; background:var(--green-weak); border-radius:8px; color:var(--green-deep);';
  head.textContent = `${data.name}さん ／ 今後の予約：${list.length}件`;
  content.appendChild(head);

  if (!list.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center; padding:14px; color:#999; font-size:15px; margin-bottom:20px;';
    empty.textContent = '今後の予約はありません。';
    content.appendChild(empty);
    return;
  }

  const box = document.createElement('div');
  box.className = 'history-result-month';
  box.style.marginTop = '8px';
  list.forEach(ev => {
    const d = new Date(ev.start);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <span class="history-item-date">${formatDayLabelFromKey(ev.start.slice(0, 10))} ${time}〜</span>
      <span class="history-item-class">${ev.class_title || ev.label || ''}</span>
    `;
    box.appendChild(item);
  });
  content.appendChild(box);
}

// 受講履歴（過去）を月ごとに描画
function renderHistoryInto(content, data) {
  const months = data.period_months || historyPeriodMonths;
  const periodLabel = months === 12 ? '1年' : `${months}ヶ月`;
  const total = data.total || 0;
  const rangeStr = (data.period_start && data.period_end)
    ? `（${data.period_start} 〜 ${data.period_end}）`
    : '';

  // サマリーヘッダー
  const summary = document.createElement('div');
  summary.style.cssText = 'font-weight:bold; font-size:17px; margin:20px 0 4px; padding:12px 12px 8px; background:#f5f5f5; border-radius:8px 8px 0 0; color:#333;';
  summary.textContent = `${data.name}さん ／ 過去${periodLabel}の受講回数：${total}回`;
  content.appendChild(summary);

  // 検索期間の表示
  const rangeEl = document.createElement('div');
  rangeEl.style.cssText = 'font-size:13px; color:#888; padding:0 12px 12px; background:#f5f5f5; border-radius:0 0 8px 8px; margin-bottom:16px;';
  rangeEl.textContent = `検索期間 ${rangeStr}`;
  content.appendChild(rangeEl);

  if (total === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'text-align:center; padding:20px; color:#999; font-size:15px;';
    empty.textContent = `この期間に受講記録はありません。`;
    content.appendChild(empty);
    return;
  }

  // 月ごとにグループ化
  const byMonth = {};
  data.history.forEach(ev => {
    const mk = ev.start.slice(0, 7);
    if (!byMonth[mk]) byMonth[mk] = [];
    byMonth[mk].push(ev);
  });

  // 新しい月順で表示
  Object.keys(byMonth).sort().reverse().forEach(mk => {
    const [y, m] = mk.split('-');
    const monthDiv = document.createElement('div');
    monthDiv.className = 'history-result-month';

    const label = document.createElement('div');
    label.className = 'history-month-label';
    label.textContent = `${y}年${Number(m)}月（${byMonth[mk].length}回）`;
    monthDiv.appendChild(label);

    byMonth[mk].forEach(ev => {
      const d = new Date(ev.start);
      const dateLabel = formatDayLabelFromKey(ev.start.slice(0, 10));
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const classTitle = ev.class_title || ev.label || '';

      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <span class="history-item-date">${dateLabel} ${time}〜</span>
        <span class="history-item-class">${classTitle}</span>
      `;
      monthDiv.appendChild(item);
    });

    content.appendChild(monthDiv);
  });
}

// Restore admin session if exists
if (sessionStorage.getItem('teraco_admin_code')) {
  loadAdminSummary().then(ok => {
    if (ok) {
      adminPanel.classList.remove('hidden');
      adminLoginView.classList.add('hidden');
      adminContentView.classList.remove('hidden');
    }
  });
}
