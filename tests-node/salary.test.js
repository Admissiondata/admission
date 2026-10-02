const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const request = require('supertest');
const ExcelJS = require('exceljs');
const { createSalaryApp } = require('../salary-server');

function testClient(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-node-'));
  const app = createSalaryApp({ dbPath: path.join(directory, 'salary.db') });
  t.after(() => {
    app.locals.database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return request(app);
}

function workbookResponse() {
  return (response, callback) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => callback(null, Buffer.concat(chunks)));
  };
}

test('faculty CRUD persists employment dates and orders by employee code', async (t) => {
  const client = testClient(t);
  const department = await client.post('/api/departments').send({ name: 'Architecture', code: 'ARC' }).expect(201);
  await client.post('/api/faculties').send({ employee_code: 'Z9', name: 'A Faculty', department_id: department.body.id, monthly_salary: 20000, joining_date: '2020-01-01' }).expect(201);
  const created = await client.post('/api/faculties').send({ employee_code: 'A2', name: 'Z Faculty', department_id: department.body.id, monthly_salary: 18000 }).expect(201);
  await client.patch(`/api/faculties/${created.body.id}`).send({ employee_code: 'A2', name: 'Z Faculty', department_id: department.body.id, monthly_salary: 18000, joining_date: '2021-02-03', relieving_date: '2026-09-30', weekdays: [0] }).expect(200);

  const faculties = await client.get('/api/faculties').expect(200);
  assert.deepEqual(faculties.body.map((row) => row.employee_code), ['A2', 'Z9']);
  assert.equal(faculties.body[0].joining_date, '2021-02-03');
  assert.equal(faculties.body[0].relieving_date, '2026-09-30');
});

test('special attendance on an off-day increments present and adds one daily rate', async (t) => {
  const client = testClient(t);
  const department = await client.post('/api/departments').send({ name: 'Design', code: 'DES' });
  const faculty = await client.post('/api/faculties').send({ employee_code: 'EMP01', name: 'Faculty', department_id: department.body.id, monthly_salary: 20000, weekdays: [0] });
  const calendar = await client.get(`/api/attendance?faculty_id=${faculty.body.id}&month=6&year=2026`);
  const sunday = calendar.body.attendance.find((row) => row.attendance_date === '2026-06-07');
  assert.equal(sunday.is_working, 0);

  await client.put(`/api/attendance/${sunday.id}`).send({ is_working: false, attendance_status: 'special' }).expect(200);
  const updated = await client.get(`/api/attendance?faculty_id=${faculty.body.id}&month=6&year=2026`);
  assert.equal(updated.body.totals.working_days, 5);
  assert.equal(updated.body.totals.present_days, 1);
  const payroll = await client.post('/api/salary/calculate').send({ faculty_id: faculty.body.id, month: 6, year: 2026 }).expect(200);
  assert.equal(payroll.body.salary.calculated_salary, '4000.00');
});

test('June visiting sheet imports and exports the attendance matrix', async (t) => {
  const client = testClient(t);
  const source = path.join(__dirname, '..', 'Visiting Salary Sheet.xlsx');
  const imported = await client.post('/api/salary/visiting/import').attach('file', source).expect(200);
  assert.equal(imported.body.total_payable, '87000.00');
  assert.equal(imported.body.staff.length, 4);

  const response = await client.get('/api/salary/monthly/export.xlsx?month=6&year=2026').buffer(true).parse(workbookResponse()).expect(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(response.body);
  const sheet = workbook.getWorksheet('Visiting Attendance');
  assert.equal(sheet.getCell('A1').value, 'COLLEGE OF ARCHITECTURE');
  assert.equal(sheet.getCell('A3').value, 'Statement of Visiting Staff Attendance');
  assert.equal(sheet.getCell('D8').value, 1);
  assert.equal(sheet.getCell('AJ12').value, 87000);
});
