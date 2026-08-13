'use strict';

// Runtime config must be set before importing the compiled module (env is read
// at import time). No Slack token / Mongo so we exercise the pure + fallback
// paths without hitting the network.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = '';
process.env.SLACK_BOT_TOKEN = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractSlackNameFromEvent,
  resolveSlackDisplayName,
  clearSlackNameCache,
} = require('../dist/runtime/slack-identity');

test.beforeEach(() => clearSlackNameCache());

test('extractSlackNameFromEvent prefers real_name from user_profile', () => {
  const name = extractSlackNameFromEvent({
    user: 'U123',
    user_profile: { real_name: 'Alice Ivanova', display_name: 'ali', name: 'alice' },
  });
  assert.equal(name, 'Alice Ivanova');
});

test('extractSlackNameFromEvent skips blank profile fields and falls back to username', () => {
  const name = extractSlackNameFromEvent({
    user: 'U123',
    user_profile: { real_name: '  ', display_name: '', name: '' },
    username: 'legacy_name',
  });
  assert.equal(name, 'legacy_name');
});

test('extractSlackNameFromEvent returns empty string when nothing is present', () => {
  assert.equal(extractSlackNameFromEvent({ user: 'U123' }), '');
  assert.equal(extractSlackNameFromEvent(null), '');
});

test('resolveSlackDisplayName uses the callback name without any lookup', async () => {
  const name = await resolveSlackDisplayName('U999', {
    user: 'U999',
    user_profile: { display_name: 'Bob' },
  });
  assert.equal(name, 'Bob');
});

test('resolveSlackDisplayName returns empty when no name source is available', async () => {
  // No Mongo, no Slack token -> nothing resolvable; caller applies its own label.
  const name = await resolveSlackDisplayName('U-unknown', { user: 'U-unknown' });
  assert.equal(name, '');
});

test('resolveSlackDisplayName caches a resolved callback name for later id-only lookups', async () => {
  const first = await resolveSlackDisplayName('U555', {
    user: 'U555',
    user_profile: { real_name: 'Cached Person' },
  });
  assert.equal(first, 'Cached Person');

  // A later event for the same user without a profile should reuse the cache
  // instead of resolving to empty.
  const second = await resolveSlackDisplayName('U555', { user: 'U555' });
  assert.equal(second, 'Cached Person');
});
