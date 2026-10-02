const path = require('node:path');
const Database = require('better-sqlite3');
const ExcelJS = require('exceljs');
const express = require('express');
const multer = require('multer');
require('dotenv').config();

const BASE_DIR = __dirname;
const STATIC_DIR = path.join(BASE_DIR, 'salary');
const DEFAULT_DB_PATH = path.join(BASE_DIR, 'salary_data.db');
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function openDatabase(dbPath = process.env.SALARY_DB_PATH || DEFAULT_DB_PATH) {
	const database = new Database(dbPath);
	database.pragma('foreign_keys = ON');
	database.exec(`
		CREATE TABLE IF NOT EXISTS departments (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL UNIQUE,
			code TEXT NOT NULL UNIQUE,
			head_name TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active'
		);
		CREATE TABLE IF NOT EXISTS faculties (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			employee_code TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			department_id INTEGER NOT NULL,
			designation TEXT NOT NULL DEFAULT '',
			faculty_type TEXT NOT NULL DEFAULT 'custom',
			monthly_salary NUMERIC NOT NULL CHECK(monthly_salary >= 0),
			joining_date TEXT NOT NULL DEFAULT '',
			relieving_date TEXT NOT NULL DEFAULT '',
			email TEXT NOT NULL DEFAULT '',
			mobile TEXT NOT NULL DEFAULT '',
			weekdays TEXT NOT NULL DEFAULT '[0, 1, 2, 3, 4]',
			status TEXT NOT NULL DEFAULT 'active',
			FOREIGN KEY (department_id) REFERENCES departments(id)
		);
		CREATE TABLE IF NOT EXISTS monthly_attendance (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			faculty_id INTEGER NOT NULL,
			attendance_date TEXT NOT NULL,
			is_working INTEGER NOT NULL DEFAULT 0,
			attendance_status TEXT NOT NULL DEFAULT '',
			leave_type TEXT NOT NULL DEFAULT '',
			remarks TEXT NOT NULL DEFAULT '',
			UNIQUE(faculty_id, attendance_date),
			FOREIGN KEY (faculty_id) REFERENCES faculties(id)
		);
		CREATE TABLE IF NOT EXISTS salary_records (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			faculty_id INTEGER NOT NULL,
			month INTEGER NOT NULL,
			year INTEGER NOT NULL,
			snapshot TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			UNIQUE(faculty_id, month, year),
			FOREIGN KEY (faculty_id) REFERENCES faculties(id)
		);
		CREATE TABLE IF NOT EXISTS audit_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			action TEXT NOT NULL,
			module TEXT NOT NULL,
			record_id TEXT NOT NULL,
			old_data TEXT NOT NULL DEFAULT '',
			new_data TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
	`);
	const columns = new Set(database.pragma('table_info(faculties)').map((column) => column.name));
	if (!columns.has('relieving_date')) {
		database.exec("ALTER TABLE faculties ADD COLUMN relieving_date TEXT NOT NULL DEFAULT ''");
	}
	return database;
}

