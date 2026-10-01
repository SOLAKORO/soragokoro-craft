/**
 * そらごころクラフト 集計・ログイン用 Apps Script
 * このスプレッドシートの「拡張機能 > Apps Script」に貼り付けて、ウェブアプリとしてデプロイします。
 * ・アプリから届いた進捗を「進捗一覧」「ミッション達成表」「進捗履歴」に書き込みます。
 * ・アプリのログイン(IDとパスワード)を、そらごころテスト集計表の「名簿」と照らします。
 */
var SH_PROG = '進捗一覧';
var SH_MIS = 'ミッション達成表';
var SH_LOG = '進捗履歴';
var LEVEL_NAMES = ['', 'ひらがな', 'ふりがな', '漢字'];

// ログインに使う名簿: 「そらごころテスト集計表」の「名簿」シート(ID・パスワード・名前・学年)
var ROSTER_SSID = '1VZTreXLxeeQfgTgnaMPbcpp1MSEw_1V5foVkVqqx-ds';
var ROSTER_SHEET = '名簿';
var MAX_FAILS = 5;       // まちがえて良い回数
var LOCK_SECONDS = 600;  // それを超えたら 10分ロック
var TOKEN_DAYS = 30;     // ログインの有効期間(日)

// そらごころテストの「ポイント」に足す量(ここを変えると増減できます)
var MISSION_PT = 3;      // ミッションを1つクリアするごとに(1つのミッションにつき1回だけ)
var DAILY_PT = 2;        // 毎日チャレンジを達成した日ごとに(1日1回だけ)
var SH_SAVE = 'セーブ';
var SH_PT = 'ポイント履歴';
var SAVE_MAX = 600000;   // 1人あたり保存できる文字数の上限
var SAVE_CHUNK = 40000;  // 1セルに入れる文字数(セルの上限は5万字)

function doGet() {
  return out_('soragokoro-craft ok v3 (login+token)');
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var d = JSON.parse(e.postData.contents);
    if (!d || d.app !== 'soragokoro-craft') return out_('ignored');
    if (d.action === 'login') {
      try { return json_(login_(d)); }
      catch (le) { return json_({ ok: false, error: 'server', detail: String(le).slice(0, 100) }); }
    }
    // 進捗の記録・セーブ・ポイントは、ログインで発行した「通行証」がある人だけ
    var isApi = d.action === 'save' || d.action === 'load' || d.action === 'earn';
    if (!checkToken_(d.token, d.id)) return isApi ? json_({ ok: false, error: 'auth' }) : out_('denied');
    lock.waitLock(20000);
    if (d.action === 'save') return json_(save_(d));
    if (d.action === 'load') return json_(load_(d));
    if (d.action === 'earn') return json_(earn_(d));
    record_(d);
    return out_('ok');
  } catch (err) {
    return out_('error: ' + err);
  } finally {
    try { lock.releaseLock(); } catch (x) { /* ロックを取れていない場合 */ }
  }
}

