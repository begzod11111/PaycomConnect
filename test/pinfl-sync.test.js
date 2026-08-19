'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyPinflMaskForSlack,
  formatPinflForSlack,
  isUzbekistanPinfl,
  PINFL_SLACK_NOTICE,
} = require('../dist/runtime/pinfl');
const {
  parseSyncCommandText,
  telegramHistorySkipReason,
  parseTelegramNumericId,
  listIdsToFetch,
  buildSyncAckText,
} = require('../dist/runtime/sync');

test('Uzbekistan PINFL example is detected and hyphenated for Slack', () => {
  assert.equal(isUzbekistanPinfl('31808995970049'), true);
  assert.equal(formatPinflForSlack('31808995970049'), '3180-8995-9700-49');
  const result = applyPinflMaskForSlack('мой ПИНФЛ 31808995970049 проверьте');
  assert.equal(result.rewritten, true);
  assert.equal(result.count, 1);
  assert.equal(result.text, 'мой ПИНФЛ 3180-8995-9700-49 проверьте');
});

test('already hyphenated PINFL is left unchanged', () => {
  const result = applyPinflMaskForSlack('3180-8995-9700-49');
  assert.equal(result.rewritten, false);
  assert.equal(result.text, '3180-8995-9700-49');
});

test('14-digit values that are not PINFL stay intact', () => {
  assert.equal(isUzbekistanPinfl('99999999999999'), false);
  const result = applyPinflMaskForSlack('заказ 99999999999999');
  assert.equal(result.rewritten, false);
  assert.equal(result.text, 'заказ 99999999999999');
});

test('PINFL inside URLs is not rewritten', () => {
  const result = applyPinflMaskForSlack('see https://example.com/31808995970049');
  assert.equal(result.rewritten, false);
});

test('Slack-only PINFL notice is staff copy, not a Telegram instruction', () => {
  assert.match(PINFL_SLACK_NOTICE, /Slack/i);
  assert.doesNotMatch(PINFL_SLACK_NOTICE, /клиент|merchant|напишите/i);
});

test('parseSyncCommandText defaults to last 50 and supports limits / full chat', () => {
  assert.deepEqual(parseSyncCommandText(''), { window: 'last', limit: 50 });
  assert.deepEqual(parseSyncCommandText('telegram 50'), { window: 'last', limit: 50 });
  assert.deepEqual(parseSyncCommandText('jira'), { window: 'last', limit: 50 });
  assert.deepEqual(parseSyncCommandText('tg 10'), { window: 'last', limit: 10 });
  assert.deepEqual(parseSyncCommandText('100'), { window: 'last', limit: 100 });
  assert.deepEqual(parseSyncCommandText('all'), { window: 'full', limit: 50 });
  assert.deepEqual(parseSyncCommandText('telegram all'), { window: 'full', limit: 50 });
});

test('listIdsToFetch compares Telegram ids to already-sent ones instead of rescanning them', () => {
  const delivered = [];
  for (let id = 4951; id <= 5000; id += 1) delivered.push(id);
  const last = listIdsToFetch({
    knownIds: [5000],
    deliveredIds: delivered,
    window: 'last',
    limit: 50,
    newerProbe: 8,
  });
  assert.equal(last.windowStart, 4951);
  assert.equal(last.windowEnd, 5008);
  assert.equal(last.alreadyOk, 50);
  assert.deepEqual(last.toFetch, [5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008]);

  const hole = listIdsToFetch({
    knownIds: [26],
    deliveredIds: [26],
    window: 'last',
    limit: 50,
    newerProbe: 2,
  });
  assert.ok(hole.toFetch.includes(25));
  assert.ok(!hole.toFetch.includes(26));
  assert.ok(hole.toFetch.includes(27));
});

test('full-chat sync ack warns that a long chat runs in the background', () => {
  const ack = buildSyncAckText({ window: 'full', limit: 50 });
  assert.match(ack, /весь/i);
  assert.match(ack, /фон/i);
  const last = buildSyncAckText({ window: 'last', limit: 10 });
  assert.match(last, /10/);
  assert.doesNotMatch(last, /Jira/i);
  assert.doesNotMatch(ack, /Jira/i);
});

test('telegramHistorySkipReason drops service/slash/bot/empty, keeps ordinary text', () => {
  assert.equal(telegramHistorySkipReason({ text: '/connect 123', from: { id: 1 } }), 'slash_command');
  assert.equal(telegramHistorySkipReason({ new_chat_members: [{ id: 1 }] }), 'service');
  assert.equal(telegramHistorySkipReason({ from: { is_bot: true }, text: 'hi' }), 'bot');
  assert.equal(telegramHistorySkipReason({ text: 'hello', from: { id: 1 } }), null);
  assert.equal(telegramHistorySkipReason({ text: '31808995970049', from: { id: 1 } }), null);
});

test('parseTelegramNumericId understands legacy and chat-scoped ids', () => {
  assert.equal(parseTelegramNumericId('26', '-1003990461674'), 26);
  assert.equal(parseTelegramNumericId('-1003990461674:27', '-1003990461674'), 27);
  assert.equal(parseTelegramNumericId('tg-msg-1', '-1001'), null);
});
