'use strict';

require('dotenv').config({ quiet: true });
const Database = require('better-sqlite3');
const path = require('node:path');
const { createSupabaseClient } = require('../supabase-client');

const BATCH_SIZE = 100;
const databasePath = process.env.SALARY_DB_PATH || path.join(__dirname, '..', 'salary_data.db');
const localDb = new Database(databasePath, { readonly: true, fileMustExist: true });

function batches(rows) {
  const output = [];
  for (let index = 0; index < rows.length; index += BATCH_SIZE) output.push(rows.slice(index, index + BATCH_SIZE));
  return output;
}

function timestamp(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? String(value || '') : parsed.toISOString();
}

function auditSignature(row) {
  return [row.action, row.module, row.record_id, row.old_data, row.new_data, timestamp(row.created_at)].join('\u001f');
}

async function migrate() {
  const supabase = createSupabaseClient();
  const localTables = ['departments', 'faculties', 'monthly_attendance', 'salary_records', 'audit_logs'];
  const counts = Object.fromEntries(localTables.map((table) => [table, localDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  const localDepartments = localDb.prepare('SELECT * FROM departments ORDER BY id').all();
  const localFaculties = localDb.prepare('SELECT * FROM faculties ORDER BY id').all();
  const localAttendance = localDb.prepare('SELECT * FROM monthly_attendance ORDER BY id').all();
  const localSalaryRecords = localDb.prepare('SELECT * FROM salary_records ORDER BY id').all();
  const localAuditLogs = localDb.prepare('SELECT * FROM audit_logs ORDER BY id').all();
  const departmentIds = new Map();
  const facultyIds = new Map();

  for (const batch of batches(localDepartments.map(({ id, ...row }) => row))) {
    const saved = await supabase.upsert('departments', batch, 'code');
    saved.forEach((row) => {
      const original = localDepartments.find((item) => item.code === row.code);
      if (original) departmentIds.set(original.id, row.id);
    });
  }
  const cloudDepartments = await supabase.select('departments', { select: 'id,code' });
  const departmentByCode = new Map(cloudDepartments.map((row) => [row.code, row.id]));
  localDepartments.forEach((row) => departmentIds.set(row.id, departmentByCode.get(row.code)));

  for (const batch of batches(localFaculties.map(({ id, ...row }) => ({ ...row, department_id: departmentIds.get(row.department_id) })))) {
    const saved = await supabase.upsert('faculties', batch, 'employee_code');
    saved.forEach((row) => {
      const original = localFaculties.find((item) => item.employee_code === row.employee_code);
      if (original) facultyIds.set(original.id, row.id);
    });
  }
  const cloudFaculties = await supabase.select('faculties', { select: 'id,employee_code' });
  const facultyByCode = new Map(cloudFaculties.map((row) => [row.employee_code, row.id]));
  localFaculties.forEach((row) => facultyIds.set(row.id, facultyByCode.get(row.employee_code)));

  for (const batch of batches(localAttendance.map(({ id, ...row }) => ({ ...row, faculty_id: facultyIds.get(row.faculty_id) })))) {
    await supabase.upsert('monthly_attendance', batch, 'faculty_id,attendance_date');
  }
  for (const batch of batches(localSalaryRecords.map(({ id, ...row }) => ({ ...row, faculty_id: facultyIds.get(row.faculty_id) })))) {
    await supabase.upsert('salary_records', batch, 'faculty_id,month,year');
  }

  const existingAudits = await supabase.select('audit_logs', { select: 'action,module,record_id,old_data,new_data,created_at' });
  const knownAuditSignatures = new Set(existingAudits.map(auditSignature));
  const missingAudits = localAuditLogs.map(({ id, ...row }) => ({
    ...row,
    record_id: row.module === 'salary' && facultyIds.has(Number(row.record_id)) ? String(facultyIds.get(Number(row.record_id))) : row.record_id,
  })).filter((row) => !knownAuditSignatures.has(auditSignature(row)));
  for (const batch of batches(missingAudits)) await supabase.insert('audit_logs', batch);

  const cloudCounts = {};
  for (const table of localTables) cloudCounts[table] = await supabase.count(table);
  console.log(`Migrated salary data: ${JSON.stringify({ local: counts, supabase: cloudCounts })}`);
}

migrate()
  .catch((error) => {
    console.error(`Salary migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => localDb.close());
