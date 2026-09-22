/* TERACO 時間割（正本）。予約アプリ(app.js)と印刷用カレンダー(calendar.html)の両方がこれを読む。
   コース名・分数・曜日・時間・色を変えるときは、このファイルだけを直す。
   2026年10月からの正式版：A=水曜／B=金曜。個人レッスンは火・木。 */
window.TERACO_TIMETABLE = {
  categories: { smartphone: 'スマホ', pc_ai: 'パソコンAI' },
  courses: {
    'sp-intro': { cat: 'smartphone', label: 'スマホ入門',   short: '入門', min: 45, color: '#F8DDB0', classes: { A: { dow: 3, time: '16:00' }, B: { dow: 5, time: '14:00' } } },
    'sp-adv':   { cat: 'smartphone', label: 'スマホ応用',   short: '応用', min: 90, color: '#C9E2C0', classes: { A: { dow: 3, time: '14:00' }, B: { dow: 5, time: '10:00' } } },
    'pc-intro': { cat: 'pc_ai',      label: 'パソコン入門', short: '入門', min: 45, color: '#E6CDF5', classes: { A: { dow: 3, time: '10:00' }, B: { dow: 5, time: '15:00' } } },
    'pc-adv':   { cat: 'pc_ai',      label: 'パソコン応用', short: '応用', min: 45, color: '#A9DCFB', classes: { A: { dow: 3, time: '11:00' }, B: { dow: 5, time: '16:00' } } },
    'private':  { cat: null,         label: '個人レッスン', short: '個人レッスン', min: 50, color: '#FDF3C4', classes: null }
  },
  privateDows: [2, 4],
  privateTimes: ['10:00', '11:00', '14:00', '15:00', '16:00', '17:00'],
  adminTimes: ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00']
};
