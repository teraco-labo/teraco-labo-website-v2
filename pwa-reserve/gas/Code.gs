// TERACO予約システム v50 (新デザイン用に next_data / schedule_get / schedule_set を追加。既存の処理は変更なし。分数はコース名の「(45分)」を優先)

var CONFIG = {
  TIMEZONE: 'Asia/Tokyo',
  CALENDAR_ID: 'primary',
  TEACHER_EMAIL: 'fujisaki@teraco-labo.com',
  ADMIN_PASSCODE: '2684', // 管理者画面用のパスコード
  TITLE_PREFIX: 'TERACO予約',
  LOCATION: 'TERACOラボ',
  SLOT_MINUTES: 45,
  CAPACITY: 8,
  FIXED_TIMES: ['10:00', '14:00', '16:00', '18:00'],
  OVERVIEW_DAYS: 60,
  MONTHLY_LIMIT: 8
};

function authorizeMe() {
  var me = Session.getActiveUser().getEmail();
  GmailApp.sendEmail(me, '承認テスト', 'これが届いたら承認完了です');
  Logger.log('承認されました！');
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = p.action || 'overview';
  if (action === 'version') return jsonOut({ok: true, version: 'v50', timestamp: new Date().toISOString()});
  if (action === 'overview') return jsonOut(getOverview(p.name || '', Number(p.days) || CONFIG.OVERVIEW_DAYS));
  if (action === 'schedule_get') return jsonOut({ ok: true, schedule: getSchedule_() });
  if (action === 'admin_summary') return jsonOut(getAdminSummary(p.passcode));
  if (action === 'attendance_history') return jsonOut(getAttendanceHistory(p.passcode, p.name || '', p.email || '', Number(p.months) || 3));
  if (action === 'admin_calendar_events') return jsonOut(getAdminCalendarEvents(p.passcode, p.start || '', p.end || ''));
  if (action === 'admin_customer_reservations') return jsonOut(getAdminCustomerReservations(p.passcode, p.name || '', p.start || '', p.end || ''));
  if (action === 'admin_import_sheet_data') return jsonOut(adminImportSheetData(p.passcode, p.sheet_id || '', p.sheet_name || ''));
  return jsonOut({ok: true});
}

/**
 * 管理者用：期間指定でカレンダー予約一覧を取得
 */
function getAdminCalendarEvents(passcode, startStr, endStr) {
  if (passcode !== CONFIG.ADMIN_PASSCODE) return { ok: false, message: 'パスコードが正しくありません' };
  var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  var start = startStr ? new Date(startStr) : todayStart();
  var end = endStr ? new Date(endStr + 'T23:59:59') : addDays(start, 14);
  var events = cal.getEvents(start, end);
  var result = events.map(function(ev) {
    var names = (ev.getDescription() || '').split('\n').filter(function(l) { return l.trim() && !isJunkLine(l.trim()); });
    return {
      event_id: ev.getId(),
      title: ev.getTitle(),
      start: ev.getStartTime().toISOString(),
      end: ev.getEndTime().toISOString(),
      names: names
    };
  });
  return { ok: true, events: result };
}

/**
 * 管理者用：顧客名で予約一覧を取得
 */
function getAdminCustomerReservations(passcode, name, startStr, endStr) {
  if (passcode !== CONFIG.ADMIN_PASSCODE) return { ok: false, message: 'パスコードが正しくありません' };
  if (!name || !name.trim()) return { ok: false, message: '名前を入力してください' };
  var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  var start = startStr ? new Date(startStr) : todayStart();
  var end = endStr ? new Date(endStr + 'T23:59:59') : addDays(start, 90);
  var reservations = findUserEvents(cal, name.trim(), start, end, '');
  return { ok: true, name: name.trim(), reservations: reservations };
}

/**
 * 管理者用：Googleスプレッドシートの全データを取得
 * @param {string} passcode   管理者パスコード
 * @param {string} sheetId    スプレッドシートのID
 * @param {string} sheetName  シート名（省略時は先頭シート）
 */
