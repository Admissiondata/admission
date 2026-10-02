const path = require('node:path');
const ExcelJS = require('exceljs');
const express = require('express');
const multer = require('multer');

const STATIC_DIR = path.join(__dirname, 'matching');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const REPORT_COLUMNS = ['name', 'acpc', 'fees'];

function normalizeText(value) { return value == null ? '' : String(value).trim().toLowerCase(); }
function normalizeNumber(value) { return value == null ? '' : String(value).trim(); }

function cellValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') return value.result ?? value.text ?? value.richText?.map((part) => part.text).join('') ?? null;
  return value;
}

async function readDataset(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };
  const headers = sheet.getRow(1).values.slice(1).map((value) => String(cellValue(value) ?? '').trim());
  const rows = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const values = sheet.getRow(rowNumber).values.slice(1).map(cellValue);
    if (!values.some((value) => value != null && value !== '')) continue;
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] ?? null])));
  }
  return { headers, rows };
}

function processDatasets(leftRows, rightRows) {
  const matches = [];
  const duplicates = [];
  const notReportingFees = [];
  const seenPairs = new Set();
  const keyFor = (record) => JSON.stringify([normalizeText(record.Name), normalizeNumber(record['ACPC Application Number'])]);
  const toResult = (record) => ({ name: record.Name ?? null, acpc: record['ACPC Application Number'] ?? null, fees: record.Fees ?? null });

  for (const record of leftRows) {
    const key = keyFor(record);
    if (seenPairs.has(key)) {
      duplicates.push(toResult(record));
      continue;
    }
    seenPairs.add(key);
    const found = rightRows.some((candidate) => normalizeText(candidate.Name) === normalizeText(record.Name) && normalizeNumber(candidate['ACPC Application Number']) === normalizeNumber(record['ACPC Application Number']));
    (found ? matches : notReportingFees).push(toResult(record));
  }
  for (const record of rightRows) {
    if (seenPairs.has(keyFor(record))) continue;
    notReportingFees.push(toResult(record));
  }
  return { matches, duplicates, not_reporting_fees: notReportingFees };
}

async function readReports(leftBuffer, rightBuffer) {
  const [left, right] = await Promise.all([readDataset(leftBuffer), readDataset(rightBuffer)]);
  const required = ['Name', 'ACPC Application Number', 'Fees'];
  if ([left, right].some((dataset) => required.some((column) => !dataset.headers.includes(column)))) {
    throw new Error('Both sheets must contain Name, ACPC Application Number, and Fees columns.');
  }
  return processDatasets(left.rows, right.rows);
}

async function createWorkbook(result) {
  const workbook = new ExcelJS.Workbook();
  for (const [key, sheetName] of [['matches', 'Matches'], ['duplicates', 'Duplicates'], ['not_reporting_fees', 'Not Reporting Fees']]) {
    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRow(REPORT_COLUMNS);
    result[key].forEach((record) => sheet.addRow(REPORT_COLUMNS.map((column) => record[column])));
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: `C${Math.max(1, result[key].length + 1)}` };
    sheet.columns = [{ width: 30 }, { width: 24 }, { width: 16 }];
  }
  return workbook.xlsx.writeBuffer();
}

function createMatchingApp() {
  const app = express();
  app.use(express.static(STATIC_DIR));
  app.post('/api/match', upload.fields([{ name: 'left', maxCount: 1 }, { name: 'right', maxCount: 1 }]), async (req, res) => {
    if (!req.files?.left?.[0] || !req.files?.right?.[0]) return res.status(400).json({ ok: false, error: 'Upload both Excel sheets.' });
    try { return res.json({ ok: true, ...await readReports(req.files.left[0].buffer, req.files.right[0].buffer) }); }
    catch (error) { return res.status(400).json({ ok: false, error: error.message }); }
  });
  app.post('/api/match/export.xlsx', upload.fields([{ name: 'left', maxCount: 1 }, { name: 'right', maxCount: 1 }]), async (req, res, next) => {
    if (!req.files?.left?.[0] || !req.files?.right?.[0]) return res.status(400).json({ ok: false, error: 'Upload both Excel sheets.' });
    try {
      const result = await readReports(req.files.left[0].buffer, req.files.right[0].buffer);
      const buffer = await createWorkbook(result);
      return res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('admission_report.xlsx').send(buffer);
    } catch (error) { if (error.message.includes('Both sheets')) return res.status(400).json({ ok: false, error: error.message }); return next(error); }
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'Admission Match Tool' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError) return res.status(400).json({ ok: false, error: error.message });
    console.error(error); return res.status(500).json({ ok: false, error: 'Internal server error' });
  });
  return app;
}

if (require.main === module) {
  const app = createMatchingApp(); const port = Number(process.env.MATCHING_PORT || 8501);
  app.listen(port, '0.0.0.0', () => console.log(`Admission Match Tool -> http://0.0.0.0:${port}`));
}

module.exports = { createMatchingApp, readDataset, processDatasets, readReports, createWorkbook };
