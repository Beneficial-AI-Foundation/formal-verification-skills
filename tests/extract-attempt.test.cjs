'use strict';

// Recorded extraction attempt in the patch engine: the supported-invocation
// contract, the controlled environment, the ordered Charon -> Aeneas -> publish
// stages and the publication preflight. Charon, Aeneas, rustc and cargo are fake
// scripts steered by a behaviour file; no real tool runs here.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { fakeTools, engine: runEngine, writeSpec } = require('./helpers/fake-extraction-tools.cjs');

const TMP = fs.realpathSync(os.tmpdir());
const SECRET = 'SENTINEL-c0ffee-SECRET';
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// A tiny crate with a fake release inside it, a fake cargo home, and a parent
// directory for the extraction copies; `behaviour` steers the fake tools.
function workspace(behaviour = {}) {
  const root = fs.mkdtempSync(path.join(TMP, 'fvs-attempt-'));
  temporaryDirectories.push(root);
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n');
  fs.writeFileSync(path.join(project, 'Cargo.lock'), 'version = 3\n');
  fs.writeFileSync(path.join(project, 'src', 'lib.rs'), 'pub fn one() -> u32 { 1 }\n');
  const tools = fakeTools(project, root, behaviour);
  fs.mkdirSync(path.join(root, 'copies'));
  return { root, project, release: tools.release, cargoHome: tools.cargoHome, tools, behaviour: tools.setBehaviour };
}

const engine = (ws, args, extraEnv) => runEngine(ws.tools, args, extraEnv);

let copies = 0;
function prepared(ws, parent = path.join(ws.root, 'copies')) {
  const out = path.join(parent, `out-${(copies += 1)}`);
  const prep = engine(ws, ['prepare', '--project-root', ws.project, '--out', out]);
  assert.equal(prep.status, 0, prep.stdout);
  return out;
}

const spec = (ws, fields = {}) => writeSpec(path.join(ws.root, `spec-${(copies += 1)}.json`), fields);

function attempted(ws, fields, extraEnv) {
  const out = prepared(ws);
  const recorded = engine(ws, ['attempt', '--out', out, '--spec', spec(ws, fields)], extraEnv);
  return { out, recorded };
}

const step = (ws, out, name) => engine(ws, ['run', '--out', out, '--step', name]);

function complete(ws, fields, extraEnv) {
  const { out, recorded } = attempted(ws, fields, extraEnv);
  assert.equal(recorded.status, 0, recorded.stdout);
  for (const name of ['charon', 'aeneas', 'publish']) assert.equal(step(ws, out, name).status, 0, name);
  return out;
}

function snapshot(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = {};
  (function visit(relative) {
    for (const name of fs.readdirSync(path.join(dir, relative)).sort()) {
      const child = path.join(relative, name);
      const stat = fs.lstatSync(path.join(dir, child));
      if (stat.isDirectory()) {
        files[child] = 'directory';
        visit(child);
      } else files[child] = stat.isSymbolicLink() ? `link:${fs.readlinkSync(path.join(dir, child))}` : sha256(path.join(dir, child));
    }
  })('');
  return files;
}

function everyFileText(dir) {
  return Object.entries(snapshot(dir) ?? {}).filter(([, kind]) => kind !== 'directory').map(([file]) => fs.readFileSync(path.join(dir, file), 'utf8')).join('\n');
}

