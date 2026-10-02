'use strict';

const ExcelJS = require('exceljs');
const express = require('express');
const multer = require('multer');
const { createSupabaseClient } = require('./supabase-client');
const {
  calculateSalary,
  attendanceTotals,
  readVisitingWorkbook,
  periodParts,
  weekDay,
  money,
  summaryWorkbook,
  visitingAttendanceWorkbook,
} = require('./salary-server');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function validPeriod(month, year) {
  return Number.isInteger(month) && month >= 1 && month <= 12 && Number.isInteger(year) && year >= 2000;
}

function dateRange(month, year) {
  const { last, dates } = periodParts(month, year);
  return { first: dates[0], last: `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`, dates };
}

function normalizeWeekdays(value) {
  if (Array.isArray(value)) return value.map(Number);
  try { return JSON.parse(value || '[]').map(Number); }
  catch { return []; }
}

function facultyObject(row, departmentName = '') {
  return {
    ...row,
    department_name: departmentName,
    monthly_salary: Number(row.monthly_salary),
    weekdays: normalizeWeekdays(row.weekdays),
  };
}

function jsonError(res, message, status = 400) {
  return res.status(status).json({ ok: false, error: message });
}

function createSupabaseSalaryApp({ supabase = createSupabaseClient() } = {}) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  const select = (table, query) => supabase.select(table, { select: '*', ...query });
  const one = async (table, query) => (await select(table, { ...query, limit: '1' }))[0] || null;
  const getDepartments = () => select('departments', { status: 'eq.active', order: 'name.asc' });

  async function facultyWithDepartment(id, activeOnly = true) {
    const query = { id: `eq.${id}` };
    if (activeOnly) query.status = 'eq.active';
    const faculty = await one('faculties', query);
    if (!faculty) return null;
    const department = await one('departments', { id: `eq.${faculty.department_id}` });
    return facultyObject(faculty, department?.name || '');
  }

  async function facultyList() {
    const [faculties, departments] = await Promise.all([
      select('faculties', { status: 'eq.active', order: 'employee_code.asc' }),
      getDepartments(),
    ]);
    const departmentNames = new Map(departments.map((row) => [row.id, row.name]));
    return faculties.map((faculty) => facultyObject(faculty, departmentNames.get(faculty.department_id) || ''));
  }

  async function ensureCalendar(faculty, month, year) {
    const { first, last, dates } = dateRange(month, year);
    let rows = await select('monthly_attendance', {
      faculty_id: `eq.${faculty.id}`,
      attendance_date: `gte.${first}`,
      and: `(attendance_date.lte.${last})`,
      order: 'attendance_date.asc',
    });
    const existingDates = new Set(rows.map((row) => row.attendance_date));
    const weekdays = normalizeWeekdays(faculty.weekdays);
    const missing = dates.filter((date) => !existingDates.has(date)).map((date) => {
      const working = weekdays.includes(weekDay(date));
      return { faculty_id: faculty.id, attendance_date: date, is_working: Number(working), attendance_status: '', leave_type: '', remarks: '' };
    });
    if (missing.length) {
      await supabase.upsert('monthly_attendance', missing, 'faculty_id,attendance_date');
      rows = await select('monthly_attendance', {
        faculty_id: `eq.${faculty.id}`,
        attendance_date: `gte.${first}`,
        and: `(attendance_date.lte.${last})`,
        order: 'attendance_date.asc',
      });
    }
    return rows;
  }

  async function monthlyRows(month, year) {
    const faculties = await facultyList();
    const rows = [];
    for (const faculty of faculties) {
      const attendance = await ensureCalendar(faculty, month, year);
      const totals = attendanceTotals(attendance);
      let salary;
      let error = '';
      try {
        salary = calculateSalary({
          monthly_salary: faculty.monthly_salary,
          working_days: totals.working_days,
          present_days: totals.regular_present_days,
          paid_leave: totals.paid_leave,
          unpaid_leave: totals.unpaid_leave,
          special_present_days: totals.special_present_days,
        });
      } catch (exception) {
        salary = { monthly_salary: Number(faculty.monthly_salary), calculated_salary: 0, final_salary: 0 };
        error = exception.message;
      }
      rows.push({
        faculty_id: faculty.id,
        employee_code: faculty.employee_code,
        name: faculty.name,
        department: faculty.department_name,
        faculty_type: faculty.faculty_type,
        weekdays: faculty.weekdays,
        monthly_salary: Number(salary.monthly_salary).toFixed(2),
        working_days: totals.working_days,
        present_days: totals.present_days,
        absent_days: totals.absent_days,
        paid_leave: totals.paid_leave,
        unpaid_leave: totals.unpaid_leave,
        calculated_salary: Number(salary.calculated_salary).toFixed(2),
        final_salary: Number(salary.final_salary).toFixed(2),
        error,
        attendance,
      });
    }
    return rows;
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Faculty Salary Management', database: 'supabase' }));
  app.get('/api/departments', async (_req, res) => res.json(await getDepartments()));
  app.post('/api/departments', async (req, res) => {
    const name = String(req.body.name || '').trim();
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!name || !code) return jsonError(res, 'Department name and code are required');
    const [row] = await supabase.insert('departments', [{ name, code, head_name: String(req.body.head_name || '').trim() }]);
    return res.status(201).json({ ok: true, id: row.id });
  });
  app.patch('/api/departments/:id', async (req, res) => {
    const name = String(req.body.name || '').trim();
    const code = String(req.body.code || '').trim().toUpperCase();
    if (!name || !code) return jsonError(res, 'Department name and code are required');
    const rows = await supabase.update('departments', { id: `eq.${Number(req.params.id)}`, status: 'eq.active' }, { name, code, head_name: String(req.body.head_name || '').trim() });
    if (!rows.length) return jsonError(res, 'Department not found', 404);
    return res.json({ ok: true });
  });
  app.delete('/api/departments/:id', async (req, res) => {
    const id = Number(req.params.id);
    const attached = await select('faculties', { department_id: `eq.${id}`, status: 'eq.active', select: 'id', limit: '1' });
    if (attached.length) return jsonError(res, 'Move or delete the department faculty first', 409);
    const rows = await supabase.update('departments', { id: `eq.${id}`, status: 'eq.active' }, { status: 'inactive' });
    return rows.length ? res.json({ ok: true }) : jsonError(res, 'Department not found', 404);
  });
  app.get('/api/faculties', async (_req, res) => res.json(await facultyList()));
  app.get('/api/faculties/export.xlsx', async (_req, res) => {
    const faculties = await facultyList();
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Faculty Master');
    sheet.addRow(['Employee Code', 'Faculty Name', 'Department', 'Designation', 'Faculty Type', 'Monthly Salary', 'Joining Date', 'Relieving Date', 'Email', 'Mobile', 'Working Weekdays', 'Status']);
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF116B67' } };
    faculties.forEach((row) => sheet.addRow([row.employee_code, row.name, row.department_name, row.designation, row.faculty_type, row.monthly_salary, row.joining_date, row.relieving_date, row.email, row.mobile, row.weekdays.map((day) => DAY_NAMES[day]).join(', '), row.status]));
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: `L${faculties.length + 1}` };
    sheet.columns.forEach((column) => { column.width = Math.min(Math.max(...column.values.map((value) => String(value || '').length)) + 2, 30); });
    const buffer = await workbook.xlsx.writeBuffer();
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('Faculty_Master.xlsx').send(buffer);
  });
  app.get('/api/salary/monthly', async (req, res) => {
    const month = Number(req.query.month || new Date().getMonth() + 1);
    const year = Number(req.query.year || new Date().getFullYear());
    if (!validPeriod(month, year)) return jsonError(res, 'Month and year are required');
    const rows = await monthlyRows(month, year);
    const publicRows = rows.map(({ attendance, ...row }) => row);
    const total = money(publicRows.reduce((sum, row) => sum + Number(row.final_salary), 0)).toFixed(2);
    return res.json({ month, year, rows: publicRows, total_payable: total });
  });
  app.get('/api/salary/visiting/latest-period', async (_req, res) => {
    const [faculty, records] = await Promise.all([
      select('faculties', { select: 'id,faculty_type', faculty_type: 'eq.visiting', status: 'eq.active' }),
      select('salary_records', { select: 'faculty_id,month,year', order: 'year.desc,month.desc', limit: '1000' }),
    ]);
    const visitingIds = new Set(faculty.map((row) => row.id));
    const latest = records.find((row) => visitingIds.has(row.faculty_id));
    return res.json(latest ? { month: latest.month, year: latest.year } : { month: null, year: null });
  });
  app.get('/api/salary/monthly/export.xlsx', async (req, res) => {
    const month = Number(req.query.month || new Date().getMonth() + 1);
    const year = Number(req.query.year || new Date().getFullYear());
    if (!validPeriod(month, year)) return jsonError(res, 'Month and year are required');
    const rowsWithAttendance = await monthlyRows(month, year);
    const rows = rowsWithAttendance.map(({ attendance, ...row }) => row);
    const visiting = rows.some((row) => row.faculty_type === 'visiting');
    let workbook;
    if (visiting) {
      const attendanceByFaculty = new Map(rowsWithAttendance.map((row) => [row.faculty_id, row.attendance]));
      const databaseAdapter = { prepare: () => ({ all: (facultyId) => attendanceByFaculty.get(facultyId) || [] }) };
      workbook = visitingAttendanceWorkbook(databaseAdapter, month, year, rows);
    } else workbook = summaryWorkbook(month, year, rows);
    const buffer = await workbook.xlsx.writeBuffer();
    const name = visiting ? `Visiting_Salary_${year}_${String(month).padStart(2, '0')}.xlsx` : `Salary_Report_${year}_${String(month).padStart(2, '0')}.xlsx`;
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(name).send(buffer);
  });
  app.post('/api/salary/visiting/import', upload.single('file'), async (req, res) => {
    if (!req.file) return jsonError(res, 'Choose a visiting salary workbook');
    try {
      const period = await readVisitingWorkbook(req.file.buffer);
      const result = await importVisitingData(supabase, period);
      return res.json(result);
    } catch (error) {
      return jsonError(res, error.message, /finalized|belongs to another/.test(error.message) ? 409 : 400);
    }
  });
  app.post('/api/faculties', async (req, res) => {
    const required = ['employee_code', 'name', 'department_id', 'monthly_salary'];
    if (required.some((field) => String(req.body[field] ?? '').trim() === '')) return jsonError(res, 'Employee code, name, department, and monthly salary are required');
    const salary = Number(req.body.monthly_salary);
    if (!Number.isFinite(salary) || salary < 0) return jsonError(res, 'Monthly salary and weekdays must be valid');
    const weekdays = [...new Set((req.body.weekdays || [0, 1, 2, 3, 4]).map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b);
    const [row] = await supabase.insert('faculties', [{
      employee_code: String(req.body.employee_code).trim().toUpperCase(),
      name: String(req.body.name).trim(),
      department_id: Number(req.body.department_id),
      designation: String(req.body.designation || '').trim(),
      faculty_type: String(req.body.faculty_type || 'custom').trim(),
      monthly_salary: salary,
      joining_date: String(req.body.joining_date || '').trim(),
      relieving_date: String(req.body.relieving_date || '').trim(),
      email: String(req.body.email || '').trim(),
      mobile: String(req.body.mobile || '').trim(),
      weekdays: JSON.stringify(weekdays),
    }]);
    return res.status(201).json({ ok: true, id: row.id });
  });
  app.patch('/api/faculties/:id', async (req, res) => {
    const required = ['employee_code', 'name', 'department_id', 'monthly_salary'];
    if (required.some((field) => String(req.body[field] ?? '').trim() === '')) return jsonError(res, 'Employee code, name, department, and monthly salary are required');
    const salary = Number(req.body.monthly_salary);
    if (!Number.isFinite(salary) || salary < 0) return jsonError(res, 'Monthly salary and weekdays must be valid');
    const id = Number(req.params.id);
    const weekdays = [...new Set((req.body.weekdays || []).map(Number))].filter((day) => Number.isInteger(day) && day >= 0 && day <= 6).sort((a, b) => a - b);
    const rows = await supabase.update('faculties', { id: `eq.${id}`, status: 'eq.active' }, {
      employee_code: String(req.body.employee_code).trim().toUpperCase(),
      name: String(req.body.name).trim(),
      department_id: Number(req.body.department_id),
      designation: String(req.body.designation || '').trim(),
      faculty_type: String(req.body.faculty_type || 'custom').trim(),
      monthly_salary: salary,
      joining_date: String(req.body.joining_date || '').trim(),
      relieving_date: String(req.body.relieving_date || '').trim(),
      email: String(req.body.email || '').trim(),
      mobile: String(req.body.mobile || '').trim(),
      weekdays: JSON.stringify(weekdays),
    });
    if (!rows.length) return jsonError(res, 'Faculty member not found', 404);
    await syncWeekdays(supabase, id, weekdays);
    return res.json({ ok: true });
  });
  app.delete('/api/faculties/:id', async (req, res) => {
    const rows = await supabase.update('faculties', { id: `eq.${Number(req.params.id)}`, status: 'eq.active' }, { status: 'inactive' });
    return rows.length ? res.json({ ok: true }) : jsonError(res, 'Faculty member not found', 404);
  });
  app.get('/api/attendance', async (req, res) => {
    const facultyId = Number(req.query.faculty_id);
    const month = Number(req.query.month || new Date().getMonth() + 1);
    const year = Number(req.query.year || new Date().getFullYear());
    if (!Number.isInteger(facultyId) || facultyId <= 0 || !validPeriod(month, year)) return jsonError(res, 'Faculty, month, and year are required');
    const faculty = await facultyWithDepartment(facultyId);
    if (!faculty) return jsonError(res, 'Faculty not found', 404);
    const attendance = await ensureCalendar(faculty, month, year);
    return res.json({ faculty, attendance, totals: attendanceTotals(attendance) });
  });
  app.put('/api/attendance/:id', async (req, res) => {
    const isWorking = Number(Boolean(req.body.is_working));
    const requested = String(req.body.attendance_status || '').trim().toLowerCase();
    const status = isWorking || requested === 'special' ? requested : '';
    const leave = status === 'leave' ? String(req.body.leave_type || '').trim().toLowerCase() : '';
    if (!['', 'present', 'absent', 'leave', 'special'].includes(status) || (status === 'special' && isWorking) || !['', 'paid', 'unpaid'].includes(leave)) return jsonError(res, 'Attendance or leave type is invalid');
    const rows = await supabase.update('monthly_attendance', { id: `eq.${Number(req.params.id)}` }, {
      is_working: isWorking,
      attendance_status: status,
      leave_type: leave,
      remarks: String(req.body.remarks || '').trim(),
    });
    return rows.length ? res.json({ ok: true }) : jsonError(res, 'Attendance date not found', 404);
  });
  app.post('/api/salary/calculate', async (req, res) => {
    const facultyId = Number(req.body.faculty_id);
    const month = Number(req.body.month);
    const year = Number(req.body.year);
    if (!validPeriod(month, year)) return jsonError(res, 'Faculty and valid month are required');
    const faculty = await facultyWithDepartment(facultyId);
    if (!faculty) return jsonError(res, 'Faculty and valid month are required');
    const attendance = await ensureCalendar(faculty, month, year);
    const totals = attendanceTotals(attendance);
    let salary;
    try {
      salary = calculateSalary({
        monthly_salary: faculty.monthly_salary,
        adjustment: req.body.adjustment || 0,
        working_days: totals.working_days,
        present_days: totals.regular_present_days,
        paid_leave: totals.paid_leave,
        unpaid_leave: totals.unpaid_leave,
        special_present_days: totals.special_present_days,
      });
    } catch (error) {
      return jsonError(res, error.message);
    }
    const moneyKeys = new Set(['monthly_salary', 'daily_salary', 'calculated_salary', 'adjustment', 'final_salary']);
    const snapshot = Object.fromEntries(Object.entries(salary).map(([key, value]) => [key, moneyKeys.has(key) ? Number(value).toFixed(2) : String(value)]));
    await supabase.upsert('salary_records', [{ faculty_id: facultyId, month, year, snapshot: JSON.stringify(snapshot), status: 'draft' }], 'faculty_id,month,year');
    return res.json({ ok: true, salary: snapshot, totals });
  });
  app.post('/api/salary/:facultyId/finalize', async (req, res) => {
    const month = Number(req.body.month);
    const year = Number(req.body.year);
    const rows = await supabase.update('salary_records', { faculty_id: `eq.${Number(req.params.facultyId)}`, month: `eq.${month}`, year: `eq.${year}` }, { status: 'finalized' });
    if (!rows.length) return jsonError(res, 'Calculate salary before finalizing', 409);
    await supabase.insert('audit_logs', [{ action: 'Salary finalized', module: 'salary', record_id: String(req.params.facultyId) }]);
    return res.json({ ok: true, status: 'finalized' });
  });

  app.use(async (error, _req, res, _next) => {
    const status = Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500;
    if (status >= 500) console.error('Salary API request failed:', error.message);
    const message = status >= 500 ? 'Salary service is unavailable. Check Supabase configuration and table permissions.' : error.message;
    return jsonError(res, message, status);
  });
  return app;
}

