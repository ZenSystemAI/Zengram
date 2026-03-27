import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { ClientResolver } from '../src/services/client-resolver.js';

describe('ClientResolver', () => {
  let resolver;

  before(() => {
    resolver = new ClientResolver();
    resolver.loadFingerprints([
      { client_id: 'acme-loans', fingerprints: { aliases: ['AL', 'Acme Loans'], people: ['Alex'], domains: ['acme-loans.ca'], keywords: ['Springfield'] } },
      { client_id: 'quickcredit', fingerprints: { aliases: ['QuickCredit', 'QC'], people: ['Alex'], domains: ['quickcredit.com'], keywords: ['Riverside'] } },
      { client_id: 'greenlife', fingerprints: { aliases: ['GL'], people: ['Jordan'], domains: ['greenlife.ca'], keywords: [] } },
    ]);
  });

  it('should resolve by alias', () => {
    assert.strictEqual(resolver.resolve('Talked to AL about their SEO strategy'), 'acme-loans');
  });

  it('should resolve by domain', () => {
    assert.strictEqual(resolver.resolve('Updated acme-loans.ca homepage'), 'acme-loans');
  });

  it('should resolve by person + context', () => {
    assert.strictEqual(resolver.resolve('Alex called about Springfield store'), 'acme-loans');
  });

  it('should return null when below threshold', () => {
    assert.strictEqual(resolver.resolve('Had a meeting today about loans'), null);
  });

  it('should return array for multi-client content', () => {
    const result = resolver.resolve('Discussed acme-loans.ca redesign and GreenLife supplement strategy');
    assert.ok(Array.isArray(result));
    assert.ok(result.includes('acme-loans'));
    assert.ok(result.includes('greenlife'));
  });

  it('should be case-insensitive', () => {
    assert.strictEqual(resolver.resolve('ACME-LOANS website is down'), 'acme-loans');
  });

  it('should handle accented characters', () => {
    assert.strictEqual(resolver.resolve('QuickCrédit needs new landing page for Riverside'), 'quickcredit');
  });
});
