'use strict';

// Enable service auth BEFORE importing the compiled app.
process.env.NODE_ENV = 'test';
process.env.ENABLE_LIVE_FORWARDING = 'false';
process.env.MONGODB_URI = '';
process.env.SERVICE_NAME = 'paycomconnect';
process.env.SERVICE_CLIENTS = 'balancer:TestSecretKey000111222333444555666777';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');

const CLIENT = 'balancer';
const SECRET = 'TestSecretKey000111222333444555666777';

function basic(name, secret) {
  return `Basic ${Buffer.from(`${name}:${secret}`).toString('base64')}`;
}

let app;
let server;

test.before(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.init();
  server = app.getHttpServer();
});

test.after(async () => {
  await app.close();
});

test('protected endpoint rejects requests without credentials', async () => {
  const res = await request(server).get('/api/connections');
  assert.equal(res.status, 401);
});

test('protected endpoint rejects invalid secret', async () => {
  const res = await request(server).get('/api/connections').set('Authorization', basic(CLIENT, 'wrong'));
  assert.equal(res.status, 401);
});

test('protected endpoint accepts valid service credentials', async () => {
  const res = await request(server).get('/api/connections').set('Authorization', basic(CLIENT, SECRET));
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test('X-Target-Service mismatch is rejected', async () => {
  const res = await request(server)
    .get('/api/connections')
    .set('Authorization', basic(CLIENT, SECRET))
    .set('X-Target-Service', 'other');
  assert.equal(res.status, 403);
});

test('health endpoint stays public', async () => {
  const res = await request(server).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.service, 'PaycomConnect');
});
