'use strict';

const { it, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const BWRAP = '/usr/bin/bwrap';
const XZ = '/usr/bin/xz';

describe('Linux x64 confinement', {
  skip: process.platform !== 'linux' || process.arch !== 'x64' ? 'Linux x64-specific backend' : false,
}, () => {
  let realish, decodeLinuxTarXz, planLinuxSandbox, runLinuxSandbox, selectProbeToolPaths;
  before(async () => {
    ({ realish, decodeLinuxTarXz, planLinuxSandbox, runLinuxSandbox, selectProbeToolPaths } =
      await import('../scripts/fvs-probe-linux.mjs'));
  });

  let root, home, project, output, tmp, env;
  const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  beforeEach(() => {
    // Keep tool homes outside runtime directories deliberately masked by bwrap.
    root = fs.mkdtempSync(path.join(os.homedir(), '.fvs-linux-unit-'));
    [home, project, output, tmp] = ['home', 'project space', 'output', 'tmp'].map((name) => {
      const value = path.join(root, name);
      fs.mkdirSync(value);
      return value;
    });
    fs.mkdirSync(path.join(home, '.cargo'));
    env = { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function plan(overrides = {}) {
    return planLinuxSandbox({ command: process.execPath, commandArgs: ['--version'], cwd: project, sourceEnv: env, ...overrides });
  }

  function extract(overrides = {}) {
    return plan({ mode: 'extract', projectRoot: project, outputDir: output, privateTmp: tmp, disposableProject: true, ...overrides });
  }

  function pair(args, flag, value) {
    return args.some((item, index) => item === flag && args[index + 1] === value);
  }

  it('read-only plan names bubblewrap absolutely', () => {
    assert.equal(plan().file, BWRAP);
  });

  it('network, user and process isolation are mandatory, never try variants', () => {
    const args = plan().args;
    const flags = [
      '--unshare-user', '--disable-userns', '--unshare-net', '--unshare-pid',
      '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session',
    ];
    for (const flag of flags) assert.ok(args.includes(flag));
    assert.ok(!args.some((x) => x.endsWith('-try')));
    assert.ok(pair(args, '--cap-drop', 'ALL'));
  });

  it('read-only mode makes no host path writable', () => {
    const p = plan();
    assert.deepEqual(p.writable, []);
    assert.ok(!p.args.includes('--bind'));
    assert.ok(!pair(p.args, '--ro-bind', '/'));
    assert.ok(pair(p.args, '--ro-bind', '/usr'));
    assert.ok(pair(p.args, '--remount-ro', '/'));
    assert.ok(pair(p.args, '--seccomp', '3'));
  });

  it('runtime sockets and host tmp directories are masked', () => {
    for (const dir of ['/tmp', '/var/tmp', '/run']) assert.ok(pair(plan().args, '--tmpfs', dir));
  });

  it('clears inherited environment, proxies and executable preload variables', () => {
    const p = plan({ sourceEnv: { ...env, HTTPS_PROXY: 'secret', NODE_OPTIONS: '--bad', LD_PRELOAD: '/bad', WSL_INTEROP: '/run/WSL/1_interop', CARGO_TARGET_DIR: '/outside' } });
    assert.ok(p.args.includes('--clearenv'));
    for (const key of ['HTTPS_PROXY', 'NODE_OPTIONS', 'LD_PRELOAD', 'WSL_INTEROP', 'CARGO_TARGET_DIR']) assert.ok(!(key in p.env));
    assert.equal(p.env.RUSTUP_AUTO_INSTALL, '0');
    assert.equal(p.env.CARGO_NET_OFFLINE, 'true');
  });

  it('preserves explicitly selected Rust toolchain', () => {
    assert.equal(plan({ sourceEnv: { ...env, RUSTUP_TOOLCHAIN: '1.98.1' } }).env.RUSTUP_TOOLCHAIN, '1.98.1');
  });

  it('extract mode requires disposable-checkout acknowledgement', () => {
    assert.throws(() => extract({ disposableProject: false }), /disposableProject/);
  });

  it('extract mode permits exactly checkout, output and private tmp', () => {
    const p = extract();
    assert.deepEqual(p.writable, [project, output, tmp]);
    assert.equal(p.args.filter((x) => x === '--bind').length, 3);
  });

  it('spaces and shell metacharacters remain argument data, not a shell command', () => {
    const literal = '$(touch nope); # space';
    const p = extract({ commandArgs: [literal] });
    assert.equal(p.args[p.args.length - 1], literal);
    assert.ok(p.args.includes(project));
  });

  it('relative executable paths are rejected', () => {
    assert.throws(() => plan({ command: 'node' }), /absolute/);
  });

  it('nonexecutable files are rejected', () => {
    const file = path.join(root, 'nonexec');
    fs.writeFileSync(file, 'data');
    assert.throws(() => plan({ command: file }), /EACCES/);
  });

  it('rustup-style executable proxy spelling is preserved', () => {
    const proxy = path.join(root, 'rust-analyzer');
    fs.symlinkSync(process.execPath, proxy);
    const p = plan({ command: proxy });
    assert.equal(p.command, proxy);
    assert.ok(p.args.includes(proxy));
  });

  it('relative and empty PATH entries are rejected', () => {
    for (const value of ['relative:/usr/bin', '/usr/bin:', ':/usr/bin']) {
      assert.throws(() => plan({ sourceEnv: { ...env, PATH: value } }), /PATH|absolute/);
    }
  });

  it('relative custom tool homes are rejected', () => {
    assert.throws(() => plan({ sourceEnv: { ...env, CARGO_HOME: 'relative' } }), /absolute/);
  });

  it('missing custom tool home inside writable checkout is rejected', () => {
    assert.throws(() => extract({ sourceEnv: { ...env, CARGO_HOME: path.join(project, 'future-tools') } }), /overlaps protected/);
  });

  it('writable tool-home ancestor is rejected', () => {
    assert.throws(() => extract({ projectRoot: home, cwd: home }), /overlaps protected/);
  });

  it('writable tool-home descendant is rejected', () => {
    const child = path.join(home, '.cargo', 'child');
    fs.mkdirSync(child);
    assert.throws(() => extract({ projectRoot: child, cwd: child }), /overlaps protected/);
  });

  it('PATH directory inside the checkout cannot be reopened writable', () => {
    const bin = path.join(project, 'bin');
    fs.mkdirSync(bin);
    assert.throws(() => extract({ sourceEnv: { ...env, PATH: `${env.PATH}:${bin}` } }), /overlaps protected/);
  });

  it('symlink alias of a protected directory is rejected', () => {
    const alias = path.join(root, 'alias');
    fs.symlinkSync(path.join(home, '.cargo'), alias);
    assert.throws(() => extract({ outputDir: alias }), /overlaps protected/);
  });

  it('missing tail is resolved through a symlinked ancestor', () => {
    const alias = path.join(root, 'alias');
    fs.symlinkSync(home, alias);
    assert.equal(realish(path.join(alias, 'new', 'child')), path.join(home, 'new', 'child'));
  });

  it('dangling symlink is rejected, not interpreted as a missing directory', () => {
    const alias = path.join(root, 'broken');
    fs.symlinkSync(path.join(root, 'absent'), alias);
    assert.throws(() => realish(alias), /ENOENT/);
  });

  it('writable roots must be disjoint', () => {
    const child = path.join(project, 'out');
    fs.mkdirSync(child);
    assert.throws(() => extract({ outputDir: child }), /disjoint/);
  });

  it('extra protected directories are honored', () => {
    assert.throws(() => extract({ additionalProtected: [output] }), /overlaps protected/);
  });

  it('tool selection preserves upstream precedence without executing helpers', () => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const marker = path.join(root, 'executed');
    const write = (file) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      return file;
    };
    const onPath = write(path.join(bin, 'probe-rust'));
    write(path.join(home, '.cargo', 'bin', 'probe-rust'));
    write(path.join(bin, 'scip'));
    const cached = write(path.join(home, '.probe-rust', 'tools', 'scip'));
    const rustup = write(path.join(bin, 'rustup'));
    const lean = write(path.join(home, '.local', 'bin', 'probe-lean-v4.31.0'));
    fs.writeFileSync(path.join(project, 'lean-toolchain'), 'leanprover/lean4:v4.31.0\n');
    const library = path.join(home, '.local', 'lib', 'probe-lean-v4.31.0');
    fs.mkdirSync(library, { recursive: true });
    const selected = selectProbeToolPaths({ sourceEnv: { ...env, PATH: `${bin}:${env.PATH}` }, projectRoot: project });
    assert.equal(selected.helpers['probe-rust'], onPath);
    assert.equal(selected.helpers.scip, cached);
    assert.equal(selected.helpers['probe-lean'], lean);
    assert.equal(selected.rustupPath, rustup);
    assert.deepEqual(selected.libraries, [library]);
    assert.equal(fs.existsSync(marker), false);
  });

  it('selected files are protected without exposing their external parent directory', () => {
    const external = path.join(root, 'outside');
    fs.mkdirSync(external);
    const helper = path.join(external, 'helper');
    fs.writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const alias = path.join(root, 'helper');
    fs.symlinkSync(helper, alias);
    const toolPaths = { executables: [alias], libraries: [] };
    for (const p of [plan({ command: alias, toolPaths }), extract({ toolPaths })]) {
      assert.ok(p.protect.includes(helper));
      assert.ok(p.readMounts.some((mount) => mount.source === helper && mount.destination === helper));
      assert.ok(!p.readMounts.some((mount) => mount.source === external));
    }
    assert.throws(() => extract({ projectRoot: external, cwd: external, toolPaths }), /overlaps protected/);
  });

  it('project toolchain text cannot select arbitrary library directories', () => {
    fs.writeFileSync(path.join(project, 'lean-toolchain'), 'leanprover/lean4:v4.31.0/../../../../other');
    assert.throws(() => selectProbeToolPaths({ sourceEnv: env, projectRoot: project }), /unsupported Lean toolchain name/);
  });

  it('tool-home aliases cannot expose all of HOME', () => {
    fs.symlinkSync(home, path.join(home, '.local'));
    assert.throws(() => plan(), /must not expose HOME/);
  });

  it('source project cannot hold the probe executable', () => {
    const helper = path.join(project, 'probe');
    fs.writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.throws(() => extract({ command: helper }), /overlaps protected/);
  });

  it('root/runtime directories cannot be cwd or writable roots', () => {
    assert.throws(() => plan({ cwd: '/' }), /root/);
    assert.throws(() => plan({ cwd: '/tmp' }), /root/);
    assert.throws(() => extract({ projectRoot: '/', cwd: project }), /unsafe writable/);
  });

  it('read-only mode rejects writable-directory parameters', () => {
    assert.throws(() => plan({ outputDir: output }), /read-only/);
  });

  it('extraction cwd must be in a disposable directory', () => {
    assert.throws(() => extract({ cwd: home }), /cwd/);
  });

  it('custom tool homes under masked tmp are rejected', () => {
    assert.throws(() => plan({ sourceEnv: { ...env, CARGO_HOME: '/tmp/fvs-tools' } }), /hidden/);
  });

  it('NUL command arguments are rejected', () => {
    assert.throws(() => plan({ commandArgs: ['x\0y'] }), /NUL/);
  });

  it('runtime pseudo-filesystems cannot be tool homes', () => {
    for (const value of ['/dev/fvs', '/proc/fvs', '/sys/fvs']) {
      assert.throws(() => plan({ sourceEnv: { ...env, CARGO_HOME: value } }), /hidden/);
    }
  });

  it('Windows-mounted PATH directories are rejected', () => {
    assert.throws(() => plan({ sourceEnv: { ...env, PATH: '/usr/bin:/mnt/c/Windows/System32' } }), /Windows/);
  });

  it('Windows-named executable is rejected even through an ELF symlink', () => {
    const exe = path.join(root, 'node.exe');
    fs.symlinkSync(process.execPath, exe);
    assert.throws(() => plan({ command: exe }), /Windows/);
  });

  it('concatenated valid XZ streams decode without filesystem extraction', () => {
    const a = spawnSync(XZ, ['--compress', '--stdout'], { input: Buffer.from('a') }).stdout;
    const b = spawnSync(XZ, ['--compress', '--stdout'], { input: Buffer.from('b') }).stdout;
    const bytes = Buffer.concat([a, b]);
    assert.equal(decodeLinuxTarXz(bytes, sha(bytes)).toString(), 'ab');
  });

  it('XZ decoding returns a byte stream without unpacking filesystem entries', () => {
    const raw = Buffer.from('not yet validated tar bytes\n');
    const compressed = spawnSync(XZ, ['--compress', '--stdout'], { input: raw });
    assert.equal(compressed.status, 0);
    assert.deepEqual(decodeLinuxTarXz(compressed.stdout, sha(compressed.stdout)), raw);
  });

  it('wrong archive digest fails before decompression', () => {
    assert.throws(() => decodeLinuxTarXz(Buffer.from('not xz'), '0'.repeat(64)), /SHA-256 does not match/);
  });

  it('a syntactically valid pinned hash is required', () => {
    assert.throws(() => decodeLinuxTarXz(Buffer.alloc(0), ''), /pinned SHA-256/);
  });

  it('matching digest is insufficient for a corrupt XZ archive', () => {
    const bytes = Buffer.from('not xz');
    assert.throws(() => decodeLinuxTarXz(bytes, sha(bytes)), /cannot decompress/);
  });

  it('compressed archive size limit is enforced', () => {
    assert.throws(() => decodeLinuxTarXz(Buffer.alloc(32 * 1024 * 1024 + 1), '0'.repeat(64)), /size limit/);
  });

  it('spawn wrapper rejects a direct executable plan', () => {
    assert.throws(() => runLinuxSandbox({ file: process.execPath, args: ['--version'] }), /bubblewrap plan/);
  });

  it('missing bubblewrap fails closed without executing the requested command', {
    skip: fs.existsSync(BWRAP) ? 'bubblewrap exists; missing-binary case not applicable' : false,
  }, () => {
    const marker = path.join(project, 'should-not-exist');
    const p = plan({ commandArgs: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'escaped')`] });
    const result = runLinuxSandbox(p);
    assert.equal(result.ok, false);
    assert.match(result.error, /ENOENT/);
    assert.ok(!fs.existsSync(marker));
  });

  it('live confinement denies protected writes, permits output writes and isolates the network namespace', {
    skip: !fs.existsSync(BWRAP) ? 'bubblewrap unavailable: real confinement not tested' : false,
  }, () => {
    const ns = fs.readlinkSync('/proc/self/ns/net');
    const blocked = path.join(home, '.cargo', 'must-not-write');
    const writable = path.join(output, 'can-write');
    const code = `
      const fs = require('node:fs');
      if (fs.readlinkSync('/proc/self/ns/net') === ${JSON.stringify(ns)}) throw Error('network namespace not isolated');
      let denied = false;
      try {
        fs.writeFileSync(${JSON.stringify(blocked)}, 'bad');
      } catch (error) {
        denied = ['EROFS', 'EACCES', 'EPERM'].includes(error.code);
      }
      if (!denied) throw Error('protected write was not denied');
      fs.writeFileSync(${JSON.stringify(writable)}, 'ok');
      process.stdout.write('basic isolation passed; this is not extraction evidence\\n');
    `;
    const result = runLinuxSandbox(extract({ commandArgs: ['-e', code] }));
    assert.equal(result.ok, true, result.stderr || result.error);
    assert.equal(fs.readFileSync(writable, 'utf8'), 'ok');
    assert.ok(!fs.existsSync(blocked));
  });
});
