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
const { commandContext, nodeArguments, validateDocumentedNodeCommand } = require('./helpers/documented-node-command.cjs');

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

// Only profile/resolver statements belong to the read-only host-check sections.
function readOnlyExamples(text) {
  const checks = section(text, 'Prerequisites you install yourself') + section(text, 'Check your host');
  return [...checks.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap(m => m[1].split('\n'))
    .map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}
function namedReadOnlyExamples(text) {
  const lines = readOnlyExamples(text);
  return ['fvs-auto.mjs', 'fvs-probe-inventory.mjs'].map(name => {
    const matches = lines.filter(line => line.startsWith('node ') && line.includes('/' + name + '"'));
    assert.equal(matches.length, 1, `one documented ${name} check`); return matches[0];
  });
}
function assertOnlyReadOnlyExamples(text) {
  for (const command of readOnlyExamples(text)) validateDocumentedNodeCommand(command);
  assert.deepEqual(readOnlyExamples(text).sort(), namedReadOnlyExamples(text).sort(),
    'read-only prerequisite/profile examples may run only the declared profile and resolver');
}
function assertBoundedVerdictWording(text) {
  const stripped = text.replace(/supported-and-tested|unsupported-platform|unsupported/g, '');
  assert.doesNotMatch(stripped, /\bsupported\b/i);
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

  it('passes exact profile/resolver argv with a spaced literal HOME', (t) => {
    const context = commandContext(t), [profile, resolver] = namedReadOnlyExamples(raw);
    assert.deepEqual(nodeArguments(profile, context), [path.join(context.home, '.claude/scripts/fvs-auto.mjs'),
      'profile', '--project-root', '.', '--format', 'text']);
    assert.deepEqual(nodeArguments(resolver, context), [path.join(context.home, '.claude/scripts/fvs-probe-inventory.mjs'),
      'resolve', '--project-root', '.', '--format', 'text']);
    assert.ok(raw.includes('.aeneas/releases/<rev>/<platform>/'));
  });

  it('rejects suffix and substitution before Bash can write a sentinel', async (t) => {
    const [profile] = namedReadOnlyExamples(raw);
    const variants = [
      ['suffix', profile + '; : > "$CRATE_ROOT/write-sentinel"'],
      ['substitution', profile.replace('fvs-auto.mjs"', 'fvs-auto.mjs$(: > "$CRATE_ROOT/write-sentinel")"')],
    ];
    for (const [name, command] of variants) await t.test(name, (tt) => {
      const context = commandContext(tt), sentinel = path.join(context.crate, 'write-sentinel');
      let rejection = null;
      try { nodeArguments(command, context); } catch (error) { rejection = error; }
      assert.equal(fs.existsSync(sentinel), false, `${name} ran unsupported shell syntax before rejection`);
      assert.match(rejection?.message ?? '', /unsupported documented node invocation/);
      assert.throws(() => assertOnlyReadOnlyExamples(raw.replace(profile, command)), /unsupported documented node invocation/);
    });
  });

  it('keeps prerequisite checks read-only and manual FVS setup behind explicit consent', () => {
    for (const source of [
      'https://rustup.rs',
      'https://github.com/leanprover/elan',
      'https://github.com/AeneasVerif/aeneas/releases',
      'https://github.com/Beneficial-AI-Foundation/probe-aeneas/releases',
      'https://github.com/OrchestratorInc/agent-orchestrator/releases',
    ]) assert.ok(raw.includes(source), source);
    assert.match(doc, /The profile and resolver install no prerequisites/);
    assert.match(doc, /you install every prerequisite below yourself/);
    assertOnlyReadOnlyExamples(raw);
    const manual = flat(section(raw, 'Rc3 exact-source installation'));
    assert.match(manual, /After permission for these exact local writes/);
    assert.match(manual, /FVS installs none of those tools/);
    assert.match(manual, /installing FVS never runs `bd init`, migrates a store or changes Beads settings/);
    const unsafe = raw.replace('## Check your host', '## Check your host\n\n```bash\nnpm install forbidden-example\n```');
    assert.throws(() => assertOnlyReadOnlyExamples(unsafe), /unsupported documented node invocation/);
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

  it('names the rc3 run tuple and labels it unverified, with build-level evidence only, until a recorded run', () => {
    assert.ok(!tested.some((tuple) => tuple.charonVersion === '0.1.315' || tuple.aeneasRev.startsWith('5a392f4')),
      'the rc3 run tuple is now in TESTED_TUPLES: update the reference and this test');
    const matrix = section(raw, 'Tested matrix');
    const row = sentences(matrix).find((candidate) => candidate.startsWith('|') && candidate.includes('nightly-2026.11.09-5a392f4'));
    assert.ok(row, 'rc3 run tuple row');
    for (const fragment of ['Charon 0.1.315', 'Lean 4.35.0', 'unverified', 'build-level evidence only']) assert.ok(row.includes(fragment), fragment);
    assert.doesNotMatch(row, /supported-and-tested|\btested\b|confined probe-aeneas inventory/);
    assert.ok(!matrix.split('\n').some((line) => line.startsWith('|') && line.includes('0855ce1')), 'the earlier pilot tuple is no longer listed');
  });

  it('states that Linux is not validated, that FVS does not choose the tools, and that nothing else has a recorded run', () => {
    assert.match(doc, /Linux x86_64 is not validated for FVS extraction or acceptance/);
    assert.match(doc, /FVS does not choose your tools: your project pins its own Aeneas, Charon and Lean/);
    assert.match(doc, /A combination that is not listed here shows as `available-but-unverified`, and setup and extraction go on/);
    assert.match(doc, /No other platform, tuple or operation has a recorded run/);
    assert.doesNotMatch(doc, /Everything else is unsupported/);
  });

  it('never claims Linux support beyond the confined probe inventory', () => {
    for (const sentence of sentences(raw).filter((candidate) => /linux|x86_64/i.test(candidate))) {
      assert.ok(/confined probe-aeneas inventory/.test(sentence) || /\bnot\b|\bno\b|unsupported/i.test(sentence),
        `unqualified Linux sentence: ${sentence}`);
    }
  });

  it('keeps whole-guide support wording bound to the recorded verdict names', () => {
    assertBoundedVerdictWording(raw);
    assert.match(doc, /Neither an installed version line nor unit fixtures establish full AO\/Lean factory or cloud support/);
    for (const heading of ['Rc3 exact-source installation', 'Tested matrix']) {
      const blanket = raw.replace(`## ${heading}`, `## ${heading}\n\nFVS is supported on every host.`);
      assert.throws(() => assertBoundedVerdictWording(blanket), /not match/);
    }
  });

  it('keeps planning artefacts out of shipped text', () => {
    assert.doesNotMatch(raw, /\.planning|\.scratch|\bticket\b|\bmilestone\b|\broadmap\b/i);
  });
});

describe('auto-setup reference: running under Agent Orchestrator and Codex', () => {
  const topics = ['Permissions and command rules', 'Agent Orchestrator setup', 'Codex trust', 'Owner-run steps',
    'Starting a run with /goal', 'Reports, links and owner questions', 'Reading the primary checkout safely'];

  it('has one section for each setup topic, before the tested matrix', () => {
    const at = topics.map((topic) => raw.indexOf(`\n## ${topic}\n`));
    assert.ok(at.every((index, i) => index >= 0 && index < raw.indexOf('\n## Tested matrix') && (i === 0 || index > at[i - 1])),
      `sections in order: ${at}`);
  });

  it('keeps the command habits for every worker and the wildcard-rule warning', () => {
    const text = flat(section(raw, 'Permissions and command rules'));
    assert.match(text, /One simple command per call, for every worker/);
    assert.match(text, /no `cd` followed by a command/);
    assert.match(text, /words inside quoted text/);
    assert.match(text, /an ask rule takes precedence over an allow rule/);
    assert.match(text, /Describe commands in words/);
    assert.match(text, /about 30 minutes/);
    assert.match(text, /needs a twin for the rewritten form/);
  });

  it('keeps wildcard-message and API-restriction advice out of the default habits and states when each note applies', () => {
    const bullets = section(raw, 'Permissions and command rules').split(/\n(?=- \*\*)/).filter((b) => b.startsWith('- **'));
    const optional = bullets.filter((b) => /\(optional note\)/.test(b.split('\n')[0] + b.split('\n')[1]));
    const defaults = bullets.filter((b) => !optional.includes(b));
    assert.equal(defaults.length, 3, 'three default habits');
    assert.equal(optional.length, 3, 'three optional notes');
    for (const bullet of defaults) {
      assert.doesNotMatch(flat(bullet), /wildcard|`gh api`|`ao send`|Describe commands in words|wrapper/i, `default habit carries an optional-note topic: ${bullet.slice(0, 60)}`);
    }
    const byTitle = (pattern) => optional.find((b) => pattern.test(b));
    const wildcard = flat(byTitle(/Describe commands in words/));
    assert.match(wildcard, /This applies only if you wrote a permission rule that asks before any command starting with a wildcard/);
    assert.match(wildcard, /call `ao` itself directly, not through a wrapper/);
    const api = flat(byTitle(/Read pull requests without `gh api`/));
    assert.match(api, /This applies only if your permission rules or your project's own rules block `gh api`/);
    assert.match(api, /`gh pr view` and `gh pr diff`/);
    // The advice must agree with the read-only known-issues step, which allows `gh api` with an explicit read method.
    assert.match(api, /`gh api` with an explicit read method, `gh search` or `curl` on a public page/);
    assert.match(api, /records the search as `not checked`/);
    assert.match(flat(fs.readFileSync(path.join(ROOT, 'fv-skills', 'workflows', 'aeneas-extract.md'), 'utf8')),
      /a `gh api` call with an explicit read method, `gh search`, or `curl` on a public page/);
    assert.match(flat(section(raw, 'Permissions and command rules')), /The notes below apply only in the setup each one names/);
  });

  it('names the personal command-rewriting tool only inside its optional note', () => {
    const outside = raw.split('\n').filter((line) => /\brtk\b/i.test(line));
    assert.equal(outside.length, 1, 'RTK appears once');
    assert.match(flat(section(raw, 'Permissions and command rules')), /\(optional note\)[^]*RTK is one such tool/);
  });

  it('says why a linked .claude folder does not work, as the permission helper itself checks', () => {
    const helper = fs.readFileSync(path.join(ROOT, 'scripts', 'fvs-auto-actor-permissions.py'), 'utf8');
    assert.ok(helper.includes('actor .claude is not a real directory'), 'the helper no longer refuses a linked .claude');
    const text = flat(section(raw, 'Agent Orchestrator setup'));
    assert.match(text, /refuses a `\.claude` that is a link/);
    assert.match(text, /The one file never to share between actors is `settings\.local\.json`, the per-actor grants file/);
    assert.match(text, /with `settings\.local\.json` kept a real file in each worktree, was checked end to end on AO 0\.14\.10 in a throwaway project/);
    assert.match(text, /Recheck it on other AO versions/);
    assert.doesNotMatch(text, /Never share one settings file|Both are untested/);
  });

  it('warns that a full config replacement drops what it does not name, and ties the model rule to the config', () => {
    const text = flat(section(raw, 'Agent Orchestrator setup'));
    assert.match(text, /`--config-json` is different: it replaces the whole config/);
    assert.match(text, /Read the saved config first, change one field, send the whole object back/);
    assert.match(text, /Model aliases: writer = <model id>/);
    assert.match(text, /FVS names no model/);
    assert.match(text, /separate from FVS's own model settings \(`\/fvs:configure`, `model-profiles\.md`\)/);
    assert.ok(fs.existsSync(path.join(ROOT, 'fv-skills', 'references', 'model-profiles.md')));
  });

  it('says rule changes reach only later sessions, and how a live session re-reads them', () => {
    const text = flat(section(raw, 'Agent Orchestrator setup'));
    assert.match(text, /Rule changes reach only sessions that start afterwards/);
    assert.match(text, /message every live session/);
    assert.match(text, /re-read them with `ao project get <id> --json`/);
  });

  it('marks the Codex facts as seen in one setup and gives the model-free check', () => {
    const text = flat(section(raw, 'Codex trust'));
    assert.match(text, /seen in one setup; re-check it on your version/);
    assert.match(text, /`trust_level = "trusted"`/);
    assert.match(text, /`trusted_hash`/);
    assert.match(text, /`codex debug prompt-input`/);
  });

  it('names the owner-run steps and points the agreement to the helper and the seat page', () => {
    const text = flat(section(raw, 'Owner-run steps'));
    assert.match(text, /`auto-seats\.md`/);
    assert.match(text, /`fvs-auto-agreement\.mjs`/);
    assert.match(text, /The helper never records anything/);
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'fvs-auto-agreement.mjs')));
  });

  it('gives a goal wording that accepts an owner gate as done', () => {
    const text = flat(section(raw, 'Starting a run with /goal'));
    assert.match(text, /\/goal Run the auto track under the current agreement until the first checked proof\. Reaching an owner gate, reported once in plain chat, counts as done for now\./);
    assert.match(text, /say so once in plain chat and stop/);
  });

  it('follows an app-only link with the plain absolute path and asks owner questions in plain words', () => {
    const text = flat(section(raw, 'Reports, links and owner questions'));
    assert.match(text, /always followed by the plain absolute path/);
    assert.match(text, /what happens next, what it costs and what stays blocked/);
    assert.match(text, /recommended, with a one-line reason/);
  });
});

describe('auto-setup reference: probe statuses and stage lines', () => {
  const rowFor = (heading, key) => {
    const row = section(raw, heading).split('\n').find((line) => line.startsWith(`| \`${key}\` |`));
    assert.ok(row, `row ${key}`);
    return flat(row);
  };

  it('names every probe status as a row', () => {
    for (const status of ['qualified', 'present-unqualified', 'unverified-blocked', 'missing', 'not-checked']) {
      rowFor('Probes and stage lines', status);
    }
  });

  it('says when a probe is unverified-blocked and which probe-lean version stays blocked', () => {
    const row = rowFor('Probes and stage lines', 'unverified-blocked');
    assert.match(row, /its `--version` run fails/);
    assert.match(row, /`probe-lean` at a version the Lean graph step refuses/);
    assert.match(row, /runs reduced, without it, until you replace it/);
    assert.doesNotMatch(row, /no route/);
    assert.match(row, /accepts `probe-lean` 0\.14\.0/);
    assert.match(row, /0\.24\.0 is accepted by the Lean graph step only beside a version 2 Lean constants record/);
    assert.match(row, /prints `unverified-blocked` for 0\.24\.0/);
  });

  it('says not-checked covers a host with no read-only confinement', () => {
    const row = rowFor('Probes and stage lines', 'not-checked');
    assert.match(row, /no read-only confinement on this host to run the `--version` check in/);
    assert.match(row, /runs reduced, without it, until the check can run/);
    assert.doesNotMatch(row, /no route/);
  });

  it('reads the provenance disagreement as a warning that the next step only clears', () => {
    const row = flat(raw.split('\n').find((line) => line.startsWith('| `translation.json`, `lake-manifest.json` and `aeneas-config.yml` disagree')));
    assert.match(row, /\(a warning: the run goes on\)/);
    assert.match(row, /Nothing here blocks the run: To clear the provenance warning: Regenerate the extraction so/);
    assert.doesNotMatch(row, /unblock/i);
  });

  it('says a stage runs reduced when only probes are lost, and has no route only without ao, lean or a recorded probe check', () => {
    const own = flat(section(raw, 'Probes and stage lines'));
    assert.match(own, /each need `ao` and `lean` to have a route at all/);
    assert.match(own, /A lost probe does not stop them: the stage runs without that probe's output, and the output is labelled reduced/);
    assert.match(own, /So reduced output never promises proof acceptance, and without `probe-lean` the strict lane refuses acceptance until it is usable/);
    assert.match(own, /The build check that `\/fvs:auto-execute` runs in a fresh clean copy needs none of the probes/);
    assert.doesNotMatch(own, /all five probes|has no route here until/);
    const reduced = rowFor('Probes and stage lines', 'ready, reduced');
    assert.match(reduced, /`ao` and `lean` are present, and only probes are missing, not checked or unusable/);
    assert.match(reduced, /The line names each lost probe and what that costs, says reduced output never promises proof acceptance/);
    assert.match(reduced, /`To restore, the owner can \.\.\.` and `\(warning, not a stop\)`/);
    assert.doesNotMatch(reduced, /agent can/);
    const noRoute = rowFor('Probes and stage lines', 'no route here');
    assert.match(noRoute, /`ao` or `lean` is missing, or the recorded profile has no usable status for a probe/);
    assert.doesNotMatch(noRoute, /a probe is missing/);
    assert.match(own, /repeats a `ready, unverified` or `ready, reduced` line as a warning/);
  });

  it('keeps the stage-readiness rule in the stage-readiness section only', () => {
    const own = section(raw, 'Probes and stage lines');
    assert.ok(!raw.replace(own, '').includes('no route here'), 'auto-setup.md says it outside its own stage-readiness section');
    const others = [
      path.join('fv-skills', 'workflows', 'auto-top-specs.md'),
      path.join('fv-skills', 'workflows', 'auto-init.md'),
      path.join('fv-skills', 'references', 'auto-witness.md'),
      path.join('fv-skills', 'references', 'auto-resume.md'),
      path.join('fv-skills', 'references', 'auto-transitions.md'),
      path.join('commands', 'fvs', 'help.md'),
      path.join('commands', 'fvs', 'auto-init.md'),
    ];
    for (const file of others) {
      const text = flat(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      assert.doesNotMatch(text, /no route here|has no route|all five probes/, `${file} restates the stage-readiness rule`);
    }
    for (const file of others.slice(0, 3).concat(others[5])) {
      assert.match(flat(fs.readFileSync(path.join(ROOT, file), 'utf8')), /auto-setup\.md|Probes and stage lines/, `${file} points to the stage-readiness section`);
    }
  });

  it('says an empty override variable counts as unset and only an unusable value is refused', () => {
    const text = flat(section(raw, 'Probes and stage lines'));
    assert.match(text, /An empty variable counts as unset, and the default place is used\./);
    assert.match(text, /A variable with a value that is unusable is refused with its name in the reason, and the lookup never falls back to the default place/);
    assert.doesNotMatch(text, /is set but unusable/);
  });

  it('says a refused override leaves the helpers not-checked with the reason and does not abort setup', () => {
    const text = flat(section(raw, 'Probes and stage lines'));
    assert.match(text, /The profile then still prints its table, with the helpers `not-checked` and the refusal as the reason, and setup does not abort\./);
    assert.doesNotMatch(text, /stops with the refusal|refusal as its only output/);
  });

  it('does not quote the engine messages it describes', () => {
    assert.doesNotMatch(flat(section(raw, 'Probes and stage lines')), /Optional|nothing stops without it|degraded route/);
  });
});

describe('README pointer', () => {
  it('links the setup reference', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    assert.ok(readme.includes('(fv-skills/references/auto-setup.md)'));
  });
});