async function syncWeekdays(supabase, facultyId, weekdays) {
  const rows = await supabase.select('monthly_attendance', { select: 'id,attendance_date,attendance_status', faculty_id: `eq.${facultyId}` });
  for (const row of rows) {
    const working = weekdays.includes(weekDay(row.attendance_date));
    const attendanceStatus = !working && row.attendance_status !== 'special' ? '' : row.attendance_status;
    await supabase.update('monthly_attendance', { id: `eq.${row.id}` }, {
      is_working: Number(working),
      attendance_status: attendanceStatus,
      leave_type: !working ? '' : undefined,
    });
  }
}

async function importVisitingData(supabase, { month, year, department, staff }) {
  const departments = await supabase.select('departments', { select: '*', status: 'eq.active' });
  let departmentRow = departments.find((item) => item.name.toLowerCase() === department.toLowerCase());
  if (!departmentRow) {
    const base = department.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'VISITING';
    const usedCodes = new Set(departments.map((item) => item.code));
    let code = base;
    let suffix = 1;
    while (usedCodes.has(code)) { suffix += 1; code = `${base.slice(0, 6)}${suffix}`; }
    [departmentRow] = await supabase.insert('departments', [{ name: department, code }]);
  }

  const upsertFaculty = [];
  const byEmployeeCode = new Map();
  for (const person of staff) {
    const existing = await supabase.select('faculties', { select: '*', employee_code: `eq.${person.employee_code}`, limit: '1' });
    const faculty = existing[0];
    if (faculty && faculty.name.toLowerCase().replace(/[^a-z0-9]/g, '') !== person.name.toLowerCase().replace(/[^a-z0-9]/g, '')) throw new Error(`Employee code ${person.employee_code} belongs to another faculty member`);
    if (faculty) {
      const finalized = await supabase.select('salary_records', { select: 'id', faculty_id: `eq.${faculty.id}`, month: `eq.${month}`, year: `eq.${year}`, status: 'eq.finalized', limit: '1' });
      if (finalized.length) throw new Error(`${person.name} has finalized salary for this period`);
    }
    upsertFaculty.push({
      ...(faculty ? { id: faculty.id } : {}),
      employee_code: person.employee_code,
      name: person.name,
      department_id: departmentRow.id,
      designation: 'Visiting Faculty',
      faculty_type: 'visiting',
      monthly_salary: person.monthly_salary,
      weekdays: JSON.stringify(person.weekdays),
      status: 'active',
    });
    byEmployeeCode.set(person.employee_code, person);
  }
  const savedFaculties = await supabase.upsert('faculties', upsertFaculty, 'employee_code');
  const facultyByCode = new Map(savedFaculties.map((row) => [row.employee_code, row]));
  const attendanceRows = [];
  const salaryRows = [];
  const auditRows = [];
  const dates = periodParts(month, year).dates;
  for (const person of staff) {
    const faculty = facultyByCode.get(person.employee_code);
    if (!faculty) throw new Error(`Could not save faculty ${person.name}`);
    const presentDates = new Set(person.attendance_dates);
    const workingDates = new Set(dates.filter((date) => person.weekdays.includes(weekDay(date))));
    presentDates.forEach((date) => workingDates.add(date));
    if (workingDates.size > person.working_days) [...workingDates].filter((date) => !presentDates.has(date)).sort().reverse().slice(0, workingDates.size - person.working_days).forEach((date) => workingDates.delete(date));
    if (workingDates.size < person.working_days) for (const date of dates) { if (!workingDates.has(date)) workingDates.add(date); if (workingDates.size === person.working_days) break; }
    if (workingDates.size !== person.working_days) throw new Error(`Could not build the attendance calendar for ${person.name}`);
    for (const date of dates) {
      const working = workingDates.has(date);
      attendanceRows.push({ faculty_id: faculty.id, attendance_date: date, is_working: Number(working), attendance_status: presentDates.has(date) ? 'present' : working ? 'absent' : '', leave_type: '', remarks: '' });
    }
    const snapshot = Object.fromEntries(Object.entries(person.calculation).map(([key, value]) => [key, String(value)]));
    salaryRows.push({ faculty_id: faculty.id, month, year, snapshot: JSON.stringify(snapshot), status: 'draft' });
    auditRows.push({ action: 'Visiting salary sheet imported', module: 'salary', record_id: String(faculty.id), new_data: JSON.stringify({ month, year, payable: String(person.sheet_payable) }) });
  }
  await supabase.upsert('monthly_attendance', attendanceRows, 'faculty_id,attendance_date');
  await supabase.upsert('salary_records', salaryRows, 'faculty_id,month,year');
  await supabase.insert('audit_logs', auditRows);
  return {
    month,
    year,
    staff: staff.map(({ employee_code, name, monthly_salary, working_days, present_days, sheet_payable }) => ({ employee_code, name, monthly_salary: String(monthly_salary), working_days, present_days, sheet_payable })),
    total_payable: money(staff.reduce((sum, person) => sum + person.sheet_payable, 0)).toFixed(2),
  };
}

module.exports = { createSupabaseSalaryApp, dateRange, facultyObject, importVisitingData, syncWeekdays };