function money(value) {
	return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function calculateSalary({ monthly_salary, working_days, present_days, paid_leave = 0, unpaid_leave = 0, special_present_days = 0, adjustment = 0 }) {
	const salary = Number(monthly_salary);
	const working = Number(working_days);
	const present = Number(present_days);
	const paid = Number(paid_leave);
	const unpaid = Number(unpaid_leave);
	const special = Number(special_present_days);
	const adjust = Number(adjustment || 0);
	if (![salary, working, present, paid, unpaid, special, adjust].every(Number.isFinite) || salary < 0 || adjust < 0 || ![working, present, paid, unpaid, special].every(Number.isInteger) || [working, present, paid, unpaid, special].some((value) => value < 0)) {
		throw new Error('Salary, attendance, and adjustment values must be valid non-negative numbers');
	}
	if (working <= 0) throw new Error('Working days must be greater than zero');
	if (present > working || paid > working || unpaid > working || present + paid > working) throw new Error('Present and paid days cannot exceed working days');
	const dailySalary = salary / working;
	const calculated = money(dailySalary * (present + paid + special));
	return {
		monthly_salary: money(salary), working_days: working, present_days: present + special,
		regular_present_days: present, special_present_days: special,
		absent_days: working - present - paid - unpaid, paid_leave: paid, unpaid_leave: unpaid,
		paid_days: present + paid + special, daily_salary: money(dailySalary),
		calculated_salary: calculated, adjustment: money(adjust), final_salary: money(calculated + adjust),
	};
}

function periodParts(month, year) {
	const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return { last, dates: Array.from({ length: last }, (_, index) => `${year}-${String(month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`) };
}

function weekDay(isoDate) {
	return (new Date(`${isoDate}T00:00:00Z`).getUTCDay() + 6) % 7;
}

function attendanceTotals(rows) {
	const working = rows.filter((row) => row.is_working);
	const regularPresent = working.filter((row) => row.attendance_status === 'present').length;
	const specialPresent = rows.filter((row) => !row.is_working && row.attendance_status === 'special').length;
	const paidLeave = working.filter((row) => row.attendance_status === 'leave' && row.leave_type === 'paid').length;
	const unpaidLeave = working.filter((row) => row.attendance_status === 'leave' && row.leave_type === 'unpaid').length;
	const absent = working.filter((row) => row.attendance_status === 'absent').length;
	return { working_days: working.length, present_days: regularPresent + specialPresent, regular_present_days: regularPresent, special_present_days: specialPresent, absent_days: absent, paid_leave: paidLeave, unpaid_leave: unpaidLeave };
}

function facultyObject(row) {
	return { ...row, monthly_salary: Number(row.monthly_salary), weekdays: JSON.parse(row.weekdays) };
}

async function readVisitingWorkbook(buffer) {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(buffer);
	const sheet = workbook.worksheets.find((item) => /june\s*-?\s*2026/i.test(item.name));
	const sheetName = sheet?.name;
	if (!sheetName) throw new Error('Workbook must contain a June 2026 sheet');
	const cell = (row, column) => {
		const value = sheet.getCell(row, column).value;
		if (value && typeof value === 'object') return value.result ?? value.text ?? value.richText?.map((part) => part.text).join('') ?? null;
		return value;
	};
	const heading = String(cell(4, 1) || '');
	const periodMatch = heading.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
	if (!periodMatch) throw new Error('Could not read the month and year from the June sheet');
	const day = Number(periodMatch[1]);
	const month = Number(periodMatch[2]);
	const year = Number(periodMatch[3]);
	const dateCheck = new Date(Date.UTC(year, month - 1, day));
	if (dateCheck.getUTCFullYear() !== year || dateCheck.getUTCMonth() !== month - 1 || dateCheck.getUTCDate() !== day) throw new Error('Invalid month and year in visiting sheet');
	const departmentMatch = heading.match(/Dept:\s*([^\n]+)/i);
	const department = (departmentMatch?.[1] || 'Visiting Staff').split(/\bDate\s*:/i)[0].replace(/\s+/g, ' ').replace(/^[A-Z]\.\s*/, '').trim();
	const staff = [];
	for (let row = 8; row <= sheet.rowCount; row += 1) {
		const employeeCode = String(cell(row, 1) || '').trim();
		const name = String(cell(row, 2) || '').trim();
		if (!employeeCode || !name || !/^[A-Za-z0-9-]+$/.test(employeeCode)) continue;
		const presentDays = Number(cell(row, 33));
		const workingDays = Number(cell(row, 34));
		const monthlySalary = Number(cell(row, 35));
		const sheetPayable = Number(cell(row, 36));
		if (![presentDays, workingDays, monthlySalary, sheetPayable].every(Number.isFinite) || !Number.isInteger(presentDays) || !Number.isInteger(workingDays) || presentDays < 0 || workingDays <= 0 || presentDays > workingDays || monthlySalary < 0) throw new Error(`Invalid salary or attendance values for ${name}`);
		const attendanceDates = [];
		for (let attendanceDay = 1; attendanceDay <= 31; attendanceDay += 1) {
			const marker = cell(row, attendanceDay + 2);
			if (marker === 1 || marker === '1' || marker === '1.0') {
				const validDay = new Date(Date.UTC(year, month - 1, attendanceDay));
				if (validDay.getUTCMonth() !== month - 1) throw new Error(`Attendance date ${attendanceDay} is outside ${month}/${year}`);
				attendanceDates.push(`${year}-${String(month).padStart(2, '0')}-${String(attendanceDay).padStart(2, '0')}`);
			}
		}
		if (attendanceDates.length !== presentDays) throw new Error(`Attendance marks do not match the sheet total for ${name}`);
		const normalized = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
		const nameParts = normalized(name).split(' ').filter((part) => part && !['prof', 'professor'].includes(part));
		const identity = [nameParts[0], nameParts.at(-1)];
		const weekdayPatterns = [[0, /\bmon(?:day)?\b/], [1, /\b(?:tue(?:sday)?|tuedsday)\b/], [2, /\bwed(?:nesday)?\b/], [3, /\bthu(?:rsday)?\b/], [4, /\bfri(?:day)?\b/], [5, /\bsat(?:urday)?\b/], [6, /\bsun(?:day)?\b/]];
		let weekdays;
		for (let row = 18; row <= sheet.rowCount && !weekdays; row += 1) {
			const note = Array.from({ length: sheet.actualColumnCount }, (_, column) => cell(row, column + 1)).filter((value) => value != null).join(' ');
			const normalizedNote = normalized(note);
			if (identity[0] && identity.every((part) => normalizedNote.split(' ').includes(part))) weekdays = weekdayPatterns.filter(([, pattern]) => pattern.test(normalizedNote)).map(([index]) => index);
			if (!weekdays?.length) weekdays = undefined;
		}
		if (!weekdays) weekdays = attendanceDates.length ? [...new Set(attendanceDates.map(weekDay))].sort() : [0, 1, 2, 3, 4];
		const calculation = calculateSalary({ monthly_salary: monthlySalary, working_days: workingDays, present_days: presentDays });
		if (money(calculation.final_salary) !== money(sheetPayable)) throw new Error(`Calculated pay does not match the sheet for ${name}`);
		staff.push({ employee_code: employeeCode, name, monthly_salary: monthlySalary, sheet_payable: sheetPayable, present_days: presentDays, working_days: workingDays, attendance_dates: attendanceDates, weekdays, calculation });
	}
	if (!staff.length) throw new Error('No visiting staff rows were found in the June sheet');
	if (new Set(staff.map((item) => item.employee_code)).size !== staff.length) throw new Error('The June sheet contains duplicate employee codes');
	return { month, year, department, staff };
}

function createSalaryApp({ dbPath } = {}) {
	const database = openDatabase(dbPath);
	const app = express();
	app.use(express.json({ limit: '20mb' }));
	app.use(express.static(STATIC_DIR));

	const getFaculty = database.prepare("SELECT f.*, d.name AS department_name FROM faculties f JOIN departments d ON d.id=f.department_id WHERE f.id=?");
	function ensureCalendar(facultyId, month, year) {
		const faculty = getFaculty.get(facultyId);
		if (!faculty) return { faculty: null, rows: [] };
		const { dates } = periodParts(month, year);
		const insert = database.prepare('INSERT OR IGNORE INTO monthly_attendance (faculty_id, attendance_date, is_working) VALUES (?, ?, ?)');
		const ensure = database.transaction(() => dates.forEach((attendanceDate) => insert.run(facultyId, attendanceDate, JSON.parse(faculty.weekdays).includes(weekDay(attendanceDate)) ? 1 : 0)));
		ensure();
		const rows = database.prepare('SELECT * FROM monthly_attendance WHERE faculty_id=? AND attendance_date LIKE ? ORDER BY attendance_date').all(facultyId, `${year}-${String(month).padStart(2, '0')}-%`);
		return { faculty, rows };
	}
	function syncWeekdays(facultyId, weekdays) {
		const rows = database.prepare('SELECT id, attendance_date FROM monthly_attendance WHERE faculty_id=?').all(facultyId);
		const update = database.prepare("UPDATE monthly_attendance SET is_working=?, attendance_status=CASE WHEN ?=0 AND attendance_status<>'special' THEN '' ELSE attendance_status END, leave_type=CASE WHEN ?=0 THEN '' ELSE leave_type END WHERE id=?");
		const transaction = database.transaction(() => rows.forEach((row) => { const working = weekdays.includes(weekDay(row.attendance_date)) ? 1 : 0; update.run(working, working, working, row.id); }));
		transaction();
	}
	function monthlySalaryRows(month, year) {
		const facultyRows = database.prepare("SELECT f.*, d.name AS department_name FROM faculties f JOIN departments d ON d.id=f.department_id WHERE f.status='active' ORDER BY f.employee_code COLLATE NOCASE").all();
		return facultyRows.map((faculty) => {
			const { rows } = ensureCalendar(faculty.id, month, year);
			const totals = attendanceTotals(rows);
			let salary; let error = '';
			try {
				salary = calculateSalary({ monthly_salary: faculty.monthly_salary, working_days: totals.working_days, present_days: totals.regular_present_days, paid_leave: totals.paid_leave, unpaid_leave: totals.unpaid_leave, special_present_days: totals.special_present_days });
			} catch (exception) {
				salary = { monthly_salary: Number(faculty.monthly_salary), calculated_salary: 0, final_salary: 0 };
				error = exception.message;
			}
			return { faculty_id: faculty.id, employee_code: faculty.employee_code, name: faculty.name, department: faculty.department_name, faculty_type: faculty.faculty_type, weekdays: JSON.parse(faculty.weekdays), monthly_salary: Number(salary.monthly_salary).toFixed(2), working_days: totals.working_days, present_days: totals.present_days, absent_days: totals.absent_days, paid_leave: totals.paid_leave, unpaid_leave: totals.unpaid_leave, calculated_salary: Number(salary.calculated_salary).toFixed(2), final_salary: Number(salary.final_salary).toFixed(2), error };
		});
	}
	function validPeriod(month, year) { return Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(year) && year >= 2000; }
	function jsonError(res, message, status = 400) { return res.status(status).json({ ok: false, error: message }); }

	app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Faculty Salary Management' }));
	app.get('/api/departments', (_req, res) => res.json(database.prepare("SELECT * FROM departments WHERE status='active' ORDER BY name").all()));
	app.post('/api/departments', (req, res) => {
		const name = String(req.body.name || '').trim(); const code = String(req.body.code || '').trim().toUpperCase();
		if (!name || !code) return jsonError(res, 'Department name and code are required');
		try { const result = database.prepare('INSERT INTO departments (name, code, head_name) VALUES (?, ?, ?)').run(name, code, String(req.body.head_name || '').trim()); return res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) }); }
		catch (error) { if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return jsonError(res, 'Department name or code already exists', 409); throw error; }
	});
	app.patch('/api/departments/:id', (req, res) => {
		const name = String(req.body.name || '').trim(); const code = String(req.body.code || '').trim().toUpperCase();
		if (!name || !code) return jsonError(res, 'Department name and code are required');
		try { const result = database.prepare("UPDATE departments SET name=?, code=?, head_name=? WHERE id=? AND status='active'").run(name, code, String(req.body.head_name || '').trim(), Number(req.params.id)); if (!result.changes) return jsonError(res, 'Department not found', 404); return res.json({ ok: true }); }
		catch (error) { if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return jsonError(res, 'Department name or code already exists', 409); throw error; }
	});
	app.delete('/api/departments/:id', (req, res) => {
		const id = Number(req.params.id);
		if (database.prepare("SELECT COUNT(*) AS count FROM faculties WHERE department_id=? AND status='active'").get(id).count) return jsonError(res, 'Move or delete the department faculty first', 409);
		const result = database.prepare("UPDATE departments SET status='inactive' WHERE id=? AND status='active'").run(id);
		return result.changes ? res.json({ ok: true }) : jsonError(res, 'Department not found', 404);
	});
	app.get('/api/faculties', (_req, res) => res.json(database.prepare("SELECT f.*, d.name AS department_name FROM faculties f JOIN departments d ON d.id=f.department_id WHERE f.status='active' ORDER BY f.employee_code COLLATE NOCASE").all().map(facultyObject)));
	app.get('/api/faculties/export.xlsx', async (_req, res, next) => {
		try {
			const rows = database.prepare("SELECT f.*, d.name AS department_name FROM faculties f JOIN departments d ON d.id=f.department_id WHERE f.status='active' ORDER BY f.employee_code COLLATE NOCASE").all();
			const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Faculty Master');
			sheet.addRow(['Employee Code', 'Faculty Name', 'Department', 'Designation', 'Faculty Type', 'Monthly Salary', 'Joining Date', 'Relieving Date', 'Email', 'Mobile', 'Working Weekdays', 'Status']);
			sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF116B67' } };
			rows.forEach((row) => sheet.addRow([row.employee_code, row.name, row.department_name, row.designation, row.faculty_type, Number(row.monthly_salary), row.joining_date, row.relieving_date, row.email, row.mobile, JSON.parse(row.weekdays).map((day) => DAY_NAMES[day]).join(', '), row.status]));
			sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.autoFilter = { from: 'A1', to: `L${rows.length + 1}` };
			sheet.columns.forEach((column) => { column.width = Math.min(Math.max(...column.values.map((value) => String(value || '').length)) + 2, 30); });
			const buffer = await workbook.xlsx.writeBuffer(); res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('Faculty_Master.xlsx').send(buffer);
		} catch (error) { next(error); }
	});
	app.get('/api/salary/monthly', (req, res) => {
		const month = Number(req.query.month || new Date().getMonth() + 1); const year = Number(req.query.year || new Date().getFullYear());
		if (!validPeriod(month, year)) return jsonError(res, 'Month and year are required');
		const rows = monthlySalaryRows(month, year);
		return res.json({ month, year, rows, total_payable: money(rows.reduce((total, row) => total + Number(row.final_salary), 0)).toFixed(2) });
	});
	app.get('/api/salary/visiting/latest-period', (_req, res) => {
		const row = database.prepare("SELECT r.month, r.year FROM salary_records r JOIN faculties f ON f.id=r.faculty_id WHERE f.faculty_type='visiting' ORDER BY r.year DESC, r.month DESC LIMIT 1").get();
		res.json(row || { month: null, year: null });
	});
	app.get('/api/salary/monthly/export.xlsx', async (req, res, next) => {
		try {
			const month = Number(req.query.month || new Date().getMonth() + 1); const year = Number(req.query.year || new Date().getFullYear());
			if (!validPeriod(month, year)) return jsonError(res, 'Month and year are required');
			const rows = monthlySalaryRows(month, year);
			const workbook = rows.some((row) => row.faculty_type === 'visiting') ? visitingAttendanceWorkbook(database, month, year, rows) : summaryWorkbook(month, year, rows);
			const buffer = await workbook.xlsx.writeBuffer();
			const name = rows.some((row) => row.faculty_type === 'visiting') ? `Visiting_Salary_${year}_${String(month).padStart(2, '0')}.xlsx` : `Salary_Report_${year}_${String(month).padStart(2, '0')}.xlsx`;
			res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(name).send(buffer);
		} catch (error) { next(error); }
	});
	app.post('/api/salary/visiting/import', upload.single('file'), async (req, res) => {
		if (!req.file) return jsonError(res, 'Choose a visiting salary workbook');
		try { const period = await readVisitingWorkbook(req.file.buffer); return res.json(importVisitingData(database, period)); }
		catch (error) { return jsonError(res, error.message, /finalized|belongs to another/.test(error.message) ? 409 : 400); }
	});
	app.post('/api/faculties', (req, res) => {
		const fields = ['employee_code', 'name', 'department_id', 'monthly_salary'];
		if (fields.some((field) => String(req.body[field] ?? '').trim() === '')) return jsonError(res, 'Employee code, name, department, and monthly salary are required');
		try {
			const weekdays = [...new Set((req.body.weekdays || [0, 1, 2, 3, 4]).map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b);
			const salary = Number(req.body.monthly_salary); if (!Number.isFinite(salary) || salary < 0) throw new Error();
			const result = database.prepare('INSERT INTO faculties (employee_code, name, department_id, designation, faculty_type, monthly_salary, joining_date, relieving_date, email, mobile, weekdays) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(String(req.body.employee_code).trim().toUpperCase(), String(req.body.name).trim(), Number(req.body.department_id), String(req.body.designation || '').trim(), String(req.body.faculty_type || 'custom').trim(), salary, String(req.body.joining_date || '').trim(), String(req.body.relieving_date || '').trim(), String(req.body.email || '').trim(), String(req.body.mobile || '').trim(), JSON.stringify(weekdays));
			return res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) });
		} catch (error) { if (error.code?.startsWith('SQLITE_CONSTRAINT')) return jsonError(res, 'Employee code already exists or department is invalid', 409); return jsonError(res, 'Monthly salary and weekdays must be valid'); }
	});
	app.patch('/api/faculties/:id', (req, res) => {
		const fields = ['employee_code', 'name', 'department_id', 'monthly_salary'];
		if (fields.some((field) => String(req.body[field] ?? '').trim() === '')) return jsonError(res, 'Employee code, name, department, and monthly salary are required');
		try {
			const weekdays = [...new Set((req.body.weekdays || []).map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b);
			const salary = Number(req.body.monthly_salary); if (!Number.isFinite(salary) || salary < 0) throw new Error();
			const id = Number(req.params.id);
			const result = database.prepare("UPDATE faculties SET employee_code=?, name=?, department_id=?, designation=?, faculty_type=?, monthly_salary=?, joining_date=?, relieving_date=?, email=?, mobile=?, weekdays=? WHERE id=? AND status='active'").run(String(req.body.employee_code).trim().toUpperCase(), String(req.body.name).trim(), Number(req.body.department_id), String(req.body.designation || '').trim(), String(req.body.faculty_type || 'custom').trim(), salary, String(req.body.joining_date || '').trim(), String(req.body.relieving_date || '').trim(), String(req.body.email || '').trim(), String(req.body.mobile || '').trim(), JSON.stringify(weekdays), id);
			if (!result.changes) return jsonError(res, 'Faculty member not found', 404);
			syncWeekdays(id, weekdays); return res.json({ ok: true });
		} catch (error) { if (error.code?.startsWith('SQLITE_CONSTRAINT')) return jsonError(res, 'Employee code already exists or department is invalid', 409); return jsonError(res, 'Monthly salary and weekdays must be valid'); }
	});
	app.delete('/api/faculties/:id', (req, res) => {
		const result = database.prepare("UPDATE faculties SET status='inactive' WHERE id=? AND status='active'").run(Number(req.params.id));
		return result.changes ? res.json({ ok: true }) : jsonError(res, 'Faculty member not found', 404);
	});
	app.get('/api/attendance', (req, res) => {
		const facultyId = Number(req.query.faculty_id); const month = Number(req.query.month || new Date().getMonth() + 1); const year = Number(req.query.year || new Date().getFullYear());
		if (!Number.isInteger(facultyId) || facultyId <= 0 || !validPeriod(month, year)) return jsonError(res, 'Faculty, month, and year are required');
		const { faculty, rows } = ensureCalendar(facultyId, month, year); if (!faculty) return jsonError(res, 'Faculty not found', 404);
		return res.json({ faculty: facultyObject(faculty), attendance: rows, totals: attendanceTotals(rows) });
	});
	app.put('/api/attendance/:id', (req, res) => {
		const isWorking = Number(Boolean(req.body.is_working)); const requested = String(req.body.attendance_status || '').trim().toLowerCase();
		const status = isWorking || requested === 'special' ? requested : ''; const leave = status === 'leave' ? String(req.body.leave_type || '').trim().toLowerCase() : '';
		if (!['', 'present', 'absent', 'leave', 'special'].includes(status) || (status === 'special' && isWorking) || !['', 'paid', 'unpaid'].includes(leave)) return jsonError(res, 'Attendance or leave type is invalid');
		const result = database.prepare('UPDATE monthly_attendance SET is_working=?, attendance_status=?, leave_type=?, remarks=? WHERE id=?').run(isWorking, status, leave, String(req.body.remarks || '').trim(), Number(req.params.id));
		return result.changes ? res.json({ ok: true }) : jsonError(res, 'Attendance date not found', 404);
	});
	app.post('/api/salary/calculate', (req, res) => {
		const facultyId = Number(req.body.faculty_id); const month = Number(req.body.month); const year = Number(req.body.year);
		if (!validPeriod(month, year)) return jsonError(res, 'Faculty and valid month are required');
		const { faculty, rows } = ensureCalendar(facultyId, month, year); if (!faculty) return jsonError(res, 'Faculty and valid month are required');
		const totals = attendanceTotals(rows); let salary;
		try { salary = calculateSalary({ monthly_salary: faculty.monthly_salary, adjustment: req.body.adjustment || 0, working_days: totals.working_days, present_days: totals.regular_present_days, paid_leave: totals.paid_leave, unpaid_leave: totals.unpaid_leave, special_present_days: totals.special_present_days }); }
		catch (error) { return jsonError(res, error.message); }
		const moneyKeys = new Set(['monthly_salary', 'daily_salary', 'calculated_salary', 'adjustment', 'final_salary']);
		const snapshot = Object.fromEntries(Object.entries(salary).map(([key, value]) => [key, moneyKeys.has(key) ? Number(value).toFixed(2) : String(value)]));
		database.prepare("INSERT INTO salary_records (faculty_id, month, year, snapshot) VALUES (?, ?, ?, ?) ON CONFLICT(faculty_id, month, year) DO UPDATE SET snapshot=excluded.snapshot, status='draft'").run(facultyId, month, year, JSON.stringify(snapshot));
		return res.json({ ok: true, salary: snapshot, totals });
	});
	app.post('/api/salary/:facultyId/finalize', (req, res) => {
		const month = Number(req.body.month); const year = Number(req.body.year);
		const result = database.prepare("UPDATE salary_records SET status='finalized' WHERE faculty_id=? AND month=? AND year=?").run(Number(req.params.facultyId), month, year);
		if (!result.changes) return jsonError(res, 'Calculate salary before finalizing', 409);
		database.prepare("INSERT INTO audit_logs (action, module, record_id) VALUES ('Salary finalized', 'salary', ?)").run(String(req.params.facultyId));
		return res.json({ ok: true, status: 'finalized' });
	});

	app.use((error, _req, res, _next) => {
		console.error(error);
		res.status(error instanceof multer.MulterError ? 400 : 500).json({ ok: false, error: error instanceof multer.MulterError ? error.message : 'Internal server error' });
	});
	app.locals.database = database;
	return app;
}

