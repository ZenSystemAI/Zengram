import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startupConfigIssues } from '../src/services/config-utils.js';

describe('startupConfigIssues', () => {
  it('accepts a strong, unique API key', () => {
    assert.deepEqual(startupConfigIssues({ BRAIN_API_KEY: 'a-sufficiently-long-secret-value' }), []);
  });

  it('flags a missing API key', () => {
    const issues = startupConfigIssues({});
    assert.ok(issues.some(i => /BRAIN_API_KEY is required/.test(i)));
  });

  it('flags an empty / whitespace-only API key', () => {
    assert.ok(startupConfigIssues({ BRAIN_API_KEY: '   ' }).some(i => /required/.test(i)));
  });

  it('flags leading/trailing whitespace on the key', () => {
    const issues = startupConfigIssues({ BRAIN_API_KEY: ' a-sufficiently-long-secret ' });
    assert.ok(issues.some(i => /whitespace/.test(i)));
  });

  it('rejects a placeholder value', () => {
    const issues = startupConfigIssues({ BRAIN_API_KEY: 'your-admin-api-key-here' });
    assert.ok(issues.some(i => /placeholder/.test(i)));
  });

  it('rejects a too-short key', () => {
    const issues = startupConfigIssues({ BRAIN_API_KEY: 'short' });
    assert.ok(issues.some(i => /at least 16 characters/.test(i)));
  });
});
