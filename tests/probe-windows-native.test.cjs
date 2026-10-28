'use strict';

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const WINDOWS = 'x86_64-pc-windows-msvc';

describe('native Windows official-release refusal', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
}, () => {
  const runtimes = [];
  const calls = [];
  let directory;
  let projectRoot;
  let probePath;
  let toolsRoot;
  let originalSpawnSync;

  before(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs Windows refusal '));
    projectRoot = path.join(directory, 'source project');
    toolsRoot = path.join(directory, 'absent tool home');
    probePath = path.join(directory, 'probe-aeneas.exe');
    fs.mkdirSync(path.join(projectRoot, 'Crate'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, 'rust crate'));
    const tuple = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'probe-compatibility.json'), 'utf8')).tuples[0];
    fs.writeFileSync(path.join(projectRoot, 'rust crate', 'Cargo.toml'), '[package]\nname = "native-refusal"\n');
    fs.writeFileSync(path.join(projectRoot, 'aeneas-config.yml'),
      `aeneas:\n  commit: "${tuple.aeneasRev}"\ncrate:\n  dir: "rust crate"\naeneas_args:\n  dest: "Crate"\n`);
    fs.writeFileSync(path.join(projectRoot, 'lake-manifest.json'), JSON.stringify({
      packages: [{ name: 'aeneas', rev: tuple.aeneasRev }],
    }));
    fs.writeFileSync(path.join(projectRoot, 'lean-toolchain'), `${tuple.leanToolchain}\n`);
    fs.writeFileSync(path.join(projectRoot, 'Crate', 'translation.json'), JSON.stringify({
      aeneas_version: tuple.aeneasRev, charon_version: tuple.charonVersion,
    }));
    fs.writeFileSync(probePath, 'unverified candidate must never execute');

    originalSpawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (...args) => {
      calls.push(args);
      throw new Error('unsupported Windows must not spawn a helper');
    };
    syncBuiltinESMExports();
    for (const relative of ['scripts', 'plugins/fvs/scripts']) {
      runtimes.push([relative, await import(pathToFileURL(path.join(ROOT, relative, 'fvs-probe-inventory.mjs')).href)]);
    }
  });

  after(() => {
    if (originalSpawnSync) {
      childProcess.spawnSync = originalSpawnSync;
      syncBuiltinESMExports();
    }
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('refuses native and foreign targets without probing tools or offering installation', () => {
    for (const [name, runtime] of runtimes) {
      assert.equal(runtime.hostTarget(), WINDOWS, name);
      assert.deepEqual(runtime.readProvenance(projectRoot).problems, [], name);
      for (const platform of [undefined, WINDOWS, 'x86_64-unknown-linux-gnu', 'aarch64-apple-darwin']) {
        const result = runtime.resolveProbe({ projectRoot, probe: probePath, distribution: 'official', ...(platform ? { platform } : {}) });
        assert.equal(result.status, 'unsupported-platform', `${name}: ${platform}`);
        assert.equal(result.install.available, false);
        assert.equal(result.probe, null);
        assert.deepEqual(result.helpers, {});
      }
    }
    assert.deepEqual(calls, []);
  });

  it('refuses download and local-archive installation without creating a tool home', async () => {
    let downloads = 0;
    for (const [, runtime] of runtimes) {
      for (const archive of [null, path.join(directory, 'missing archive.zip')]) {
        await assert.rejects(runtime.installProbe({
          toolsRoot, target: WINDOWS, decision: 'interactive', archive,
          fetchImpl: async () => { downloads += 1; throw new Error('unexpected download'); },
        }), /not installable/);
      }
    }
    assert.equal(downloads, 0);
    assert.equal(fs.existsSync(toolsRoot), false);
    assert.deepEqual(calls, []);
  });

  it('refuses direct extraction and preserves existing output and protected source bytes', () => {
    const original = Buffer.from('existing output must survive\r\n');
    const source = path.join(projectRoot, 'protected.txt');
    fs.writeFileSync(source, original);
    for (const [name, runtime] of runtimes) {
      const output = path.join(directory, 'existing graph.json');
      fs.writeFileSync(output, original);
      for (const destination of [output, path.join(directory, 'absent graph.json')]) {
        const result = runtime.confinedExtract({
          probePath, projectRoot, rustProject: path.join(projectRoot, 'rust crate'),
          output: destination, stdio: 'pipe',
        });
        assert.equal(result.ok, false, name);
        assert.match(result.error, /confinement is unavailable/);
      }
      assert.deepEqual(fs.readFileSync(output), original);
      assert.equal(fs.existsSync(path.join(directory, 'absent graph.json')), false);
    }
    assert.deepEqual(fs.readFileSync(source), original);
    assert.deepEqual(calls, []);
  });
});