function adminImportSheetData(passcode, sheetId, sheetName) {
  if (passcode !== CONFIG.ADMIN_PASSCODE) return { ok: false, message: 'パスコードが正しくありません' };
  if (!sheetId || !sheetId.trim()) return { ok: false, message: 'スプレッドシートIDを指定してください' };
  try {
    var ss = SpreadsheetApp.openById(sheetId.trim());
    var allSheets = ss.getSheets().map(function(s) { return s.getName(); });
    var sheet;
    if (sheetName && sheetName.trim()) {
      sheet = ss.getSheetByName(sheetName.trim());
      if (!sheet) return { ok: false, message: 'シート「' + sheetName + '」が見つかりません', sheets: allSheets };
    } else {
      sheet = ss.getSheets()[0];
    }
    var data = sheet.getDataRange().getValues();
    if (data.length === 0) return { ok: true, headers: [], rows: [], sheets: allSheets, sheet: sheet.getName() };
    var headers = data[0].map(function(h) { return String(h || '').trim(); });
    var rows = data.slice(1).map(function(row) {
      return headers.map(function(h, i) {
        var v = row[i];
        if (v instanceof Date) return Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy/MM/dd');
        return v !== undefined && v !== null ? String(v) : '';
      });
    }).filter(function(row) {
      return row.some(function(cell) { return cell !== ''; });
    });
    return { ok: true, headers: headers, rows: rows, sheets: allSheets, sheet: sheet.getName(), total: rows.length };
  } catch (e) {
    return { ok: false, message: 'スプレッドシートの読み込みに失敗しました: ' + e.toString() };
  }
}

/**
 * 管理者用：今日・明日の予約状況をまとめて取得
 */
function getAdminSummary(passcode) {
  if (passcode !== CONFIG.ADMIN_PASSCODE) return { ok: false, message: 'パスコードが正しくありません' };
  
  var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var end = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000); // 今日・明日の2日間
  
  var events = cal.getEvents(start, end);
  var days = {};
  
  // 2日分の枠を初期化
  for (var i = 0; i < 2; i++) {
    var d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    var key = formatDate(d);
    days[key] = { label: formatDay(d), slots: [] };
    
    CONFIG.FIXED_TIMES.forEach(function(time) {
      days[key].slots.push({ time: time, title: '', count: 0, names: [] });
    });
  }

  events.forEach(function(ev) {
    var st = ev.getStartTime();
    var dayKey = formatDate(st);
    var timeStr = pad(st.getHours()) + ':' + pad(st.getMinutes());
    
    if (days[dayKey]) {
      var names = (ev.getDescription() || '').split('\n').filter(function(l) { 
        return l.trim() && !isJunkLine(l.trim()); 
      });
      
      days[dayKey].slots.forEach(function(slot) {
        if (slot.time === timeStr) {
          slot.title = ev.getTitle();
          slot.count = names.length;
          slot.names = names;
        }
      });
    }
  });

  return { ok: true, days: days };
}

/**
 * 「受講履歴（過去）」と「予約内容の確認（今後）」を1回でまとめて取得
 * - 管理者：パスコードが一致すれば任意の受講者を検索できる
 * - 予約者：Googleログイン（メールアドレス）が必要。未ログインなら履歴は返さない
 * @param {string} passcode  管理者パスコード（予約者は空）
 * @param {string} name      検索する受講者名
 * @param {string} email     Googleログインのメールアドレス（予約者は必須）
 * @param {number} months    遡る月数（1/3/6/12）
 */
