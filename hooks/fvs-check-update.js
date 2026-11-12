#!/usr/bin/env node
// Check for FVS updates in background, write result to cache
// Called by SessionStart hook - runs once per session

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const homeDir = os.homedir();
const cwd = process.cwd();

// Detect runtime config directory (supports Claude, OpenCode, Antigravity)
// Respects CLAUDE_CONFIG_DIR for custom config directory setups
// Mirrors GSD's detectConfigDir pattern for consistency
function detectConfigDir(baseDir) {
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir && fs.existsSync(path.join(envDir, 'fv-skills', 'VERSION'))) {
    return envDir;
  }
  for (const dir of ['.config/opencode', '.opencode', '.gemini/config/plugins/fvs', '.agents/plugins/fvs', '.claude']) {
    if (fs.existsSync(path.join(baseDir, dir, 'fv-skills', 'VERSION'))) {
      return path.join(baseDir, dir);
    }
  }
  return envDir || path.join(baseDir, '.claude');
}

const globalConfigDir = detectConfigDir(homeDir);
const projectConfigDir = detectConfigDir(cwd);
const cacheDir = path.join(globalConfigDir, 'cache');
const cacheFile = path.join(cacheDir, 'fvs-update-check.json');

// VERSION file locations (check project first, then global)
const projectVersionFile = path.join(projectConfigDir, 'fv-skills', 'VERSION');
const globalVersionFile = path.join(globalConfigDir, 'fv-skills', 'VERSION');

// fv-skills directory locations (for _sync-meta.json lookup)
const projectFvSkillsDir = path.join(projectConfigDir, 'fv-skills');
const globalFvSkillsDir = path.join(globalConfigDir, 'fv-skills');

// Ensure cache directory exists
if (!fs.existsSync(cacheDir)) {
  fs.mkdirSync(cacheDir, { recursive: true });
}

// SemVer 2.0.0 precedence of a against b: 1, 0 or -1, or null when either is not a valid version (so it
// never raises an update). A prerelease (3.0.0-rc1) sorts below its release (3.0.0) and above every lower
// version (2.3.12). Numbers compare exactly. bin/install.js and the update command keep the same comparison.
function semverCompare(a, b) {
  const id = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
  const re = new RegExp("^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(" + id + "(?:\\." + id + ")*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$");
  const parse = (v) => { const m = re.exec(String(v).trim()); return m && [BigInt(m[1]), BigInt(m[2]), BigInt(m[3]), m[4] ? m[4].split(".") : []]; };
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  const cmp = (s, t) => (s > t) - (s < t);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return cmp(x[i], y[i]);
  const p = x[3], q = y[3];
  if (!p.length || !q.length) return cmp(!p.length, !q.length);
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined || q[i] === undefined) return p[i] === undefined ? -1 : 1;
    if (p[i] === q[i]) continue;
    const pn = /^\d+$/.test(p[i]), qn = /^\d+$/.test(q[i]);
    return pn && qn ? cmp(BigInt(p[i]), BigInt(q[i])) : pn !== qn ? (pn ? -1 : 1) : cmp(p[i], q[i]);
  }
  return 0;
}

// Run check in background (spawn background process, windowsHide prevents console flash)
const child = spawn(process.execPath, ['-e', `
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');
  ${semverCompare.toString()}

  const cacheFile = ${JSON.stringify(cacheFile)};
  const projectVersionFile = ${JSON.stringify(projectVersionFile)};
  const globalVersionFile = ${JSON.stringify(globalVersionFile)};
  const projectFvSkillsDir = ${JSON.stringify(projectFvSkillsDir)};
  const globalFvSkillsDir = ${JSON.stringify(globalFvSkillsDir)};

  // Check project directory first (local install), then global
  let installed = null;
  try {
    if (fs.existsSync(projectVersionFile)) {
      installed = fs.readFileSync(projectVersionFile, 'utf8').trim();
    } else if (fs.existsSync(globalVersionFile)) {
      installed = fs.readFileSync(globalVersionFile, 'utf8').trim();
    }
  } catch (e) {}

  let latest = null;
  try {
    latest = execSync('npm view fv-skills-baif version', { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
  } catch (e) {}

  // --- Aeneas upstream staleness check ---
  let aeneas_stale = false;
  let aeneas_snapshot_commit = null;
  let aeneas_latest_commit = null;

  try {
    // Find _sync-meta.json (project-local first, then global)
    const projectSyncMeta = path.join(projectFvSkillsDir, 'upstream', 'aeneas', '_sync-meta.json');
    const globalSyncMeta = path.join(globalFvSkillsDir, 'upstream', 'aeneas', '_sync-meta.json');
    const syncMetaPath = fs.existsSync(projectSyncMeta) ? projectSyncMeta
                       : fs.existsSync(globalSyncMeta) ? globalSyncMeta
                       : null;

    if (syncMetaPath) {
      const meta = JSON.parse(fs.readFileSync(syncMetaPath, 'utf8'));
      aeneas_snapshot_commit = meta.snapshot_commit || null;

      if (aeneas_snapshot_commit) {
        // Fetch latest commit SHA from GitHub (gh CLI first, curl fallback)
        try {
          aeneas_latest_commit = execSync(
            'gh api repos/AeneasVerif/aeneas/commits/main --jq ".sha"',
            { encoding: 'utf8', timeout: 10000, windowsHide: true }
          ).trim();
        } catch (e) {
          try {
            const raw = execSync(
              'curl -sL "https://api.github.com/repos/AeneasVerif/aeneas/commits/main"',
              { encoding: 'utf8', timeout: 10000, windowsHide: true }
            );
            aeneas_latest_commit = JSON.parse(raw).sha || null;
          } catch (e2) { /* silent fail */ }
        }
        aeneas_stale = !!(aeneas_latest_commit && aeneas_snapshot_commit !== aeneas_latest_commit);
      }
    }
  } catch (e) { /* silent fail */ }

  const result = {
    update_available: !!latest && installed !== null && semverCompare(latest, installed) === 1,
    installed: installed || 'unknown',
    latest: latest || 'unknown',
    checked: Math.floor(Date.now() / 1000),
    aeneas_stale,
    aeneas_snapshot_commit,
    aeneas_latest_commit
  };

  fs.writeFileSync(cacheFile, JSON.stringify(result));
`], {
  stdio: 'ignore',
  windowsHide: true,
  detached: true  // Required on Windows for proper process detachment
});

child.unref();
