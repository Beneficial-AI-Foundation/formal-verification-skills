// The installer copies hooks only from hooks/dist, which is git-ignored build output (scripts/build-hooks.js), so a
// fresh checkout has none and an install silently skips the hooks. Tests that run the installer call this first.
// The directory is staged and renamed into place so that test files starting in parallel never read a half-copied hook.
const fs = require('node:fs'), path = require('node:path');

const HOOKS = path.resolve(__dirname, '..', '..', 'hooks');

module.exports = function ensureHooksDist() {
  const dist = path.join(HOOKS, 'dist');
  if (fs.existsSync(dist)) return;
  const stage = fs.mkdtempSync(path.join(HOOKS, 'dist-stage-'));
  try {
    for (const name of fs.readdirSync(HOOKS).filter((entry) => entry.endsWith('.js'))) {
      fs.copyFileSync(path.join(HOOKS, name), path.join(stage, name));
    }
    fs.renameSync(stage, dist);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    if (!fs.existsSync(dist)) throw error; // another test file won the rename
  }
};
