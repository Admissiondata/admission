const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const request = require('supertest');
const { createNavratriApp } = require('../navratri-server');

function testClient(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'navratri-node-'));
  const app = createNavratriApp({ dbPath: path.join(directory, 'passes.db'), adminPin: 'test-pin' });
  t.after(() => {
    app.locals.database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return request(app);
}

function registration() {
  return {
    name: 'Asha Patel', gender: 'bahin', dob: '2002-05-10', mobile: '9876543210', role: 'operator',
    k: ['12 Main Road', 'Rajkot', 'Rajkot', '360001'], h: ['12 Main Road', 'Rajkot', 'Rajkot', '360001'],
    aadhar_no: '123456789012', photo: 'data:image/jpeg;base64,abc',
  };
}

test('registers, approves, filters, and exports a pass', async (t) => {
  const client = testClient(t);
  const created = await client.post('/api/register').send(registration()).expect(200);
  assert.equal(created.body.record.role, 'operator');
  assert.equal(created.body.record.status, 'pending');
  assert.match(created.body.no, /^NP-\d{4}-0001$/);

  await client.patch(`/api/registrations/${created.body.no}`).set('X-Admin-Pin', 'test-pin').send({ status: 'approved', approved_by: 'authority' }).expect(200);
  const filtered = await client.get('/api/registrations?status=approved&q=asha').expect(200);
  assert.equal(filtered.body.length, 1);
  assert.equal(filtered.body[0].status, 'approved');
  const stats = await client.get('/api/stats').expect(200);
  assert.equal(stats.body.total_fee, 50);
  const csv = await client.get('/api/export.csv').expect(200);
  assert.match(csv.text, /Asha Patel/);
  assert.match(csv.headers['content-disposition'], /navratri_registrations\.csv/);
});

test('protects admin changes and supports users and settings', async (t) => {
  const client = testClient(t);
  const created = await client.post('/api/register').send(registration()).expect(200);
  await client.patch(`/api/registrations/${created.body.no}`).send({ status: 'approved' }).expect(401);
  await client.post('/api/settings').send({ title: 'Test Pass' }).expect(401);
  await client.post('/api/settings').set('X-Admin-Pin', 'test-pin').send({ title: 'Test Pass', background: '/background.png' }).expect(200);
  const settings = await client.get('/api/settings').expect(200);
  assert.equal(settings.body.title, 'Test Pass');
  assert.equal(settings.body.background, '/background.png');

  await client.post('/api/users').send({ username: 'demo_admin', password: 'secret123', role: 'admin' }).expect(200);
  const login = await client.post('/api/login').send({ username: 'demo_admin', password: 'secret123' }).expect(200);
  assert.equal(login.body.user.role, 'admin');
});

test('exports and restores a PIN-protected JSON backup', async (t) => {
  const client = testClient(t);
  const created = await client.post('/api/register').send(registration()).expect(200);
  await client.get('/api/export.json').expect(401);
  const backup = await client.get('/api/export.json').set('X-Admin-Pin', 'test-pin').expect(200);
  assert.equal(backup.body.ledger[0].no, created.body.no);

  await client.post('/api/clear').set('X-Admin-Pin', 'test-pin').send({}).expect(200);
  assert.equal((await client.get('/api/registrations')).body.length, 0);
  const restored = await client.post('/api/import').set('X-Admin-Pin', 'test-pin').send(backup.body).expect(200);
  assert.equal(restored.body.count, 1);
  assert.equal((await client.get(`/api/registrations/${created.body.no}`)).body.name, 'Asha Patel');
});