function importVisitingData(database, { month, year, department, staff }) {
	const transaction = database.transaction(() => {
		let dept = database.prepare("SELECT id FROM departments WHERE lower(name)=lower(?) AND status='active'").get(department);
		if (!dept) {
			const base = department.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'VISITING'; let code = base; let suffix = 1;
			while (database.prepare('SELECT 1 FROM departments WHERE code=?').get(code)) { suffix += 1; code = `${base.slice(0, 6)}${suffix}`; }
			const created = database.prepare('INSERT INTO departments (name, code) VALUES (?, ?)').run(department, code); dept = { id: Number(created.lastInsertRowid) };
		}
		const facultyIds = new Map();
		for (const person of staff) {
			const existing = database.prepare('SELECT id, name FROM faculties WHERE employee_code=?').get(person.employee_code);
			if (existing && existing.name.toLowerCase().replace(/[^a-z0-9]/g, '') !== person.name.toLowerCase().replace(/[^a-z0-9]/g, '')) throw new Error(`Employee code ${person.employee_code} belongs to another faculty member`);
			if (existing && database.prepare("SELECT 1 FROM salary_records WHERE faculty_id=? AND month=? AND year=? AND status='finalized'").get(existing.id, month, year)) throw new Error(`${person.name} has finalized salary for this period`);
			facultyIds.set(person.employee_code, existing?.id || null);
		}
		const updateFaculty = database.prepare("UPDATE faculties SET name=?, department_id=?, designation='Visiting Faculty', faculty_type='visiting', monthly_salary=?, weekdays=? WHERE id=?");
		const insertFaculty = database.prepare("INSERT INTO faculties (employee_code,name,department_id,designation,faculty_type,monthly_salary,weekdays) VALUES (?, ?, ?, 'Visiting Faculty', 'visiting', ?, ?)");
		const upsertDay = database.prepare("INSERT INTO monthly_attendance (faculty_id,attendance_date,is_working,attendance_status) VALUES (?, ?, ?, ?) ON CONFLICT(faculty_id,attendance_date) DO UPDATE SET is_working=excluded.is_working,attendance_status=excluded.attendance_status,leave_type='',remarks=''");
		const upsertSalary = database.prepare("INSERT INTO salary_records (faculty_id,month,year,snapshot,status) VALUES (?, ?, ?, ?, 'draft') ON CONFLICT(faculty_id,month,year) DO UPDATE SET snapshot=excluded.snapshot,status='draft'");
		const audit = database.prepare("INSERT INTO audit_logs (action,module,record_id,new_data) VALUES (?,'salary',?,?)");
		for (const person of staff) {
			let facultyId = facultyIds.get(person.employee_code);
			if (facultyId) updateFaculty.run(person.name, dept.id, person.monthly_salary, JSON.stringify(person.weekdays), facultyId);
			else facultyId = Number(insertFaculty.run(person.employee_code, person.name, dept.id, person.monthly_salary, JSON.stringify(person.weekdays)).lastInsertRowid);
			const presentSet = new Set(person.attendance_dates);
			const workingSet = new Set(periodParts(month, year).dates.filter((date) => person.weekdays.includes(weekDay(date))));
			presentSet.forEach((date) => workingSet.add(date));
			if (workingSet.size > person.working_days) [...workingSet].filter((date) => !presentSet.has(date)).sort().reverse().slice(0, workingSet.size - person.working_days).forEach((date) => workingSet.delete(date));
			if (workingSet.size < person.working_days) for (const date of periodParts(month, year).dates) { if (!workingSet.has(date)) workingSet.add(date); if (workingSet.size === person.working_days) break; }
			if (workingSet.size !== person.working_days) throw new Error(`Could not build the attendance calendar for ${person.name}`);
			for (const date of periodParts(month, year).dates) { const working = workingSet.has(date); upsertDay.run(facultyId, date, Number(working), presentSet.has(date) ? 'present' : working ? 'absent' : ''); }
			upsertSalary.run(facultyId, month, year, JSON.stringify(Object.fromEntries(Object.entries(person.calculation).map(([key, value]) => [key, String(value)]))));
			audit.run('Visiting salary sheet imported', String(facultyId), JSON.stringify({ month, year, payable: String(person.sheet_payable) }));
		}
	});
	try { transaction(); }
	catch (error) { if (error.code?.startsWith('SQLITE_CONSTRAINT')) throw new Error('Unable to import visiting sheet because of conflicting data'); throw error; }
	return { month, year, staff: staff.map(({ employee_code, name, monthly_salary, working_days, present_days, sheet_payable }) => ({ employee_code, name, monthly_salary: String(monthly_salary), working_days, present_days, sheet_payable: String(sheet_payable) })), total_payable: money(staff.reduce((sum, person) => sum + person.sheet_payable, 0)).toFixed(2) };
}

