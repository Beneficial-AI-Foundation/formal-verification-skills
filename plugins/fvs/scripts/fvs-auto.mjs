#!/usr/bin/env node
'use strict';

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  CONFINEMENT_UNAVAILABLE,
  PROBE_RELEASE,
  TESTED_TUPLES,
  executableFile,
  hostTarget,
  managedProbePath,
  readOnlyRun,
  resolveProbe,
  which,
} from './fvs-probe-inventory.mjs';

const GREEN = 'supported-and-tested';

function fatal(message) {
  throw new Error(message);
}

function usage() {
  process.stdout.write([
    'Usage: node fvs-auto.mjs profile [--project-root DIR] [--format json|text]',
    '       node fvs-auto.mjs init-state --input CHOICES.json [--project-root DIR] [--confirm-overwrite]',
    '       node fvs-auto.mjs read-state [--project-root DIR]',
    '       node fvs-auto.mjs record-roadmap --decision accepted|declined [--project-root DIR] [--confirm-overwrite]',
    '       node fvs-auto.mjs record-extraction --out OUT --build-exit-code N [--project-root DIR]',
    '       node fvs-auto.mjs record-externals --input RECORDS.json [--project-root DIR]',
    '',
    'profile reports what this host and project can do for the FVS auto track,',
    'one verdict per item: supported-and-tested, available-but-unverified,',
    'incompatible, missing, unsupported-platform or not-extracted-yet.',
    'It only detects: it never installs, downloads or modifies anything.',
    '',
    'The state subcommands keep the milestone 1 auto-track state under',
    '.formalising/auto-fv/ in the project root: state.json (profile, owner choices,',
    'roadmap decision, extraction record) and externals.json (one record per',
    'boundary). Every write is atomic; malformed files are reported, never',
    'overwritten. They print one JSON result. Exit codes: 0 ok; 1 refused',
    '(confirmation required, blocked profile, failed extraction, record loss,',
    'invalid input, no state); 2 usage or internal error; 3 malformed state.',
  ].join('\n') + '\n');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function firstLine(text) {
  return (text ?? '').split(/\r?\n/)[0].trim();
}

// Version checks run only under the resolver's read-only confinement
// (sandbox-exec on macOS, bubblewrap on Linux): unconfined, a rustup or elan
// proxy could download the toolchain a project pins. Where confinement is
// unavailable the check is skipped and `skipped` says why.
function versionCheck(bin, args, cwd, root) {
  const run = readOnlyRun(bin, args, cwd, { projectRoot: root });
  const unavailable = run.confinementError ?? (run.output === CONFINEMENT_UNAVAILABLE ? run.output : null);
  return { ...run, skipped: unavailable ? `not checked: ${unavailable}` : null };
}

function item(id, verdict, reason, nextStep, evidence, scope = null) {
  return {
    id,
    verdict,
    reason,
    nextStep: verdict === GREEN ? null : nextStep,
    ...(scope ? { scope } : {}),
    evidence,
  };
}

function sameAeneas(rev, tuple) {
  return typeof rev === 'string' && /^[0-9a-f]{7,40}$/.test(rev) && tuple.aeneasRev.startsWith(rev);
}

// Compares a project tuple with every tested tuple. Sharing a tested Aeneas
// revision while pinning another Charon or Lean contradicts that tuple's
// evidence; merely differing from every tested tuple does not.
function compareTuples({ aeneas, charon, lean }) {
  const exact = TESTED_TUPLES.find((tuple) => sameAeneas(aeneas, tuple) &&
    charon === tuple.charonVersion && lean === tuple.leanToolchain) ?? null;
  const contradictions = [];
  if (!exact) {
    for (const tuple of TESTED_TUPLES.filter((entry) => sameAeneas(aeneas, entry))) {
      if (charon !== null && charon !== tuple.charonVersion) {
        contradictions.push(`Aeneas ${aeneas} was tested with Charon ${tuple.charonVersion} (${tuple.id}); this project has Charon ${charon}`);
      }
      if (lean !== null && lean !== tuple.leanToolchain) {
        contradictions.push(`Aeneas ${aeneas} was tested with ${tuple.leanToolchain} (${tuple.id}); this project pins ${lean}`);
      }
    }
  }
  const differences = TESTED_TUPLES.map((tuple) => {
    const fields = [];
    if (!sameAeneas(aeneas, tuple)) fields.push(`Aeneas ${aeneas ?? 'unknown'} vs ${tuple.aeneasRev}`);
    if (charon !== tuple.charonVersion) fields.push(`Charon ${charon ?? 'unknown'} vs ${tuple.charonVersion}`);
    if (lean !== tuple.leanToolchain) fields.push(`Lean ${lean ?? 'unknown'} vs ${tuple.leanToolchain}`);
    return `${tuple.id} (${fields.join(', ')})`;
  });
  return { exact, contradictions, differences };
}

function hostItem(platform) {
  const evidence = { os: process.platform, arch: process.arch, target: platform };
  const tested = TESTED_TUPLES.filter((tuple) => tuple.platforms[platform]).map((tuple) => tuple.id);
  if (tested.length === 0) {
    const asset = PROBE_RELEASE.assets[platform];
    const probeReason = asset?.reason ?? `no official probe-aeneas ${PROBE_RELEASE.tag} asset exists for it`;
    const hosts = [...new Set(TESTED_TUPLES.flatMap((tuple) => Object.keys(tuple.platforms)))].join(', ');
    return item('host', 'unsupported-platform', `${platform} has no recorded FVS confined run: ${probeReason}`,
      `Use a host with recorded evidence (${hosts}) for the auto track; here only exploratory work without a graph is possible.`,
      evidence);
  }
  return item('host', 'available-but-unverified',
    `${platform} has recorded confined-run evidence only for the probe-aeneas inventory operation (${tested.join(', ')}); no other auto-track operation is validated on any host`,
    'None for the host; the probe item states what is tested for this project.',
    evidence);
}

function aoItem() {
  const found = which('ao');
  if (!found) {
    return item('ao', 'missing', 'the ao CLI is not on PATH; the auto commands require Agent Orchestrator',
      'Install Agent Orchestrator and put its ao CLI on PATH, then rerun the profile.', { path: null });
  }
  return item('ao', 'available-but-unverified', `ao is on PATH at ${found}; FVS records no tested Agent Orchestrator version`,
    'None required now.', { path: found });
}

// The toolchain as the crate directory sees it: rustup reads a pin from the
// crate directory or any parent, so the crate directory is checked first.
function rustItem(root, rustProject) {
  const pinFile = [...new Set([rustProject, root])]
    .flatMap((directory) => ['rust-toolchain.toml', 'rust-toolchain'].map((name) => path.join(directory, name)))
    .find((file) => fs.existsSync(file)) ?? null;
  const toolchainFile = pinFile && path.relative(root, pinFile);
  const evidence = {
    rustup: which('rustup'),
    cargo: which('cargo'),
    rustc: which('rustc'),
    toolchainFile,
    toolchainPin: pinFile ? readText(pinFile)?.trim() ?? null : null,
    version: null,
    hostTarget: null,
  };
  const absent = ['cargo', 'rustc'].filter((name) => !evidence[name]);
  if (absent.length > 0) {
    return item('rust', 'missing', `${absent.join(' and ')} not on PATH`,
      'Install Rust with rustup (https://rustup.rs), then rerun the profile.', evidence);
  }
  const pinned = toolchainFile ? `, pinned by ${toolchainFile}` : '';
  const run = versionCheck(evidence.rustc, ['-vV'], rustProject, root);
  if (run.skipped) {
    return item('rust', 'available-but-unverified', `cargo and rustc are on PATH${pinned}; the version was ${run.skipped}`,
      'Run rustc -vV in the crate directory yourself to confirm the toolchain.', evidence);
  }
  if (!run.ok) {
    return item('rust', 'available-but-unverified', `rustc is on PATH but rustc -vV failed in the crate directory: ${firstLine(run.output)}`,
      'Run rustc -vV in the crate directory and fix the reported error (a pinned toolchain may need rustup toolchain install).',
      evidence);
  }
  evidence.version = firstLine(run.stdout);
  evidence.hostTarget = run.stdout.match(/^host: (.+)$/m)?.[1] ?? null;
  return item('rust', 'available-but-unverified',
    `${evidence.version} for ${evidence.hostTarget ?? 'an unknown host'}${pinned}; FVS records no tested Rust toolchain for the auto track`,
    'None required now.', evidence);
}

function leanItem(root) {
  const evidence = {
    toolchain: readText(path.join(root, 'lean-toolchain'))?.trim() || null,
    lakefile: ['lakefile.toml', 'lakefile.lean'].find((name) => fs.existsSync(path.join(root, name))) ?? null,
    lake: which('lake'),
    lakeVersion: null,
  };
  if (!evidence.toolchain) {
    return item('lean', 'missing', 'lean-toolchain is missing or empty',
      'Add a lean-toolchain file to the project root pinning the Lean version your Aeneas backend uses.', evidence);
  }
  if (!evidence.lakefile) {
    return item('lean', 'missing', 'no lakefile.toml or lakefile.lean in the project root',
      'Create the Lean project (a lakefile.toml that requires the Aeneas Lean backend) in the project root.', evidence);
  }
  if (!evidence.lake) {
    return item('lean', 'missing', 'lake is not on PATH',
      'Install elan (https://github.com/leanprover/elan); it provides lake and the pinned Lean toolchain.', evidence);
  }
  const run = versionCheck(evidence.lake, ['--version'], root, root);
  if (run.skipped) {
    return item('lean', 'available-but-unverified', `lake is on PATH; its version was ${run.skipped}`,
      'Run lake --version in the project root yourself to confirm the pinned toolchain.', evidence);
  }
  if (!run.ok) {
    return item('lean', 'available-but-unverified', `lake is on PATH but lake --version failed in the project: ${firstLine(run.output)}`,
      `Run lake --version in the project root; elan may first need to install ${evidence.toolchain}.`, evidence);
  }
  evidence.lakeVersion = firstLine(run.stdout);
  return item('lean', 'available-but-unverified',
    `${evidence.lakeVersion}, lean-toolchain ${evidence.toolchain}; no Lean-only operation is tested (tuple evidence is in the aeneas and probe items)`,
    'None required now.', evidence);
}

function sortedDirectories(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

// The Aeneas requirement as written in the lakefile. Nothing is guessed: an
// unparsed lakefile.lean is reported as such.
function lakefileAeneas(root) {
  const toml = readText(path.join(root, 'lakefile.toml'));
  if (toml !== null) {
    const block = toml.split(/^(?=\s*\[)/m)
      .find((part) => /^\s*\[\[require\]\]/.test(part) && /^\s*name\s*=\s*"aeneas"/m.test(part));
    return { file: 'lakefile.toml', required: Boolean(block), rev: block?.match(/^\s*rev\s*=\s*"([^"]*)"/m)?.[1] ?? null };
  }
  const lean = readText(path.join(root, 'lakefile.lean'));
  if (lean === null) return { file: null, required: false, rev: null };
  const code = lean.split(/\r?\n/).filter((line) => !/^\s*--/.test(line)).join('\n');
  const rev = code.match(/require\s+«?aeneas»?\s+from\s+git\s+"[^"]*"\s*@\s*"([^"]+)"/)?.[1] ?? null;
  return { file: 'lakefile.lean', required: rev !== null || /require\s+«?aeneas»?\b/.test(code), rev };
}

function manifestInputRev(root) {
  try {
    const packages = JSON.parse(fs.readFileSync(path.join(root, 'lake-manifest.json'), 'utf8')).packages;
    const aeneas = Array.isArray(packages) ? packages.filter((entry) => entry?.name === 'aeneas') : [];
    return aeneas.length === 1 && typeof aeneas[0].inputRev === 'string' ? aeneas[0].inputRev : null;
  } catch {
    return null;
  }
}

// The CPU and OS a release directory or target name stands for, from common
// spellings (darwin-arm64, macos-aarch64, aarch64-apple-darwin, linux-x64,
// x86_64-unknown-linux-gnu). Null when the name says neither clearly.
function cpuAndOs(name) {
  const tokens = name.toLowerCase().split(/[-_.]/);
  const has = (...words) => words.some((word) => tokens.includes(word));
  const cpu = has('arm64', 'aarch64') ? 'aarch64' : has('x64', 'x86', 'amd64') ? 'x86_64' : null;
  const system = has('darwin', 'macos', 'apple') ? 'darwin' : has('linux') ? 'linux'
    : has('windows', 'win32', 'msvc') ? 'windows' : null;
  return cpu && system ? `${cpu}-${system}` : null;
}

// Installed releases under .aeneas/releases/<tag>/<platform>/. Only a
// release whose directory name clearly matches the host counts as usable.
function aeneasReleases(root, platform) {
  const host = cpuAndOs(platform);
  const base = path.join(root, '.aeneas', 'releases');
  return sortedDirectories(base).flatMap((tag) => sortedDirectories(path.join(base, tag)).map((name) => {
    const directory = path.join(base, tag, name);
    return {
      tag,
      platform: name,
      forHost: host !== null && cpuAndOs(name) === host,
      aeneas: executableFile(path.join(directory, 'aeneas')),
      charon: executableFile(path.join(directory, 'charon')),
    };
  }));
}

function aeneasItem(root, platform, provenance) {
  const lakefile = lakefileAeneas(root);
  const inputRev = manifestInputRev(root);
  const pins = [...new Set([lakefile.rev, inputRev, provenance.aeneasRev].filter(Boolean))];
  const releases = aeneasReleases(root, platform);
  // With no pin at all, any installed release for this host counts as
  // present; which Aeneas Lake would use is then reported as uncertain.
  const pinned = releases.filter((entry) => pins.length === 0 || pins.includes(entry.tag));
  const release = pinned.find((entry) => entry.forHost && entry.aeneas && entry.charon) ?? null;
  const evidence = {
    lakefile,
    manifest: { rev: provenance.aeneasRev, inputRev },
    aeneasConfigCommit: provenance.aeneasConfigCommit,
    releases,
    aeneas: release?.aeneas ?? which('aeneas'),
    charon: { path: release?.charon ?? which('charon'), version: null, output: null },
  };
  if (pins.length === 0 && !lakefile.required) {
    return item('aeneas', 'missing', 'no Aeneas requirement in the lakefile or lake-manifest.json',
      'Require the Aeneas Lean backend in lakefile.toml ([[require]] name = "aeneas" with a pinned rev).', evidence);
  }
  const conflicts = provenance.problems.filter((problem) => problem.startsWith('conflict:'));
  if (conflicts.length > 0) {
    return item('aeneas', 'incompatible', conflicts.join('; '),
      'Regenerate the extraction so translation.json, lake-manifest.json and aeneas-config.yml agree, then rerun the profile.',
      evidence);
  }
  // An uncertain pin never hides absent binaries: presence is checked first
  // and the uncertainty is carried into the reason.
  let uncertainty = null;
  if (pins.length === 0) {
    uncertainty = `${lakefile.file} requires aeneas but no revision was read from it, and lake-manifest.json pins none`;
  } else if (lakefile.rev && inputRev && lakefile.rev !== inputRev) {
    uncertainty = `${lakefile.file} requires Aeneas ${lakefile.rev} but lake-manifest.json resolved ${inputRev}, so which Aeneas Lake uses is uncertain`;
  }
  const absent = [['aeneas', evidence.aeneas], ['charon', evidence.charon.path]]
    .filter(([, found]) => !found).map(([name]) => name);
  if (absent.length > 0) {
    const rev = lakefile.rev ?? inputRev ?? provenance.aeneasRev;
    const install = `Aeneas and Charon for ${rev ?? 'it'} built for ${platform} (an Aeneas release from https://github.com/AeneasVerif/aeneas/releases bundles both) under .aeneas/releases/${rev ?? '<rev>'}/<platform>/, or put aeneas and charon on PATH.`;
    let step = `Install ${install}`;
    if (!rev) step = `Pin the Aeneas rev in the lakefile, then install ${install}`;
    else if (uncertainty) step = `Run lake update so lake-manifest.json matches the lakefile, then install ${install}`;
    const foreign = pinned.filter((entry) => !entry.forHost).map((entry) => `${entry.tag}/${entry.platform}`);
    return item('aeneas', 'missing', [
      `${absent.join(' and ')} not found for ${platform} under .aeneas/releases/${pins.join(' or ') || '*'}/ or on PATH`,
      ...(foreign.length > 0 ? [`installed releases are for other hosts: ${foreign.join(', ')}`] : []),
      ...(uncertainty ? [uncertainty] : []),
    ].join('; '), step, evidence);
  }
  if (uncertainty) {
    return item('aeneas', 'available-but-unverified', uncertainty, pins.length === 0
      ? 'Pin the Aeneas rev in the lakefile, or run lake update so lake-manifest.json records the resolved revision, then rerun the profile.'
      : 'Run lake update so lake-manifest.json matches the lakefile, then rerun the profile.', evidence);
  }
  // Only the installed Charon counts here: it is what the next extraction
  // uses. The probe item judges the one recorded in translation.json.
  const charon = evidence.charon;
  const run = versionCheck(charon.path, ['version'], root, root);
  charon.output = run.skipped ?? firstLine(run.output);
  charon.version = run.ok ? run.stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null : null;

  const tuples = compareTuples({
    aeneas: provenance.aeneasRev ?? inputRev ?? lakefile.rev,
    charon: charon.version,
    lean: provenance.leanToolchain,
  });
  if (tuples.contradictions.length > 0) {
    return item('aeneas', 'incompatible', tuples.contradictions.join('; '),
      'Install the Charon and Lean versions this Aeneas revision was tested with, or move to another Aeneas revision.', evidence);
  }
  if (tuples.exact) {
    return item('aeneas', 'available-but-unverified',
      `matches tested tuple ${tuples.exact.id}, whose recorded evidence covers only the confined probe-aeneas inventory operation, not Aeneas extraction`,
      'None required now; extraction with this tuple has no recorded FVS run yet.', evidence);
  }
  return item('aeneas', 'available-but-unverified',
    `no tested tuple matches the installed toolchain: differs from ${tuples.differences.join('; ')}`,
    'None required to extract; results with this tuple stay unverified until a confined run is recorded for it.', evidence);
}

const AENEAS_HEADER = '-- THIS FILE WAS AUTOMATICALLY GENERATED BY AENEAS';

function startsWithAeneasHeader(file) {
  try {
    const head = Buffer.alloc(AENEAS_HEADER.length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    return head.toString('utf8') === AENEAS_HEADER;
  } catch {
    return false;
  }
}

// The first Aeneas-generated Lean file, breadth first and sorted, so an
// extraction made without translation.json is not mistaken for a fresh
// project. Hidden directories (.lake, .git, .aeneas), target and node_modules
// are skipped.
function firstGeneratedLean(root) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !['target', 'node_modules'].includes(entry.name)) pending.push(file);
      } else if (entry.name.endsWith('.lean') && startsWithAeneasHeader(file)) {
        return path.relative(root, file);
      }
    }
  }
  return null;
}

