'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// Pure policy checks: importing this module must never discover or launch a backend.
const helperUrl = pathToFileURL(path.join(__dirname, '..', 'scripts', 'fvs-lean-diagnostics.mjs'));
async function evaluate(context) {
  const { evaluateReadiness } = await import(helperUrl.href);
  assert.equal(typeof evaluateReadiness, 'function');
  return evaluateReadiness(context);
}

function request(overrides = {}) {
  return {
    requestId: 'crypto-write-once',
    runtime: 'pi',
    channel: 'shell',
    role: 'fvs-crypto-executor',
    mode: 'crypto_execute',
    root: '/owned/lean-fixture',
    targets: ['/owned/lean-fixture/Probe.lean'],
    toolchain: { name: 'leanprover/lean4:v4.33.1' },
    requestedBackend: 'beam',
    requireLive: false,
    configuredCandidates: [],
    effectiveGrants: [],
    observations: [],
    fallbackAcceptance: null,
    ...overrides,
  };
}

function observedRequest() {
  const context = request({
    toolchain: { name: 'leanprover/lean4:v4.33.1', lean: '/owned/bin/lean', lake: '/owned/bin/lake' },
    savedFiles: [{ path: '/owned/lean-fixture/Probe.lean', sha256: 'a'.repeat(64), version: 2 }],
    hostControls: { verified: true, sourceWritesWithheld: true, evidence: '/owned/no-write-proof.json' },
  });
  const scope = {
    requestId: context.requestId, runtime: context.runtime, channel: context.channel,
    role: context.role, mode: context.mode, root: context.root, targets: context.targets,
    toolchain: context.toolchain,
  };
  context.observations = [{
    source: 'child-call', childId: 'same-writer', evidence: '/owned/call-record.json',
    scope, backend: 'beam', savedFiles: context.savedFiles,
    diagnostics: { status: 'ready', complete: true, errors: 0 },
    goals: { status: 'ready', callable: true },
    session: { owner: 'same-writer', generation: 'generation-1', status: 'running' },
  }];
  context.session = context.observations[0].session;
  return context;
}

