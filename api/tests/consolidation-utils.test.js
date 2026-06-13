import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LlmOutputError,
  consolidationJobStatus,
  consolidationRunStatus,
  extractConsolidationJson,
  isSupersedableType,
  parseConsolidationResponse,
} from '../src/services/consolidation-utils.js';

describe('extractConsolidationJson', () => {
  it('extracts fenced JSON', () => {
    assert.equal(
      extractConsolidationJson('```json\n{"merged_facts":[]}\n```'),
      '{"merged_facts":[]}'
    );
  });

  it('extracts the first balanced object from local-model chatter', () => {
    assert.equal(
      extractConsolidationJson('Here is the result:\n{"merged_facts":[{"content":"a {nested} value"}]}\nDone.'),
      '{"merged_facts":[{"content":"a {nested} value"}]}'
    );
  });
});

describe('parseConsolidationResponse', () => {
  it('parses a valid consolidation object', () => {
    assert.deepEqual(parseConsolidationResponse('{"merged_facts":[],"contradictions":[]}'), {
      merged_facts: [],
      contradictions: [],
    });
  });

  it('allows missing optional arrays', () => {
    assert.deepEqual(parseConsolidationResponse('{}'), {});
  });

  it('rejects invalid JSON as retryable LLM output', () => {
    assert.throws(
      () => parseConsolidationResponse('{not json'),
      (err) => err instanceof LlmOutputError && err.retryable === true
    );
  });

  it('rejects non-object JSON', () => {
    assert.throws(
      () => parseConsolidationResponse('[]'),
      /non-object JSON/
    );
  });

  it('rejects present consolidation fields with non-array values', () => {
    assert.throws(
      () => parseConsolidationResponse('{"merged_facts":{"content":"bad"}}'),
      /merged_facts must be an array/
    );
  });
});

describe('consolidation status helpers', () => {
  it('marks runs with failed batches as partial', () => {
    assert.equal(consolidationRunStatus([]), 'complete');
    assert.equal(consolidationRunStatus([{ error: 'invalid JSON' }]), 'partial');
  });

  it('maps partial run results to partial async jobs', () => {
    assert.equal(consolidationJobStatus({ status: 'complete' }), 'complete');
    assert.equal(consolidationJobStatus({ status: 'partial' }), 'partial');
  });
});

describe('isSupersedableType', () => {
  it('allows superseding facts and statuses', () => {
    assert.equal(isSupersedableType('fact'), true);
    assert.equal(isSupersedableType('status'), true);
  });

  it('preserves events and decisions as historical records', () => {
    assert.equal(isSupersedableType('event'), false);
    assert.equal(isSupersedableType('decision'), false);
  });

  it('rejects unknown or missing types', () => {
    assert.equal(isSupersedableType('insight'), false);
    assert.equal(isSupersedableType(''), false);
    assert.equal(isSupersedableType(null), false);
    assert.equal(isSupersedableType(undefined), false);
  });
});
