#!/usr/bin/env node
'use strict';

import { spawnSync } from 'node:child_process';
import { parseBudget, executionToolIdentity, ExecutionError, runExecutionFields, withProcessCancellation, runControl, runTaskCommand, observeOwnedWork, closeOwnedWork } from './fvs-execution.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  CONFINEMENT_UNAVAILABLE,
  PROBE_RELEASE,
  TESTED_TUPLES,
  acceptedProbeLeanVersions,
  executableFile,
  hostTarget,
  managedProbePath,
  readOnlyRun,
  resolveProbe,
  which,
} from './fvs-probe-inventory.mjs';
import { selectProbeToolPaths } from './fvs-probe-linux.mjs';

import {
  MemoryError, memoryHash, memoryOwnData, memoryDataSnapshot, memoryBindingsErrors, bindingIdentity, inspectMemoryRegistration, memoryJson,
  prepareMemoryBootstrapRequest, runMemoryBootstrap, consumeMemoryBootstrap,
} from './fvs-project-memory.mjs';
import { ResumeError, runResume, consumeResume, consumeTransition, observeAssignedActor, verifyReleasedPacketContext, readRuntime, parseResumeRequest } from './fvs-auto-resume.mjs';
import { readChain } from './fvs-contract-registry.mjs';
import { inspectAutoAcceptance } from './fvs-checker-auto.mjs';
import { installedFvs, TransitionError, transitionValidators, transitionBytes, transitionJson, transitionSave, nextTransitionFacts, performTransition, verifyStartup, acknowledgeStart, readWorkPacket, readTransitionAction, transitionBound, readRuntimeObservation, recordTaskProgress, readTaskProgress, assessTaskProgress, workerMemoryEvidence, verifyTransitionAuthorization } from './fvs-auto-transitions.mjs';

const GREEN = 'supported-and-tested';

function fatal(message) {
  throw new Error(message);
}

function usage() {
  process.stdout.write([
    'Usage: node fvs-auto.mjs profile [--project-root DIR] [--format json|text]',
    '       node fvs-auto.mjs init-state --input CHOICES.json [--project-root DIR] [--confirm-overwrite]',
    '       node fvs-auto.mjs read-state [--project-root DIR] [--require-agreement | --brief]',
    '       node fvs-auto.mjs record-agreement --input AGREEMENT.json [--project-root DIR] [--confirm-overwrite]',
    '       node fvs-auto.mjs record-memory --input REGISTRATION.json [--project-root PRIMARY] [--confirm-overwrite]',
    '       node fvs-auto.mjs prime-memory --request REQUEST.json --out EXCLUSIVE_DIR [--project-root PRIMARY]',
    '       node fvs-auto.mjs refresh-memory --request REQUEST.json --out EXCLUSIVE_DIR [--project-root PRIMARY]',
    '       node fvs-auto.mjs checkpoint|state --request REQUEST.json --out EXCLUSIVE_DIR [--project-root PRIMARY]',
    '       node fvs-auto.mjs next-transition|execute-transition|verify-transition|verify-startup|ack-work|run-owned|record-progress|read-progress|observe-progress --input OPTIONS.json [--project-root PRIMARY]',
    '       node fvs-auto.mjs record-roadmap --decision accepted|declined [--project-root DIR] [--confirm-overwrite]',
    '       node fvs-auto.mjs record-extraction --out OUT --build-exit-code N --oracle complete|refused|unknown [--oracle-reason TEXT] [--project-root DIR]',
    '       node fvs-auto.mjs record-externals --input RECORDS.json [--project-root DIR]',
    '       node fvs-auto.mjs record-spec --spec-file PATH --items ID[,ID...] --round N --verdict pass|changes|blocked --review FILE [--out-of-scope ID[,ID...]] [--commit SHA] [--project-root DIR]',
    '       node fvs-auto.mjs spec-status [--commit SHA] [--project-root DIR]',
    '       node fvs-auto.mjs record-override --key KEY --value TEXT --reason TEXT [--project-root DIR]',
    '       node fvs-auto.mjs list-items [--translation PATH | --crate NAME] [--scope FILE|DIR|RUST_PATH[,...]] [--project-root DIR]',
    '       node fvs-auto.mjs allowed-axioms [--commit SHA] [--project-root DIR]',
    '       node fvs-auto.mjs record-pr --kind spec|proof --url URL --branch B --head SHA [--project-root DIR]',
    '       node fvs-auto.mjs record-pr --kind spec|proof --merged --merge-commit SHA [--project-root DIR]',
    '       node fvs-auto.mjs freeze|check|accept --request FILE --out EXCLUSIVE_DIR',
    '',
    'profile reports what this host and project can do for the FVS auto track,',
    'one verdict per item: supported-and-tested, available-but-unverified,',
    'incompatible, missing, unsupported-platform or not-extracted-yet.',
    'It only detects: it never installs, downloads or modifies anything.',
    '',
    'The state subcommands keep the milestone 1 auto-track state under',
    '.formalising/auto-fv/ in the project root: state.json (profile, owner choices,',
    'roadmap offer, extraction, optional M2 agreement), externals.json (one record per',
    'boundary), overrides.json (run decisions made after the agreement; append-only) and',
    'specs.json (one row per spec review round; PATH and FILE are',
    'files inside the project root, relative to it). Every write is atomic; malformed files are reported, never',
    'overwritten. They print one JSON result. Exit codes: 0 ok; 1 refused',
    '(confirmation required, blocked profile, failed extraction, record loss,',
    'invalid input, no state); 2 usage or internal error; 3 malformed state.',
    'freeze/check/accept use the shared independent checker and its bound request schemas.',
    'Provisional registry readiness and standalone audits do not authorize auto acceptance.',
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

// Probes and the host they were tested on add evidence; none of them stops setup
// or extraction. Each missing probe costs what PROBE_LOSSES says, and what each
// stage can still do is in `readiness`.
const OPTIONAL = 'Not needed for setup or extraction:';
export const PROBE_LOSSES = {
  'probe-aeneas': 'Rust-to-Lean mappings confirmed independently of Aeneas: without it every mapping is declared by Aeneas in translation.json, never exact, and generated Lean functions are not checked against functions.json.',
  'probe-rust': 'the Rust atom inventory: without it Rust names and spans come from translation.json alone, and Rust functions Aeneas did not translate are not detected.',
  scip: 'the code index probe-rust reads: without it probe-rust cannot run.',
  'rust-analyzer': 'the indexer probe-rust uses: without it probe-rust cannot run.',
  'probe-lean': 'the Lean atom list for the graph: without it no Lean graph is built, so the closure plan has source order only, no dependency order, and strict acceptance refuses it; a Lean project commit other than the Rust commit is not reconciled with the published generated Lean files.',
};

// Presence and qualification of each probe. Qualified probes were checked by the
// resolver for this toolchain tuple. Any other present probe is run once with
// --version under the read-only confinement: one that does not answer, or a
// probe-lean whose version the Lean graph step refuses, is unverified-blocked
// with the reason, because no stage can use its output.
function probeStatuses(root, probe, resolver, platform) {
  let selected = null;
  let unchecked = null;
  try {
    selected = selectProbeToolPaths({ projectRoot: root });
  } catch (error) {
    // An unreadable lean-toolchain or a refused path override leaves the helpers not checked.
    unchecked = error.message;
  }
  const aeneasPath = [managedProbePath(undefined, platform), which('probe-aeneas')].find((file) => file && fs.existsSync(file)) ?? null;
  return Object.keys(PROBE_LOSSES).map((id) => {
    const found = id === 'probe-aeneas' ? aeneasPath : selected?.helpers[id] ?? null;
    let status = found ? 'present-unqualified' : 'missing';
    let reason = null;
    if (id !== 'probe-aeneas' && selected === null) [status, reason] = ['not-checked', unchecked];
    if (probe.verdict === GREEN && resolver.status === 'verified') [status, reason] = ['qualified', null];
    if (status === 'present-unqualified') [status, reason] = probeUsable(id, found, root, selected);
    return { id, status, path: found, lost: status === 'qualified' || status === 'present-unqualified' ? null : PROBE_LOSSES[id],
      ...(reason === null ? {} : { reason }) };
  });
}

function probeUsable(id, bin, root, selected) {
  const run = readOnlyRun(bin, ['--version'], root, { projectRoot: root, toolPaths: selected });
  const unavailable = run.confinementError ?? (run.output === CONFINEMENT_UNAVAILABLE ? run.output : null);
  if (unavailable) return ['not-checked', `${id} --version was not run: ${unavailable}`];
  // rustup installs a rust-analyzer proxy that fails until the component is
  // added, so a failing one is missing, as the resolver also counts it.
  if (!run.ok) return [id === 'rust-analyzer' ? 'missing' : 'unverified-blocked', `${id} --version failed: ${firstLine(run.output) || 'no output'}`];
  if (id !== 'probe-lean') return ['present-unqualified', null];
  const version = firstLine(run.stdout).split(/\s+/).pop();
  // Which constants record a run produces is known only after it runs, so every
  // version the graph step can take is a route; the graph step checks the pairing.
  const plain = acceptedProbeLeanVersions();
  const withConstants = acceptedProbeLeanVersions({ constantsVersion2: true }).filter((v) => !plain.includes(v));
  if ([...plain, ...withConstants].includes(version)) return ['present-unqualified', null];
  return ['unverified-blocked', `the Lean graph step accepts only probe-lean ${plain.join(' or ')} output${withConstants.length ? `, or ${withConstants.join(' or ')} output with a version 2 constants record,` : ''} and refuses other versions; this probe-lean reports ${JSON.stringify(version)}`];
}

// What each stage needs on this engine. The AO controller launches spec, review
// and proof work only on a closure plan the registry accepts: a verified Lean
// graph from probe-lean, and an identity confirmed by probe-aeneas and probe-rust
// (which needs scip and rust-analyzer). Without AO or Lean a stage has no route;
// without a probe it runs reduced, labelled with what that probe's output would
// have added. Probes that are present but not qualified for this tuple give a
// route whose output is labelled unverified.
const STAGE_NEEDS = ['ao', 'lean', ...Object.keys(PROBE_LOSSES)];
const STAGES = { 'auto-top-specs': STAGE_NEEDS, 'auto-execute': STAGE_NEEDS };

// The recorded profile changes only when init-state runs again (same choices
// refresh only the profile), so every step ends by naming that.
const REFRESH = 'then rerun /fvs:auto-init with the recorded choices so the recorded profile is refreshed';

function stageGap(need, items, probes) {
  if (!(need in PROBE_LOSSES)) {
    const entry = items[need];
    if (entry && entry.verdict !== 'missing') return null;
    const advice = entry?.nextStep ? entry.nextStep[0].toLowerCase() + entry.nextStep.slice(1).replace(/,? then rerun the profile\.?$|\.$/, '') : `install ${need}`;
    return { need, supplier: 'owner', step: `${advice}, ${REFRESH}` };
  }
  const probe = probes[need];
  if (!probe) return { need, supplier: 'agent', step: 'rerun /fvs:auto-init with the recorded choices so the recorded profile is refreshed: it did not check the probes' };
  if (probe.status === 'missing') return { need, supplier: 'owner', step: `install ${need} (or set its path override), ${REFRESH}` };
  if (probe.status === 'not-checked') return { need, supplier: 'owner', step: `fix what stopped the probe check (${probe.reason ?? 'reason not recorded'}), ${REFRESH}` };
  if (probe.status === 'unverified-blocked') return { need, supplier: 'owner', step: `replace ${need} with one this engine can use (${probe.reason}), ${REFRESH}` };
  if (!['qualified', 'present-unqualified'].includes(probe.status)) return { need, supplier: 'agent', step: `rerun /fvs:auto-init with the recorded choices so the recorded profile is refreshed: its ${need} status ${JSON.stringify(probe.status)} is not one this engine knows` };
  return null;
}

// One line per stage, computed from a profile (fresh or recorded) so the setup
// report, the next action and the read state never disagree: full (every probe
// qualified), ready-unverified (every probe present and usable, some not
// qualified), ready-reduced (only recorded probes are missing, not checked or
// unusable, or absent from a profile recorded before probes were checked: the
// stage runs without their output, labelled reduced), or no-route (AO or Lean
// missing), naming the first missing need and who supplies it.
const REDUCED_PROBE = ['missing', 'not-checked', 'unverified-blocked'];
export function readiness(profileResult) {
  const items = Object.fromEntries((profileResult?.items ?? []).map((entry) => [entry.id, entry]));
  const probes = Object.fromEntries((profileResult?.probes ?? []).map((entry) => [entry.id, entry]));
  return Object.entries(STAGES).map(([stage, needs]) => {
    const gaps = needs.map((need) => stageGap(need, items, probes)).filter(Boolean);
    if (gaps.length > 0 && gaps.every((gap) => gap.need in PROBE_LOSSES && REDUCED_PROBE.includes(probes[gap.need]?.status ?? 'not-checked'))) {
      const lost = gaps.map((gap) => gap.need);
      const named = lost.map((need) => {
        const { status, reason } = probes[need] ?? { status: 'not-checked' };
        if (status === 'missing') return need;
        return `${need} (${status === 'not-checked' ? 'not checked' : 'present but unusable'}${reason ? `: ${reason}` : ''})`;
      });
      const unverified = needs.filter((need) => probes[need]?.status === 'present-unqualified');
      // Any lost probe output can leave the identity or the plan unaccepted, so strict acceptance is never
      // promised here. The clean-copy build check reads no probe output.
      const acceptance = ` Reduced output never promises strict acceptance (freeze, check, accept), even when probe-lean is present${lost.includes('probe-lean') ? '; strict acceptance needs the Lean graph from probe-lean' : ''}. Build-check acceptance (a full build in a clean copy) needs no probe.`;
      const labelled = unverified.length > 0 ? ` ${unverified.join(', ')} not qualified for this toolchain tuple: output labelled unverified.` : '';
      return { stage, status: 'ready-reduced', firstMissing: gaps[0], missing: lost,
        line: `${stage}: ready, reduced - without ${named.join(', ')}; output labelled reduced. Lost: ${lost.map((need) => `${need}: ${PROBE_LOSSES[need]}`).join(' ')}${acceptance}${labelled} To restore, the ${gaps[0].supplier} can ${gaps[0].step} (warning, not a stop)` };
    }
    if (gaps.length > 0) {
      const blocked = gaps.filter((gap) => probes[gap.need]?.status === 'unverified-blocked').map((gap) => gap.need);
      const absent = gaps.map((gap) => gap.need).filter((need) => !blocked.includes(need));
      const what = [absent.length > 0 && `missing ${absent.join(', ')}`,
        blocked.length > 0 && `blocked by ${blocked.join(', ')}: present but unverified, and no stage can use its output`].filter(Boolean).join('; ');
      return { stage, status: 'no-route', firstMissing: gaps[0], missing: gaps.map((gap) => gap.need), summary: what,
        line: `${stage}: no route here - ${what}; first, the ${gaps[0].supplier} must ${gaps[0].step}` };
    }
    const unverified = needs.filter((need) => need in PROBE_LOSSES && probes[need].status !== 'qualified');
    if (unverified.length > 0) {
      return { stage, status: 'ready-unverified', firstMissing: null,
        line: `${stage}: ready, unverified - ${unverified.join(', ')} not qualified for this toolchain tuple; their output is used and labelled unverified (warning, not a stop)` };
    }
    return { stage, status: 'full', firstMissing: null, line: `${stage}: full - every probe qualified for this toolchain tuple` };
  });
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
      `${OPTIONAL} setup and extraction go on here, and the stage lines say what each later stage can do; a host with recorded evidence (${hosts}) can also run the confined probe inventory.`,
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
    const nested = evidence.lakefile ? null : nestedLeanProject(root);
    if (nested) {
      evidence.nestedProject = nested;
      return item('lean', 'missing', `lean-toolchain is missing or empty at the project root; the Lean project is in ${nested}/`,
        `Rerun with the project root at ${nested}/, where the Lean project is.`, evidence);
    }
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

// The one visible subfolder holding a Lean project (a lean-toolchain and a
// lakefile), for a project root that holds none. With none or several
// candidates nothing is named. Only read; the user's project is never written.
function nestedLeanProject(root) {
  const found = sortedDirectories(root).filter((name) => !name.startsWith('.')
    && readText(path.join(root, name, 'lean-toolchain'))?.trim()
    && ['lakefile.toml', 'lakefile.lean'].some((file) => fs.existsSync(path.join(root, name, file))));
  return found.length === 1 ? found[0] : null;
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

// Where installed releases are looked for: the project root's own .aeneas, then,
// when the root is a subfolder of a git working tree, the top of that working
// tree (a Lean project in formal/ beside an install at the repository root). The
// repository-top folder counts only while it is itself in the working tree of the
// root: a link out of the tree, or a nested repository, hides it.
function releaseBases(root) {
  const bases = [path.join(root, '.aeneas', 'releases')];
  const top = gitWorkingTree(root);
  const above = top === null || top === root ? null : path.join(top, '.aeneas', 'releases');
  if (above !== null && fs.existsSync(above) && gitWorkingTree(above) === top) bases.push(above);
  return bases;
}

// Installed releases under .aeneas/releases/<tag>/<platform>/. Only a
// release whose directory name clearly matches the host counts as usable.
function aeneasReleases(bases, platform) {
  const host = cpuAndOs(platform);
  return bases.flatMap((base) => sortedDirectories(base).flatMap((tag) => sortedDirectories(path.join(base, tag)).map((name) => {
    const directory = path.join(base, tag, name);
    return {
      tag,
      platform: name,
      forHost: host !== null && cpuAndOs(name) === host,
      aeneas: executableFile(path.join(directory, 'aeneas')),
      charon: executableFile(path.join(directory, 'charon')),
    };
  })));
}

function aeneasItem(root, platform, provenance) {
  const lakefile = lakefileAeneas(root);
  const inputRev = manifestInputRev(root);
  const pins = [...new Set([lakefile.rev, inputRev, provenance.aeneasRev].filter(Boolean))];
  const bases = releaseBases(root);
  const releases = aeneasReleases(bases, platform);
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
    const nested = lakefile.file ? null : nestedLeanProject(root);
    if (nested) {
      return item('aeneas', 'missing', `no lakefile at the project root, so no Aeneas requirement; the Lean project is in ${nested}/`,
        `The Aeneas requirement is read from the Lean project's lakefile, so it is checked once the project root is at ${nested}/.`, evidence);
    }
    return item('aeneas', 'missing', 'no Aeneas requirement in the lakefile or lake-manifest.json',
      'Require the Aeneas Lean backend in lakefile.toml ([[require]] name = "aeneas" with a pinned rev).', evidence);
  }
  // A provenance conflict (the recorded Aeneas versions disagree) is a warning,
  // never a stop: the run goes on if the recorded extraction builds against the
  // pinned Lean library, and a failed build stops at record-extraction instead.
  const conflicts = provenance.problems.filter((problem) => problem.startsWith('conflict:'));
  if (conflicts.length > 0) evidence.provenanceConflicts = conflicts;
  const unverified = (reason, step) => item('aeneas', 'available-but-unverified', conflicts.length === 0 ? reason
    : `warning: ${conflicts.join('; ')}; the run goes on if the recorded extraction builds against the pinned Lean library (a failed build stops at record-extraction); ${reason}`,
  conflicts.length === 0 ? step
    : `${step} To clear the provenance warning: Regenerate the extraction so translation.json, lake-manifest.json and aeneas-config.yml agree, then rerun the profile.`,
  evidence);
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
    const install = `Aeneas and Charon for ${rev ?? 'it'} built for ${platform} (an Aeneas release from https://github.com/AeneasVerif/aeneas/releases bundles both) under .aeneas/releases/${rev ?? '<rev>'}/<platform>/ in the project root or at the top of its git working tree, or put aeneas and charon on PATH.`;
    let step = `Install ${install}`;
    if (!rev) step = `Pin the Aeneas rev in the lakefile, then install ${install}`;
    else if (uncertainty) step = `Run lake update so lake-manifest.json matches the lakefile, then install ${install}`;
    const foreign = pinned.filter((entry) => !entry.forHost).map((entry) => `${entry.tag}/${entry.platform}`);
    return item('aeneas', 'missing', [
      `${absent.join(' and ')} not found for ${platform} under .aeneas/releases/${pins.join(' or ') || '*'}/ or on PATH`,
      ...(foreign.length > 0 ? [`installed releases are for other hosts: ${foreign.join(', ')}`] : []),
      ...(uncertainty ? [uncertainty] : []),
      ...conflicts,
    ].join('; '), step, evidence);
  }
  if (uncertainty) {
    return unverified(uncertainty, pins.length === 0
      ? 'Pin the Aeneas rev in the lakefile, or run lake update so lake-manifest.json records the resolved revision, then rerun the profile.'
      : 'Run lake update so lake-manifest.json matches the lakefile, then rerun the profile.');
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
  // A tuple is evidence, never a gate: if this Aeneas works with the project's
  // Lean, the run goes on and the difference stays on record as a warning.
  if (tuples.contradictions.length > 0) {
    return unverified(`warning: ${tuples.contradictions.join('; ')}`,
      'None required; the tuple is recorded as evidence, not a gate. To match the tested tuple instead: Install the Charon and Lean versions this Aeneas revision was tested with, or move to another Aeneas revision.');
  }
  if (tuples.exact) {
    return unverified(
      `matches tested tuple ${tuples.exact.id}, whose recorded evidence covers only the confined probe-aeneas inventory operation, not Aeneas extraction`,
      'None required now; extraction with this tuple has no recorded FVS run yet.');
  }
  return unverified(
    `no tested tuple matches the installed toolchain: differs from ${tuples.differences.join('; ')}`,
    'None required to extract; results with this tuple stay unverified until a confined run is recorded for it.');
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
      `${OPTIONAL} setup and extraction go on without probes, and the stage lines say what each later stage can do.`, evidence);
  }
  const conflicts = provenance.problems.filter((problem) => problem.startsWith('conflict:'));
  const malformed = provenance.problems.some((problem) => problem.includes('escapes the project root'));
  if (provenance.translationJson === null) evidence.generatedLean = firstGeneratedLean(root);
  if (provenance.translationJson === null && conflicts.length === 0 && !malformed && !evidence.generatedLean) {
    return item('probe', 'not-extracted-yet',
      'no translation.json yet: the probe inventory runs on an Aeneas extraction that writes translation.json',
      'Extract the crate with the shared aeneas-extract workflow (/fvs:aeneas-extract), then rerun the profile.', evidence);
  }
  // Below a tested tuple the resolver never looks for probe-aeneas, so an
  // absent probe is checked here before anything is called present.
  const installed = fs.existsSync(managedProbePath(undefined, platform)) || Boolean(which('probe-aeneas'));
  const presence = (reason) => (installed ? reason : `probe-aeneas is not installed, and ${reason}`);
  const verdict = installed ? 'available-but-unverified' : 'missing';
  // Conflicting recorded versions leave any probe output unqualified, never a stop.
  if (conflicts.length > 0) {
    return item('probe', verdict, presence(`warning: ${conflicts.join('; ')}, so probe output stays unverified`),
      `${OPTIONAL} ${resolver.manual[0]}`, evidence);
  }
  if (resolver.status === 'unknown') {
    return item('probe', verdict, presence(`provenance unknown: ${provenance.problems.join('; ')}`),
      `${OPTIONAL} ${resolver.manual[0]}`, evidence);
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
        `${OPTIONAL} Pin the Charon and Lean versions this Aeneas revision was tested with (or move to another Aeneas revision), then re-extract.`,
        evidence);
    }
    const qualify = `qualify this tuple: run probe-aeneas ${PROBE_RELEASE.tag} confined against this project with its own Aeneas, Charon and Lean, record the envelope, helper versions and platform, and add the tuple to TESTED_TUPLES in a reviewed PR citing that evidence.`;
    return item('probe', verdict,
      presence(`no tested tuple matches this extraction: differs from ${tuples.differences.join('; ')}`),
      installed
        ? `${OPTIONAL} to verify, ${qualify}`
        : `${OPTIONAL} install probe-aeneas ${PROBE_RELEASE.tag} by hand from ${PROBE_RELEASE.baseUrl} (FVS installs it only for a tested tuple), then ${qualify}`,
      evidence);
  }
  if (resolver.status === 'verified') {
    return item('probe', GREEN,
      `exact tested tuple ${resolver.tuple} on ${platform}, with probe-aeneas and every helper at the tested version`,
      null, evidence, { operation: 'probe-aeneas inventory (confined)', tuple: resolver.tuple, platform });
  }
  // A tested tuple with a drifted or absent probe or helper.
  return item('probe', resolver.status, resolver.reasons.join('; '), `${OPTIONAL} ${resolver.manual[0]}`, evidence);
}