function out_(s) {
  return ContentService.createTextOutput(s);
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// 全角を半角にそろえ、前後の空白をとる
function norm_(v) {
  return String(v == null ? '' : v).normalize('NFKC').trim();
}

// 「小学3年」「中学1年」などを { grade: '小3', level: 2 } にする
// level: 1=ひらがな(小1-2) 2=ふりがな(小3-4) 3=漢字(小5-6・中学以上)
function parseGrade_(text) {
  var t = norm_(text);
  var m = t.match(/(小|中|高)[^0-9]*([0-9])/);
  if (!m) return { grade: 'その他', level: 2 };
  var n = Number(m[2]);
  if (m[1] === '小') {
    if (n < 1 || n > 6) return { grade: 'その他', level: 2 };
    return { grade: '小' + n, level: n <= 2 ? 1 : (n <= 4 ? 2 : 3) };
  }
  return { grade: m[1] + n, level: 3 };
}

// ---- 通行証(トークン) ----
// ログイン成功時に「ID.期限.署名」を発行。署名は、このスクリプトだけが知る秘密の鍵で作る。
function secret_() {
  var props = PropertiesService.getScriptProperties();
  var k = props.getProperty('TOKEN_SECRET');
  if (!k) {
    k = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', k);
  }
  return k;
}
function sign_(msg) {
  var raw = Utilities.computeHmacSha256Signature(msg, secret_());
  return Utilities.base64EncodeWebSafe(raw).replace(/=+$/, '');
}
function makeToken_(id) {
  var exp = Date.now() + TOKEN_DAYS * 86400000;
  return { token: id.length + ':' + id + ':' + exp + ':' + sign_(id + '|' + exp), exp: exp };
}
function checkToken_(token, id) {
  try {
    var t = String(token || '');
    var n = parseInt(t.split(':')[0], 10);
    if (!(n > 0)) return false;
    var head = t.indexOf(':') + 1;
    var tid = t.substr(head, n);
    var rest = t.substr(head + n + 1).split(':');
    var exp = Number(rest[0]), sig = rest[1] || '';
    if (norm_(tid) !== norm_(id)) return false;
    if (!(exp > Date.now())) return false;
    var want = sign_(tid + '|' + exp);
    if (want.length !== sig.length) return false;
    var diff = 0;
    for (var i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
  } catch (e) { return false; }
}

// ID とパスワードを名簿と照らす。パスワードは返さない。
function login_(d) {
  var id = norm_(d.id), pw = norm_(d.password);
  if (!id || !pw) return { ok: false, error: 'empty' };
  var cache = CacheService.getScriptCache();
  var failKey = 'fail:' + id;
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= MAX_FAILS) return { ok: false, error: 'locked' };
  var sh = SpreadsheetApp.openById(ROSTER_SSID).getSheetByName(ROSTER_SHEET);
  if (!sh) return { ok: false, error: 'server' };
  var rows = sh.getDataRange().getDisplayValues();
  var head = rows[0];
  var cId = head.indexOf('ID'), cPw = head.indexOf('パスワード'), cName = head.indexOf('名前'), cGrade = head.indexOf('学年');
  if (cId < 0 || cPw < 0 || cName < 0) return { ok: false, error: 'server' };
  for (var i = 1; i < rows.length; i++) {
    if (norm_(rows[i][cId]) !== id) continue;
    if (norm_(rows[i][cPw]) !== pw) break;
    cache.remove(failKey);
    var g = parseGrade_(cGrade >= 0 ? rows[i][cGrade] : '');
    var tk = makeToken_(String(rows[i][cId]).trim());
    return { ok: true, id: String(rows[i][cId]).trim(), name: String(rows[i][cName]).trim(), grade: g.grade, level: g.level, token: tk.token, exp: tk.exp };
  }
  cache.put(failKey, String(fails + 1), LOCK_SECONDS);
  return { ok: false, error: 'wrong' };
}

// 式として解釈されないよう、先頭の記号を無効にする
function safe_(v) {
  var s = String(v == null ? '' : v).slice(0, 60);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function num_(v) {
  v = Number(v);
  return isFinite(v) && v >= 0 ? Math.round(v) : 0;
}

// 1列目(ID)を上から調べて、同じ人の行番号を返す。いなければ最初の空き行。
function findRow_(sh, key) {
  var vals = sh.getRange(2, 1, sh.getMaxRows() - 1, 1).getDisplayValues();
  for (var i = 0; i < vals.length; i++) {
    if (vals[i][0] === '') return { row: i + 2, found: false };
    if (vals[i][0] === key) return { row: i + 2, found: true };
  }
  sh.insertRowsAfter(sh.getMaxRows(), 100);
  return { row: vals.length + 2, found: false };
}

function record_(d) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = safe_(d.name);
  var key = safe_(d.id || d.name);
  if (!name || !key) return;
  var grade = safe_(d.grade);
  var now = new Date();
  var cleared = num_(d.cleared);

  // 進捗一覧
  var prog = ss.getSheetByName(SH_PROG);
  var r = findRow_(prog, key);
  var oldCleared = r.found ? Number(prog.getRange(r.row, 5).getValue()) : -1;
  prog.getRange(r.row, 1, 1, 6).setValues([[key, name, grade, LEVEL_NAMES[num_(d.level)] || '', cleared, num_(d.total)]]);
  prog.getRange(r.row, 8, 1, 10).setValues([[
    safe_(d.current), num_(d.zukan), num_(d.placed), num_(d.broken), num_(d.inspected),
    num_(d.runs), num_(d.labMade), num_(d.asked), num_(d.playMin), now
  ]]);
  prog.getRange(r.row, 19, 1, 2).setValues([[num_(d.dailyStreak), num_(d.dailyDays)]]);

  // ミッション達成表
  var mis = ss.getSheetByName(SH_MIS);
  var mr = findRow_(mis, key);
  var ms = [];
  for (var i = 0; i < 13; i++) {
    var v = d.missions && d.missions[i];
    ms.push(v === '✓' ? '✓' : (v === '-' ? '-' : ''));
  }
  mis.getRange(mr.row, 1, 1, 2).setValues([[key, name]]);
  mis.getRange(mr.row, 3, 1, 13).setValues([ms]);

  // 進捗履歴: 初めての人、クリア数が変わったとき、開始時に1行追加
  if (!r.found || cleared !== oldCleared || d.reason === 'start') {
    var log = ss.getSheetByName(SH_LOG);
    var lr = findRow_(log, '\u0000').row; // 最初の空き行を得るため存在しないキーを探す
    var why = !r.found ? '初回' : (cleared !== oldCleared ? 'ミッションクリア' : 'プレイ開始');
    log.getRange(lr, 1, 1, 9).setValues([[now, key, name, grade, cleared, safe_(d.current), num_(d.zukan), num_(d.playMin), why]]);
  }
}

// ---- 名簿から ID・名前・学年を集計表にうつす(パスワードは うつさない) ----
function onOpen() {
  SpreadsheetApp.getUi().createMenu('そらごころクラフト')
    .addItem('名簿から みんなを とうろく(ID・なまえ・学年)', 'syncRoster')
    .addToUi();
}

function syncRoster() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = SpreadsheetApp.openById(ROSTER_SSID).getSheetByName(ROSTER_SHEET);
  if (!sh) throw new Error('名簿シートが見つかりません');
  var rows = sh.getDataRange().getDisplayValues();
  var head = rows[0];
  var cId = head.indexOf('ID'), cName = head.indexOf('名前'), cGrade = head.indexOf('学年');
  if (cId < 0 || cName < 0) throw new Error('名簿に ID と 名前 の列がありません');
  var prog = ss.getSheetByName(SH_PROG), mis = ss.getSheetByName(SH_MIS);
  var added = 0;
  for (var i = 1; i < rows.length; i++) {
    var id = safe_(rows[i][cId]);
    if (!id) continue;
    var name = safe_(rows[i][cName]);
    var g = parseGrade_(cGrade >= 0 ? rows[i][cGrade] : '');
    var r = findRow_(prog, id);
    if (!r.found) {
      prog.getRange(r.row, 1, 1, 3).setValues([[id, name, g.grade]]);
      added++;
    } else {
      prog.getRange(r.row, 2, 1, 2).setValues([[name, g.grade]]);
    }
    var mr = findRow_(mis, id);
    mis.getRange(mr.row, 1, 1, 2).setValues([[id, name]]);
  }
  SpreadsheetApp.getActiveSpreadsheet().toast(added + '人を あたらしく とうろくしました', 'そらごころクラフト', 5);
}

