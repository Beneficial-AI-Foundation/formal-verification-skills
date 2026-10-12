#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

export const BEAM_SOURCE = '6511cd96917d74cf59e03e303c69e2b6785aba78';
const BACKENDS = new Set(['auto', 'beam', 'mcp', 'ide', 'compiler', 'none']);
const SCOPE_FIELDS = ['requestId', 'runtime', 'channel', 'role', 'mode', 'root', 'targets', 'toolchain', 'requestedBackend'];
const DEFAULTS = { backend: 'auto', require_live: false, mcp_server: 'lean-lsp', beam_path: null };

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function diagnosticsPreferences(config = {}) {
  if (!object(config) || (config.diagnostics !== undefined && !object(config.diagnostics))) {
    throw new Error('diagnostics preferences must be an object');
  }
  const policy = { ...DEFAULTS, ...config.diagnostics };
  if (!BACKENDS.has(policy.backend) || typeof policy.require_live !== 'boolean' ||
      typeof policy.mcp_server !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(policy.mcp_server) ||
      (policy.beam_path !== null && (typeof policy.beam_path !== 'string' ||
        !path.isAbsolute(policy.beam_path) || /[\x00-\x1f\x7f]/.test(policy.beam_path)))) {
    throw new Error('invalid diagnostics preference; choose an exact backend/server/absolute Beam path');
  }
  // Only preferences: legacy readiness/consent fields cannot supply runtime evidence.
  for (const key of ['ready', 'available', 'qualification', 'fallbackAcceptance', 'compiler_accepted']) {
    if (Object.hasOwn(policy, key)) throw new Error(`diagnostics.${key} is not a durable preference`);
  }
  return policy;
}

function sameScope(context, scope) {
  return object(scope) && SCOPE_FIELDS.every(key =>
    context[key] !== undefined && isDeepStrictEqual(context[key], scope[key]));
}

function canonicalTarget(root, file) {
  return typeof file === 'string' && path.isAbsolute(file) && path.normalize(file) === file &&
    file.startsWith(root + path.sep) && !/[\x00-\x1f\x7f]/.test(file);
}

