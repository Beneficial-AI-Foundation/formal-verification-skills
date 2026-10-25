'use strict';

// The auto-track setup reference is a claim about this host and project, so
// it is checked against the code that makes those claims: the profile's real
// text output, its usage text, its next-step wording and TESTED_TUPLES.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const AUTO_SCRIPT = path.join(ROOT, 'scripts', 'fvs-auto.mjs');
const INVENTORY_SCRIPT = path.join(ROOT, 'scripts', 'fvs-probe-inventory.mjs');
const REFERENCE = path.join(ROOT, 'fv-skills', 'references', 'auto-setup.md');
const FIXTURES = path.join(__dirname, 'fixtures', 'auto-profile');

// The command a user runs to check each tool, as the reference must print it.
const VERSION_CHECKS = {
  ao: 'ao --version',
  rustup: 'rustup --version',
  rustc: 'rustc -vV',
  cargo: 'cargo --version',
  elan: 'elan --version',
  lake: 'lake --version',
  aeneas: 'aeneas -version',
  charon: 'charon version',
  'probe-aeneas': 'probe-aeneas --version',
  'probe-rust': 'probe-rust --version',
  scip: 'scip --version',
  // The resolver finds probe-lean only under the project's Lean version.
  'probe-lean': '~/.local/bin/probe-lean-v4.31.0 --version',
  'rust-analyzer': 'rust-analyzer --version',
};

// Next steps the profile prints verbatim whatever the host or project. The
// ones that name a revision, platform or path are described, not quoted.
const STATIC_NEXT_STEPS = [
  'Install Agent Orchestrator and put its ao CLI on PATH, then rerun the profile.',
  'Install Rust with rustup (https://rustup.rs), then rerun the profile.',
  'Run rustc -vV in the crate directory yourself to confirm the toolchain.',
  'Add a lean-toolchain file to the project root pinning the Lean version your Aeneas backend uses.',
  'Create the Lean project (a lakefile.toml that requires the Aeneas Lean backend) in the project root.',
  'Install elan (https://github.com/leanprover/elan); it provides lake and the pinned Lean toolchain.',
  'Run lake --version in the project root yourself to confirm the pinned toolchain.',
  'Require the Aeneas Lean backend in lakefile.toml ([[require]] name = "aeneas" with a pinned rev).',
  'Regenerate the extraction so translation.json, lake-manifest.json and aeneas-config.yml agree, then rerun the profile.',
  'Install the Charon and Lean versions this Aeneas revision was tested with, or move to another Aeneas revision.',
  'None required to extract; results with this tuple stay unverified until a confined run is recorded for it.',
  'Extract the crate with the shared aeneas-extract workflow (/fvs:aeneas-extract), then rerun the profile.',
  'Pin the Charon and Lean versions this Aeneas revision was tested with (or move to another Aeneas revision), then re-extract.',
];

const flat = (text) => text.replace(/\s+/g, ' ');

// Table rows stay whole; prose is split into sentences.
function sentences(text) {
  return text.split(/\n\s*\n/).flatMap((block) => (block.trimStart().startsWith('|')
    ? block.split('\n').map((row) => row.trim()).filter(Boolean)
    : flat(block).trim().split(/(?<=[.!?])\s+/)));
}

function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}`);
  assert.ok(start >= 0, `section ${heading}`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

let tested = null;
let linux = null;
let doc = null;
let raw = null;
let outputs = null;

// Runs the real profile CLI with no tool on PATH (the fixture home holds none),
// so the verdicts a fresh host prints do not depend on this machine's tools.
function profileText(projectRoot, format = 'text') {
  const run = spawnSync(process.execPath, [AUTO_SCRIPT, 'profile', '--project-root', projectRoot, '--format', format], {
    encoding: 'utf8',
    env: {
      HOME: path.join(FIXTURES, 'home'),
      PATH: path.join(FIXTURES, 'home'),
      FVS_TOOLS_HOME: path.join(FIXTURES, 'no-fvs-tools'),
    },
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

before(async () => {
  ({ TESTED_TUPLES: tested } = await import(pathToFileURL(INVENTORY_SCRIPT).href));
  linux = await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-probe-linux.mjs')).href);
  raw = fs.readFileSync(REFERENCE, 'utf8');
  doc = flat(raw);
  outputs = ['fresh', 'pilot', 'tested'].map((name) => profileText(path.join(FIXTURES, name)));
});

describe('auto-setup reference: profile vocabulary', () => {
  it('documents every profile item', () => {
    const { items } = JSON.parse(profileText(path.join(FIXTURES, 'fresh'), 'json'));
    assert.ok(items.length >= 6);
    for (const { id } of items) assert.ok(raw.includes(`| \`${id}\` |`), `item ${id}`);
  });

  it('documents every verdict the profile can print, by its exact name', () => {
    const usage = spawnSync(process.execPath, [AUTO_SCRIPT, '--help'], { encoding: 'utf8' }).stdout;
    const verdicts = flat(usage).match(/one verdict per item: ([^.]+)\./)[1].split(/,\s*|\s+or\s+/);
    assert.equal(verdicts.length, 6);
    for (const verdict of verdicts) assert.ok(raw.includes(`| \`${verdict}\` |`), `verdict ${verdict}`);
    const printed = outputs.join('\n').matchAll(/^\w+: ([a-z-]+) - /gm);
    for (const [, verdict] of printed) assert.ok(verdicts.includes(verdict), `undocumented verdict ${verdict}`);
  });

  it('quotes the next steps the profile prints verbatim', () => {
    const script = fs.readFileSync(AUTO_SCRIPT, 'utf8');
    for (const step of STATIC_NEXT_STEPS) {
      assert.ok(script.includes(step), `the profile no longer prints: ${step}`);
      assert.ok(doc.includes(step), `reference lacks next step: ${step}`);
    }
  });
});

