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

  const summary = await request(server).get('/api/analytics/summary');
  assert.equal(summary.status, 200);
  assert.equal(summary.body.totalMessages, 1);
  assert.equal(summary.body.firstInteractions, 1);
  assert.equal(summary.body.jiraIssuesTriggered, 1);
  assert.equal(summary.body.forwardedMessages, 1);
  assert.equal(summary.body.totalConnections, 1);
  assert.equal(summary.body.linkedConnections, 1);
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