function probeItem(root, platform, resolver) {
  const evidence = { resolver, generatedLean: null };
  const { provenance } = resolver;
  if (resolver.status === 'unsupported-platform') {
    return item('probe', 'unsupported-platform', resolver.reasons.join('; '),
      resolver.manual[0] ?? 'Continue without a graph for exploratory work.', evidence);
  }
  const conflicts = provenance.problems.filter((problem) => problem.startsWith('conflict:'));
  const malformed = provenance.problems.some((problem) => problem.includes('escapes the project root'));
  if (provenance.translationJson === null) evidence.generatedLean = firstGeneratedLean(root);
  if (provenance.translationJson === null && conflicts.length === 0 && !malformed && !evidence.generatedLean) {
    return item('probe', 'not-extracted-yet',
      'no translation.json yet: the probe inventory runs on an Aeneas extraction that writes translation.json',
      'Extract the crate with the shared aeneas-extract workflow (/fvs:aeneas-extract), then rerun the profile.', evidence);
  }
  if (conflicts.length > 0) {
    return item('probe', 'incompatible', conflicts.join('; '), resolver.manual[0], evidence);
  }
  // Below a tested tuple the resolver never looks for probe-aeneas, so an
  // absent probe is checked here before anything is called present.
  const installed = fs.existsSync(managedProbePath(undefined, platform)) || Boolean(which('probe-aeneas'));
  const presence = (reason) => (installed ? reason : `probe-aeneas is not installed, and ${reason}`);
  const verdict = installed ? 'available-but-unverified' : 'missing';
  if (resolver.status === 'unknown') {
    return item('probe', verdict, presence(`provenance unknown: ${provenance.problems.join('; ')}`),
      resolver.manual[0], evidence);
  }
  if (resolver.tuple === null) {
    // The resolver stops at the tuple check and reports any untested tuple
    // as incompatible; only a contradiction of a tested tuple is one here.
    const tuples = compareTuples({
      aeneas: provenance.aeneasRev,
      charon: provenance.charonVersion,
      lean: provenance.leanToolchain,
    });
    if (tuples.contradictions.length > 0) {
      return item('probe', 'incompatible', tuples.contradictions.join('; '),
        'Pin the Charon and Lean versions this Aeneas revision was tested with (or move to another Aeneas revision), then re-extract.',
        evidence);
    }
    const qualify = `qualify this tuple: run probe-aeneas ${PROBE_RELEASE.tag} confined against this project with its own Aeneas, Charon and Lean, record the envelope, helper versions and platform, and add the tuple to TESTED_TUPLES in a reviewed PR citing that evidence.`;
    return item('probe', verdict,
      presence(`no tested tuple matches this extraction: differs from ${tuples.differences.join('; ')}`),
      installed
        ? `To verify, ${qualify}`
        : `Install probe-aeneas ${PROBE_RELEASE.tag} by hand from ${PROBE_RELEASE.baseUrl} (FVS installs it only for a tested tuple), then ${qualify}`,
      evidence);
  }
  if (resolver.status === 'verified') {
    return item('probe', GREEN,
      `exact tested tuple ${resolver.tuple} on ${platform}, with probe-aeneas and every helper at the tested version`,
      null, evidence, { operation: 'probe-aeneas inventory (confined)', tuple: resolver.tuple, platform });
  }
  // A tested tuple with a drifted or absent probe or helper.
  return item('probe', resolver.status, resolver.reasons.join('; '), resolver.manual[0], evidence);
}