export function profile({ projectRoot, platform = hostTarget() }) {
  const root = path.resolve(projectRoot);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) fatal(`project root is not a directory: ${root}`);
  const resolver = resolveProbe({ projectRoot: root, platform });
  const probe = probeItem(root, platform, resolver);
  const result = {
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
      probe,
    ],
    probes: probeStatuses(root, probe, resolver, platform),
  };
  return { ...result, readiness: readiness(result) };
}

function renderText(result) {
  const lines = [`FVS >> compatibility profile for ${result.projectRoot} on ${result.platform}`];
  for (const entry of result.items) {
    lines.push(`${entry.id}: ${entry.verdict} - ${entry.reason}`);
    if (entry.scope) lines.push(`  scope: ${entry.scope.operation}, tuple ${entry.scope.tuple}, ${entry.scope.platform} only`);
    if (entry.nextStep) lines.push(`  next: ${entry.nextStep}`);
  }
  lines.push('probes (none is needed for setup or extraction; the stage lines below say what each stage needs):');
  for (const entry of result.probes ?? []) {
    lines.push(`  ${entry.id}: ${entry.status}${entry.reason ? ` (${entry.reason})` : ''}${entry.lost ? `; loses ${entry.lost}` : ''}`);
  }
  lines.push('stages:');
  for (const entry of readiness(result)) lines.push(`  ${entry.line}`);
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

// Auto-track state: M1 setup choices/offer/extraction plus an optional M2 agreement; the
// extraction record (state.json) and the externals record (externals.json).
// ponytail: no lock; the coordinator is the only writer of this state.
const STATE_DIR = path.join('.formalising', 'auto-fv');
const ROADMAP_PATH = '.formalising/auto-fv/ROADMAP.md';
// nodeHours is recorded owner metadata only: milestone 1 runs no proofs and enforces no per-node
// limit, and the owner has since decided against arbitrary per-node proof timeouts.
const DEFAULT_LIMITS = { nodeHours: 2, workers: 3 };
// The shared extractor's final success-oracle verdict, as its run-end summary reports it.
const ORACLE_VERDICTS = ['complete', 'refused', 'unknown'];
const REQUIRED_CHECKS = ['status', 'verify-tree', 'verify-restore'];
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

function choiceErrors(choices, version = 1) {
  const errors = [];
  if (!fields(errors, choices, 'choices', ['source', 'scope', 'limits', ...(version === 2 ? ['budget', 'memory'] : [])])) return errors;
  if (fields(errors, choices.source, 'source', ['revision', 'configuration'])) {
    // The revision reaches git as an argument, so an option-like value is refused.
    if (!isText(choices.source.revision) || /^-|\s/.test(choices.source.revision)) {
      errors.push('source.revision must be a git revision (a commit, tag or branch name)');
    }
    if (!isText(choices.source.configuration)) errors.push('source.configuration must be a non-empty string');
  }
  if (!isText(choices.scope)) errors.push('scope must be a non-empty string naming the bounded initial scope');
  if (version === 2) {
    if (fields(errors, choices.limits, 'limits', ['workers']) && (!Number.isSafeInteger(choices.limits.workers) || choices.limits.workers < 1)) errors.push('limits.workers must be a positive integer');
    try { parseBudget(choices.budget); } catch (error) { errors.push(error.message); }
    if (fields(errors, choices.memory, 'memory policy', ['mode']) && !['disabled', 'beads'].includes(choices.memory.mode)) errors.push('memory mode must be disabled or beads');
  } else {
  if (fields(errors, choices.limits, 'limits', ['nodeHours', 'workers', 'wallClockHours'])) {
    const { nodeHours, workers, wallClockHours } = choices.limits;
    if (!positive(nodeHours)) errors.push('limits.nodeHours must be a positive number of hours');
    if (!Number.isInteger(workers) || workers < 1) errors.push('limits.workers must be a positive integer');
    if (wallClockHours === undefined) errors.push('limits.wallClockHours is required: the owner names one total wall-clock cap');
    else if (!positive(wallClockHours)) errors.push('limits.wallClockHours must be a positive number of hours');
  }
  }
  return errors;
}

function normalizeChoices(input, version = 1) {
  if (version === 2) input = JSON.parse(JSON.stringify(memoryDataSnapshot(input)));
  const choices = plainObject(input) && plainObject(input.limits)
    ? { ...input, limits: { ...(version === 1 ? DEFAULT_LIMITS : { workers: DEFAULT_LIMITS.workers }), ...input.limits }, ...(version === 2 ? { budget: input.budget ?? { kind: 'none' }, memory: input.memory ?? { mode: 'disabled' } } : {}) }
    : input;
  const errors = choiceErrors(choices, version);
  if (errors.length > 0) refuse('invalid-input', `invalid owner choices: ${errors.join('; ')}`, { errors });
  const { source, scope, limits } = choices;
  return {
    source: { revision: source.revision, configuration: source.configuration },
    scope,
    limits: version === 1 ? { nodeHours: limits.nodeHours, workers: limits.workers, wallClockHours: limits.wallClockHours } : { workers: limits.workers },
    ...(version === 2 ? { budget: parseBudget(choices.budget), memory: { mode: choices.memory.mode } } : {}),
  };
}

function stateErrors(state) {
  const errors = [];
  if (!fields(errors, state, 'state', ['schema', 'schemaVersion', 'profiledAt', 'profile', 'choices', 'roadmap', 'extraction', 'choicesGeneration', 'agreements', 'memoryBindings'])) return errors;
  if (state.schema !== 'fvs/auto-state' || ![1, 2].includes(state.schemaVersion)) errors.push('schema must be fvs/auto-state version 1 or 2');
  if (!plainObject(state.profile) || state.profile.schema !== 'fvs/auto-profile' || !Array.isArray(state.profile.items)) {
    errors.push('profile must be a recorded fvs/auto-profile result');
  }
  errors.push(...choiceErrors(state.choices, state.schemaVersion));
  const { roadmap, extraction } = state;
  if (roadmap !== null && (!fields(errors, roadmap, 'roadmap', ['decision', 'path', 'decidedAt'])
    || !['accepted', 'declined'].includes(roadmap.decision)
    || roadmap.path !== (roadmap.decision === 'accepted' ? ROADMAP_PATH : null) || !isText(roadmap.decidedAt))) {
    errors.push('roadmap must be null or an accepted or declined decision with its path and time');
  }
  if (extraction !== null) errors.push(...extractionErrors(extraction));
  errors.push(...agreementStateErrors(state));
  errors.push(...memoryBindingsErrors(state.memoryBindings));
  return errors;
}

export { stateErrors as recordedStateErrors };
const EXTRACTION_FIELDS = ['status', 'recordedAt', 'selected', 'reasons', 'declared', 'checks', 'inputs', 'note'];

function inputsValid(inputs) {
  return plainObject(inputs) && isText(inputs.out) && /^[0-9a-f]{64}$/.test(inputs.manifestSha256 ?? '')
    && isText(inputs.crateRoot) && isText(inputs.mode) && (inputs.sourceCommit === null || isText(inputs.sourceCommit))
    && Array.isArray(inputs.patches)
    && inputs.patches.every((patch) => plainObject(patch) && isText(patch.file) && /^[0-9a-f]{64}$/.test(patch.sha256 ?? ''));
}

// Structural checks only: a stored record is never re-verified by running tools. A success record must
// carry everything that made it a success; a failed record keeps its reasons and may lack inputs.
const SHA256 = /^[0-9a-f]{64}$/;

// The recorded extraction attempt the patch engine re-validated (attempt-status);
// absent for an extraction that did not run through the attempt recorder.
const ATTEMPT_STAGES = ['charon', 'aeneas', 'publish'];


// The optional M2 extension records declared owner evidence, not authentication or proof acceptance.
// Approval covers canonical JSON content; roadmap status logs and record timestamps are not approval.
const AGREEMENT_FIELDS = ['schema', 'schemaVersion', 'mode', 'payload', 'ownerEvidence', 'approvedPayloadSha256'];
// `targets` is optional and left out of the payload when the owner names no crates, so an
// agreement written without it keeps its digest.
const PAYLOAD_FIELDS = ['choicesGeneration', 'choices', 'contextVersion', 'boundaries', 'conventions', 'layout',
  'claims', 'trust', 'acceptance', 'ownerReserved', 'execution', 'draftPr', 'targets'];
const CRATE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// The crates of a monorepo the owner verifies, and each crate the owner decided not to
// verify, with that decision in the owner's words. A non-target crate's items can only
// become assumptions; a target crate's items are proved, and other targets use the result.
function targetsErrors(targets) {
  const errors = [];
  if (!fields(errors, targets, 'agreement.payload.targets', ['crates', 'nonTargets'])) return errors;
  const { crates, nonTargets } = targets;
  const names = Array.isArray(crates) && crates.every((name) => typeof name === 'string' && CRATE_NAME.test(name));
  if (!names || crates.length === 0 || new Set(crates).size !== crates.length) {
    errors.push('agreement.payload.targets.crates must be a list of distinct crate names with at least one entry');
  }
  if (!Array.isArray(nonTargets)) errors.push('agreement.payload.targets.nonTargets must be a list, empty when the owner drops no crate');
  else {
    nonTargets.forEach((entry, index) => {
      const where = `agreement.payload.targets.nonTargets[${index}]`;
      if (!fields(errors, entry, where, ['crate', 'decision'])) return;
      if (typeof entry.crate !== 'string' || !CRATE_NAME.test(entry.crate)) errors.push(`${where}.crate must be a crate name`);
      else if (names && crates.includes(entry.crate)) errors.push(`${where}.crate ${entry.crate} is also a target`);
      if (!isText(entry.decision)) errors.push(`${where}.decision must be the owner's decision in words`);
    });
    if (new Set(nonTargets.map((entry) => entry?.crate)).size !== nonTargets.length) errors.push('agreement.payload.targets.nonTargets names a crate twice');
  }
  return errors;
}
const generationValid = (value) => Number.isSafeInteger(value) && value >= 0;
const textList = (value) => Array.isArray(value) && value.every(isText);
const canonicalJson = (value) => JSON.stringify(value, function (_key, item) {
  return plainObject(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item;
});
const approvalContent = ({ schema, schemaVersion, mode, payload }) => ({ schema, schemaVersion, mode, payload });
const agreementEnvelope = (record) => Object.fromEntries(AGREEMENT_FIELDS.map((key) => [key, record[key]]));

// Also used to prepare the exact payload presented to the owner. Computing a digest grants nothing.
export const agreementPayloadSha256 = (agreement) => sha256(canonicalJson(approvalContent(agreement)));

function agreementErrors(value, stored = false) {
  const errors = [];
  if (!fields(errors, value, 'agreement', [...AGREEMENT_FIELDS, ...(stored ? ['contextSha256', 'recordedAt'] : [])])) return errors;
  if (value.schema !== 'fvs/auto-agreement' || ![1, 2].includes(value.schemaVersion)) errors.push('agreement must be fvs/auto-agreement version 1 or 2');
  if (value.mode !== 'nonpublic-intent') errors.push('agreement.mode must be nonpublic-intent; public-api is unsupported pending separately permitted visibility landing');
  const p = value.payload;
  if (fields(errors, p, 'agreement.payload', PAYLOAD_FIELDS)) {
    if (!generationValid(p.choicesGeneration)) errors.push('agreement.payload.choicesGeneration must be a nonnegative safe integer');
    if (!Number.isSafeInteger(p.contextVersion) || p.contextVersion < 1) errors.push('agreement.payload.contextVersion must be a positive safe integer');
    errors.push(...choiceErrors(p.choices, value.schemaVersion));
    if (!['single-crate', 'monorepo'].includes(p.layout)) errors.push('agreement.payload.layout must be single-crate or monorepo');
    if ('targets' in p) {
      if (p.layout !== 'monorepo') errors.push('agreement.payload.targets applies to layout monorepo only');
      errors.push(...targetsErrors(p.targets));
    }
    for (const key of ['boundaries', 'conventions', 'claims', 'trust', 'acceptance', 'ownerReserved']) {
      if (!textList(p[key]) || (['claims', 'trust', 'acceptance', 'ownerReserved'].includes(key) && p[key].length === 0)) {
        errors.push('agreement.payload.' + key + ' must be an explicit list of nonempty strings' + (['boundaries', 'conventions'].includes(key) ? '' : ' with at least one entry'));
      }
    }
    if (p.execution !== null) {
      if (fields(errors, p.execution, 'agreement.payload.execution', ['actions', 'reference'])
        && (!textList(p.execution.actions) || p.execution.actions.length === 0 || !isText(p.execution.reference))) {
        errors.push('execution must be null or explicit actions and their evidence reference');
      }
    }
    if (p.draftPr !== null) {
      if (fields(errors, p.draftPr, 'agreement.payload.draftPr', ['destination', 'reference'])
        && (!isText(p.draftPr.destination) || !isText(p.draftPr.reference))) {
        errors.push('draftPr must be null or an explicit destination and its evidence reference');
      }
    }
  }
  if (fields(errors, value.ownerEvidence, 'agreement.ownerEvidence', ['reference', 'response'])
    && (!isText(value.ownerEvidence.reference) || !isText(value.ownerEvidence.response))) {
    errors.push('ownerEvidence must retain the actual response text and its reference; authenticity is declared workflow evidence');
  }
  if (!SHA256.test(value.approvedPayloadSha256 ?? '') || value.approvedPayloadSha256 !== agreementPayloadSha256(value)) {
    errors.push('approvedPayloadSha256 does not match the actual retained canonical approval content');
  }
  if (stored) {
    if (!isText(value.recordedAt)) errors.push('agreement.recordedAt must be a nonempty string');
    if (value.contextSha256 !== sha256(canonicalJson(agreementEnvelope(value)))) errors.push('agreement.contextSha256 does not match its retained context and owner evidence');
  }
  return errors;
}

function agreementStateErrors(state) {
  const errors = [];
  if (!('choicesGeneration' in state) && !('agreements' in state)) return errors; // Legacy, no write-on-read.
  if (!generationValid(state.choicesGeneration) || !Array.isArray(state.agreements)) return ['choicesGeneration and agreements must be present together as a safe generation and an array'];
  let previousVersion = 0;
  let previousGeneration = 0;
  for (const record of state.agreements) {
    const recordErrors = agreementErrors(record, true);
    if (record.schemaVersion !== state.schemaVersion) recordErrors.push('agreement/state versions differ');
    errors.push(...recordErrors);
    if (recordErrors.length) continue;
    if (record.payload.contextVersion <= previousVersion || record.payload.choicesGeneration < previousGeneration
      || record.payload.choicesGeneration > state.choicesGeneration) errors.push('agreement history versions/generations must advance monotonically within the current generation');
    previousVersion = record.payload.contextVersion;
    previousGeneration = record.payload.choicesGeneration;
  }
  return errors;
}

function validateAgreement(value, code) {
  if (plainObject(value) && value.mode !== 'nonpublic-intent') {
    refuse('unsupported-agreement-mode', 'only nonpublic-intent is supported; public-API selection is not supported in this release');
  }
  const errors = agreementErrors(value);
  if (errors.length) refuse(code, 'invalid agreement: ' + errors.join('; '), { errors });
}

// Bounded Markdown profile: active ATX sections, fenced blocks and standalone HTML comments.
// Other raw/mixed HTML is ambiguous here and refuses; this is not a general Markdown renderer.
function activeAgreementText(text, file) {
  const invalid = (message) => refuse('invalid-agreement-context', message, { file });
  const contexts = [];
  let section = '', fence = null, comment = false, paragraph = false;
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
        if (fence.current) contexts.push(fence);
        fence = null;
      } else if (fence.current) fence.lines.push(line);
      continue; // Headings/comments inside code are inert, including JSON string contents.
    }
    if (comment || /^ {0,3}<!--/.test(line)) {
      let rest = line;
      while (true) {
        if (!comment) { rest = rest.trimStart().slice(4); comment = true; }
        const end = rest.indexOf('-->'), nested = rest.indexOf('<!--');
        if (nested >= 0 && (end < 0 || nested < end)) invalid('nested HTML comments make the current context ambiguous');
        if (end < 0) break;
        comment = false;
        rest = rest.slice(end + 3).trimStart();
        if (!rest) break;
        if (!rest.startsWith('<!--')) invalid('mixed HTML-comment/prose lines are unsupported in the canonical agreement context');
      }
      paragraph = false;
      continue;
    }
    if (/^(?: {4}| {0,3}\t)/.test(line)) { paragraph = false; continue; } // Indented examples.
    const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening) {
      const info = opening[3].trim();
      if (opening[2][0] === '`' && info.includes('`')) invalid('ambiguous backtick fence info');
      const current = /^fvs-auto-agreement(?:\s|$)/.test(info);
      if (current && (opening[1] || opening[2] !== '```' || info !== 'fvs-auto-agreement')) {
        invalid('the active current agreement fence must use unindented triple backticks and the exact fvs-auto-agreement tag');
      }
      fence = { marker: opening[2][0], length: opening[2].length, current, section, lines: [] };
      paragraph = false;
      continue;
    }
    if (line.includes('<!--') || line.includes('-->') || /^ {0,3}<(?:\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t/>])|[!?])/.test(line)) {
      invalid('mixed comments or other raw HTML blocks make the canonical agreement context ambiguous');
    }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|)[ \t]*$/.exec(line);
    if (heading) {
      if (heading[1].length <= 2) section = heading[1].length === 2 ? (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '') : '';
      paragraph = false;
    } else if (paragraph && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)) {
      section = ''; // A setext heading ends the old section; only documented ATX Decisions is supported.
      paragraph = false;
    } else paragraph = line.trim() !== '';
  }
  if (fence || comment) invalid('unclosed fenced block or HTML comment makes the canonical agreement context ambiguous');
  if (contexts.length !== 1) invalid('the roadmap must contain exactly one active current fvs-auto-agreement fence');
  if (!/^Decisions(?:\s|$)/.test(contexts[0].section)) invalid('the active current agreement fence must be in the roadmap Decisions section');
  return contexts[0].lines.join('\n');
}