function getAttendanceHistory(passcode, name, email, months) {
  var isAdmin = (passcode && passcode === CONFIG.ADMIN_PASSCODE);
  if (!name || !name.trim()) return { ok: false, message: '検索する名前を入力してください' };

  var mail = (email || '').trim();
  // 予約者が受講履歴を見るにはGoogleログインが必要（管理者はパスコードで免除）
  if (!isAdmin && !mail) {
    return { ok: false, need_login: true, message: '受講履歴を見るには、Googleでログインしてください。' };
  }

  var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  var now = new Date();
  var todayS = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var start = new Date(now.getFullYear(), now.getMonth() - months, now.getDate());
  var userName = name.trim();

  // 受講履歴（指定期間前 〜 現在）
  var history = findUserEvents(cal, userName, start, now, mail);
  history.sort(function(a, b) { return new Date(b.start).getTime() - new Date(a.start).getTime(); });

  // 予約内容の確認（現在 〜 120日先）
  var upcoming = findUserEvents(cal, userName, now, addDays(todayS, 120), mail);
  upcoming.sort(function(a, b) { return new Date(a.start).getTime() - new Date(b.start).getTime(); });

  return {
    ok: true,
    name: userName,
    is_admin: !!isAdmin,
    history: history,
    total: history.length,
    upcoming: upcoming,
    upcoming_total: upcoming.length,
    period_months: months,
    period_start: Utilities.formatDate(start, CONFIG.TIMEZONE, 'yyyy/MM/dd'),
    period_end: Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy/MM/dd')
  };
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return jsonOut({ok: false, message: 'JSONエラー'}); }
  if (body.action === 'overview') return jsonOut(getOverview(body.name || '', Number(body.days) || CONFIG.OVERVIEW_DAYS, body.email || ''));
  if (body.action === 'next_data') return jsonOut(getNextData(body.name || '', Number(body.days) || 75, body.email || ''));
  if (body.action === 'schedule_get') return jsonOut({ ok: true, schedule: getSchedule_() });
  if (body.action === 'schedule_set') return jsonOut(setSchedule_(body.passcode, body.schedule));
  if (body.action === 'batch_reserve') return jsonOut(reserve(body.name, body.slots, body.class_details, body.email, body.add_to_calendar, body.passcode));
  if (body.action === 'batch_cancel') return jsonOut(cancel(body.name, body.event_ids, body.email, body.passcode));
  if (body.action === 'attendance_history') return jsonOut(getAttendanceHistory(body.passcode, body.name || '', body.email || '', Number(body.months) || 3));
  return jsonOut({ok: false, message: '不明なアクション'});
}

function getOverview(name, days, email) {
  var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  var start = todayStart();
  var slots = buildSlots(cal, start, days);
  if (!name || !name.trim()) return {ok: true, name: '', slots: slots, existing: [], months: getMonths(start, days)};
  var trimmed = name.trim();
  var end = addDays(start, days + 31);
  var existing = findUserEvents(cal, trimmed, start, end, email || '');
  return { ok: true, name: trimmed, slots: slots, existing: existing, months: getMonthsWithCount(start, days, existing) };
}

function reserve(name, slotIds, classDetails, email, addToCalendar, passcode) {
  if (!name || !name.trim()) return {ok: false, message: 'お名前を入力してください'};
  var userName = name.trim();
  var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return {ok: false, message: 'サーバーが一時的に混み合っています。少し時間をおいてからもう一度お試しください。'};

  try {
    // 管理者チェック: パスコードが正しければ締切チェックをスキップ
    var isAdmin = (passcode && passcode === CONFIG.ADMIN_PASSCODE);
    
    // 予約締切チェック (前日17:00まで) - 管理者の場合はスキップ
    var now = new Date();
    var deadlineLimit = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0, 0); // 今日の17:00
    
    var title = makeTitle(classDetails);
    var minutes = getMinutes(classDetails);
    var created = [];
    var calendarAdded = 0;

    for (var i = 0; i < slotIds.length; i++) {
      var startTime = new Date(Number(slotIds[i]));
      if (isNaN(startTime.getTime())) continue;

      // 管理者でない場合のみ締切チェック
      if (!isAdmin) {
        // 判定: 予約日が明日以降か、または今日が17時前で明日以降の予約か
        var reservationDay = new Date(startTime.getFullYear(), startTime.getMonth(), startTime.getDate());
        var tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        
        if (reservationDay < tomorrow) {
          return {ok: false, message: '当日および過去の予約はできません。前日17:00までにご予約ください。'};
        }
        if (reservationDay.getTime() === tomorrow.getTime() && now > deadlineLimit) {
          return {ok: false, message: '明日の予約締切（本日17:00）を過ぎています。お急ぎの場合は教室へ直接ご連絡ください。'};
        }
      }

      var endTime = new Date(startTime.getTime() + minutes * 60000);
      var existing = findEventAt(cal, startTime, title);
      var eventId = "";

      if (existing) {
        eventId = existing.getId();
        var desc = existing.getDescription() || '';
        if (!hasName(desc, userName)) {
          existing.setDescription(addName(desc, userName, email));
        }
      } else {
        var ev = cal.createEvent(title, startTime, endTime, {
          description: addName('', userName, email),
          location: CONFIG.LOCATION,
          sendInvites: false
        });
        eventId = ev.getId();
      }
      
      // 複数予約でAPI制限を避けるため、2件目以降は少し待ってからゲスト追加（リトライ付き）
      if (addToCalendar && email && eventId) {
        if (i > 0) Utilities.sleep(450);
        var ok = addGuestSilently(eventId, email);
        if (!ok) {
          Utilities.sleep(500);
          ok = addGuestSilently(eventId, email);
        }
        if (ok) calendarAdded++;
      }
      
      created.push({event_id: eventId, slot_id: String(slotIds[i]), start: startTime.toISOString()});
    }

    if (created.length > 0) sendNotification('予約', userName, created, title, email);
    var msg = created.length + '件予約しました';
    if (addToCalendar && email && calendarAdded < created.length && calendarAdded >= 0) {
      msg += '（Googleカレンダー反映: ' + calendarAdded + '/' + created.length + '件）';
    }
    return {ok: true, message: msg, created: created, calendar_added: calendarAdded};
  } finally {
    lock.releaseLock();
  }
}

