'use strict';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeInboundMessage, telegramExternalId } = require('../dist/runtime/bridge');

test('telegramExternalId includes chat id so ids are unique across groups', () => {
  assert.equal(telegramExternalId('-1001', 42), '-1001:42');
  assert.equal(telegramExternalId('-1002', 42), '-1002:42');
  assert.notEqual(telegramExternalId('-1001', 42), telegramExternalId('-1002', 42));
});

test('normalizeInboundMessage: two chats with the same message_id get different externalIds', () => {
  const first = normalizeInboundMessage('telegram', {
    message: {
      message_id: 15,
      chat: { id: -100111, type: 'supergroup', title: 'Group A' },
      from: { id: 1, first_name: 'Client' },
      text: 'one',
    },
  });
  const second = normalizeInboundMessage('telegram', {
    message: {
      message_id: 15,
      chat: { id: -100222, type: 'supergroup', title: 'Group B' },
      from: { id: 2, first_name: 'Other' },
      text: 'two',
    },
  });
  assert.equal(first.externalId, '-100111:15');
  assert.equal(second.externalId, '-100222:15');
  assert.notEqual(first.externalId, second.externalId);
});

test('normalizeInboundMessage: channel_post is treated as a telegram message', () => {
  const normalized = normalizeInboundMessage('telegram', {
    update_id: 9,
    channel_post: {
      message_id: 3,
      chat: { id: -100505, type: 'channel', title: 'Billing Channel' },
      text: 'hello, you have a billing system',
    },
  });
  assert.equal(normalized.source, 'telegram');
  assert.equal(normalized.channelId, '-100505');
  assert.equal(normalized.externalId, '-100505:3');
  assert.equal(normalized.text, 'hello, you have a billing system');
  assert.equal(normalized.userName, 'Billing Channel');
});

test('normalizeInboundMessage: sticker is not empty content', () => {
  const normalized = normalizeInboundMessage('telegram', {
    message: {
      message_id: 8,
      chat: { id: -1008, type: 'supergroup' },
      from: { id: 9, first_name: 'Client' },
      sticker: { file_id: 'abc', emoji: '👍', file_size: 10 },
    },
  });
  assert.match(normalized.text, /Sticker/);
  assert.equal(normalized.files.length, 1);
  assert.equal(normalized.files[0].type, 'sticker');
});

test('normalizeInboundMessage: telegram reply and slack thread are captured', () => {
  const telegram = normalizeInboundMessage('telegram', {
    message: {
      message_id: 4,
      chat: { id: -1004, type: 'supergroup' },
      from: { id: 1, first_name: 'Client' },
      text: 'reply',
      reply_to_message: { message_id: 3, text: 'parent' },
    },
  });
  assert.equal(telegram.metadata.replyToTelegramMessageId, '3');
  assert.equal(telegram.replyToMessageId, '3');

  const slack = normalizeInboundMessage('slack', {
    ts: '2.002',
    thread_ts: '2.001',
    userId: 'U1',
    channelId: 'C1',
    text: 'thread reply',
  });
  assert.equal(slack.metadata.threadTs, '2.001');
  assert.equal(slack.threadTs, '2.001');
  assert.equal(slack.externalId, '2.002');
});