function currentAgreementContext(root) {
  const file = path.join(root, ROADMAP_PATH);
  let text;
  try {
    const relative = path.relative(root, fs.realpathSync(file));
    if (!fs.lstatSync(file).isFile() || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('not a regular in-project roadmap');
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    refuse('agreement-context-missing', 'cannot read the canonical agreement context: ' + error.message, { file });
  }
  const content = activeAgreementText(text, file);
  let agreement;
  try { agreement = JSON.parse(content); }
  catch (error) { refuse('invalid-agreement-context', 'the current agreement fence is not JSON: ' + error.message, { file }); }
  validateAgreement(agreement, 'invalid-agreement-context');
  return { agreement, contextSha256: sha256(canonicalJson(agreement)) };
}

function checkAgreementChoices(state, agreement) {
  const changes = choiceChanges(agreement.payload.choices, state.choices);
  if (agreement.payload.choicesGeneration !== (state.choicesGeneration ?? 0) || changes.length) {
    refuse('stale-agreement', 'the agreement does not cover the current choices generation; an explicitly approved successor is required', { changes, choicesGeneration: state.choicesGeneration ?? 0 });
  }
}

// Narrow stored-content gate only. Auto-init must additionally check effective canonical intent.
function requireStoredAgreement(root, state) {
  const record = state.agreements?.at(-1);
  if (!record) refuse('agreement-required', 'record the initial owner agreement before the M2 route; roadmap offer acceptance is not agreement');
  checkAgreementChoices(state, record);
  const current = currentAgreementContext(root);
  if (current.contextSha256 !== record.contextSha256) {
    refuse('stale-agreement-context', 'the actual current roadmap context or retained owner evidence differs from the recorded agreement', { recordedContextVersion: record.payload.contextVersion, currentContextVersion: current.agreement.payload.contextVersion });
  }
  return { status: 'stored-context-current', contextSha256: record.contextSha256, agreement: record,
    semanticCheckRequired: 'Read the actual owner response, applicable roadmap sections and non-superseded Decisions before reporting semantic applicability; this stored-content gate does not authenticate a human or classify prose.' };
}

export function recordAgreement({ projectRoot, agreement, confirmOverwrite = false }) {
  const root = projectDirectory(projectRoot);
  const state = requireState(root);
  validateAgreement(agreement, 'invalid-input');
  if (agreement.schemaVersion !== state.schemaVersion) refuse('invalid-input', 'agreement/state versions differ; no implicit migration');
  const current = currentAgreementContext(root);
  if (canonicalJson(agreement) !== canonicalJson(current.agreement)) refuse('agreement-context-mismatch', 'the submitted agreement is not the actual current canonical roadmap envelope');
  checkAgreementChoices(state, agreement);
  const previous = state.agreements?.at(-1);
  if (previous?.contextSha256 === current.contextSha256) return { code: 'unchanged', message: 'this agreement is already recorded; nothing was written', state };
  if (previous) {
    if (agreement.payload.contextVersion <= previous.payload.contextVersion) refuse('stale-agreement-context', 'a successor must use a greater contextVersion than the previous agreement');
    if (!confirmOverwrite) refuse('confirmation-required', 'a successor agreement changes recorded owner-approved content', {
      changes: [{ field: 'agreement.contextVersion', recorded: previous.payload.contextVersion, requested: agreement.payload.contextVersion }],
      nextStep: 'Read the actual owner confirmation of the exact successor payload before using --confirm-overwrite.',
    });
  }
  state.choicesGeneration ??= 0;
  state.agreements ??= [];
  state.agreements.push({ ...agreement, contextSha256: current.contextSha256, recordedAt: now() });
  commitState(root, state, state);
  return { code: 'recorded', message: 'initial-scope agreement recorded; no workers or publication authorized by inference', state };
}

function publicationValid(publication, translation) {
  if (!Array.isArray(publication) || publication.length === 0) return false;
  const entryValid = (entry) => plainObject(entry) && isText(entry.attemptPath) && isText(entry.projectPath) && SHA256.test(entry.sha256 ?? '');
  if (!publication.every(entryValid)) return false;
  for (const key of ['attemptPath', 'projectPath']) if (new Set(publication.map((entry) => entry[key])).size !== publication.length) return false;
  return publication.some((entry) => entry.attemptPath === translation.attemptPath && entry.projectPath === translation.projectPath && entry.sha256 === translation.sha256);
}

function runValid(run) {
  return plainObject(run) && SHA256.test(run.attemptSha256 ?? '') && SHA256.test(run.manifestSha256 ?? '')
    && SHA256.test(run.configSha256 ?? '') && plainObject(run.config) && typeof run.supported === 'boolean'
    && Array.isArray(run.residuals) && run.trust === 'local-host-and-reviewed-scripts'
    && plainObject(run.stages) && Object.keys(run.stages).join() === ATTEMPT_STAGES.join() && ATTEMPT_STAGES.every((stage) => SHA256.test(run.stages[stage] ?? ''))
    && plainObject(run.llbc) && isText(run.llbc.path) && SHA256.test(run.llbc.sha256 ?? '')
    && plainObject(run.translation) && isText(run.translation.attemptPath) && isText(run.translation.projectPath) && SHA256.test(run.translation.sha256 ?? '')
    && publicationValid(run.publication, run.translation);
}

// What ties a crate's stitch to a provider: the provider, the digest of the provider's own publish
// stage that the stitch was made from, and the Lean modules it imports. An entry without them is only
// a label, and a label does not make the crate use the provider's translation.
const stitchEntries = (unit) => [].concat(unit?.stitch ?? []).filter((entry) => entry !== null && typeof entry === 'object');
const stitchEvidence = (entry) => isText(entry.provider) && SHA256.test(entry.providerStageSha256 ?? '')
  && Array.isArray(entry.modules) && entry.modules.length > 0 && entry.modules.every(isText);

// The roster of a run over several crates, which the extraction engine hashes (the main crate, the
// crates in order, each with its package, folder and stitch providers, the non-targets and the crates a
// patch removed). The roster is rebuilt from the rows the run holds and must agree with them field for
// field, besides carrying the hash every row and the run carry: a row dropped from the aggregate, one
// added, or one whose package, folder, stitch or non-targets changed cannot pass for the extraction that
// was made. Returns the first disagreement in words, or null.
function rosterProblem(run) {
  const { roster, rosterSha256, units } = run;
  if (!SHA256.test(rosterSha256 ?? '') || !plainObject(roster) || sha256(JSON.stringify(roster)) !== rosterSha256) return 'the roster does not match its hash';
  if (!units.every((unit) => unit.rosterSha256 === rosterSha256)) return 'a crate carries another roster than the run';
  const crates = units.map((unit) => unit.crate);
  const spelt = (crate) => typeof crate === 'string' && CRATE_NAME.test(crate);
  const bad = crates.find((crate) => !spelt(crate));
  if (bad !== undefined) return `${JSON.stringify(bad)} is not a crate name`;
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, at) => item === b[at]);
  if (new Set(crates).size !== crates.length || !Array.isArray(roster.order) || roster.order.length !== crates.length || !roster.order.every((crate) => crates.includes(crate))) {
    return 'a crate is missing from the run, or was added to it';
  }
  if (!same(roster.order, run.order)) return 'the order of the crates is not the roster\'s';
  if (!Array.isArray(roster.units) || roster.units.length !== roster.order.length) return 'the roster lists other crates than its order';
  if (isText(run.crate) && roster.main !== run.crate) return 'the main crate is not the roster\'s';
  for (const [at, crate] of roster.order.entries()) {
    const row = units.find((unit) => unit.crate === crate);
    const listed = roster.units[at];
    const providers = [...new Set(stitchEntries(row).map((entry) => entry.provider))].sort();
    if (listed?.crate !== crate || listed.package !== row.package || listed.dir !== row.dir || !same(Array.isArray(listed.stitch) ? [...new Set(listed.stitch)].sort() : null, providers)) {
      return `crate ${crate} does not match its roster entry (package, folder or stitch providers)`;
    }
  }
  const keyOf = (entry) => `${entry?.crate}\u0000${entry?.dir ?? ''}`;
  if (!Array.isArray(roster.nonTargets)) return 'the roster lists its non-targets in another form';
  const nonTargets = roster.nonTargets.map(keyOf).sort();
  for (const row of units) {
    if (!same((Array.isArray(row.nonTargets) ? row.nonTargets : []).map(keyOf).sort(), nonTargets)) return `crate ${row.crate} names other non-target crates than the roster`;
  }
  if (!Array.isArray(roster.dropped) || !roster.dropped.every((entry) => spelt(entry?.crate) && isText(entry.reason))) return 'the roster lists its dropped crates in another form';
  if (roster.dropped.some((entry) => crates.includes(entry.crate) || roster.nonTargets.some((other) => other?.crate === entry.crate))) return 'a dropped crate is also in the run or a non-target';
  return null;
}

// A run over several crates lists each crate's whole single-crate run in `units`, so
// a reader written for one crate reads any crate's row unchanged. Every unit comes
// from the same prepared copy as the main run, so it carries the same manifest hash,
// and the same roster. A stitch is more than a label: it names the provider's publish stage that it was
// made from, which must be the one the provider's row holds, and the crate's imports are its providers.
// Returns the first problem in words, or null.
// A stitch that replaced aliases leaves a Lean check for each file it changed (`leanChecks`). A row that replaced
// some and records none cannot have its checks held against a receipt: an empty record on both sides would pass.
function leanChecksProblem(rows) {
  for (const row of rows) {
    const replaced = stitchEntries(row).reduce((sum, entry) => sum + (Array.isArray(entry.replaced) ? entry.replaced.length : 0), 0);
    if (replaced > 0 && !(Array.isArray(row.leanChecks) && row.leanChecks.length > 0)) {
      return `${isText(row.crate) ? `crate ${row.crate}` : 'the run'} stitched ${replaced} alias${replaced === 1 ? '' : 'es'} but records no Lean check for ${replaced === 1 ? 'it' : 'them'}`;
    }
  }
  return null;
}

export function unitsProblem(run) {
  const { units } = run;
  if (units === undefined) {
    // The fields of an aggregate come together: a single crate's own run has none of them, so a run that
    // still carries the roster, its hash or the order has lost its crate rows and is not a single crate.
    const left = ['roster', 'rosterSha256', 'order'].filter((key) => key in run);
    return left.length === 0 ? leanChecksProblem([run]) : `the run carries its ${left.join(', ')} but lists none of its crates`;
  }
  if (!Array.isArray(units) || units.length === 0) return 'the run lists no crate';
  if (!units.every((unit) => runValid(unit) && isText(unit.crate) && isText(unit.status) && unit.manifestSha256 === run.manifestSha256)) return 'a crate row is not a valid run of this copy';
  const roster = rosterProblem(run);
  if (roster !== null) return roster;
  for (const unit of units) {
    for (const entry of stitchEntries(unit)) {
      if (!stitchEvidence(entry)) return `the stitch of ${unit.crate} to ${isText(entry.provider) ? entry.provider : '(no provider)'} carries no evidence (the digest of the provider's publish stage and the Lean modules it imports)`;
      const provider = units.find((row) => row.crate === entry.provider);
      if (provider === undefined || provider === unit) return `crate ${unit.crate} is stitched to ${entry.provider}, which is not another crate of the run`;
      if (provider.stages?.publish !== entry.providerStageSha256) return `the stitch of ${unit.crate} was made from another publication of ${entry.provider} than the run holds`;
    }
    const named = new Set(stitchEntries(unit).map((entry) => entry.provider));
    if (Array.isArray(unit.imports) && (unit.imports.length !== named.size || !unit.imports.every((crate) => named.has(crate)))) return `crate ${unit.crate} imports crates its stitch does not name`;
  }
  return leanChecksProblem(units);
}

const unitsValid = (run) => unitsProblem(run) === null;
const recordedRunValid = (run) => runValid(run) && unitsValid(run);

// The recorded run of one crate. Without a crate it is the main run, which is all a
// single-crate project has; with one it is that crate's unit, or null when the
// extraction holds no such crate.
export function runOf(state, crate) {
  const run = state?.extraction?.run ?? null;
  if (crate === undefined) return run;
  if (run === null) return null;
  return run.units ? run.units.find((unit) => unit.crate === crate) ?? null : (run.crate === crate ? run : null);
}

// The unit rows of a run: its units, or the run itself when it names its crate.
const unitsOf = (run) => run?.units ?? (isText(run?.crate) ? [run] : []);

// The crates a unit depends on, by every way the record names one: its Lean imports, the target
// crates its LLBC reaches (`dependsOn` and the foreign target crates), the ones the extraction left
// unstitched, and its stitch providers. The order of the crates and the stitch obligation read this
// one set, so an edge named in one place and not another cannot be ordered yet go unchecked.
function crateEdges(unit) {
  const names = (list) => (Array.isArray(list) ? list : []);
  return new Set([
    ...names(unit.imports),
    ...names(unit.dependsOn),
    ...names(unit.unstitched),
    ...stitchEntries(unit).map((entry) => entry.provider),
    ...names(unit.foreignCrates).filter((entry) => entry?.kind === 'target').map((entry) => entry.crate),
  ].filter(isText));
}

// The crates of an extraction that has more than one (or any, with `always`), with the
// other extracted crates each one depends on and an order that puts providers before
// consumers. A crate depends on another by any edge `crateEdges` names (its stitch, its
// imports, the target crates its LLBC reaches); null for a single-crate run, so nothing about
// that changes.
function crateView(run, always = false) {
  const units = unitsOf(run);
  if (units.length < (always ? 1 : 2)) return null;
  const crates = units.map((unit) => unit.crate);
  const dependsOn = new Map(units.map((unit) => [unit.crate, [...crateEdges(unit)].filter((crate) => crates.includes(crate) && crate !== unit.crate).sort()]));
  const derived = [];
  const rest = [...crates].sort();
  const ready = () => rest.find((crate) => dependsOn.get(crate).every((other) => derived.includes(other)));
  for (let next = ready(); next !== undefined; next = ready()) {
    derived.push(next);
    rest.splice(rest.indexOf(next), 1);
  }
  // The extraction's own order is kept when it already puts every provider first.
  const given = Array.isArray(run.order) && run.order.every((crate, at) => dependsOn.get(crate).every((other) => run.order.indexOf(other) < at)) ? run.order : null;
  return {
    order: given ?? derived,
    ...(rest.length > 0 ? { cycle: rest } : {}),
    units: units.map((unit) => ({ crate: unit.crate, package: unit.package ?? null, dir: unit.dir ?? null, dependsOn: dependsOn.get(unit.crate),
      hasErrorItems: Array.isArray(unit.hasErrors?.items) ? unit.hasErrors.items : [] })),
  };
}

// What the extraction and the owner's agreement together say about the crates of this
// project, or null when there is nothing to say: a single crate, no non-target crate
// the extraction declared, no crate a patch removed from the copy and no crate decision in
// the agreement. A target is an extracted crate the owner did not drop; a crate the agreement
// names a target but the extraction lacks is missing; a non-target crate, declared by the
// extraction or dropped by the owner, only has assumptions. A crate a patch removed from the
// copy (`omitted`: its sources are left out, or its path dependency became a registry release)
// is such a crate too, and the extraction's own reason for removing it is no substitute for the
// owner's decision: it waits for that decision like a declared non-target.
export function crateContextOf(state) {
  // No crate is accepted on an extraction whose scope is not settled.
  return scopeUnsettled(state?.extraction) === null ? recordedCrateContext(state) : null;
}

// The same, for a run that is read as it is (the run being recorded has no scope of its own to settle yet).
function recordedCrateContext(state) {
  const extraction = state?.extraction?.status === 'succeeded' ? state.extraction : null;
  if (!extraction) return null;
  const { run } = extraction;
  const units = unitsOf(run);
  const agreed = state.agreements?.at(-1)?.payload?.targets ?? null;
  const omitted = new Map((Array.isArray(run?.roster?.dropped) ? run.roster.dropped : []).filter((entry) => isText(entry?.crate)).map((entry) => [entry.crate, isText(entry.reason) ? entry.reason : null]));
  const declared = [...new Set([...[run, ...units].flatMap((row) => (Array.isArray(row?.nonTargets) ? row.nonTargets.map((entry) => entry?.crate) : [])).filter(isText), ...omitted.keys()])].sort();
  // The crates the extraction's own scope names, kept apart from the run: a run that is gone says nothing
  // against them.
  const scoped = extraction.scope?.kind === 'multi-crate' && Array.isArray(extraction.scope.libraryCrates) ? extraction.scope.libraryCrates.filter(isText) : [];
  if (units.length < 2 && declared.length === 0 && agreed === null && scoped.length < 2) return null;
  const dropped = new Set((agreed?.nonTargets ?? []).map((entry) => entry.crate));
  const view = crateView(run, true);
  if (view === null) {
    // An extraction that holds no crate at all (it carries no attempt) says nothing against an
    // agreement or a scope that names several: none of those crates is held, so none can be accepted, and
    // the obligation to verify each of them stays.
    const named = [...new Set([...declaredCrates({ targets: agreed }), ...scoped])].sort();
    if (units.length > 0 || named.length < 2) return null;
    return { view: { order: [], units: [] }, units, extracted: [], targets: [], missing: [...new Set([...(agreed?.crates ?? []), ...scoped])].sort(), nonTargets: new Set([...declared, ...dropped]), omitted, undecided: [], unlisted: [] };
  }
  // Providers first; the crates of a dependency cycle have no place in the order and follow it.
  const extracted = [...view.order, ...(view.cycle ?? [])];
  const targets = extracted.filter((crate) => !dropped.has(crate));
  return {
    view, units, extracted, targets,
    missing: (agreed?.crates ?? []).filter((crate) => !extracted.includes(crate)),
    nonTargets: new Set([...declared, ...dropped]),
    omitted,
    // Declared non-target crates and crates removed from the copy whose owner decision is not in the
    // agreement yet.
    undecided: declared.filter((crate) => !dropped.has(crate)),
    // Extracted crates that an agreement with crate decisions names as neither a target nor a non-target.
    unlisted: agreed === null ? [] : targets.filter((crate) => !agreed.crates.includes(crate)),
  };
}

// The crate context of a recorded state, for a reader that takes a null context for a project of one crate (the
// one-crate-per-spec-file rule, the allowed axioms): it refuses when the extraction the state holds has no settled
// scope, because one crate is never what is left when nothing says how many there are.
function settledCrateContext(state) {
  const unsettled = state?.extraction?.status === 'succeeded' ? scopeUnsettled(state.extraction) : null;
  if (unsettled !== null) refuse('scope-unsettled', unsettled, { nextStep: 'Rerun /fvs:auto-extract so that the extraction is recorded with its scope.' });
  return crateContextOf(state);
}

const crateContext = (root) => settledCrateContext(loadState(root));

// The crates a recorded extraction has to account for: the ones the owner's agreement names (targets and
// non-targets) and the in-repo library crates of the workspace the copy was prepared from (its
// inventory, which a copy prepared with a release folder records). More than one means the scope is
// several crates, and only an attempt over all of them can stand for it.
export function declaredCrates({ manifest = null, targets = null } = {}) {
  const named = [...(Array.isArray(targets?.crates) ? targets.crates : []), ...(Array.isArray(targets?.nonTargets) ? targets.nonTargets.map((entry) => entry?.crate) : [])];
  const original = manifest?.workspace?.original?.crates;
  const inRepo = (Array.isArray(original) ? original : []).filter((row) => row?.library).map((row) => row.crate);
  return [...new Set([...named, ...inRepo].filter(isText))].sort();
}

// What the copy is a copy of, as the extraction engine records it in the manifest when it prepares the copy
// (`scope.kind`: single-crate, multi-crate, or unknown; for several crates `libraryCrates` names the in-repo
// library crates of the workspace). A single crate is a fact the extraction established, never what is left
// when nothing says otherwise: a copy that records no scope, or one the engine could not classify, has an
// unknown scope, and an unknown scope is never read as a single crate.
const ESTABLISHED_SCOPES = ['single-crate', 'multi-crate'];
const scopeOf = (manifest) => (plainObject(manifest?.scope) && [...ESTABLISHED_SCOPES, 'unknown'].includes(manifest.scope.kind) ? manifest.scope
  : { kind: 'unknown', basis: 'none', reason: 'the copy records no scope (it was prepared before the extraction engine recorded one)' });

// Why a scope and the run recorded with it cannot be of the same extraction, or null. A scope of several
// crates needs the aggregate run over them: its crate rows and roster, with every library crate of the
// workspace a row, a non-target or a dropped crate. The scope is kept in the extraction record apart from
// the run, so a run that lost its rows (or is gone) cannot pass for the extraction of a single crate.
function scopeProblem(scope, run) {
  if (!plainObject(scope) || !ESTABLISHED_SCOPES.includes(scope.kind)) return 'the record does not say whether the extraction is of a single crate or of several, and an unknown scope is never read as a single crate';
  if (run?.scope !== undefined && canonicalJson(run.scope) !== canonicalJson(scope)) return 'the scope the attempt recorded is not the scope of the copy';
  if (scope.kind === 'single-crate') return null;
  const named = scope.libraryCrates;
  if (!Array.isArray(named) || named.length < 2 || !named.every((crate) => typeof crate === 'string' && CRATE_NAME.test(crate))) return 'the scope is several crates but does not name them';
  if (!plainObject(run) || !Array.isArray(run.units) || !plainObject(run.roster)) {
    return `the scope is several crates (${named.join(', ')}), but the record holds no run over them: it needs the attempt of every crate, each one a target, a non-target or dropped`;
  }
  const held = new Set([...run.units.map((unit) => unit?.crate), ...['nonTargets', 'dropped'].flatMap((key) => (Array.isArray(run.roster[key]) ? run.roster[key] : []).map((entry) => entry?.crate))]);
  const loose = named.filter((crate) => !held.has(crate));
  return loose.length === 0 ? null : `the scope names ${loose.join(', ')}, which the run neither extracts nor lists as a non-target or as dropped`;
}

// Why a succeeded extraction does not count yet, or null: its record keeps no scope (it was made before the extraction
// kept one) or an unknown one. A single crate is never what is left when nothing says otherwise, so the phase machine
// does not move past the extraction until it is recorded again with its scope established.
const scopeUnsettled = (extraction) => (plainObject(extraction?.scope) && ESTABLISHED_SCOPES.includes(extraction.scope.kind) ? null
  : 'the recorded extraction does not say whether it is of a single crate or of several, and an unknown scope is never read as a single crate');

function crateReport(context, acceptance = null) {
  const status = new Map((acceptance ?? []).map((entry) => [entry.crate, entry]));
  return { order: context.view.order, targets: context.targets, nonTargets: [...context.nonTargets].sort(),
    ...(context.missing.length > 0 ? { missing: context.missing } : {}), ...(context.view.cycle ? { cycle: context.view.cycle } : {}),
    units: context.view.units.map((unit) => (status.has(unit.crate) ? { ...unit, accepted: status.get(unit.crate).accepted, ...(status.get(unit.crate).reason ? { reason: status.get(unit.crate).reason } : {}) } : unit)) };
}

// The per-crate acceptance at the head of the open proof PR, once an accepting receipt for it
// was made against the recorded spec merge; null before that, and for a single-crate project.
function proofAcceptance(root, state, specs, context) {
  const specMerge = (specs?.prs ?? []).filter((pr) => pr.kind === 'spec' && pr.merged).at(-1);
  if (!context || !specMerge) return null;
  const proofPr = specs.prs.slice(specs.prs.lastIndexOf(specMerge) + 1).filter((pr) => pr.kind === 'proof' && !pr.merged).at(-1);
  const receipt = proofPr ? buildCheckReceipt(root, proofPr.head) : null;
  if (!(receipt?.accepted && receipt.specBase === specMerge.mergeCommit)) return null;
  // The phase and the per-crate report read one verdict on the receipt: a receipt that does not count
  // for the phase accepts no crate either.
  return crateAcceptance(root, specs, context, receipt, crateReceiptProblem(root, state, specs, context, receipt, proofPr.head));
}

// Why an accepting receipt of the proof head does not count for a run over several crates, or null:
// the allowed axioms cannot be derived at the head (`underivable`), the receipt was made with
// another list or none (`list`), or the externals records are not the ones the check read
// (`externals`). The list names only the axioms an accepted record puts on it, so a record whose
// content changed while its status and source stayed leaves the list as it was: the receipt names the
// digest of the whole externals file the check read, and the file now has to be that one.
function crateReceiptProblem(root, state, specs, context, receipt, head) {
  const allowed = allowedAxiomList(root, state, context, head, specs);
  if (allowed.problems.length > 0) return { kind: 'underivable', text: `the allowed axioms cannot be derived at that commit: ${allowed.problems.join('; ')}` };
  if (receipt.allowAxioms?.sha256 !== allowed.sha256) {
    return { kind: 'list', text: `it was not made with the allowed axioms of this commit (${receipt.allowAxioms ? 'it holds another list' : 'it holds none'})` };
  }
  let current = null;
  try { current = sha256(fs.readFileSync(externalsPath(root))); } catch { /* no externals file: the check read none either */ }
  if ((receipt.externals?.sha256 ?? null) !== current) {
    return { kind: 'externals', text: 'the externals records are not the ones the check read (the file changed after the check, or the receipt does not name the file it read)' };
  }
  return null;
}

// The pairs of verified crates where the consumer depends on the provider (its LLBC reaches items
// of it, or the record names it) but is not stitched to it. Each such item is an axiom in the
// consumer's own Lean: a black box where the provider's translation belongs, which a verified
// provider must never be. An import label alone is not a stitch. A crate the owner does not verify
// may be assumed, so it makes no pair.
function unstitchedPairs(context) {
  return context.units.filter((unit) => context.targets.includes(unit.crate)).flatMap((unit) => {
    // Linked means a stitch with its evidence: an import label alone, or a stitch entry that names
    // no provider publication and no module, does not make the crate use the provider's translation.
    const linked = new Set(stitchEntries(unit).filter(stitchEvidence).map((entry) => entry.provider));
    return [...crateEdges(unit)].filter((crate) => crate !== unit.crate && context.targets.includes(crate) && !linked.has(crate)).sort()
      .map((provider) => ({ crate: unit.crate, provider }));
  });
}

