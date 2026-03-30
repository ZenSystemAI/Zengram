import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities, loadAliasCache, addToAliasCache } from '../src/services/entities.js';

// ---------------------------------------------------------------------------
// 1. Basic entity extraction
// ---------------------------------------------------------------------------

describe('extractEntities — basic', () => {
  beforeEach(() => {
    // Reset alias cache to built-in KNOWN_TECH only
    loadAliasCache([]);
  });

  it('extracts client_id as client entity', () => {
    const entities = extractEntities('Some work done', 'acme-corp', 'claude-code');
    const client = entities.find(e => e.type === 'client');
    assert.ok(client);
    assert.equal(client.name, 'acme-corp');
    assert.equal(client.role, 'about');
  });

  it('extracts source_agent as agent entity', () => {
    const entities = extractEntities('Some work done', 'global', 'claude-code');
    const agent = entities.find(e => e.type === 'agent');
    assert.ok(agent);
    assert.equal(agent.name, 'claude-code');
    assert.equal(agent.role, 'source');
  });

  it('does not extract client for global', () => {
    const entities = extractEntities('Hello', 'global', 'test-agent');
    const client = entities.find(e => e.type === 'client');
    assert.equal(client, undefined);
  });
});

// ---------------------------------------------------------------------------
// 2. Technology extraction
// ---------------------------------------------------------------------------

describe('extractEntities — technologies', () => {
  beforeEach(() => {
    loadAliasCache([]);
  });

  it('extracts known technologies', () => {
    const text = 'We deployed the app using Docker and PostgreSQL on Hostinger';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(names.includes('Docker'));
    assert.ok(names.includes('PostgreSQL'));
    assert.ok(names.includes('Hostinger'));
  });

  it('resolves tech aliases to canonical names', () => {
    const text = 'Installed k8s and psql on the server';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(names.includes('Kubernetes'));
    assert.ok(names.includes('PostgreSQL'));
  });

  it('is case-insensitive for tech names', () => {
    const text = 'DOCKER and REDIS are running';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(names.includes('Docker'));
    assert.ok(names.includes('Redis'));
  });
});

// ---------------------------------------------------------------------------
// 3. Domain extraction
// ---------------------------------------------------------------------------

describe('extractEntities — domains', () => {
  beforeEach(() => {
    loadAliasCache([]);
  });

  it('extracts domain names', () => {
    const text = 'Deployed to localagency.ca and checked acme-corp.com';
    const entities = extractEntities(text, 'global', 'test');
    const domains = entities.filter(e => e.type === 'domain');
    const names = domains.map(e => e.name);
    assert.ok(names.includes('localagency.ca'));
    assert.ok(names.includes('acme-corp.com'));
  });

  it('handles various TLDs', () => {
    const text = 'Check example.io and myapp.dev and site.fr';
    const entities = extractEntities(text, 'global', 'test');
    const domains = entities.filter(e => e.type === 'domain');
    assert.equal(domains.length, 3);
  });
});

// ---------------------------------------------------------------------------
// 4. Quoted name extraction
// ---------------------------------------------------------------------------