// ---- シートを無ければ作る ----
function getSheet_(name, header, hidden) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
    if (hidden) sh.hideSheet();
  }
  return sh;
}

// ---- クラウドセーブ ----
// セーブ: 1人分を 40000字ずつに分けて「セーブ」シート(非表示)に入れる。A=ID B=時刻 C=番号 D=データ
function save_(d) {
  var id = norm_(d.id), data = String(d.data || '');
  if (!id || !data) return { ok: false, error: 'empty' };
  if (data.length > SAVE_MAX) return { ok: false, error: 'big' };
  var ts = num_(d.ts);
  var sh = getSheet_(SH_SAVE, ['ID', '更新(ミリ秒)', '番号', 'データ'], true);
  removeSaveRows_(sh, id);
  var rows = [];
  for (var i = 0, seq = 0; i < data.length; i += SAVE_CHUNK, seq++) rows.push([id, ts, seq, data.substr(i, SAVE_CHUNK)]);
  var start = sh.getLastRow() + 1;
  if (sh.getMaxRows() < start + rows.length) sh.insertRowsAfter(sh.getMaxRows(), rows.length + 20);
  sh.getRange(start, 1, rows.length, 4).setNumberFormat('@');
  sh.getRange(start, 1, rows.length, 4).setValues(rows);
  return { ok: true, ts: ts, parts: rows.length };
}
function removeSaveRows_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return;
  var ids = sh.getRange(2, 1, last - 1, 1).getDisplayValues();
  for (var i = ids.length - 1; i >= 0; i--) if (norm_(ids[i][0]) === id) sh.deleteRow(i + 2);
}
function load_(d) {
  var id = norm_(d.id);
  var sh = getSheet_(SH_SAVE, ['ID', '更新(ミリ秒)', '番号', 'データ'], true);
  var last = sh.getLastRow();
  if (last < 2) return { ok: true, data: '' };
  var rows = sh.getRange(2, 1, last - 1, 4).getDisplayValues();
  var parts = [], ts = 0;
  for (var i = 0; i < rows.length; i++) {
    if (norm_(rows[i][0]) !== id) continue;
    parts.push({ seq: Number(rows[i][2]), text: rows[i][3] });
    ts = Number(rows[i][1]) || ts;
  }
  parts.sort(function (a, b) { return a.seq - b.seq; });
  return { ok: true, ts: ts, data: parts.map(function (p) { return p.text; }).join('') };
}