const unstitchedReason = ({ crate, provider }, subject = `crate ${crate}`) => `${subject} uses items of ${provider}, which is verified, without being stitched to it: they would be axioms in ${crate}'s Lean, not ${provider}'s translation. Stitch ${crate} to ${provider} in the extraction spec, or have the owner record ${provider} as a non-target in the agreement`;

// What stops a recorded run over several crates from being used, given the targets the owner's
// agreement names (null without a crate decision): a crate whose extraction did not complete, a
// dependency cycle, which no order of providers before consumers fits, and a verified crate that
// uses another verified crate's items without being stitched to it. The extraction engine refuses
// the first and the last itself; this is the second check of the same cases. Empty for a single crate.
export function crateProblems(run, agreedTargets = null) {
  const context = run ? recordedCrateContext({ extraction: { status: 'succeeded', run }, agreements: agreedTargets === null ? [] : [{ payload: { targets: agreedTargets } }] }) : null;
  if (context === null) return [];
  return [
    // A single crate's run has no status of its own: only the rows of a run over several crates do.
    ...context.units.filter((unit) => isText(unit.status) && unit.status !== 'complete').map((unit) => `crate ${unit.crate} did not complete its extraction (${unit.status})`),
    ...(context.view.cycle ? [`the crates ${context.view.cycle.join(', ')} depend on each other, so no order puts providers before consumers`] : []),
    ...unstitchedPairs(context).map((pair) => unstitchedReason(pair)),
  ];
}

// What the project itself still has to do once the extraction stitched crates together: the
// axioms its theorems rest on changed. FVS never rewrites those lists; this is not part of the
// extraction. Empty when no crate is stitched.
const stitchedWork = (run) => (unitsOf(run).some((unit) => [].concat(unit.stitch ?? []).length > 0)
  ? ' After the stitching the project has work FVS does not do: regenerate the pinned axiom lists in its own Lean project as a reviewed change, record an externals entry for each axiom that newly appears, and replace the hand-written Trusted axioms about functions the stitching now translates.'
  : '');

function crateWarnings(context) {
  return [
    ...context.missing.map((crate) => `the agreement names ${crate} as a target, but the extraction does not hold it`),
    ...context.unlisted.map((crate) => `the extraction holds ${crate}, which the agreement names as neither a target nor a non-target: a successor agreement records the owner's decision`),
    // The extraction is refused with these when it is recorded; they show here when the owner's
    // decision changed afterwards, and keep the crate from being accepted.
    ...unstitchedPairs(context).map((pair) => unstitchedReason(pair)),
  ];
}

const crateDecisions = (context) => context.undecided.map((crate) => (context.omitted.has(crate)
  ? `crate ${crate} left out of the extraction copy: the owner has not recorded a decision in the agreement`
  : `non-target crate ${crate}: the owner has not recorded a decision in the agreement`));

// The target crates the build check accepted at the head of the proof PR. The check builds the
// whole project once, so a crate is accepted when every statement of its recorded spec files
// built and every target crate it depends on is accepted too; a target with no built statement
// is not accepted, and neither is one that uses a verified crate it is not stitched to (see
// unstitchedPairs). What the statements may rest on beyond Lean's standard axioms is not judged
// here: the build check enforces the allowed axioms, and the state requires a receipt made with
// the current list (see allowedAxiomList).
function crateAcceptance(root, specs, context, receipt, blocked = null) {
  // The crates the agreement names but the extraction lacks follow either way: an extraction that holds
  // none of them (no attempt, or one for other crates) leaves every one of them to be accepted.
  const result = context.targets.length === 0 && context.extracted.length > 0
    ? [{ crate: null, accepted: false, reason: 'the agreement drops every extracted crate, so nothing is verified' }] : [];
  const prefix = repositoryPrefix(root);
  const pruned = ownerChangesOf(specs);
  const rows = currentSpecRows(specs).filter((row) => pruned.get(row.specFile) !== 'pruned');
  const files = new Map((Array.isArray(receipt.specFiles) ? receipt.specFiles : []).map((file) => [file?.path, file]));
  const dependsOn = new Map(context.view.units.map((unit) => [unit.crate, unit.dependsOn.filter((crate) => context.targets.includes(crate))]));
  const unstitched = unstitchedPairs(context);
  const reasonOf = (crate) => {
    const loose = unstitched.find((pair) => pair.crate === crate);
    if (loose) return unstitchedReason(loose, 'it');
    const own = rows.filter((row) => row.items.some((id) => itemCrate(id) === crate));
    if (own.length === 0) return 'no spec file is recorded for this crate';
    let statements = 0;
    for (const row of own) {
      const file = files.get(path.posix.join(prefix, row.specFile));
      if (!file) return `${row.specFile} is not among the files the build check built`;
      if (file.status !== 'built') return `${row.specFile} did not build in the check${isText(file.reason) ? `: ${file.reason}` : ''}`;
      for (const statement of Array.isArray(file.statements) ? file.statements : []) {
        statements += 1;
        if (statement?.status !== 'built') return `the statement ${statement?.name} did not build in the check`;
      }
    }
    return statements === 0 ? 'the build check built no statement of this crate' : null;
  };
  const accepted = new Set();
  // Providers come first, so a crate is judged after the crates it depends on.
  for (const crate of context.targets) {
    const reason = (blocked === null ? null : `the build check receipt does not count: ${blocked.text}`) ?? reasonOf(crate)
      ?? dependsOn.get(crate).filter((other) => !accepted.has(other)).map((other) => `it depends on ${other}, which is not accepted`).at(0) ?? null;
    if (reason === null) accepted.add(crate);
    result.push({ crate, accepted: reason === null, ...(reason === null ? {} : { reason }) });
  }
  for (const crate of context.missing) result.push({ crate, accepted: false, reason: 'the extraction does not hold this crate' });
  // A crate the extraction only assumes is a black box in every crate that calls it, and nobody but the
  // owner decides that a crate is not verified: until the agreement records it, the run is not done.
  for (const crate of context.undecided) {
    result.push({ crate, accepted: false, reason: context.omitted.has(crate)
      ? `the extraction left this crate out of the copy${context.omitted.get(crate) === null ? '' : ` (${context.omitted.get(crate)})`}, and the owner has not recorded that decision in the agreement`
      : 'the extraction assumes this crate as a non-target, and the owner has not recorded that decision in the agreement' });
  }
  return result;
}

// ---- The allowed axioms of a run over several crates -------------------------------------
//
// The build check refuses a statement that rests on an axiom beyond Lean's standard ones unless
// the list it is given names that axiom, fully qualified. The engine writes the list from the
// blobs of the commit being checked and requires the receipt to have been made with it. An
// axiom is listed only when its origin says it is the owner's to assume:
//   - declared in a file the extraction published (its hash is the recorded one), for an item of
//     a crate the owner does not verify or of another library: it only asserts that the item
//     exists;
//   - declared there for an item another verified crate has no definition for, and named in the
//     stitch's assumed list;
//   - declared there for an item the verified crate itself left opaque, with an accepted
//     externals record whose source starts with that item's path;
//   - hand-written in a Trusted folder, citing in its docstring, in backticks, the id of an
//     accepted externals record whose source names a crate path and no verified crate.
// Anything else the engine cannot read or place is withheld and named, never listed.

const ALLOWED_AXIOMS_SCHEMA = 'fvs/auto-allowed-axioms';
const allowedAxiomsPath = (root) => path.join(root, STATE_DIR, 'allowed-axioms.json');

// Lean source with its comments and string contents blanked (every newline kept, so lines and
// columns hold), and the doc comments with where each one ends.
function leanCode(text) {
  const out = text.split('');
  const docs = [];
  const blank = (from, to) => {
    for (let at = from; at < to; at += 1) if (out[at] !== '\n') out[at] = ' ';
  };
  let at = 0;
  while (at < text.length) {
    const here = text[at];
    if (here === '/' && text[at + 1] === '-') {
      // A block comment; they nest.
      let depth = 1;
      let end = at + 2;
      while (end < text.length && depth > 0) {
        if (text[end] === '/' && text[end + 1] === '-') { depth += 1; end += 2; }
        else if (text[end] === '-' && text[end + 1] === '/') { depth -= 1; end += 2; }
        else end += 1;
      }
      if (text[at + 2] === '-') docs.push({ end, text: text.slice(at, end) });
      blank(at, end);
      at = end;
    } else if (here === '-' && text[at + 1] === '-') {
      let end = at;
      while (end < text.length && text[end] !== '\n') end += 1;
      blank(at, end);
      at = end;
    } else if (here === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      blank(at + 1, Math.min(end, text.length));
      at = end + 1;
    } else if (here === "'" && !/[A-Za-z0-9_'!?]/.test(text[at - 1] ?? '')) {
      // A character literal; a quote after an identifier is part of the name.
      const literal = /^'(?:\\.|[^\\'\n])'/.exec(text.slice(at, at + 8));
      if (literal) {
        blank(at + 1, at + literal[0].length - 1);
        at += literal[0].length;
      } else at += 1;
    } else at += 1;
  }
  return { code: out.join(''), docs };
}

