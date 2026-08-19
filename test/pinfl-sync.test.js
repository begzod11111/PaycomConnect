'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyPinflMaskForSlack,
  formatPinflForSlack,
  isUzbekistanPinfl,
  PINFL_SLACK_NOTICE,
} = require('../dist/runtime/pinfl');
const { jiraCommentToPlainText, jiraDocToText } = require('../dist/runtime/jira');
const {
  parseSyncCommandText,
  telegramHistorySkipReason,
  parseTelegramNumericId,
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

test('parseSyncCommandText reads scope and lookback', () => {
  assert.deepEqual(parseSyncCommandText(''), { scope: 'all', lookback: 200 });
  assert.deepEqual(parseSyncCommandText('telegram 50'), { scope: 'telegram', lookback: 50 });
  assert.deepEqual(parseSyncCommandText('jira'), { scope: 'jira', lookback: 200 });
  assert.deepEqual(parseSyncCommandText('tg 15'), { scope: 'telegram', lookback: 15 });
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

test('jira ADF comments flatten to plain text', () => {
  const text = jiraCommentToPlainText({
    body: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Need PINFL' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'please' }] },
      ],
    },
  });
  assert.match(text, /Need PINFL/);
  assert.match(text, /please/);
  assert.equal(jiraDocToText('plain'), 'plain');
});