// ---- ポイント(そらごころテストの名簿の「ポイント」に足す) ----
// 同じ人・同じ種類・同じキーは1回だけ。足した記録は「ポイント履歴」シートに残る。
function jstDate_(t) {
  return Utilities.formatDate(new Date(t), 'Asia/Tokyo', 'yyyy-MM-dd');
}
function earn_(d) {
  var id = norm_(d.id), kind = String(d.kind || ''), key = String(d.key || '').slice(0, 20), pts = 0;
  if (kind === 'mission' && /^m\d{1,2}$/.test(key)) pts = MISSION_PT;
  else if (kind === 'daily' && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
    var now = Date.now();
    if (key !== jstDate_(now) && key !== jstDate_(now - 86400000)) return { ok: false, error: 'date' };
    pts = DAILY_PT;
  } else return { ok: false, error: 'bad' };

  var led = getSheet_(SH_PT, ['日時', 'ID', '種類', 'キー', 'ポイント', '加算後の合計'], false);
  var last = led.getLastRow();
  if (last >= 2) {
    var rows = led.getRange(2, 2, last - 1, 3).getDisplayValues();
    for (var i = 0; i < rows.length; i++) {
      if (norm_(rows[i][0]) === id && rows[i][1] === kind && rows[i][2] === key) return { ok: true, added: 0, dup: true };
    }
  }
  var rs = SpreadsheetApp.openById(ROSTER_SSID).getSheetByName(ROSTER_SHEET);
  if (!rs) return { ok: false, error: 'server' };
  var data = rs.getDataRange().getDisplayValues();
  var cId = data[0].indexOf('ID'), cPt = data[0].indexOf('ポイント');
  if (cId < 0 || cPt < 0) return { ok: false, error: 'server' };
  for (var r = 1; r < data.length; r++) {
    if (norm_(data[r][cId]) !== id) continue;
    var cur = Number(String(data[r][cPt]).replace(/[^0-9.\-]/g, '')) || 0;
    var total = cur + pts;
    var lr = last + 1;
    led.getRange(lr, 1, 1, 6).setValues([[new Date(), "'" + id, kind, "'" + key, pts, total]]);
    try {
      rs.getRange(r + 1, cPt + 1).setValue(total);
    } catch (e) {
      led.deleteRow(lr);
      return { ok: false, error: 'server' };
    }
    return { ok: true, added: pts, total: total };
  }
  return { ok: false, error: 'noid' };
}