describe('auto-setup reference: prerequisites', () => {
  it('documents every tool the failure messages name, each with its version-check command', () => {
    // The script's own text is a superset of any one host's printed messages.
    const text = [fs.readFileSync(AUTO_SCRIPT, 'utf8'), ...outputs].join('\n');
    const named = Object.keys(VERSION_CHECKS)
      .filter((tool) => new RegExp(`(?<![\\w-])${tool}(?![\\w-])`, 'i').test(text));
    // The profile text must exercise the whole fresh-host path, not a corner.
    for (const tool of ['ao', 'rustup', 'cargo', 'rustc', 'elan', 'lake', 'aeneas', 'charon', 'probe-aeneas']) {
      assert.ok(named.includes(tool), `failure messages no longer name ${tool}`);
    }
    for (const tool of named) assert.ok(raw.includes(`\`${VERSION_CHECKS[tool]}\``), `${tool}: ${VERSION_CHECKS[tool]}`);
  });

  it('documents every tested helper with its version-check command', () => {
    const helpers = new Set(tested.flatMap((tuple) => Object.values(tuple.platforms).flatMap((platform) => Object.keys(platform.helpers))));
    assert.ok(helpers.size >= 4);
    for (const helper of helpers) {
      assert.ok(VERSION_CHECKS[helper], `helper ${helper} has no known version-check command`);
      assert.ok(raw.includes(`\`${VERSION_CHECKS[helper]}\``), helper);
    }
    for (const tuple of tested) {
      const leanVersion = tuple.leanToolchain.split(':').pop();
      assert.ok(raw.includes(`\`~/.local/bin/probe-lean-${leanVersion} --version\``), `probe-lean for ${leanVersion}`);
    }
  });

  it('documents the Rust components each tested helper needs, with a command that checks them', () => {
    const blocks = raw.split(/\n\s*\n/);
    let required = 0;
    for (const tuple of tested) {
      for (const helper of Object.values(tuple.platforms).flatMap((platform) => Object.values(platform.helpers))) {
        if (!helper.components) continue;
        const toolchain = helper.version.match(/\d+\.\d+\.\d+/)[0];
        const command = `rustup component list --installed --toolchain ${toolchain}`;
        const block = blocks.find((candidate) => candidate.includes(`\`${command}\``));
        assert.ok(block, `no check for the ${toolchain} components`);
        for (const component of helper.components) {
          assert.ok(block.includes(`\`${component}\``), `${component} is not named beside its check`);
          required += 1;
        }
      }
    }
    assert.ok(required >= 2, 'the tested helpers no longer list required components');
  });

  it('documents the confinement each tested platform needs, with its source and check', () => {
    const isolations = new Set(tested.flatMap((tuple) => Object.values(tuple.platforms).map((platform) => platform.isolation)));
    // A new isolation mechanism must come with its own documented prerequisite.
    assert.deepEqual([...isolations].sort(), ['bubblewrap', 'sandbox-exec']);
    assert.ok(raw.includes('https://github.com/containers/bubblewrap'));
    for (const binary of [linux.BWRAP, linux.XZ]) assert.ok(raw.includes(`\`${binary} --version\``), binary);
    assert.ok(raw.includes('`/usr/bin/sandbox-exec`'));
    // The resolver's own guidance, quoted, and no advice to loosen system policy.
    for (const guidance of [
      'Check whether unprivileged user namespaces are permitted, including any AppArmor restrictions.',
      'FVS does not change system security policy.',
    ]) {
      assert.ok(fs.readFileSync(INVENTORY_SCRIPT, 'utf8').includes(guidance), `the resolver no longer prints: ${guidance}`);
      assert.ok(doc.includes(guidance), `reference lacks: ${guidance}`);
    }
    assert.doesNotMatch(raw, /\bsysctl\b|apparmor_parser|aa-disable|unprivileged_userns_clone|setenforce/i);
  });

  it('says that an ignore rule does not untrack committed files', () => {
    assert.match(doc, /does not untrack files already committed/);
    assert.ok(raw.includes('git ls-files .formalising/'));
  });

  it('shows how to run the profile and the resolver that prints helper setup steps', () => {
    assert.ok(raw.includes('node ~/.claude/scripts/fvs-auto.mjs profile --project-root . --format text'));
    assert.ok(raw.includes('fvs-probe-inventory.mjs resolve --project-root . --format text'));
    assert.ok(raw.includes('.aeneas/releases/<rev>/<platform>/'));
  });

  it('gives an official source for each prerequisite and installs nothing itself', () => {
    for (const source of [
      'https://rustup.rs',
      'https://github.com/leanprover/elan',
      'https://github.com/AeneasVerif/aeneas/releases',
      'https://github.com/Beneficial-AI-Foundation/probe-aeneas/releases',
      'https://github.com/OrchestratorInc/agent-orchestrator/releases',
    ]) assert.ok(raw.includes(source), source);
    assert.match(doc, /This walkthrough and the profile install nothing/);
    assert.match(doc, /you install every prerequisite below yourself/);
    // The walkthrough must not describe an installer next to its no-install promise.
    assert.doesNotMatch(raw, /installer|consent-gated|FVS-owned/i);
  });

  it('explains how .formalising stays out of git and how to check it', () => {
    assert.match(doc, /\.formalising\//);
    assert.ok(raw.includes('info/exclude'));
    assert.ok(raw.includes('git check-ignore'));
    assert.match(doc, /Nothing in this walkthrough edits your git configuration/);
  });
});

describe('auto-setup reference: tested matrix', () => {
  it('lists exactly the tested tuple and platform pairs recorded in TESTED_TUPLES', () => {
    const matrix = section(raw, 'Tested matrix');
    const rows = sentences(matrix).filter((row) => row.startsWith('|') && /confined probe-aeneas inventory/.test(row));
    const documented = rows.map((row) => {
      const cells = row.split('|').map((cell) => cell.trim());
      return `${cells[2]} @ ${cells[3]}`;
    }).sort();
    const recorded = tested.flatMap((tuple) => Object.keys(tuple.platforms).map((platform) => `${tuple.id} @ ${platform}`)).sort();
    assert.deepEqual(documented, recorded);
    for (const tuple of tested) {
      for (const [platform, evidence] of Object.entries(tuple.platforms)) {
        const row = rows.find((candidate) => candidate.includes(tuple.id) && candidate.includes(platform));
        assert.ok(row.includes(evidence.isolation), `${platform} isolation`);
        const helperLine = sentences(matrix)
          .find((candidate) => !candidate.startsWith('|') && candidate.includes(platform) && candidate.includes('helpers'));
        assert.ok(helperLine, `helper versions for ${platform}`);
        for (const [name, helper] of Object.entries(evidence.helpers)) {
          assert.ok(helperLine.includes(helper.version), `${platform} ${name}: ${helper.version}`);
        }
      }
      for (const fragment of [
        `Aeneas ${tuple.aeneasRev.slice(0, 8)}`,
        `Charon ${tuple.charonVersion}`,
        `Lean ${tuple.leanToolchain.split(':v')[1]}`,
        `probe-aeneas v${tuple.probeAeneasVersion}`,
        tuple.testedWith,
      ]) assert.ok(matrix.includes(fragment), fragment);
    }
  });

  it('names the pilot tuple and labels it unverified until a recorded run', () => {
    assert.ok(!tested.some((tuple) => tuple.charonVersion === '0.1.274' || tuple.aeneasRev.startsWith('0855ce1')),
      'the pilot tuple is now in TESTED_TUPLES: update the reference and this test');
    const row = sentences(section(raw, 'Tested matrix')).find((candidate) => candidate.includes('nightly-2026.09.30-0855ce1'));
    assert.ok(row, 'pilot tuple row');
    for (const fragment of ['Charon 0.1.274', 'Lean 4.31.0', 'unverified']) assert.ok(row.includes(fragment), fragment);
    assert.doesNotMatch(row, /supported-and-tested|\btested\b/);
  });

  it('states that Linux is not validated for extraction or acceptance and that everything else is unsupported', () => {
    assert.match(doc, /Linux x86_64 is not validated for FVS extraction or acceptance/);
    assert.match(doc, /Everything else is unsupported/);
  });

  it('never claims Linux support beyond the confined probe inventory', () => {
    for (const sentence of sentences(raw).filter((candidate) => /linux|x86_64/i.test(candidate))) {
      assert.ok(/confined probe-aeneas inventory/.test(sentence) || /\bnot\b|\bno\b|unsupported/i.test(sentence),
        `unqualified Linux sentence: ${sentence}`);
    }
  });

  it('has no blanket "supported" wording', () => {
    const stripped = raw.replace(/supported-and-tested|unsupported-platform|unsupported/g, '');
    assert.doesNotMatch(stripped, /\bsupported\b/i);
  });

  it('keeps planning artefacts out of shipped text', () => {
    assert.doesNotMatch(raw, /\.planning|\.scratch|\bticket\b|\bmilestone\b|\broadmap\b/i);
  });
});

describe('README pointer', () => {
  it('links the setup reference', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.ok(readme.includes('(fv-skills/references/auto-setup.md)'));
  });
});
