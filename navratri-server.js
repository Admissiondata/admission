const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');
const express = require('express');
const multer = require('multer');
require('dotenv').config();

const BASE_DIR = __dirname;
const STATIC_DIR = path.join(BASE_DIR, 'navratri');
const DEFAULT_DB_PATH = path.join(BASE_DIR, 'navratri_data.db');
const DEFAULT_PIN = '1234';
const VALID_ROLES = new Set(['operator', 'authority', 'admin']);
const VALID_STATUSES = new Set(['pending', 'approved', 'rejected']);
const GENDER_FEE = { bahin: 50, bhai: 100 };
const MOBILE_RE = /^\d{10}$/;
const AADHAR_RE = /^\d{12}$/;
const DEFAULT_SETTINGS = { title: 'ગરબા પાસ – નવરાત્રી મહોત્સવ ૨૦૨૬', subtitle: 'શ્રી ખેલૈયા મંડળ, વાસદ', address: '', date_from: '11-10-2026', date_to: '20-11-2026', background: '' };
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function openDatabase(dbPath = process.env.NAVRATRI_DB_PATH || DEFAULT_DB_PATH) {
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS registrations (
      no TEXT PRIMARY KEY, date TEXT NOT NULL, name TEXT NOT NULL, gender TEXT NOT NULL,
      dob TEXT NOT NULL, age INTEGER NOT NULL, mobile TEXT NOT NULL,
      k_sar TEXT, k_gam TEXT, k_tal TEXT, k_pin TEXT,
      h_sar TEXT, h_gam TEXT, h_tal TEXT, h_pin TEXT,
      fee INTEGER NOT NULL, ts INTEGER NOT NULL, photo TEXT, aadhar TEXT, aadhar_no TEXT,
      role TEXT NOT NULL DEFAULT 'operator', status TEXT NOT NULL DEFAULT 'pending',
      approved_by TEXT, qr_code TEXT
    );
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO meta (key, value) VALUES ('counter', '0');
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'operator',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const columns = new Set(database.pragma('table_info(registrations)').map((column) => column.name));
  const migrations = [['photo', 'TEXT'], ['aadhar', 'TEXT'], ['aadhar_no', 'TEXT'], ['role', "TEXT NOT NULL DEFAULT 'operator'"], ['status', "TEXT NOT NULL DEFAULT 'pending'"], ['approved_by', 'TEXT'], ['qr_code', 'TEXT']];
  migrations.forEach(([column, type]) => { if (!columns.has(column)) database.exec(`ALTER TABLE registrations ADD COLUMN ${column} ${type}`); });
  return database;
}