// The axioms a Lean file declares, each with its fully qualified name (the enclosing
// namespaces in front) and the doc comment right before it. `unread` counts axiom keywords the
// reader could not place in a declaration: a file with any is not read at all.
export function leanAxioms(text) {
  const { code, docs } = leanCode(text);
  const commands = [];
  let offset = 0;
  for (const [index, line] of code.split('\n').entries()) {
    if (/^\S/.test(line)) commands.push({ line: index + 1, start: offset, text: line });
    else if (commands.length > 0) commands.at(-1).text += `\n${line}`;
    offset += line.length + 1;
  }
  const frames = [];
  const axioms = [];
  let pending = null;
  for (const command of commands) {
    let rest = command.text.trimStart();
    let attributes = false;
    for (;;) {
      if (rest.startsWith('@[')) {
        let depth = 0;
        let close = 0;
        for (; close < rest.length; close += 1) {
          if (rest[close] === '[') depth += 1;
          else if (rest[close] === ']' && (depth -= 1) === 0) break;
        }
        rest = rest.slice(close + 1).trimStart();
        attributes = true;
        continue;
      }
      const modifier = /^(?:private|protected|noncomputable|unsafe|partial|nonrec|public|meta)\b\s*/.exec(rest);
      if (!modifier) break;
      rest = rest.slice(modifier[0].length);
    }
    // The doc comment ends right before the command, with only blanks between.
    const doc = docs.findLast((candidate) => candidate.end <= command.start && code.slice(candidate.end, command.start).trim() === '');
    if (rest === '' && attributes) {
      // Attributes on a line of their own belong to the declaration after them, and so does the doc comment before them.
      pending = pending ?? (doc ? doc.text : null);
      continue;
    }
    const docText = doc ? doc.text : pending;
    pending = null;
    const head = /^[A-Za-z_]+/.exec(rest)?.[0];
    if (head === 'namespace') frames.push(/^namespace\s+(\S+)/.exec(rest)?.[1] ?? '');
    else if (head === 'section' || head === 'mutual') frames.push('');
    else if (head === 'end') frames.pop();
    else if (head === 'axiom') {
      const name = /^axiom\s+(«[^»]*»|[^\s:({[⦃]+)/.exec(rest)?.[1];
      if (name) {
        const full = name.startsWith('_root_.') ? name.slice(7) : [...frames.filter(Boolean), name].join('.');
        axioms.push({ name, full, line: command.line, doc: docText });
      }
    }
  }
  const keywords = (code.match(/(?<![A-Za-z0-9_.'«»])axiom(?![A-Za-z0-9_'])/g) ?? []).length;
  return { axioms, unread: keywords - axioms.length };
}

// The Rust path an extraction writes first in an item's doc comment, such as
// `[core::num::{u32}::wrapping_div]:`, or null for a hand-written docstring.
const docRustPath = (doc) => /^(?:Trait (?:implementation|declaration): )?\[(.*)\]:?$/.exec(doc?.replace(/^\/--\s*/, '').split('\n')[0].trim() ?? '')?.[1] ?? null;
const docRecordIds = (doc) => [...(doc ?? '').matchAll(/`([^`\s]+)`/g)].map((entry) => entry[1]);

const allowedAxiomsBytes = (crates) => Buffer.from(`${JSON.stringify({ schema: ALLOWED_AXIOMS_SCHEMA, schemaVersion: 2, crates }, null, 2)}\n`);

// The path of the project root inside its git working tree, posix style: what the build check puts
// in front of a project file in its receipt. Empty when the root is the top or in no repository.
// The working tree's top is a real path, so the root is compared by its real path too: a project
// reached through a symbolic link (a temporary folder on macOS, say) has the same prefix.
function repositoryPrefix(root) {
  const top = gitWorkingTree(root);
  return top === null ? '' : path.relative(top, fs.realpathSync(root)).split(path.sep).join('/');
}

// The live spec files of each target crate, as the build check reports them. A spec file covers one
// crate, so a statement belongs to the crate whose list holds its file.
function crateSpecFiles(root, specs, context) {
  const prefix = repositoryPrefix(root);
  const pruned = ownerChangesOf(specs);
  const rows = currentSpecRows(specs).filter((row) => pruned.get(row.specFile) !== 'pruned');
  return new Map(context.targets.map((crate) => [crate, [...new Set(rows.filter((row) => row.items.some((id) => itemCrate(id) === crate))
    .map((row) => path.posix.join(prefix, row.specFile)))].sort()]));
}

function trustedLeanFiles(root, commit) {
  const run = spawnSync('git', ['--no-optional-locks', '-C', root, 'ls-tree', '-r', '--name-only', commit], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) return null;
  return run.stdout.split('\n').filter((file) => file.endsWith('.lean') && file.split('/').slice(0, -1).some((folder) => folder.toLowerCase() === 'trusted'));
}

// Why an accepted externals record is not about axioms the owner may assume, or null. The
// record's source is free text, so it must name a crate path and no verified crate.
function recordSourceProblem(record, context) {
  const text = record.source.symbol;
  if (![...text.matchAll(/(?:^|[\s,;(])([A-Za-z_][A-Za-z0-9_]*)::/g)].length) return `the record ${record.id} names no crate path in its source`;
  for (const unit of context.units.filter((entry) => context.targets.includes(entry.crate))) {
    const names = [unit.crate, ...(isText(unit.package) ? [unit.package] : [])];
    if (names.some((name) => new RegExp(`(?<![A-Za-z0-9_-])${name.replace(/[^A-Za-z0-9_]/g, '\\$&')}(?![A-Za-z0-9_-])`).test(text))) {
      return `the record ${record.id} is about ${unit.crate}, a verified crate: prove it there`;
    }
  }
  return null;
}

// What native_decide and bv_decide add to a statement's axioms, as the build check names them. The
// build check judges such an axiom against the merged spec by its exact name: one the statement already
// rested on there is kept and flagged, a new one is refused. The list never holds one, so a name that
// looks native is not a way around that rule, and an unchanged baseline dependency needs no entry.
const NATIVE_AXIOM = /\._native\.(native_decide|bv_decide)\.ax_|^Lean\.(ofReduceBool|trustCompiler)$/;
const NATIVE_REASON = 'it is an axiom that native_decide or bv_decide adds: the build check judges it against the merged spec (an unchanged one is flagged, a new one refused), so it is never listed';

// The axioms a run over several crates may rest on at `commit`: for each target crate, its live spec
// files and the fully qualified, sorted axioms its statements may rest on (`crates`), the distinct
// names over all of them (`axioms`), each axiom withheld and why, and the problems that stop the
// list from being derived. A crate's axioms are the ones its own published Lean declares and the
// owner may assume, those of every crate it depends on (stitched crates and the crates its LLBC
// reaches, followed to the end), and the Trusted ones. A statement of one crate never rests on an
// axiom that only another crate's section holds.
export function allowedAxiomList(root, state, context, commit, specs = null) {
  const problems = [];
  const withheld = [];
  const own = new Map(context.units.map((unit) => [unit.crate, new Set()]));
  const trusted = new Set();
  const accepted = new Map((loadExternals(root)?.records ?? []).filter((record) => record.status === 'assumption-accepted').map((record) => [record.id, record]));
  const read = (file, expectedSha256) => {
    // The root or the recorded path may reach the project through a symbolic link the other does
    // not (a temporary folder on macOS, say): the file is the project's when either the two paths
    // as written or the two real paths put it inside the project.
    const absolute = path.resolve(root, file);
    const inside = (base, target) => {
      const below = path.relative(base, target);
      return below === '' || below.startsWith('..') || path.isAbsolute(below) ? null : below;
    };
    const relative = inside(root, absolute) ?? inside(fs.realpathSync(root), realPathOf(absolute)) ?? '';
    if (relative === '') {
      problems.push(`${file} is outside this project (${root}), so it cannot be read at ${commit}: the extraction was recorded from another checkout, so record it again from this one`);
      return null;
    }
    const posix = relative.split(path.sep).join('/');
    const bytes = bytesAt(root, commit, posix);
    if (bytes === null) problems.push(`${posix} is not in the commit ${commit}`);
    else if (expectedSha256 !== undefined && sha256(bytes) !== expectedSha256) problems.push(`${posix} differs from the file the extraction published`);
    else {
      const { axioms, unread } = leanAxioms(bytes.toString('utf8'));
      if (unread === 0) return { posix, axioms };
      problems.push(`${posix} holds ${unread} axiom keyword(s) the engine could not place in a declaration`);
    }
    return null;
  };
  for (const unit of context.units) {
    const assumed = [].concat(unit.stitch ?? []).flatMap((entry) => (Array.isArray(entry?.assumed) ? entry.assumed : []));
    const foreign = new Set((Array.isArray(unit.foreignCrates) ? unit.foreignCrates : []).map((entry) => entry?.crate));
    for (const entry of Array.isArray(unit.publication) ? unit.publication : []) {
      if (!entry.projectPath.endsWith('.lean')) continue;
      const file = read(entry.projectPath, entry.sha256);
      for (const axiom of file?.axioms ?? []) {
        const rustPath = docRustPath(axiom.doc);
        const owner = rustPath?.split('::')[0];
        const withhold = (reason) => withheld.push({ name: axiom.full, file: file.posix, reason });
        if (NATIVE_AXIOM.test(axiom.full)) withhold(NATIVE_REASON);
        else if (!owner || !CRATE_NAME.test(owner)) withhold('its doc comment gives no Rust path, so its crate cannot be read');
        else if (owner !== unit.crate && !foreign.has(owner)) withhold(`its crate ${owner} is not one the extraction recorded for ${unit.crate}`);
        else if (!context.targets.includes(owner)) own.get(unit.crate).add(axiom.full);
        else if (owner === unit.crate) {
          if ([...accepted.values()].some((record) => record.source.symbol === rustPath || record.source.symbol.startsWith(`${rustPath} `))) own.get(unit.crate).add(axiom.full);
          else withhold(`it stands for ${rustPath}, an item of the verified crate ${owner} that has no definition there: the owner accepts it with an externals record whose source starts with that path`);
        } else if (assumed.some((item) => item?.rustPath === rustPath)) own.get(unit.crate).add(axiom.full);
        else withhold(`it stands for ${rustPath}, an item of the verified crate ${owner}: stitch ${unit.crate} to ${owner}, or prove the function there`);
      }
    }
  }
  for (const relative of trustedLeanFiles(root, commit) ?? []) {
    const file = read(relative);
    for (const axiom of file?.axioms ?? []) {
      const records = docRecordIds(axiom.doc).filter((id) => accepted.has(id)).map((id) => accepted.get(id));
      const reason = NATIVE_AXIOM.test(axiom.full) ? NATIVE_REASON
        : records.length === 0 ? 'its docstring cites no accepted externals record (the record id in backticks)' : records.map((record) => recordSourceProblem(record, context)).find(Boolean);
      if (reason) withheld.push({ name: axiom.full, file: file.posix, reason });
      else trusted.add(axiom.full);
    }
  }
  const dependsOn = new Map(context.view.units.map((unit) => [unit.crate, unit.dependsOn]));
  const reach = (crate) => {
    const seen = new Set();
    const visit = (next) => {
      if (seen.has(next)) return;
      seen.add(next);
      for (const provider of dependsOn.get(next) ?? []) visit(provider);
    };
    visit(crate);
    return seen;
  };
  const files = crateSpecFiles(root, specs, context);
  const crates = [...context.targets].sort().map((crate) => ({
    crate,
    specFiles: files.get(crate),
    axioms: [...new Set([...reach(crate)].flatMap((name) => [...(own.get(name) ?? [])]).concat([...trusted]))].sort(),
  }));
  const bytes = allowedAxiomsBytes(crates);
  return { commit, crates, axioms: [...new Set(crates.flatMap((entry) => entry.axioms))].sort(), withheld, problems, bytes, sha256: sha256(bytes) };
}

// Writes the allowed axioms for the commit the build check will check: the open proof PR's
// head when one is recorded, else HEAD. A project with one crate has no list.
export function allowedAxioms({ projectRoot, commit }) {
  const root = projectDirectory(projectRoot);
  const state = requireState(root);
  const context = settledCrateContext(state);
  if (context === null) refuse('not-multi-crate', 'this project has one crate: the build check runs without an allowed-axioms file');
  const specs = loadSpecs(root);
  const proofPr = (specs?.prs ?? []).filter((pr) => pr.kind === 'proof' && !pr.merged).at(-1);
  const head = resolveRevision(root, commit ?? proofPr?.head ?? 'HEAD');
  if (head === null) refuse('usage', `${commit ?? proofPr?.head ?? 'HEAD'} is not a commit in this checkout`);
  const result = allowedAxiomList(root, state, context, head, specs);
  if (result.problems.length > 0) refuse('allowed-axioms-unreadable', `the allowed axioms cannot be derived at ${head}: ${result.problems.join('; ')}`);
  const file = allowedAxiomsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, result.bytes);
  return { code: 'written', message: `${result.axioms.length} allowed axiom(s) for ${result.crates.length} crate(s) written for ${head}${result.withheld.length > 0 ? `; ${result.withheld.length} withheld` : ''}`,
    file, commit: head, sha256: result.sha256, names: result.axioms.length, crates: result.crates.length, withheld: result.withheld };
}

function extractionErrors(extraction) {
  const errors = [];
  if (!fields(errors, extraction, 'extraction', [...EXTRACTION_FIELDS, 'run', 'scope'])) return errors;
  if ('run' in extraction && !recordedRunValid(extraction.run)) {
    // A run that reads as a run but disagrees with its roster or stitch says where.
    const why = runValid(extraction.run) ? unitsProblem(extraction.run) : null;
    errors.push(`extraction.run must be the re-validated extraction attempt${why ? ` (${why})` : ''}`);
  }
  const missing = EXTRACTION_FIELDS.filter((key) => !(key in extraction));
  if (missing.length > 0) return [`extraction lacks ${missing.join(', ')}`];
  const { status, reasons, selected, declared, checks, inputs } = extraction;
  if (!['succeeded', 'failed'].includes(status)) errors.push('extraction.status must be succeeded or failed');
  if (!isText(extraction.recordedAt) || !isText(extraction.note)) errors.push('extraction.recordedAt and extraction.note must be strings');
  if (!Array.isArray(reasons) || !reasons.every(isText)) errors.push('extraction.reasons must be an array of strings');
  if (!plainObject(selected) || !isText(selected.revision) || !isText(selected.configuration)) {
    errors.push('extraction.selected must hold the revision and configuration the record answers');
  }
  if (!plainObject(declared) || !Number.isInteger(declared.buildExitCode) || !ORACLE_VERDICTS.includes(declared.oracle)
    || !(declared.oracleReason === undefined || isText(declared.oracleReason))) {
    errors.push(`extraction.declared must hold an integer buildExitCode and an oracle verdict (${ORACLE_VERDICTS.join(', ')})`);
  }
  if (!plainObject(checks) || !REQUIRED_CHECKS.every((name) => plainObject(checks[name]) && typeof checks[name].ok === 'boolean')) {
    errors.push(`extraction.checks must hold the ${REQUIRED_CHECKS.join(', ')} results`);
  }
  if (!(inputs === null || inputsValid(inputs))) errors.push('extraction.inputs must be null or the recorded extraction inputs');
  if (errors.length > 0 || !Array.isArray(reasons)) return errors;
  if (status === 'failed' && reasons.length === 0) errors.push('a failed extraction must record its reasons');
  if (status === 'succeeded') {
    const contradictions = [
      reasons.length > 0 && 'it records failure reasons',
      declared.buildExitCode !== 0 && `its build exited ${declared.buildExitCode}`,
      declared.oracle !== 'complete' && `the shared success oracle reported ${declared.oracle}`,
      REQUIRED_CHECKS.some((name) => !checks[name].ok) && 'a required patch engine check refused',
      inputs === null && 'it has no extraction inputs',
      inputs !== null && inputs.mode !== 'translation-patches' && `its copy was prepared in ${inputs.mode} mode`,
      inputs !== null && inputs.sourceCommit === null && 'it has no source commit',
    ].filter(Boolean);
    if (contradictions.length > 0) errors.push(`extraction is recorded as succeeded although ${contradictions.join(', ')}`);
    // A record with no scope, or an unknown one, is a valid record that the phase machine does not move past; a scope
    // that is there must agree with the run.
    const unsettled = scopeUnsettled(extraction) === null ? scopeProblem(extraction.scope, extraction.run) : null;
    if (unsettled !== null) errors.push(`extraction.scope: ${unsettled}`);
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
function loadRecord(file, code, validate, rerun, recovery = () => null) {
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
  if (errors.length > 0) refuse(code, `${file} is malformed: ${errors.join('; ')}`, { file, errors, nextStep: recovery(errors, file) ?? nextStep });
  RECORD_TEXT.set(value, text);
  return value;
}

// A state whose only fault is its extraction record can be put right by extracting again, which replaces
// that record and nothing else: the owner is not left with a state that only a hand edit can open.
const extractionOnly = (errors) => errors.every((text) => text.startsWith('extraction'));
const extractionRecovery = (errors, file) => (extractionOnly(errors)
  ? `To record the extraction again in place of the one that cannot be read, rerun /fvs:auto-extract; nothing else in ${file} is touched. Otherwise fix ${file} by hand or move it aside, then rerun /fvs:auto-init.` : null);

// The exact text each loaded record was parsed from, so a writer can tell
// whether the file changed after it read it.
const RECORD_TEXT = new WeakMap();

const loadState = (root) => loadRecord(statePath(root), 'malformed-state', stateErrors, '/fvs:auto-init', extractionRecovery);
const loadExternals = (root) => loadRecord(externalsPath(root), 'malformed-externals', externalsFileErrors, '/fvs:auto-extract');
const specsPath = (root) => path.join(root, STATE_DIR, 'specs.json');
const loadSpecs = (root) => loadRecord(specsPath(root), 'malformed-specs', specsFileErrors, 'the spec-phase command');
const overridesPath = (root) => path.join(root, STATE_DIR, 'overrides.json');
const loadOverrides = (root) => loadRecord(overridesPath(root), 'malformed-overrides', overridesFileErrors, 'record-override');

// Run overrides: decisions made after the agreement (a changed PR base, an
// exception that no longer holds) that the agreement still names the old way.
// The file is append-only; the last row for a key is the one in force.
const OVERRIDE_KEY = /^[a-z0-9][a-z0-9-]*$/;
const OVERRIDES_NOTE = 'Run overrides were recorded after the agreement and take precedence over it for this run. They do not amend the agreement, which still names the earlier values.';

function overridesFileErrors(value) {
  if (!plainObject(value) || value.schema !== 'fvs/auto-overrides' || value.schemaVersion !== 1 || !Array.isArray(value.overrides)) {
    return ['schema must be fvs/auto-overrides version 1 with an overrides list'];
  }
  return value.overrides.flatMap((row, index) => (plainObject(row) && OVERRIDE_KEY.test(row.key) && isText(row.value) && isText(row.reason) && isText(row.recordedAt)
    ? [] : [`overrides[${index}] must have a key (lowercase words joined by hyphens), a value, a reason and a time`]));
}

const currentOverrides = (overrides) => Object.fromEntries((overrides?.overrides ?? []).map(({ key, value, reason, recordedAt }) => [key, { value, reason, recordedAt }]));

export function recordOverride({ projectRoot, key, value, reason }) {
  if (!OVERRIDE_KEY.test(key ?? '')) refuse('usage', '--key must be lowercase words joined by hyphens, for example pr-base');
  if (!isText(value)) refuse('usage', '--value must be text');
  if (!isText(reason)) refuse('usage', '--reason must say why the run differs from the agreement');
  const root = projectDirectory(projectRoot);
  requireState(root);
  const base = loadOverrides(root);
  const row = { key, value: value.trim(), reason: reason.trim(), recordedAt: now() };
  if (currentOverrides(base)[key]?.value === row.value) {
    return { code: 'unchanged', message: `the override ${key} already holds this value; nothing was written`, overrides: currentOverrides(base) };
  }
  const next = { ...(base ?? { schema: 'fvs/auto-overrides', schemaVersion: 1 }), overrides: [...(base?.overrides ?? []), row] };
  commitState(root, base, next, overridesPath(root));
  return { code: 'recorded', message: `run override recorded: ${key} = ${row.value}. ${OVERRIDES_NOTE}`, row, overrides: currentOverrides(next) };
}

// One row per review round of a spec file; the last row for a file is its
// current verdict, earlier rows are history. Labels come from the verdict.
const SPEC_VERDICTS = {
  pass: () => 'spec reviewed: pass',
  changes: (round) => `spec reviewed: changes requested (round ${round})`,
  blocked: (round) => `spec blocked after ${round} round${round === 1 ? '' : 's'}`,
};
const HEX64 = /^[0-9a-f]{64}$/;

function specsFileErrors(value) {
  if (!plainObject(value) || value.schema !== 'fvs/auto-specs' || value.schemaVersion !== 1 || !Array.isArray(value.specs)
    || !(value.prs === undefined || Array.isArray(value.prs))) {
    return ['schema must be fvs/auto-specs version 1 with a specs list and an optional prs list'];
  }
  const prErrors = (value.prs ?? []).flatMap((pr, index) => {
    const text = (field) => typeof pr[field] === 'string' && pr[field].length > 0;
    const changes = pr?.ownerChanges === undefined || (Array.isArray(pr.ownerChanges)
      && pr.ownerChanges.every((entry) => plainObject(entry) && typeof entry.specFile === 'string' && Object.hasOwn(OWNER_CHANGES, entry.change)));
    const ok = plainObject(pr) && PR_KINDS.includes(pr.kind) && changes
      && (pr.merged === true ? text('mergeCommit') : text('url') && text('branch') && text('head'));
    return ok ? [] : [`prs[${index}] must be a ${PR_KINDS.join(' or ')} PR with url, branch and head, or a merge with its merge commit (and owner changes ${Object.keys(OWNER_CHANGES).join(' or ')})`];
  });
  return [...prErrors, ...value.specs.flatMap((row, index) => {
    const ids = (list) => Array.isArray(list) && list.every((id) => typeof id === 'string' && id.length > 0);
    const ok = plainObject(row) && typeof row.specFile === 'string' && typeof row.review === 'string'
      && ids(row.items) && row.items.length > 0 && ids(row.outOfScope) && Number.isInteger(row.round) && row.round >= 1
      && Object.hasOwn(SPEC_VERDICTS, row.verdict) && HEX64.test(row.specSha256) && HEX64.test(row.reviewSha256)
      && (row.commit === undefined || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(row.commit));
    return ok ? [] : [`specs[${index}] must name a spec file, items, a round, a verdict (${Object.keys(SPEC_VERDICTS).join(', ')}) and both hashes`];
  })];
}
const PR_KINDS = ['spec', 'proof'];
// What the owner did to a reviewed spec file before merging the spec PR.
const OWNER_CHANGES = { pruned: 'pruned by owner', 'owner-changed': 'changed by owner in review' };
const currentSpecRows = (specs) => [...new Map((specs?.specs ?? []).map((row) => [row.specFile, row])).values()];
const lastPr = (specs, kind) => (specs?.prs ?? []).filter((pr) => pr.kind === kind).at(-1);
// One record has one digest: the digest of its canonical JSON (keys in order), the same one the build
// check computes when it writes a receipt (fvs-build-check.mjs, recordDigest).
const recordDigest = (record) => crypto.createHash('sha256').update(canonicalJson(record ?? null)).digest('hex');
// The version of the receipt the build check writes (fvs-build-check.mjs, `schema`). Version 2 is the
// first whose acceptance rests on the Lean-level comparison of the statements with the merged spec; an
// older receipt is read as older and never counted, so it takes a new check to be accepted again.
const BUILD_CHECK_RECEIPT_SCHEMA = 2;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// The Lean-level comparison an acceptance must carry: the toolchain it ran on, the declarations compared,
// the new Trusted axioms it bound to their records, and the digests of both dumps.
const hasLeanComparison = (semantic) => semantic !== null && typeof semantic === 'object'
  && semantic.toolchain !== null && typeof semantic.toolchain === 'object'
  && Array.isArray(semantic.statements) && semantic.statements.length > 0 && Array.isArray(semantic.bindings)
  && ['base', 'head'].every((side) => SHA256_HEX.test(semantic.dumps?.[side] ?? ''));
// The Lean checks the recorded extraction holds for the files it stitched (extraction.run, one row per crate, or
// the single crate's own row), each as the build check lists them in a receipt (fvs-build-check.mjs, stitchPlan).
const recordedLeanChecks = (root) => {
  const run = loadState(root)?.extraction?.run;
  const rows = Array.isArray(run?.units) ? run.units : run !== null && typeof run === 'object' ? [run] : [];
  return rows.flatMap((unit) => (Array.isArray(unit?.leanChecks) ? unit.leanChecks : []).map((check) => ({ ...check, unit: typeof unit.crate === 'string' ? unit.crate : '(unnamed)' })));
};
// A check is the same one when the unit, the file, the module Lake maps it to, the number of items and both digests agree.
const leanCheckKeys = (checks) => checks.map((check) => JSON.stringify([check.unit, check.relativePath, check.module ?? null, check.items ?? null, check.fileSha256, check.blockSha256])).sort();
// Why a receipt's record of the stitch checks is not the recorded extraction's, or null. The extraction records a
// Lean check block and the digest of the file it ends, and an acceptance is the build check holding the commit to
// exactly those; a receipt made before the stitch checks, or for other checks than the ones now recorded, is not one.
function stitchStale(root, checked) {
  const recorded = leanCheckKeys(recordedLeanChecks(root));
  const entries = Array.isArray(checked?.entries) ? checked.entries : null;
  if (recorded.length === 0 && (entries?.length ?? 0) === 0) return null;
  if (entries === null) return 'the recorded extraction holds Lean checks for stitched files, but the receipt carries no record of them (an older build check wrote it)';
  if (leanCheckKeys(entries).join('\n') !== recorded.join('\n')) return 'the Lean checks that the recorded extraction holds for its stitched files are not the ones the build check was made with';
  if (entries.length > 0 && checked.builtChecked !== true) return 'its stitch checks did not include the check that Lake compiled each stitched file';
  return null;
}
// Why an accepting receipt no longer holds, or null. A receipt of another version, or without the
// Lean-level comparison, does not count. The receipt lists the externals records its
// acceptance relied on, each with a digest; a record that changed, is gone, or cannot be read now means
// the authority the check used is not the one on record, so the check has to run again.
function staleReason(root, receipt) {
  if (receipt.schema !== BUILD_CHECK_RECEIPT_SCHEMA) return `it is a version ${receipt.schema ?? 'unknown'} receipt, made before the build check compared the statements with the merged spec in Lean (this engine reads version ${BUILD_CHECK_RECEIPT_SCHEMA})`;
  if (!hasLeanComparison(receipt.integrity?.semantic)) return 'it carries no Lean-level comparison of the statements with the merged spec (integrity.semantic)';
  const bound = receipt.externals;
  if (!bound || !Array.isArray(bound.records)) return 'it does not list the externals records it relied on (an older build check wrote it)';
  // Every axiom the Lean-level check bound to a record needs that record's digest in the list, so a record
  // revoked after the check is seen; a binding with no digest rests on an authority nothing can re-check.
  const listed = new Set(bound.records.map((entry) => entry?.id));
  const unlisted = receipt.integrity.semantic.bindings.find((binding) => !listed.has(binding?.record));
  if (unlisted) return `the Lean-level check bound the axiom ${unlisted.axiom} to the externals record ${unlisted.record}, but the receipt carries no digest of that record`;
  const changed = stitchStale(root, receipt.integrity.stitchChecks);
  if (changed !== null) return changed;
  if (bound.records.length === 0) return null;
  let records;
  try { records = JSON.parse(fs.readFileSync(path.join(root, '.formalising', 'auto-fv', 'externals.json'), 'utf8')).records; } catch { return 'the externals records it relied on cannot be read now'; }
  for (const entry of bound.records) {
    const now = Array.isArray(records) ? records.find((record) => record?.id === entry?.id) : undefined;
    if (!now) return `the externals record ${entry?.id} it relied on is no longer recorded`;
    if (recordDigest(now) !== entry.sha256) return `the externals record ${entry.id} it relied on changed after the check`;
  }
  return null;
}
// The build check's receipt for a full commit SHA, or null when it is missing,
// unreadable or for another commit. Only the receipt decides acceptance. An accepting receipt whose
// externals records no longer hold comes back not accepting, with the reason in `stale`.
export function buildCheckReceipt(root, head) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head ?? '')) return null;
  try {
    const receipt = JSON.parse(fs.readFileSync(path.join(root, '.formalising', 'auto-fv', 'build-check', `${head}.json`), 'utf8'));
    if (!(receipt?.kind === 'fvs-build-check' && receipt.commit === head && typeof receipt.accepted === 'boolean' && typeof receipt.label === 'string')) return null;
    const stale = receipt.accepted ? staleReason(root, receipt) : null;
    return stale === null ? receipt : { ...receipt, accepted: false, stale };
  } catch {
    return null;
  }
}
// The owner's change per spec file at the last spec merge; a later review round clears it.
function ownerChangesOf(specs) {
  const merge = (specs?.prs ?? []).filter((pr) => pr.kind === 'spec' && pr.merged).at(-1);
  const rows = new Map(currentSpecRows(specs).map((row) => [row.specFile, row]));
  return new Map((merge?.ownerChanges ?? []).filter((entry) => rows.get(entry.specFile)?.recordedAt <= merge.recordedAt)
    .map((entry) => [entry.specFile, entry.change]));
}

function requireState(root) {
  const state = loadState(root);
  if (!state) refuse('no-state', `no auto-track state in ${statePath(root)}`, { nextStep: 'Run /fvs:auto-init first.' });
  return state;
}

// The state for recording an extraction: the same, except that an extraction record which no longer
// reads is dropped from the copy in memory, because this write replaces it. Any other fault still refuses.
function requireStateToExtract(root) {
  try {
    return requireState(root);
  } catch (error) {
    const errors = error instanceof Refusal && error.code === 'malformed-state' ? error.details?.errors : null;
    if (!Array.isArray(errors) || !extractionOnly(errors)) throw error;
    const text = fs.readFileSync(statePath(root), 'utf8');
    const state = { ...JSON.parse(text), extraction: null };
    if (stateErrors(state).length > 0) throw error;
    RECORD_TEXT.set(state, text);
    return state;
  }
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

// Every state write goes through here. An exclusive lock file serializes the
// writers; under it, a writer whose state file changed since it read `base`
// (null: no state yet) refuses instead of replacing newer owner choices,
// agreements, extraction or memory records with its older copy.
// ponytail: a killed writer leaves the lock behind and the next write refuses
// naming it; recover it automatically (holder pid liveness) if that ever matters.
function commitState(root, base, value, file = statePath(root)) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    refuse('state-locked', `another FVS command is writing ${file}; nothing was written`, { file: lock,
      nextStep: `Rerun once it has finished. If no FVS command is running, an interrupted one left ${lock} behind: delete that file, then rerun.` });
  }
  try {
    fs.writeSync(fd, `${process.pid}\n`);
    let current = null;
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current !== (base === null ? null : RECORD_TEXT.get(base))) {
      refuse('state-changed', `${file} changed after this command read it; nothing was written`, { file,
        nextStep: 'Rerun the command so it starts from the current state.' });
    }
    writeAtomic(file, value);
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
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

// Verdicts that stop auto-init. Probes are optional, so neither the probe item
// nor the host it was tested on ever stops it. A provenance conflict is a warning:
// the extraction stops only when its recorded build fails.
const blocks = (entry) => !['host', 'probe'].includes(entry.id)
  && ['incompatible', 'unsupported-platform', 'missing'].includes(entry.verdict);

// What stops setup for a recorded state. A missing Aeneas stops a first setup, but
// not once an extraction has succeeded: only a new extraction needs Aeneas, and it
// refuses there, naming the tool, so setup warns instead.
const stops = (entry, state) => blocks(entry)
  && !(entry.id === 'aeneas' && entry.verdict === 'missing' && state?.extraction?.status === 'succeeded');

export function initState({ projectRoot, choices, confirmOverwrite = false, platform = hostTarget(), schemaVersion }) {
  const root = projectDirectory(projectRoot);
  const recorded = loadState(root);
  schemaVersion ??= recorded?.schemaVersion ?? (Object.hasOwn(choices?.limits ?? {}, 'wallClockHours') || Object.hasOwn(choices?.limits ?? {}, 'nodeHours') ? 1 : 2);
  if (![1, 2].includes(schemaVersion)) refuse('invalid-input', 'unsupported setup version');
  if (recorded && recorded.schemaVersion !== schemaVersion) refuse('migration-required', 'existing setup version is preserved; no in-place migration');
  const requested = normalizeChoices(choices, schemaVersion);
  const result = profile({ projectRoot: root, platform });
  const warned = result.items.filter((entry) => blocks(entry) && !stops(entry, recorded));
  const warning = warned.length === 0 ? '' : `; warning: ${warned.map((entry) => `${entry.id} is ${entry.verdict}`).join(', ')}, so a new extraction stops until it is fixed. ${warned.map((entry) => entry.nextStep).join(' ')}`;
  const refuseBlocked = () => {
    const blocking = result.items.filter((entry) => stops(entry, recorded)).map(({ id, verdict, reason, nextStep }) => ({ id, verdict, reason, nextStep }));
    if (blocking.length > 0) {
      const nested = result.items.find((entry) => entry.id === 'lean')?.evidence.nestedProject;
      const where = nested ? `; the Lean project is in ${nested}/, so rerun with the project root at ${nested}/` : '';
      refuse('profile-blocked', `the compatibility profile stops auto-init: ${blocking.map((entry) => `${entry.id} is ${entry.verdict}`).join(', ')}${where}${recorded ? '; the recorded profile now holds these facts, and the recorded choices are unchanged' : ''}`,
        { blocking, nextStep: blocking.map((entry) => entry.nextStep).join(' ') });
    }
  };
  if (recorded) {
    const changes = choiceChanges(recorded.choices, requested);
    const profileChanged = canonicalJson(result) !== canonicalJson(recorded.profile);
    // New host facts (a tool installed or removed) are saved even when they stop
    // setup, so readiness and the next action never rest on tools the host no
    // longer has. Only the profile is replaced: choices, generation, agreements
    // and extraction stay, and requested choice changes are not saved here.
    if (profileChanged && (changes.length === 0 || result.items.some((entry) => stops(entry, recorded)))) {
      commitState(root, recorded, { ...recorded, profiledAt: now(), profile: result });
    }
    refuseBlocked();
    if (changes.length === 0) {
      return profileChanged
        ? { ...readState({ projectRoot: root }), code: 'profile-refreshed', message: `the recorded profile was refreshed in ${statePath(root)}; the choices are unchanged${warning}` }
        : { ...readState({ projectRoot: root }), code: 'unchanged', message: `the recorded setup state already holds these choices and this profile; nothing was written${warning}` };
    }
    if (!confirmOverwrite) {
      refuse('confirmation-required', `the requested choices change recorded owner choices: ${changes.map((change) => change.field).join(', ')}`,
        { changes, nextStep: 'Show each change to the owner and rerun with --confirm-overwrite only after they confirm it.' });
    }
  }
  refuseBlocked();
  const state = {
    schema: 'fvs/auto-state',
    schemaVersion,
    profiledAt: now(),
    profile: result,
    choices: requested,
    roadmap: recorded?.roadmap ?? null,
    extraction: recorded?.extraction ?? null,
    ...(recorded?.memoryBindings ? { memoryBindings: recorded.memoryBindings } : {}),
    ...('choicesGeneration' in (recorded ?? {}) ? {
      choicesGeneration: recorded.choicesGeneration + 1,
      agreements: recorded.agreements,
    } : {}),
  };
  if ('choicesGeneration' in state && !generationValid(state.choicesGeneration)) refuse('generation-exhausted', 'choices generation cannot advance safely; no state was written');
  commitState(root, recorded, state);
  // The refreshed view, so the caller sees the pending decisions of the state just written.
  return { ...readState({ projectRoot: root }), code: recorded ? 'updated' : 'created', message: `setup state written to ${statePath(root)}${warning}` };
}

// How a worker pushes a proof branch: with the FVS push command, which pushes one branch to the
// destination recorded at init, never with git push.
const PUSH_STEP = 'push with the FVS push command (`node <FVS scripts folder>/fvs-auto-push.mjs --branch fvs/<name>`, never git push)';

// The phase, the next action and its warnings, derived together so they never
// disagree. After a successful extraction the next step is the spec phase: the
// orchestrator spawns stock AO workers and runs the engine steps itself, so no
// execution grant, stage profile or permission install is asked for. A missing
// or outdated agreement and a reduced or unverified stage are warnings only.
function progress(root, state, specs = null) {
  const blocking = state.profile.items.filter((entry) => stops(entry, state));
  if (blocking.length > 0) {
    return { phase: 'setup', warnings: [], nextAction: `Setup is blocked: ${blocking.map((entry) => `${entry.id} is ${entry.verdict}`).join(', ')}. ${blocking.map((entry) => entry.nextStep).join(' ')} Then rerun /fvs:auto-init.` };
  }
  const { selected } = state.extraction ?? {};
  if (selected && choiceChanges(selected, state.choices.source).length > 0) {
    return { phase: 'extract', warnings: [], nextAction: `Rerun /fvs:auto-extract: the recorded extraction is for revision ${selected.revision} (${selected.configuration}), not the selected source.` };
  }
  if (state.extraction?.status !== 'succeeded') {
    return { phase: 'extract', warnings: [], nextAction: state.extraction ? 'Rerun /fvs:auto-extract after fixing the recorded failure reasons.' : 'Run /fvs:auto-extract to extract the selected revision.' };
  }
  const unsettled = scopeUnsettled(state.extraction);
  if (unsettled !== null) return { phase: 'extract', warnings: [], nextAction: `Rerun /fvs:auto-extract: ${unsettled}.` };
  // A recorded spec PR merge starts the proof phase.
  const specMerge = (specs?.prs ?? []).filter((pr) => pr.kind === 'spec' && pr.merged).at(-1);
  const stageName = specMerge ? 'auto-execute' : 'auto-top-specs';
  // Recomputed from the recorded profile, never read from a stored field.
  const stage = readiness(state.profile).find((entry) => entry.stage === stageName);
  if (stage.status === 'no-route') {
    return { phase: 'setup', warnings: [], nextAction: `/fvs:${stageName} cannot run here yet: it is ${stage.summary}. First, the ${stage.firstMissing.supplier} must ${stage.firstMissing.step}.` };
  }
  const warnings = ['ready-unverified', 'ready-reduced'].includes(stage.status) ? [stage.line] : [];
  const agreement = state.agreements?.at(-1);
  if (!agreement) {
    warnings.push('no agreement is recorded: the agent can draft one (scope, claims, trust, acceptance) for the owner to approve and record with record-agreement; the spec phase does not wait for it');
  } else if (agreement.payload.choicesGeneration !== (state.choicesGeneration ?? 0) || choiceChanges(agreement.payload.choices, state.choices).length > 0) {
    warnings.push('the recorded agreement covers earlier choices: a successor agreement is advised; the spec phase does not wait for it');
  }
  const specPr = lastPr(specs, 'spec');
  if (specMerge) {
    if (!specPr.merged) warnings.push(`the spec refactor PR ${specPr.url} is open: after the owner merges it, record the merge with record-pr --kind spec --merged --merge-commit SHA`);
    const suffix = warnings.map((warning) => ` Warning: ${warning}.`).join('');
    // Only proof PRs recorded after the latest spec merge prove its statements.
    const proofs = specs.prs.slice(specs.prs.lastIndexOf(specMerge) + 1).filter((pr) => pr.kind === 'proof');
    const proofPr = proofs.filter((pr) => !pr.merged).at(-1);
    const proofMerge = proofs.at(-1)?.merged ? proofs.at(-1) : null;
    if (!proofPr) {
      return { phase: 'proofs', warnings,
        nextAction: `The spec PR merge is recorded at ${specMerge.mergeCommit}. Run /fvs:auto-execute from the AO orchestrator for the proof phase: stock AO workers prove the merged statements, and the orchestrator opens one draft proof PR on the project's own repository and records it with record-pr --kind proof. No execution grant, stage profile or permission install is needed.` + stitchedWork(state.extraction.run) + suffix };
    }
    const receipt = buildCheckReceipt(root, proofPr.head);
    // An accepting receipt counts only when the statements were held to the recorded spec merge: a
    // receipt made with no spec base, or against another commit, proves nothing about them.
    const heldToSpec = receipt?.specBase === specMerge.mergeCommit;
    // With several crates the build check also gets the allowed axioms, which the engine writes for
    // the commit it checks; a project with one crate runs it without.
    const several = crateContextOf(state) !== null;
    const check = `node fvs-build-check.mjs --project-root ${root} --commit ${proofPr.head} --spec-base ${specMerge.mergeCommit}`
      + (several ? ` --allow-axioms ${allowedAxiomsPath(root)}` : '');
    const writeList = `node fvs-auto.mjs allowed-axioms --project-root ${root} --commit ${proofPr.head}`;
    const checkSteps = several ? `Write the allowed axioms: ${writeList}; then run the build check: ${check}` : `Run the build check on that commit: ${check}`;
    // With several crates the accepting receipt must also hold for every verified crate: one built
    // project says nothing about a crate with no statement or one that depends on a crate that is
    // not accepted, and it counts only when it was made with the allowed axioms of this commit. A
    // single-crate project has no crate context.
    const context = receipt?.accepted && heldToSpec ? crateContextOf(state) : null;
    const gate = context ? crateReceiptProblem(root, state, specs, context, receipt, proofPr.head) : null;
    if (gate) {
      return { phase: 'proofs', warnings,
        nextAction: gate.kind === 'underivable'
          ? `The build check accepted the draft proof PR ${proofPr.url} at ${proofPr.head}, but ${gate.text}. Fix what is named, ${PUSH_STEP}, record the new head with record-pr --kind proof, and rerun the build check on it.` + suffix
          : `The build check receipt for the draft proof PR ${proofPr.url} at ${proofPr.head} does not count: ${gate.text}. ${checkSteps}; read-state reports done when it accepts.` + suffix };
    }
    const rejected = context ? crateAcceptance(root, specs, context, receipt).filter((entry) => !entry.accepted) : [];
    if (receipt?.accepted && heldToSpec && rejected.length === 0) {
      // With several crates the build check refuses a native-decision axiom the merged spec did not rest
      // on, so a flag on its accepting receipt is a dependency the spec base already had. The owner's
      // review decides it: the flag is reported, not hidden in the receipt.
      const flagged = context && Array.isArray(receipt.flags) ? receipt.flags.filter(isText) : [];
      const flagWarning = flagged.length > 0 ? [`the build check flags ${flagged.join('; ')}: a native-decision axiom the merged spec already rested on, which the owner's review decides`] : [];
      return { phase: 'done', warnings: [...warnings, ...flagWarning],
        nextAction: `The build check accepted the draft proof PR ${proofPr.url} at ${proofPr.head}: ${receipt.label}. `
          + (proofMerge ? `The proof PR merge is recorded at ${proofMerge.mergeCommit}.` : 'The owner reviews and merges it; then record the merge with record-pr --kind proof --merged --merge-commit SHA.') + suffix
          + flagWarning.map((warning) => ` Warning: ${warning}.`).join('') };
    }
    if (rejected.length > 0) {
      return { phase: 'proofs', warnings,
        nextAction: `The build check accepted the draft proof PR ${proofPr.url} at ${proofPr.head}, but not every verified crate is accepted: ${rejected.map((entry) => `crate ${entry.crate ?? '(none)'}: ${entry.reason}`).join('; ')}. Fix what is named, ${PUSH_STEP}, record the new head with record-pr --kind proof, and rerun the build check on it.` + suffix };
    }
    return { phase: 'proofs', warnings,
      nextAction: (receipt?.stale
        ? `The build check receipt for the draft proof PR ${proofPr.url} at ${proofPr.head} does not count: ${receipt.stale}. ${several ? checkSteps : `Run the build check again: ${check}`}; read-state reports done when it accepts.`
        : receipt?.accepted
        ? `The build check receipt for the draft proof PR ${proofPr.url} at ${proofPr.head} does not count: it was made ${typeof receipt.specBase === 'string' ? `against the spec base ${receipt.specBase}` : 'without a spec base'}, not against the recorded spec merge ${specMerge.mergeCommit}. ${several ? checkSteps : `Run the build check again: ${check}`}; read-state reports done when it accepts.`
        : receipt
          ? `The build check failed for the draft proof PR ${proofPr.url} at ${proofPr.head}: ${receipt.label}. Fix the proofs, ${PUSH_STEP}, record the new head with record-pr --kind proof, and rerun the build check on it.`
          : `The draft proof PR ${proofPr.url} is recorded at ${proofPr.head}. ${checkSteps}; read-state reports done when it accepts.`) + suffix };
  }
  return { phase: 'specs', warnings,
    nextAction: (specPr
      ? `The draft spec PR ${specPr.url} is recorded: the owner reviews and merges it. After the merge, read the merge commit with gh pr view and record it with record-pr --kind spec --merged --merge-commit SHA. A spec refactor is another review round recorded with record-spec, then another record-pr.`
      : 'Run /fvs:auto-top-specs from the AO orchestrator for the spec phase: the orchestrator lists the public API items in scope, spawns stock AO workers to write the statements and review them adversarially, and opens one draft spec PR on the project\'s own repository for the owner to merge. No execution grant, stage profile or permission install is needed.')
      + stitchedWork(state.extraction.run) + warnings.map((warning) => ` Warning: ${warning}.`).join('') };
}

