import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { ClientResolver } from '../src/services/client-resolver.js';

describe('ClientResolver', () => {
  let resolver;

  before(() => {
    resolver = new ClientResolver();
    resolver.loadFingerprints([
      { client_id: 'jetloans', fingerprints: { aliases: ['JL', 'Jet Loans'], people: ['Brandon'], domains: ['jetloans.ca'], keywords: ['Granby'] } },
      { client_id: 'credit-instant', fingerprints: { aliases: ['Credit Instant', 'CI'], people: ['Brandon'], domains: ['creditinstant.com'], keywords: ['Quebec City'] } },
      { client_id: 'biolistix', fingerprints: { aliases: ['Bio'], people: ['Dominique'], domains: ['biolistix.ca'], keywords: [] } },
    ]);
  });

  it('should resolve by alias', () => {
    assert.strictEqual(resolver.resolve('Talked to JL about their SEO strategy'), 'jetloans');
  });

  it('should resolve by domain', () => {
    assert.strictEqual(resolver.resolve('Updated jetloans.ca homepage'), 'jetloans');
  });

  it('should resolve by person + context', () => {
    assert.strictEqual(resolver.resolve('Brandon called about Granby store'), 'jetloans');
  });

  it('should return null when below threshold', () => {
    assert.strictEqual(resolver.resolve('Had a meeting today about loans'), null);
  });

  it('should return array for multi-client content', () => {
    const result = resolver.resolve('Discussed jetloans.ca redesign and Biolistix supplement strategy');
    assert.ok(Array.isArray(result));
    assert.ok(result.includes('jetloans'));
    assert.ok(result.includes('biolistix'));
  });

  it('should be case-insensitive', () => {
    assert.strictEqual(resolver.resolve('JETLOANS website is down'), 'jetloans');
  });

  it('should handle accented characters', () => {
    assert.strictEqual(resolver.resolve('Crédit Instant needs new landing page for Québec City'), 'credit-instant');
  });
});