function hashPassword(password) { return crypto.createHash('sha256').update(String(password).trim()).digest('hex'); }
function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function calcAge(dob) {
  if (!validDate(dob)) return null;
  const [year, month, day] = dob.split('-').map(Number);
  const now = new Date();
  return now.getFullYear() - year - ((now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day)) ? 1 : 0);
}
function todayIso() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function qrUrl(value) { return `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(String(value || '').trim() || 'navratri-pass')}`; }
function rowToRecord(row, withBlobs = false) {
  const record = {
    no: row.no, date: row.date, name: row.name, gender: row.gender, dob: row.dob, age: row.age, mobile: row.mobile,
    k: [row.k_sar, row.k_gam, row.k_tal, row.k_pin], h: [row.h_sar, row.h_gam, row.h_tal, row.h_pin], fee: row.fee, ts: row.ts,
    aadhar_no: row.aadhar_no || '', role: row.role || 'operator', status: row.status || 'pending', approved_by: row.approved_by || '',
    qr_code: row.qr_code || '', has_photo: Boolean(row.photo), has_aadhar: Boolean(row.aadhar),
  };
  if (withBlobs) { record.photo = row.photo || ''; record.aadhar = row.aadhar || ''; }
  return record;
}
function csvField(value) { const text = String(value ?? ''); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
function syncSupabaseRecord(record) {
  const url = String(process.env.SUPABASE_URL || '').trim(); const key = String(process.env.SUPABASE_KEY || '').trim(); const table = String(process.env.SUPABASE_TABLE || 'registrations').trim();
  if (!url || !key || !record?.no) return;
  const payload = {
    no: String(record.no || ''), date: String(record.date || ''), name: String(record.name || ''), gender: String(record.gender || ''),
    dob: String(record.dob || ''), age: Number(record.age || 0), mobile: String(record.mobile || ''),
    k_sar: String(record.k?.[0] || ''), k_gam: String(record.k?.[1] || ''), k_tal: String(record.k?.[2] || ''), k_pin: String(record.k?.[3] || ''),
    h_sar: String(record.h?.[0] || ''), h_gam: String(record.h?.[1] || ''), h_tal: String(record.h?.[2] || ''), h_pin: String(record.h?.[3] || ''),
    fee: Number(record.fee || 0), ts: Number(record.ts || 0), photo: String(record.photo || ''), aadhar: String(record.aadhar || ''),
    aadhar_no: String(record.aadhar_no || ''), role: String(record.role || 'operator'), status: String(record.status || 'pending'),
    approved_by: String(record.approved_by || ''), qr_code: String(record.qr_code || ''),
  };
  fetch(`${url.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(table)}`, {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
  }).catch(() => {});
}

function createNavratriApp({ dbPath, adminPin = process.env.ADMIN_PIN ?? DEFAULT_PIN } = {}) {
  const database = openDatabase(dbPath);
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use(express.static(STATIC_DIR));
  const jsonError = (res, error, status = 400) => res.status(status).json({ ok: false, error });
  const pinValid = (req) => !adminPin || String(req.get('X-Admin-Pin') || '').trim() === adminPin;
  const pinError = (res) => jsonError(res, 'એડમિન PIN ખોટો છે.', 401);
  const readCounter = () => Number(database.prepare("SELECT value FROM meta WHERE key='counter'").get()?.value || 0);
  const setCounter = (value) => database.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('counter',?)").run(String(value));
  function getSettings() {
    const value = database.prepare("SELECT value FROM meta WHERE key='settings'").get()?.value;
    let settings = {};
    try { if (value) settings = JSON.parse(value); } catch { settings = {}; }
    return { ...DEFAULT_SETTINGS, ...settings };
  }
  function settingsPayload(settings) {
    return { ...settings, logo: settings.logo || (require('node:fs').existsSync(path.join(STATIC_DIR, 'logo.png')) ? '/logo.png' : ''), background: settings.background || (require('node:fs').existsSync(path.join(STATIC_DIR, 'background.png')) ? '/background.png' : '') };
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Navratri Garba Pass 2026' }));
  app.get('/api/next', (_req, res) => res.json({ no: `NP-${new Date().getFullYear()}-${String(readCounter() + 1).padStart(4, '0')}` }));
  app.post('/api/users', (req, res) => {
    const username = String(req.body.username || '').trim(); const password = String(req.body.password || '').trim(); let role = String(req.body.role || 'operator').trim().toLowerCase();
    if (username.length < 3) return jsonError(res, 'યુઝરનેમ ઓછામાં ઓછી 3 અક્ષરનો હોવો જોઈએ.');
    if (password.length < 6) return jsonError(res, 'પાસવર્ડ ઓછામાં ઓછી 6 અક્ષરનો હોવો જોઈએ.');
    if (!VALID_ROLES.has(role)) role = 'operator';
    let user = database.prepare('SELECT id,username,role FROM users WHERE username=?').get(username);
    if (!user) {
      try { const result = database.prepare('INSERT INTO users (username,password,role) VALUES (?,?,?)').run(username, hashPassword(password), role); user = database.prepare('SELECT id,username,role FROM users WHERE id=?').get(result.lastInsertRowid); }
      catch (error) { if (error.code?.startsWith('SQLITE_CONSTRAINT')) return jsonError(res, 'Username already exists', 409); throw error; }
    }
    return res.json({ ok: true, user });
  });
  app.post('/api/login', (req, res) => {
    const username = String(req.body.username || '').trim(); const password = String(req.body.password || '').trim();
    if (!username || !password) return jsonError(res, 'યુઝરનેમ અથવા પાસવર્ડ ખોટો છે.', 401);
    const user = database.prepare('SELECT id,username,role FROM users WHERE username=? AND password=?').get(username, hashPassword(password));
    return user ? res.json({ ok: true, user }) : jsonError(res, 'યુઝરનેમ અથવા પાસવર્ડ ખોટો છે.', 401);
  });
  app.post('/api/register', (req, res) => {
    const data = req.body || {}; const name = String(data.name || '').trim(); const gender = String(data.gender || '').trim(); const dob = String(data.dob || '').trim(); const mobile = String(data.mobile || '').trim();
    let role = String(data.role || 'operator').trim().toLowerCase(); if (!VALID_ROLES.has(role)) role = 'operator';
    if (!name) return jsonError(res, 'નામ ફરજિયાત છે.');
    if (!Object.hasOwn(GENDER_FEE, gender)) return jsonError(res, 'લિંગ પસંદ કરો (બહેન / ભાઈ).');
    if (!MOBILE_RE.test(mobile)) return jsonError(res, 'મોબાઈલ નંબર ૧૦ આંકડાનો ફરજિયાત છે.');
    const age = calcAge(dob); if (age === null || age < 0) return jsonError(res, 'જન્મ તારીખ સાચી નથી.');
    const aadharNo = String(data.aadhar_no || '').trim(); if (aadharNo && !AADHAR_RE.test(aadharNo)) return jsonError(res, 'આધાર નંબર ૧૨ આંકડાનો ફરજિયાત છે.');
    const addr = Array.isArray(data.k) ? data.k : []; const haddr = Array.isArray(data.h) ? data.h : [];
    const k = Array.from({ length: 4 }, (_, index) => String(addr[index] || '').trim()); const h = Array.from({ length: 4 }, (_, index) => String(haddr[index] || '').trim());
    const date = todayIso(); const ts = Date.now(); let no;
    const allocate = database.transaction(() => { const next = readCounter() + 1; setCounter(next); no = `NP-${new Date().getFullYear()}-${String(next).padStart(4, '0')}`; }); allocate();
    const qr = qrUrl(no); const photo = String(data.photo || '').trim(); const aadhar = String(data.aadhar || '').trim();
    database.prepare('INSERT INTO registrations (no,date,name,gender,dob,age,mobile,k_sar,k_gam,k_tal,k_pin,h_sar,h_gam,h_tal,h_pin,fee,ts,photo,aadhar,aadhar_no,role,status,approved_by,qr_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(no, date, name, gender, dob, age, mobile, ...k, ...h, GENDER_FEE[gender], ts, photo, aadhar, aadharNo, role, 'pending', '', qr);
    const record = rowToRecord(database.prepare('SELECT * FROM registrations WHERE no=?').get(no), true); syncSupabaseRecord(record);
    return res.json({ ok: true, no, record });
  });
  app.get('/api/registrations', (req, res) => {
    const query = String(req.query.q || '').trim().toLowerCase(); const status = String(req.query.status || '').trim().toLowerCase();
    let rows;
    if (query) { const like = `%${query}%`; rows = database.prepare("SELECT * FROM registrations WHERE (lower(name) LIKE ? OR mobile LIKE ? OR lower(no) LIKE ?) AND (?='' OR status=?) ORDER BY ts DESC").all(like, like, like, status, status); }
    else rows = status ? database.prepare('SELECT * FROM registrations WHERE status=? ORDER BY ts DESC').all(status) : database.prepare('SELECT * FROM registrations ORDER BY ts DESC').all();
    return res.json(rows.map((row) => ({ ...rowToRecord(row), photo: row.photo || '' })));
  });
  app.get('/api/registrations/:no', (req, res) => {
    const row = database.prepare('SELECT * FROM registrations WHERE no=?').get(req.params.no);
    return row ? res.json(rowToRecord(row, true)) : jsonError(res, 'પાસ મળ્યો નથી.', 404);
  });
  app.patch('/api/registrations/:no', (req, res) => {
    if (!pinValid(req)) return pinError(res);
    const old = database.prepare('SELECT * FROM registrations WHERE no=?').get(req.params.no); if (!old) return jsonError(res, 'પાસ મળ્યો નથી.', 404);
    const data = req.body || {}; let status = String(data.status ?? old.status ?? 'pending').trim().toLowerCase(); if (!VALID_STATUSES.has(status)) status = old.status || 'pending';
    let approvedBy = String(data.approved_by ?? old.approved_by ?? '').trim().toLowerCase(); if (status === 'approved' && !VALID_ROLES.has(approvedBy)) approvedBy = 'authority'; if (status !== 'approved') approvedBy = '';
    const field = (name) => String(data[name] ?? old[name] ?? '').trim(); const name = field('name'); const mobile = field('mobile'); const dob = field('dob'); const regDate = field('date');
    if (!name) return jsonError(res, 'નામ ફરજિયાત છે.'); if (!MOBILE_RE.test(mobile)) return jsonError(res, 'મોબાઈલ નંબર ૧૦ આંકડાનો ફરજિયાત છે.');
    const age = calcAge(dob); if (age === null || age < 0) return jsonError(res, 'જન્મ તારીખ સાચી નથી.');
    const aadharNo = field('aadhar_no'); if (aadharNo && !AADHAR_RE.test(aadharNo)) return jsonError(res, 'આધાર નંબર ૧૨ આંકડાનો ફરજિયાત છે.');
    const addr = (value, keys) => Array.from({ length: 4 }, (_, index) => String(value?.[index] ?? old[keys[index]] ?? '').trim());
    const k = addr(data.k, ['k_sar', 'k_gam', 'k_tal', 'k_pin']); const h = addr(data.h, ['h_sar', 'h_gam', 'h_tal', 'h_pin']);
    const photo = data.photo == null ? old.photo : data.photo; const aadhar = data.aadhar == null ? old.aadhar : data.aadhar;
    let role = String(data.role ?? old.role ?? 'operator').trim().toLowerCase(); if (!VALID_ROLES.has(role)) role = old.role || 'operator';
    database.prepare('UPDATE registrations SET date=?,name=?,dob=?,age=?,mobile=?,k_sar=?,k_gam=?,k_tal=?,k_pin=?,h_sar=?,h_gam=?,h_tal=?,h_pin=?,photo=?,aadhar=?,aadhar_no=?,role=?,status=?,approved_by=?,qr_code=? WHERE no=?').run(regDate, name, dob, age, mobile, ...k, ...h, photo, aadhar, aadharNo, role, status, approvedBy, old.qr_code || qrUrl(req.params.no), req.params.no);
    const record = rowToRecord(database.prepare('SELECT * FROM registrations WHERE no=?').get(req.params.no), true); syncSupabaseRecord(record);
    return res.json({ ok: true, record });
  });
  app.delete('/api/registrations/:no', (req, res) => {
    if (!pinValid(req)) return pinError(res);
    const result = database.prepare('DELETE FROM registrations WHERE no=?').run(req.params.no);
    return result.changes ? res.json({ ok: true }) : jsonError(res, 'રજીસ્ટ્રેશન મળ્યું નથી.', 404);
  });
  app.post('/api/clear', (req, res) => {
    if (!pinValid(req)) return pinError(res);
    database.prepare('DELETE FROM registrations').run(); setCounter(0); return res.json({ ok: true });
  });
  app.get('/api/settings', (_req, res) => res.json(settingsPayload(getSettings())));
  app.post('/api/settings', (req, res) => {
    if (!pinValid(req)) return pinError(res);
    const settings = getSettings(); for (const key of ['title', 'subtitle', 'address', 'date_from', 'date_to', 'background']) if (Object.hasOwn(req.body || {}, key)) settings[key] = String(req.body[key]).trim();
    database.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('settings',?)").run(JSON.stringify(settings));
    return res.json({ ok: true, settings: settingsPayload(settings) });
  });
  app.post('/api/logo', upload.single('logo'), (req, res) => {
    if (!pinValid(req)) return pinError(res); if (!req.file?.buffer.length) return jsonError(res, 'લોગો ફાઈલ પસંદ કરો.');
    require('node:fs').writeFileSync(path.join(STATIC_DIR, 'logo.png'), req.file.buffer); return res.json({ ok: true, logo: '/logo.png' });
  });
  app.post('/api/background', upload.single('background'), (req, res) => {
    if (!pinValid(req)) return pinError(res); if (!req.file?.buffer.length) return jsonError(res, 'બેકગ્રાઉન્ડ ફાઈલ પસંદ કરો.');
    require('node:fs').writeFileSync(path.join(STATIC_DIR, 'background.png'), req.file.buffer); return res.json({ ok: true, background: '/background.png' });
  });
  app.get('/api/stats', (_req, res) => {
    const total = database.prepare('SELECT COUNT(*) AS n FROM registrations').get().n;
    const bahin = database.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(fee),0) AS f FROM registrations WHERE gender='bahin'").get();
    const bhai = database.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(fee),0) AS f FROM registrations WHERE gender='bhai'").get();
    return res.json({ total, bahin: bahin.n, bahin_fee: bahin.f, bhai: bhai.n, bhai_fee: bhai.f, total_fee: bahin.f + bhai.f });
  });
  app.get('/api/export.csv', (_req, res) => {
    const rows = database.prepare('SELECT * FROM registrations ORDER BY ts DESC').all();
    const headers = ['નો', 'તારીખ', 'નામ', 'લિંગ', 'જન્મ તારીખ', 'ઉમર', 'મોબાઈલ', 'કાયમી સરનામું', 'ગામ', 'તાલુકો', 'પિન', 'હાલ સરનામું', 'ગામ', 'તાલુકો', 'પિન', 'આધાર નંબર', 'ફી'];
    const lines = [headers, ...rows.map((row) => [row.no, row.date, row.name, row.gender, row.dob, row.age, row.mobile, row.k_sar, row.k_gam, row.k_tal, row.k_pin, row.h_sar, row.h_gam, row.h_tal, row.h_pin, row.aadhar_no || '', row.fee])].map((line) => line.map(csvField).join(',')).join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8').attachment('navratri_registrations.csv').send(`\uFEFF${lines}`);
  });
  app.get('/api/export.xlsx', async (_req, res, next) => {
    try {
      const rows = database.prepare('SELECT * FROM registrations ORDER BY ts DESC').all(); const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Registrations');
      sheet.addRow(['નો.', 'તારીખ', 'નામ', 'લિંગ', 'જન્મ તારીખ', 'ઉમર', 'મોબાઈલ', 'કાયમી સરનામું', 'ગામ', 'તાલુકો', 'પિન', 'હાલ સરનામું', 'ગામ', 'તાલુકો', 'પિન', 'આધાર નંબર', 'ફી']);
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8E1B2E' } }; sheet.getRow(1).alignment = { horizontal: 'center' };
      const gender = { bahin: 'બહેન', bhai: 'ભાઈ' };
      rows.forEach((row) => sheet.addRow([row.no, row.date, row.name, gender[row.gender] || row.gender, row.dob, row.age, row.mobile, row.k_sar, row.k_gam, row.k_tal, row.k_pin, row.h_sar, row.h_gam, row.h_tal, row.h_pin, row.aadhar_no || '', row.fee]));
      [14, 12, 28, 8, 12, 6, 12, 24, 14, 14, 8, 24, 14, 14, 8, 16, 8].forEach((width, index) => { sheet.getColumn(index + 1).width = width; }); sheet.views = [{ state: 'frozen', ySplit: 1 }];
      const buffer = await workbook.xlsx.writeBuffer(); res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('navratri_registrations.xlsx').send(buffer);
    } catch (error) { next(error); }
  });
  app.get('/api/export.json', (req, res) => {
    if (!pinValid(req)) return pinError(res);
    const rows = database.prepare('SELECT * FROM registrations ORDER BY ts DESC').all();
    const payload = JSON.stringify({ counter: readCounter(), ledger: rows.map((row) => rowToRecord(row, true)) }, null, 2);
    res.type('application/json; charset=utf-8').attachment('navratri_backup.json').send(payload);
  });
  app.post('/api/import', (req, res) => {
    if (!pinValid(req)) return pinError(res);
    const data = req.body || {}; if (!Array.isArray(data.ledger)) return jsonError(res, 'બેકઅપ ફાઈલ સાચી નથી.');
    const records = [];
    for (const item of data.ledger) {
      if (!item || typeof item !== 'object' || !item.no || !item.name) continue;
      const age = item.age ?? calcAge(String(item.dob || '')); if (age == null || age < 0) continue;
      const k = Array.isArray(item.k) ? item.k : []; const h = Array.isArray(item.h) ? item.h : [];
      records.push([item.no, item.date || todayIso(), item.name, item.gender || 'bhai', item.dob || '', age, item.mobile || '', ...Array.from({ length: 4 }, (_, i) => k[i] ?? null), ...Array.from({ length: 4 }, (_, i) => h[i] ?? null), item.fee ?? 50, item.ts || 0, item.photo || '', item.aadhar || '', item.aadhar_no || '']);
    }
    if (!records.length) return jsonError(res, 'બેકઅપ ફાઈલમાં કોઈ લાયક રેકોર્ડ નથી.');
    const replace = database.prepare('INSERT OR REPLACE INTO registrations (no,date,name,gender,dob,age,mobile,k_sar,k_gam,k_tal,k_pin,h_sar,h_gam,h_tal,h_pin,fee,ts,photo,aadhar,aadhar_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const transaction = database.transaction(() => { database.prepare('DELETE FROM registrations').run(); records.forEach((record) => replace.run(...record)); const maxNumber = Math.max(0, ...records.map((record) => { const tail = String(record[0]).split('-').at(-1); return /^\d+$/.test(tail) ? Number(tail) : 0; })); const given = Number.parseInt(data.counter || '0', 10) || 0; setCounter(Math.max(maxNumber, given)); });
    transaction(); return res.json({ ok: true, count: records.length });
  });

  app.use((error, _req, res, _next) => { console.error(error); res.status(error instanceof multer.MulterError ? 400 : 500).json({ ok: false, error: error instanceof multer.MulterError ? error.message : 'Internal server error' }); });
  app.locals.database = database;
  return app;
}

if (require.main === module) {
  const app = createNavratriApp(); const port = Number(process.env.NAVRATRI_PORT || 5000);
  app.listen(port, '0.0.0.0', () => console.log(`Navratri Garba Pass server -> http://0.0.0.0:${port}`));
}

module.exports = { createNavratriApp, openDatabase, rowToRecord, hashPassword, calcAge, syncSupabaseRecord };
