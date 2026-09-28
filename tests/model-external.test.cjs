'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-model-external.mjs');
const REVIEW_SCRIPT = path.join(ROOT, 'scripts', 'fvs-model-review.mjs');

function runHelper(cwd, args, env = {}, script = SCRIPT) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

function sourceRecord(root) {
  const content = 'pub fn demo() -> bool { true }\n';
  const file = path.join(root, 'authoritative.rs');
  fs.writeFileSync(file, content);
  return {
    status: 'RESOLVED',
    strategy: 'registry',
    package: 'demo',
    revision: '1.0.0',
    file,
    range: { start_line: 1, end_line: 1 },
    sha256: sha256(content),
    range_sha256: sha256(content),
    unsafe: false,
  };
}

describe('External Rust modeling command', () => {
  it('is one canonical command routed from both Aeneas and FC', () => {
    const command = read('commands', 'fvs', 'model-external.md');
    const workflow = read('fv-skills', 'workflows', 'model-external.md');
    const executor = read('agents', 'fvs-external-modeler.md');

    assert.match(command, /^name: fvs:model-external$/m);
    assert.match(command, /fvs-external-modeler/);
    assert.match(workflow, /one requested (?:external Rust )?stub/i);
    assert.match(executor, /bounded external-stub dependency closure/i);

    for (const router of ['aeneas.md', 'fc.md']) {
      const text = read('commands', 'fvs', router);
      assert.match(text, /model-external/);
      assert.match(text, /fvs:model-external/);
    }

    const plugin = read('plugins', 'fvs', 'skills', 'model-external', 'SKILL.md');
    const adapter = plugin.split('</codex_skill_adapter>')[0];
    assert.match(adapter, /fvs-external-modeler/);
    assert.doesNotMatch(adapter, /fvs-researcher|fvs-executor/);
    assert.match(read('pi', 'skills', 'fvs-model-external', 'SKILL.md'), /name: fvs-model-external/);
  });

  it('fails closed on unsafe/effectful source, review caps, and trust shortcuts', () => {
    const command = read('commands', 'fvs', 'model-external.md');
    const workflow = read('fv-skills', 'workflows', 'model-external.md');
    const executor = read('agents', 'fvs-external-modeler.md');
    const reference = read('fv-skills', 'references', 'external-modeling.md');
    const reviewHelper = read('scripts', 'fvs-model-review.mjs');
    const installer = read('bin', 'install.js');
    const contract = [command, workflow, executor, reference].join('\n');

    assert.match(contract, /Unsafe Rust (?:is )?(?:`BLOCKED`|stops)/i);
    assert.match(contract, /HUMAN_RULING/);
    assert.match(contract, /at most three|capped at three/i);
    assert.match(contract, /post-approval model edit invalidates|model edit\s+invalidates/i);
    assert.match(contract, /sorryAx/);
    assert.match(contract, /pre-existing custom axiom/i);
    assert.match(contract, /no new (?:custom )?axiom|introduces no.*axiom/i);
    assert.match(reviewHelper, /runReviewer/);
    assert.match(installer, /'fvs-external-modeler': 'workspace-write'/);
    assert.match(installer, /'fvs-external-modeler': 'xhigh'/);
    assert.match(read('commands', 'fvs', 'help.md'), /\/fvs:model-external/);
  });

  it('resolves and hashes an exact Cargo.lock registry source range', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-model-external-registry-'));
    const cargoHome = path.join(root, 'cargo-home');
    const crate = path.join(cargoHome, 'registry', 'src', 'index.test', 'demo-1.2.3');
    fs.mkdirSync(path.join(crate, 'src'), { recursive: true });
    const source = 'pub fn helper() {}\npub fn demo(x: u32) -> u32 {\n    x + 1\n}\n';
    fs.writeFileSync(path.join(crate, 'src', 'lib.rs'), source);
    fs.writeFileSync(path.join(crate, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "1.2.3"\n');
    fs.writeFileSync(path.join(root, 'Cargo.lock'), `[[package]]\nname = "demo"\nversion = "1.2.3"\nsource = "registry+https://example.invalid/index"\nchecksum = "${'a'.repeat(64)}"\n`);
    const request = path.join(root, 'request.json');
    fs.writeFileSync(request, JSON.stringify({
      strategy: 'registry',
      lockfile: 'Cargo.lock',
      package: 'demo',
      version: '1.2.3',
      source_file: 'src/lib.rs',
      start_line: 2,
      end_line: 4,
      function: 'demo',
    }));

    const result = runHelper(root, ['resolve', request], { CARGO_HOME: cargoHome });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.status, 'RESOLVED');
    assert.equal(record.strategy, 'registry');
    assert.equal(record.revision, '1.2.3');
    assert.equal(record.sha256, sha256(source));
    assert.equal(record.range_sha256, sha256('pub fn demo(x: u32) -> u32 {\n    x + 1\n}\n'));
    assert.deepEqual(record.range, { start_line: 2, end_line: 4 });

    fs.writeFileSync(path.join(crate, 'src', 'lib.rs'), source.replace('pub fn helper() {}', '// @generated'));
    const generated = runHelper(root, ['resolve', request], { CARGO_HOME: cargoHome });
    assert.equal(generated.status, 1);
    assert.match(generated.stderr, /generated source/i);
  });

  it('resolves configured vendored source and rejects disagreement with the Cargo cache', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-model-external-vendor-'));
    const cargoHome = path.join(root, 'cargo-home');
    const vendor = path.join(root, 'vendor', 'demo');
    const cache = path.join(cargoHome, 'registry', 'src', 'index.test', 'demo-1.2.3');
    const source = 'pub fn demo() -> bool {\n    true\n}\n';
    for (const crate of [vendor, cache]) {
      fs.mkdirSync(path.join(crate, 'src'), { recursive: true });
      fs.writeFileSync(path.join(crate, 'src', 'lib.rs'), source);
      fs.writeFileSync(path.join(crate, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "1.2.3"\n');
    }
    fs.writeFileSync(path.join(vendor, '.cargo-checksum.json'), JSON.stringify({
      files: { 'src/lib.rs': sha256(source) },
      package: 'b'.repeat(64),
    }));
    fs.mkdirSync(path.join(root, '.cargo'));
    fs.writeFileSync(path.join(root, '.cargo', 'config.toml'), '[source.crates-io]\nreplace-with = "vendored-sources"\n[source.vendored-sources]\ndirectory = "vendor"\n');
    fs.writeFileSync(path.join(root, 'Cargo.lock'), `[[package]]\nname = "demo"\nversion = "1.2.3"\nsource = "registry+https://example.invalid/index"\nchecksum = "${'b'.repeat(64)}"\n`);
    const request = path.join(root, 'request.json');
    fs.writeFileSync(request, JSON.stringify({
      strategy: 'vendor',
      lockfile: 'Cargo.lock',
      package: 'demo',
      version: '1.2.3',
      source_file: 'src/lib.rs',
      start_line: 1,
      end_line: 3,
      function: 'demo',
    }));

    const resolved = runHelper(root, ['resolve', request], { CARGO_HOME: cargoHome });
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(JSON.parse(resolved.stdout).strategy, 'vendor');

    fs.writeFileSync(path.join(cache, 'src', 'lib.rs'), source.replace('true', 'false'));
    const disagreement = runHelper(root, ['resolve', request], { CARGO_HOME: cargoHome });
    assert.equal(disagreement.status, 1);
    assert.match(disagreement.stderr, /source copies disagree/i);
  });

  it('resolves a Cargo.lock git source only at its exact checked-out revision', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-model-external-git-'));
    const cargoHome = path.join(root, 'cargo-home');
    const checkout = path.join(cargoHome, 'git', 'checkouts', 'demo-hash', 'checkout');
    fs.mkdirSync(path.join(checkout, 'src'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'src', 'lib.rs'), 'pub fn demo() -> u8 { 7 }\n');
    fs.writeFileSync(path.join(checkout, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\n');
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'test@example.invalid'],
      ['config', 'user.name', 'FVS Test'],
      ['remote', 'add', 'origin', 'https://example.invalid/demo'],
      ['add', '.'],
      ['commit', '-qm', 'fixture'],
    ]) {
      const git = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
      assert.equal(git.status, 0, git.stderr);
    }
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(root, 'Cargo.lock'), `[[package]]\nname = "demo"\nversion = "0.1.0"\nsource = "git+https://example.invalid/demo?rev=${commit}#${commit}"\n`);
    const request = path.join(root, 'request.json');
    fs.writeFileSync(request, JSON.stringify({
      strategy: 'git',
      lockfile: 'Cargo.lock',
      package: 'demo',
      version: '0.1.0',
      source_file: 'src/lib.rs',
      start_line: 1,
      end_line: 1,
      function: 'demo',
    }));

    const result = runHelper(root, ['resolve', request], { CARGO_HOME: cargoHome });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.strategy, 'git');
    assert.equal(record.revision, commit);
  });

  it('binds rustc sysroot source to the compiler commit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-model-external-sysroot-'));
    const sysroot = path.join(root, 'toolchain');
    const library = path.join(sysroot, 'lib', 'rustlib', 'src', 'rust', 'library', 'core');
    fs.mkdirSync(path.join(library, 'src'), { recursive: true });
    fs.writeFileSync(path.join(library, 'src', 'lib.rs'), 'pub const fn demo() -> usize { 1 }\n');
    const commit = 'c'.repeat(40);
    const rustc = path.join(root, 'rustc');
    fs.writeFileSync(rustc, `#!/bin/sh\nif [ "$1" = "--print" ]; then printf '%s\\n' "$FAKE_SYSROOT"; else printf 'rustc 1.99.0\\ncommit-hash: ${commit}\\n'; fi\n`);
    fs.chmodSync(rustc, 0o755);
    const request = path.join(root, 'request.json');
    fs.writeFileSync(request, JSON.stringify({
      strategy: 'sysroot',
      package: 'core',
      source_file: 'src/lib.rs',
      start_line: 1,
      end_line: 1,
      function: 'demo',
    }));

    const result = runHelper(root, ['resolve', request], { RUSTC: rustc, FAKE_SYSROOT: sysroot });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.strategy, 'sysroot');
    assert.equal(record.revision, commit);
    assert.equal(record.authority, 'rustc 1.99.0');
  });

  it('restores every canonical target and preserves the failed candidate patch', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-model-external-transaction-'));
    fs.mkdirSync(path.join(root, 'Specs'));
    fs.writeFileSync(path.join(root, 'ExternalModel.lean'), 'def demo := 0\n');
    const request = path.join(root, 'begin.json');
    fs.writeFileSync(request, JSON.stringify({
      run: 'demo-n1',
      root_stub: 'demo',
      closure: ['demo'],
      targets: ['ExternalModel.lean', 'Specs/Demo.lean'],
      source_records: [sourceRecord(root)],
    }));

    const begun = runHelper(root, ['begin', request]);
    assert.equal(begun.status, 0, begun.stderr);
    const run = JSON.parse(begun.stdout).run_directory;
    assert.equal(fs.readFileSync(path.join(run, 'source', '000-authoritative.rs'), 'utf8'),
      'pub fn demo() -> bool { true }\n');
    fs.writeFileSync(path.join(root, 'ExternalModel.lean'), 'def demo := 1\n');
    fs.writeFileSync(path.join(root, 'Specs', 'Demo.lean'), 'theorem demo_spec : True := by trivial\n');

    const restored = runHelper(root, ['restore', run]);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'ExternalModel.lean'), 'utf8'), 'def demo := 0\n');
    assert.equal(fs.existsSync(path.join(root, 'Specs', 'Demo.lean')), false);
    const patch = fs.readFileSync(path.join(run, 'candidate.patch'), 'utf8');
    assert.match(patch, /def demo := 1/);
    assert.match(patch, /theorem demo_spec/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'result.json'), 'utf8')).status, 'RESTORED');
  });

  it('refuses generated Lean before creating a candidate transaction', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-model-external-generated-'));
    fs.writeFileSync(path.join(root, 'Funs.lean'), '-- generated\n');
    const request = path.join(root, 'begin.json');
    fs.writeFileSync(request, JSON.stringify({
      run: 'generated-n1',
      root_stub: 'demo',
      closure: ['demo'],
      targets: ['Funs.lean'],
      source_records: [{ range_sha256: 'e'.repeat(64) }],
    }));

    const result = runHelper(root, ['begin', request]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /generated Lean target is immutable/i);
    assert.equal(fs.existsSync(path.join(root, '.formalising', 'model-external', 'generated-n1')), false);

    fs.writeFileSync(path.join(root, 'FunsExternal.lean'), '-- AUTO-GENERATED FILE: DO NOT EDIT\n');
    fs.writeFileSync(request, JSON.stringify({
      run: 'legacy-external-n1',
      root_stub: 'demo',
      closure: ['demo'],
      targets: ['FunsExternal.lean'],
      source_records: [sourceRecord(root)],
    }));
    const legacy = runHelper(root, ['begin', request]);
    assert.equal(legacy.status, 1);
    assert.match(legacy.stderr, /legacy generated FunsExternal\.lean requires migration/i);
    assert.equal(fs.existsSync(path.join(root, '.formalising', 'model-external', 'legacy-external-n1')), false);
  });

  it('finalizes only review-bound, proved, built, CLEAN target hashes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-model-external-finalize-'));
    fs.mkdirSync(path.join(root, 'Specs'));
    fs.writeFileSync(path.join(root, 'ExternalModel.lean'), 'def demo := 0\n');
    fs.writeFileSync(path.join(root, 'Specs', 'Demo.lean'), 'theorem demo_spec : True := by trivial\n');
    const begin = path.join(root, 'begin.json');
    fs.writeFileSync(begin, JSON.stringify({
      run: 'demo-final',
      root_stub: 'demo',
      closure: ['demo'],
      targets: ['ExternalModel.lean', 'Specs/Demo.lean'],
      source_records: [sourceRecord(root)],
    }));
    const started = runHelper(root, ['begin', begin]);
    assert.equal(started.status, 0, started.stderr);
    const run = JSON.parse(started.stdout).run_directory;
    for (const name of ['model-review.md', 'specification-review.md', 'proof.log', 'build.log', 'trust.md']) {
      fs.writeFileSync(path.join(run, name), `${name}\n`);
    }
    const resultFile = path.join(root, 'result.json');
    fs.writeFileSync(resultFile, JSON.stringify({
      status: 'COMPLETE',
      model_review: {
        verdict: 'PASS', round: 1, evidence: 'model-review.md',
        approved_sha256: { 'ExternalModel.lean': sha256('def demo := 0\n') },
      },
      specification_review: {
        verdict: 'PASS', round: 1, evidence: 'specification-review.md',
        tracked_files: ['Specs/Demo.lean'], approved_surface_sha256: 'a'.repeat(64),
      },
      proof: { status: 'PASS', evidence: 'proof.log' },
      build: { status: 'PASS', evidence: 'build.log' },
      trust: { status: 'CLEAN', evidence: 'trust.md', sorries: [], new_axioms: [], uninspectable: [] },
      custom_axioms: [],
    }));

    fs.appendFileSync(path.join(root, 'ExternalModel.lean'), '-- changed after model review\n');
    const invalidated = runHelper(root, ['finalize', run, resultFile]);
    assert.equal(invalidated.status, 1);
    assert.match(invalidated.stderr, /model changed after approval/i);
    fs.writeFileSync(path.join(root, 'ExternalModel.lean'), 'def demo := 0\n');

    const finalized = runHelper(root, ['finalize', run, resultFile]);
    assert.equal(finalized.status, 0, finalized.stderr);
    const result = JSON.parse(fs.readFileSync(path.join(run, 'result.json'), 'utf8'));
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.target_sha256['ExternalModel.lean'], sha256('def demo := 0\n'));
  });

  it('records separate immutable model and specification reviews', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-model-external-review-'));
    const run = path.join(root, '.formalising', 'model-external', 'demo');
    fs.mkdirSync(path.join(run, 'source'), { recursive: true });
    fs.writeFileSync(path.join(run, 'source', '000-source.rs'), 'pub fn demo() -> bool { true }\n');
    fs.writeFileSync(path.join(root, 'ExternalModel.lean'), 'def demo := true\n');
    fs.writeFileSync(path.join(root, 'DemoSpec.lean'), 'theorem demo_spec : demo = true := rfl\n');
    fs.writeFileSync(path.join(run, 'journal.json'), JSON.stringify({
      version: 1,
      project_root: fs.realpathSync(root),
      source_records: [{ evidence: 'source/000-source.rs' }],
      targets: [{ path: 'ExternalModel.lean' }, { path: 'DemoSpec.lean' }],
    }));

    for (const mode of ['model', 'specification']) {
      const request = path.join(root, `${mode}.json`);
      const input = mode === 'model' ? 'ExternalModel.lean' : 'DemoSpec.lean';
      fs.writeFileSync(request, JSON.stringify({
        mode,
        round: 1,
        runtime: 'other',
        model: 'external-reviewer',
        effort: 'high',
        author_runtime: 'codex',
        run_directory: '.formalising/model-external/demo',
        inputs: ['.formalising/model-external/demo/source/000-source.rs', input],
        history: [],
      }));
      const prepared = runHelper(root, ['prepare', request], {}, REVIEW_SCRIPT);
      assert.equal(prepared.status, 0, prepared.stderr);
      const reviewDirectory = JSON.parse(prepared.stdout).review_directory;
      const title = mode === 'model'
        ? '# FVS External Model Review'
        : '# FVS External Specification Review';
      const response = path.join(root, `${mode}-response.md`);
      fs.writeFileSync(response, `${title}\n\n## Findings\n\nnone\n\n## Source coverage\n\nAll supplied source and Lean inputs reviewed.\n\n## Evidence\n\nCompared the complete immutable packet.\n\nVERDICT: PASS\n`);
      if (mode === 'model') {
        fs.appendFileSync(path.join(root, input), '-- changed after approval packet\n');
        const stale = runHelper(root, ['import', reviewDirectory, response], {}, REVIEW_SCRIPT);
        assert.equal(stale.status, 1);
        assert.match(stale.stderr, /input changed after packet creation/i);
        fs.writeFileSync(path.join(root, input), 'def demo := true\n');
      }
      const imported = runHelper(root, ['import', reviewDirectory, response], {}, REVIEW_SCRIPT);
      assert.equal(imported.status, 0, imported.stderr);
      assert.match(fs.readFileSync(path.join(reviewDirectory, 'review.md'), 'utf8'), /VERDICT: PASS/);
    }

    const bin = path.join(root, 'fake-bin');
    fs.mkdirSync(bin);
    const payload = '# FVS External Model Review\n\n## Findings\nNone.\n\n## Source coverage\nCompared all source and model inputs.\n\n## Evidence\nsource.rs:1\n\nVERDICT: PASS\n';
    const fake = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('1.0.0'); process.exit(0); }",
      "if (args[0] === 'login') { if (process.env.FVS_FAKE_MODEL_MODE === 'auth') setInterval(() => {}, 1000); else process.exit(0); }",
      `let response = ${JSON.stringify(payload)};`,
      "if (process.env.FVS_FAKE_MODEL_MODE === 'wrapper') response = 'Review complete.\\n' + response;",
      "if (process.env.FVS_FAKE_MODEL_MODE === 'competing') response += '\\nVERDICT: REVISE';",
      "if (process.env.FVS_FAKE_MODEL_MODE === 'fail') { process.stderr.write('fake failed'); process.exit(9); }",
      "fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], response);",
      "if (process.env.FVS_FAKE_MODEL_MODE === 'root-exited') { const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:['ignore','inherit','inherit']}); fs.writeFileSync(process.env.FVS_FAKE_PID_FILE, String(child.pid)); }",
    ].join('\n');
    fs.writeFileSync(path.join(bin, 'codex'), fake, { mode: 0o755 });
    const nativeEnv = { PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FVS_REVIEW_TIMEOUT_MS: '1100', FVS_REVIEW_AUTH_TIMEOUT_MS: '2500',
      FVS_FAKE_PID_FILE: path.join(root, 'review-child.pid') };
    for (const mode of ['wrapper', 'competing', 'fail', 'auth', 'root-exited']) {
      const modeRun = path.join(root, '.formalising', 'model-external', mode);
      fs.mkdirSync(path.join(modeRun, 'source'), { recursive: true });
      fs.copyFileSync(path.join(run, 'source/000-source.rs'), path.join(modeRun, 'source/000-source.rs'));
      fs.writeFileSync(path.join(modeRun, 'journal.json'), JSON.stringify({
        ...JSON.parse(fs.readFileSync(path.join(run, 'journal.json'))),
        project_root: fs.realpathSync(root),
        source_records: [{ evidence: 'source/000-source.rs' }],
      }));
      const request = path.join(root, `${mode}-run.json`);
      fs.writeFileSync(request, JSON.stringify({ mode: 'model', round: 1, runtime: 'codex',
        model: 'exact-test-model', effort: 'high', author_runtime: 'claude',
        run_directory: `.formalising/model-external/${mode}`,
        inputs: [`.formalising/model-external/${mode}/source/000-source.rs`, 'ExternalModel.lean'], history: [] }));
      const result = runHelper(root, ['run', request], { ...nativeEnv, FVS_FAKE_MODEL_MODE: mode }, REVIEW_SCRIPT);
      if (!['darwin', 'linux'].includes(process.platform)) {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Unsupported reviewer process cleanup/);
        continue;
      }
      const latest = path.join(modeRun, 'reviews', 'model-round-1');
      if (mode === 'wrapper') {
        assert.equal(result.status, 0, result.stderr);
        assert.match(fs.readFileSync(path.join(latest, 'review.md'), 'utf8'), /VERDICT: PASS/);
      } else {
        assert.notEqual(result.status, 0, `${mode}: ${result.stderr}`);
        assert.match(result.stderr, /Review attempt preserved|invalid response preserved/);
        assert.ok(!fs.existsSync(path.join(latest, 'review.md')));
        if (mode === 'root-exited') {
          assert.match(result.stderr, /deadline/);
          assert.throws(() => process.kill(Number(fs.readFileSync(nativeEnv.FVS_FAKE_PID_FILE, 'utf8')), 0), /ESRCH/);
        }
      }
    }

    const overCap = path.join(root, 'over-cap.json');
    fs.writeFileSync(overCap, JSON.stringify({
      mode: 'model', round: 4, runtime: 'other', model: 'external-reviewer', effort: 'high',
      author_runtime: 'codex', run_directory: '.formalising/model-external/demo',
      inputs: ['.formalising/model-external/demo/source/000-source.rs', 'ExternalModel.lean'], history: [],
    }));
    const rejected = runHelper(root, ['prepare', overCap], {}, REVIEW_SCRIPT);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /round must be between 1 and 3/i);
  });
});