// What `read-state --brief` keeps: where the run is and what to do next, a few
// lines instead of the recorded probe profile and every readiness row.
const BRIEF_FIELDS = ['code', 'message', 'phase', 'nextAction', 'warnings', 'pendingDecisions', 'externals', 'crates', 'overrides', 'overridesNote', 'fvs'];

export function readState({ projectRoot, requireAgreement = false, brief = false }) {
  if (brief && requireAgreement) refuse('usage', '--brief cannot be combined with --require-agreement: that check returns the whole agreement');
  // Workers search global paths and find older installs; the orchestrator puts this one in every brief.
  const full = { ...readFullState({ projectRoot, requireAgreement }), fvs: installedFvs() };
  return brief ? { brief: true, ...Object.fromEntries(BRIEF_FIELDS.filter((key) => Object.hasOwn(full, key)).map((key) => [key, full[key]])) } : full;
}

function readFullState({ projectRoot, requireAgreement }) {
  const root = projectDirectory(projectRoot);
  const state = loadState(root);
  if (!state) {
    if (requireAgreement) refuse('agreement-required', 'no recorded setup or initial agreement; run /fvs:auto-init');
    return { code: 'no-state', message: `no auto-track state in ${statePath(root)}`, phase: 'setup', warnings: [], nextAction: 'Run /fvs:auto-init to record the setup state.', pendingDecisions: [] };
  }
  const records = loadExternals(root)?.records ?? [];
  const externals = Object.fromEntries([['total', records.length],
    ...BOUNDARY_STATUSES.map((status) => [status, records.filter((record) => record.status === status).length])]);
  const overrides = currentOverrides(loadOverrides(root));
  // Only a succeeded extraction with several crates, a declared non-target or a crate decision has a crate view.
  const context = crateContextOf(state);
  const specs = loadSpecs(root);
  const next = progress(root, state, specs);
  return {
    code: 'ok',
    message: `auto-track state in ${statePath(root)}`,
    state,
    roadmapPresent: state.roadmap?.path ? fs.existsSync(path.join(root, state.roadmap.path)) : false,
    externals,
    ...(context ? { crates: crateReport(context, proofAcceptance(root, state, specs, context)) } : {}),
    ...(Object.keys(overrides).length > 0 ? { overrides, overridesNote: OVERRIDES_NOTE } : {}),
    pendingDecisions: [...(requireAgreement || state.roadmap ? [] : ['roadmap']), ...(context ? crateDecisions(context) : [])],
    readiness: readiness(state.profile),
    ...next,
    ...(context ? { warnings: [...next.warnings, ...crateWarnings(context)] } : {}),
    ...(requireAgreement ? { agreement: requireStoredAgreement(root, state) } : {}),
  };
}

function memoryOperation(fn) {
  const failure = error => {
    if (error instanceof Refusal) throw error;
    refuse(error instanceof MemoryError || error instanceof ResumeError || error instanceof TransitionError || error instanceof ExecutionError ? error.code : 'memory-unverified', error.message, error.details ?? {});
  };
  try { const result = fn(); return result instanceof Promise ? result.catch(failure) : result; }
  catch (error) { return failure(error); }
}
function memoryCanonical(root) {
  const view = readState({ projectRoot: root, requireAgreement: true });
  return { view, envelope: agreementEnvelope(view.agreement.agreement) };
}
export function recordMemory(options) {
  return memoryOperation(() => {
    const { projectRoot, registration, confirmOverwrite = false } = memoryDataSnapshot(options);
    const root = projectDirectory(projectRoot), state = memoryCanonical(root).view.state;
    const observed = inspectMemoryRegistration({ projectRoot: root, registration });
    if (memoryJson(requireState(root)) !== memoryJson(state)) refuse('state-changed', 'canonical state changed during store inspection; registration not written');
    const previous = state.memoryBindings?.at(-1);
    if (previous && memoryJson(bindingIdentity(previous)) === memoryJson(bindingIdentity(observed.binding))) {
      return { code: 'unchanged', message: 'the existing memory registration already matches; no state written', state, inspection: observed.out };
    }
    if (previous && !confirmOverwrite) refuse('confirmation-required', 'memory registration changes the recorded project/store/tool identity', {
      nextStep: 'Confirm the actual replacement before --confirm-overwrite; old bindings are retained.', inspection: observed.out,
    });
    const bindingRevision = previous ? previous.bindingRevision + 1 : 0;
    if (!Number.isSafeInteger(bindingRevision)) refuse('generation-exhausted', 'memory binding revision cannot advance safely');
    state.memoryBindings ??= [];
    state.memoryBindings.push({ ...observed.binding, bindingRevision, recordedAt: now() });
    commitState(root, state, state);
    return { code: 'recorded', message: 'existing primary project memory registered; no store created or workers launched', state, inspection: observed.out };
  });
}
export function prepareMemoryRequest(options) {
  return memoryOperation(() => {
    const { projectRoot, attemptId, operation, phase, target } = memoryDataSnapshot(options);
    const root = projectDirectory(projectRoot);
    return prepareMemoryBootstrapRequest({ loadCanonical: () => memoryCanonical(root), attemptId, operation, phase, target });
  });
}
function memoryBootstrap(options, operation) {
  return memoryOperation(() => {
    options = memoryOwnData(options, 'memory operation');
    options.request = memoryDataSnapshot(options.request);
    const errors = [];
    if (!fields(errors, options, 'memory operation', ['projectRoot', 'request', 'requestBytes', 'out', 'callerRoot']) || errors.length) refuse('invalid-input', errors.join('; '));
    if (!isText(options.out)) refuse('usage', 'an exclusive --out directory is required');
    const root = projectDirectory(options.projectRoot);
    return runMemoryBootstrap({ ...options, projectRoot: root, callerRoot: options.callerRoot ?? process.cwd(), operation,
      loadCanonical: () => memoryCanonical(root), validateEnvelope: agreementErrors });
  });
}
export const primeMemory = (options) => memoryBootstrap(options, 'worker-readonly');
export const refreshMemory = (options) => memoryBootstrap(options, 'coordinator-refresh');
export function verifyMemoryBootstrap(options) {
  return memoryOperation(() => {
    const { projectRoot, request, out, callerRoot = process.cwd() } = memoryDataSnapshot(options);
    const root = projectDirectory(projectRoot);
    return consumeMemoryBootstrap({ request, out, callerRoot, loadCanonical: () => memoryCanonical(root) });
  });
}

