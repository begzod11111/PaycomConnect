import assert from 'node:assert/strict';
import test, { before } from 'node:test';

// Configure service auth BEFORE importing the app so config/env picks it up.
// node --test runs each test file in its own process, so this does not affect app.test.js.
process.env.MONGODB_URI = '';
process.env.ENABLE_LIVE_FORWARDING = 'false';
process.env.SERVICE_NAME = 'paycomconnect';
process.env.SERVICE_CLIENTS = 'balancer:TestSecretKey000111222333444555666777';

const CLIENT = 'balancer';
const SECRET = 'TestSecretKey000111222333444555666777';

function basic(name, secret) {
  return `Basic ${Buffer.from(`${name}:${secret}`).toString('base64')}`;
}

let request;
let app;

before(async () => {
  request = (await import('supertest')).default;
  ({ default: app } = await import('../index.js'));
});

test('protected data endpoint rejects requests without credentials', async () => {
  const res = await request(app).get('/api/connections');
  assert.equal(res.status, 401);
  assert.ok(res.headers['www-authenticate']);
});

test('protected data endpoint rejects invalid secret', async () => {
  const res = await request(app)
    .get('/api/connections')
    .set('Authorization', basic(CLIENT, 'wrong-secret'));
  assert.equal(res.status, 401);
});

test('protected data endpoint rejects unknown client', async () => {
  const res = await request(app)
    .get('/api/connections')
    .set('Authorization', basic('stranger', SECRET));
  assert.equal(res.status, 401);
});

test('protected data endpoint accepts valid service credentials', async () => {
  const res = await request(app)
    .get('/api/connections')
    .set('Authorization', basic(CLIENT, SECRET));
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('X-Target-Service mismatch is rejected', async () => {
  const res = await request(app)
    .get('/api/connections')
    .set('Authorization', basic(CLIENT, SECRET))
    .set('X-Target-Service', 'some-other-service');
  assert.equal(res.status, 403);
});

test('X-Target-Service matching this service is accepted', async () => {
  const res = await request(app)
    .get('/api/connections')
    .set('Authorization', basic(CLIENT, SECRET))
    .set('X-Target-Service', 'paycomconnect');
  assert.equal(res.status, 200);
});

test('health endpoint stays public', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.service, 'PaycomConnect');
});