/**
 * ゲストを「回答待ち」状態でサイレント追加する。
 * 主催者をattendeesに含めて「全員が辞退しました」表示を防ぎ、成功時trueを返す。
 */
function addGuestSilently(eventId, email) {
  try {
    var cleanId = eventId.split('@')[0];
    var event = Calendar.Events.get(CONFIG.CALENDAR_ID, cleanId);
    var attendees = event.attendees ? event.attendees.slice() : [];
    var organizerEmail = event.organizer && event.organizer.email ? event.organizer.email.toLowerCase() : '';

    // 主催者がattendeesにいない場合は先に追加（accepted）→「全員が辞退しました」を防ぐ
    if (organizerEmail && !attendees.some(function(a) { return (a.email || '').toLowerCase() === organizerEmail; })) {
      attendees.push({ email: event.organizer.email, responseStatus: 'accepted' });
    }
    var exists = attendees.some(function(a) { return (a.email || '').toLowerCase() === email.toLowerCase(); });
    if (!exists) {
      attendees.push({ email: email, responseStatus: 'needsAction' });
      Calendar.Events.patch({attendees: attendees}, CONFIG.CALENDAR_ID, cleanId, { sendUpdates: 'none' });
    }
    return true;
  } catch (e) {
    Logger.log('ゲスト追加失敗: ' + eventId + ' - ' + e.toString());
    return false;
  }
}

function cancel(name, eventIds, email, passcode) {
  if (!name || !name.trim()) return {ok: false, message: 'お名前を入力してください'};
  var userName = name.trim();
  var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return {ok: false, message: 'サーバーが一時的に混み合っています。少し時間をおいてからもう一度お試しください。'};

  try {
    // 管理者チェック: パスコードが正しければ締切チェックをスキップ
    var isAdmin = (passcode && passcode === CONFIG.ADMIN_PASSCODE);
    
    var now = new Date();
    var deadlineLimit = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0, 0);
    var removed = [];
    var title = '';
    
    for (var i = 0; i < eventIds.length; i++) {
      var ev = cal.getEventById(eventIds[i]);
      if (!ev) continue;

      var startTime = ev.getStartTime();
      var reservationDay = new Date(startTime.getFullYear(), startTime.getMonth(), startTime.getDate());
      var tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

      // 管理者でない場合のみ締切チェック
      if (!isAdmin) {
        if (reservationDay < tomorrow || (reservationDay.getTime() === tomorrow.getTime() && now > deadlineLimit)) {
          return {ok: false, message: '当日および前日17:00を過ぎたキャンセルの受付はできません。教室へ直接ご連絡ください。'};
        }
      }

      var desc = ev.getDescription() || '';
      // 「名前」または「メールアドレス」のどちらかが一致する予約だけを、このユーザーの予約として扱う
      if (!hasName(desc, userName) && !eventHasEmail(ev, email)) continue;
      if (!title) title = ev.getTitle();
      removed.push({slot_id: String(ev.getStartTime().getTime()), start: ev.getStartTime().toISOString()});

      var newDesc = removeName(desc, userName);
      if (newDesc.trim()) {
        // まだ他の予約者がいる場合：この生徒だけを削除して通知
        ev.setDescription(newDesc);
        // 管理者キャンセル時はemailが渡らないので、説明欄に保存していればそこから取得
        var emailToRemove = email || getEmailFromDesc(desc, userName);
        if (emailToRemove) removeGuestAndNotify(eventIds[i], emailToRemove);
      } else {
        // この生徒が最後（または唯一）の予約者の場合：予定ごと削除して通知
        // ※二重通知を防ぐため removeGuest は呼ばず、deleteEvent のみ実行
        deleteEventAndNotify(eventIds[i]);
      }
    }
    
    if (removed.length > 0) {
      // 管理者には常に通知
      sendNotificationToTeacher('取消', userName, removed, title, email);
      // ユーザーへのアプリメールは、Googleの通知があるので「Google未ログイン（＝Google通知がない）」場合のみ送信
      if (!email) {
        sendNotificationToUser('取消', userName, removed, title, email);
      }
    }
    return {ok: true, message: removed.length + '件取り消しました'};
  } finally {
    lock.releaseLock();
  }
}

