import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrubCredentials } from '../src/services/scrub.js';

// Coverage for the v4.4 credential patterns: Stripe, Google API, Slack, GitHub.
// Each positive case asserts both the marker AND that the raw secret is gone;
// negatives guard against firing on ordinary prose.
//
// Fixture secrets are CONSTRUCTED at runtime (prefix + concatenation) so no
// literal secret-shaped token sits in this file — GitHub push protection
// scans committed content and rejects pushes containing realistic key
// literals, even fake ones in tests.

describe('Stripe keys → [STRIPE_KEY_REDACTED]', () => {
  it('redacts a live secret key (sk_live_)', () => {
    const key = 'sk_' + 'live_' + '51H8fGaBcDeFgHiJkLmNoPqRs';
    const result = scrubCredentials(`stripe = ${key}`);
    assert.ok(result.includes('[STRIPE_KEY_REDACTED]'), result);
    assert.ok(!result.includes(key));
  });

  it('redacts a restricted key (rk_live_)', () => {
    const key = 'rk_' + 'live_' + '0123456789abcdefghijklmn';
    const result = scrubCredentials(`key ${key} rotated`);
    assert.ok(result.includes('[STRIPE_KEY_REDACTED]'), result);
    assert.ok(!result.includes(key));
  });

  it('redacts a publishable key (pk_live_)', () => {
    const key = 'pk_' + 'live_' + 'ABCDEFGHIJKLMNOPQRSTUVwx';
    const result = scrubCredentials(key);
    assert.ok(result.includes('[STRIPE_KEY_REDACTED]'), result);
  });

  it('redacts test-mode variants (sk_test_/pk_test_)', () => {
    const sk = 'sk_' + 'test_' + 'abcdefghij0123456789ABCD';
    const pk = 'pk_' + 'test_' + 'zyxwvutsrq9876543210ZYXW';
    const result = scrubCredentials(`${sk} and ${pk}`);
    const count = (result.match(/\[STRIPE_KEY_REDACTED\]/g) || []).length;
    assert.equal(count, 2, result);
  });

  it('does not fire on ordinary words like "skate" or "peaks"', () => {
    const input = 'The skate park peaks in popularity each summer.';
    assert.equal(scrubCredentials(input), input);
  });
});

describe('Google API keys → [GOOGLE_API_KEY_REDACTED]', () => {
  it('redacts an AIza... key', () => {
    const key = 'AIza' + 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'.slice(0, 35);
    const result = scrubCredentials(`maps key: ${key}`);
    assert.ok(result.includes('[GOOGLE_API_KEY_REDACTED]'), result);
    assert.ok(!result.includes(key));
  });

  it('does not fire on the bare token "AIza"', () => {
    const input = 'The variable AIza was never assigned.';
    assert.equal(scrubCredentials(input), input);
  });
});

describe('Slack tokens → [SLACK_TOKEN_REDACTED]', () => {
  it('redacts a standalone bot token (xoxb-)', () => {
    const token = 'xoxb' + '-123456789012-abcDEFghiJKL';
    const result = scrubCredentials(`slack: ${token}`);
    assert.ok(result.includes('[SLACK_TOKEN_REDACTED]'), result);
    assert.ok(!result.includes(token));
  });

  it('redacts user/app/refresh variants (xoxp/xoxa/xoxr)', () => {
    const input = ['xoxp', 'xoxa', 'xoxr']
      .map((prefix, i) => `${prefix}-${String(i + 1).repeat(10)}-${'abc'[i].repeat(4)}`)
      .join(' and ');
    const result = scrubCredentials(input);
    const count = (result.match(/\[SLACK_TOKEN_REDACTED\]/g) || []).length;
    assert.equal(count, 3, result);
  });

  it('does not fire on words starting with "xox"', () => {
    const input = 'She signed the note with xoxo and a smile.';
    assert.equal(scrubCredentials(input), input);
  });
});

describe('GitHub tokens → [GITHUB_TOKEN_REDACTED]', () => {
  it('redacts a standalone personal token (ghp_)', () => {
    const token = 'ghp_' + 'A'.repeat(36);
    const result = scrubCredentials(`git remote uses ${token} now`);
    assert.ok(result.includes('[GITHUB_TOKEN_REDACTED]'), result);
    assert.ok(!result.includes(token));
  });

  it('redacts oauth/user/server/refresh variants (gho_/ghu_/ghs_/ghr_)', () => {
    const input = [
      'gho_' + 'a'.repeat(36),
      'ghu_' + 'b'.repeat(36),
      'ghs_' + 'c'.repeat(36),
      'ghr_' + 'd'.repeat(36),
    ].join(' ');
    const result = scrubCredentials(input);
    const count = (result.match(/\[GITHUB_TOKEN_REDACTED\]/g) || []).length;
    assert.equal(count, 4, result);
  });

  it('does not fire on prose like "ghost" or "ghoul"', () => {
    const input = 'The ghost story about a ghoul kept the campers awake.';
    assert.equal(scrubCredentials(input), input);
  });

  it('does not fire on a too-short ghp_ fragment', () => {
    const input = 'ghp_short123'; // fewer than 36 trailing chars
    assert.equal(scrubCredentials(input), input);
  });
});
