// Capture one documented node invocation; never execute its FVS script.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
// These are the only documented calls this helper may hand to Bash.
const DOCUMENTED_COMMANDS = new Set([
  'node "$HOME/.claude/scripts/fvs-auto.mjs" profile --project-root . --format text',
  'node "$HOME/.claude/scripts/fvs-probe-inventory.mjs" resolve --project-root . --format text',
  'node "$HOME/.claude/scripts/fvs-extract-patches.mjs" migrate --project-root "$CRATE_ROOT"',
  'node "$HOME/.claude/scripts/fvs-extract-patches.mjs" check --project-root "$CRATE_ROOT"',
]);
function validateDocumentedNodeCommand(command) {
  assert.ok(DOCUMENTED_COMMANDS.has(command), 'unsupported documented node invocation');
}
function commandContext(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-doc-argv-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home with spaces $& $'"), crate = path.join(root, 'crate with spaces');
  fs.mkdirSync(home); fs.mkdirSync(crate);
  return { home, crate };
}
function nodeArguments(command, { home, crate }) {
  validateDocumentedNodeCommand(command);
  const body = 'node() { printf \'%s\\0\' "$@"; }\n' + command + '\n';
  const result = spawnSync('/bin/bash', ['-c', body], { cwd: crate, encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: home, CRATE_ROOT: crate, LANG: 'C' } });
  assert.equal(result.status, 0, result.stderr);
  const args = result.stdout.split('\0'); assert.equal(args.pop(), '', 'NUL-terminated argv');
  return args;
}
module.exports = { commandContext, nodeArguments, validateDocumentedNodeCommand };