function removeGuestAndNotify(eventId, email) {
  try {
    var cleanId = eventId.split('@')[0];
    var event = Calendar.Events.get(CONFIG.CALENDAR_ID, cleanId);
    if (!event.attendees) return;

    var lowerEmail = email.toLowerCase();
    var newList = event.attendees.filter(function(a) { return a.email.toLowerCase() !== lowerEmail; });

    if (newList.length !== event.attendees.length) {
      // 削除通知を送信することで、相手のカレンダーから消去させる
      Calendar.Events.patch({attendees: newList}, CONFIG.CALENDAR_ID, cleanId, { sendUpdates: 'all' });
    }
  } catch (e) {
    Logger.log('ゲスト削除失敗: ' + e.toString());
  }
}

function deleteEventAndNotify(eventId) {
  try {
    var cleanId = eventId.split('@')[0];
    Calendar.Events.remove(CONFIG.CALENDAR_ID, cleanId, { sendUpdates: 'all' });
  } catch (e) {
    Logger.log('イベント削除失敗: ' + e.toString());
  }
}

// 通知機能を分割して整理
function sendNotification(type, userName, items, title, email) {
  sendNotificationToTeacher(type, userName, items, title, email);
  sendNotificationToUser(type, userName, items, title, email);
}

function sendNotificationToTeacher(type, userName, items, title, email) {
  if (!CONFIG.TEACHER_EMAIL) return;
  var dates = items.map(function(it) { return '・' + formatSlot(new Date(it.start)); }).join('\n');
  var now = new Date(), timestamp = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy/MM/dd HH:mm');
  try {
    var teacherBody = userName + ' さんの予約が ' + type + ' されました。\n\n■ 内容: ' + title + '\n■ 日時:\n' + dates + '\n\n■ 連絡先: ' + (email || '（Google未ログイン）') + '\n■ 処理日時: ' + timestamp;
    GmailApp.sendEmail(CONFIG.TEACHER_EMAIL, '【TERACO予約】' + type + '通知 (' + userName + '様)', teacherBody, { name: 'TERACO予約システム' });
  } catch (e) { Logger.log('講師通知失敗: ' + e.toString()); }
}

function sendNotificationToUser(type, userName, items, title, email) {
  if (!email) return;
  var dates = items.map(function(it) { return '・' + formatSlot(new Date(it.start)); }).join('\n');
  try {
    var userBody = userName + ' 様\n\nTERACOラボのご予約が ' + type + ' されました。\n\n■ 予約内容: ' + title + '\n■ 予約日時:\n' + dates + '\n\nご不明な点がございましたら、お気軽にお問い合わせください。\n\nTERACOラボ';
    GmailApp.sendEmail(email, '【TERACO予約】' + type + '完了のお知らせ (' + userName + '様)', userBody, { name: 'TERACOラボ' });
  } catch (e) { Logger.log('ユーザー通知失敗: ' + e.toString()); }
}

