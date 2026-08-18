'use strict';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  telegramUserDisplayName,
  isTelegramServiceMessage,
  formatTelegramMembershipNotice,
  telegramMessageAuthorName,
  isTelegramProxySender,
} = require('../dist/runtime/membership');

test('telegramUserDisplayName prefers first+last, then username, then id', () => {
  assert.equal(telegramUserDisplayName({ first_name: 'Ali', last_name: 'Valiev' }), 'Ali Valiev');
  assert.equal(telegramUserDisplayName({ username: 'ali' }), '@ali');
  assert.equal(telegramUserDisplayName({ username: '@ali' }), '@ali');
  assert.equal(telegramUserDisplayName({ id: 42 }), 'id42');
  assert.equal(telegramUserDisplayName(null), '');
});

test('isTelegramServiceMessage flags join/leave/system messages, not plain text', () => {
  assert.equal(isTelegramServiceMessage({ new_chat_members: [{ id: 1 }] }), true);
  assert.equal(isTelegramServiceMessage({ left_chat_member: { id: 1 } }), true);
  assert.equal(isTelegramServiceMessage({ new_chat_title: 'x' }), true);
  assert.equal(isTelegramServiceMessage({ pinned_message: {} }), true);
  assert.equal(isTelegramServiceMessage({ text: 'hello' }), false);
  assert.equal(isTelegramServiceMessage(null), false);
});

test('formatTelegramMembershipNotice: user joined on their own', () => {
  const notice = formatTelegramMembershipNotice({
    from: { id: 1, first_name: 'Ali' },
    new_chat_members: [{ id: 1, first_name: 'Ali' }],
  });
  assert.match(notice, /Ali/);
  assert.match(notice, /присоединил/);
});

test('formatTelegramMembershipNotice: someone added by another member', () => {
  const notice = formatTelegramMembershipNotice({
    from: { id: 1, first_name: 'Admin' },
    new_chat_members: [{ id: 2, first_name: 'Guest' }],
  });
  assert.match(notice, /Admin/);
  assert.match(notice, /добавил/);
  assert.match(notice, /Guest/);
});

test('formatTelegramMembershipNotice: bots are ignored', () => {
  const notice = formatTelegramMembershipNotice({
    from: { id: 1, first_name: 'Admin' },
    new_chat_members: [{ id: 99, first_name: 'Helper', is_bot: true }],
  });
  assert.equal(notice, '');
});

test('formatTelegramMembershipNotice: member left on their own', () => {
  const notice = formatTelegramMembershipNotice({
    from: { id: 2, first_name: 'Guest' },
    left_chat_member: { id: 2, first_name: 'Guest' },
  });
  assert.match(notice, /Guest/);
  assert.match(notice, /покинул/);
});

test('formatTelegramMembershipNotice: member removed by an admin', () => {
  const notice = formatTelegramMembershipNotice({
    from: { id: 1, first_name: 'Admin' },
    left_chat_member: { id: 2, first_name: 'Guest' },
  });
  assert.match(notice, /Admin/);
  assert.match(notice, /удалил/);
  assert.match(notice, /Guest/);
});

test('formatTelegramMembershipNotice: escapes Slack control characters in names', () => {
  const notice = formatTelegramMembershipNotice({
    from: { id: 1, first_name: 'A&B <x>' },
    new_chat_members: [{ id: 1, first_name: 'A&B <x>' }],
  });
  assert.match(notice, /A&amp;B &lt;x&gt;/);
});

test('formatTelegramMembershipNotice: returns empty for non-membership messages', () => {
  assert.equal(formatTelegramMembershipNotice({ new_chat_title: 'x' }), '');
  assert.equal(formatTelegramMembershipNotice({ text: 'hi' }), '');
  assert.equal(formatTelegramMembershipNotice(null), '');
});

test('telegramMessageAuthorName uses sender_chat for anonymous/channel posts', () => {
  assert.equal(
    telegramMessageAuthorName({
      from: { id: 1087968824, username: 'GroupAnonymousBot', first_name: 'Group' },
      sender_chat: { id: -1001, title: 'Payme Support', type: 'supergroup' },
    }),
    'Payme Support',
  );
  assert.equal(
    telegramMessageAuthorName({
      from: { id: 136817688, username: 'Channel_Bot', first_name: 'Channel' },
      sender_chat: { id: -1002, title: 'News Channel', type: 'channel' },
    }),
    'News Channel',
  );
  assert.equal(telegramMessageAuthorName({ from: { id: 7, first_name: 'Lyubov' } }), 'Lyubov');
  assert.equal(isTelegramProxySender({ id: 777000 }), true);
  assert.equal(isTelegramProxySender({ id: 42, first_name: 'Human' }), false);
});
