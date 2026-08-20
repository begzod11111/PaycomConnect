'use strict';

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifySlackInbound,
  isSlackSystemNoticeText,
  slackThreadTs,
  slackPermalink,
} = require('../dist/runtime/slack-events');
const { isOwnMessage, telegramForwardFromName } = require('../dist/runtime/message-sync');

test('Slack Connect org-share notice is a system event, not a user message', () => {
  const text =
    '<@U09ABCDEF> has added qurilishavtotexta-minot-205778859 to all of TBC Explorers. Members of those workspaces can now be invited to join this channel.';
  assert.equal(isSlackSystemNoticeText(text), true);
  const classified = classifySlackInbound({
    event_id: 'Ev1',
    type: 'message',
    user: 'U09ABCDEF',
    text,
    channel: 'C123',
  });
  assert.equal(classified.kind, 'ignore');
  assert.equal(classified.reason, 'ignored_system_notice');
});

test('ordinary Slack messages are still created', () => {
  const classified = classifySlackInbound({
    event_id: 'Ev2',
    userId: 'U100',
    text: 'Problem with invoice 54321',
    channelId: 'C111',
  });
  assert.equal(classified.kind, 'create');
});

test('member_joined_channel and channel_shared never become Telegram posts', () => {
  assert.equal(classifySlackInbound({ type: 'member_joined_channel', user: 'U1' }).kind, 'ignore');
  assert.equal(classifySlackInbound({ type: 'channel_shared', channel: 'C1' }).reason, 'ignored_event:channel_shared');
  assert.equal(classifySlackInbound({ event: { type: 'message', subtype: 'channel_join', text: '<@U1> has joined' } }).kind, 'ignore');
});

test('message_changed is an edit, message_deleted is a delete, bot edits are ignored', () => {
  const edit = classifySlackInbound({
    event: {
      type: 'message',
      subtype: 'message_changed',
      channel: 'C1',
      message: { user: 'U100', text: 'new', ts: '1.001', client_msg_id: 'abc' },
      previous_message: { user: 'U100', text: 'old', ts: '1.001' },
    },
  });
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.message.text, 'new');

  const del = classifySlackInbound({
    event: {
      type: 'message',
      subtype: 'message_deleted',
      channel: 'C1',
      deleted_ts: '1.001',
      previous_message: { user: 'U100', text: 'old', ts: '1.001' },
    },
  });
  assert.equal(del.kind, 'delete');

  const botEdit = classifySlackInbound({
    event: {
      type: 'message',
      subtype: 'message_changed',
      message: { bot_id: 'B123', text: 'echo', ts: '1.002' },
    },
  });
  assert.equal(botEdit.kind, 'ignore');
});

test('thread_ts equal to ts is not a reply; permalink is stable', () => {
  assert.equal(slackThreadTs({ ts: '1.001', thread_ts: '1.001' }), '');
  assert.equal(slackThreadTs({ ts: '1.002', thread_ts: '1.001' }), '1.001');
  assert.equal(slackPermalink('C123', '1710000000.000100'), 'https://slack.com/archives/C123/p1710000000000100');
});

test('isOwnMessage only allows the original author', () => {
  assert.equal(isOwnMessage({ userId: 'U1' }, 'U1'), true);
  assert.equal(isOwnMessage({ userId: 'U1' }, 'U2'), false);
  assert.equal(isOwnMessage({ userId: '1002' }, 1002), true);
});

test('telegramForwardFromName reads forward_origin / forward_from', () => {
  assert.equal(
    telegramForwardFromName({ forward_origin: { type: 'user', sender_user: { first_name: 'Ali' } } }),
    'Ali',
  );
  assert.equal(telegramForwardFromName({ forward_from: { first_name: 'Behzod', last_name: 'Toirjonov' } }), 'Behzod Toirjonov');
  assert.equal(telegramForwardFromName({ text: 'hi' }), '');
});