export function profile({ projectRoot, platform = hostTarget() }) {
  const root = path.resolve(projectRoot);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) fatal(`project root is not a directory: ${root}`);
  const resolver = resolveProbe({ projectRoot: root, platform });
  return {
    schema: 'fvs/auto-profile',
    schemaVersion: 1,
    projectRoot: root,
    platform,
    items: [
      hostItem(platform),
      aoItem(),
      rustItem(root, resolver.provenance.rustProject),
      leanItem(root),
      aeneasItem(root, platform, resolver.provenance),
      probeItem(root, platform, resolver),
    ],
  };
}

function renderText(result) {
  const lines = [`FVS >> compatibility profile for ${result.projectRoot} on ${result.platform}`];
  for (const entry of result.items) {
    lines.push(`${entry.id}: ${entry.verdict} - ${entry.reason}`);
    if (entry.scope) lines.push(`  scope: ${entry.scope.operation}, tuple ${entry.scope.tuple}, ${entry.scope.platform} only`);
    if (entry.nextStep) lines.push(`  next: ${entry.nextStep}`);
  }
  return `${lines.join('\n')}\n`;
}

function profileCli(argv) {
  const flags = { 'project-root': '.', format: 'json' };
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift();
    const key = flag.replace(/^--/, '');
    if (!flag.startsWith('--') || !Object.prototype.hasOwnProperty.call(flags, key)) {
      fatal(`unknown argument ${JSON.stringify(flag)}`);
    }
    const value = rest.shift();
    if (!value || value.startsWith('--')) fatal(`${flag} requires a value`);
    flags[key] = value;
  }
  if (!['json', 'text'].includes(flags.format)) fatal('--format must be json or text');
  const result = profile({ projectRoot: flags['project-root'] });
  process.stdout.write(flags.format === 'text' ? renderText(result) : `${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

// Milestone 1 auto-track state: setup choices, the roadmap decision, the
// extraction record (state.json) and the externals record (externals.json).
// ponytail: no lock; the coordinator is the only writer of this state.
const STATE_DIR = path.join('.formalising', 'auto-fv');
const ROADMAP_PATH = '.formalising/auto-fv/ROADMAP.md';
const DEFAULT_LIMITS = { nodeHours: 2, workers: 3 };
const BOUNDARY_KINDS = ['opaque', 'external', 'handwritten-model', 'semantic-patch'];
const BOUNDARY_STATUSES = ['open', 'assumption-accepted', 'correspondence-proved', 'blocked'];
const NOT_A_PROOF = 'Extraction success is not a proof: it shows only that the recorded source and translation patches extract and build; no specification is stated or proved by it.';
const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fvs-extract-patches.mjs');

export class Refusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function refuse(code, message, details) {
  throw new Refusal(code, message, details);
}

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const now = () => new Date().toISOString();

// Pushes an error for a non-object or for any field outside `allowed`.
function fields(errors, value, where, allowed) {
  if (!plainObject(value)) {
    errors.push(`${where} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${where}.${key} is not a known field`);
  return true;
}

function choiceErrors(choices) {
  const errors = [];
  if (!fields(errors, choices, 'choices', ['source', 'scope', 'limits'])) return errors;
  if (fields(errors, choices.source, 'source', ['revision', 'configuration'])) {
    // The revision reaches git as an argument, so an option-like value is refused.
    if (!isText(choices.source.revision) || /^-|\s/.test(choices.source.revision)) {
      errors.push('source.revision must be a git revision (a commit, tag or branch name)');
    }
    if (!isText(choices.source.configuration)) errors.push('source.configuration must be a non-empty string');
  }
  if (!isText(choices.scope)) errors.push('scope must be a non-empty string naming the bounded initial scope');
  if (fields(errors, choices.limits, 'limits', ['nodeHours', 'workers', 'wallClockHours'])) {
    const { nodeHours, workers, wallClockHours } = choices.limits;
    if (!positive(nodeHours)) errors.push('limits.nodeHours must be a positive number of hours');
    if (!Number.isInteger(workers) || workers < 1) errors.push('limits.workers must be a positive integer');
    if (wallClockHours === undefined) errors.push('limits.wallClockHours is required: the owner names one total wall-clock cap');
    else if (!positive(wallClockHours)) errors.push('limits.wallClockHours must be a positive number of hours');
  }
  return errors;
}

function normalizeChoices(input) {
  const choices = plainObject(input) && plainObject(input.limits)
    ? { ...input, limits: { ...DEFAULT_LIMITS, ...input.limits } }
    : input;
  const errors = choiceErrors(choices);
  if (errors.length > 0) refuse('invalid-input', `invalid owner choices: ${errors.join('; ')}`, { errors });
  const { source, scope, limits } = choices;
  return {
    source: { revision: source.revision, configuration: source.configuration },
    scope,
    limits: { nodeHours: limits.nodeHours, workers: limits.workers, wallClockHours: limits.wallClockHours },
  };
}

function stateErrors(state) {
  const errors = [];
  if (!fields(errors, state, 'state', ['schema', 'schemaVersion', 'profiledAt', 'profile', 'choices', 'roadmap', 'extraction'])) return errors;
  if (state.schema !== 'fvs/auto-state' || state.schemaVersion !== 1) errors.push('schema must be fvs/auto-state version 1');
  if (!plainObject(state.profile) || state.profile.schema !== 'fvs/auto-profile' || !Array.isArray(state.profile.items)) {
    errors.push('profile must be a recorded fvs/auto-profile result');
  }
  errors.push(...choiceErrors(state.choices));
  const { roadmap, extraction } = state;
  if (roadmap !== null && (!fields(errors, roadmap, 'roadmap', ['decision', 'path', 'decidedAt'])
    || !['accepted', 'declined'].includes(roadmap.decision)
    || roadmap.path !== (roadmap.decision === 'accepted' ? ROADMAP_PATH : null) || !isText(roadmap.decidedAt))) {
    errors.push('roadmap must be null or an accepted or declined decision with its path and time');
  }
  if (extraction !== null && (!fields(errors, extraction, 'extraction', ['status', 'recordedAt', 'selected', 'reasons', 'declared', 'checks', 'inputs', 'note'])
    || !['succeeded', 'failed'].includes(extraction.status)
    || !Array.isArray(extraction.reasons) || !extraction.reasons.every(isText)
    || (extraction.status === 'succeeded') !== (extraction.reasons.length === 0)
    || !plainObject(extraction.selected) || !isText(extraction.selected.revision) || !isText(extraction.selected.configuration)
    || !plainObject(extraction.declared) || !Number.isInteger(extraction.declared.buildExitCode))) {
    errors.push('extraction must be null or a succeeded record without reasons or a failed record with them');
  }
  return errors;
}

// correspondence-proved stays in the schema but no milestone 1 record may
// claim it: nothing here can check that a receipt is checked correspondence
// evidence, and a path or hash alone proves nothing.
const NOT_PROVABLE = 'correspondence-proved is not available: checked correspondence receipt validation is not implemented in this milestone, so no record may claim it; keep the boundary open, assumption-accepted or blocked';

function externalsErrors(records) {
  if (!Array.isArray(records)) return ['records must be an array'];
  const errors = [];
  const seen = new Set();
  records.forEach((record, index) => {
    const where = `records[${index}]`;
    if (!fields(errors, record, where, ['id', 'kind', 'source', 'model', 'claimedBehaviour', 'reason',
      'affectedRoots', 'evidence', 'status', 'decision'])) return;
    if (!isText(record.id)) errors.push(`${where}.id must be a non-empty string`);
    else if (seen.has(record.id)) errors.push(`${where}.id ${record.id} is duplicated`);
    seen.add(record.id);
    if (!BOUNDARY_KINDS.includes(record.kind)) errors.push(`${where}.kind must be one of ${BOUNDARY_KINDS.join(', ')}`);
    if (!plainObject(record.source) || !isText(record.source.symbol) || !isText(record.source.commit)) {
      errors.push(`${where}.source must hold the source symbol and commit`);
    }
    if (!plainObject(record.model) || !isText(record.model.symbol) || !/^[0-9a-f]{64}$/.test(record.model.sha256 ?? '')) {
      errors.push(`${where}.model must hold the model symbol and its sha256`);
    }
    for (const key of ['claimedBehaviour', 'reason']) if (!isText(record[key])) errors.push(`${where}.${key} must be a non-empty string`);
    for (const key of ['affectedRoots', 'evidence']) {
      if (!Array.isArray(record[key]) || !record[key].every(isText)) errors.push(`${where}.${key} must be an array of strings`);
    }
    if (!BOUNDARY_STATUSES.includes(record.status)) errors.push(`${where}.status must be one of ${BOUNDARY_STATUSES.join(', ')}`);
    const decided = plainObject(record.decision) && ['by', 'at', 'evidence'].every((key) => isText(record.decision[key]))
      && Object.keys(record.decision).length === 3;
    if (!(decided || (record.decision === null && record.status === 'open'))) {
      errors.push(`${where}.decision must name who decided, when and on what evidence (null only while open)`);
    }
    if (record.status === 'correspondence-proved') errors.push(`${where}: ${NOT_PROVABLE}`);
  });
  return errors;
}

function externalsFileErrors(value) {
  if (!plainObject(value) || value.schema !== 'fvs/auto-externals' || value.schemaVersion !== 1) {
    return ['schema must be fvs/auto-externals version 1'];
  }
  return externalsErrors(value.records);
}

function projectDirectory(projectRoot) {
  const root = path.resolve(projectRoot);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) refuse('usage', `project root is not a directory: ${root}`);
  return fs.realpathSync(root);
}

const statePath = (root) => path.join(root, STATE_DIR, 'state.json');
const externalsPath = (root) => path.join(root, STATE_DIR, 'externals.json');

// Null when the file is absent; a refusal naming the file and the next step
// when it is unreadable or does not validate. It is never repaired here.
function loadRecord(file, code, validate, rerun) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    text = null;
  }
  const nextStep = `Fix ${file} by hand or move it aside, then rerun ${rerun}; FVS never overwrites or repairs it.`;
  if (text === null) refuse(code, `${file} cannot be read`, { file, nextStep });
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    refuse(code, `${file} is not valid JSON: ${error.message}`, { file, nextStep });
  }
  const errors = validate(value);
  if (errors.length > 0) refuse(code, `${file} is malformed: ${errors.join('; ')}`, { file, errors, nextStep });
  return value;
}

const loadState = (root) => loadRecord(statePath(root), 'malformed-state', stateErrors, '/fvs:auto-init');
const loadExternals = (root) => loadRecord(externalsPath(root), 'malformed-externals', externalsFileErrors, '/fvs:auto-extract');

function requireState(root) {
  const state = loadState(root);
  if (!state) refuse('no-state', `no auto-track state in ${statePath(root)}`, { nextStep: 'Run /fvs:auto-init first.' });
  return state;
}

// Written to a sibling temporary file, flushed, then renamed over the target,
// so a crash leaves either the old file or the new one, never a torn one.
function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx');
  try {
    fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function flatten(value, prefix = '') {
  if (!plainObject(value)) return { [prefix]: value };
  return Object.assign({}, ...Object.entries(value).map(([key, inner]) => flatten(inner, prefix ? `${prefix}.${key}` : key)));
}

function choiceChanges(recorded, requested) {
  const [before, after] = [flatten(recorded), flatten(requested)];
  return Object.keys(after).filter((field) => before[field] !== after[field])
    .map((field) => ({ field, recorded: before[field], requested: after[field] }));
}

// Verdicts that stop auto-init. A missing probe is expected until extraction,
// and probe-aeneas is first needed by milestone 2.
const blocks = (entry) => ['incompatible', 'unsupported-platform'].includes(entry.verdict)
  || (entry.verdict === 'missing' && entry.id !== 'probe');

export function initState({ projectRoot, choices, confirmOverwrite = false, platform = hostTarget() }) {
  const root = projectDirectory(projectRoot);
  const requested = normalizeChoices(choices);
  const recorded = loadState(root);
  if (recorded) {
    const changes = choiceChanges(recorded.choices, requested);
    if (changes.length === 0) {
      return { code: 'unchanged', message: 'the recorded setup state already holds these choices; nothing was written', state: recorded };
    }
    if (!confirmOverwrite) {
      refuse('confirmation-required', `the requested choices change recorded owner choices: ${changes.map((change) => change.field).join(', ')}`,
        { changes, nextStep: 'Show each change to the owner and rerun with --confirm-overwrite only after they confirm it.' });
    }
  }
  const result = profile({ projectRoot: root, platform });
  const blocking = result.items.filter(blocks).map(({ id, verdict, reason, nextStep }) => ({ id, verdict, reason, nextStep }));
  if (blocking.length > 0) {
    refuse('profile-blocked', `the compatibility profile stops auto-init: ${blocking.map((entry) => `${entry.id} is ${entry.verdict}`).join(', ')}`,
      { blocking, nextStep: blocking.map((entry) => entry.nextStep).join(' ') });
  }
  const state = {
    schema: 'fvs/auto-state',
    schemaVersion: 1,
    profiledAt: now(),
    profile: result,
    choices: requested,
    roadmap: recorded?.roadmap ?? null,
    extraction: recorded?.extraction ?? null,
  };
  writeAtomic(statePath(root), state);
  return { code: recorded ? 'updated' : 'created', message: `setup state written to ${statePath(root)}`, state };
}

function nextAction(state) {
  const { selected } = state.extraction ?? {};
  if (selected && choiceChanges(selected, state.choices.source).length > 0) {
    return `Rerun /fvs:auto-extract: the recorded extraction is for revision ${selected.revision} (${selected.configuration}), not the selected source.`;
  }
  if (state.extraction?.status === 'succeeded') {
    return 'Run /fvs:auto-top-specs; milestone 2 functionality not yet available, so the auto track stops after extraction for now.';
  }
  if (state.extraction) return 'Rerun /fvs:auto-extract after fixing the recorded failure reasons.';
  return 'Run /fvs:auto-extract to extract the selected revision.';
}

export function readState({ projectRoot }) {
  const root = projectDirectory(projectRoot);
  const state = loadState(root);
  if (!state) {
    return { code: 'no-state', message: `no auto-track state in ${statePath(root)}`, nextAction: 'Run /fvs:auto-init to record the setup state.', pendingDecisions: [] };
  }
  const records = loadExternals(root)?.records ?? [];
  const externals = Object.fromEntries([['total', records.length],
    ...BOUNDARY_STATUSES.map((status) => [status, records.filter((record) => record.status === status).length])]);
  return {
    code: 'ok',
    message: `auto-track state in ${statePath(root)}`,
    state,
    roadmapPresent: state.roadmap?.path ? fs.existsSync(path.join(root, state.roadmap.path)) : false,
    externals,
    pendingDecisions: state.roadmap ? [] : ['roadmap'],
    nextAction: nextAction(state),
  };
}

export function recordRoadmap({ projectRoot, decision, confirmOverwrite = false }) {
  if (!['accepted', 'declined'].includes(decision)) refuse('usage', '--decision must be accepted or declined');
  const root = projectDirectory(projectRoot);
  const state = requireState(root);
  if (state.roadmap?.decision === decision) return { code: 'unchanged', message: `the roadmap offer is already recorded as ${decision}`, state };
  if (state.roadmap && !confirmOverwrite) {
    refuse('confirmation-required', `the roadmap offer is recorded as ${state.roadmap.decision}`, {
      changes: [{ field: 'roadmap.decision', recorded: state.roadmap.decision, requested: decision }],
      nextStep: 'Change it only when the owner asks, with --confirm-overwrite.',
    });
  }
  state.roadmap = { decision, path: decision === 'accepted' ? ROADMAP_PATH : null, decidedAt: now() };
  writeAtomic(statePath(root), state);
  return { code: 'recorded', message: `roadmap offer recorded as ${decision}`, state };
}

function engineCheck(command, out) {
  const run = spawnSync(process.execPath, [ENGINE, command, '--out', out], { encoding: 'utf8' });
  try {
    const { ok, code, message } = JSON.parse(run.stdout);
    return { ok: ok === true, code, message };
  } catch {
    return { ok: false, code: 'internal', message: firstLine(run.stderr) || `the engine exited ${run.status}` };
  }
}

function resolveRevision(directory, revision) {
  const run = spawnSync('git', ['--no-optional-locks', '-C', directory, 'rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

// The status is derived here, never taken from the caller: success needs a
// zero build exit (the one declared input) and the patch engine's own status,
// verify-tree and verify-restore checks on the copy Charon consumed, taken
// from this project at the recorded revision without uncommitted changes.
export function recordExtraction({ projectRoot, out, buildExitCode }) {
  if (!Number.isInteger(buildExitCode)) refuse('usage', '--build-exit-code must be an integer');
  const root = projectDirectory(projectRoot);
  const state = requireState(root);
  const copy = path.resolve(out);
  const checks = {
    status: engineCheck('status', copy),
    'verify-tree': engineCheck('verify-tree', copy),
    'verify-restore': engineCheck('verify-restore', copy),
  };
  const reasons = [];
  if (buildExitCode !== 0) reasons.push(`the build exited ${buildExitCode}`);
  for (const [name, check] of Object.entries(checks)) {
    if (!check.ok) reasons.push(`the patch engine ${name} check refused (${check.code}): ${check.message}`);
  }
  let inputs = null;
  if (checks.status.ok) {
    const bytes = fs.readFileSync(path.join(copy, 'manifest.json'));
    const manifest = JSON.parse(bytes);
    const { revision } = state.choices.source;
    const crate = manifest.projectRoot;
    if (manifest.mode !== 'translation-patches') reasons.push(`the copy was prepared in ${manifest.mode} mode; the auto track extracts through translation patches only`);
    if (crate !== root && !crate.startsWith(`${root}${path.sep}`)) reasons.push(`the copy was prepared from ${crate}, outside this project`);
    const resolved = resolveRevision(crate, revision);
    if (!manifest.source.commit) reasons.push(`${crate} is not a git checkout, so the extraction cannot be tied to revision ${revision}`);
    else if (manifest.source.commit !== resolved) {
      reasons.push(`the copy was prepared from commit ${manifest.source.commit}, but the recorded revision ${revision} is ${resolved ?? 'not resolvable there'}`);
    }
    if (manifest.source.dirty?.length > 0) reasons.push(`the extraction inputs had uncommitted changes: ${manifest.source.dirty.join(', ')}`);
    inputs = {
      out: copy,
      manifestSha256: sha256(bytes),
      crateRoot: crate,
      mode: manifest.mode,
      sourceCommit: manifest.source.commit,
      patches: manifest.patches.map(({ file, sha256: hash }) => ({ file, sha256: hash })),
    };
  }
  const extraction = {
    status: reasons.length === 0 ? 'succeeded' : 'failed',
    recordedAt: now(),
    // The source selection this record answers; a later confirmed change makes it history.
    selected: { ...state.choices.source },
    reasons,
    declared: { buildExitCode },
    checks,
    inputs,
    note: NOT_A_PROOF,
  };
  state.extraction = extraction;
  writeAtomic(statePath(root), state);
  if (reasons.length > 0) {
    refuse('extraction-failed', `extraction recorded as failed: ${reasons.join('; ')}`,
      { extraction, nextStep: 'Fix the reasons above and rerun /fvs:auto-extract; a failed extraction is never recorded as success.' });
  }
  return { code: 'recorded', message: `extraction recorded as succeeded. ${NOT_A_PROOF}`, extraction };
}

export function recordExternals({ projectRoot, records }) {
  const root = projectDirectory(projectRoot);
  requireState(root);
  const errors = externalsErrors(records);
  if (errors.length > 0) refuse('invalid-input', `invalid externals record: ${errors.join('; ')}`, { errors });
  const kept = new Set(records.map((record) => record.id));
  const lost = (loadExternals(root)?.records ?? []).map((record) => record.id).filter((id) => !kept.has(id));
  if (lost.length > 0) {
    refuse('record-loss', `the new externals record drops ${lost.join(', ')}; a boundary is never deleted, only moved to another status`,
      { lost, nextStep: 'Resubmit every recorded boundary, changing only what the owner decided.' });
  }
  writeAtomic(externalsPath(root), { schema: 'fvs/auto-externals', schemaVersion: 1, records });
  return { code: 'recorded', message: `${records.length} boundary record(s) written to ${externalsPath(root)}` };
}

function readInput(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    refuse('invalid-input', `cannot read JSON from ${file}: ${error.message}`);
  }
}

function stateFlags(argv, values, switches = []) {
  const flags = { 'project-root': '.' };
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift();
    const key = flag.replace(/^--/, '');
    if (key !== flag && switches.includes(key)) {
      flags[key] = true;
      continue;
    }
    if (key === flag || ![...values, 'project-root'].includes(key)) refuse('usage', `unknown argument ${JSON.stringify(flag)}`);
    const value = rest.shift();
    if (!value || value.startsWith('--')) refuse('usage', `${flag} requires a value`);
    flags[key] = value;
  }
  for (const key of values) if (flags[key] === undefined) refuse('usage', `--${key} is required`);
  return flags;
}

const STATE_COMMANDS = {
  'init-state': (argv) => {
    const flags = stateFlags(argv, ['input'], ['confirm-overwrite']);
    return initState({ projectRoot: flags['project-root'], choices: readInput(flags.input), confirmOverwrite: flags['confirm-overwrite'] === true });
  },
  'read-state': (argv) => readState({ projectRoot: stateFlags(argv, [])['project-root'] }),
  'record-roadmap': (argv) => {
    const flags = stateFlags(argv, ['decision'], ['confirm-overwrite']);
    return recordRoadmap({ projectRoot: flags['project-root'], decision: flags.decision, confirmOverwrite: flags['confirm-overwrite'] === true });
  },
  'record-extraction': (argv) => {
    const flags = stateFlags(argv, ['out', 'build-exit-code']);
    if (!/^-?\d+$/.test(flags['build-exit-code'])) refuse('usage', '--build-exit-code must be an integer');
    return recordExtraction({ projectRoot: flags['project-root'], out: flags.out, buildExitCode: Number(flags['build-exit-code']) });
  },
  'record-externals': (argv) => {
    const flags = stateFlags(argv, ['input']);
    return recordExternals({ projectRoot: flags['project-root'], records: readInput(flags.input) });
  },
};

function stateMain(command, argv) {
  let result;
  try {
    result = { ok: true, command, ...STATE_COMMANDS[command](argv) };
  } catch (error) {
    result = error instanceof Refusal
      ? { ok: false, code: error.code, command, message: error.message, ...error.details }
      : { ok: false, code: 'internal', command, message: error.message };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.stderr.write(`FVS >> ${result.code}: ${result.message}\n`);
  const malformed = ['malformed-state', 'malformed-externals'].includes(result.code);
  process.exitCode = result.ok ? 0 : malformed ? 3 : ['usage', 'internal'].includes(result.code) ? 2 : 1;
}

const SUBCOMMANDS = { profile: profileCli };

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  if (Object.prototype.hasOwnProperty.call(STATE_COMMANDS, argv[0])) {
    stateMain(argv[0], argv.slice(1));
    return;
  }
  try {
    if (!Object.prototype.hasOwnProperty.call(SUBCOMMANDS, argv[0])) {
      const available = [...Object.keys(SUBCOMMANDS), ...Object.keys(STATE_COMMANDS)].join(', ');
      fatal(`unknown subcommand ${JSON.stringify(argv[0])}; available: ${available}`);
    }
    process.exitCode = SUBCOMMANDS[argv[0]](argv.slice(1));
  } catch (error) {
    process.stderr.write(`FVS_AUTO_ERROR: ${error.message}\n`);
    process.exitCode = 2;
  }
}

function invokedDirectly() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main(process.argv.slice(2));
