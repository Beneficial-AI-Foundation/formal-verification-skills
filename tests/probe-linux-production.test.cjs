'use strict';

const { it, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

describe('Linux production staging and host socket isolation', {
  skip: process.platform !== 'linux' || process.arch !== 'x64',
}, () => {
  let planLinuxSandbox, runLinuxSandbox, runLinuxStagedExtract;
  let root, home, project, bin, env;
  const live = { skip: !fs.existsSync('/usr/bin/bwrap') ? 'bubblewrap unavailable' : false };
  const ordinary = { skip: live.skip || (process.getuid?.() === 0 ? 'requires an ordinary user' : false) };
  before(async () => {
    ({ planLinuxSandbox, runLinuxSandbox, runLinuxStagedExtract } = await import('../scripts/fvs-probe-linux.mjs'));
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.homedir(), '.fvs-linux-production-'));
    [home, project, bin] = ['home', 'developer checkout', 'tools'].map((name) => {
      const value = path.join(root, name);
      fs.mkdirSync(value);
      return value;
    });
    fs.mkdirSync(path.join(home, '.cargo'));
    env = { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
    fs.writeFileSync(path.join(project, 'source.rs'), 'original source');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  function probe(code) {
    const file = path.join(bin, 'probe');
    fs.writeFileSync(file, `#!${process.execPath}\n${code}\n`, { mode: 0o755 });
    return file;
  }
  function staged(code, extra = {}) {
    return runLinuxStagedExtract({ probePath: probe(code), projectRoot: project, rustProject: project, sourceEnv: env, ...extra });
  }
  function readOnly(code, extra = {}) {
    return planLinuxSandbox({ command: process.execPath, commandArgs: ['-e', code], cwd: project, sourceEnv: env, ...extra });
  }

  it('live staging preserves source paths while isolating source, tool aliases and Cargo target siblings', live, () => {
    const protectedFile = path.join(home, '.cargo', 'sentinel');
    fs.writeFileSync(protectedFile, 'protected');
    fs.linkSync(protectedFile, path.join(project, 'hardlink'));
    fs.symlinkSync(path.join(home, '.cargo'), path.join(project, 'tool-alias'));
    const result = staged(`
      const fs = require('fs'), path = require('path');
      const root = process.argv[3], out = process.argv[5];
      fs.writeFileSync(path.join(root, 'source.rs'), 'changed staged source');
      fs.writeFileSync(path.join(root, 'hardlink'), 'changed independent copy');
      fs.mkdirSync(path.join(root, 'targetAb1234'));
      let denied = false;
      try {
        fs.writeFileSync(path.join(root, 'tool-alias', 'sentinel'), 'bad');
      } catch (error) {
        denied = ['EROFS', 'EACCES', 'EPERM'].includes(error.code);
      }
      if (!denied) throw Error('tool alias writable');
      let missingHomeDenied = false;
      try {
        fs.mkdirSync(path.join(process.env.HOME, '.probe-rust'));
      } catch (error) {
        missingHomeDenied = ['EROFS', 'EACCES', 'EPERM'].includes(error.code);
      }
      if (!missingHomeDenied) throw Error('missing helper home creation allowed');
      fs.writeFileSync(out, JSON.stringify({ originalPath: root, staged: true }));
    `);
    assert.equal(result.ok, true, result.stderr || result.error);
    assert.deepEqual(JSON.parse(result.outputText), { originalPath: project, staged: true });
    assert.equal(fs.readFileSync(path.join(project, 'source.rs'), 'utf8'), 'original source');
    assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'protected');
    assert.equal(fs.existsSync(path.join(project, 'targetAb1234')), false);
    assert.equal(fs.existsSync(path.join(home, '.probe-rust')), false);
    for (const dir of result.policy.writable.slice(1)) assert.equal(fs.existsSync(dir), false);
  });

  it('live failure removes partial candidate and preserves diagnostics', live, () => {
    const result = staged(`
      require('fs').writeFileSync(process.argv[5], '{}');
      console.error('intentional helper failure');
      process.exit(29);
    `);
    assert.equal(result.ok, false);
    assert.equal(result.status, 29);
    assert.equal(result.outputText, undefined);
    assert.match(result.stderr, /intentional helper failure/);
    for (const dir of result.policy.writable.slice(1)) assert.equal(fs.existsSync(dir), false);
  });

  it('stages read-only source directories with owner access and preserves source modes', ordinary, () => {
    const vendor = path.join(project, 'vendor');
    const nested = path.join(vendor, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'input'), 'read-only source', { mode: 0o444 });
    fs.writeFileSync(path.join(nested, 'executable'), '#!/bin/sh\n', { mode: 0o555 });
    fs.chmodSync(nested, 0o555);
    fs.chmodSync(vendor, 0o555);
    try {
      const result = staged(`
        const fs = require('fs'), path = require('path');
        const nested = path.join(process.argv[3], 'vendor', 'nested');
        if ((fs.statSync(nested).mode & 0o700) !== 0o700) throw Error('owner access missing');
        if ((fs.statSync(path.join(nested, 'input')).mode & 0o777) !== 0o444) throw Error('file mode changed');
        if ((fs.statSync(path.join(nested, 'executable')).mode & 0o777) !== 0o555) throw Error('executable mode changed');
        fs.writeFileSync(path.join(nested, 'generated'), 'private');
        fs.writeFileSync(process.argv[5], '{}');
      `);
      assert.equal(result.ok, true, result.stderr || result.error);
      assert.equal(fs.statSync(vendor).mode & 0o777, 0o555);
      assert.equal(fs.statSync(nested).mode & 0o777, 0o555);
      assert.equal(fs.statSync(path.join(nested, 'input')).mode & 0o777, 0o444);
      assert.equal(fs.statSync(path.join(nested, 'executable')).mode & 0o777, 0o555);
      assert.equal(fs.readFileSync(path.join(nested, 'input'), 'utf8'), 'read-only source');
      assert.equal(fs.existsSync(path.join(nested, 'generated')), false);
      assert.equal(fs.existsSync(path.dirname(result.policy.writable[1])), false);
    } finally {
      fs.chmodSync(vendor, 0o755);
      fs.chmodSync(nested, 0o755);
    }
  });

  for (const status of [0, 29]) {
    it(`removes child-created inaccessible directories after exit ${status} without following aliases`, ordinary, () => {
      const sourceSentinel = path.join(project, 'source.rs');
      const sourceMode = fs.statSync(sourceSentinel).mode;
      const protectedDir = path.join(home, '.cargo', 'sentinel');
      fs.mkdirSync(protectedDir);
      fs.writeFileSync(path.join(protectedDir, 'file'), 'protected', { mode: 0o444 });
      fs.chmodSync(protectedDir, 0o555);
      try {
        const result = staged(`
          const fs = require('fs'), path = require('path');
          const blocked = path.join(process.argv[3], 'blocked');
          fs.mkdirSync(blocked);
          fs.writeFileSync(path.join(blocked, 'file'), 'private');
          fs.symlinkSync(${JSON.stringify(protectedDir)}, path.join(blocked, 'tools'));
          fs.symlinkSync(${JSON.stringify(sourceSentinel)}, path.join(blocked, 'source'));
          fs.chmodSync(blocked, 0o000);
          fs.writeFileSync(process.argv[5], '{}');
          console.log('child stdout');
          console.error('child stderr');
          process.exit(${status});
        `);
        assert.equal(result.ok, status === 0, result.error);
        assert.equal(result.status, status);
        assert.equal(result.stdout.trim(), 'child stdout');
        assert.equal(result.stderr.trim(), 'child stderr');
        assert.equal(result.outputText, status === 0 ? '{}' : undefined);
        assert.equal(result.cleanupError, undefined);
        assert.equal(fs.existsSync(path.dirname(result.policy.writable[1])), false);
        assert.equal(fs.existsSync(path.join(project, 'blocked')), false);
        assert.equal(fs.readFileSync(sourceSentinel, 'utf8'), 'original source');
        assert.equal(fs.statSync(sourceSentinel).mode, sourceMode);
        assert.equal(fs.statSync(protectedDir).mode & 0o777, 0o555);
        assert.equal(fs.statSync(path.join(protectedDir, 'file')).mode & 0o777, 0o444);
        assert.equal(fs.readFileSync(path.join(protectedDir, 'file'), 'utf8'), 'protected');
      } finally {
        fs.chmodSync(protectedDir, 0o755);
      }
    });

    it(`reports injected cleanup failure after child exit ${status} without returning candidate bytes`, live, () => {
      const remove = fs.rmSync;
      let stage;
      let attempts = 0;
      fs.rmSync = (file, options) => {
        if (typeof file === 'string' && path.dirname(file) === '/tmp' && path.basename(file).startsWith('fvs-probe-stage-')) {
          stage = file;
          attempts += 1;
          throw Object.assign(new Error('injected cleanup denial'), { code: 'EPERM', path: file });
        }
        return remove(file, options);
      };
      try {
        const result = staged(`
          require('fs').writeFileSync(process.argv[5], '{}');
          console.log('child stdout');
          console.error('child stderr');
          process.exit(${status});
        `);
        assert.equal(result.ok, false);
        assert.equal(result.status, status);
        assert.equal(result.stdout.trim(), 'child stdout');
        assert.equal(result.stderr.trim(), 'child stderr');
        assert.equal(result.outputText, undefined);
        assert.equal(result.primaryError, status === 0 ? null : 'bubblewrap/child exited with 29');
        assert.deepEqual(result.cleanupError, { code: 'EPERM', message: 'injected cleanup denial', path: stage });
        assert.equal(result.retainedStage, stage);
        assert.match(result.error, /cannot remove private staging directory.*injected cleanup denial/);
        assert.equal(attempts, 2);
        assert.equal(fs.existsSync(stage), true);
        assert.equal(fs.readFileSync(path.join(project, 'source.rs'), 'utf8'), 'original source');
      } finally {
        fs.rmSync = remove;
        if (stage) remove(stage, { recursive: true, force: true });
      }
    });
  }

  it('rejects malformed nested .git files explicitly before running the child', () => {
    const fixture = path.join(project, 'fixture');
    fs.mkdirSync(fixture);
    const file = path.join(fixture, '.git');
    fs.writeFileSync(file, 'ordinary fixture text');
    const result = staged('throw Error("child must not run")');
    assert.equal(result.ok, false);
    assert.equal(result.status, null);
    assert.match(result.error, /unsupported \.git file \(expected a gitdir pointer\)/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'ordinary fixture text');
  });

  it('rejects a gitdir pointer to an ordinary external data directory before running the child', () => {
    const external = path.join(root, 'external-data');
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'HEAD'), 'ordinary data');
    fs.writeFileSync(path.join(external, 'sentinel'), 'unchanged');
    fs.writeFileSync(path.join(project, '.git'), `gitdir: ${external}\n`);
    const result = staged('throw Error("child must not run")');
    assert.equal(result.ok, false);
    assert.equal(result.status, null);
    assert.match(result.error, /unsupported Git metadata layout \(expected an objects directory\)/);
    assert.equal(fs.readFileSync(path.join(external, 'sentinel'), 'utf8'), 'unchanged');
  });

  for (const nested of [false, true]) {
    it(`rejects ${nested ? 'nested' : 'root'} symlinked .git entries before running the child`, () => {
      const metadata = path.join(root, 'external-git');
      fs.mkdirSync(metadata);
      fs.writeFileSync(path.join(metadata, 'HEAD'), 'unchanged');
      const base = nested ? path.join(project, 'nested') : project;
      if (nested) fs.mkdirSync(base);
      const alias = path.join(base, '.git');
      fs.symlinkSync(metadata, alias);
      const result = staged('throw Error("child must not run")');
      assert.equal(result.ok, false);
      assert.equal(result.status, null);
      assert.match(result.error, /symlinked \.git entries are unsupported/);
      assert.equal(fs.readlinkSync(alias), metadata);
      assert.equal(fs.readFileSync(path.join(metadata, 'HEAD'), 'utf8'), 'unchanged');
    });
  }

  it('live staging preserves linked Git worktree provenance with read-only metadata', live, () => {
    const main = path.join(root, 'git-main');
    fs.mkdirSync(main);
    const git = (args) => {
      const result = spawnSync('/usr/bin/git', args, { cwd: main, encoding: 'utf8', env: { ...process.env, HOME: home } });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init', '--quiet']);
    git(['-c', 'user.name=FVS test', '-c', 'user.email=fvs@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
    const worktree = path.join(root, 'linked-worktree');
    git(['worktree', 'add', '--detach', worktree, 'HEAD']);
    const expected = git(['rev-parse', 'HEAD']);
    const before = fs.readFileSync(path.join(main, '.git', 'HEAD'), 'utf8');
    const result = staged(`
      const fs = require('fs'), cp = require('child_process');
      const revision = cp.execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      fs.writeFileSync(process.argv[5], JSON.stringify({ revision }));
    `, { projectRoot: worktree, rustProject: worktree });
    assert.equal(result.ok, true, result.stderr || result.error);
    assert.equal(JSON.parse(result.outputText).revision, expected);
    assert.equal(fs.readFileSync(path.join(main, '.git', 'HEAD'), 'utf8'), before);
  });

  it('live candidate symlinks are rejected without reading their targets', live, () => {
    const result = staged(`require('fs').symlinkSync('/etc/passwd', process.argv[5]);`);
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.outputText, undefined);
    assert.match(result.error, /independent regular file/);
  });

  it('live proxy executable basename is preserved', live, () => {
    const alias = path.join(bin, 'rust-analyzer');
    fs.symlinkSync(process.execPath, alias);
    const result = runLinuxSandbox(readOnly('console.log(process.argv0)', { command: alias }));
    assert.equal(result.ok, true, result.stderr || result.error);
    assert.equal(result.stdout.trim(), alias);
  });

  it('live socket in an explicitly visible project cannot connect to the host', live, async () => {
    // AF_UNIX path names have a short kernel limit. Bind/connect relative to
    // cwd so the fixture also works under a long dedicated CI/tool HOME.
    const socket = 'host-control.sock';
    const server = net.createServer();
    const originalCwd = process.cwd();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      try {
        process.chdir(project);
        server.listen(socket, resolve);
      } finally {
        process.chdir(originalCwd);
      }
    });
    try {
      const code = `
        const socket = require('net').connect(${JSON.stringify(socket)});
        socket.on('connect', () => {
          socket.destroy();
          process.exit(0);
        });
        socket.on('error', (error) => {
          console.error(error.code);
          process.exit(4);
        });
      `;
      const control = spawnSync(process.execPath, ['-e', code], { cwd: project, encoding: 'utf8', timeout: 3000 });
      assert.equal(control.status, 0, control.stderr);
      const result = runLinuxSandbox(readOnly(code));
      assert.equal(result.ok, false);
      assert.equal(result.status, 4);
      assert.match(result.stderr, /EPERM|EACCES/);
    } finally {
      server.close();
    }
  });

  it('live root allowlist excludes WSL GUI, init and unrelated home files', live, () => {
    const secret = path.join(home, 'unrelated');
    fs.writeFileSync(secret, 'private');
    const result = runLinuxSandbox(readOnly(`
      const fs = require('fs');
      for (const file of ['/mnt/wslg', '/init', ${JSON.stringify(secret)}]) {
        if (fs.existsSync(file)) throw Error('unexpected host path: ' + file);
      }
    `));
    assert.equal(result.ok, true, result.stderr || result.error);
  });

  it('live denied nested namespaces fail closed without executing the requested command', live, () => {
    const outputDir = path.join(root, 'out');
    const privateTmp = path.join(root, 'tmp');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(privateTmp);
    const marker = path.join(outputDir, 'must-not-exist');
    const runtime = path.resolve(__dirname, '../scripts/fvs-probe-linux.mjs');
    const code = `
      import(${JSON.stringify(pathToFileURL(runtime).href)}).then(({ planLinuxSandbox, runLinuxSandbox }) => {
        const plan = planLinuxSandbox({
          command: process.execPath, cwd: ${JSON.stringify(project)},
          commandArgs: ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'escaped')`)}],
        });
        console.log(JSON.stringify(runLinuxSandbox(plan)));
      }).catch((error) => {
        console.error(error);
        process.exit(9);
      });
    `;
    const outer = runLinuxSandbox(readOnly(code, {
      mode: 'extract', projectRoot: project, outputDir, privateTmp, disposableProject: true,
      readOnlyPaths: [path.dirname(runtime)],
    }));
    assert.equal(outer.ok, true, outer.stderr || outer.error);
    const denied = JSON.parse(outer.stdout);
    assert.equal(denied.ok, false);
    assert.ok(Number.isInteger(denied.status) && denied.status !== 0);
    assert.match(denied.stderr, /bwrap:.*(?:namespace|uid map|Operation not permitted|Permission denied)/i);
    assert.equal(fs.existsSync(marker), false);
  });

  it('extract mode rejects hardlinked writable files', () => {
    const tool = path.join(home, '.cargo', 'tool');
    fs.writeFileSync(tool, 'protected');
    fs.linkSync(tool, path.join(project, 'alias'));
    const outputDir = path.join(root, 'out');
    const privateTmp = path.join(root, 'tmp');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(privateTmp);
    assert.throws(() => readOnly('', { mode: 'extract', projectRoot: project, outputDir, privateTmp, disposableProject: true }), /hardlink/);
  });

  it('extract mode permits Cargo hardlinks entirely within its writable tree', () => {
    fs.linkSync(path.join(project, 'source.rs'), path.join(project, 'internal-build-alias'));
    const outputDir = path.join(root, 'out');
    const privateTmp = path.join(root, 'tmp');
    fs.mkdirSync(outputDir);
    fs.mkdirSync(privateTmp);
    const plan = readOnly('', { mode: 'extract', projectRoot: project, outputDir, privateTmp, disposableProject: true });
    assert.equal(plan.mode, 'extract');
  });

  it('runtime and filesystem roots cannot enter through protected/read paths', () => {
    for (const value of ['/', '/mnt/wslg', '/run']) {
      assert.throws(() => readOnly('', { additionalProtected: [value] }), /hidden|HOME or its ancestors/);
      assert.throws(() => readOnly('', { readOnlyPaths: [value] }), /runtime or filesystem root/);
    }
  });

  it('rejects runtime cwd descendants and symlink aliases before constructing a sandbox', () => {
    const temporary = fs.mkdtempSync('/tmp/fvs-probe-cwd-');
    const proc = `/proc/${process.pid}`;
    const alias = path.join(root, 'proc-alias');
    fs.symlinkSync(proc, alias);
    try {
      for (const cwd of [proc, alias, temporary, '/dev/pts', '/sys/kernel', '/run/lock', '/mnt/wslg']) {
        if (!fs.existsSync(cwd)) continue;
        assert.throws(() => readOnly('', { cwd }), /cwd must not be a filesystem or runtime root or descendant/);
      }
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('production rejects Rust sources outside its staged project', () => {
    const result = staged('', { rustProject: home });
    assert.equal(result.ok, false);
    assert.match(result.error, /inside projectRoot/);
  });

  it('production rejects custom tool homes within the developer checkout', () => {
    const result = staged('', { sourceEnv: { ...env, CARGO_HOME: path.join(project, 'custom-cargo') } });
    assert.equal(result.ok, false);
    assert.match(result.error, /overlaps protected/);
    assert.equal(fs.existsSync(path.join(project, 'custom-cargo')), false);
  });
});