function resumeOperation(operation, options) {
  try {
    options = JSON.parse(JSON.stringify(memoryDataSnapshot(options)));
    // The adapter takes descriptor-validated caller data. These services are
    // coordinator code, never callbacks/role attestations from a JSON request.
    const root = projectDirectory(options.projectRoot);
    const boundTool = (name) => { const file = fs.realpathSync(fileURLToPath(new URL(name, import.meta.url))); return { file, sha256: sha256(transitionBytes(file)) }; };
    const offlineGit = (cwd, args, buffer = false, status = false) => {
      const p = spawnSync('/usr/bin/git', ['-C', cwd, ...args], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
      if (p.error || p.signal || (!status && p.status !== 0)) refuse('transition-git-unverified', 'bounded offline Git observation failed');
      return status ? p.status : buffer ? p.stdout : p.stdout.toString('utf8');
    };
    const services = { loadCanonical: () => memoryCanonical(root), refreshMemory, verifyMemory: verifyMemoryBootstrap, inspectAcceptance: inspectAutoAcceptance,
      transitions: transitionValidators({ tools: { auto: boundTool('fvs-auto.mjs'), registry: boundTool('fvs-contract-registry.mjs'), ao: options.request.ao.tool }, git: offlineGit }) };
    return operation === 'verify' ? consumeResume(options, services) : operation === 'verify-transition' ? consumeTransition(options, services) : runResume(operation, options, services);
  } catch (e) {
    if (e instanceof Refusal) throw e;
    refuse(e.code ?? 'resume-unverified', e.message, e.details ?? {});
  }
}
export const checkpointState = (options) => resumeOperation('checkpoint', options);
export const reconcileState = (options) => resumeOperation('state', options);
export const verifyReconciliation = (options) => resumeOperation('verify', options);
export const verifyTransition = (options) => resumeOperation('verify-transition', options);
const transitionTools = () => Object.fromEntries(['auto', 'registry'].map((key) => {
  const file = fs.realpathSync(fileURLToPath(new URL(key === 'auto' ? 'fvs-auto.mjs' : 'fvs-contract-registry.mjs', import.meta.url)));
  return [key, { file, sha256: sha256(transitionBytes(file)) }];
}));
export function executeTransition(options, executionServices = {}) {
  return memoryOperation(() => {
    const data = JSON.parse(JSON.stringify(memoryDataSnapshot(options)));
    if (Object.keys(data).length !== 5 || ['projectRoot', 'request', 'beforeOut', 'producerOut', 'evidenceDir'].some((k) => !Object.hasOwn(data, k))) refuse('transition-invalid-input', 'closed effect options required');
    const { projectRoot, request, beforeOut, producerOut, evidenceDir } = data, root = projectDirectory(projectRoot);
    const checked = verifyTransition({ projectRoot: root, request, out: beforeOut });
    if (checked.position !== 'before') refuse('transition-before-required', 'facts/after observations are not execution permission');
    const runtime = readRuntime(root), latest = runtime.state.history.at(-1);
    if (latest.event.position !== 'before' || latest.event.intent.request.sha256 !== checked.action.sha256) refuse('transition-before-required', 'no exact current pending before');
    return performTransition({ actionRef: checked.action, ao: request.ao.tool, tools: transitionTools(), producerOut, evidenceDir, beforeEventSha256: latest.sha256,
      committedHeadSha256: checked.committedHeadSha256, runtimeRoot: path.join(root, '.formalising/auto-fv/resume'), ...runExecutionFields(runtime.state.run), lastObservedAtMs: runtime.lastObservedAtMs }, { ...executionServices, head: () => readRuntime(root).headSha256 });
  });
}
export function nextTransition(options) {
  return memoryOperation(() => {
    const data = JSON.parse(JSON.stringify(memoryDataSnapshot(options)));
    if (Object.keys(data).length !== 3 || ['projectRoot', 'currentRequest', 'out'].some((k) => !Object.hasOwn(data, k))) refuse('transition-invalid-input', 'closed proposal options required');
    const { projectRoot, currentRequest, out } = data, root = projectDirectory(projectRoot);
    if (currentRequest.resume?.transition !== null) refuse('transition-invalid-input', 'next-transition cannot reserve or execute an action');
    const runtime=readRuntime(root);
    if(runtime.state?.run.schemaVersion===2){
      const c=JSON.parse(JSON.stringify(memoryDataSnapshot(currentRequest))),q=parseResumeRequest(Buffer.from(memoryJson(c.resume)));
      if(Object.keys(c).length!==4||['resume','registry','authorization','profile'].some(k=>!Object.hasOwn(c,k))||q.schemaVersion!==2||q.transition!==null||q.runId!==runtime.state.run.runId||q.expectedHeadSha256!==runtime.headSha256)refuse('resume-head-stale','proposal needs its own current request/head');
      const canonical=memoryCanonical(root);verifyTransitionAuthorization({kind:'construct',stage:'extraction',authorization:c.authorization,profile:c.profile},canonical);
      if(canonical.view.state.choicesGeneration!==runtime.state.run.choicesGeneration||canonical.view.agreement.contextSha256!==runtime.state.run.agreementContextSha256)refuse('resume-context-stale','progress scope agreement changed');
      const active=[...runtime.reservations.values()].filter(r=>r.state!=='closed'&&r.intent.effect.kind==='ao-launch').map(r=>({reservationId:r.id,sessionId:r.sessionId,nodes:r.intent.nodes,state:r.state}));
      if(active.length)return{status:'proposal',kind:'observe-existing',assignments:active,executable:false,proofCurrentness:'not inspected; scheduling facts only',next:'observe-progress with the issued packet and retained progress; actual stop/replacement still requires current transition checks'};
    }
    const reconciled = reconcileState({ projectRoot: root, request: currentRequest.resume, out });
    if (reconciled.code === 'partial') return { status: 'partial', reasons: reconciled.observation.reasons, executable: false };
    verifyReconciliation({ projectRoot: root, request: currentRequest.resume, out });
    return nextTransitionFacts({ currentRequest, reconciled, runtime: readRuntime(root), canonical: memoryCanonical(root) });
  });
}
export function verifyWorkerStartup(options) { return workerTransition('startup', options); }
export function acknowledgeWorkPacket(options) { return workerTransition('start', options); }
function workerTransition(operation, options) {
  return memoryOperation(() => {
    const data = JSON.parse(JSON.stringify(memoryDataSnapshot(options))), keys = ['projectRoot', 'ao', 'out', 'actor', 'expectedMemoryRequest', ...(operation === 'startup' ? ['actionRef', 'acknowledgement'] : ['memoryOut', 'packet', 'marker'])];
    if (Object.keys(data).length !== keys.length || keys.some((k) => !Object.hasOwn(data, k))) refuse('transition-invalid-input', 'closed actor options required');
    const { projectRoot, ao, out, actor, expectedMemoryRequest, memoryOut, ...rest } = data;
    if (!path.isAbsolute(out) || path.dirname(out) !== fs.realpathSync(path.dirname(out)) || out === projectDirectory(projectRoot) || out.startsWith(projectDirectory(projectRoot) + path.sep)) refuse('transition-invalid-input', 'canonical exclusive output outside the protected project required');
    fs.mkdirSync(out, { mode: 0o700 }); const requestInput = transitionSave(path.join(out, 'request.json'), data);
    // A v2 start validates the released context twice (before and after the marker commit); each
    // check owns a fresh exclusive output, so the second check is never refused by the first's directory.
    let contextChecks = 0;
    const root = projectDirectory(projectRoot), services = { memoryOut,
      currentClock() { const v = readRuntime(root), run = v.state?.run; if (!run) refuse('resume-context-stale', 'original run missing'); return { runId: run.runId, startedAtMs: run.startedAtMs, ...(run.schemaVersion === 2 ? { schemaVersion: 2, budget: run.budget } : { deadlineMs: run.deadlineMs }), lastObservedAtMs: v.lastObservedAtMs }; },
      beforeForAction(ref) {
        const r = readRuntime(root).state?.history.find((r) => r.event.position === 'before' && memoryJson(r.event.intent.request ?? null) === memoryJson(ref));
        if (!r) refuse('resume-pair-conflict', 'no exact retained launch-before event'); return r.sha256;
      },
      verifyMemory: (o) => verifyMemoryBootstrap({ ...o, projectRoot: root }),
      verifyReleasedPacket: (packet) => verifyReleasedPacketContext({ projectRoot: root, ao, packet, memoryRequest: expectedMemoryRequest, out: out + '-context-' + (++contextChecks) }, { loadCanonical: () => memoryCanonical(root), transitions: transitionValidators({ tools: { ...transitionTools(), ao: ao.tool }, git() { refuse('transition-unavailable', 'unexpected packet Git mutation'); } }) }),
      observeActor: (a) => observeAssignedActor({ projectRoot: root, ao, actor: a, attemptId: expectedMemoryRequest.attemptId, out: out + '-actor' }) };
    // Supplied role/profile data is controller provenance, not OS authentication.
    const result = operation === 'startup' ? verifyStartup({ ...rest, actor, expectedMemoryRequest }, services)
      : acknowledgeStart({ ...rest, actor, expectedMemoryRequest }, services);
    transitionSave(path.join(out, 'result.json'), { ...result, requestInput }); return result;
  });
}
// Candidate work permission is relational metadata, never proof acceptance.
export function verifyActiveTask(raw, {progressOnly=false}={}) {
  return memoryOperation(() => {
    raw=JSON.parse(JSON.stringify(memoryDataSnapshot(raw)));
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw.invocationId))refuse('owned-work-unsupported','fresh task observation identity required');
    const packetRef = raw.packet, markerRef = raw.marker, packet = readWorkPacket(packetRef), launch = readTransitionAction(packet.launch);
    if (packet.schemaVersion !== 2 || launch.stage !== 'proof' || !launch.nodes.length) refuse('owned-work-unsupported', 'owned command route requires an issued v2 proof task');
    const root = projectDirectory(launch.before.fixed.canonicalRoot), current = readRuntime(root), run = current.state?.run, reservation = current.reservations.get(packet.actor.reservationId);
    if (!run || run.schemaVersion !== 2 || run.runId !== packet.runId || !reservation || reservation.state !== 'active' || reservation.sessionId !== packet.actor.sessionId
      || reservation.intent.effect.assignmentId !== packet.actor.assignmentId || reservation.intent.stage !== launch.stage || !sameMemory(reservation.intent.nodes, launch.nodes) || !sameMemory(reservation.intent.request, packet.launch)) refuse('owned-work-unsupported', 'task has no current active assignment');
    const view = readState({ projectRoot: root, requireAgreement: true });
    if (view.state.choicesGeneration !== run.choicesGeneration || view.agreement.contextSha256 !== run.agreementContextSha256) refuse('resume-context-stale', 'task agreement changed');
    const marker = transitionBound(markerRef);
    if (markerRef.file !== packet.startMarker || marker.schema !== 'fvs/auto-execution-start' || marker.schemaVersion !== 2 || !sameMemory(marker.packet, packetRef) || !sameMemory(marker.actor, packet.actor)) refuse('owned-work-unsupported', 'task has no exact start marker');
    const releases = current.state.history.filter(row => row.event.position === 'before' && row.event.intent.request && (() => { const a = readTransitionAction(row.event.intent.request); return a.kind === 'release' && sameMemory(a.target.packet, packetRef); })());
    if (releases.length !== 1 || !current.state.history.some(row => row.event.position === 'after' && row.event.beforeEventSha256 === releases[0].sha256 && row.event.outcome === 'succeeded')) refuse('owned-work-unsupported', 'work delivery is not durably published');
    for (const row of current.state.history) if (row.event.position === 'before' && row.event.intent.request) {
      const a = readTransitionAction(row.event.intent.request), completion = a.basis?.workCompletion;
      if (completion && sameMemory(transitionBound(completion).packet, packetRef)) refuse('owned-work-closed', 'issued task already has a result consumer');
    }
    const latest = readRuntimeObservation(current.state.history.at(-1).event);
    if (!sameMemory(latest.inputs.baseline, launch.before.baseline)) refuse('resume-context-stale', 'task baseline changed');
    const out = path.join(path.dirname(packetRef.file), 'lease-' + raw.invocationId);
    const actor = observeAssignedActor({ projectRoot: root, ao: { tool: launch.before.fixed.aoTool, stateHome: run.aoStateHome, projectId: run.aoProjectId }, actor: packet.actor, attemptId: raw.invocationId, out });
    const fixedActor = a => ({ projectId:a.projectId,sessionId:a.sessionId,reservationId:a.reservationId,assignmentId:a.assignmentId,path:a.worktree.path,gitDir:a.worktree.gitDir,common:a.worktree.gitCommonDir,branch:a.worktree.branchRef,profile:a.profile });
    if (!sameMemory(fixedActor(actor), fixedActor(packet.actor))) refuse('resume-context-stale', 'task actor path/branch/profile changed');
    const frozen = launch.before.baseline === null ? null : transitionBound(launch.before.baseline);
    if (frozen?.schema !== 'fvs-checker/auto-baseline' || frozen.version !== 2) refuse('owned-work-unsupported', 'issued proof task lacks v2 expectations');
    const toolPins = [...Object.entries(frozen.checker ?? {}).filter(([file]) => ['node','git'].includes(path.basename(file))).map(([file,sha256])=>({file,sha256})), ...[frozen.build?.lean,frozen.build?.lake].filter(Boolean).map(t=>({file:t.path,sha256:t.sha256}))];
    const gitTools=toolPins.filter(t=>path.basename(t.file)==='git');if(gitTools.length!==1)refuse('owned-work-unsupported','one exact frozen Git tool required');
    const gitTool=gitTools[0];let readSeq=0;
    const fence=()=>{
      const observed=readRuntime(root),canonical=readState({projectRoot:root,requireAgreement:true});
      if(observed.headSha256!==current.headSha256||canonical.state.choicesGeneration!==run.choicesGeneration||canonical.agreement.contextSha256!==run.agreementContextSha256||!sameMemory(canonical.state.memoryBindings??[],view.state.memoryBindings??[]))refuse('resume-context-stale','task/run/memory binding context changed');
      transitionBound(packetRef);transitionBound(markerRef);transitionBound(launch.before.baseline);
      const chain=readChain(frozen.registry.root);if(chain.pending||(chain.records.at(-1)?.sha??null)!==frozen.registry.headSha256)refuse('resume-context-stale','task semantic generation changed');
      if(executionToolIdentity(gitTool.file).sha256!==gitTool.sha256)refuse('resume-context-stale','frozen Git tool changed');
      const expected=[launch.before.source.commit,launch.before.source.tree,'',run.gitCommonDir,launch.before.source.branchRef],queries=[['rev-parse','HEAD'],['rev-parse','HEAD^{tree}'],['status','--porcelain=v1','--untracked-files=all'],['rev-parse','--git-common-dir'],['symbolic-ref','HEAD']];
      for(const[index,args]of queries.entries()){
        const argv=[gitTool.file,'-C',launch.before.source.root,...args],env={PATH:'/usr/bin:/bin',LANG:'C',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'},p=spawnSync(argv[0],argv.slice(1),{cwd:launch.before.source.root,env,timeout:10000,maxBuffer:1024*1024});
        const stem='task-source-'+readSeq++,stream=(suffix,bytes)=>{const file=path.join(out,stem+suffix);fs.writeFileSync(file,bytes??Buffer.alloc(0),{flag:'wx'});return{file,sha256:sha256(bytes??Buffer.alloc(0))};};
        transitionSave(path.join(out,stem+'.json'),{argv,env,tool:gitTool,exitCode:p.status,signal:p.signal,error:p.error?.code??null,stdout:stream('.stdout',p.stdout),stderr:stream('.stderr',p.stderr)});
        const value=p.stdout?.toString('utf8').trim(),actual=index===3&&value?fs.realpathSync(path.resolve(launch.before.source.root,value)):value;
        if(p.status!==0||p.signal||p.error||actual!==expected[index])refuse('resume-context-stale','actual integration source/common Git/branch changed');
      }
      const finalChain=readChain(frozen.registry.root);if(executionToolIdentity(gitTool.file).sha256!==gitTool.sha256||readRuntime(root).headSha256!==current.headSha256||finalChain.pending||(finalChain.records.at(-1)?.sha??null)!==frozen.registry.headSha256)refuse('resume-context-stale','tool/run/semantic generation changed during task observation');
    };
    if(!progressOnly){
      if(!sameMemory(marker.memoryEvidence,workerMemoryEvidence(marker.memoryEvidence?.out,packet.memoryRequest,launch.before.fixed)))refuse('resume-context-stale','worker memory evidence changed');
      if(run.memory.mode==='beads')verifyMemoryBootstrap({projectRoot:root,callerRoot:packet.actor.worktree.path,request:packet.memoryRequest,out:marker.memoryEvidence.out});
    }
    fence();
    return { packet:packetRef, actor:packet.actor, observedActor:actor, control:runControl(run), toolPins, fence, authority:progressOnly?'progress facts only; no work/dispatch authority':'candidate work lease only; no proof authority' };
  });
}
const sameMemory = (a,b) => memoryHash(a) === memoryHash(b);

export function recordProgress(options) {
  return memoryOperation(() => {
    const value=JSON.parse(JSON.stringify(memoryDataSnapshot(options))),invocationId=crypto.randomUUID();
    const lease=verifyActiveTask({packet:value.packet,marker:value.marker,invocationId},{progressOnly:true});
    return recordTaskProgress(value,{observeActor:()=>lease.observedActor});
  });
}
export function observeProgress(options) {
  return memoryOperation(()=>{
    const value=JSON.parse(JSON.stringify(memoryDataSnapshot(options)));
    if(Object.keys(value).length!==4||['packet','marker','progress','out'].some(k=>!Object.hasOwn(value,k)))refuse('transition-progress-invalid','closed current progress observation required');
    const p=readTaskProgress(value.progress);
    if(!sameMemory(p.packet,value.packet)||!sameMemory(p.marker,value.marker))refuse('transition-progress-invalid','current observation/handoff differ');
    const lease=verifyActiveTask({packet:value.packet,marker:value.marker,invocationId:crypto.randomUUID()},{progressOnly:true});
    if(fs.existsSync(value.out)||!path.isAbsolute(value.out)||fs.realpathSync(path.dirname(value.out))!==path.dirname(value.out))refuse('transition-progress-invalid','exclusive progress observation output required');
    const observation={schema:'fvs/auto-progress-observation',schemaVersion:1,progress:value.progress,actor:lease.observedActor,ownedWork:observeOwnedWork(value.packet,p.actor),assessment:assessTaskProgress(p),executable:false,proofAuthority:'none; current scheduling facts only'};
    fs.mkdirSync(value.out,{mode:0o700});const evidence=transitionSave(path.join(value.out,'observation.json'),observation);return{...observation,evidence};
  });
}
export function readProgress(options) {
  return memoryOperation(() => {
    const value=JSON.parse(JSON.stringify(memoryDataSnapshot(options)));
    if(Object.keys(value).length!==1||!Object.hasOwn(value,'progress'))refuse('transition-progress-invalid','closed progress reference required');
    const p=readTaskProgress(value.progress);
    return{status:'historical-progress-facts',progress:value.progress,task:p,assessment:assessTaskProgress(p),executable:false,proofAuthority:'none; current actor/context and stop still need fresh observation'};
  });
}

export function readRuntimeState(options) {
  return memoryOperation(() => {
    const data = memoryDataSnapshot(options), errors = [];
    if (!fields(errors, data, 'runtime read', ['projectRoot']) || errors.length) refuse('invalid-input', errors.join('; '));
    return readRuntime(projectDirectory(data.projectRoot));
  });
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
  commitState(root, state, state);
  return { code: 'recorded', message: `roadmap offer recorded as ${decision}`, state };
}

function engineResult(command, out) {
  const run = spawnSync(process.execPath, [ENGINE, command, '--out', out], { encoding: 'utf8' });
  try {
    const result = JSON.parse(run.stdout);
    return { ...result, ok: result.ok === true };
  } catch {
    return { ok: false, code: 'internal', message: firstLine(run.stderr) || `the engine exited ${run.status}` };
  }
}

function engineCheck(command, out) {
  const { ok, code, message } = engineResult(command, out);
  return { ok, code, message };
}

// The top of the git working tree that holds a directory, or null when it is in
// none. The variables that redirect git are cleared, so two unrelated
// directories cannot be made to report one working tree.
function gitWorkingTree(directory) {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete env[name];
  const run = spawnSync('git', ['--no-optional-locks', '-C', directory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env });
  const top = run.status === 0 ? run.stdout.trim() : '';
  return top ? fs.realpathSync(top) : null;
}

// The real path of a path that may not exist on disk: its deepest existing ancestor is resolved
// and the rest is kept as written.
function realPathOf(target) {
  const missing = [];
  let existing = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...missing);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(target);
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

