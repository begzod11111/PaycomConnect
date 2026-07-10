'use strict';

// No Mongo, no Slack token: exercises the offline fallbacks of the resolver.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = '';
process.env.SLACK_BOT_TOKEN = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveSlackDisplayName } = require('../dist/runtime/slack');

test('resolveSlackDisplayName keeps an already-real name without any lookup', async () => {
  assert.equal(await resolveSlackDisplayName('U08BYQYML5A', 'Alice Manager'), 'Alice Manager');
});

test('resolveSlackDisplayName falls back to the id when nothing can be resolved', async () => {
  // "user-<id>" is the synthetic placeholder produced during normalization.
  assert.equal(await resolveSlackDisplayName('U08BYQYML5A', 'user-U08BYQYML5A'), 'user-U08BYQYML5A');
  assert.equal(await resolveSlackDisplayName('U08BYQYML5A', ''), 'U08BYQYML5A');
});