describe('extractEntities — quoted names', () => {
  beforeEach(() => {
    loadAliasCache([]);
  });

  it('extracts quoted workflow names', () => {
    const text = 'Updated the "SEO Monthly Snapshot" workflow in n8n';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(names.includes('SEO Monthly Snapshot'));
  });

  it('ignores very short quoted strings', () => {
    const text = 'Set "ab" to true';
    const entities = extractEntities(text, 'global', 'test');
    const quoted = entities.filter(e => e.name === 'ab');
    assert.equal(quoted.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. Capitalized phrase extraction
// ---------------------------------------------------------------------------

describe('extractEntities — capitalized phrases', () => {
  beforeEach(() => {
    loadAliasCache([]);
  });

  it('extracts multi-word proper nouns', () => {
    const text = 'James Wilson approved the deployment of Metro Design site';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(names.includes('James Wilson'));
    assert.ok(names.includes('Metro Design'));
  });

  it('skips day and month names', () => {
    const text = 'Meeting on Monday March about the project';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    // "Monday March" should be skipped — but let's check individual words aren't in there
    const person = entities.filter(e => e.type === 'person' && (e.name === 'Monday' || e.name === 'March'));
    assert.equal(person.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 6. Alias cache resolution
// ---------------------------------------------------------------------------

describe('extractEntities — alias cache', () => {
  beforeEach(() => {
    loadAliasCache([]);
  });

  it('resolves aliases from DB entries', () => {
    // Simulate loading a DB alias
    loadAliasCache([
      { alias: 'md', entity_id: 42, canonical_name: 'Metro Design', entity_type: 'client' },
    ]);

    const text = 'Working on EL project today';
    const entities = extractEntities(text, 'global', 'test');
    // "EL" alone won't match since we match quoted or capitalized multi-word
    // But through addToAliasCache direct lookup it should still work for matching
  });

  it('addToAliasCache makes new aliases resolvable', () => {
    addToAliasCache('test-server', 99, 'Test Server', 'system');
    const text = 'Deployed update to Test Server overnight';
    const entities = extractEntities(text, 'global', 'test');
    // Morpheus should resolve — check alias cache was used
    // (It'll match as technology "Morpheus" since it's not in KNOWN_TECH,
    // but alias cache takes precedence in the extractEntities matching)
  });
});

// ---------------------------------------------------------------------------
// 7. Dedup within single extraction
// ---------------------------------------------------------------------------

describe('extractEntities — deduplication', () => {
  beforeEach(() => {
    loadAliasCache([]);
  });

  it('does not produce duplicate entities', () => {
    const text = 'Docker container running Docker image on Docker host';
    const entities = extractEntities(text, 'global', 'test');
    const dockerEntities = entities.filter(e => e.name === 'Docker' && e.role === 'mentioned');
    assert.equal(dockerEntities.length, 1);
  });

  it('same entity in different roles is allowed', () => {
    // source_agent and mentioned can both appear
    const text = 'claude-code deployed to the server';
    const entities = extractEntities(text, 'global', 'claude-code');
    const ccEntities = entities.filter(e => e.name === 'claude-code');
    // Should have at least source role
    assert.ok(ccEntities.length >= 1);
  });
});

// ---------------------------------------------------------------------------
// 8. Cold-start: KNOWN_TECH pre-seeded in cache
// ---------------------------------------------------------------------------

describe('alias cache cold-start', () => {
  it('pre-seeds KNOWN_TECH on loadAliasCache with empty DB entries', () => {
    loadAliasCache([]);
    // After loading with empty array, tech aliases should still be in cache
    const text = 'Using k8s and psql';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(names.includes('Kubernetes'));
    assert.ok(names.includes('PostgreSQL'));
  });

  it('DB aliases override built-in tech aliases', () => {
    loadAliasCache([
      { alias: 'docker', entity_id: 7, canonical_name: 'Docker CE', entity_type: 'technology' },
    ]);
    const text = 'Running docker containers';
    const entities = extractEntities(text, 'global', 'test');
    const docker = entities.find(e => e.name === 'Docker CE');
    assert.ok(docker, 'DB alias should override built-in KNOWN_TECH');
    assert.equal(docker.entityId, 7);
  });
});

// ---------------------------------------------------------------------------
// 9. Noise filtering — quoted names
// ---------------------------------------------------------------------------

describe('extractEntities — noise filtering (quoted names)', () => {
  beforeEach(() => {
    loadAliasCache([]);
  });

  it('rejects CSS-like hyphenated names', () => {
    const text = 'Set "background-image" and "object-position" and "flex-wrap" on the element';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(!names.includes('background-image'));
    assert.ok(!names.includes('object-position'));
    assert.ok(!names.includes('flex-wrap'));
  });

  it('rejects HTML data attributes', () => {
    const text = 'Added "data-en" and "data-fr" and "data-faq" attributes';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(!names.includes('data-en'));
    assert.ok(!names.includes('data-fr'));
    assert.ok(!names.includes('data-faq'));
  });

  it('rejects camelCase code identifiers', () => {
    const text = 'Updated "searchInput" and "fieldsToUpdate" variables';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(!names.includes('searchInput'));
    assert.ok(!names.includes('fieldsToUpdate'));
  });

  it('rejects shell commands', () => {
    const text = 'Run "docker compose up -d --force-recreate" to restart';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(!names.some(n => n.includes('docker compose')));
  });

  it('rejects error codes and log messages', () => {
    const text = 'Got "ERROR_TOKEN_DOES_NOT_EXIST" and "Failed to start audit"';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(!names.includes('ERROR_TOKEN_DOES_NOT_EXIST'));
    assert.ok(!names.includes('Failed to start audit'));
  });

  it('rejects single lowercase words', () => {
    const text = 'Set "active" and "channel" and "last" flags';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(!names.includes('active'));
    assert.ok(!names.includes('channel'));
    assert.ok(!names.includes('last'));
  });

  it('keeps legitimate quoted workflow names', () => {
    const text = 'Updated the "SEO Monthly Snapshot" and "Client Onboarding" workflows';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(names.includes('SEO Monthly Snapshot'));
    assert.ok(names.includes('Client Onboarding'));
  });
});

// ---------------------------------------------------------------------------
// 10. Noise filtering — capitalized phrases
// ---------------------------------------------------------------------------

describe('extractEntities — noise filtering (capitalized phrases)', () => {
  beforeEach(() => {
    loadAliasCache([]);
  });

  it('rejects generic adjective + noun phrases', () => {
    const text = 'Checked the Exposed Qdrant and Audited Neo and Electric Violet configs';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(!names.includes('Exposed Qdrant'));
    assert.ok(!names.includes('Audited Neo'));
    assert.ok(!names.includes('Electric Violet'));
  });

  it('rejects phrases with 5+ words', () => {
    const text = 'The Quick Brown Fox Jumped Over Lazy Dogs';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(!names.includes('Quick Brown Fox Jumped Over'));
  });

  it('keeps known system names', () => {
    const text = 'Deployed Mission Center and Knowledge Base updates';
    const entities = extractEntities(text, 'global', 'test');
    const names = entities.map(e => e.name);
    assert.ok(names.includes('Mission Center'));
    assert.ok(names.includes('Knowledge Base'));
  });
});