describe('extraction attempt: supported positive', () => {
  it('records a supported attempt, runs the three stages in order and re-validates the chain', () => {
    const ws = workspace();
    const out = complete(ws);
    const status = engine(ws, ['attempt-status', '--out', out]);
    assert.equal(status.status, 0, status.stdout);
    const { run } = status.result;
    assert.equal(run.supported, true);
    assert.deepEqual(run.residuals, []);
    assert.equal(run.trust, 'local-host-and-reviewed-scripts');
    assert.equal(run.llbc.sha256, sha256(path.join(out, 'demo.llbc')));
    assert.equal(run.translation.projectPath, path.join(ws.project, 'Demo', 'translation.json'));
    assert.equal(run.translation.sha256, sha256(path.join(ws.project, 'Demo', 'translation.json')));
    assert.deepEqual(Object.keys(run.stages), ['charon', 'aeneas', 'publish']);
    const attempt = JSON.parse(fs.readFileSync(path.join(out, 'attempt.json'), 'utf8'));
    assert.deepEqual(Object.keys(attempt.env).sort(), ['CARGO_HOME', 'HOME', 'PATH', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN']);
    assert.equal(attempt.env.RUSTUP_TOOLCHAIN, 'nightly-2026-09-17');
    assert.deepEqual(attempt.charon.argv.slice(-2), ['--', '--locked']);
    const seen = JSON.parse(fs.readFileSync(path.join(ws.release, 'seen-charon.json'), 'utf8'));
    assert.deepEqual(Object.keys(seen.env).filter((name) => name !== '__CF_USER_TEXT_ENCODING').sort(), Object.keys(attempt.env).sort(), 'the tool saw only the controlled environment');
    assert.equal(seen.cwd, fs.realpathSync(attempt.tree));
  });

  it('gives a second attempt with the same configuration the same configuration hash, and republishes owned files', () => {
    const ws = workspace();
    const first = complete(ws);
    const second = complete(ws);
    const config = (out) => JSON.parse(fs.readFileSync(path.join(out, 'attempt.json'), 'utf8')).configSha256;
    assert.equal(config(first), config(second));
    assert.equal(engine(ws, ['attempt-status', '--out', second]).status, 0);
    ws.behaviour({ lean: 'def one := 2\n' });
    const third = complete(ws);
    assert.equal(fs.readFileSync(path.join(ws.project, 'Demo', 'Demo.lean'), 'utf8'), 'def one := 2\n');
    assert.equal(engine(ws, ['attempt-status', '--out', third]).status, 0);
  });
});

describe('extraction attempt: configuration contract and privacy', () => {
  it('refuses secret-bearing or unsupported arguments before anything is recorded, without echoing them', () => {
    const cases = {
      'cargo --config override': [{ cargoArgs: ['--locked', '--config', `registries.x.token="${SECRET}"`] }, 'override'],
      'URL as a Charon value': [{ charonArgs: ['--opaque', `https://${SECRET}@example.invalid/x`] }, 'url'],
      'key=value cargo argument': [{ cargoArgs: [`--features=${SECRET}`] }, 'key=value'],
      'manifest path override': [{ cargoArgs: ['--manifest-path', `/tmp/${SECRET}/Cargo.toml`] }, 'path-override'],
      'unsupported Aeneas option': [{ aeneasArgs: ['-borrow-check'] }, 'unsupported'],
      'unknown spec field': [{ extra: true }, undefined],
    };
    for (const [label, [fields, argClass]] of Object.entries(cases)) {
      const ws = workspace();
      const { out, recorded } = attempted(ws, fields);
      assert.equal(recorded.status, 5, label);
      assert.equal(recorded.result.code, 'invalid-input', label);
      assert.equal(recorded.result.class, argClass, label);
      assert.ok(!recorded.stdout.includes(SECRET) && !recorded.stderr.includes(SECRET), `${label}: refusal echoes no value`);
      assert.equal(fs.existsSync(path.join(out, 'attempt.json')), false, `${label}: nothing persisted`);
    }
  });

  it('never passes, records or logs secret environment values, and leaves the attempt unsupported', () => {
    const ws = workspace();
    const out = complete(ws, {}, { CARGO_REGISTRY_TOKEN: SECRET, CARGO_REGISTRIES_PRIVATE_TOKEN: SECRET });
    const attempt = JSON.parse(fs.readFileSync(path.join(out, 'attempt.json'), 'utf8'));
    assert.equal(attempt.supported, false);
    assert.deepEqual(attempt.residuals.map((r) => r.name), ['CARGO_REGISTRIES_PRIVATE_TOKEN', 'CARGO_REGISTRY_TOKEN']);
    assert.ok(!everyFileText(out).includes(SECRET), 'no record or log under OUT holds the value');
    assert.ok(!fs.readFileSync(path.join(ws.release, 'seen-charon.json'), 'utf8').includes(SECRET), 'Charon never saw it');
    assert.ok(!fs.readFileSync(path.join(ws.release, 'seen-aeneas.json'), 'utf8').includes(SECRET), 'Aeneas never saw it');
  });

  it('keeps a removed influential setting unsupported even though the tools succeed', () => {
    const ws = workspace();
    const out = complete(ws, {}, { RUSTFLAGS: '-C opt-level=3' });
    const status = engine(ws, ['attempt-status', '--out', out]);
    assert.equal(status.status, 0);
    assert.equal(status.result.run.supported, false);
    assert.deepEqual(status.result.run.residuals, [{ name: 'RUSTFLAGS', class: 'influential' }]);
  });

  it('reports an unknown variable by name and a different toolchain override as influential', () => {
    const ws = workspace();
    const { recorded } = attempted(ws, {}, { SOME_UNKNOWN_SETTING: 'x', RUSTUP_TOOLCHAIN: 'stable' });
    assert.deepEqual(recorded.result.attempt.residuals, [{ name: 'RUSTUP_TOOLCHAIN', class: 'influential' }, { name: 'SOME_UNKNOWN_SETTING', class: 'unknown' }]);
    assert.equal(recorded.result.attempt.supported, false);
  });

  it('hashes a present cargo configuration file without copying it, and leaves the attempt unsupported', () => {
    const ws = workspace();
    const parent = path.join(ws.root, 'copies', 'with-config');
    fs.mkdirSync(path.join(parent, '.cargo'), { recursive: true });
    fs.writeFileSync(path.join(parent, '.cargo', 'config.toml'), `[registries.x]\ntoken = "${SECRET}"\n`);
    const out = prepared(ws, parent);
    const recorded = engine(ws, ['attempt', '--out', out, '--spec', spec(ws)]);
    const entry = recorded.result.attempt.cargoConfig.find((file) => file.present);
    assert.equal(entry.path, path.join(parent, '.cargo', 'config.toml'));
    assert.equal(entry.sha256, sha256(entry.path));
    assert.deepEqual(recorded.result.attempt.residuals, [{ name: entry.path, class: 'cargo-config' }]);
    assert.ok(!everyFileText(out).includes(SECRET));
    fs.writeFileSync(path.join(ws.cargoHome, 'credentials.toml'), SECRET);
    const credentials = attempted(ws).recorded.result.attempt.credentials;
    assert.deepEqual(credentials.map((c) => c.present), [false, true], 'credentials: presence only');
  });
});

describe('extraction attempt: stage protocol', () => {
  it('records a failed stage when the tool exits non-zero after writing its output, and ends the attempt', () => {
    const ws = workspace({ charonExit: 3 });
    const { out } = attempted(ws);
    const charon = step(ws, out, 'charon');
    assert.equal(charon.status, 9);
    assert.ok(fs.existsSync(path.join(out, 'demo.llbc')), 'the output exists');
    assert.ok(fs.existsSync(path.join(out, 'stage-1-charon.failed.json')));
    assert.equal(step(ws, out, 'aeneas').status, 8, 'no later stage runs after a failure');
    assert.equal(step(ws, out, 'charon').status, 8, 'and the failed stage is not retried');
  });

  it('records a killed tool as failed', () => {
    const ws = workspace({ charonSignal: true });
    const { out } = attempted(ws);
    const charon = step(ws, out, 'charon');
    assert.equal(charon.status, 9);
    assert.match(charon.result.message, /killed by SIGKILL/);
  });

  it('refuses after an interrupted stage left its pending record', () => {
    const ws = workspace();
    const { out } = attempted(ws);
    assert.equal(step(ws, out, 'charon').status, 0);
    fs.writeFileSync(path.join(out, 'stage-2-aeneas.pending.json'), '{}');
    assert.equal(step(ws, out, 'aeneas').status, 8);
    assert.equal(step(ws, out, 'publish').status, 8);
    assert.equal(engine(ws, ['attempt-status', '--out', out]).status, 8);
  });

  it('refuses duplicate and reordered stages', () => {
    const ws = workspace();
    const { out } = attempted(ws);
    assert.equal(step(ws, out, 'aeneas').status, 8, 'Aeneas before Charon');
    assert.equal(step(ws, out, 'charon').status, 0);
    assert.equal(step(ws, out, 'charon').status, 8, 'Charon twice');
    assert.equal(step(ws, out, 'publish').status, 8, 'publish before Aeneas');
  });

  it('refuses an existing LLBC, an existing Aeneas destination and a second attempt on one copy', () => {
    const ws = workspace();
    const first = attempted(ws);
    fs.writeFileSync(path.join(first.out, 'demo.llbc'), 'stale');
    assert.equal(step(ws, first.out, 'charon').status, 8);
    assert.equal(engine(ws, ['attempt', '--out', first.out, '--spec', spec(ws)]).status, 8);
    const second = attempted(ws);
    assert.equal(step(ws, second.out, 'charon').status, 0);
    fs.mkdirSync(path.join(second.out, 'aeneas-dest'));
    assert.equal(step(ws, second.out, 'aeneas').status, 8);
  });

  it('refuses a broken chain: a tampered previous-record hash or a changed manifest', () => {
    const ws = workspace();
    const { out } = attempted(ws);
    assert.equal(step(ws, out, 'charon').status, 0);
    const recordFile = path.join(out, 'stage-1-charon.completed.json');
    const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    fs.writeFileSync(recordFile, JSON.stringify({ ...record, prevSha256: '0'.repeat(64) }));
    assert.equal(step(ws, out, 'aeneas').status, 8);
    const other = attempted(ws).out;
    fs.appendFileSync(path.join(other, 'manifest.json'), ' ');
    assert.equal(step(ws, other, 'charon').status, 8);
  });

  it('refuses a tool whose hash changed after the attempt was recorded', () => {
    const ws = workspace();
    const { out } = attempted(ws);
    assert.equal(step(ws, out, 'charon').status, 0);
    fs.appendFileSync(path.join(ws.release, 'aeneas'), '\n// changed\n');
    assert.equal(step(ws, out, 'aeneas').status, 8);
  });

  it('refuses a wrong consumed LLBC, and fails a stage that changes the LLBC or the copy', () => {
    const ws = workspace();
    const { out } = attempted(ws);
    assert.equal(step(ws, out, 'charon').status, 0);
    fs.appendFileSync(path.join(out, 'demo.llbc'), ' ');
    assert.equal(step(ws, out, 'aeneas').status, 8);
    const touching = workspace({ aeneasTouchLlbc: true });
    const second = attempted(touching).out;
    assert.equal(step(touching, second, 'charon').status, 0);
    assert.equal(step(touching, second, 'aeneas').status, 9);
    const tree = workspace({ charonTouchTree: true });
    const third = attempted(tree).out;
    const charon = step(tree, third, 'charon');
    assert.equal(charon.status, 9);
    assert.match(charon.result.message, /verify-tree after Charon/);
  });

  it('fails Aeneas on a missing or extra output, and refuses outputs changed before publication', () => {
    for (const [label, behaviour] of [['missing', { aeneasFiles: [] }], ['extra', { aeneasFiles: ['Demo.lean', 'Stray.lean'] }]]) {
      const ws = workspace(behaviour);
      const { out } = attempted(ws);
      assert.equal(step(ws, out, 'charon').status, 0, label);
      assert.equal(step(ws, out, 'aeneas').status, 9, label);
    }
    const ws = workspace();
    const { out } = attempted(ws);
    assert.equal(step(ws, out, 'charon').status, 0);
    assert.equal(step(ws, out, 'aeneas').status, 0);
    fs.appendFileSync(path.join(out, 'aeneas-dest', 'Demo.lean'), '-- edited\n');
    assert.equal(step(ws, out, 'publish').status, 8);
  });

  it('refuses attempt-status when a published file changed afterwards', () => {
    const ws = workspace();
    const out = complete(ws);
    fs.appendFileSync(path.join(ws.project, 'Demo', 'Demo.lean'), '-- edited\n');
    assert.equal(engine(ws, ['attempt-status', '--out', out]).status, 8);
  });
});

describe('extraction attempt: the recorded attempt is the executed attempt', () => {
  const editAttempt = (out, edit) => {
    const file = path.join(out, 'attempt.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    edit(record);
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
  };

  it('refuses a cargo configuration file that appears, changes or disappears after the attempt is recorded', () => {
    for (const label of ['appears before Charon', 'appears before attempt-status', 'cargo home config appears', 'changes', 'disappears']) {
      const ws = workspace();
      const parent = path.join(ws.root, 'copies', 'drift');
      fs.mkdirSync(path.join(parent, '.cargo'), { recursive: true });
      const config = path.join(parent, '.cargo', 'config.toml');
      if (label === 'changes' || label === 'disappears') fs.writeFileSync(config, '[build]\nrustflags = ["--cfg", "a"]\n');
      const out = prepared(ws, parent);
      assert.equal(engine(ws, ['attempt', '--out', out, '--spec', spec(ws)]).status, 0, label);
      if (label === 'appears before attempt-status') {
        for (const name of ['charon', 'aeneas', 'publish']) assert.equal(step(ws, out, name).status, 0, label);
        fs.writeFileSync(config, '[build]\nrustflags = ["--cfg", "b"]\n');
        assert.equal(engine(ws, ['attempt-status', '--out', out]).status, 8, label);
        continue;
      }
      if (label === 'appears before Charon') fs.writeFileSync(config, '[build]\nrustflags = ["--cfg", "b"]\n');
      if (label === 'cargo home config appears') fs.writeFileSync(path.join(ws.cargoHome, 'config.toml'), '[build]\nrustflags = ["--cfg", "b"]\n');
      if (label === 'changes') fs.writeFileSync(config, '[build]\nrustflags = ["--cfg", "changed"]\n');
      if (label === 'disappears') fs.rmSync(config);
      const charon = step(ws, out, 'charon');
      assert.equal(charon.status, 8, label);
      assert.match(charon.result.message, /cargo configuration file appeared, changed or disappeared/, label);
      assert.equal(fs.existsSync(path.join(ws.release, 'seen-charon.json')), false, `${label}: Charon never ran`);
    }
  });

  it('refuses a toolchain identity that changed after the attempt was recorded', () => {
    const ws = workspace();
    const { out } = attempted(ws);
    fs.writeFileSync(path.join(ws.cargoHome, 'bin', 'rustc'), `#!${process.execPath}\nconsole.log('rustc 1.101.0-nightly (other)');\n`, { mode: 0o755 });
    const charon = step(ws, out, 'charon');
    assert.equal(charon.status, 8);
    assert.match(charon.result.message, /toolchain identity changed/);
  });

  it('refuses edited execution fields before the first stage, even with the stored configuration untouched', () => {
    const edits = {
      'Charon argv gains a feature': (r) => r.charon.argv.push('--features', 'alt'),
      'environment gains RUSTFLAGS': (r) => { r.env.RUSTFLAGS = '-C opt-level=3'; },
      'Charon working directory moved': (r) => { r.charon.cwd = r.projectRoot; },
      'Aeneas destination moved': (r) => { r.aeneas.argv[4] = path.join(r.projectRoot, 'Demo'); },
      'tool path swapped': (r) => { r.tools.charon.path = r.tools.aeneas.path; },
      'spec gains a supported option': (r) => { r.spec.cargoArgs = [...r.spec.cargoArgs, '--features', 'alt']; },
      'supported flag forced on': (r) => { r.residuals = [{ name: 'RUSTFLAGS', class: 'influential' }]; },
    };
    for (const [label, edit] of Object.entries(edits)) {
      const ws = workspace();
      const { out } = attempted(ws);
      editAttempt(out, edit);
      const charon = step(ws, out, 'charon');
      assert.equal(charon.status, 8, label);
      assert.equal(fs.existsSync(path.join(ws.release, 'seen-charon.json')), false, `${label}: refused before spawning`);
    }
  });

  it('fails Charon when its LLBC is malformed: duplicate file ids or a local source without contents', () => {
    for (const behaviour of [{ llbcDuplicateFile: true }, { llbcNoContents: true }]) {
      const ws = workspace(behaviour);
      const { out } = attempted(ws);
      const charon = step(ws, out, 'charon');
      assert.equal(charon.status, 9, JSON.stringify(behaviour));
      assert.match(charon.result.message, /file ids are not unique|has no contents/);
    }
  });

  it('fails Charon when its LLBC relabels or alters a prepared source, even with the label removed', () => {
    for (const [behaviour, pattern] of [[{ llbcRelabel: true }, /is not the prepared source/], [{ llbcRelabel: 'other_crate' }, /is not the prepared source/],
      [{ llbcAlterContents: true }, /is not the prepared source/], [{ llbcRelabelOnly: 'other_crate' }, /labels src\/lib\.rs with crate/]]) {
      const ws = workspace(behaviour);
      const { out } = attempted(ws);
      const charon = step(ws, out, 'charon');
      assert.equal(charon.status, 9, JSON.stringify(behaviour));
      assert.match(charon.result.message, pattern, JSON.stringify(behaviour));
    }
  });

  it('fails Aeneas when translation.json leaves a local function without a Lean file, or names no Lean file at all', () => {
    const cases = {
      'local function without lean_file': { translationFunctions: [{ def_id: 0, is_local: true }], aeneasFiles: [] },
      'one of two local functions without lean_file': { translationFunctions: [{ def_id: 0, is_local: true, lean_file: 'Demo.lean' }, { def_id: 1, is_local: true }], aeneasFiles: ['Demo.lean'] },
      'non-string lean_file': { translationFunctions: [{ def_id: 0, is_local: true, lean_file: 7 }], aeneasFiles: [] },
      'path outside the output': { translationFunctions: [{ def_id: 0, is_local: true, lean_file: '../Demo.lean' }], aeneasFiles: [] },
      'metadata only': { translationFunctions: [], aeneasFiles: [] },
    };
    for (const [label, behaviour] of Object.entries(cases)) {
      const ws = workspace();
      const { out } = attempted(ws);
      assert.equal(step(ws, out, 'charon').status, 0, label);
      ws.behaviour(behaviour);
      const aeneas = step(ws, out, 'aeneas');
      assert.equal(aeneas.status, 9, label);
      assert.match(aeneas.result.message, /lean_file|names no generated Lean file/, label);
    }
  });

  it('fails Aeneas on an empty directory left in its output', () => {
    const ws = workspace({ aeneasFiles: ['Demo.lean'] });
    const { out } = attempted(ws);
    assert.equal(step(ws, out, 'charon').status, 0);
    ws.behaviour({ aeneasFiles: ['Demo.lean'], aeneasMkdir: 'Stray' });
    assert.equal(step(ws, out, 'aeneas').status, 9);
  });
});

describe('extraction attempt: publication preflight never mutates the destination on refusal', () => {
  function upToPublish(ws) {
    const { out } = attempted(ws);
    assert.equal(step(ws, out, 'charon').status, 0);
    assert.equal(step(ws, out, 'aeneas').status, 0);
    return out;
  }

  const cases = {
    'maintained file with an output basename': [(dir) => fs.writeFileSync(path.join(dir, 'Demo.lean'), '-- maintained\n'), 'unowned'],
    'unowned extra file (mixed namespace)': [(dir) => fs.writeFileSync(path.join(dir, 'Spec.lean'), '-- a spec\n'), 'unowned'],
    'leftover pending marker': [(dir) => fs.writeFileSync(path.join(dir, '.fvs-publication.pending.json'), '[]'), 'pending'],
    'empty directory where a later output goes': [(dir) => fs.mkdirSync(path.join(dir, 'translation.json')), 'occupied'],
    'directory at the ownership record path': [(dir) => fs.mkdirSync(path.join(dir, '.fvs-publication.json')), 'occupied'],
    'unowned empty directory': [(dir) => fs.mkdirSync(path.join(dir, 'Scratch')), 'unowned'],
  };
  for (const [label, [arrange, reason]] of Object.entries(cases)) {
    it(`refuses a ${label}`, () => {
      const ws = workspace();
      const dir = path.join(ws.project, 'Demo');
      fs.mkdirSync(dir);
      arrange(dir);
      const out = upToPublish(ws);
      const before = snapshot(dir);
      const publish = step(ws, out, 'publish');
      assert.equal(publish.status, 8, publish.stdout);
      assert.equal(publish.result.reason, reason);
      assert.deepEqual(snapshot(dir), before);
    });
  }

  it('refuses a hand-edited owned file and a stale owned file, leaving the destination unchanged', () => {
    for (const label of ['hand-edited', 'stale']) {
      const ws = workspace();
      complete(ws);
      const dir = path.join(ws.project, 'Demo');
      if (label === 'hand-edited') fs.appendFileSync(path.join(dir, 'Demo.lean'), '-- edit\n');
      else {
        fs.writeFileSync(path.join(dir, 'Old.lean'), 'old\n');
        const ownership = JSON.parse(fs.readFileSync(path.join(dir, '.fvs-publication.json'), 'utf8'));
        ownership.files['Old.lean'] = sha256(path.join(dir, 'Old.lean'));
        fs.writeFileSync(path.join(dir, '.fvs-publication.json'), JSON.stringify(ownership));
      }
      const out = upToPublish(ws);
      const before = snapshot(dir);
      const publish = step(ws, out, 'publish');
      assert.equal(publish.status, 8, label);
      assert.equal(publish.result.reason, label === 'hand-edited' ? 'modified' : 'stale', label);
      assert.deepEqual(snapshot(dir), before, label);
    }
  });

  it('refuses a destination reached through a symbolic link', () => {
    const ws = workspace();
    const elsewhere = path.join(ws.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const out = upToPublish(ws);
    fs.symlinkSync(elsewhere, path.join(ws.project, 'Demo'));
    const publish = step(ws, out, 'publish');
    assert.notEqual(publish.status, 0);
    assert.deepEqual(snapshot(elsewhere), {});
  });

  it('refuses two outputs that differ only in case where the filesystem can hold both', (t) => {
    const probe = path.join(workspace().root, 'Case');
    fs.writeFileSync(probe, '');
    if (fs.existsSync(probe.toLowerCase())) {
      t.skip('case-insensitive filesystem: two such outputs cannot coexist, so the case cannot arise');
      return;
    }
    const ws = workspace({ aeneasFiles: ['Demo.lean', 'demo.lean'] });
    const { out } = attempted(ws);
    assert.equal(step(ws, out, 'charon').status, 0);
    // translation.json names only Demo.lean, so the extra file already fails Aeneas.
    assert.notEqual(step(ws, out, 'aeneas').status, 0);
  });
});
