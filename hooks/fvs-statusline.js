#!/usr/bin/env node
// Claude Code Statusline - FVS Edition
// Shows: model | current task | directory | context usage
// Delegates to GSD statusline when installed, appending FV-specific info.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Module-level constants (computed once per invocation)
const homeDir = os.homedir();
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');

// Read JSON from stdin
let input = '';
// Timeout guard: if stdin doesn't close within 3s, exit silently.
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);

    // Detect GSD statusline installation
    const gsdPath = findGsdStatusline();

    if (gsdPath) {
      // --- GSD DELEGATION MODE ---
      // Pipe stdin data to GSD's statusline, capture output, append FVS info
      delegateToGsd(gsdPath, data);
    } else {
      // --- STANDALONE MODE ---
      // Use corrected context meter (matching GSD's formula)
      renderStandalone(data);
    }
  } catch (e) {
    // Silent fail - don't break statusline on parse errors
  }
});

/**
 * Find GSD's statusline hook. Checks multiple locations.
 * Returns the path if found, null otherwise.
 */
function findGsdStatusline() {
  const candidates = [
    // Global install (most common)
    path.join(claudeDir, 'hooks', 'gsd-statusline.js'),
    // Local project install
    path.join(process.cwd(), '.claude', 'hooks', 'gsd-statusline.js'),
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch (e) {}
  }
  return null;
}

/**
 * Detect active FVS verification state.
 * Returns a short description or empty string.
 */
function detectFvsState() {
  const cwd = process.cwd();
  const continueHere = path.join(cwd, '.formalising', 'fv-plans', '.continue-here.md');
  const codemap = path.join(cwd, '.formalising', 'CODEMAP.md');

  // Try .continue-here.md first (more specific)
  try {
    const content = fs.readFileSync(continueHere, 'utf8');
    const targetMatch = content.match(/(?:target|function|verifying)[:\s]+(\S+)/i);
    if (targetMatch) return `verifying ${targetMatch[1]}`;
    return 'formalising';
  } catch (e) {}

  // Fall back to CODEMAP existence
  try {
    fs.accessSync(codemap);
    return 'formalising';
  } catch (e) {}

  return '';
}

/**
 * Delegate to GSD's statusline, append FVS context if active.
 */
function delegateToGsd(gsdPath, data) {
  try {
    const gsdOutput = execSync(`node "${gsdPath}"`, {
      input: JSON.stringify(data),
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trimEnd();

    // Append FVS verification context if active
    const fvsState = detectFvsState();
    if (fvsState) {
      process.stdout.write(`${gsdOutput} \x1b[36m| FVS: ${fvsState}\x1b[0m`);
    } else {
      process.stdout.write(gsdOutput);
    }
  } catch (e) {
    // If GSD delegation fails, fall back to standalone mode
    renderStandalone(data);
  }
}

/**
 * Standalone statusline with corrected context meter.
 * Uses GSD's 16.5% autocompact buffer normalization.
 */
function renderStandalone(data) {
  const model = data.model?.display_name || 'Claude';
  const dir = data.workspace?.current_dir || process.cwd();
  const session = data.session_id || '';
  const remaining = data.context_window?.remaining_percentage;

  // Context window display (shows USED percentage scaled to usable context)
  // Claude Code reserves ~16.5% for autocompact buffer, so usable context
  // is 83.5% of the total window. We normalize to show 100% at that point.
  const AUTO_COMPACT_BUFFER_PCT = 16.5;
  let ctx = '';
  if (remaining != null) {
    // Normalize: subtract buffer from remaining, scale to usable range
    const usableRemaining = Math.max(0, ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100);
    const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));

    // Write context metrics to bridge file for the context-monitor PostToolUse hook.
    // The monitor reads this file to inject agent-facing warnings when context is low.
    if (session) {
      try {
        const bridgePath = path.join(os.tmpdir(), `claude-ctx-${session}.json`);
        const bridgeData = JSON.stringify({
          session_id: session,
          remaining_percentage: remaining,
          used_pct: used,
          timestamp: Math.floor(Date.now() / 1000)
        });
        fs.writeFileSync(bridgePath, bridgeData);
      } catch (e) {
        // Silent fail -- bridge is best-effort, don't break statusline
      }
    }

    // Build progress bar (10 segments)
    const filled = Math.floor(used / 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

    // Color based on usable context thresholds
    if (used < 50) {
      ctx = ` \x1b[32m${bar} ${used}%\x1b[0m`;
    } else if (used < 65) {
      ctx = ` \x1b[33m${bar} ${used}%\x1b[0m`;
    } else if (used < 80) {
      ctx = ` \x1b[38;5;208m${bar} ${used}%\x1b[0m`;
    } else {
      ctx = ` \x1b[5;31m💀 ${bar} ${used}%\x1b[0m`;
    }
  }

  // Current task from todos
  let task = '';
  const todosDir = path.join(claudeDir, 'todos');
  if (session) {
    try {
      const files = fs.readdirSync(todosDir)
        .filter(f => f.startsWith(session) && f.includes('-agent-') && f.endsWith('.json'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(todosDir, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length > 0) {
        const todos = JSON.parse(fs.readFileSync(path.join(todosDir, files[0].name), 'utf8'));
        const inProgress = todos.find(t => t.status === 'in_progress');
        if (inProgress) task = inProgress.activeForm || '';
      }
    } catch (e) {}
  }

  // FVS update available? Aeneas docs outdated?
  let fvsUpdate = '';
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(claudeDir, 'cache', 'fvs-update-check.json'), 'utf8'));
    if (cache.update_available) {
      fvsUpdate = '\x1b[33m\u2b06 /fvs:update\x1b[0m \u2502 ';
    }
    if (cache.aeneas_stale) {
      fvsUpdate += '\x1b[33mAeneas docs outdated \u2192 /fvs:sync-aeneas\x1b[0m \u2502 ';
    }
  } catch (e) {}

  // FVS verification state
  const fvsState = detectFvsState();
  const fvsTag = fvsState ? ` \x1b[36m| FVS: ${fvsState}\x1b[0m` : '';

  // Output
  const dirname = path.basename(dir);
  if (task) {
    process.stdout.write(`${fvsUpdate}\x1b[2m${model}\x1b[0m \u2502 \x1b[1m${task}\x1b[0m \u2502 \x1b[2m${dirname}\x1b[0m${ctx}${fvsTag}`);
  } else {
    process.stdout.write(`${fvsUpdate}\x1b[2m${model}\x1b[0m \u2502 \x1b[2m${dirname}\x1b[0m${ctx}${fvsTag}`);
  }
}