// --- 共通ユーティリティ ---
function makeTitle(details) {
  if (!details || !details.category) return CONFIG.TITLE_PREFIX;
  return details.category + (details.course ? ' ' + details.course : '');
}
function getMinutes(details) {
  if (!details || !details.course) return 45;
  var c = details.course;
  var mm = String(c).match(/(\d+)\s*分/);
  if (mm) return Number(mm[1]);
  if (c.indexOf('90') >= 0 || c.indexOf('応用') >= 0 || c.indexOf('アドバンス') >= 0) return 90;
  if (c.indexOf('50') >= 0 || c.indexOf('個人') >= 0) return 50;
  return 45;
}
function findEventAt(cal, startTime, title) {
  var events = cal.getEvents(new Date(startTime.getTime() - 60000), new Date(startTime.getTime() + 60000));
  for (var i = 0; i < events.length; i++) {
    if (events[i].getTitle() === title && events[i].getStartTime().getTime() === startTime.getTime()) return events[i];
  }
  return null;
}
function findUserEvents(cal, userName, start, end, email) {
  var events = cal.getEvents(start, end);
  var result = [];
  var search = normalize(userName);
  for (var i = 0; i < events.length; i++) {
    var ev = events[i], desc = ev.getDescription() || '', title = ev.getTitle() || '';
    // 条件:
    // 1) 説明欄の名前が一致
    // 2) タイトルに名前が含まれる（旧形式）
    // 3) Googleカレンダーのゲストに、ログイン中のメールアドレスが含まれる
    if (hasName(desc, userName) || normalize(title).indexOf(search) >= 0 || eventHasEmail(ev, email)) {
      var st = ev.getStartTime();
      result.push({ event_id: ev.getId(), slot_id: String(st.getTime()), start: st.toISOString(), label: formatSlot(st), month_key: monthKey(st), class_title: title });
    }
  }
  return result;
}

/**
 * イベントのゲストに指定メールアドレスが含まれているかを判定
 */
function eventHasEmail(ev, email) {
  if (!email) return false;
  var target = String(email).trim().toLowerCase();
  if (!target) return false;
  try {
    var guests = ev.getGuestList();
    for (var i = 0; i < guests.length; i++) {
      var ge = (guests[i].getEmail() || '').toLowerCase();
      if (ge === target) return true;
    }
  } catch (e) {
    Logger.log('eventHasEmail error: ' + e.toString());
  }
  return false;
}

/**
 * 説明欄から名前に対応するメールアドレスを取得（予約時にemail付きで保存した場合）
 */
function getEmailFromDesc(desc, userName) {
  if (!desc || !userName) return '';
  var lines = desc.split('\n'), search = normalize(userName);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf('email:') === 0) {
      var parts = line.split(':');
      if (parts.length >= 3) {
        var storedName = parts.slice(1, -1).join(':');
        var storedEmail = parts[parts.length - 1];
        if (normalize(storedName) === search && storedEmail.indexOf('@') >= 0) return storedEmail;
      }
    }
  }
  return '';
}

function hasName(desc, userName) {
  var search = normalize(userName), lines = desc.split('\n');
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line && (normalize(line) === search || normalize(line).indexOf(search) >= 0)) return true;
  }
  return false;
}
function addName(desc, userName, email) {
  var lines = desc.split('\n'), names = [], search = normalize(userName);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line && !isJunkLine(line)) names.push(line);
  }
  if (!names.some(function(n) { return normalize(n) === search; })) {
    names.push(userName);
    if (email && String(email).trim().indexOf('@') >= 0) {
      names.push('email:' + userName + ':' + String(email).trim());
    }
  }
  return names.join('\n');
}
function removeName(desc, userName) {
  var lines = desc.split('\n'), result = [], search = normalize(userName);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    if (isJunkLine(line)) continue;
    if (normalize(line) === search) continue;
    if (line.indexOf('email:') === 0) {
      var parts = line.split(':');
      if (parts.length >= 3 && normalize(parts.slice(1, -1).join(':')) === search) continue;
    }
    result.push(line);
  }
  return result.join('\n');
}
function isJunkLine(line) {
  var lower = line.toLowerCase();
  return lower.indexOf('namekey') >= 0 || line.indexOf('予約者') >= 0 || line === '---' || line.indexOf('email:') === 0;
}
function normalize(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase().replace(/﨑/g, '崎').replace(/髙/g, '高').replace(/濵/g, '浜').replace(/邊/g, '辺').replace(/邉/g, '辺').replace(/齋/g, '斎');
}
/**
 * 曜日別の全スロット（コース問わず全パターンのスーパーセット）
 * フロントエンド側でコース別にフィルタリングする
 *   個人レッスン: 月(1)・火(2)・木(4) → 10-17時1時間おき(12/13除く), 水(3)・金(5) → 17:00のみ
 *   グループ系  : 水(3)・金(5) → 10:00/14:00/16:00
 *   ※GASは水金の全パターン [10:00, 14:00, 16:00, 17:00] を返し、月火木は [10:00,11:00,14:00,15:00,16:00,17:00] を返す
 */