/** Evaluate supplied host evidence, not tool discovery, native enforcement or qualification. */
export function evaluateReadiness(context) {
  const result = {
    status: 'unknown', reason: 'no current child call evidence',
    diagnostics: 'unknown', goals: 'unknown', evidenceSource: 'none',
  };
  const blocked = reason => ({ ...result, status: 'blocked', reason });
  if (!object(context)) return blocked('request must be an object');
  const backend = context.requestedBackend ?? 'auto';
  if (!BACKENDS.has(backend) || (context.requireLive !== undefined && typeof context.requireLive !== 'boolean')) {
    return blocked('invalid backend or required-live policy');
  }
  if (typeof context.root !== 'string' || !path.isAbsolute(context.root) ||
      path.normalize(context.root) !== context.root || context.root === path.parse(context.root).root ||
      !Array.isArray(context.targets) || context.targets.length === 0 ||
      !context.targets.every(file => canonicalTarget(context.root, file)) ||
      new Set(context.targets).size !== context.targets.length ||
      !['requestId', 'runtime', 'channel', 'role', 'mode'].every(key =>
        typeof context[key] === 'string' && context[key].length > 0 && !/[\x00-\x1f\x7f]/.test(context[key])) ||
      !object(context.toolchain) || typeof context.toolchain.name !== 'string' || !context.toolchain.name) {
    return blocked('missing exact request/root/role/channel/toolchain/target scope');
  }
  if (context.requireLive && (backend === 'compiler' || backend === 'none')) {
    return blocked('required-live forbids compiler fallback');
  }
  const consent = context.fallbackAcceptance;
  if (consent !== null && consent !== undefined) {
    if (context.requireLive) return blocked('required-live forbids compiler fallback');
    if (!object(consent) || consent.warned !== true || consent.explicitlyAccepted !== true ||
        !sameScope(context, consent.scope) ||
        (context.session !== undefined && !isDeepStrictEqual(context.session, consent.scope?.session))) {
      return blocked('fallback warning/acceptance scope mismatch');
    }
    return { ...result, status: 'compiler-accepted', reason: 'warned request-local degraded compiler mode' };
  }
  if (backend === 'compiler') return blocked('warned explicit request-local compiler acceptance required');
  const observations = Array.isArray(context.observations) ? context.observations : [];
  const calls = observations.filter(call => object(call) && call.source === 'child-call' &&
    typeof call.childId === 'string' && call.childId.length > 0 &&
    typeof call.evidence === 'string' && call.evidence.length > 0);
  // Auto never chooses Beam merely because the child has a shell.
  const call = calls.find(item => backend === 'auto' ? ['mcp', 'ide'].includes(item.backend) : item.backend === backend);
  if (!call) return context.requireLive ? blocked('required-live has no current child feedback') : result;
  result.evidenceSource = 'supplied-child-call';
  if (!sameScope(context, call.scope)) return blocked('child feedback belongs to another request scope');
  if (!object(context.hostControls) || context.hostControls.verified !== true ||
      context.hostControls.sourceWritesWithheld !== true || !context.hostControls.evidence) {
    return blocked('native host source-write withholding is not verified');
  }
  const saved = context.savedFiles;
  if (!Array.isArray(saved) || saved.length !== context.targets.length ||
      !saved.every(file => object(file) && context.targets.includes(file.path) &&
        /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.version) && file.version >= 0) ||
      new Set(saved.map(file => file.path)).size !== saved.length ||
      !isDeepStrictEqual(saved, call.savedFiles)) {
    return blocked('saved-file hash or document version is stale/missing');
  }
  if (backend === 'beam') {
    const qualification = context.beamQualification;
    if (!object(qualification) || qualification.source !== 'host-qualification' ||
        !qualification.evidence || qualification.sourceRevision !== BEAM_SOURCE ||
        !isDeepStrictEqual(qualification.toolchain, context.toolchain) ||
        !/^[a-f0-9]{64}$/.test(qualification.bundleSha256)) {
      return blocked('Beam lacks supplied exact local source/bundle/toolchain qualification');
    }
  }
  if (backend === 'beam' && (!object(context.session) || context.session.status !== 'running' ||
      !context.session.owner || !context.session.generation ||
      !isDeepStrictEqual(context.session, call.session))) {
    return blocked('owned backend generation is missing/lost/changed');
  }
  const diagnostic = call.diagnostics;
  const goal = call.goals;
  if (object(diagnostic) && diagnostic.status === 'ready' && diagnostic.complete === true && diagnostic.errors === 0) {
    result.diagnostics = 'ready';
  } else if (object(diagnostic) && diagnostic.status !== 'unknown') result.diagnostics = 'blocked';
  if (object(goal) && goal.status === 'ready' && goal.callable === true) result.goals = 'ready';
  else if (object(goal) && goal.status !== 'unknown') result.goals = 'blocked';
  if (result.diagnostics !== 'ready' || result.goals !== 'ready') {
    return blocked('diagnostics and goals are separate; semantic error/pending/missing feedback');
  }
  return { ...result, status: 'ready', reason: 'supplied fresh child diagnostic/goal evidence; host remains authority' };
}

function readRequest(file) {
  if (!file || !path.isAbsolute(file)) throw new Error('request must be an absolute JSON file');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1048576) throw new Error('request must be a bounded regular file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(argv) {
  if (argv.length !== 3 || argv[0] !== 'preflight' || argv[1] !== '--request') {
    throw new Error('usage: fvs-lean-diagnostics.mjs preflight --request /absolute/request.json');
  }
  const result = evaluateReadiness(readRequest(argv[2]));
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.status === 'blocked' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`FVS_DIAGNOSTICS_ERROR: ${error.message}\n`); process.exitCode = 2; }
}