function resolveRevision(directory, revision) {
  const run = spawnSync('git', ['--no-optional-locks', '-C', directory, 'rev-parse', '--verify', '--quiet', `${revision}^{commit}`], { encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

// The status is derived here, never taken from the caller: success needs a zero
// build exit and the shared extractor's success oracle reporting complete (the two
// declared inputs, which can only block success), and the patch engine's own
// status, verify-tree and verify-restore checks on the copy Charon consumed, taken
// from this project at the recorded revision without uncommitted changes.
export function recordExtraction({ projectRoot, out, buildExitCode, oracle, oracleReason }) {
  if (!Number.isInteger(buildExitCode)) refuse('usage', '--build-exit-code must be an integer');
  if (!ORACLE_VERDICTS.includes(oracle)) refuse('usage', `--oracle must be ${ORACLE_VERDICTS.slice(0, -1).join(', ')} or ${ORACLE_VERDICTS.at(-1)}`);
  if (oracleReason !== undefined && typeof oracleReason !== 'string') refuse('usage', 'the oracle reason must be text');
  // A blank reason is the same as none, so the record satisfies the reader's optional-text rule.
  const reason = isText(oracleReason) ? oracleReason : undefined;
  const root = projectDirectory(projectRoot);
  const state = requireStateToExtract(root);
  // A relative copy path is read from the project root, not the shell's working directory.
  const copy = path.resolve(root, out);
  const checks = {
    status: engineCheck('status', copy),
    'verify-tree': engineCheck('verify-tree', copy),
    'verify-restore': engineCheck('verify-restore', copy),
  };
  const reasons = [];
  if (buildExitCode !== 0) reasons.push(`the build exited ${buildExitCode}`);
  if (oracle === 'refused') reasons.push(`the shared extractor's success oracle refused completion: ${reason ?? 'no reason given'}`);
  if (oracle === 'unknown') reasons.push(`the shared extractor did not report a complete success oracle (verdict unknown)${reason ? `: ${reason}` : ''}`);
  for (const [name, check] of Object.entries(checks)) {
    if (!check.ok) reasons.push(`the patch engine ${name} check refused (${check.code}): ${check.message}`);
  }
  let inputs = null;
  let manifest = null;
  if (checks.status.ok) {
    const bytes = fs.readFileSync(path.join(copy, 'manifest.json'));
    manifest = JSON.parse(bytes);
    const { revision } = state.choices.source;
    const crate = manifest.projectRoot;
    if (manifest.mode !== 'translation-patches') reasons.push(`the copy was prepared in ${manifest.mode} mode; the auto track extracts through translation patches only`);
    // The crate must be in the git working tree that holds the project root: beside the
    // Lean project (the Lean root in a subfolder, the crate at the repository root) or
    // inside it. A nested repository or linked worktree is another checkout, so its
    // commit says nothing about this project, wherever it sits. The revision and
    // uncommitted-change checks below bind the crate to the recorded commit.
    const rootTree = crate === root ? null : gitWorkingTree(root);
    if (crate !== root && (rootTree === null || rootTree !== gitWorkingTree(crate))) {
      reasons.push(`the copy was prepared from ${crate}, which is not in the git working tree of this project`);
    }
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
  // An attempt recorded by the patch engine is attached only after the engine
  // re-validates its whole chain against the current files.
  let run;
  const attempted = fs.existsSync(path.join(copy, 'attempt.json'));
  if (attempted) {
    const status = engineResult('attempt-status', copy);
    if (!status.ok) reasons.push(`the recorded extraction attempt does not check out (${status.code}): ${status.message}`);
    else if (!runValid(status.run) || status.run.manifestSha256 !== inputs?.manifestSha256) reasons.push('the recorded extraction attempt is not bound to this manifest');
    else if (unitsProblem(status.run) !== null) reasons.push(`the crates of the recorded extraction attempt do not agree with its roster (${unitsProblem(status.run)}): extract again`);
    else run = status.run;
  }
  // Providers must come before consumers, and a verified crate must be stitched to the verified
  // crates it uses, with the targets the owner's latest agreement names.
  const agreedTargets = state.agreements?.at(-1)?.payload?.targets ?? null;
  reasons.push(...crateProblems(run, agreedTargets));
  // The scope is what the copy recorded when it was prepared, and a single crate is never what is left when
  // it records none: an unknown scope is a reason of its own, which the owner settles by preparing the copy
  // again (a release folder lets cargo read the workspace).
  const scope = scopeOf(manifest);
  if (manifest !== null && scope.kind === 'unknown') {
    reasons.push(`the scope of this extraction is not established (${isText(scope.reason) ? scope.reason : 'the extraction engine could not tell a single crate from several'}), and an unknown scope is never read as a single crate: prepare the copy again so that it records its scope`);
  }
  // When the scope is several crates (the copy's scope, the agreement, or the workspace holds them), only a
  // completed attempt over all of them can be recorded: a missing attempt, or the attempt of one crate,
  // is never read as "nothing else to verify". An attempt that was refused has its own reason above.
  const inScope = [...new Set([...declaredCrates({ manifest, targets: agreedTargets }), ...(scope.kind === 'multi-crate' && Array.isArray(scope.libraryCrates) ? scope.libraryCrates.filter(isText) : [])])].sort();
  if ((inScope.length > 1 || scope.kind === 'multi-crate') && (attempted ? run !== undefined && run.roster === undefined : true)) {
    reasons.push(`the crates ${inScope.join(', ')} are in scope (the copy's scope, the agreement, or the workspace names them), but the copy holds ${attempted ? 'the attempt of one crate only' : 'no extraction attempt'}: record a completed attempt over all of them, with an extraction spec that makes each crate a target, a non-target or dropped`);
  } else if (manifest !== null && scope.kind !== 'unknown' && (!attempted || run !== undefined)) {
    const unsettled = scopeProblem(scope, run);
    if (unsettled !== null) reasons.push(unsettled);
  }
  const extraction = {
    status: reasons.length === 0 ? 'succeeded' : 'failed',
    recordedAt: now(),
    // The source selection this record answers; a later confirmed change makes it history.
    selected: { ...state.choices.source },
    reasons,
    declared: { buildExitCode, oracle, ...(reason ? { oracleReason: reason } : {}) },
    checks,
    inputs,
    ...(manifest !== null ? { scope } : {}),
    ...(run ? { run } : {}),
    note: NOT_A_PROOF,
  };
  state.extraction = extraction;
  commitState(root, state, state);
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

// A path relative to the project root (or absolute) naming an existing file
// inside it, returned root-relative with forward slashes so rows key on it.
function projectFile(root, file, flag) {
  let real;
  try {
    real = fs.realpathSync(path.resolve(root, file));
  } catch {
    refuse('invalid-input', `${flag} ${file} does not exist under ${root}`);
  }
  if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) {
    refuse('invalid-input', `${flag} must name a file inside the project root ${root}: ${file}`);
  }
  return { relative: path.relative(root, real).split(path.sep).join('/'), real };
}

const idList = (text, flag) => {
  const ids = (text ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.some((id) => /\s/.test(id))) refuse('usage', `${flag} takes comma-separated Rust paths without spaces`);
  return [...new Set(ids)];
};

// The spec file named by a path that only has to exist in a commit, not on disk.
// The path is checked lexically, so it still has to stay inside the project root.
function committedSpec(root, commit, file) {
  const relative = path.relative(root, path.resolve(root, file));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    refuse('invalid-input', `--spec-file must name a file inside the project root ${root}: ${file}`);
  }
  const specFile = relative.split(path.sep).join('/');
  const bytes = bytesAt(root, commit, specFile);
  if (bytes === null) refuse('invalid-input', `--spec-file ${file} is not a file in commit ${commit}`);
  return { relative: specFile, bytes };
}

// The crate an item belongs to: the first segment of its Rust path.
const itemCrate = (id) => id.split('::')[0];

// Every item of a spec file must belong to one target crate and must have been
// translated: an item of a crate the owner or the extraction left out has no statement
// to give, a target the extraction lacks has nothing to state it about, and an item
// Charon could not translate has no definition.
function checkSpecItems(context, ids) {
  const owners = new Set();
  for (const id of ids) {
    const crate = itemCrate(id);
    if (context.nonTargets.has(crate)) {
      refuse('invalid-input', `${id}: crate ${crate} is not a verification target, so its items get no statement; the owner may only assume them`);
    }
    if (context.missing.includes(crate)) {
      refuse('invalid-input', `${id}: crate ${crate} is a target in the agreement but the extraction does not hold it; extract it, or record the owner's decision to drop it`);
    }
    const unit = context.units.find((entry) => entry.crate === crate);
    if (!unit) {
      const known = context.units.map((entry) => entry.crate);
      refuse('invalid-input', `${id}: crate ${crate} is not in the recorded extraction (crates: ${known.join(', ')})`, { crates: known });
    }
    if (Array.isArray(unit.hasErrors?.items) && unit.hasErrors.items.includes(id)) {
      refuse('invalid-input', `${id} was not translated (Charon reported errors on it), so it cannot have a statement; name it in --out-of-scope`);
    }
    owners.add(crate);
  }
  if (owners.size > 1) refuse('invalid-input', `--items names items of ${[...owners].join(', ')}: a spec file covers one crate, so record one file per crate`, { crates: [...owners] });
}

// With a commit, the spec file is hashed from that commit's git object, so the
// checkout is never moved or touched to record a review. The review report is
// a working file (it is never committed), so it is still read from disk.
export function recordSpec({ projectRoot, specFile, items, round, verdict, review, outOfScope, commit }) {
  const root = projectDirectory(projectRoot);
  if (!Object.hasOwn(SPEC_VERDICTS, verdict)) refuse('usage', `--verdict must be ${Object.keys(SPEC_VERDICTS).join(', ')}`);
  if (!Number.isInteger(round) || round < 1) refuse('usage', '--round must be a positive integer');
  const ids = idList(items, '--items');
  if (ids.length === 0) refuse('usage', '--items must name at least one item');
  const context = crateContext(root);
  if (context) checkSpecItems(context, ids);
  let resolved = null;
  if (commit !== undefined) {
    resolved = resolveRevision(root, commit);
    if (resolved === null) refuse('invalid-input', `--commit ${commit} is not a local commit: fetch the branch first`);
  }
  const spec = resolved === null ? projectFile(root, specFile, '--spec-file') : committedSpec(root, resolved, specFile);
  const reviewFile = projectFile(root, review, '--review');
  const row = {
    specFile: spec.relative, items: ids, outOfScope: idList(outOfScope, '--out-of-scope'), round, verdict,
    specSha256: sha256(resolved === null ? fs.readFileSync(spec.real) : spec.bytes), review: reviewFile.relative, reviewSha256: sha256(fs.readFileSync(reviewFile.real)),
    ...(resolved === null ? {} : { commit: resolved }),
    recordedAt: new Date().toISOString(),
  };
  const base = loadSpecs(root);
  commitState(root, base, { ...(base ?? { schema: 'fvs/auto-specs', schemaVersion: 1 }), specs: [...(base?.specs ?? []), row] }, specsPath(root));
  const warnings = round > 3 ? [`round ${round} is past the three agreed review rounds; it is recorded`] : [];
  return { code: 'recorded', message: `${SPEC_VERDICTS[verdict](round)}: ${row.specFile}`, row, warnings };
}

// The Rust functions Aeneas translated from this crate, read from translation.json
// and narrowed by an explicit scope: a source file or directory (src/hmac.rs) or a
// Rust path prefix (libcrux_hmac::hmac). translation.json records no visibility, so
// the list holds candidates for the public API, never a claim about it.
export function listItems({ projectRoot, translation, scope, crate }) {
  const root = projectDirectory(projectRoot);
  if (translation !== undefined && crate !== undefined) refuse('usage', '--crate names a crate of the recorded extraction, so it cannot be combined with --translation');
  // Without --translation, the one a succeeded extraction published; a failed one names none.
  const state = translation === undefined ? loadState(root) : null;
  const extraction = state?.extraction?.status === 'succeeded' ? state.extraction : null;
  let run = extraction?.run;
  if (extraction && crate !== undefined) {
    run = runOf(state, crate);
    if (!run) refuse('invalid-input', `the recorded extraction has no crate ${crate}`, { crates: (extraction.run?.units ?? []).map((unit) => unit.crate) });
  } else if (extraction && (extraction.run?.units?.length ?? 0) > 1) {
    // Several crates are translated, and a list of only one of them would read as complete.
    refuse('invalid-input', 'the recorded extraction has several crates: pass --crate NAME', { crates: extraction.run.units.map((unit) => unit.crate) });
  }
  const file = translation === undefined ? run?.translation?.projectPath : path.resolve(root, translation);
  if (!file) refuse('invalid-input', 'no translation.json is known: pass --translation PATH, or record an extraction that names it', { nextStep: 'Run /fvs:auto-extract, or pass --translation PATH.' });
  let bytes;
  let data;
  try {
    bytes = fs.readFileSync(file);
    data = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    refuse('invalid-input', `cannot read ${file} as JSON: ${error.message}`);
  }
  // The top level is an object of lists next to plain text fields (versions, crate name), so a
  // loop over its entries meets strings; only the lists are read, and a wrong shape is named.
  if (!plainObject(data) || !Array.isArray(data.functions)) {
    refuse('invalid-input', `${file} is not an Aeneas translation.json: expected an object with a "functions" list, found ${Array.isArray(data) ? 'a list' : typeof data}`);
  }
  const badAt = data.functions.findIndex((entry) => !plainObject(entry) || !isText(entry.rust_name) || !isText(entry.lean_name));
  if (badAt >= 0) refuse('invalid-input', `${file}: functions[${badAt}] must be an object with a rust_name and a lean_name`);
  const scopes = idList(scope, '--scope');
  const inScope = (entry) => scopes.length === 0 || scopes.some((prefix) => {
    const source = entry.source?.file;
    return entry.rust_name === prefix || entry.rust_name.startsWith(`${prefix}::`)
      || (typeof source === 'string' && (source === prefix || source.startsWith(`${prefix.replace(/\/$/, '')}/`)));
  });
  const local = data.functions.filter((entry) => entry.is_local === true);
  const chosen = local.filter(inScope);
  const items = chosen.map((entry) => ({
    rustName: entry.rust_name, leanName: entry.lean_name, leanFile: entry.lean_file ?? null,
    source: entry.source ? { file: entry.source.file, beginLine: entry.source.begin_line, endLine: entry.source.end_line } : null,
    opaque: entry.is_opaque === true, canFail: entry.can_fail === true,
  })).sort((a, b) => (a.source?.file ?? '').localeCompare(b.source?.file ?? '') || (a.source?.beginLine ?? 0) - (b.source?.beginLine ?? 0) || a.rustName.localeCompare(b.rustName));
  return {
    code: 'ok', message: `${items.length} translated local function(s) in scope, from ${file}`,
    translation: file, translationSha256: sha256(bytes), crate: typeof data.crate === 'string' ? data.crate : null, scope: scopes,
    excluded: { notLocal: data.functions.length - local.length, outOfScope: local.length - chosen.length },
    visibility: 'not recorded: translation.json holds no visibility, so these are candidates; confirm each against the Rust source (pub, pub(crate) or private) before calling it public API',
    items,
  };
}

// Current verdict per spec file, recomputed against the bytes on disk, or at a
// commit when one is given (the PR head, for a checkout that holds no spec
// files). Ready for the PR: at least one pass, no file waiting for changes,
// none stale. Blocked files do not hold the PR; its body names them.
export function specStatus({ projectRoot, commit }) {
  const root = projectDirectory(projectRoot);
  let resolved = null;
  if (commit !== undefined) {
    resolved = resolveRevision(root, commit);
    if (resolved === null) refuse('invalid-input', `--commit ${commit} is not a local commit: fetch the branch first`);
  }
  const specs = loadSpecs(root);
  const current = new Map();
  for (const row of specs?.specs ?? []) current.set(row.specFile, { row, rounds: (current.get(row.specFile)?.rounds ?? 0) + 1 });
  const owner = ownerChangesOf(specs);
  const specFiles = [...current.values()].map(({ row, rounds }) => {
    let bytes = null;
    if (resolved !== null) bytes = bytesAt(root, resolved, row.specFile);
    else {
      try {
        bytes = fs.readFileSync(path.join(root, row.specFile));
      } catch {
        // a missing spec file is stale
      }
    }
    const ownerChange = OWNER_CHANGES[owner.get(row.specFile)] ?? null;
    return { specFile: row.specFile, items: row.items, outOfScope: row.outOfScope.map((id) => ({ id, label: 'out of scope (noted by agent)' })),
      verdict: row.verdict, round: row.round, label: ownerChange ?? SPEC_VERDICTS[row.verdict](row.round), rounds, review: row.review,
      stale: bytes === null || sha256(bytes) !== row.specSha256, missing: bytes === null, ownerChange };
  });
  // A file the owner pruned at the merge never holds a later PR.
  const live = specFiles.filter((file) => owner.get(file.specFile) !== 'pruned');
  const ready = (files) => files.some((file) => file.verdict === 'pass') && !files.some((file) => file.verdict === 'changes' || file.stale);
  const blocked = specFiles.filter((file) => file.verdict === 'blocked').map((file) => file.specFile);
  // With several crates, every crate needs its own reviewed spec files before the PR is ready.
  const context = crateContext(root);
  const crates = context ? specCrates(context, specFiles, live, ready) : null;
  const readyForPr = ready(live) && (crates === null || crates.units.every((unit) => unit.ready));
  return { code: 'ok', message: `${specFiles.length} spec file(s) recorded in ${specsPath(root)}`, ...(resolved === null ? {} : { commit: resolved }),
    specFiles: crates ? specFiles.map((file) => ({ ...file, crates: crateNames(context, file.items) })) : specFiles, ...(crates ? { crates } : {}), readyForPr, blocked };
}

// The target crates an item list belongs to, providers first.
const crateNames = (context, items) => context.targets.filter((crate) => items.some((id) => itemCrate(id) === crate));

// Each target crate with the spec files that state its items, providers first, then the
// targets the extraction lacks. A crate is ready when it has a reviewed pass and no file
// of it waits for changes or is stale; a missing crate is never ready.
function specCrates(context, specFiles, live, ready) {
  const label = (files, crate) => (context.missing.includes(crate) ? 'the agreement names this crate as a target, but the extraction does not hold it'
    : files.length === 0 ? 'no spec file is recorded for this crate'
      : ready(files) ? 'spec files reviewed: pass'
        : files.some((file) => file.verdict === 'changes' || file.stale) ? 'a spec file is waiting for changes or changed after its review'
          : 'no spec file of this crate has a reviewed pass');
  const dependsOn = new Map(context.view.units.map((unit) => [unit.crate, unit.dependsOn.filter((crate) => context.targets.includes(crate))]));
  const order = [...context.targets, ...context.missing];
  return {
    order,
    units: order.map((crate) => {
      const files = live.filter((file) => file.items.some((id) => itemCrate(id) === crate));
      return { crate, dependsOn: dependsOn.get(crate) ?? [], specFiles: files.map((file) => file.specFile), ready: !context.missing.includes(crate) && ready(files), label: label(files, crate) };
    }),
  };
}

// The raw bytes of a project-root-relative file at a commit (never converted by
// a git filter), or null when the commit does not have it as a file. The
// project root may be a subdirectory of the repository.
function bytesAt(root, commit, relative) {
  const run = spawnSync('git', ['--no-optional-locks', '-C', root, 'cat-file', 'blob', `${commit}:./${relative}`], { maxBuffer: 64 * 1024 * 1024 });
  return run.status === 0 ? run.stdout : null;
}

// Records a draft PR the orchestrator opened. Only a mismatch the engine can
// see is reported, as a warning: it never calls GitHub and never refuses a PR.
export function recordPr({ projectRoot, kind, url, branch, head, merged = false, mergeCommit }) {
  const root = projectDirectory(projectRoot);
  if (!PR_KINDS.includes(kind)) refuse('usage', `--kind must be ${PR_KINDS.join(' or ')}`);
  if (merged) return recordMerge(root, kind, mergeCommit);
  for (const [flag, value] of [['--url', url], ['--branch', branch], ['--head', head]]) if (!value) refuse('usage', `${flag} is required`);
  const warnings = [];
  const commit = resolveRevision(root, head);
  if (kind === 'spec') {
    // Readiness is judged at the PR head when it is local: the checkout need not hold the spec files.
    const status = specStatus({ projectRoot: root, ...(commit === null ? {} : { commit }) });
    if (!status.readyForPr) warnings.push(status.specFiles.length === 0 ? 'no reviewed spec file is recorded' : 'spec-status is not ready for the PR (a file is waiting for changes or changed after its review)');
    for (const unit of (status.crates?.units ?? []).filter((entry) => !entry.ready)) warnings.push(`crate ${unit.crate}: ${unit.label}`);
    if (commit === null) {
      warnings.push(`the head ${head} is not a local commit, so the recorded spec files were not compared with it; fetch the PR branch to compare`);
    } else {
      const specs = loadSpecs(root);
      const owner = ownerChangesOf(specs);
      for (const row of currentSpecRows(specs).filter((entry) => owner.get(entry.specFile) !== 'pruned')) {
        const bytes = bytesAt(root, commit, row.specFile);
        if (bytes === null) warnings.push(`${row.specFile} is not in the PR head`);
        else if (sha256(bytes) !== row.specSha256) warnings.push(`${row.specFile} in the PR head differs from the reviewed bytes`);
      }
    }
  }
  const base = loadSpecs(root);
  const pr = { kind, url, branch, head: commit ?? head, recordedAt: new Date().toISOString() };
  commitState(root, base, { ...(base ?? { schema: 'fvs/auto-specs', schemaVersion: 1, specs: [] }), prs: [...(base?.prs ?? []), pr] }, specsPath(root));
  return { code: 'recorded', message: `draft ${kind} PR recorded: ${url}`, pr, warnings };
}

// The owner merged the PR; the orchestrator read the merge commit from GitHub.
// The commit must be local so the merged spec files can be compared with their
// reviewed bytes: a file the owner removed is pruned, one they edited is
// owner-changed. Both are warnings; a spec merge starts the proof phase.
function recordMerge(root, kind, mergeCommit) {
  if (!mergeCommit) refuse('usage', '--merge-commit is required with --merged');
  const commit = resolveRevision(root, mergeCommit);
  if (commit === null) refuse('invalid-input', `the merge commit ${mergeCommit} is not a local commit: fetch the merged branch, then rerun record-pr`);
  const base = loadSpecs(root);
  const open = lastPr(base, kind);
  const warnings = open && !open.merged ? [] : [`no open draft ${kind} PR is recorded; the merge is recorded on its own`];
  const pr = { kind, merged: true, mergeCommit: commit, ...(open && !open.merged ? { url: open.url } : {}), recordedAt: new Date().toISOString() };
  if (kind === 'spec') {
    pr.ownerChanges = currentSpecRows(base).flatMap((row) => {
      const bytes = bytesAt(root, commit, row.specFile);
      if (bytes === null) return [{ specFile: row.specFile, change: 'pruned' }];
      return sha256(bytes) === row.specSha256 ? [] : [{ specFile: row.specFile, change: 'owner-changed' }];
    });
    if (currentSpecRows(base).length === 0) warnings.push('no reviewed spec file is recorded, so the merged statements were not compared with reviewed bytes');
    warnings.push(...pr.ownerChanges.map((entry) => `${entry.specFile}: ${OWNER_CHANGES[entry.change]}`));
  }
  commitState(root, base, { ...(base ?? { schema: 'fvs/auto-specs', schemaVersion: 1, specs: [] }), prs: [...(base?.prs ?? []), pr] }, specsPath(root));
  const ownerChanges = pr.ownerChanges?.map((entry) => ({ ...entry, label: OWNER_CHANGES[entry.change] }));
  return { code: 'recorded', message: `${kind} PR merge recorded at ${commit}`, pr: { ...pr, ...(ownerChanges ? { ownerChanges } : {}) }, warnings };
}

function readInput(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    refuse('invalid-input', `cannot read JSON from ${file}: ${error.message}`);
  }
}

function stateFlags(argv, values, switches = [], optional = []) {
  const flags = { 'project-root': '.' };
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift();
    const key = flag.replace(/^--/, '');
    if (key !== flag && switches.includes(key)) {
      flags[key] = true;
      continue;
    }
    if (key === flag || ![...values, ...optional, 'project-root'].includes(key)) refuse('usage', `unknown argument ${JSON.stringify(flag)}`);
    const value = rest.shift();
    if (!value || value.startsWith('--')) refuse('usage', `${flag} requires a value`);
    flags[key] = value;
  }
  for (const key of values) if (flags[key] === undefined) refuse('usage', `--${key} is required`);
  return flags;
}

const STATE_COMMANDS = {
  'record-progress': argv => { const flags=stateFlags(argv,['input']);return recordProgress(transitionJson(fs.readFileSync(flags.input))); },
  'observe-progress': argv => { const flags=stateFlags(argv,['input']);return observeProgress(transitionJson(fs.readFileSync(flags.input))); },
  'read-progress': argv => { const flags=stateFlags(argv,['input']);return readProgress(transitionJson(fs.readFileSync(flags.input))); },
  ...Object.fromEntries([['next-transition', nextTransition], ['execute-transition', executeTransition], ['verify-transition', verifyTransition], ['verify-startup', verifyWorkerStartup], ['ack-work', acknowledgeWorkPacket]].map(([command, run]) => [command, (argv, services) => {
    const flags = stateFlags(argv, ['input']);
    return run({ ...transitionJson(fs.readFileSync(flags.input)), projectRoot: flags['project-root'] }, services);
  }])),
  ...Object.fromEntries([['checkpoint', checkpointState], ['state', reconcileState]].map(([command, run]) => [command, (argv) => {
    const flags = stateFlags(argv, ['request', 'out']);
    return run({ projectRoot: flags['project-root'], request: parseResumeRequest(fs.readFileSync(flags.request)), out: flags.out });
  }])),
  'run-owned': (argv, services) => { const flags = stateFlags(argv, ['input']); return runTaskCommand(transitionJson(fs.readFileSync(flags.input)), services); },
  'init-state': (argv) => {
    const flags = stateFlags(argv, ['input'], ['confirm-overwrite']);
    return initState({ projectRoot: flags['project-root'], choices: readInput(flags.input), confirmOverwrite: flags['confirm-overwrite'] === true });
  },
  'read-state': (argv) => {
    const flags = stateFlags(argv, [], ['require-agreement', 'brief']);
    return readState({ projectRoot: flags['project-root'], requireAgreement: flags['require-agreement'] === true, brief: flags.brief === true });
  },
  'record-agreement': (argv) => {
    const flags = stateFlags(argv, ['input'], ['confirm-overwrite']);
    return recordAgreement({ projectRoot: flags['project-root'], agreement: readInput(flags.input), confirmOverwrite: flags['confirm-overwrite'] === true });
  },
  'record-memory': (argv) => {
    const flags = stateFlags(argv, ['input'], ['confirm-overwrite']);
    return recordMemory({ projectRoot: flags['project-root'], registration: readInput(flags.input), confirmOverwrite: flags['confirm-overwrite'] === true });
  },
  ...Object.fromEntries([['prime-memory', primeMemory], ['refresh-memory', refreshMemory]].map(([command, run]) => [command, (argv) => {
    const flags = stateFlags(argv, ['request', 'out']);
    const requestBytes = fs.readFileSync(flags.request);
    let request;
    try { request = JSON.parse(requestBytes.toString('utf8')); }
    catch (e) { refuse('invalid-input', 'cannot parse bootstrap request: ' + e.message); }
    return run({ projectRoot: flags['project-root'], request, requestBytes, out: flags.out });
  }])),
  'record-roadmap': (argv) => {
    const flags = stateFlags(argv, ['decision'], ['confirm-overwrite']);
    return recordRoadmap({ projectRoot: flags['project-root'], decision: flags.decision, confirmOverwrite: flags['confirm-overwrite'] === true });
  },
  'record-extraction': (argv) => {
    const flags = stateFlags(argv, ['out', 'build-exit-code', 'oracle'], [], ['oracle-reason']);
    if (!/^-?\d+$/.test(flags['build-exit-code'])) refuse('usage', '--build-exit-code must be an integer');
    return recordExtraction({
      projectRoot: flags['project-root'],
      out: flags.out,
      buildExitCode: Number(flags['build-exit-code']),
      oracle: flags.oracle,
      oracleReason: flags['oracle-reason'],
    });
  },
  'record-externals': (argv) => {
    const flags = stateFlags(argv, ['input']);
    return recordExternals({ projectRoot: flags['project-root'], records: readInput(flags.input) });
  },
  'record-spec': (argv) => {
    const flags = stateFlags(argv, ['spec-file', 'items', 'round', 'verdict', 'review'], [], ['out-of-scope', 'commit']);
    if (!/^\d+$/.test(flags.round)) refuse('usage', '--round must be a positive integer');
    return recordSpec({ projectRoot: flags['project-root'], specFile: flags['spec-file'], items: flags.items, round: Number(flags.round),
      verdict: flags.verdict, review: flags.review, outOfScope: flags['out-of-scope'], commit: flags.commit });
  },
  'list-items': (argv) => {
    const flags = stateFlags(argv, [], [], ['translation', 'scope', 'crate']);
    return listItems({ projectRoot: flags['project-root'], translation: flags.translation, scope: flags.scope, crate: flags.crate });
  },
  'allowed-axioms': (argv) => {
    const flags = stateFlags(argv, [], [], ['commit']);
    return allowedAxioms({ projectRoot: flags['project-root'], commit: flags.commit });
  },
  'record-override': (argv) => {
    const flags = stateFlags(argv, ['key', 'value', 'reason']);
    return recordOverride({ projectRoot: flags['project-root'], key: flags.key, value: flags.value, reason: flags.reason });
  },
  'spec-status': (argv) => {
    const flags = stateFlags(argv, [], [], ['commit']);
    return specStatus({ projectRoot: flags['project-root'], commit: flags.commit });
  },
  'record-pr': (argv) => {
    const flags = stateFlags(argv, ['kind'], ['merged'], ['url', 'branch', 'head', 'merge-commit']);
    return recordPr({ projectRoot: flags['project-root'], kind: flags.kind, url: flags.url, branch: flags.branch, head: flags.head,
      merged: flags.merged === true, mergeCommit: flags['merge-commit'] });
  },
};

async function stateMain(command, argv) {
  let result;
  try {
    let v2Effect = false;
    let stdinCancelId;
    if (command === 'run-owned') {
      const index = argv.indexOf('--input'); const input = index >= 0 ? transitionJson(fs.readFileSync(argv[index + 1])) : null;
      v2Effect = true; stdinCancelId = input?.invocationId;
    }
    if (command === 'execute-transition') {
      const index = argv.indexOf('--input');
      if (index >= 0 && argv[index + 1]) v2Effect = transitionJson(fs.readFileSync(argv[index + 1])).request?.schemaVersion === 2;
    }
    const invoke = async services => await STATE_COMMANDS[command](argv, services);
    const value = v2Effect ? await withProcessCancellation(invoke, { stdinCancelId }) : await invoke({});
    result = { ok: !(v2Effect && value.status === 'execution-unverified'), command, ...value };
  } catch (error) {
    result = error instanceof Refusal || error instanceof ResumeError || error instanceof TransitionError || error instanceof ExecutionError || error instanceof MemoryError
      ? { ok: false, code: error.code, command, message: error.message, ...error.details }
      : { ok: false, code: 'internal', command, message: error.message };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.stderr.write(`FVS >> ${result.code}: ${result.message}\n`);
  const malformed = ['malformed-state', 'malformed-externals', 'malformed-specs', 'malformed-overrides'].includes(result.code);
  process.exitCode = result.code === 'cancelled' ? 130 : result.ok ? 0 : malformed ? 3 : ['usage', 'internal'].includes(result.code) ? 2 : 1;
}

const SUBCOMMANDS = { profile: profileCli };

async function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  if (Object.prototype.hasOwnProperty.call(STATE_COMMANDS, argv[0])) {
    await stateMain(argv[0], argv.slice(1));
    return;
  }
  if (['freeze', 'check', 'accept'].includes(argv[0])) {
    const { checkerCli } = await import('./fvs-checker.mjs');
    return checkerCli(argv);
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

if (invokedDirectly()) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`FVS_AUTO_ERROR: ${error.message}\n`);
  process.exitCode = 2;
});