function getTimesForDay(day) {
  var dow = day.getDay(); // 0=日,1=月,2=火,3=水,4=木,5=金,6=土
  if (dow === 1 || dow === 2 || dow === 4) {
    return ['10:00', '11:00', '14:00', '15:00', '16:00', '17:00'];
  }
  if (dow === 3 || dow === 5) {
    return ['10:00', '14:00', '16:00', '17:00'];
  }
  return [];
}

function buildSlots(cal, start, days) {
  var slots = [], now = new Date(), end = addDays(start, days), events = cal.getEvents(start, end);
  for (var d = 0; d < days; d++) {
    var day = addDays(start, d);
    var times = getTimesForDay(day);
    for (var t = 0; t < times.length; t++) {
      var time = times[t], st = atTime(day, time);
      if (st <= now) continue;
      var et = new Date(st.getTime() + CONFIG.SLOT_MINUTES * 60000), count = 0;
      for (var e = 0; e < events.length; e++) {
        var ev = events[e];
        if (ev.getStartTime() < et && ev.getEndTime() > st) {
          var names = (ev.getDescription() || '').split('\n').filter(function(l) { return l.trim() && !isJunkLine(l.trim()); });
          count += names.length;
        }
      }
      slots.push({ slot_id: String(st.getTime()), iso: st.toISOString(), day_key: formatDate(st), day_label: formatDay(st), start_time: time, month_key: monthKey(st), capacity: CONFIG.CAPACITY, reserved_count: count });
    }
  }
  return slots;
}
function getMonths(start, days) {
  var months = [], seen = {};
  for (var i = 0; i < days; i++) {
    var key = monthKey(addDays(start, i));
    if (!seen[key]) { seen[key] = true; months.push({key: key, label: monthLabel(key), limit: CONFIG.MONTHLY_LIMIT, reserved: 0, remaining: CONFIG.MONTHLY_LIMIT}); }
  }
  return months;
}
function getMonthsWithCount(start, days, existing) {
  var months = getMonths(start, days), counts = {};
  for (var i = 0; i < existing.length; i++) { counts[existing[i].month_key] = (counts[existing[i].month_key] || 0) + 1; }
  for (var j = 0; j < months.length; j++) { var m = months[j]; m.reserved = counts[m.key] || 0; m.remaining = Math.max(0, m.limit - m.reserved); }
  return months;
}
function jsonOut(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function todayStart() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { var r = new Date(d.getTime()); r.setDate(r.getDate() + n); return r; }
function atTime(d, hhmm) { var p = hhmm.split(':'); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(p[0]), Number(p[1] || 0)); }
function formatDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function formatDay(d) { return (d.getMonth() + 1) + '/' + d.getDate() + '(' + ['日', '月', '火', '水', '木', '金', '土'][d.getDay()] + ')'; }
function formatSlot(d) { return formatDay(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function monthKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
function monthLabel(k) { var p = k.split('-'); return p[0] + '年' + Number(p[1]) + '月'; }
function pad(n) { return n < 10 ? '0' + n : String(n); }

// =====================================================================
// v50 追加：新デザイン（pwa-reserve-next）用。ここから下は新しい処理だけ。
// 既存の overview / batch_reserve / batch_cancel などは一切変更していない。
// =====================================================================

// 2026年10月からの時間割（0=日…6=土）。火木=個人レッスン、水金=グループ講座
var NEXT_TIMES = {
  2: ['10:00', '11:00', '14:00', '15:00', '16:00', '17:00'],
  3: ['10:00', '11:00', '14:00', '16:00'],
  4: ['10:00', '11:00', '14:00', '15:00', '16:00', '17:00'],
  5: ['10:00', '14:00', '15:00', '16:00']
};

// 受講の予約イベントか（タイトル先頭で判定。私用の予定を人数に数えないため）
function isLessonTitle_(title) {
  return /^(スマホ|パソコンAI|TERACO予約)/.test(title || '');
}

// 講座カレンダー（正本）。スクリプトプロパティに JSON で保存する
function getSchedule_() {
  var empty = { published: [], off: [], events: [], updated: '' };
  var raw = PropertiesService.getScriptProperties().getProperty('SCHEDULE_JSON');
  if (!raw) return empty;
  try { var o = JSON.parse(raw); return { published: o.published || [], off: o.off || [], events: o.events || [], updated: o.updated || '' }; }
  catch (e) { return empty; }
}

function setSchedule_(passcode, schedule) {
  if (passcode !== CONFIG.ADMIN_PASSCODE) return { ok: false, message: 'パスコードが正しくありません' };
  if (!schedule || typeof schedule !== 'object') return { ok: false, message: '講座カレンダーの内容が空です' };
  var isDay = function(x) { return /^\d{4}-\d{2}-\d{2}$/.test(String(x)); };
  var isMonth = function(x) { return /^\d{4}-\d{2}$/.test(String(x)); };
  var clean = {
    published: (schedule.published || []).filter(isMonth).sort(),
    off: (schedule.off || []).filter(isDay).sort(),
    events: (schedule.events || []).filter(function(ev) { return ev && isDay(ev.day) && /^\d{2}:\d{2}$/.test(String(ev.time)) && ev.label; })
      .map(function(ev) { return { day: String(ev.day), time: String(ev.time), label: String(ev.label).slice(0, 30), min: Number(ev.min) || 45 }; }),
    updated: new Date().toISOString()
  };
  var json = JSON.stringify(clean);
  if (json.length > 8500) return { ok: false, message: '講座カレンダーのデータが大きすぎます。古い月の休みを整理してください。' };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, message: 'サーバーが混み合っています。少し待ってからもう一度お試しください。' };
  try { PropertiesService.getScriptProperties().setProperty('SCHEDULE_JSON', json); }
  finally { lock.releaseLock(); }
  return { ok: true, schedule: clean };
}

// 新デザインが1回の通信で必要なものを全部受け取る：空き枠・自分の予約・講座カレンダー
function getNextData(name, days, email) {
  var cal = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  var start = todayStart(), now = new Date();
  days = Math.min(Math.max(days, 7), 100);
  var end = addDays(start, days), events = cal.getEvents(start, end);
  var evs = events.map(function(ev) {
    var title = ev.getTitle() || '';
    var lesson = isLessonTitle_(title);
    var names = lesson ? (ev.getDescription() || '').split('\n').filter(function(l) { return l.trim() && !isJunkLine(l.trim()); }).length : 0;
    return { s: ev.getStartTime().getTime(), e: ev.getEndTime().getTime(), allDay: ev.isAllDayEvent(), names: names };
  });
  var slots = [];
  for (var d = 0; d < days; d++) {
    var day = addDays(start, d), dow = day.getDay(), times = NEXT_TIMES[dow] || [];
    var solo = (dow === 2 || dow === 4);                       // 個人レッスンの日は定員1人・50分
    for (var t = 0; t < times.length; t++) {
      var st = atTime(day, times[t]); if (st <= now) continue;
      var s0 = st.getTime(), e0 = s0 + (solo ? 50 : 45) * 60000, count = 0, busy = false;
      for (var i = 0; i < evs.length; i++) {
        if (evs[i].s < e0 && evs[i].e > s0) { count += evs[i].names; if (!evs[i].allDay) busy = true; }
      }
      slots.push({ slot_id: String(s0), iso: st.toISOString(), day_key: formatDate(st), day_label: formatDay(st), start_time: times[t],
                   month_key: monthKey(st), capacity: solo ? 1 : CONFIG.CAPACITY, reserved_count: count, busy: solo ? busy : false });
    }
  }
  var existing = [];
  if (name && name.trim()) existing = findUserEvents(cal, name.trim(), start, addDays(start, days + 31), email || '');
  return { ok: true, version: 'v50', name: (name || '').trim(), slots: slots, existing: existing, schedule: getSchedule_() };
}

