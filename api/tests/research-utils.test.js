import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseResearchJson,
  normalizeSufficiency,
  buildGapQuery,
  groundResearchSynthesis,
} from '../src/services/research-utils.js';

describe('research-utils', () => {
  it('parses fenced / chattery LLM JSON', () => {
    assert.deepEqual(
      parseResearchJson('```json\n{"status":"SUFFICIENT","missing":[]}\n```'),
      { status: 'SUFFICIENT', missing: [] }
    );
    assert.deepEqual(
      parseResearchJson('Sure:\n{"status":"INSUFFICIENT"}\nthanks'),
      { status: 'INSUFFICIENT' }
    );
  });

  it('throws on non-object research JSON', () => {
    assert.throws(() => parseResearchJson('not json'), /invalid JSON/);
    assert.throws(() => parseResearchJson('[1,2,3]'), /non-object JSON/);
  });

  it('normalizes the sufficiency gate fail-safe to INSUFFICIENT', () => {
    assert.deepEqual(
      normalizeSufficiency({ status: 'sufficient', reason: 'has it', missing: [], draft: 'd' }),
      { status: 'SUFFICIENT', reason: 'has it', missing: [], draft: 'd' }
    );
    // missing/unknown status => INSUFFICIENT (gather more, don't guess)
    assert.equal(normalizeSufficiency({}).status, 'INSUFFICIENT');
    assert.equal(normalizeSufficiency({ status: 'maybe' }).status, 'INSUFFICIENT');
    // junk fields don't crash; arrays cleaned
    assert.deepEqual(normalizeSufficiency({ missing: ['  a ', 7, '', 'b'] }).missing, ['a', 'b']);
  });

  it('builds the next gap query from missing items, then reason', () => {
    assert.equal(
      buildGapQuery({ missing: ['spec of server X', 'deploy date'], reason: 'x' }),
      'spec of server X; deploy date'
    );
    assert.equal(buildGapQuery({ missing: [], reason: 'need the date' }), 'need the date');
    assert.equal(buildGapQuery({ missing: [], reason: '' }), '');
  });

  it('grounds synthesis citations against retrieved ids', () => {
    const synth = {
      answer: 'M*A*S*H ran 150 min [mem:a], 52 longer than Cheers [mem:ghost]',
      key_findings: ['Cheers ran 98 min [mem:b]', 'fabricated [mem:nope]'],
      unresolved: ['exact airdate'],
    };
    const out = groundResearchSynthesis(synth, ['a', 'b']);
    assert.equal(out.answer, 'M*A*S*H ran 150 min [mem:a], 52 longer than Cheers');
    assert.deepEqual(out.key_findings, ['Cheers ran 98 min [mem:b]', 'fabricated']);
    assert.deepEqual(out.unresolved, ['exact airdate']);
    assert.deepEqual(out.cited_memory_ids, ['a', 'b']);
  });

  it('handles a synthesis missing fields without throwing', () => {
    const out = groundResearchSynthesis({}, ['a']);
    assert.deepEqual(out, { answer: '', key_findings: [], unresolved: [], cited_memory_ids: [] });
  });
});
