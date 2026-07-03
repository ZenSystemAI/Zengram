import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeQuery, expandQuery, extractSearchTerms } from '../src/services/query-expander.js';

describe('analyzeQuery', () => {
  it('detects a preference-style query with a domain', () => {
    const result = analyzeQuery('can you recommend a good show to watch?');
    assert.equal(result.isVague, true);
    assert.equal(result.domain, 'entertainment');
    assert.ok(Array.isArray(result.expansions) && result.expansions.length > 0);
    assert.equal(result.originalQuery, 'can you recommend a good show to watch?');
  });

  it('non-preference technical queries are not vague', () => {
    const result = analyzeQuery('postgres connection pool settings');
    assert.equal(result.isVague, false);
  });

  it('returns no domain when nothing matches', () => {
    const result = analyzeQuery('what did the deployment change?');
    assert.equal(result.domain, undefined);
  });

  it('picks the highest-scoring domain on mixed triggers', () => {
    // two music triggers vs one food trigger
    const result = analyzeQuery('what album or playlist for dinner');
    assert.equal(result.domain, 'music');
  });
});

describe('expandQuery', () => {
  it('appends the first expansion', () => {
    assert.equal(expandQuery('recommend a show', ['a b c']), 'recommend a show a b c');
  });
  it('returns the original when there are no expansions', () => {
    assert.equal(expandQuery('recommend a show', []), 'recommend a show');
    assert.equal(expandQuery('recommend a show', null), 'recommend a show');
  });
});

describe('extractSearchTerms', () => {
  it('strips scaffolding and stopwords, keeps topic terms', () => {
    const terms = extractSearchTerms('What restaurants did I say I like in Montreal?');
    assert.equal(terms, 'restaurants say like montreal');
  });
  it('drops short words', () => {
    assert.equal(extractSearchTerms('is it up?'), '');
  });
});
