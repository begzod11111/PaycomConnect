'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeSlackText,
  telegramEntitiesToSlackMrkdwn,
  escapeTelegramHtml,
  slackTextToTelegramHtml,
  extractSlackMentionIds,
  looksLikeStructuredData,
} = require('../dist/runtime/message-format');

const JSON_PAYLOAD = [
  '{',
  '  "name": "order",',
  '  "validate": null,',
  '  "is_primary": false,',
  '  "full_name": "test",',
  '  "order_id": 12345',
  '}',
].join('\n');

test('escapeSlackText escapes Slack control characters', () => {
  assert.equal(escapeSlackText('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
  assert.equal(escapeSlackText(''), '');
  assert.equal(escapeSlackText(undefined), '');
});

test('telegram->slack: plain text with special chars is escaped, not distorted', () => {
  const text = 'Cost is 3 < 5 & you save >10%';
  assert.equal(telegramEntitiesToSlackMrkdwn(text, []), 'Cost is 3 &lt; 5 &amp; you save &gt;10%');
});

test('telegram->slack: bare URL with query params is preserved verbatim', () => {
  const text = 'see https://example.com/path?a=1&b=2';
  assert.equal(telegramEntitiesToSlackMrkdwn(text, []), 'see https://example.com/path?a=1&amp;b=2');
});

test('telegram->slack: text_link entity becomes a Slack link', () => {
  const text = 'click here please';
  const entities = [{ type: 'text_link', offset: 6, length: 4, url: 'https://paycom.uz/?a=1&b=2' }];
  assert.equal(
    telegramEntitiesToSlackMrkdwn(text, entities),
    'click <https://paycom.uz/?a=1&amp;b=2|here> please',
  );
});

test('telegram->slack: bold/italic/code/strike entities map to mrkdwn', () => {
  const text = 'bold italic code strike';
  const entities = [
    { type: 'bold', offset: 0, length: 4 },
    { type: 'italic', offset: 5, length: 6 },
    { type: 'code', offset: 12, length: 4 },
    { type: 'strikethrough', offset: 17, length: 6 },
  ];
  assert.equal(telegramEntitiesToSlackMrkdwn(text, entities), '*bold* _italic_ `code` ~strike~');
});

test('telegram->slack: entities that wrap special characters still escape them', () => {
  const text = 'x<y';
  const entities = [{ type: 'bold', offset: 0, length: 3 }];
  assert.equal(telegramEntitiesToSlackMrkdwn(text, entities), '*x&lt;y*');
});

test('telegram->slack: pre block is fenced', () => {
  const text = 'code';
  const entities = [{ type: 'pre', offset: 0, length: 4 }];
  assert.equal(telegramEntitiesToSlackMrkdwn(text, entities), '```\ncode\n```');
});

test('escapeTelegramHtml escapes HTML characters', () => {
  assert.equal(escapeTelegramHtml('a < b & "c"'), 'a &lt; b &amp; &quot;c&quot;');
});

test('slack->telegram: already-escaped entities are not double escaped', () => {
  assert.equal(slackTextToTelegramHtml('Tom &amp; Jerry &lt;3'), 'Tom &amp; Jerry &lt;3');
});

test('slack->telegram: link with label becomes an anchor', () => {
  assert.equal(
    slackTextToTelegramHtml('open <https://example.com/?a=1&amp;b=2|the site> now'),
    'open <a href="https://example.com/?a=1&amp;b=2">the site</a> now',
  );
});

test('slack->telegram: link without label uses the URL as text', () => {
  assert.equal(
    slackTextToTelegramHtml('<https://example.com>'),
    '<a href="https://example.com">https://example.com</a>',
  );
});

test('slack->telegram: unmapped user mention falls back to label or id', () => {
  assert.equal(slackTextToTelegramHtml('hi <@U123|bob>'), 'hi @bob');
  assert.equal(slackTextToTelegramHtml('hi <@U123>'), 'hi @U123');
});

test('slack->telegram: mapped user mention links to Telegram user', () => {
  const mentions = new Map([['U123', { telegramId: '555', displayName: 'Bob Boss' }]]);
  assert.equal(
    slackTextToTelegramHtml('hi <@U123>', mentions),
    'hi <a href="tg://user?id=555">@Bob Boss</a>',
  );
});

test('slack->telegram: channel and special commands are readable', () => {
  assert.equal(slackTextToTelegramHtml('in <#C1|general>'), 'in #general');
  assert.equal(slackTextToTelegramHtml('<!here> ping'), '@here ping');
  assert.equal(slackTextToTelegramHtml('<!subteam^S1|@team>'), '@team');
});

test('extractSlackMentionIds returns unique ids', () => {
  assert.deepEqual(extractSlackMentionIds('<@U1> and <@U2|x> and <@U1>'), ['U1', 'U2']);
  assert.deepEqual(extractSlackMentionIds('no mentions'), []);
});

test('looksLikeStructuredData recognizes JSON/config, ignores chat', () => {
  assert.equal(looksLikeStructuredData(JSON_PAYLOAD), true);
  assert.equal(looksLikeStructuredData('привет, как дела? отправь биллинг'), false);
  assert.equal(looksLikeStructuredData('short'), false);
});

test('telegram->slack: JSON payload is wrapped in a code block (snake_case safe)', () => {
  const out = telegramEntitiesToSlackMrkdwn(JSON_PAYLOAD, []);
  assert.ok(out.startsWith('```\n') && out.endsWith('\n```'), 'should be fenced');
  // Underscores/braces preserved verbatim inside the fence (no italic distortion).
  assert.ok(out.includes('"is_primary": false'));
  assert.ok(out.includes('"order_id": 12345'));
});

test('telegram->slack: ordinary text is not turned into a code block', () => {
  assert.equal(telegramEntitiesToSlackMrkdwn('just a normal message here', []), 'just a normal message here');
});

test('slack->telegram: JSON payload becomes a <pre> block', () => {
  const out = slackTextToTelegramHtml(JSON_PAYLOAD);
  assert.ok(out.startsWith('<pre>') && out.endsWith('</pre>'));
  assert.ok(out.includes('"order_id": 12345'));
});

test('slack->telegram: explicit code fence becomes <pre> and unescapes entities', () => {
  const out = slackTextToTelegramHtml('```\na &lt; b &amp; c\n```');
  assert.equal(out, '<pre>a &lt; b &amp; c</pre>');
});
