import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedIntegerParam,
  enumParam,
  falseyParam,
  isInvalidBooleanParam,
  isInvalidIntegerParam,
  isInvalidIsoTimestampParam,
  requestBodyObject,
  stringParam,
  requestHasOperatorApproval,
  trimmedStringParam,
  isInvalidStringParam,
  truthyParam,
} from '../src/services/request-utils.js';

describe('request-utils', () => {
  it('clamps integer query params instead of passing unsafe limits through', () => {
    assert.equal(boundedIntegerParam('500', { defaultValue: 10, min: 1, max: 100 }), 100);
    assert.equal(boundedIntegerParam('-5', { defaultValue: 10, min: 1, max: 100 }), 1);
    assert.equal(boundedIntegerParam('not-a-number', { defaultValue: 10, min: 1, max: 100 }), 10);
    assert.equal(boundedIntegerParam(undefined, { defaultValue: 25, min: 1, max: 100 }), 25);
    assert.equal(boundedIntegerParam(['5', '100'], { defaultValue: 10, min: 1, max: 100 }), 10);
    assert.equal(boundedIntegerParam({ value: '5' }, { defaultValue: 10, min: 1, max: 100 }), 10);
    assert.equal(boundedIntegerParam('5abc', { defaultValue: 10, min: 1, max: 100 }), 10);
    assert.equal(boundedIntegerParam(' 5 ', { defaultValue: 10, min: 1, max: 100 }), 5);
    assert.equal(boundedIntegerParam(5.5, { defaultValue: 10, min: 1, max: 100 }), 10);
  });

  it('identifies malformed integer params so routes can fail narrow', () => {
    assert.equal(isInvalidIntegerParam(undefined), false);
    assert.equal(isInvalidIntegerParam(''), false);
    assert.equal(isInvalidIntegerParam('5'), false);
    assert.equal(isInvalidIntegerParam('-5'), false);
    assert.equal(isInvalidIntegerParam(5), false);
    assert.equal(isInvalidIntegerParam('5abc'), true);
    assert.equal(isInvalidIntegerParam('many'), true);
    assert.equal(isInvalidIntegerParam(5.5), true);
    assert.equal(isInvalidIntegerParam(['5']), true);
    assert.equal(isInvalidIntegerParam({ value: 5 }), true);
    assert.equal(isInvalidIntegerParam('-1', { min: 0 }), true);
    assert.equal(isInvalidIntegerParam('0', { min: 0 }), false);
  });

  it('normalizes enum query params case-insensitively', () => {
    assert.equal(enumParam('INDEX', ['index', 'compact', 'full'], 'compact'), 'index');
    assert.equal(enumParam(' surprise ', ['index', 'compact', 'full'], 'compact'), 'compact');
  });

  it('rejects repeated/object query params where a scalar string is required', () => {
    assert.equal(stringParam('alpha'), 'alpha');
    assert.equal(stringParam(['alpha', 'beta']), undefined);
    assert.equal(trimmedStringParam('  alpha  '), 'alpha');
    assert.equal(trimmedStringParam(['alpha']), undefined);
    assert.equal(isInvalidStringParam(['alpha']), true);
    assert.equal(isInvalidStringParam({ agent: 'alpha' }), true);
    assert.equal(isInvalidStringParam(''), false);
    assert.equal(isInvalidStringParam(undefined), false);
  });

  it('identifies malformed timestamp params so routes can fail narrow before SQL casts', () => {
    assert.equal(isInvalidIsoTimestampParam(undefined), false);
    assert.equal(isInvalidIsoTimestampParam(''), false);
    assert.equal(isInvalidIsoTimestampParam('2026-05-20T12:34:56Z'), false);
    assert.equal(isInvalidIsoTimestampParam('2026-05-20T12:34:56+04:30'), false);
    assert.equal(isInvalidIsoTimestampParam('2026-05-20'), false);
    assert.equal(isInvalidIsoTimestampParam('not-a-date'), true);
    assert.equal(isInvalidIsoTimestampParam('05/20/2026'), true);
    assert.equal(isInvalidIsoTimestampParam('2026-02-30'), true);
    assert.equal(isInvalidIsoTimestampParam('2026-2-3'), true);
    assert.equal(isInvalidIsoTimestampParam('123'), true);
    assert.equal(isInvalidIsoTimestampParam('2026-05-20T25:00:00Z'), true);
    assert.equal(isInvalidIsoTimestampParam('2026-05-20T12:60:00Z'), true);
    assert.equal(isInvalidIsoTimestampParam(['2026-05-20T00:00:00Z']), true);
    assert.equal(isInvalidIsoTimestampParam({ value: '2026-05-20T00:00:00Z' }), true);
  });

  it('normalizes missing or malformed JSON request bodies to an empty object', () => {
    assert.deepEqual(requestBodyObject({ body: undefined }), {});
    assert.deepEqual(requestBodyObject({ body: null }), {});
    assert.deepEqual(requestBodyObject({ body: ['not', 'an', 'object'] }), {});
    assert.deepEqual(requestBodyObject({ body: 'not an object' }), {});
    assert.deepEqual(requestBodyObject({ body: { type: 'event' } }), { type: 'event' });
  });

  it('parses common boolean query spellings', () => {
    assert.equal(truthyParam('YES'), true);
    assert.equal(truthyParam('0'), false);
    assert.equal(falseyParam('No'), true);
    assert.equal(falseyParam('1'), false);
  });

  it('identifies malformed boolean params so routes can fail narrow', () => {
    assert.equal(isInvalidBooleanParam(undefined), false);
    assert.equal(isInvalidBooleanParam(''), false);
    assert.equal(isInvalidBooleanParam(true), false);
    assert.equal(isInvalidBooleanParam('YES'), false);
    assert.equal(isInvalidBooleanParam('off'), false);
    assert.equal(isInvalidBooleanParam('maybe'), true);
    assert.equal(isInvalidBooleanParam(2), true);
    assert.equal(isInvalidBooleanParam(['true']), true);
  });

  it('detects explicit operator approval only from scalar truthy body or query params', () => {
    assert.equal(requestHasOperatorApproval({ body: { operator_approved: true }, query: {} }), true);
    assert.equal(requestHasOperatorApproval({ body: {}, query: { operator_approved: 'true' } }), true);
    assert.equal(requestHasOperatorApproval({ body: { operator_approved: false }, query: {} }), false);
    assert.equal(requestHasOperatorApproval({ body: {}, query: { operator_approved: '0' } }), false);
    assert.equal(requestHasOperatorApproval({ body: { operator_approved: ['true'] }, query: {} }), false);
    assert.equal(requestHasOperatorApproval({ body: {}, query: {} }), false);
  });
});
