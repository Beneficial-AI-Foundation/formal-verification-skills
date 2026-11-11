// Capture one documented node invocation; never execute its FVS script.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
function commandContext(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-doc-argv-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home with spaces $& $'"), crate = path.join(root, 'crate with spaces');
  fs.mkdirSync(home); fs.mkdirSync(crate);
  return { home, crate };
}
function nodeArguments(command, { home, crate }) {
  assert.match(command, /^node [^\n]+$/, 'one documented node command required');
  const body = 'node() { printf \'%s\\0\' "$@"; }\n' + command + '\n';
  const result = spawnSync('/bin/bash', ['-c', body], { cwd: crate, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: home, CRATE_ROOT: crate, LANG: 'C' } });
  assert.equal(result.status, 0, result.stderr);
  const args = result.stdout.split('\0'); assert.equal(args.pop(), '', 'NUL-terminated argv');
  return args;
}
module.exports = { commandContext, nodeArguments };
