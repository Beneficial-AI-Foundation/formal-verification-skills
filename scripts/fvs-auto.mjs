#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  PROBE_RELEASE,
  SANDBOX_EXEC,
  TESTED_TUPLES,
  executableFile,
  hostTarget,
  managedProbePath,
  readOnlyRun,
  resolveProbe,
  which,
} from './fvs-probe-inventory.mjs';

const GREEN = 'supported-and-tested';
const NOT_CHECKED = 'not checked: this host has no read-only sandbox';
// Linux x64 has upstream binaries but no FVS validation for extraction or
// acceptance; any other host without recorded evidence is unsupported.
const NOT_VALIDATED = { 'x86_64-unknown-linux-gnu': 'Linux x64' };

function fatal(message) {
  throw new Error(message);
}

function usage() {
  process.stdout.write([
    'Usage: node fvs-auto.mjs profile [--project-root DIR] [--format json|text]',
    '',
    'profile reports what this host and project can do for the FVS auto track,',
    'one verdict per item: supported-and-tested, available-but-unverified,',
    'incompatible, missing, unsupported-platform or not-extracted-yet.',
    'It only detects: it never installs, downloads or modifies anything.',
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

// Version checks run only under the read-only sandbox: unconfined, a rustup
// or elan proxy could download the toolchain a project pins. Returns null
// when the check cannot be confined.
function confinedRun(bin, args, cwd) {
  return fs.existsSync(SANDBOX_EXEC) ? readOnlyRun(bin, args, cwd) : null;
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
    if (NOT_VALIDATED[platform]) {
      return item('host', 'available-but-unverified',
        `${NOT_VALIDATED[platform]} is not validated for FVS extraction or acceptance, and verified probe operations are unsupported here: ${probeReason}`,
        `Expect exploratory work without a graph here; use a host with recorded evidence (${hosts}) for verified probe operations.`,
        evidence);
    }
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
  const run = confinedRun(evidence.rustc, ['-vV'], rustProject);
  if (!run) {
    return item('rust', 'available-but-unverified', `cargo and rustc are on PATH${pinned}; the version was ${NOT_CHECKED}`,
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
  const run = confinedRun(evidence.lake, ['--version'], root);
  if (!run) {
    return item('lean', 'available-but-unverified', `lake is on PATH; its version was ${NOT_CHECKED}`,
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

// Installed releases under .aeneas/releases/<tag>/<platform>/.
// ponytail: platform directory names are not matched against the host; add
// that when a project carries releases for several platforms.
function aeneasReleases(root) {
  const base = path.join(root, '.aeneas', 'releases');
  return sortedDirectories(base).flatMap((tag) => sortedDirectories(path.join(base, tag)).map((platform) => {
    const directory = path.join(base, tag, platform);
    return {
      tag,
      platform,
      aeneas: executableFile(path.join(directory, 'aeneas')),
      charon: executableFile(path.join(directory, 'charon')),
    };
  }));
}

function aeneasItem(root, provenance) {
  const lakefile = lakefileAeneas(root);
  const inputRev = manifestInputRev(root);
  const pins = [...new Set([lakefile.rev, inputRev, provenance.aeneasRev].filter(Boolean))];
  const releases = aeneasReleases(root);
  // With no pin at all, any installed release counts as present; which
  // Aeneas Lake would use is then reported as uncertain.
  const release = releases.find((entry) =>
    (pins.length === 0 || pins.includes(entry.tag)) && entry.aeneas && entry.charon) ?? null;
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
    const install = `Aeneas and Charon for ${rev ?? 'it'} (an Aeneas release from https://github.com/AeneasVerif/aeneas/releases bundles both) under .aeneas/releases/${rev ?? '<rev>'}/<platform>/, or put aeneas and charon on PATH.`;
    let step = `Install ${install}`;
    if (!rev) step = `Pin the Aeneas rev in the lakefile, then install ${install}`;
    else if (uncertainty) step = `Run lake update so lake-manifest.json matches the lakefile, then install ${install}`;
    return item('aeneas', 'missing',
      `${absent.join(' and ')} not found under .aeneas/releases/${pins.join(' or ') || '*'}/ or on PATH${uncertainty ? `; ${uncertainty}` : ''}`,
      step, evidence);
  }
  if (uncertainty) {
    return item('aeneas', 'available-but-unverified', uncertainty, pins.length === 0
      ? 'Pin the Aeneas rev in the lakefile, or run lake update so lake-manifest.json records the resolved revision, then rerun the profile.'
      : 'Run lake update so lake-manifest.json matches the lakefile, then rerun the profile.', evidence);
  }
  // Only the installed Charon counts here: it is what the next extraction
  // uses. The probe item judges the one recorded in translation.json.
  const charon = evidence.charon;
  const run = confinedRun(charon.path, ['version'], root);
  charon.output = run ? firstLine(run.output) : NOT_CHECKED;
  charon.version = run?.ok ? run.stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null : null;

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
      aeneasItem(root, resolver.provenance),
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

const SUBCOMMANDS = { profile: profileCli };

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  try {
    if (!Object.prototype.hasOwnProperty.call(SUBCOMMANDS, argv[0])) {
      fatal(`unknown subcommand ${JSON.stringify(argv[0])}; available: ${Object.keys(SUBCOMMANDS).join(', ')}`);
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