describe('Lean diagnostics readiness does not infer child access', () => {
  it('leaves an unobserved child unknown rather than silently accepting compiler mode', async () => {
    const result = await evaluate(request());
    assert.equal(result.status, 'unknown');
    assert.notEqual(result.status, 'compiler-accepted');
  });

  it('does not promote configured Beam and shell grants to live readiness', async () => {
    const result = await evaluate(request({
      configuredCandidates: [{ backend: 'beam', path: '/owned/bin/lean-beam' }],
      effectiveGrants: [{ tool: 'bash', source: 'parent-definition' }],
    }));
    assert.equal(result.status, 'unknown');
  });

  it('blocks required-live with no observed diagnostics or goals', async () => {
    const result = await evaluate(request({ requireLive: true }));
    assert.equal(result.status, 'blocked');
  });

  it('does not accept a saved compiler preference as request-local consent', async () => {
    const result = await evaluate(request({ requestedBackend: 'compiler' }));
    assert.equal(result.status, 'blocked');
  });

  it('does not trust a supplied ready label without actual child evidence', async () => {
    const result = await evaluate(request({
      observations: [{ status: 'ready', source: 'project-config' }],
    }));
    assert.notEqual(result.status, 'ready');
    assert.notEqual(result.status, 'compiler-accepted');
  });

  it('accepts exact fresh child feedback under separately verified host controls', async () => {
    const result = await evaluate(observedRequest());
    assert.equal(result.status, 'ready');
    assert.equal(result.diagnostics, 'ready');
    assert.equal(result.goals, 'ready');
    assert.equal(result.evidenceSource, 'supplied-child-call');
  });

  for (const field of ['requestId', 'root', 'role', 'channel', 'runtime', 'mode']) {
    it(`rejects child evidence for another ${field}`, async () => {
      const context = observedRequest();
      context.observations[0].scope = { ...context.observations[0].scope, [field]: 'other' };
      assert.equal((await evaluate(context)).status, 'blocked');
    });
  }

  it('rejects stale saved-source evidence', async () => {
    const context = observedRequest();
    context.observations[0].savedFiles = [{ ...context.savedFiles[0], sha256: 'b'.repeat(64) }];
    assert.equal((await evaluate(context)).status, 'blocked');
  });

  it('rejects stale document versions independently of source hashes', async () => {
    const context = observedRequest();
    context.observations[0].savedFiles = [{ ...context.savedFiles[0], version: 1 }];
    assert.equal((await evaluate(context)).status, 'blocked');
  });

  it('treats errors under successful transport as semantic failure', async () => {
    const context = observedRequest();
    context.observations[0].ok = true;
    context.observations[0].diagnostics.errors = 1;
    assert.equal((await evaluate(context)).status, 'blocked');
  });

  it('does not promote incomplete elaboration', async () => {
    const context = observedRequest();
    context.observations[0].diagnostics.complete = false;
    assert.equal((await evaluate(context)).status, 'blocked');
  });

  it('reports unavailable goals separately and blocks the writer readiness gate', async () => {
    const context = observedRequest();
    context.observations[0].goals = { status: 'unknown' };
    const result = await evaluate(context);
    assert.equal(result.status, 'blocked');
    assert.equal(result.diagnostics, 'ready');
    assert.equal(result.goals, 'unknown');
  });

  it('does not replace host source-write controls with prompt instructions', async () => {
    const context = observedRequest();
    context.hostControls.sourceWritesWithheld = false;
    assert.equal((await evaluate(context)).status, 'blocked');
  });

  it('revokes readiness when the owned generation changes', async () => {
    const context = observedRequest();
    context.session = { ...context.session, generation: 'generation-2' };
    assert.equal((await evaluate(context)).status, 'blocked');
  });

  it('accepts warned explicit compiler consent for this request only', async () => {
    const context = request({ requestedBackend: 'compiler' });
    context.fallbackAcceptance = {
      warned: true, explicitlyAccepted: true,
      scope: { requestId: context.requestId, runtime: context.runtime, channel: context.channel,
        role: context.role, mode: context.mode, root: context.root, targets: context.targets,
        toolchain: context.toolchain },
    };
    assert.equal((await evaluate(context)).status, 'compiler-accepted');
    context.requestId = 'other-request';
    assert.equal((await evaluate(context)).status, 'blocked');
  });

  it('required-live rejects even explicitly accepted compiler consent', async () => {
    const context = request({ requestedBackend: 'compiler', requireLive: true });
    context.fallbackAcceptance = { warned: true, explicitlyAccepted: true, scope: context };
    assert.equal((await evaluate(context)).status, 'blocked');
  });

  it('rejects malformed policy without discarding unrelated preferences', async () => {
    const { diagnosticsPreferences } = await import(helperUrl.href);
    assert.deepEqual(diagnosticsPreferences({ unrelated: 1 }), {
      backend: 'auto', require_live: false, mcp_server: 'lean-lsp', beam_path: null,
    });
    assert.throws(() => diagnosticsPreferences({ diagnostics: { require_live: 'yes' } }));
    assert.throws(() => diagnosticsPreferences({ diagnostics: { backend: 'latest' } }));
  });

  it('has no backend discovery side effects on import', async () => {
    const source = fs.readFileSync(helperUrl, 'utf8');
    assert.doesNotMatch(source, /execSync\(|execFileSync\(/);
    assert.equal((await evaluate(request())).evidenceSource, 'none');
  });

  it('does not infer IDE goals from a diagnostic tool grant', async () => {
    const result = await evaluate(request({
      requestedBackend: 'ide',
      effectiveGrants: [{ tool: 'mcp__ide__getDiagnostics', source: 'parent-definition' }],
    }));
    assert.notEqual(result.status, 'ready');
  });
});
