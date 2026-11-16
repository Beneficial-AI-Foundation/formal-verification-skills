'use strict';

// The proof-phase progress helper on a degraded closure plan, with a stub
// Lake: every item gets one terminal, labelled outcome, the run moves on and
// ends with a summary, and nothing ever reads as accepted.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-auto-reduced.mjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'auto-closure-plan', 'positive');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const load = (name) => { const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8'); return { json: JSON.parse(text), sha256: sha(text) }; };

// `lake lean FILE`: fails on FAIL, warns about sorry on SORRY or WARNONLY,
// replays an imported module's sorry warning on IMPORTED,
// edits a project file on TOUCH and creates lake-manifest.json on MANIFEST.
// `lake env lean --threads=2 AUDIT`: prints the audit result for the nonce in
// the appended program, with sorryAx on SORRY or HIDDEN and myAxiom on
// MYAXIOM; nothing on NOAUDIT, no canary row on NOCANARY, a result under
// a wrong nonce on FORGE, and a correct result then exit 3 on AUDITEXIT.
const STUB = `#!/bin/sh
if [ "$1" = env ]; then
  f="$4"
  n=$(grep -o 'FVS-REDUCED-AUDIT-[0-9a-f]*' "$f" | head -1 | sed 's/FVS-REDUCED-AUDIT-//')
  grep -q FORGE "$f" && echo 'FVS-REDUCED-AUDIT-0000 [{"name":"T.x","axioms":[]}]'
  grep -q NOAUDIT "$f" && exit 0
  ax='"propext"'
  grep -qE 'SORRY|HIDDEN' "$f" && ax="$ax,\\"sorryAx\\""
  grep -q MYAXIOM "$f" && ax="$ax,\\"myAxiom\\""
  canary="{\\"name\\":\\"fvsReducedCanary_$n\\",\\"axioms\\":[\\"sorryAx\\"]},"
  grep -q NOCANARY "$f" && canary=""
  echo "FVS-REDUCED-AUDIT-$n [$canary{\\"name\\":\\"T.x\\",\\"axioms\\":[$ax]}]"
  grep -q AUDITEXIT "$f" && exit 3
  exit 0
fi
f="$2"
grep -q TOUCH "$f" && echo "-- edited" >> Proofs/Other.lean
grep -q MANIFEST "$f" && echo '{}' > lake-manifest.json
if grep -q FAIL "$f"; then echo "$f:1:0: error: unsolved goals"; exit 1; fi
grep -qE 'SORRY|WARNONLY' "$f" && echo "$f:1:0: warning: declaration uses 'sorry'"
grep -q IMPORTED "$f" && echo "warning: Proofs/Imported.lean:4:2: declaration uses 'sorry'"
exit 0
`;

const gitIn = (dir, ...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });

describe('reduced lane (degraded plan, no Lean graph)', () => {
  let tmp, project, planFile, lake, plan, run;
  const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const json = (result) => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  const next = (file = planFile) => json(cli('next', '--project-root', project, '--plan', file));
  const out = () => path.join(tmp, `out-${run++}`);
  const record = (defId, file, ...extra) => cli('record', '--project-root', project, '--plan', planFile, '--def-id', String(defId), '--lean', file, '--out', out(), '--lake', lake, ...extra);
  const write = (file, text, dir = project) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
  const commit = (file, dir = project) => { assert.equal(gitIn(dir, 'add', file).status, 0); assert.equal(gitIn(dir, 'commit', '-q', '-m', file).status, 0); };

  before(async () => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-reduced-')));
    run = 0;
    project = path.join(tmp, 'project');
    fs.mkdirSync(path.join(project, 'Proofs'), { recursive: true });
    fs.writeFileSync(path.join(project, 'lean-toolchain'), 'leanprover/lean4:v4.35.0\n');
    fs.writeFileSync(path.join(project, 'Proofs', 'Other.lean'), '-- unrelated\n');
    const bin = path.join(tmp, 'toolchain', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    lake = path.join(bin, 'lake');
    fs.writeFileSync(lake, STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'lean'), '#!/bin/sh\n', { mode: 0o755 });
    spawnSync('git', ['init', '-q'], { cwd: project });
    const { buildPlan } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-closure-plan.mjs')).href);
    plan = buildPlan({ identity: load('identity-record.json'), graph: null, roots: [21], failed: [] });
    assert.equal(plan.status, 'degraded');
    assert.ok(plan.degraded.sourceOrder.length >= 3, 'the fixture has at least three items');
    planFile = path.join(tmp, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify(plan));
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('records a failed build, then built items, moves on after commits and ends with a summary', () => {
    const items = plan.degraded.sourceOrder;
    const first = next();
    assert.equal(first.status, 'item');
    assert.equal(first.item.defId, items[0].defId);
    assert.doesNotMatch(first.note, /no spec review/);
    assert.match(first.note, /Progress only: nothing here is accepted/);
    assert.deepEqual(first.warnings, []);

    write('Proofs/One.lean', 'theorem one : True := by FAIL\n');
    const failed = json(record(items[0].defId, 'Proofs/One.lean'));
    assert.equal(failed.outcome, 'build-failed');
    assert.equal(failed.label, 'Lean build failed');
    assert.equal(failed.build.exitCode, 1);
    assert.equal(failed.audit, null, 'a failed build is not audited');
    assert.equal(failed.fileCommitted, false);
    assert.equal(fs.readFileSync(path.join(project, failed.build.log), 'utf8').includes('unsolved goals'), true);
    assert.equal(sha(fs.readFileSync(path.join(project, failed.build.log))), failed.build.logSha256);

    // Committing the recorded file changes neither the plan nor the record: next moves on.
    commit('Proofs/One.lean');
    assert.equal(next().item.defId, items[1].defId, 'a failed item is terminal and never selected again');
    write('Proofs/Two.lean', 'theorem two : True := trivial\n');
    commit('Proofs/Two.lean');
    const built = json(record(items[1].defId, 'Proofs/Two.lean'));
    assert.equal(built.outcome, 'built');
    assert.equal(built.label, 'built by Lean, not yet build-checked');
    assert.equal(built.audit.status, 'audited');
    assert.deepEqual(built.axioms, ['propext']);
    assert.equal(built.fileCommitted, true);
    assert.equal(built.fileSha256, sha('theorem two : True := trivial\n'));
    assert.equal(built.planSha256, sha(fs.readFileSync(planFile)));
    assert.equal(sha(fs.readFileSync(path.join(project, built.audit.log))), built.audit.logSha256);

    assert.equal(next().item.defId, items[2].defId);
    // A recorded file that changes is reported while items remain, not only in the summary.
    write('Proofs/Two.lean', 'theorem two : True := by trivial\n');
    assert.deepEqual(next().warnings, [`the proof files of def_ids ${items[1].defId} changed or are gone since they were recorded: those outcomes are history, not current.`]);
    write('Proofs/Two.lean', 'theorem two : True := trivial\n');
    assert.deepEqual(next().warnings, []);
    write('Proofs/Three.lean', 'theorem three : True := SORRY\n');
    const sorry = json(record(items[2].defId, 'Proofs/Three.lean'));
    assert.equal(sorry.label, 'built with sorry');
    assert.equal(sorry.fileCommitted, false, 'an uncommitted file is recorded as uncommitted');
    if (items.length > 3) assert.equal(next().item.defId, items[3].defId);
    for (const item of items.slice(3)) {
      const entry = json(cli('record', '--project-root', project, '--plan', planFile, '--def-id', String(item.defId), '--no-proof', 'the worker gave up'));
      assert.equal(entry.label, 'no proof produced');
    }

    const summary = next();
    assert.equal(summary.status, 'summary');
    assert.equal(summary.items.length, items.length);
    assert.deepEqual(summary.counts, { built: 1, 'built-with-axioms': 0, 'built-unaudited': 0, 'built-with-sorry': 1, 'build-failed': 1, 'no-proof': items.length - 3 });
    assert.match(summary.line, /^Proof progress finished: \d+ items\. built by Lean, not yet build-checked: 1;/);
    assert.match(summary.line, /Progress only: nothing here is accepted/);
    assert.ok(summary.items.every((row) => !/accepted/.test(row.label)), 'nothing reads as accepted');
    assert.deepEqual(summary.items[1].axioms, ['propext'], 'the summary lists each item\'s axioms');
    assert.equal(summary.items[1].file, 'Proofs/Two.lean');
    assert.equal(summary.line.includes('stale'), false);

    write('Proofs/Two.lean', 'theorem two : True := by trivial\n');
    const stale = next();
    assert.match(stale.items.find((row) => row.defId === items[1].defId).stale, /changed or is gone since it was recorded/);
    assert.match(stale.line, /Warning: 1 proof files changed after recording/);
  });

  it('labels sorry and axioms from the Lean audit, and falls back to "axioms not audited"', () => {
    const id = plan.degraded.sourceOrder[0].defId;
    const label = (name, text) => { write(`Proofs/${name}.lean`, text); return json(record(id, `Proofs/${name}.lean`)); };
    const axioms = label('Ax', 'axiom myAxiom : False\ntheorem t : True := trivial -- MYAXIOM\n');
    assert.equal(axioms.outcome, 'built-with-axioms');
    assert.equal(axioms.label, 'built using axioms beyond the standard three, not yet build-checked');
    assert.deepEqual(axioms.axioms, ['myAxiom', 'propext']);
    assert.equal(label('Hidden', 'theorem t : True := HIDDEN\n').outcome, 'built-with-sorry', 'sorry the build log does not show still counts');
    const disagree = label('WarnOnly', 'theorem t : True := trivial -- WARNONLY\n');
    assert.equal(disagree.outcome, 'built-with-sorry');
    assert.match(disagree.audit.reason, /warned about sorry but the audit found no sorryAx/);
    write('Proofs/Imported.lean', 'theorem s : True := sorry\n');
    const imported = label('ImportSorry', 'theorem t : True := trivial -- IMPORTED\n');
    assert.equal(imported.outcome, 'built', 'a sorry warning replayed from an imported module is not this file\'s');
    assert.equal(imported.audit.status, 'audited');
    const silent = label('NoAudit', 'theorem t : True := trivial -- NOAUDIT\n');
    assert.equal(silent.outcome, 'built-unaudited');
    assert.equal(silent.label, 'built by Lean, axioms not audited, not yet build-checked');
    assert.equal(silent.axioms, null);
    assert.match(label('NoCanary', 'theorem t : True := trivial -- NOCANARY\n').audit.reason, /missed its own sorry canary/);
    const forged = label('Forge', 'theorem t : True := trivial -- FORGE NOAUDIT\n');
    assert.equal(forged.outcome, 'built-unaudited', 'a result under another nonce is ignored');
    const failedAudit = label('AuditExit', 'theorem t : True := trivial -- AUDITEXIT\n');
    assert.equal(failedAudit.outcome, 'built-unaudited', 'a matching result from an audit that exited nonzero is not trusted');
    assert.match(failedAudit.audit.reason, /^the audit exited with code 3$/);
    const auditText = fs.readFileSync(path.join(tmp, `out-${run - 1}`, 'audit.lean'), 'utf8');
    assert.ok(auditText.startsWith('import Lean theorem t'), 'the audit copy is the file with Lean imported');
  });

  it('reads the proof file from a worker checkout and builds it in the project root', () => {
    const id = plan.degraded.sourceOrder[0].defId;
    const worker = path.join(tmp, 'worker');
    fs.mkdirSync(worker);
    spawnSync('git', ['init', '-q'], { cwd: worker });
    write('Proofs/W.lean', 'theorem w : True := trivial\n', worker);
    commit('Proofs/W.lean', worker);
    const entry = json(record(id, 'Proofs/W.lean', '--worktree', worker));
    assert.equal(entry.outcome, 'built');
    assert.equal(entry.source.worktree, worker);
    assert.match(entry.source.commit, /^[0-9a-f]{40}$/);
    assert.equal(entry.fileCommitted, true);
    assert.equal(entry.build.argv[2], path.join(worker, 'Proofs/W.lean'));
    assert.ok(fs.existsSync(path.join(project, entry.build.log)), 'logs and ledger stay in the project root');
    assert.ok(!fs.existsSync(path.join(worker, '.formalising')), 'nothing is written into the worker checkout');
    assert.match(record(id, '../escape.lean', '--worktree', worker).stderr, /relative to the worker checkout/);
    write('Proofs/Later.lean', 'theorem l : True := trivial\n', worker);
    commit('Proofs/Later.lean', worker);
    assert.ok(next().warnings.includes(`the outcomes of def_ids ${id} are observations of an earlier commit of their checkout; the build check decides.`));
  });

  it('records a proof under an ignored, never-tracked path as not committed', () => {
    const id = plan.degraded.sourceOrder[0].defId;
    const worker = path.join(tmp, 'ignored-worker');
    fs.mkdirSync(worker);
    spawnSync('git', ['init', '-q'], { cwd: worker });
    write('.gitignore', 'Proofs/\n', worker);
    commit('.gitignore', worker);
    write('Proofs/I.lean', 'theorem i : True := trivial\n', worker);
    assert.equal(gitIn(worker, 'status', '--porcelain', '--', 'Proofs/I.lean').stdout, '', 'git status hides the ignored file');
    const entry = json(record(id, 'Proofs/I.lean', '--worktree', worker));
    assert.equal(entry.outcome, 'built');
    assert.equal(entry.fileCommitted, false);
  });

  it('records Lake creating lake-manifest.json as a warning, and refuses a build that edits other project files', () => {
    const id = plan.degraded.sourceOrder[0].defId;
    write('Proofs/Manifest.lean', 'theorem m : True := trivial -- MANIFEST\n');
    const entry = json(record(id, 'Proofs/Manifest.lean'));
    assert.equal(entry.outcome, 'built');
    assert.match(entry.warnings[0], /Lake created lake-manifest\.json during the build \(sha256 [0-9a-f]{64}\)/);

    write('Proofs/Touch.lean', 'theorem t : True := trivial -- TOUCH\n');
    const touched = record(id, 'Proofs/Touch.lean');
    assert.equal(touched.status, 1);
    assert.match(touched.stderr, /refused: the project files changed during the build .*Proofs\/Other\.lean/);
  });

  it('a regenerated plan starts again and warns about the other plan\'s records', () => {
    const regenerated = path.join(tmp, 'plan-2.json');
    fs.writeFileSync(regenerated, JSON.stringify(plan, null, 2));
    const fresh = next(regenerated);
    assert.equal(fresh.status, 'item');
    assert.equal(fresh.item.defId, plan.degraded.sourceOrder[0].defId);
    assert.match(fresh.warnings[0], /^\d+ recorded outcomes belong to another plan/);
  });

  it('refuses a plan that is not degraded, an unknown item, and proof files outside the project', () => {
    const ready = path.join(tmp, 'ready.json');
    fs.writeFileSync(ready, JSON.stringify({ ...plan, status: 'ready' }));
    assert.match(cli('next', '--project-root', project, '--plan', ready).stderr, /the plan is ready, not degraded: use the strict lane/);
    assert.match(record(999999, 'Proofs/Two.lean').stderr, /def_id 999999 is not an item of this degraded plan/);
    const id = plan.degraded.sourceOrder[0].defId;
    assert.match(record(id, '../escape.lean').stderr, /relative to the worker checkout/);
    assert.match(record(id, '/abs/x.lean').stderr, /relative to the worker checkout/);
    assert.match(cli('record', '--project-root', project, '--plan', planFile, '--def-id', String(id)).stderr, /exactly one of --lean FILE or --no-proof REASON/);
    const duplicate = path.join(tmp, 'duplicate.json');
    fs.writeFileSync(duplicate, JSON.stringify({ ...plan, degraded: { ...plan.degraded, sourceOrder: [...plan.degraded.sourceOrder, plan.degraded.sourceOrder[0]] } }));
    assert.match(cli('next', '--project-root', project, '--plan', duplicate).stderr, /unique integer def_ids/);
  });

  it('freeze, check and accept refuse a degraded plan with a reason that names the record step', async () => {
    const { extractionContext, inspectAutoBaselineArtifacts } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-checker-auto.mjs')).href);
    const text = fs.readFileSync(planFile);
    assert.throws(() => extractionContext({ identity: null, graph: null, plan: { file: planFile, sha256: sha(text) }, rust: null, lean: null }),
      (error) => error.code === 'unsupported' && /Strict acceptance needs the Lean graph; a degraded plan cannot freeze\. .*fvs-auto-reduced\.mjs record/.test(error.message));
    assert.throws(() => inspectAutoBaselineArtifacts({ baseline: null, deadlineMs: Date.now() + 60000 }),
      (error) => /no frozen baseline: freeze first\. Strict acceptance needs the Lean graph/.test(error.message));
  });

  // Last: these rows are written straight into the ledger, as authored code could.
  it('ignores invalid ledger rows, derives labels from the outcome, and refuses a corrupt ledger', () => {
    const ledgerFile = path.join(project, '.formalising/auto-fv/reduced/outcomes.json');
    const saved = fs.readFileSync(ledgerFile);
    const ledger = JSON.parse(saved);
    const items = plan.degraded.sourceOrder;
    const row = { schema: 'fvs/auto-reduced-outcome', version: 1, planSha256: sha(fs.readFileSync(planFile)), defId: items[0].defId, file: 'Proofs/Two.lean', fileSha256: 'x', axioms: [] };
    ledger.records.push({ ...row, outcome: 'accepted' }, { ...row, outcome: 'constructor' }, { ...row, outcome: 'built', defId: 999999 },
      { ...row, outcome: 'built', file: '../x.lean' }, { ...row, outcome: 'built', label: 'accepted' });
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
    const summary = next();
    assert.equal(summary.status, 'summary');
    assert.ok(summary.warnings.includes('4 recorded rows for this plan are not valid outcomes (unknown item, outcome or file path); they are ignored and kept in the ledger.'));
    assert.equal(summary.items[0].label, 'built by Lean, not yet build-checked', 'the stored label is never shown');
    assert.ok(summary.items.every((entry) => !/accepted/.test(entry.label)));

    fs.writeFileSync(ledgerFile, '{not json');
    const corrupt = cli('next', '--project-root', project, '--plan', planFile);
    assert.equal(corrupt.status, 1);
    assert.match(corrupt.stderr, /^refused: \.formalising\/auto-fv\/reduced\/outcomes\.json is not JSON/);
    fs.writeFileSync(ledgerFile, saved);
  });
});
