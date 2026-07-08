'use strict';

// Configure runtime BEFORE importing the compiled app (env is read at import).
process.env.NODE_ENV = 'test';
process.env.ENABLE_LIVE_FORWARDING = 'false';
process.env.MONGODB_URI = '';
process.env.SERVICE_CLIENTS = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/app.module');
const { resetMemoryStore } = require('../dist/runtime/persistence');

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

test.beforeEach(() => {
  resetMemoryStore();
});

test('GET /api/health returns service status', async () => {
  const response = await request(server).get('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.service, 'PaycomConnect');
  assert.equal(response.body.analytics.totalMessages, 0);
  assert.equal(response.body.analytics.totalConnections, 0);
});

test('telegram connect command creates pending_slack connection by INN', async () => {
  const response = await request(server)
    .post('/api/mock/telegram')
    .send({
      messageId: 'tg-connect-1',
      userId: '1001',
      userName: 'Manager Ali',
      channelId: '-100777',
      chatTitle: 'Paycom TG Support',
      text: '/connect 123456789',
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.duplicate, false);
  assert.equal(response.body.onboarding, true);
  assert.equal(response.body.activation.status, 'pending_slack');
  assert.match(response.body.activation.message, /Ожидается подключение Slack/i);

  const connections = await request(server).get('/api/connections');
  assert.equal(connections.status, 200);
  assert.equal(connections.body.length, 1);
  assert.equal(connections.body[0].inn, '123456789');
  assert.equal(connections.body[0].telegramChatId, '-100777');
  assert.equal(connections.body[0].status, 'pending_slack');
});

test('slack connect command completes link and normal telegram message is forwarded only after link', async () => {
  await request(server).post('/api/mock/telegram').send({
    messageId: 'tg-connect-1',
    userId: '1001',
    userName: 'Manager Ali',
    channelId: '-100777',
    chatTitle: 'Paycom TG Support',
    text: '/connect 123456789',
  });

  const slackConnect = await request(server)
    .post('/api/slack/commands/connect')
    .type('form')
    .send({
      text: '123456789',
      channel_id: 'C-PAYCOM-1',
      channel_name: 'paycom-connect',
      user_id: 'U-1',
      user_name: 'slack.manager',
    });

  assert.equal(slackConnect.status, 200);
  assert.match(slackConnect.body.text, /завершена|подключена/i);
  assert.equal(slackConnect.body.connection.status, 'linked');

  const tgMessage = await request(server)
    .post('/api/mock/telegram')
    .send({
      messageId: 'tg-msg-1',
      userId: '1002',
      userName: 'Client User',
      channelId: '-100777',
      chatTitle: 'Paycom TG Support',
      text: 'Есть проблема с оплатой №12345',
    });

  assert.equal(tgMessage.status, 201);
  assert.equal(tgMessage.body.message.source, 'telegram');
  assert.equal(tgMessage.body.message.firstInteraction, true);
  assert.equal(tgMessage.body.delivery.status, 'mocked');
  assert.equal(tgMessage.body.delivery.target, 'C-PAYCOM-1');
  assert.equal(tgMessage.body.jira.triggered, true);
  assert.equal(tgMessage.body.jira.status, 'mocked');

  // Rich message metadata: sender classification, content format, delivered flag.
  assert.equal(tgMessage.body.message.direction, 'telegram_to_slack');
  assert.equal(tgMessage.body.message.format, 'text');
  assert.equal(tgMessage.body.message.delivered, true);
  assert.equal(tgMessage.body.message.sender.type, 'client');
  assert.equal(tgMessage.body.message.sender.isEmployee, false);

  const summary = await request(server).get('/api/analytics/summary');
  assert.equal(summary.status, 200);
  assert.equal(summary.body.totalMessages, 1);
  assert.equal(summary.body.firstInteractions, 1);
  assert.equal(summary.body.jiraIssuesTriggered, 1);
  assert.equal(summary.body.forwardedMessages, 1);
  assert.equal(summary.body.totalConnections, 1);
  assert.equal(summary.body.linkedConnections, 1);
});

test('file message is stored with format=file', async () => {
  await request(server).post('/api/mock/telegram').send({
    messageId: 'tg-connect-file',
    userId: '1001',
    userName: 'Manager Ali',
    channelId: '-100555',
    chatTitle: 'Paycom TG Support',
    text: '/connect 555666777',
  });

  await request(server)
    .post('/api/slack/commands/connect')
    .type('form')
    .send({
      text: '555666777',
      channel_id: 'C-FILE-1',
      channel_name: 'inn-555666777',
      user_id: 'U-file',
      user_name: 'slack.manager',
    });

  const fileMessage = await request(server)
    .post('/api/mock/telegram')
    .send({
      messageId: 'tg-file-1',
      userId: '2002',
      userName: 'Client User',
      channelId: '-100555',
      files: [{ type: 'document', name: 'invoice.pdf', mimeType: 'application/pdf', size: 1024 }],
    });

  assert.equal(fileMessage.status, 201);
  assert.equal(fileMessage.body.message.format, 'file');
  assert.equal(fileMessage.body.message.sender.type, 'client');
});

test('action logs are recorded and retrievable', async () => {
  await request(server).post('/api/mock/telegram').send({
    messageId: 'tg-connect-log',
    userId: '1001',
    userName: 'Manager Ali',
    channelId: '-100444',
    chatTitle: 'Paycom TG Support',
    text: '/connect 444555666',
  });

  const logs = await request(server).get('/api/logs/recent');
  assert.equal(logs.status, 200);
  assert.ok(Array.isArray(logs.body));
  assert.ok(logs.body.length >= 1);

  const actions = logs.body.map((entry) => entry.action);
  assert.ok(actions.includes('message.received'));
  assert.ok(actions.includes('connection.activation'));

  const summary = await request(server).get('/api/analytics/summary');
  assert.ok(summary.body.totalActionLogs >= 1);
});

test('dashboard overview page and data endpoints are served', async () => {
  const page = await request(server).get('/api/dashboard');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.text, /local dashboard/i);

  const overview = await request(server).get('/api/dashboard/data/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.body.service, 'PaycomConnect');
  assert.ok(overview.body.process);
  assert.ok(overview.body.analytics);

  const logs = await request(server).get('/api/dashboard/data/logs');
  assert.equal(logs.status, 200);
  assert.ok(Array.isArray(logs.body));

  const messages = await request(server).get('/api/dashboard/data/messages');
  assert.equal(messages.status, 200);
  assert.ok(Array.isArray(messages.body));

  for (const path of ['/messages', '/logs', '/connections']) {
    const res = await request(server).get('/api/dashboard' + path);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
  }
});

test('message is not forwarded before link is completed', async () => {
  await request(server).post('/api/mock/telegram').send({
    messageId: 'tg-connect-2',
    userId: '1001',
    userName: 'Manager Ali',
    channelId: '-100888',
    text: '/connect 987654321',
  });

  const response = await request(server).post('/api/mock/telegram').send({
    messageId: 'tg-msg-unlinked-1',
    userId: '1003',
    userName: 'Pending User',
    channelId: '-100888',
    text: 'Просто сообщение до Slack-подключения',
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.delivery.status, 'pending_link');
  assert.match(response.body.delivery.reason, /Slack/i);
});

test('duplicate message is not counted twice after link', async () => {
  await request(server).post('/api/mock/telegram').send({
    messageId: 'tg-connect-3',
    userId: '1001',
    userName: 'Manager Ali',
    channelId: '-100999',
    text: '/connect 111222333',
  });

  await request(server)
    .post('/api/slack/commands/connect')
    .type('form')
    .send({
      text: '111222333',
      channel_id: 'C111222333',
      channel_name: 'inn-111222333',
      user_id: 'U100',
      user_name: 'Support Engineer',
    });

  const payload = {
    event_id: 'slack-1',
    userId: 'U100',
    userName: 'Support Engineer',
    channelId: 'C111222333',
    text: 'Problem with invoice 54321',
  };

  const first = await request(server).post('/api/mock/slack').send(payload);
  const duplicate = await request(server).post('/api/mock/slack').send(payload);
  const summary = await request(server).get('/api/analytics/summary');

  assert.equal(first.status, 201);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(summary.body.totalMessages, 1);
  assert.equal(summary.body.firstInteractions, 1);
  assert.equal(first.body.delivery.status, 'mocked');
  assert.equal(first.body.delivery.target, '-100999');
});
