'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const request = require('supertest');
const { createSupabaseSalaryApp } = require('../salary-supabase');

function mockSupabase(seed) {
  const tables = Object.fromEntries(Object.entries(seed).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]));
  const tableRows = (table) => tables[table] ||= [];
  const matches = (row, query) => Object.entries(query).every(([key, value]) => {
    if (['select', 'order', 'limit', 'on_conflict'].includes(key)) return true;
    if (key === 'and') {
      const upper = value.match(/attendance_date\.lte\.([^)]+)/)?.[1];
      return !upper || row.attendance_date <= upper;
    }
    const [operator, expected] = String(value).split('.', 2);
    if (operator === 'eq') return String(row[key]) === expected;
    if (operator === 'gte') return row[key] >= expected;
    if (operator === 'lte') return row[key] <= expected;
    return true;
  });
  return {
    async select(table, query = {}) {
      let rows = tableRows(table).filter((row) => matches(row, query)).map((row) => ({ ...row }));
      if (query.order) {
        const [field, direction] = query.order.split('.');
        rows.sort((left, right) => String(left[field]).localeCompare(String(right[field])) * (direction === 'desc' ? -1 : 1));
      }
      if (query.limit) rows = rows.slice(0, Number(query.limit));
      return rows;
    },
    async insert(table, records) {
      const rows = records.map((record) => ({ ...record, id: record.id ?? Math.max(0, ...tableRows(table).map((row) => row.id || 0)) + 1 }));
      tableRows(table).push(...rows);
      return rows.map((row) => ({ ...row }));
    },
    async upsert(table, records, conflict) {
      const keys = conflict.split(',');
      return records.map((record) => {
        let row = tableRows(table).find((candidate) => keys.every((key) => candidate[key] === record[key]));
        if (row) Object.assign(row, record);
        else { row = { ...record, id: record.id ?? Math.max(0, ...tableRows(table).map((item) => item.id || 0)) + 1 }; tableRows(table).push(row); }
        return { ...row };
      });
    },
    async update(table, query, values) {
      const rows = tableRows(table).filter((row) => matches(row, query));
      rows.forEach((row) => Object.assign(row, Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))));
      return rows.map((row) => ({ ...row }));
    },
    async remove(table, query) {
      const removed = tableRows(table).filter((row) => matches(row, query));
      tables[table] = tableRows(table).filter((row) => !matches(row, query));
      return removed;
    },
    tables,
  };
}

test('Supabase API ensures attendance and calculates salary from cloud rows', async () => {
  const supabase = mockSupabase({
    departments: [{ id: 1, name: 'Science', code: 'SCI', head_name: '', status: 'active' }],
    faculties: [{ id: 1, employee_code: 'EMP01', name: 'Faculty', department_id: 1, faculty_type: 'custom', monthly_salary: 20000, weekdays: '[0]', status: 'active' }],
    monthly_attendance: [],
    salary_records: [],
    audit_logs: [],
  });
  const client = request(createSupabaseSalaryApp({ supabase }));

  const summary = await client.get('/api/salary/monthly?month=6&year=2026').expect(200);
  assert.equal(summary.body.rows[0].working_days, 5);
  assert.equal(supabase.tables.monthly_attendance.length, 30);

  const calendar = await client.get('/api/attendance?faculty_id=1&month=6&year=2026').expect(200);
  const firstWorkingDay = calendar.body.attendance.find((row) => row.attendance_date === '2026-06-01');
  await client.put(`/api/attendance/${firstWorkingDay.id}`).send({ is_working: true, attendance_status: 'present' }).expect(200);

  const payroll = await client.post('/api/salary/calculate').send({ faculty_id: 1, month: 6, year: 2026 }).expect(200);
  assert.equal(payroll.body.salary.calculated_salary, '4000.00');
  assert.equal(supabase.tables.salary_records[0].status, 'draft');
});
