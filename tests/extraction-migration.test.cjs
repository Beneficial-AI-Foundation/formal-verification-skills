'use strict';

// The migration reference may describe only what the scripts implement. The
// engine's usage text and constants are the authority: every subcommand, flag
// and slash command the shipped extraction documentation names must exist, and
// the preserved fields it lists must be the ones `migrate` writes.
//
// Pure node:test + node:assert/strict, zero npm dependencies.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'scripts', 'fvs-extract-patches.mjs');
const REFERENCE = path.join(ROOT, 'fv-skills', 'references', 'extraction-patch-migration.md');
const DOCS = [
  REFERENCE,
  path.join(ROOT, 'fv-skills', 'workflows', 'aeneas-extract.md'),
  path.join(ROOT, 'commands', 'fvs', 'aeneas-extract.md'),
];

const WORKFLOW = path.join(ROOT, 'fv-skills', 'workflows', 'aeneas-extract.md');
const FIXTURES = path.join(__dirname, 'fixtures', 'extract-patches');
const LEDGER_FILES = ['src-modifications.diff', 'src-modifications.json', 'src-modifications.md'];
const TMP = fs.realpathSync(os.tmpdir());
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(TMP, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function run(...args) {
  const result = spawnSync(process.execPath, [ENGINE, ...args], { cwd: ROOT, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // left null: the assertion on json reports the raw output
  }
  return { status: result.status, stdout: result.stdout, json };
}

function setConfig(root, config) {
  fs.mkdirSync(path.join(root, '.formalising'), { recursive: true });
  fs.writeFileSync(path.join(root, '.formalising', 'fvs-config.json'), JSON.stringify(config));
}

// A legacy project: the fixture crate carrying the changes its ledger records.
function legacyProject(config) {
  const root = temporaryDirectory('fvs-migration-project-');
  fs.cpSync(path.join(FIXTURES, 'crate'), root, { recursive: true });
  for (const file of ['Cargo.toml', 'src/lib.rs', 'src/limits.rs']) fs.chmodSync(path.join(root, file), 0o644);
  for (const name of LEDGER_FILES) fs.copyFileSync(path.join(FIXTURES, 'legacy', name), path.join(root, name));
  const applied = spawnSync('git', ['apply', 'src-modifications.diff'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(root), GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(applied.status, 0, applied.stderr);
  if (config) setConfig(root, config);
  return root;
}

// What the owner does by hand after `migrate`: put the pristine source back.
function restorePristine(root) {
  for (const file of ['src/lib.rs', 'src/limits.rs']) fs.copyFileSync(path.join(FIXTURES, 'crate', file), path.join(root, file));
}

function prepare(root) {
  const out = path.join(temporaryDirectory('fvs-migration-out-'), 'copy');
  const prepared = run('prepare', '--project-root', root, '--out', out);
  assert.equal(prepared.status, 0, prepared.stdout);
  return out;
}

// One of the workflow's own bash blocks, run against a real prepared copy and a gate directory
// holding the given packets. The result carries the gate directory it ran against.
function workflowCheck(name, root, out, packets) {
  const gate = temporaryDirectory('fvs-migration-gate-');
  for (const [file, text] of Object.entries(packets)) fs.writeFileSync(path.join(gate, file), text);
  const block = fs.readFileSync(WORKFLOW, 'utf8').match(new RegExp(`\`\`\`bash\\n# ${name}\\n([\\s\\S]*?)\\n\`\`\``));
  assert.ok(block, `the workflow has no ${name} block`);
  const result = spawnSync('bash', ['-c', block[1]], {
    encoding: 'utf8',
    env: { ...process.env, PATCH_ENGINE: ENGINE, CRATE_ROOT: root, OUT: out, GATE_DIR: gate },
  });
  return { ...result, gate, output: `${result.stdout}${result.stderr}` };
}
const ratificationCheck = (root, out, packets) => workflowCheck('ratification-check', root, out, packets);
const recordCheck = (root, out, packets) => workflowCheck('record-check', root, out, packets);

const engineSource = fs.readFileSync(ENGINE, 'utf8');
const usage = spawnSync(process.execPath, [ENGINE, '--help'], { encoding: 'utf8' }).stdout;
const subcommands = [...usage.matchAll(/node fvs-extract-patches\.mjs (\S+)/g)].map((match) => match[1]);
const flags = new Set(usage.match(/--[a-z][a-z-]*/g));

describe('Migration reference: names only what the scripts provide', () => {
  const reference = fs.existsSync(REFERENCE) ? fs.readFileSync(REFERENCE, 'utf8') : '';

  it('exists', () => {
    assert.ok(reference.length > 0, 'fv-skills/references/extraction-patch-migration.md is missing');
  });

  it('describes the shipped migrate subcommand', () => {
    assert.ok(subcommands.includes('migrate'), 'the engine no longer ships migrate');
    assert.match(reference, /fvs-extract-patches\.mjs migrate/);
  });

  for (const file of DOCS) {
    const name = path.relative(ROOT, file);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

    it(`${name} runs only engine subcommands the script provides`, () => {
      for (const [, command] of text.matchAll(/fvs-extract-patches\.mjs[" ]+([a-z][a-z-]*)/g)) {
        assert.ok(subcommands.includes(command), `${name} names engine subcommand ${command}, which the script lacks`);
      }
    });

    it(`${name} passes only flags the engine accepts`, () => {
      for (const line of text.split('\n').filter((entry) => /fvs-extract-patches\.mjs|PATCH_ENGINE"/.test(entry))) {
        for (const flag of line.match(/--[a-z][a-z-]*/g) ?? []) {
          assert.ok(flags.has(flag) || flag === '--help', `${name} passes ${flag}, which the engine does not accept: ${line.trim()}`);
        }
      }
    });
  }

  it('names only slash commands that ship', () => {
    for (const [, command] of reference.matchAll(/\/fvs:([a-z][a-z-]*)/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, 'commands', 'fvs', `${command}.md`)), `/fvs:${command} does not exist`);
    }
  });

  it('lists exactly the fields migrate carries into each patch header', () => {
    const block = engineSource.match(/const MIGRATED_FIELDS = \[([\s\S]*?)\n\];/)[1];
    const migrated = [...block.matchAll(/\['[a-z]+', '([A-Za-z]+)'\]/g)].map((match) => match[1]);
    assert.deepEqual(migrated, ['Classification', 'Assumptions', 'Obligations', 'Evidence', 'Ratification']);
    for (const label of migrated) {
      assert.ok(reference.includes(`\`${label}:\``), `reference does not list the migrated ${label}: field`);
    }
  });

  it('names the inactive marker the engine writes and the mode key it reads', () => {
    const marker = engineSource.match(/const INACTIVE_MARKER = '([^']+)'/)[1];
    assert.ok(reference.includes(marker), `reference does not name ${marker}`);
    assert.ok(reference.includes('extraction.mode'));
  });

  it('says migration does not re-establish equivalence', () => {
    assert.match(reference, /does not (re-establish|prove)[^.]*equivalen/i);
  });

  it('claims no automation beyond migrate', () => {
    assert.match(reference, /no\s+other\s+migration\s+command/i);
  });
});

describe('CHANGELOG: the patch-mode default is recorded under Unreleased', () => {
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const unreleased = changelog.split(/^## \[/m).find((block) => block.startsWith('Unreleased]')) ?? '';

  it('names the breaking default, unchanged legacy projects, the procedure and the equivalence caveat', () => {
    assert.match(unreleased, /translation patch/i);
    assert.match(unreleased, /breaking/i);
    assert.match(unreleased, /legacy/i);
    assert.match(unreleased, /migrate/i);
    assert.match(unreleased, /extraction-patch-migration\.md/);
    assert.match(unreleased, /does not prove[^.]*equivalen|not (a )?proof[^.]*equivalen/i);
  });
});

describe('Migration sequence: starting from an explicit legacy mode', () => {
  it('refuses check as mixed until the mode is changed, then accepts it', () => {
    const root = legacyProject({ extraction: { mode: 'legacy-source-ledger' } });
    assert.equal(run('migrate', '--project-root', root).status, 0);
    restorePristine(root);

    const early = run('check', '--project-root', root);
    assert.equal(early.status, 4, early.stdout);
    assert.equal(early.json.code, 'mixed-mode');

    setConfig(root, { extraction: { mode: 'translation-patches' } });
    const late = run('check', '--project-root', root);
    assert.equal(late.status, 0, late.stdout);
    assert.equal(late.json.mode, 'translation-patches');
  });

  it('is documented in that order', () => {
    const reference = fs.readFileSync(REFERENCE, 'utf8');
    const manual = reference.slice(reference.indexOf('## The manual steps'));
    const steps = [...manual.matchAll(/^(\d+)\. ([\s\S]*?)(?=^\d+\. |\n<\/migration>)/gm)].map((match) => [Number(match[1]), match[2]]);
    const modeStep = steps.find(([, text]) => text.includes('extraction.mode'))?.[0];
    const checkStep = steps.find(([, text]) => /fvs-extract-patches\.mjs check/.test(text))?.[0];
    assert.ok(modeStep && checkStep, 'the manual steps must name the mode change and the check');
    assert.ok(modeStep < checkStep, `step ${modeStep} (mode change) must come before step ${checkStep} (check)`);

    const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    const migrate = changelog.split(/^## \[/m).find((block) => block.startsWith('Unreleased]')).split('\n- ')
      .find((bullet) => bullet.startsWith('To migrate'))?.replace(/\s+/g, ' ');
    assert.ok(migrate, 'the CHANGELOG has no migration bullet');
    assert.ok(migrate.indexOf('extraction.mode') < migrate.indexOf('run `check`'), 'the CHANGELOG must change the mode before check');
  });
});

describe('Migrated Category-B patches need a ratification bound to their current hash', () => {
  function migrated() {
    const root = legacyProject();
    assert.equal(run('migrate', '--project-root', root).status, 0);
    restorePristine(root);
    return root;
  }

  const LEGACY_PACKET = { 'M2.md': '# gate packet M2\nequivalence-ratified: 2026-05-08\n' };
  const patchOf = (root) => path.join(root, 'translation-patches', 'lib-legacy-M2.patch');
  const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const bound = (root) => ({
    ...LEGACY_PACKET,
    'M2-rebound.md': `patch-file: lib-legacy-M2.patch\npatch-sha256: ${sha256(patchOf(root))}\nequivalence-ratified: stamped by the owner\n`,
  });

  it('does not count the legacy approval, which records no patch hash', () => {
    const root = migrated();
    const checked = ratificationCheck(root, prepare(root), LEGACY_PACKET);
    assert.notEqual(checked.status, 0, checked.stdout + checked.stderr);
    assert.match(checked.stdout + checked.stderr, /lib-legacy-M2\.patch/);
  });

  it('counts a packet that carries the token and names the patch and its current hash', () => {
    const root = migrated();
    const checked = ratificationCheck(root, prepare(root), bound(root));
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  });

  it('does not count a packet bound to the hash but missing the token', () => {
    const root = migrated();
    const unstamped = { 'M2-rebound.md': `patch-file: lib-legacy-M2.patch\npatch-sha256: ${sha256(patchOf(root))}\n` };
    assert.notEqual(ratificationCheck(root, prepare(root), unstamped).status, 0);
  });

  it('invalidates the ratification when the migrated patch is edited afterwards', () => {
    const root = migrated();
    const packets = bound(root);
    assert.equal(ratificationCheck(root, prepare(root), packets).status, 0);

    fs.writeFileSync(patchOf(root), fs.readFileSync(patchOf(root), 'utf8').replace(/^Why:.*$/m, (line) => `${line} (edited)`));
    const checked = ratificationCheck(root, prepare(root), packets);
    assert.notEqual(checked.status, 0, 'a ratification for the old bytes counted for the edited patch');
    assert.match(checked.stdout + checked.stderr, /lib-legacy-M2\.patch/);
  });

  it('ignores patches that are not Category B', () => {
    const root = migrated();
    const checked = ratificationCheck(root, prepare(root), bound(root));
    assert.doesNotMatch(checked.stdout + checked.stderr, /M1|M3/);
  });

  it('ratifies an already-installed migrated patch without touching its bytes or its series entry', () => {
    const root = migrated();
    const series = path.join(root, 'translation-patches', 'series');
    const before = { series: fs.readFileSync(series), patch: fs.readFileSync(patchOf(root)) };

    // The documented continuation: bind the packet to the installed bytes, then check and re-prepare.
    const out = prepare(root);
    assert.equal(ratificationCheck(root, out, bound(root)).status, 0);
    const checked = run('check', '--project-root', root);
    assert.equal(checked.status, 0, checked.stdout);
    assert.deepEqual(fs.readFileSync(series), before.series, 'ratification changed the series');
    assert.deepEqual(fs.readFileSync(patchOf(root)), before.patch, 'ratification changed the patch bytes');
    assert.equal(recordCheck(root, prepare(root), bound(root)).status, 0);

    // Installing it again, as for a new proposal, is what the engine refuses.
    fs.appendFileSync(series, 'lib-legacy-M2.patch\n');
    const duplicated = run('check', '--project-root', root);
    assert.equal(duplicated.status, 5, duplicated.stdout);
    assert.equal(duplicated.json.code, 'invalid-input');
  });
});

describe('Retained rejected proposals are an audit trail, not orphan records', () => {
  function migrated() {
    const root = legacyProject();
    assert.equal(run('migrate', '--project-root', root).status, 0);
    restorePristine(root);
    return root;
  }

  const patchOf = (root) => path.join(root, 'translation-patches', 'lib-legacy-M2.patch');
  const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const ratified = (root) => ({
    'M2-rebound.md': `patch-file: lib-legacy-M2.patch\npatch-sha256: ${sha256(patchOf(root))}\nequivalence-ratified: stamped by the owner\n`,
  });
  const REJECTED = [
    '# gate packet for proposal A',
    'patch-file: proposal-a.patch',
    `patch-sha256: ${'0'.repeat(64)}`,
    'status: rejected',
    'rejected: the rewrite changed the wrong function; proposal B replaces it',
    '',
  ].join('\n');

  it('completes after a rejected proposal A and a ratified replacement B, keeping A\'s rejection', () => {
    const root = migrated();
    const out = prepare(root);
    const packets = { ...ratified(root), 'proposal-a.md': REJECTED };

    const ratification = workflowCheck('ratification-check', root, out, packets);
    assert.equal(ratification.status, 0, ratification.output);
    const record = workflowCheck('record-check', root, out, packets);
    assert.equal(record.status, 0, record.output);
    assert.equal(fs.readFileSync(path.join(record.gate, 'proposal-a.md'), 'utf8'), REJECTED, 'the rejection was not retained');
  });

  it('still rejects an active packet that names a patch absent from the manifest', () => {
    const root = migrated();
    const pending = { ...ratified(root), 'proposal-a.md': REJECTED.replace('status: rejected\n', '') };
    const record = recordCheck(root, prepare(root), pending);
    assert.notEqual(record.status, 0, record.output);
    assert.match(record.output, /proposal-a\.patch/);
  });

  it('skips superseded and retired packets the same way', () => {
    const root = migrated();
    for (const status of ['superseded', 'retired']) {
      const packets = { ...ratified(root), 'old.md': REJECTED.replace('status: rejected', `status: ${status}`) };
      const record = recordCheck(root, prepare(root), packets);
      assert.equal(record.status, 0, record.output);
    }
  });

  it('never lets a retained packet ratify anything', () => {
    const root = migrated();
    const retired = ratified(root)['M2-rebound.md'].concat('status: retired\n');
    const checked = workflowCheck('ratification-check', root, prepare(root), { 'M2-rebound.md': retired });
    assert.notEqual(checked.status, 0, checked.output);
    assert.match(checked.output, /lib-legacy-M2\.patch/);
  });

  it('still rejects a src-assumptions.md entry that names a patch absent from the manifest', () => {
    const root = migrated();
    fs.writeFileSync(path.join(root, 'src-assumptions.md'), '- A1: trusted by lib-legacy-M2.patch\n- A9: trusted by ghost.patch\n');
    const record = recordCheck(root, prepare(root), ratified(root));
    assert.notEqual(record.status, 0, record.output);
    assert.match(record.output, /ghost\.patch/);
    assert.doesNotMatch(record.output, /lib-legacy-M2\.patch/);
  });

  it('rejects a series that no longer matches the manifest', () => {
    const root = migrated();
    const out = prepare(root);
    const series = path.join(root, 'translation-patches', 'series');
    const names = fs.readFileSync(series, 'utf8').trim().split('\n');
    fs.writeFileSync(series, `${names.slice(1).join('\n')}\n`);
    const record = recordCheck(root, out, ratified(root));
    assert.notEqual(record.status, 0, record.output);
    assert.match(record.output, /series/);
  });
});
