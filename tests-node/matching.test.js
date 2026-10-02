const assert = require('node:assert/strict');
const test = require('node:test');
const request = require('supertest');
const ExcelJS = require('exceljs');
const { createMatchingApp, processDatasets } = require('../matching-server');

async function workbookBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Admissions');
  sheet.addRow(Object.keys(rows[0]));
  rows.forEach((row) => sheet.addRow(Object.values(row)));
  return workbook.xlsx.writeBuffer();
}

function binaryParser(response, callback) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
}

test('matches records, detects duplicates, and lists fee gaps', () => {
  const result = processDatasets(
    [
      { Name: 'John Doe', 'ACPC Application Number': '1001', Fees: '5000' },
      { Name: 'John Doe', 'ACPC Application Number': '1001', Fees: '5000' },
      { Name: 'Jane Smith', 'ACPC Application Number': '1002', Fees: '' },
    ],
    [
      { Name: 'john doe', 'ACPC Application Number': '1001', Fees: '5000' },
      { Name: 'Alice Brown', 'ACPC Application Number': '1003', Fees: '0' },
    ],
  );
  assert.equal(result.matches.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.deepEqual(result.not_reporting_fees.map((row) => row.name), ['Jane Smith', 'Alice Brown']);
});

test('uploads two sheets and returns three result collections and an Excel report', async () => {
  const app = createMatchingApp();
  const left = await workbookBuffer([
    { Name: 'John Doe', 'ACPC Application Number': '1001', Fees: '5000' },
    { Name: 'Jane Smith', 'ACPC Application Number': '1002', Fees: '' },
  ]);
  const right = await workbookBuffer([
    { Name: 'JOHN DOE', 'ACPC Application Number': '1001', Fees: '5000' },
    { Name: 'Alice Brown', 'ACPC Application Number': '1003', Fees: '0' },
  ]);
  const response = await request(app).post('/api/match').attach('left', left, 'left.xlsx').attach('right', right, 'right.xlsx').expect(200);
  assert.equal(response.body.matches.length, 1);
  assert.equal(response.body.duplicates.length, 0);
  assert.equal(response.body.not_reporting_fees.length, 2);

  const download = await request(app).post('/api/match/export.xlsx').attach('left', left, 'left.xlsx').attach('right', right, 'right.xlsx').buffer(true).parse(binaryParser).expect(200);
  assert.match(download.headers['content-disposition'], /admission_report\.xlsx/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(download.body);
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Matches', 'Duplicates', 'Not Reporting Fees']);
});

test('rejects sheets without required columns', async () => {
  const app = createMatchingApp();
  const invalid = await workbookBuffer([{ Name: 'Person' }]);
  const response = await request(app).post('/api/match').attach('left', invalid, 'left.xlsx').attach('right', invalid, 'right.xlsx').expect(400);
  assert.match(response.body.error, /Name, ACPC Application Number, and Fees/);
});