function summaryWorkbook(month, year, rows) {
	const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Monthly Salary');
	sheet.addRow(['Employee Code', 'Faculty Name', 'Department', 'Monthly Salary', 'Working Days', 'Present Days', 'Absent Days', 'Paid Leave', 'Unpaid Leave', 'Calculated Salary', 'Total Payable']);
	sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF116B67' } };
	rows.forEach((row) => sheet.addRow([row.employee_code, row.name, row.department, Number(row.monthly_salary), row.working_days, row.present_days, row.absent_days, row.paid_leave, row.unpaid_leave, Number(row.calculated_salary), Number(row.final_salary)]));
	sheet.addRow(['', 'TOTAL', '', '', '', '', '', '', '', '', money(rows.reduce((sum, row) => sum + Number(row.final_salary), 0))]);
	sheet.views = [{ state: 'frozen', ySplit: 1 }]; sheet.autoFilter = { from: 'A1', to: `K${rows.length + 1}` };
	sheet.columns.forEach((column) => { column.width = Math.min(Math.max(...column.values.map((value) => String(value || '').length)) + 2, 28); });
	return workbook;
}

function visitingAttendanceWorkbook(database, month, year, rows) {
	const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('Visiting Attendance');
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); const first = `01/${String(month).padStart(2, '0')}/${year}`; const last = `${String(lastDay).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
	const dayStart = 3; const dayEnd = lastDay + 2; const daysToAttend = lastDay + 3; const daysAttended = lastDay + 4; const salary = lastDay + 5; const payable = lastDay + 6; const finalCol = payable;
	const departments = [...new Set(rows.map((row) => row.department))]; const department = departments.length === 1 ? departments[0] : 'All Departments';
	const merge = (row, start, end, value, style = {}) => { sheet.mergeCells(row, start, row, end); const cell = sheet.getCell(row, start); cell.value = value; Object.assign(cell, style); return cell; };
	const center = { vertical: 'middle', horizontal: 'center', wrapText: true };
	merge(1, 1, finalCol, 'COLLEGE OF ARCHITECTURE', { font: { name: 'Times New Roman', size: 14, bold: true, underline: true }, alignment: center });
	merge(2, 1, finalCol, 'Sardar Vallabhbhai Patel Institute of Technology (S.V.I.T.) Vasad.', { font: { name: 'Times New Roman', size: 12, underline: true }, alignment: center });
	merge(3, 1, finalCol, rows.every((row) => row.faculty_type === 'visiting') ? 'Statement of Visiting Staff Attendance' : 'Statement of Faculty Attendance', { font: { name: 'Times New Roman', size: 12, bold: true }, alignment: center });
	merge(4, 1, 2, `Month: - ${first} To ${last}`, { alignment: { vertical: 'middle' } });
	merge(4, dayStart, dayEnd, `Dept: ${department}`, { font: { bold: true }, alignment: center });
	merge(4, daysToAttend, payable, `Date: ${last}`, { alignment: { vertical: 'middle', horizontal: 'right' } });
	sheet.mergeCells(5, 1, 7, 1); sheet.mergeCells(5, 2, 7, 2); sheet.mergeCells(5, dayStart, 5, dayEnd);
	sheet.getCell(5, 1).value = 'Emp.\nCode'; sheet.getCell(5, 2).value = 'Name of\nVisiting Staff'; sheet.getCell(5, dayStart).value = "Date's of Attendance";
	for (const [column, value] of [[daysToAttend, "Day's to\nattend"], [daysAttended, "Day's attended\nduring the month"], [salary, 'Salary'], [payable, 'Total salary\nfor pay']]) { sheet.mergeCells(5, column, 7, column); sheet.getCell(5, column).value = value; }
	for (let day = 1; day <= lastDay; day += 1) { const date = new Date(Date.UTC(year, month - 1, day)); sheet.getCell(6, dayStart + day - 1).value = day; sheet.getCell(7, dayStart + day - 1).value = date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }); }
	for (let r = 5; r <= 7; r += 1) for (let c = 1; c <= finalCol; c += 1) { const cell = sheet.getCell(r, c); cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBE7' } }; cell.font = { name: 'Arial', size: 9, bold: true }; cell.alignment = center; cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }; }
	const attendanceQuery = database.prepare('SELECT attendance_date,is_working,attendance_status FROM monthly_attendance WHERE faculty_id=? AND attendance_date LIKE ?');
	rows.forEach((item, index) => {
		const rowNumber = index + 8; const attendance = new Map(attendanceQuery.all(item.faculty_id, `${year}-${String(month).padStart(2, '0')}-%`).map((entry) => [Number(entry.attendance_date.slice(-2)), entry]));
		for (const [column, value] of [[1, item.employee_code], [2, item.name], [daysToAttend, item.present_days], [daysAttended, item.working_days], [salary, Number(item.monthly_salary)], [payable, Number(item.final_salary)]]) { const cell = sheet.getCell(rowNumber, column); cell.value = value; cell.alignment = { vertical: 'middle', horizontal: column < 3 ? 'left' : 'center', wrapText: true }; cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }; }
		for (let day = 1; day <= lastDay; day += 1) { const entry = attendance.get(day); const cell = sheet.getCell(rowNumber, dayStart + day - 1); if (['present', 'special'].includes(entry?.attendance_status)) cell.value = 1; cell.alignment = center; cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }; if (entry?.attendance_status === 'special') cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF0BF' } }; else if (!entry?.is_working) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } }; }
	});
	const totalRow = rows.length + 8; sheet.mergeCells(totalRow, 1, totalRow, payable - 1); sheet.getCell(totalRow, 1).value = `TOTAL ${department.toUpperCase()} DEPT. VISITING STAFF SALARY RS.`; sheet.getCell(totalRow, payable).value = money(rows.reduce((sum, row) => sum + Number(row.final_salary), 0));
	for (let column = 1; column <= finalCol; column += 1) { const cell = sheet.getCell(totalRow, column); cell.font = { bold: true }; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBE7' } }; cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } }; }
	const signatureRow = totalRow + 4; merge(signatureRow, 2, Math.min(5, finalCol), 'Authorized Signatory\nCollege of Architecture\nSVIT - Vasad');
	sheet.getColumn(1).width = 12; sheet.getColumn(2).width = 30; for (let column = dayStart; column <= dayEnd; column += 1) sheet.getColumn(column).width = 4.5;
	[[daysToAttend, 12], [daysAttended, 15], [salary, 13], [payable, 15]].forEach(([column, width]) => { sheet.getColumn(column).width = width; });
	[[1, 24], [2, 22], [3, 22], [4, 24], [5, 36], [6, 22], [7, 26]].forEach(([row, height]) => { sheet.getRow(row).height = height; });
	sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 7 }]; sheet.autoFilter = { from: 'A5', to: `${sheet.getColumn(finalCol).letter}${totalRow - 1}` };
	sheet.pageSetup = { orientation: 'landscape', paperSize: 8, fitToPage: true, fitToWidth: 1, fitToHeight: 1, margins: { left: 0.2, right: 0.2, top: 0.35, bottom: 0.35, header: 0.15, footer: 0.15 } };
	sheet.pageSetup.printArea = `A1:${sheet.getColumn(finalCol).letter}${signatureRow + 2}`;
	return workbook;
}

if (require.main === module) {
	const app = createSalaryApp(); const port = Number(process.env.SALARY_PORT || 5001);
	app.listen(port, '0.0.0.0', () => console.log(`Faculty Salary Management -> http://0.0.0.0:${port}`));
}

module.exports = { createSalaryApp, calculateSalary, attendanceTotals, readVisitingWorkbook, openDatabase };
