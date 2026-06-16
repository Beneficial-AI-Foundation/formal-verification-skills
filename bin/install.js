#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');

// Colors
const orange = '\x1b[38;5;208m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

// Codex config.toml constants
const FVS_CODEX_MARKER = '# FVS Agent Configuration \u2014 managed by fv-skills-baif installer';

// Codex hooks feature flag. Current Codex CLI reads a boolean `hooks` flag in
// config.toml to enable its hook dispatcher; an older naming used `codex_hooks`.
// Emit the canonical key and treat the legacy alias as equivalent so a reinstall
// over an older config migrates the flag forward instead of leaving a duplicate.
const CODEX_HOOKS_FEATURE_KEY = 'hooks';
const CODEX_HOOKS_FEATURE_LEGACY_KEYS = ['codex_hooks'];
const CODEX_HOOKS_FEATURE_ALL_KEYS = [CODEX_HOOKS_FEATURE_KEY, ...CODEX_HOOKS_FEATURE_LEGACY_KEYS];

// The only FVS hook script with a Codex event target is the update checker,
// wired as a SessionStart hook. The statusline has no Codex renderer surface and
// stays Claude-only. Both the .js and its Windows .cmd shim are treated as
// FVS-managed so a reinstall can replace a stale node-runner command with the
// shim (and vice-versa across platforms) without clobbering foreign entries.
const FVS_CODEX_MANAGED_HOOK_BASENAMES = new Set([
  'fvs-check-update.js',
  'fvs-check-update.cmd',
]);

const CODEX_AGENT_SANDBOX = {
  'fvs-executor': 'workspace-write',
  'fvs-lean-refactorer': 'workspace-write',
  'fvs-explainer': 'read-only',
  'fvs-researcher': 'read-only',
};

// Codex agents inherit the user's selected Codex model — the converter never
// pins a `model`, it sets only the reasoning-effort budget. The user owns the
// model choice and may change it mid-session; FVS controls only how hard each
// agent thinks. Precision-critical roles (spec authoring, proof attempt and
// refactor, explanation) run at the highest effort; the research/mapping
// support role runs one tier lower. Codex accepts minimal|low|medium|high|xhigh;
// any unmapped agent defaults to high at the lookup site.
const FVS_CODEX_AGENT_EFFORT = {
  'fvs-executor': 'xhigh',
  'fvs-lean-refactorer': 'xhigh',
  'fvs-explainer': 'xhigh',
  'fvs-researcher': 'high',
};

// Get version from package.json
const pkg = require('../package.json');

// Parse args
const args = process.argv.slice(2);
const hasGlobal = args.includes('--global') || args.includes('-g');
const hasLocal = args.includes('--local') || args.includes('-l');
const hasOpencode = args.includes('--opencode');
const hasClaude = args.includes('--claude');
const hasGemini = args.includes('--gemini');
const hasCodex = args.includes('--codex');
const hasAll = args.includes('--all');
const hasUninstall = args.includes('--uninstall') || args.includes('-u');

// Runtime selection - can be set by flags or interactive prompt
let selectedRuntimes = [];
if (hasAll) {
  selectedRuntimes = ['claude', 'opencode', 'gemini', 'codex'];
} else {
  if (hasOpencode) selectedRuntimes.push('opencode');
  if (hasClaude) selectedRuntimes.push('claude');
  if (hasGemini) selectedRuntimes.push('gemini');
  if (hasCodex) selectedRuntimes.push('codex');
}

// Helper to get directory name for a runtime (used for local/project installs)
function getDirName(runtime) {
  if (runtime === 'opencode') return '.opencode';
  if (runtime === 'gemini') return '.gemini';
  if (runtime === 'codex') return '.codex';
  return '.claude';
}

/**
 * Convert a pathPrefix (which uses absolute paths for global installs) to a
 * $HOME-relative form for replacing $HOME/.claude/ references in bash code blocks.
 * Preserves $HOME as a shell variable so paths remain portable across machines.
 */
function toHomePrefix(pathPrefix) {
  const home = os.homedir().replace(/\\/g, '/');
  const normalized = pathPrefix.replace(/\\/g, '/');
  if (normalized.startsWith(home)) {
    return '$HOME' + normalized.slice(home.length);
  }
  // For relative paths or paths not under $HOME, return as-is
  return normalized;
}

/**
 * Get the config directory path relative to home directory for a runtime
 * Used for templating hooks that use path.join(homeDir, '<configDir>', ...)
 * @param {string} runtime - 'claude', 'opencode', 'gemini', or 'codex'
 * @param {boolean} isGlobal - Whether this is a global install
 */
function getConfigDirFromHome(runtime, isGlobal) {
  if (!isGlobal) {
    // Local installs use the same dir name pattern
    return `'${getDirName(runtime)}'`;
  }
  // Global installs - OpenCode uses XDG path structure
  if (runtime === 'opencode') {
    // OpenCode: ~/.config/opencode -> '.config', 'opencode'
    // Return as comma-separated for path.join() replacement
    return "'.config', 'opencode'";
  }
  if (runtime === 'gemini') return "'.gemini'";
  if (runtime === 'codex') return "'.codex'";
  return "'.claude'";
}

/**
 * Get the global config directory for OpenCode
 * OpenCode follows XDG Base Directory spec and uses ~/.config/opencode/
 * Priority: OPENCODE_CONFIG_DIR > dirname(OPENCODE_CONFIG) > XDG_CONFIG_HOME/opencode > ~/.config/opencode
 */
function getOpencodeGlobalDir() {
  // 1. Explicit OPENCODE_CONFIG_DIR env var
  if (process.env.OPENCODE_CONFIG_DIR) {
    return expandTilde(process.env.OPENCODE_CONFIG_DIR);
  }

  // 2. OPENCODE_CONFIG env var (use its directory)
  if (process.env.OPENCODE_CONFIG) {
    return path.dirname(expandTilde(process.env.OPENCODE_CONFIG));
  }

  // 3. XDG_CONFIG_HOME/opencode
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(expandTilde(process.env.XDG_CONFIG_HOME), 'opencode');
  }

  // 4. Default: ~/.config/opencode (XDG default)
  return path.join(os.homedir(), '.config', 'opencode');
}

/**
 * Get the global config directory for a runtime
 * @param {string} runtime - 'claude', 'opencode', 'gemini', or 'codex'
 * @param {string|null} explicitDir - Explicit directory from --config-dir flag
 */
function getGlobalDir(runtime, explicitDir = null) {
  if (runtime === 'codex') {
    // Codex: --config-dir > CODEX_HOME > ~/.codex
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    if (process.env.CODEX_HOME) {
      return expandTilde(process.env.CODEX_HOME);
    }
    return path.join(os.homedir(), '.codex');
  }

  if (runtime === 'opencode') {
    // For OpenCode, --config-dir overrides env vars
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    return getOpencodeGlobalDir();
  }

  if (runtime === 'gemini') {
    // Gemini: --config-dir > GEMINI_CONFIG_DIR > ~/.gemini
    if (explicitDir) {
      return expandTilde(explicitDir);
    }
    if (process.env.GEMINI_CONFIG_DIR) {
      return expandTilde(process.env.GEMINI_CONFIG_DIR);
    }
    return path.join(os.homedir(), '.gemini');
  }

  // Claude Code: --config-dir > CLAUDE_CONFIG_DIR > ~/.claude
  if (explicitDir) {
    return expandTilde(explicitDir);
  }
  if (process.env.CLAUDE_CONFIG_DIR) {
    return expandTilde(process.env.CLAUDE_CONFIG_DIR);
  }
  return path.join(os.homedir(), '.claude');
}

const banner = '\n' +
  orange + '  ███████╗██╗   ██╗███████╗\n' +
  '  ██╔════╝██║   ██║██╔════╝\n' +
  '  █████╗  ██║   ██║███████╗\n' +
  '  ██╔══╝  ╚██╗ ██╔╝╚════██║\n' +
  '  ██║      ╚████╔╝ ███████║\n' +
  '  ╚═╝       ╚═══╝  ╚══════╝' + reset + '\n' +
  '\n' +
  '  Formal Verification Skills ' + dim + 'v' + pkg.version + reset + '\n' +
  '  Code your Rust in Peace\n';

// Parse --config-dir argument
function parseConfigDirArg() {
  const configDirIndex = args.findIndex(arg => arg === '--config-dir' || arg === '-c');
  if (configDirIndex !== -1) {
    const nextArg = args[configDirIndex + 1];
    // Error if --config-dir is provided without a value or next arg is another flag
    if (!nextArg || nextArg.startsWith('-')) {
      console.error(`  ${yellow}--config-dir requires a path argument${reset}`);
      process.exit(1);
    }
    return nextArg;
  }
  // Also handle --config-dir=value format
  const configDirArg = args.find(arg => arg.startsWith('--config-dir=') || arg.startsWith('-c='));
  if (configDirArg) {
    const value = configDirArg.split('=')[1];
    if (!value) {
      console.error(`  ${yellow}--config-dir requires a non-empty path${reset}`);
      process.exit(1);
    }
    return value;
  }
  return null;
}
const explicitConfigDir = parseConfigDirArg();
const hasHelp = args.includes('--help') || args.includes('-h');
const forceStatusline = args.includes('--force-statusline');

if (require.main === module) {
  console.log(banner);
}

// Show help if requested
if (require.main === module && hasHelp) {
  console.log(`  ${yellow}Usage:${reset} npx fv-skills-baif [options]\n\n  ${yellow}Options:${reset}\n    ${orange}-g, --global${reset}              Install globally (to config directory)\n    ${orange}-l, --local${reset}               Install locally (to current directory)\n    ${orange}--claude${reset}                  Install for Claude Code only\n    ${orange}--opencode${reset}                Install for OpenCode only\n    ${orange}--gemini${reset}                  Install for Gemini only\n    ${orange}--codex${reset}                   Install for Codex only\n    ${orange}--all${reset}                     Install for all runtimes\n    ${orange}-u, --uninstall${reset}           Uninstall FVS (remove all FVS files)\n    ${orange}-c, --config-dir <path>${reset}   Specify custom config directory\n    ${orange}-h, --help${reset}                Show this help message\n    ${orange}--force-statusline${reset}        Replace existing statusline config\n\n  ${yellow}Examples:${reset}\n    ${dim}# Interactive install (prompts for runtime and location)${reset}\n    npx fv-skills-baif\n\n    ${dim}# Install for Claude Code globally${reset}\n    npx fv-skills-baif --claude --global\n\n    ${dim}# Install for Codex globally${reset}\n    npx fv-skills-baif --codex --global\n\n    ${dim}# Install for Gemini globally${reset}\n    npx fv-skills-baif --gemini --global\n\n    ${dim}# Install for all runtimes globally${reset}\n    npx fv-skills-baif --all --global\n\n    ${dim}# Install to custom config directory${reset}\n    npx fv-skills-baif --claude --global --config-dir ~/.claude-bc\n\n    ${dim}# Install to current project only${reset}\n    npx fv-skills-baif --claude --local\n\n    ${dim}# Uninstall FVS from Claude Code globally${reset}\n    npx fv-skills-baif --claude --global --uninstall\n\n  ${yellow}Notes:${reset}\n    The --config-dir option is useful when you have multiple configurations.\n    It takes priority over CLAUDE_CONFIG_DIR / GEMINI_CONFIG_DIR / CODEX_HOME environment variables.\n`);
  process.exit(0);
}

/**
 * Expand ~ to home directory (shell doesn't expand in env vars passed to node)
 */
function expandTilde(filePath) {
  if (filePath && filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/**
 * Build a hook command path using forward slashes for cross-platform compatibility.
 * On Windows, $HOME is not expanded by cmd.exe/PowerShell, so we use the actual path.
 */
function buildHookCommand(configDir, hookName) {
  // Use forward slashes for Node.js compatibility on all platforms
  const hooksPath = configDir.replace(/\\/g, '/') + '/hooks/' + hookName;
  return `node "${hooksPath}"`;
}

/**
 * Read and parse settings.json, returning empty object if it doesn't exist
 */
function readSettings(settingsPath) {
  if (fs.existsSync(settingsPath)) {
    try {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

/**
 * Write settings.json with proper formatting
 */
function writeSettings(settingsPath, settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * Convert Claude Code frontmatter to opencode format
 * - Converts 'allowed-tools:' array to 'permission:' object
 * @param {string} content - Markdown file content with YAML frontmatter
 * @returns {string} - Content with converted frontmatter
 */
// Color name to hex mapping for opencode compatibility
const colorNameToHex = {
  cyan: '#00FFFF',
  red: '#FF0000',
  green: '#00FF00',
  blue: '#0000FF',
  yellow: '#FFFF00',
  magenta: '#FF00FF',
  orange: '#FFA500',
  purple: '#800080',
  pink: '#FFC0CB',
  white: '#FFFFFF',
  black: '#000000',
  gray: '#808080',
  grey: '#808080',
};

// Tool name mapping from Claude Code to OpenCode
// OpenCode uses lowercase tool names; special mappings for renamed tools
const claudeToOpencodeTools = {
  AskUserQuestion: 'question',
  SlashCommand: 'skill',
  TodoWrite: 'todowrite',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',  // Plugin/MCP - keep for compatibility
};

// Tool name mapping from Claude Code to Gemini CLI
// Gemini CLI uses snake_case built-in tool names
const claudeToGeminiTools = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'replace',
  Bash: 'run_shell_command',
  Glob: 'glob',
  Grep: 'search_file_content',
  WebSearch: 'google_web_search',
  WebFetch: 'web_fetch',
  TodoWrite: 'write_todos',
  AskUserQuestion: 'ask_user',
};

/**
 * Convert a Claude Code tool name to OpenCode format
 * - Applies special mappings (AskUserQuestion -> question, etc.)
 * - Converts to lowercase (except MCP tools which keep their format)
 */
function convertToolName(claudeTool) {
  // Check for special mapping first
  if (claudeToOpencodeTools[claudeTool]) {
    return claudeToOpencodeTools[claudeTool];
  }
  // MCP tools (mcp__*) keep their format
  if (claudeTool.startsWith('mcp__')) {
    return claudeTool;
  }
  // Default: convert to lowercase
  return claudeTool.toLowerCase();
}

/**
 * Convert a Claude Code tool name to Gemini CLI format
 * - Applies Claude->Gemini mapping (Read->read_file, Bash->run_shell_command, etc.)
 * - Filters out MCP tools (mcp__*) -- they are auto-discovered at runtime in Gemini
 * - Filters out Task -- agents are auto-registered as tools in Gemini
 * @returns {string|null} Gemini tool name, or null if tool should be excluded
 */
function convertGeminiToolName(claudeTool) {
  // MCP tools: exclude -- auto-discovered from mcpServers config at runtime
  if (claudeTool.startsWith('mcp__')) {
    return null;
  }
  // Task: exclude -- agents are auto-registered as callable tools
  if (claudeTool === 'Task') {
    return null;
  }
  // Check for explicit mapping
  if (claudeToGeminiTools[claudeTool]) {
    return claudeToGeminiTools[claudeTool];
  }
  // Default: lowercase
  return claudeTool.toLowerCase();
}

/**
 * Strip HTML <sub> tags for Gemini CLI output
 * Terminals don't support subscript -- Gemini renders these as raw HTML.
 * Converts <sub>text</sub> to italic *(text)* for readable terminal output.
 */
function stripSubTags(content) {
  return content.replace(/<sub>(.*?)<\/sub>/g, '*($1)*');
}

/**
 * Convert Claude Code agent frontmatter to Gemini CLI format
 * Gemini agents use .md files with YAML frontmatter, same as Claude,
 * but with different field names and formats:
 * - tools: must be a YAML array (not comma-separated string)
 * - tool names: must use Gemini built-in names (read_file, not Read)
 * - color: must be removed (causes validation error)
 * - mcp__* tools: must be excluded (auto-discovered at runtime)
 */
function convertClaudeToGeminiAgent(content) {
  if (!content.startsWith('---')) return content;

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) return content;

  const frontmatter = content.substring(3, endIndex).trim();
  const body = content.substring(endIndex + 3);

  const lines = frontmatter.split('\n');
  const newLines = [];
  let inAllowedTools = false;
  const tools = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Convert allowed-tools YAML array to tools list
    if (trimmed.startsWith('allowed-tools:')) {
      inAllowedTools = true;
      continue;
    }

    // Handle inline tools: field (comma-separated string)
    if (trimmed.startsWith('tools:')) {
      const toolsValue = trimmed.substring(6).trim();
      if (toolsValue) {
        const parsed = toolsValue.split(',').map(t => t.trim()).filter(t => t);
        for (const t of parsed) {
          const mapped = convertGeminiToolName(t);
          if (mapped) tools.push(mapped);
        }
      } else {
        // tools: with no value means YAML array follows
        inAllowedTools = true;
      }
      continue;
    }

    // Strip color field (not supported by Gemini CLI, causes validation error)
    if (trimmed.startsWith('color:')) continue;

    // Collect allowed-tools/tools array items
    if (inAllowedTools) {
      if (trimmed.startsWith('- ')) {
        const mapped = convertGeminiToolName(trimmed.substring(2).trim());
        if (mapped) tools.push(mapped);
        continue;
      } else if (trimmed && !trimmed.startsWith('-')) {
        inAllowedTools = false;
      }
    }

    if (!inAllowedTools) {
      newLines.push(line);
    }
  }

  // Add tools as YAML array (Gemini requires array format)
  if (tools.length > 0) {
    newLines.push('tools:');
    for (const tool of tools) {
      newLines.push(`  - ${tool}`);
    }
  }

  const newFrontmatter = newLines.join('\n').trim();

  // Escape ${VAR} patterns in agent body for Gemini CLI compatibility.
  // Gemini's templateString() treats all ${word} patterns as template variables
  // and throws "Template validation failed: Missing required input parameters"
  // when they can't be resolved. FVS agents use ${PHASE}, ${PLAN}, etc. as
  // shell variables in bash code blocks — convert to $VAR (no braces) which
  // is equivalent bash and invisible to Gemini's /\$\{(\w+)\}/g regex.
  const escapedBody = body.replace(/\$\{(\w+)\}/g, '$$$1');

  return `---\n${newFrontmatter}\n---${stripSubTags(escapedBody)}`;
}

function convertClaudeToOpencodeFrontmatter(content) {
  // Replace tool name references in content (applies to all files)
  let convertedContent = content;
  convertedContent = convertedContent.replace(/\bAskUserQuestion\b/g, 'question');
  convertedContent = convertedContent.replace(/\bSlashCommand\b/g, 'skill');
  convertedContent = convertedContent.replace(/\bTodoWrite\b/g, 'todowrite');
  // Replace /fvs:command with /fvs-command for opencode (flat command structure)
  convertedContent = convertedContent.replace(/\/fvs:/g, '/fvs-');
  // Replace ~/.claude and $HOME/.claude with OpenCode's config location
  convertedContent = convertedContent.replace(/~\/\.claude\b/g, '~/.config/opencode');
  convertedContent = convertedContent.replace(/\$HOME\/\.claude\b/g, '$HOME/.config/opencode');

  // Check if content has frontmatter
  if (!convertedContent.startsWith('---')) {
    return convertedContent;
  }

  // Find the end of frontmatter
  const endIndex = convertedContent.indexOf('---', 3);
  if (endIndex === -1) {
    return convertedContent;
  }

  const frontmatter = convertedContent.substring(3, endIndex).trim();
  const body = convertedContent.substring(endIndex + 3);

  // Parse frontmatter line by line (simple YAML parsing)
  const lines = frontmatter.split('\n');
  const newLines = [];
  let inAllowedTools = false;
  const allowedTools = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect start of allowed-tools array
    if (trimmed.startsWith('allowed-tools:')) {
      inAllowedTools = true;
      continue;
    }

    // Detect inline tools: field (comma-separated string)
    if (trimmed.startsWith('tools:')) {
      const toolsValue = trimmed.substring(6).trim();
      if (toolsValue) {
        // Parse comma-separated tools
        const tools = toolsValue.split(',').map(t => t.trim()).filter(t => t);
        allowedTools.push(...tools);
      }
      continue;
    }

    // Remove name: field - opencode uses filename for command name
    if (trimmed.startsWith('name:')) {
      continue;
    }

    // Convert color names to hex for opencode
    if (trimmed.startsWith('color:')) {
      const colorValue = trimmed.substring(6).trim().toLowerCase();
      const hexColor = colorNameToHex[colorValue];
      if (hexColor) {
        newLines.push(`color: "${hexColor}"`);
      } else if (colorValue.startsWith('#')) {
        // Validate hex color format (#RGB or #RRGGBB)
        if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i.test(colorValue)) {
          // Already hex and valid, keep as is
          newLines.push(line);
        }
        // Skip invalid hex colors
      }
      // Skip unknown color names
      continue;
    }

    // Collect allowed-tools items
    if (inAllowedTools) {
      if (trimmed.startsWith('- ')) {
        allowedTools.push(trimmed.substring(2).trim());
        continue;
      } else if (trimmed && !trimmed.startsWith('-')) {
        // End of array, new field started
        inAllowedTools = false;
      }
    }

    // Keep other fields
    if (!inAllowedTools) {
      newLines.push(line);
    }
  }

  // Add tools object if we had allowed-tools or tools
  if (allowedTools.length > 0) {
    newLines.push('tools:');
    for (const tool of allowedTools) {
      newLines.push(`  ${convertToolName(tool)}: true`);
    }
  }

  // Rebuild frontmatter (body already has tool names converted)
  const newFrontmatter = newLines.join('\n').trim();
  return `---\n${newFrontmatter}\n---${body}`;
}

/**
 * Convert Claude Code markdown command to Gemini TOML format
 * @param {string} content - Markdown file content with YAML frontmatter
 * @returns {string} - TOML content
 */
function convertClaudeToGeminiToml(content) {
  // Check if content has frontmatter
  if (!content.startsWith('---')) {
    return `prompt = ${JSON.stringify(content)}\n`;
  }

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return `prompt = ${JSON.stringify(content)}\n`;
  }

  const frontmatter = content.substring(3, endIndex).trim();
  const body = content.substring(endIndex + 3).trim();

  // Extract description from frontmatter
  let description = '';
  const lines = frontmatter.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('description:')) {
      description = trimmed.substring(12).trim();
      break;
    }
  }

  // Construct TOML
  let toml = '';
  if (description) {
    toml += `description = ${JSON.stringify(description)}\n`;
  }

  toml += `prompt = ${JSON.stringify(body)}\n`;

  return toml;
}

// ── Codex conversion functions ──────────────────────────────────────────────

/**
 * Extract frontmatter and body from markdown content
 */
function extractFrontmatterAndBody(content) {
  if (!content.startsWith('---')) {
    return { frontmatter: null, body: content };
  }

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return { frontmatter: null, body: content };
  }

  return {
    frontmatter: content.substring(3, endIndex).trim(),
    body: content.substring(endIndex + 3),
  };
}

/**
 * Extract a single field value from frontmatter string
 */
function extractFrontmatterField(frontmatter, fieldName) {
  const regex = new RegExp(`^${fieldName}:\\s*(.+)$`, 'm');
  const match = frontmatter.match(regex);
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

/**
 * Collapse multi-line text to a single line
 */
function toSingleLine(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Quote a value for YAML output
 */
function yamlQuote(value) {
  return JSON.stringify(value);
}

/**
 * Convert /fvs:command references to $fvs-command for Codex skill mentions
 */
function convertSlashCommandsToCodexSkillMentions(content) {
  let converted = content.replace(/\/fvs:([a-z0-9-]+)/gi, (_, commandName) => {
    return `$fvs-${String(commandName).toLowerCase()}`;
  });
  converted = converted.replace(/\/fvs-help\b/g, '$fvs-help');
  return converted;
}

/**
 * Convert Claude Code markdown to Codex-compatible markdown.
 *
 * Rewrites the invocation surface only: slash-command mentions become skill
 * mentions and $ARGUMENTS becomes the {{FVS_ARGS}} token. The body's tool calls
 * (AskUserQuestion, Task(...)) are deliberately left intact — the skill adapter
 * header is the contract that instructs the runtime how to translate them, so a
 * blanket word-replace would corrupt prose that mentions those names and strip
 * the surrounding semantics the adapter relies on.
 */
function convertClaudeToCodexMarkdown(content) {
  let converted = convertSlashCommandsToCodexSkillMentions(content);
  converted = converted.replace(/\$ARGUMENTS\b/g, '{{FVS_ARGS}}');
  return converted;
}

/**
 * Generate the Codex skill adapter header for a command-turned-skill.
 *
 * The header is the translation contract the Codex runtime follows when it runs
 * a converted FVS skill: how the skill is invoked, how Claude's AskUserQuestion
 * maps to request_user_input (including multi-select and a fail-closed execute
 * mode), and how Task() maps to spawn_agent. Execute mode is fail-closed by
 * design: when interactive prompting is unavailable, the runtime surfaces the
 * questions and waits rather than silently picking a default and writing
 * artifacts.
 */
function getCodexSkillAdapterHeader(skillName) {
  const invocation = `$${skillName}`;
  return `<codex_skill_adapter>
## A. Skill Invocation
- This skill is invoked by mentioning \`${invocation}\`.
- Treat all user text after \`${invocation}\` as \`{{FVS_ARGS}}\`.
- If no arguments are present, treat \`{{FVS_ARGS}}\` as empty.

## B. AskUserQuestion -> request_user_input Mapping
FVS workflows use \`AskUserQuestion\` (Claude Code syntax). Translate to Codex \`request_user_input\`:

Parameter mapping:
- \`header\` -> \`header\`
- \`question\` -> \`question\`
- Options formatted as \`"Label" -- description\` -> \`{label: "Label", description: "description"}\`
- Generate \`id\` from header: lowercase, replace spaces with underscores

Batched calls:
- \`AskUserQuestion([q1, q2])\` -> single \`request_user_input\` with multiple entries in \`questions[]\`

Multi-select workaround:
- Codex has no \`multiSelect\`. When a question allows multiple selections, do NOT collapse it to a single choice. Use sequential single-selects, or present a numbered freeform list asking the user to enter comma-separated numbers, then collect every selection before proceeding.

Execute mode fallback:
- When \`request_user_input\` is rejected or unavailable (Execute mode), present every \`AskUserQuestion\` call as a plain-text numbered list, then stop and wait for the user's reply. Do NOT pick a default and continue.
- You may proceed without a user answer only when one of these is true:
  (a) the invocation included an explicit non-interactive flag (\`--auto\` or \`--all\`),
  (b) the user has explicitly approved a specific default for this question, or
  (c) the workflow's documented contract says defaults are safe (e.g. autonomous lifecycle paths).
- Do NOT write workflow artifacts (handoff files, spec files, plan files, checkpoint files) until the user has answered the plain-text questions or one of (a)-(c) above applies. Surfacing the questions and waiting is the correct response — silently defaulting and writing artifacts is the failure mode this header exists to prevent.

## C. Task() -> spawn_agent Mapping
FVS workflows use \`Task(...)\` (Claude Code syntax). Translate to Codex collaboration tools:

**Schema detection (required first step):** Codex exposes two \`spawn_agent\` schemas:
- **agent_type-capable schema:** \`spawn_agent\` accepts \`agent_type\`, \`message\`, \`reasoning_effort\`, \`fork_context\`, etc. — typed FVS agent dispatch is available.
- **Generic schema:** \`spawn_agent\` accepts only \`message\`, \`items\`, \`fork_context\` — there is **no \`agent_type\` field**. Typed FVS agent dispatch is unavailable in this session.

Before spawning, inspect the \`spawn_agent\` tool's visible parameter schema to determine which form is active.

Typed mapping (agent_type-capable schema only):
- \`Task(subagent_type="X", prompt="Y")\` -> \`spawn_agent(agent_type="X", message="Y")\`
- \`Task(model="...")\` -> omit. \`spawn_agent\` has no inline \`model\` parameter; FVS bakes each agent's reasoning effort into its \`.toml\` at install time and the model is inherited from the user's Codex configuration.
- \`fork_context: false\` by default -- FVS agents load their own context via \`<files_to_read>\` blocks.

Generic-agent workaround (schema with NO agent_type field):
When only the generic schema is available, typed FVS agent dispatch (\`fvs-researcher\`, \`fvs-executor\`, etc.) is NOT possible. This workaround is NOT equivalent to typed execution — FVS agents carry verification-aware prompts and sandbox settings a generic subagent lacks. Fallback:
1. Resolve your active Codex config root (the directory containing your \`config.toml\`), then read \`agents/<agent-name>.toml\` relative to that root to extract the agent's instructions.
2. Inject those instructions as a role-preamble into a generic \`spawn_agent(message=...)\` call.
3. Label results clearly as "generic-agent workaround" so the user knows typed guarantees are not in effect.
4. Where typed dispatch is mandatory for correctness, fail closed and report the schema limitation rather than silently degrading.

Parallel fan-out:
- Spawn multiple agents -> collect agent IDs -> \`wait(ids)\` for all to complete

Result parsing:
- Look for structured markers in agent output: \`CHECKPOINT\`, \`PLAN COMPLETE\`, \`SUMMARY\`, etc.
- \`close_agent(id)\` after collecting results from each agent
</codex_skill_adapter>`;
}

/**
 * Convert a Claude Code command to a Codex skill
 * Adds skill adapter header and reformats frontmatter
 */
function convertClaudeCommandToCodexSkill(content, skillName) {
  const converted = convertClaudeToCodexMarkdown(content);
  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  let description = `Run FVS workflow ${skillName}.`;
  if (frontmatter) {
    const maybeDescription = extractFrontmatterField(frontmatter, 'description');
    if (maybeDescription) {
      description = maybeDescription;
    }
  }
  description = toSingleLine(description);
  const shortDescription = description.length > 180 ? `${description.slice(0, 177)}...` : description;
  const adapter = getCodexSkillAdapterHeader(skillName);

  return `---\nname: ${yamlQuote(skillName)}\ndescription: ${yamlQuote(description)}\nmetadata:\n  short-description: ${yamlQuote(shortDescription)}\n---\n\n${adapter}\n\n${body.trimStart()}`;
}

/**
 * Convert Claude Code agent markdown to Codex agent format.
 * Applies base markdown conversions, then adds a <codex_agent_role> header
 * and cleans up frontmatter (removes tools/color fields).
 */
function convertClaudeAgentToCodexAgent(content) {
  let converted = convertClaudeToCodexMarkdown(content);

  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';
  const tools = extractFrontmatterField(frontmatter, 'tools') || '';

  const roleHeader = `<codex_agent_role>
role: ${name}
tools: ${tools}
purpose: ${toSingleLine(description)}
</codex_agent_role>`;

  const cleanFrontmatter = `---\nname: ${yamlQuote(name)}\ndescription: ${yamlQuote(toSingleLine(description))}\n---`;

  return `${cleanFrontmatter}\n\n${roleHeader}\n${body}`;
}

/**
 * Generate a per-agent .toml config file for Codex.
 *
 * Emits the agent name, description, sandbox_mode, and reasoning effort, then
 * the agent body as developer_instructions. The sandbox is fail-closed
 * (read-only for any unmapped name) and the effort defaults to high. No `model`
 * line is emitted: Codex agents inherit the user's selected model, so FVS sets
 * only the reasoning-effort budget.
 */
function generateCodexAgentToml(agentName, agentContent) {
  const { frontmatter, body } = extractFrontmatterAndBody(agentContent);
  const frontmatterText = frontmatter || '';
  const name = extractFrontmatterField(frontmatterText, 'name') || agentName;
  const description = toSingleLine(
    extractFrontmatterField(frontmatterText, 'description') || `FVS agent ${name}`
  );
  const sandboxMode = CODEX_AGENT_SANDBOX[name] || CODEX_AGENT_SANDBOX[agentName] || 'read-only';
  let effort = FVS_CODEX_AGENT_EFFORT[name] || FVS_CODEX_AGENT_EFFORT[agentName] || 'high';
  // Codex accepts minimal|low|medium|high|xhigh; defensively clamp a 'max'
  // value to xhigh should it ever appear (no shipped agent uses 'max').
  if (effort === 'max') effort = 'xhigh';
  const instructions = body.trim();

  const lines = [
    `name = ${JSON.stringify(name)}`,
    `description = ${JSON.stringify(description)}`,
    `sandbox_mode = ${JSON.stringify(sandboxMode)}`,
    `model_reasoning_effort = ${JSON.stringify(effort)}`,
  ];

  if (instructions.includes("'''")) {
    // TOML literal multiline strings have no escape mechanism, so a body that
    // itself contains ''' would terminate the literal early and corrupt the
    // file. Fall back to a basic ("""...""") multiline string with backslash
    // and triple-double-quote escaping. This path loses the raw-backslash
    // benefit, but it keeps the emitted TOML valid and parseable.
    const escaped = instructions
      .replace(/\\/g, '\\\\')
      .replace(/"""/g, '\\"\\"\\"');
    lines.push('developer_instructions = """', escaped, '"""');
  } else {
    // Agent prompts contain raw backslashes in regexes and shell snippets.
    // TOML literal multiline strings preserve them without escape parsing.
    lines.push("developer_instructions = '''", instructions, "'''");
  }
  return lines.join('\n') + '\n';
}

/**
 * Generate the FVS config block for Codex config.toml.
 *
 * Emits a struct-form [agents.<name>] table per agent. Current Codex CLI
 * (>=0.116) requires an absolute config_file path and rejects the relative
 * "agents/<name>.toml" form, so the path is resolved under targetDir when one
 * is supplied. No [features]/multi_agent/[agents] globals are emitted — those
 * keys are rejected by current Codex.
 *
 * @param {Array<{name: string, description: string}>} agents
 * @param {string} [targetDir] absolute Codex config directory (e.g. ~/.codex)
 */
function generateCodexConfigBlock(agents, targetDir) {
  const agentsPrefix = targetDir
    ? path.join(targetDir, 'agents').replace(/\\/g, '/')
    : 'agents';
  const lines = [
    FVS_CODEX_MARKER,
    '',
  ];

  for (const { name, description } of agents) {
    // A bare TOML key only accepts [A-Za-z0-9_-]; a name carrying ']', '"',
    // '.', or whitespace would corrupt the table header or the quoted path.
    // Fail closed rather than emit a config Codex will reject.
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new Error(`Refusing to emit Codex agent table for unsafe name: ${JSON.stringify(name)}`);
    }
    const configFilePath = `${agentsPrefix}/${name}.toml`;
    lines.push(`[agents.${name}]`);
    lines.push(`description = ${JSON.stringify(description)}`);
    lines.push(`config_file = ${JSON.stringify(configFilePath)}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── TOML section parsing ─────────────────────────────────────────────────────
//
// A small, multiline-string-aware TOML scanner used to identify table sections
// so the Codex config strip removes only FVS-owned tables and never absorbs an
// adjacent user-authored or GSD-authored table. Quoted keys and `'''`/`"""`
// multiline string bodies are skipped so a `[bracket]`-looking line inside a
// string is not mistaken for a table header.

function splitTomlLines(content) {
  const lines = [];
  let start = 0;
  while (start < content.length) {
    const newlineIndex = content.indexOf('\n', start);
    if (newlineIndex === -1) {
      lines.push({ start, end: content.length, text: content.slice(start), eol: '' });
      break;
    }
    const hasCr = newlineIndex > start && content[newlineIndex - 1] === '\r';
    const end = hasCr ? newlineIndex - 1 : newlineIndex;
    lines.push({ start, end, text: content.slice(start, end), eol: hasCr ? '\r\n' : '\n' });
    start = newlineIndex + 1;
  }
  return lines;
}

function parseTomlBracketHeader(line, array) {
  let i = 0;
  while (i < line.length && /\s/.test(line[i])) i += 1;

  const open = array ? '[[' : '[';
  const close = array ? ']]' : ']';
  if (!line.startsWith(open, i)) return null;

  i += open.length;
  const start = i;

  while (i < line.length) {
    if (line[i] === '\'' || line[i] === '"') {
      const quote = line[i];
      i += 1;
      while (i < line.length) {
        if (quote === '"' && line[i] === '\\') { i += 2; continue; }
        if (line[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (line.startsWith(close, i)) {
      const rawPath = line.slice(start, i).trim();
      if (!rawPath) return null;
      return { path: rawPath, array };
    }
    if (line[i] === '#' || line[i] === '\r' || line[i] === '\n') return null;
    i += 1;
  }
  return null;
}

function parseTomlTableHeader(line) {
  return parseTomlBracketHeader(line, true) || parseTomlBracketHeader(line, false);
}

// Track whether a line opens or closes a `'''` / `"""` multiline string so that
// a bracketed line inside such a string is never treated as a table header.
function advanceTomlMultilineStringState(line, state) {
  let i = 0;
  while (i < line.length) {
    if (state === 'literal') {
      const close = line.indexOf('\'\'\'', i);
      if (close === -1) return state;
      i = close + 3;
      state = null;
      continue;
    }
    if (state === 'basic') {
      const close = line.indexOf('"""', i);
      if (close === -1) return state;
      i = close + 3;
      state = null;
      continue;
    }
    const ch = line[i];
    if (ch === '#') return state;
    if (ch === '\'') {
      if (line.startsWith('\'\'\'', i)) { state = 'literal'; i += 3; continue; }
      const close = line.indexOf('\'', i + 1);
      if (close === -1) return state;
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      if (line.startsWith('"""', i)) { state = 'basic'; i += 3; continue; }
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\') { i += 2; continue; }
        if (line[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return state;
}

/**
 * Split TOML content into ordered table sections.
 *
 * Each section runs from its `[header]` / `[[header]]` line to the next header
 * or EOF, with `array` distinguishing array-of-tables (`[[x]]`) from struct
 * tables (`[x]`). Headers that appear inside a multiline string are ignored.
 */
function getTomlTableSections(content) {
  const lines = splitTomlLines(content);
  const headers = [];
  let multilineState = null;

  for (const line of lines) {
    if (multilineState === null) {
      const header = parseTomlTableHeader(line.text);
      if (header) {
        headers.push({
          path: header.path,
          array: header.array,
          start: line.start,
          headerEnd: line.end + line.eol.length,
        });
      }
    }
    multilineState = advanceTomlMultilineStringState(line.text, multilineState);
  }

  return headers.map((header, index) => ({
    ...header,
    end: index + 1 < headers.length ? headers[index + 1].start : content.length,
  }));
}

function removeContentRanges(content, ranges) {
  const sorted = ranges
    .filter((r) => r && r.start < r.end)
    .sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return content;

  let cleaned = '';
  let cursor = 0;
  for (const range of sorted) {
    if (range.start < cursor) continue;
    cleaned += content.slice(cursor, range.start);
    cursor = range.end;
  }
  cleaned += content.slice(cursor);
  return cleaned;
}

/**
 * Strip FVS sections from Codex config.toml content.
 *
 * Removes only what FVS owns so a reinstall/uninstall returns the file to its
 * pre-FVS shape: the FVS marker block, current `[agents.fvs-*]` struct tables,
 * and legacy `[[agents]]` array entries whose `name = "fvs-*"`. User-authored
 * tables and GSD-authored `[agents.gsd-*]` tables are preserved verbatim via a
 * TOML-section parse rather than a regex that could absorb adjacent tables.
 *
 * Returns cleaned content, or null if the file would be empty.
 */
function stripFvsFromCodexConfig(content) {
  const sections = getTomlTableSections(content);

  const removalRanges = sections
    .filter((section) => {
      // Current struct-form tables, e.g. [agents.fvs-executor].
      if (!section.array && /^agents\.fvs-/.test(section.path)) {
        return true;
      }
      // Legacy [[agents]] array-of-tables whose name = "fvs-...". Preserve any
      // user-authored or gsd- entries.
      if (section.array && section.path === 'agents') {
        const body = content.slice(section.headerEnd, section.end);
        const nameMatch = body.match(/^[ \t]*name[ \t]*=[ \t]*["']([^"']+)["']/m);
        return Boolean(nameMatch && /^fvs-/.test(nameMatch[1]));
      }
      return false;
    })
    .map(({ start, end }) => ({ start, end }));

  let cleaned = removeContentRanges(content, removalRanges);

  // Remove the FVS marker line itself plus the blank line that followed it in
  // the FVS-emitted block.
  const markerIndex = cleaned.indexOf(FVS_CODEX_MARKER);
  if (markerIndex !== -1) {
    const before = cleaned.slice(0, markerIndex);
    const after = cleaned
      .slice(markerIndex + FVS_CODEX_MARKER.length)
      .replace(/^[^\n]*\r?\n/, '');
    cleaned = before + after;
  }

  // Collapse runs of blank lines the removals may have left behind.
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  if (!cleaned) return null;
  return cleaned + '\n';
}

/**
 * Merge FVS config block into an existing or new config.toml.
 *
 * On reinstall this first strips any previously-emitted FVS tables via the
 * TOML-aware strip (so foreign user/GSD tables survive verbatim and stale FVS
 * tables are removed), then appends the freshly-generated FVS block. The
 * FVS-emitted block carries no `[features]`/`multi_agent` keys, so none are
 * injected into the user's config.
 */
function mergeCodexConfig(configPath, fvsBlock) {
  // Case 1: No config.toml -- create fresh.
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, fvsBlock + '\n');
    return;
  }

  const existing = fs.readFileSync(configPath, 'utf8');

  // Strip any prior FVS-owned tables (struct + legacy array) and marker, leaving
  // foreign tables untouched. A null result means the file was FVS-only.
  const stripped = stripFvsFromCodexConfig(existing);
  const preserved = stripped === null ? '' : stripped.trimEnd();

  const merged = preserved
    ? preserved + '\n\n' + fvsBlock + '\n'
    : fvsBlock + '\n';

  fs.writeFileSync(configPath, merged);
}

// ── Codex hooks subsystem ────────────────────────────────────────────────────
//
// Current Codex CLI dispatches lifecycle events (e.g. SessionStart) from a
// `hooks.json` file in the config dir, gated by a boolean feature flag in
// config.toml. FVS registers a single SessionStart hook that runs the update
// checker. The reconcile preserves any foreign (user- or GSD-authored) entries:
// it removes only FVS-managed entries (matched by hook-script basename) before
// appending exactly one fresh FVS entry, and it writes back into whichever
// hooks.json shape the file already uses.

function detectLineEnding(content) {
  return /\r\n/.test(content) ? '\r\n' : '\n';
}

// Write through a sibling temp file then rename, so a mid-write failure cannot
// truncate an existing config the user depends on to launch their session.
function atomicWriteFileSync(targetPath, data, encoding = 'utf8') {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, data, encoding);
  fs.renameSync(tmp, targetPath);
}

function tomlEscapeDoubleQuoted(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Resolve a stable absolute path to the Node executable, normalizing the
// Homebrew Cellar symlink form to its stable bin/ alias so a node upgrade does
// not orphan the hook command. Returns a JSON-quoted, forward-slashed token, or
// null when process.execPath is unavailable.
function resolveCodexNodeRunner() {
  const execPath = typeof process.execPath === 'string' ? process.execPath : '';
  if (!execPath) return null;
  let stable = execPath;
  if (/^\/usr\/local\/Cellar\/node(@\d+)?\/[^/]+\/bin\/node(\.exe)?$/.test(execPath)) {
    stable = '/usr/local/bin/node';
  } else if (/^\/opt\/homebrew\/Cellar\/node(@\d+)?\/[^/]+\/bin\/node(\.exe)?$/.test(execPath)) {
    stable = '/opt/homebrew/bin/node';
  }
  return JSON.stringify(stable.replace(/\\/g, '/'));
}

function isFvsManagedCodexHookCommand(commandText, configDir) {
  if (typeof commandText !== 'string') return false;
  const normalized = commandText.replace(/\\/g, '/');
  if (typeof configDir === 'string' && configDir.length > 0) {
    const hooksDir = `${path.join(configDir, 'hooks').replace(/\\/g, '/')}/`;
    if (!normalized.includes(hooksDir)) return false;
  }
  for (const basename of FVS_CODEX_MANAGED_HOOK_BASENAMES) {
    const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('(^|[\\\\/\\s"\'`])' + escaped + '(?=$|[\\s"\'`])');
    if (pattern.test(normalized)) return true;
  }
  return false;
}

// Read hooks.json, drop any prior FVS-managed entries for `eventName`, then
// append exactly one fresh managed entry (unless managedCommand is null, which
// means remove-only). Foreign entries are preserved and the file is written back
// in the SAME shape it used: nested `{ hooks: { <Event>: [...] } }` or flat
// `{ <Event>: [...] }`. Returns { changed, wrote, path }.
function reconcileCodexHooksJsonEvent(targetDir, eventName, opts = {}) {
  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  const managedCommand = typeof opts.managedCommand === 'string' ? opts.managedCommand : null;
  const commandWindows = typeof opts.commandWindows === 'string' ? opts.commandWindows : null;

  let parsed = {};
  let currentContent = null;
  if (fs.existsSync(hooksJsonPath)) {
    const raw = fs.readFileSync(hooksJsonPath, 'utf8');
    currentContent = raw;
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(`hooks.json parse failed: ${err && err.message ? err.message : String(err)}`);
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};

  const usesNestedHooksObject =
    parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks);
  const hookTable = usesNestedHooksObject ? parsed.hooks : parsed;
  const eventEntries = Array.isArray(hookTable[eventName]) ? hookTable[eventName] : [];

  let removedManaged = false;
  const sanitizedEntries = [];
  for (const entry of eventEntries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const originalHooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    if (originalHooks.length === 0) {
      sanitizedEntries.push(entry);
      continue;
    }
    const keptHooks = originalHooks.filter((hook) => {
      const cmd = hook && typeof hook === 'object' ? hook.command : null;
      const managed = isFvsManagedCodexHookCommand(cmd, targetDir);
      if (managed) removedManaged = true;
      return !managed;
    });
    if (keptHooks.length === 0) continue;
    sanitizedEntries.push({ ...entry, hooks: keptHooks });
  }

  if (managedCommand) {
    const hookEntry = { type: 'command', command: managedCommand };
    if (commandWindows) hookEntry.commandWindows = commandWindows;
    sanitizedEntries.push({ hooks: [hookEntry] });
  }

  if (sanitizedEntries.length > 0) {
    hookTable[eventName] = sanitizedEntries;
  } else {
    delete hookTable[eventName];
  }
  if (usesNestedHooksObject) parsed.hooks = hookTable;

  const nextContent = `${JSON.stringify(parsed, null, 2)}\n`;
  const changed = currentContent !== nextContent;
  const shouldWrite = changed && (currentContent !== null || Object.keys(parsed).length > 0);
  if (shouldWrite) {
    atomicWriteFileSync(hooksJsonPath, nextContent, 'utf8');
  }
  return { changed: changed || removedManaged, wrote: shouldWrite, path: hooksJsonPath };
}

function reconcileCodexHooksJsonSessionStart(targetDir, opts = {}) {
  return reconcileCodexHooksJsonEvent(targetDir, 'SessionStart', opts);
}

// Build the Windows `.cmd` shim that wraps the Node invocation. A bare
// `node.exe <script>` command fails when Codex dispatches hooks through
// Git-Bash's POSIX exec; a `.cmd` shim launched with passthrough args avoids
// that. Returns the shim file path, its rendered body, and the hooks.json
// command token, or null when no runner is available.
function buildCodexHookWindowsShimIR(scriptAbsPath, absoluteRunnerToken) {
  if (!absoluteRunnerToken) return null;
  let interpreter;
  try {
    interpreter = JSON.parse(absoluteRunnerToken);
  } catch {
    interpreter = absoluteRunnerToken;
  }
  const targetAbs = scriptAbsPath.replace(/\\/g, '/');
  const scriptQuoted = JSON.stringify(targetAbs);
  const cmdPath = scriptAbsPath.replace(/\.js$/, '.cmd');
  const hookCommand = JSON.stringify(cmdPath.replace(/\\/g, '/'));
  const runnerQuoted = JSON.stringify(interpreter);
  return {
    cmdPath,
    hookCommand,
    render: () => `@ECHO OFF\r\n@SETLOCAL\r\n@${runnerQuoted} ${scriptQuoted} %*\r\n`,
  };
}

// Rewrite a legacy bare-`node <script>` hook command in a config.toml `[hooks]`
// block to an absolute-node command, so a hook authored under a full-PATH shell
// still launches under Codex's minimal-PATH GUI launch. Only touches commands
// whose script basename is FVS-managed.
function rewriteLegacyCodexHookBlock(content, absoluteRunnerToken) {
  if (!content || !absoluteRunnerToken) return { content, changed: false };
  let interpreter;
  try {
    interpreter = JSON.parse(absoluteRunnerToken);
  } catch {
    interpreter = absoluteRunnerToken;
  }
  let changed = false;
  const updated = content.replace(
    /^(command\s*=\s*")node\s+((?:\\"[^"]+\\"|\S+))("\s*)$/gm,
    (full, prefix, scriptToken, suffix) => {
      const quoted = scriptToken.match(/^\\"([\s\S]+)\\"$/);
      const scriptPath = quoted ? quoted[1] : scriptToken;
      if (!isFvsManagedCodexHookCommand(scriptPath)) return full;
      const desired = tomlEscapeDoubleQuoted(`${interpreter} ${JSON.stringify(scriptPath)}`);
      const current = `${scriptToken}`;
      const next = `${prefix}${desired}${suffix}`;
      if (`${prefix}node ${current}${suffix}` === next) return full;
      changed = true;
      return next;
    },
  );
  return { content: updated, changed: changed || updated !== content };
}

// Migrate older Codex `[hooks]` representations to the two-level nested
// array-of-tables form (`[[hooks.<Event>]]` + `[[hooks.<Event>.hooks]]`) that
// current Codex CLI requires. Handles: a bare `[hooks]` map / single-level
// `[hooks.<Event>]` table, flat `[[hooks]]` array entries (event taken from an
// `event` key), and a single-block `[[hooks.<Event>]]` carrying handler fields
// directly with no `[[hooks.<Event>.hooks]]` sub-table. Returns content
// unchanged when nothing matches.
function migrateCodexHooksMapFormat(content) {
  if (!content) return content;
  const sections = getTomlTableSections(content);
  const segLen = (p) => {
    // Count parsed key segments, ignoring dots inside quoted names.
    let inStr = false; let quote = '';
    let count = p.length ? 1 : 0;
    for (let i = 0; i < p.length; i += 1) {
      const ch = p[i];
      if (inStr) { if (ch === quote) inStr = false; continue; }
      if (ch === '"' || ch === '\'') { inStr = true; quote = ch; continue; }
      if (ch === '.') count += 1;
    }
    return count;
  };

  const legacyMapSections = sections.filter(
    (s) => !s.array && (
      s.path === 'hooks' ||
      (s.path.startsWith('hooks.') && segLen(s.path) === 2 &&
        s.path !== 'hooks.state' && !s.path.startsWith('hooks.state.'))
    ),
  );
  const flatAotSections = sections.filter((s) => s.array && s.path === 'hooks');
  const STALE_HANDLER = /^\s*(?:command|type|timeout|statusMessage)\s*=/m;
  const staleNamespaced = sections.filter((s) => {
    if (!s.array || !s.path.startsWith('hooks.') || segLen(s.path) !== 2) return false;
    const body = content.slice(s.headerEnd, s.end);
    if (!STALE_HANDLER.test(body)) return false;
    const subPath = `${s.path}.hooks`;
    return !sections.some((x) => x.array && x.path === subPath);
  });

  if (legacyMapSections.length === 0 && flatAotSections.length === 0 && staleNamespaced.length === 0) {
    return content;
  }

  const eol = detectLineEnding(content);
  const quoteEvent = (name) => (/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name));
  const readKeyValueLines = (body, skip = new Set()) => {
    const out = { event: [], handler: [], type: null };
    for (const rawLine of body.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
      const m = trimmed.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=/);
      if (!m) continue;
      let key = m[1];
      if (/^["']/.test(key)) { try { key = JSON.parse(key.replace(/^'/, '"').replace(/'$/, '"')); } catch { key = key.slice(1, -1); } }
      if (skip.has(key)) continue;
      if (key === 'event') { out.type = trimmed.replace(/^[^=]*=\s*/, '').replace(/^["']|["']$/g, ''); continue; }
      if (key === 'matcher') out.event.push(trimmed);
      else out.handler.push(trimmed);
    }
    return out;
  };

  const renderEvent = (eventName, eventLines, handlerLines) => {
    let block = `${eol}[[hooks.${quoteEvent(eventName)}]]${eol}`;
    for (const line of eventLines) block += `${line}${eol}`;
    block += `${eol}[[hooks.${quoteEvent(eventName)}.hooks]]${eol}`;
    const hasType = handlerLines.some((l) => /^type\s*=/.test(l));
    if (!hasType) block += `type = "command"${eol}`;
    for (const line of handlerLines) block += `${line}${eol}`;
    return block;
  };

  const ranges = [];
  let rebuilt = '';

  for (const s of legacyMapSections) {
    ranges.push({ start: s.start, end: s.end });
    const eventName = s.path === 'hooks' ? null : s.path.slice('hooks.'.length);
    const { event, handler } = readKeyValueLines(content.slice(s.headerEnd, s.end));
    if (eventName && (event.length || handler.length)) {
      rebuilt += renderEvent(eventName, event, handler);
    }
  }
  for (const s of flatAotSections) {
    ranges.push({ start: s.start, end: s.end });
    const { event, handler, type } = readKeyValueLines(content.slice(s.headerEnd, s.end), new Set(['event']));
    if (type) rebuilt += renderEvent(type, event, handler);
  }
  for (const s of staleNamespaced) {
    ranges.push({ start: s.start, end: s.end });
    const eventName = s.path.slice('hooks.'.length);
    const { event, handler } = readKeyValueLines(content.slice(s.headerEnd, s.end));
    rebuilt += renderEvent(eventName, event, handler);
  }

  const stripped = removeContentRanges(content, ranges).trimEnd();
  return `${stripped}${rebuilt}${eol}`;
}

// Ensure the FVS SessionStart hook is registered in hooks.json, resolving the
// managed command from the absolute Node runner plus the resolved script path.
// On win32 a `.cmd` shim is written and emitted as commandWindows. Returns the
// reconcile result, or a no-op result when no runner is available.
function ensureCodexHooksJsonSessionStart(targetDir, opts = {}) {
  const platform = opts.platform || process.platform;
  const absoluteRunner = opts.absoluteRunner || null;
  const hooksJsonPath = path.join(targetDir, 'hooks.json');
  if (!absoluteRunner) return { changed: false, wrote: false, path: hooksJsonPath };

  const scriptPath = path.resolve(targetDir, 'hooks', 'fvs-check-update.js').replace(/\\/g, '/');

  let managedCommand;
  let commandWindows;
  if (platform === 'win32') {
    const shimIR = buildCodexHookWindowsShimIR(scriptPath, absoluteRunner);
    if (!shimIR) return { changed: false, wrote: false, path: hooksJsonPath };
    try {
      atomicWriteFileSync(shimIR.cmdPath, shimIR.render(), 'utf8');
    } catch (shimErr) {
      const reason = shimErr && shimErr.message ? shimErr.message : String(shimErr);
      console.warn(
        `  ${yellow}⚠${reset}  Codex Windows hook NOT installed — .cmd shim write failed: ${reason}. ` +
        `Fix the write error and re-run the installer.`,
      );
      return { changed: false, wrote: false, path: hooksJsonPath };
    }
    managedCommand = shimIR.hookCommand;
    commandWindows = shimIR.hookCommand;
  } else {
    managedCommand = `${absoluteRunner} ${JSON.stringify(scriptPath)}`;
  }

  if (!managedCommand) return { changed: false, wrote: false, path: hooksJsonPath };
  return reconcileCodexHooksJsonSessionStart(targetDir, { managedCommand, commandWindows });
}

function removeCodexHooksJsonSessionStart(targetDir) {
  return reconcileCodexHooksJsonSessionStart(targetDir, { managedCommand: null });
}

// Ensure the Codex hooks feature flag is present and set true under the
// canonical key. If the file already enables the flag under the legacy key,
// rewrite that line to the canonical key (migrate forward) rather than adding a
// duplicate. Returns { content, changed }.
function ensureCodexHooksFeature(configContent) {
  const content = typeof configContent === 'string' ? configContent : '';
  const eol = content ? detectLineEnding(content) : '\n';
  const lines = content.length ? content.split(/\r?\n/) : [];

  let canonicalIdx = -1;
  let legacyIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (key === CODEX_HOOKS_FEATURE_KEY && canonicalIdx === -1) canonicalIdx = i;
    else if (CODEX_HOOKS_FEATURE_LEGACY_KEYS.includes(key) && legacyIdx === -1) legacyIdx = i;
  }

  // Only operate on root-level flag lines (not inside a [table]); a flag line
  // appearing after the first [section] header is treated as section-scoped and
  // left alone — FVS emits the flag at the document root before any table.
  const firstHeaderIdx = lines.findIndex((l) => /^\s*\[/.test(l));
  const isRootLevel = (idx) => idx !== -1 && (firstHeaderIdx === -1 || idx < firstHeaderIdx);

  if (isRootLevel(canonicalIdx)) {
    if (/=\s*true\s*$/.test(lines[canonicalIdx])) return { content, changed: false };
    lines[canonicalIdx] = `${CODEX_HOOKS_FEATURE_KEY} = true`;
    return { content: lines.join(eol), changed: true };
  }
  if (isRootLevel(legacyIdx)) {
    lines[legacyIdx] = `${CODEX_HOOKS_FEATURE_KEY} = true`;
    return { content: lines.join(eol), changed: true };
  }

  // Insert a fresh canonical flag line at the document root, above any table.
  const insertLine = `${CODEX_HOOKS_FEATURE_KEY} = true`;
  if (firstHeaderIdx === -1) {
    const base = content.trimEnd();
    const next = base ? `${insertLine}${eol}${base}${eol}` : `${insertLine}${eol}`;
    return { content: next, changed: true };
  }
  lines.splice(firstHeaderIdx, 0, insertLine, '');
  return { content: lines.join(eol), changed: true };
}

function hasEnabledCodexHooksFeature(configContent) {
  if (typeof configContent !== 'string') return false;
  const firstHeaderIdx = configContent.split(/\r?\n/).findIndex((l) => /^\s*\[/.test(l));
  const lines = configContent.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (firstHeaderIdx !== -1 && i >= firstHeaderIdx) break;
    const m = lines[i].match(/^\s*([A-Za-z0-9_]+)\s*=\s*true\s*$/);
    if (m && CODEX_HOOKS_FEATURE_ALL_KEYS.includes(m[1])) return true;
  }
  return false;
}

/**
 * Generate config.toml and per-agent .toml files for Codex.
 * Reads agent .md files from source, extracts metadata, writes .toml configs.
 */
function installCodexConfig(targetDir, agentsSrc) {
  const configPath = path.join(targetDir, 'config.toml');
  const agentsTomlDir = path.join(targetDir, 'agents');
  fs.mkdirSync(agentsTomlDir, { recursive: true });

  const agentEntries = fs.readdirSync(agentsSrc).filter(f => f.startsWith('fvs-') && f.endsWith('.md'));
  const agents = [];

  // Compute the Codex pathPrefix for replacing .claude paths
  const codexPathPrefix = `${targetDir.replace(/\\/g, '/')}/`;

  // Track the .toml files this install owns so stale per-agent configs for
  // agents no longer shipped can be pruned afterward.
  const currentTomlFiles = new Set();

  for (const file of agentEntries) {
    let content = fs.readFileSync(path.join(agentsSrc, file), 'utf8');
    // Replace .claude paths before generating TOML (source files use ~/.claude and $HOME/.claude)
    content = content.replace(/~\/\.claude\//g, codexPathPrefix);
    content = content.replace(/\$HOME\/\.claude\//g, toHomePrefix(codexPathPrefix));
    const { frontmatter } = extractFrontmatterAndBody(content);
    const name = extractFrontmatterField(frontmatter, 'name') || file.replace('.md', '');
    const description = extractFrontmatterField(frontmatter, 'description') || '';

    agents.push({ name, description: toSingleLine(description) });

    const tomlContent = generateCodexAgentToml(name, content);
    const tomlFile = `${name}.toml`;
    currentTomlFiles.add(tomlFile);
    fs.writeFileSync(path.join(agentsTomlDir, tomlFile), tomlContent);
  }

  // Prune orphan per-agent configs: any fvs-*.toml left from a prior install
  // whose agent is no longer shipped is removed so reinstall regenerates
  // exactly the current set.
  for (const existing of fs.readdirSync(agentsTomlDir)) {
    if (existing.startsWith('fvs-') && existing.endsWith('.toml') && !currentTomlFiles.has(existing)) {
      fs.unlinkSync(path.join(agentsTomlDir, existing));
    }
  }

  const fvsBlock = generateCodexConfigBlock(agents, targetDir);
  mergeCodexConfig(configPath, fvsBlock);

  // Enable the Codex hooks feature flag (canonical key, legacy alias migrated
  // forward) so the SessionStart hook in hooks.json is dispatched. Migrate any
  // legacy `[hooks]` representation to the nested AoT shape first.
  if (fs.existsSync(configPath)) {
    let configContent = fs.readFileSync(configPath, 'utf8');
    const migrated = migrateCodexHooksMapFormat(configContent);
    if (migrated !== configContent) configContent = migrated;
    const feature = ensureCodexHooksFeature(configContent);
    if (feature.changed || migrated !== fs.readFileSync(configPath, 'utf8')) {
      fs.writeFileSync(configPath, feature.content);
    }
  }

  return agents.length;
}

/**
 * List Codex skill directory names matching a prefix
 */
function listCodexSkillNames(skillsDir, prefix = 'fvs-') {
  if (!fs.existsSync(skillsDir)) return [];
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
    .filter(entry => fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort();
}

/**
 * Copy commands as Codex skills (skills/fvs-help/SKILL.md structure)
 */
function copyCommandsAsCodexSkills(srcDir, skillsDir, prefix, pathPrefix, runtime) {
  if (!fs.existsSync(srcDir)) {
    return;
  }

  fs.mkdirSync(skillsDir, { recursive: true });

  // Remove previous FVS Codex skills to avoid stale command skills
  const existing = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of existing) {
    if (entry.isDirectory() && entry.name.startsWith(`${prefix}-`)) {
      fs.rmSync(path.join(skillsDir, entry.name), { recursive: true });
    }
  }

  function recurse(currentSrcDir, currentPrefix) {
    const entries = fs.readdirSync(currentSrcDir, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(currentSrcDir, entry.name);
      if (entry.isDirectory()) {
        recurse(srcPath, `${currentPrefix}-${entry.name}`);
        continue;
      }

      if (!entry.name.endsWith('.md')) {
        continue;
      }

      const baseName = entry.name.replace('.md', '');
      const skillName = `${currentPrefix}-${baseName}`;
      const skillDir = path.join(skillsDir, skillName);
      fs.mkdirSync(skillDir, { recursive: true });

      let content = fs.readFileSync(srcPath, 'utf8');
      const globalClaudeRegex = /~\/\.claude\//g;
      const globalClaudeHomeRegex = /\$HOME\/\.claude\//g;
      const localClaudeRegex = /\.\/\.claude\//g;
      const codexDirRegex = /~\/\.codex\//g;
      content = content.replace(globalClaudeRegex, pathPrefix);
      content = content.replace(globalClaudeHomeRegex, toHomePrefix(pathPrefix));
      content = content.replace(localClaudeRegex, `./${getDirName(runtime)}/`);
      content = content.replace(codexDirRegex, pathPrefix);

      content = convertClaudeCommandToCodexSkill(content, skillName);

      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    }
  }

  recurse(srcDir, prefix);
}

/**
 * Copy commands to a flat structure for OpenCode
 * OpenCode expects: command/fvs-help.md (invoked as /fvs-help)
 * Source structure: commands/fvs/help.md
 *
 * @param {string} srcDir - Source directory (e.g., commands/fvs/)
 * @param {string} destDir - Destination directory (e.g., command/)
 * @param {string} prefix - Prefix for filenames (e.g., 'fvs')
 * @param {string} pathPrefix - Path prefix for file references
 * @param {string} runtime - Target runtime ('claude' or 'opencode')
 */
function copyFlattenedCommands(srcDir, destDir, prefix, pathPrefix, runtime) {
  if (!fs.existsSync(srcDir)) {
    return;
  }

  // Remove old fvs-*.md files before copying new ones
  if (fs.existsSync(destDir)) {
    for (const file of fs.readdirSync(destDir)) {
      if (file.startsWith(`${prefix}-`) && file.endsWith('.md')) {
        fs.unlinkSync(path.join(destDir, file));
      }
    }
  } else {
    fs.mkdirSync(destDir, { recursive: true });
  }

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);

    if (entry.isDirectory()) {
      // Recurse into subdirectories, adding to prefix
      // e.g., commands/fvs/debug/start.md -> command/fvs-debug-start.md
      copyFlattenedCommands(srcPath, destDir, `${prefix}-${entry.name}`, pathPrefix, runtime);
    } else if (entry.name.endsWith('.md')) {
      // Flatten: help.md -> fvs-help.md
      const baseName = entry.name.replace('.md', '');
      const destName = `${prefix}-${baseName}.md`;
      const destPath = path.join(destDir, destName);

      let content = fs.readFileSync(srcPath, 'utf8');
      const globalClaudeRegex = /~\/\.claude\//g;
      const globalClaudeHomeRegex = /\$HOME\/\.claude\//g;
      const localClaudeRegex = /\.\/\.claude\//g;
      const opencodeDirRegex = /~\/\.opencode\//g;
      content = content.replace(globalClaudeRegex, pathPrefix);
      content = content.replace(globalClaudeHomeRegex, toHomePrefix(pathPrefix));
      content = content.replace(localClaudeRegex, `./${getDirName(runtime)}/`);
      content = content.replace(opencodeDirRegex, pathPrefix);

      content = convertClaudeToOpencodeFrontmatter(content);

      fs.writeFileSync(destPath, content);
    }
  }
}

/**
 * Recursively copy directory, replacing paths in .md files
 * Deletes existing destDir first to remove orphaned files from previous versions
 * @param {string} srcDir - Source directory
 * @param {string} destDir - Destination directory
 * @param {string} pathPrefix - Path prefix for file references
 * @param {string} runtime - Target runtime ('claude', 'opencode', 'gemini', 'codex')
 */
function copyWithPathReplacement(srcDir, destDir, pathPrefix, runtime, isCommand = false) {
  const isOpencode = runtime === 'opencode';
  const isCodex = runtime === 'codex';
  const dirName = getDirName(runtime);

  // Clean install: remove existing destination to prevent orphaned files
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      copyWithPathReplacement(srcPath, destPath, pathPrefix, runtime, isCommand);
    } else if (entry.name.endsWith('.md')) {
      // Replace ~/.claude/ and $HOME/.claude/ and ./.claude/ with runtime-appropriate paths
      let content = fs.readFileSync(srcPath, 'utf8');
      const globalClaudeRegex = /~\/\.claude\//g;
      const globalClaudeHomeRegex = /\$HOME\/\.claude\//g;
      const localClaudeRegex = /\.\/\.claude\//g;
      content = content.replace(globalClaudeRegex, pathPrefix);
      content = content.replace(globalClaudeHomeRegex, toHomePrefix(pathPrefix));
      content = content.replace(localClaudeRegex, `./${dirName}/`);

      // Convert frontmatter for opencode compatibility
      if (isOpencode) {
        content = convertClaudeToOpencodeFrontmatter(content);
        fs.writeFileSync(destPath, content);
      } else if (isCodex) {
        content = convertClaudeToCodexMarkdown(content);
        fs.writeFileSync(destPath, content);
      } else if (runtime === 'gemini') {
        if (isCommand) {
          // Convert to TOML for Gemini (strip <sub> tags — terminals can't render subscript)
          content = stripSubTags(content);
          const tomlContent = convertClaudeToGeminiToml(content);
          // Replace extension with .toml
          const tomlPath = destPath.replace(/\.md$/, '.toml');
          fs.writeFileSync(tomlPath, tomlContent);
        } else {
          fs.writeFileSync(destPath, content);
        }
      } else {
        fs.writeFileSync(destPath, content);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Uninstall FVS from the specified directory for a specific runtime
 * Removes only FVS-specific files/directories, preserves user content
 * @param {boolean} isGlobal - Whether to uninstall from global or local
 * @param {string} runtime - Target runtime ('claude', 'opencode', 'gemini')
 */
function uninstall(isGlobal, runtime = 'claude') {
  const isOpencode = runtime === 'opencode';
  const isCodex = runtime === 'codex';
  const dirName = getDirName(runtime);

  // Get the target directory based on runtime and install type
  const targetDir = isGlobal
    ? getGlobalDir(runtime, explicitConfigDir)
    : path.join(process.cwd(), dirName);

  const locationLabel = isGlobal
    ? targetDir.replace(os.homedir(), '~')
    : targetDir.replace(process.cwd(), '.');

  let runtimeLabel = 'Claude Code';
  if (runtime === 'opencode') runtimeLabel = 'OpenCode';
  if (runtime === 'gemini') runtimeLabel = 'Gemini';
  if (runtime === 'codex') runtimeLabel = 'Codex';

  console.log(`  Uninstalling FVS from ${orange}${runtimeLabel}${reset} at ${orange}${locationLabel}${reset}\n`);

  // Check if target directory exists
  if (!fs.existsSync(targetDir)) {
    console.log(`  ${yellow}⚠${reset} Directory does not exist: ${locationLabel}`);
    console.log(`  Nothing to uninstall.\n`);
    return;
  }

  let removedCount = 0;

  // 1. Remove FVS commands/skills directory
  if (isCodex) {
    // Codex: remove skills/fvs-*/SKILL.md skill directories
    const skillsDir = path.join(targetDir, 'skills');
    if (fs.existsSync(skillsDir)) {
      let skillCount = 0;
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('fvs-')) {
          fs.rmSync(path.join(skillsDir, entry.name), { recursive: true });
          skillCount++;
        }
      }
      if (skillCount > 0) {
        removedCount++;
        console.log(`  ${green}✓${reset} Removed ${skillCount} Codex skills`);
      }
    }

    // Codex: also remove commands/fvs/ (slash commands)
    const fvsCommandsDir = path.join(targetDir, 'commands', 'fvs');
    if (fs.existsSync(fvsCommandsDir)) {
      fs.rmSync(fvsCommandsDir, { recursive: true });
      removedCount++;
      console.log(`  ${green}✓${reset} Removed commands/fvs/`);
    }

    // Codex: remove FVS agent .toml config files
    const codexAgentsDir = path.join(targetDir, 'agents');
    if (fs.existsSync(codexAgentsDir)) {
      const tomlFiles = fs.readdirSync(codexAgentsDir);
      let tomlCount = 0;
      for (const file of tomlFiles) {
        if (file.startsWith('fvs-') && file.endsWith('.toml')) {
          fs.unlinkSync(path.join(codexAgentsDir, file));
          tomlCount++;
        }
      }
      if (tomlCount > 0) {
        removedCount++;
        console.log(`  ${green}✓${reset} Removed ${tomlCount} agent .toml configs`);
      }
    }

    // Codex: clean FVS sections from config.toml
    const configPath = path.join(targetDir, 'config.toml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      const cleaned = stripFvsFromCodexConfig(content);
      if (cleaned === null) {
        // File is empty after stripping -- delete it
        fs.unlinkSync(configPath);
        removedCount++;
        console.log(`  ${green}✓${reset} Removed config.toml (was FVS-only)`);
      } else if (cleaned !== content) {
        fs.writeFileSync(configPath, cleaned);
        removedCount++;
        console.log(`  ${green}✓${reset} Cleaned FVS sections from config.toml`);
      }
    }
  } else if (isOpencode) {
    // OpenCode: remove command/fvs-*.md files
    const commandDir = path.join(targetDir, 'command');
    if (fs.existsSync(commandDir)) {
      const files = fs.readdirSync(commandDir);
      for (const file of files) {
        if (file.startsWith('fvs-') && file.endsWith('.md')) {
          fs.unlinkSync(path.join(commandDir, file));
          removedCount++;
        }
      }
      console.log(`  ${green}✓${reset} Removed FVS commands from command/`);
    }
  } else {
    // Claude Code & Gemini: remove commands/fvs/ directory
    const fvsCommandsDir = path.join(targetDir, 'commands', 'fvs');
    if (fs.existsSync(fvsCommandsDir)) {
      fs.rmSync(fvsCommandsDir, { recursive: true });
      removedCount++;
      console.log(`  ${green}✓${reset} Removed commands/fvs/`);
    }
  }

  // 2. Remove fv-skills directory
  const fvSkillsDir = path.join(targetDir, 'fv-skills');
  if (fs.existsSync(fvSkillsDir)) {
    fs.rmSync(fvSkillsDir, { recursive: true });
    removedCount++;
    console.log(`  ${green}✓${reset} Removed fv-skills/`);
  }

  // 3. Remove FVS agents (fvs-*.md files only)
  const agentsDir = path.join(targetDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    const files = fs.readdirSync(agentsDir);
    let agentCount = 0;
    for (const file of files) {
      if (file.startsWith('fvs-') && file.endsWith('.md')) {
        fs.unlinkSync(path.join(agentsDir, file));
        agentCount++;
      }
    }
    if (agentCount > 0) {
      removedCount++;
      console.log(`  ${green}✓${reset} Removed ${agentCount} FVS agents`);
    }
  }

  // 4. Remove FVS hooks. Codex carries only the update-check hook (wired as
  // SessionStart in hooks.json), plus its Windows .cmd shim; the statusline is
  // Claude-only. Other runtimes carry both hook scripts in settings.json.
  if (isCodex) {
    // Remove the FVS SessionStart entry from hooks.json, preserving any
    // foreign (user/GSD) entries.
    const hooksJsonPath = path.join(targetDir, 'hooks.json');
    if (fs.existsSync(hooksJsonPath)) {
      try {
        const result = removeCodexHooksJsonSessionStart(targetDir);
        if (result.wrote) {
          removedCount++;
          console.log(`  ${green}✓${reset} Removed FVS SessionStart hook from hooks.json`);
        }
      } catch (e) {
        // A malformed hooks.json is the user's to fix; do not abort uninstall.
      }
    }

    const hooksDir = path.join(targetDir, 'hooks');
    if (fs.existsSync(hooksDir)) {
      const codexHookFiles = ['fvs-check-update.js', 'fvs-check-update.cmd'];
      let hookCount = 0;
      for (const hook of codexHookFiles) {
        const hookPath = path.join(hooksDir, hook);
        if (fs.existsSync(hookPath)) {
          fs.unlinkSync(hookPath);
          hookCount++;
        }
      }
      if (hookCount > 0) {
        removedCount++;
        console.log(`  ${green}✓${reset} Removed ${hookCount} FVS Codex hook file(s)`);
      }
    }
  } else {
    const hooksDir = path.join(targetDir, 'hooks');
    if (fs.existsSync(hooksDir)) {
      const fvsHooks = ['fvs-statusline.js', 'fvs-check-update.js'];
      let hookCount = 0;
      for (const hook of fvsHooks) {
        const hookPath = path.join(hooksDir, hook);
        if (fs.existsSync(hookPath)) {
          fs.unlinkSync(hookPath);
          hookCount++;
        }
      }
      if (hookCount > 0) {
        removedCount++;
        console.log(`  ${green}✓${reset} Removed ${hookCount} FVS hooks`);
      }
    }
  }

  // 5. Remove FVS scripts (fvs-* files in scripts/)
  const scriptsUninstallDir = path.join(targetDir, 'scripts');
  if (fs.existsSync(scriptsUninstallDir)) {
    const scriptFiles = fs.readdirSync(scriptsUninstallDir);
    let scriptCount = 0;
    for (const file of scriptFiles) {
      if (file.startsWith('fvs-')) {
        fs.unlinkSync(path.join(scriptsUninstallDir, file));
        scriptCount++;
      }
    }
    // Remove dir if empty
    if (fs.readdirSync(scriptsUninstallDir).length === 0) {
      fs.rmdirSync(scriptsUninstallDir);
    }
    if (scriptCount > 0) {
      removedCount++;
      console.log(`  ${green}✓${reset} Removed ${scriptCount} FVS scripts`);
    }
  }

  // 6. Remove FVS package.json (CommonJS mode marker) -- skip for Codex
  if (!isCodex) {
    const pkgJsonPath = path.join(targetDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const content = fs.readFileSync(pkgJsonPath, 'utf8').trim();
        // Only remove if it's our minimal CommonJS marker
        if (content === '{"type":"commonjs"}') {
          fs.unlinkSync(pkgJsonPath);
          removedCount++;
          console.log(`  ${green}✓${reset} Removed FVS package.json`);
        }
      } catch (e) {
        // Ignore read errors
      }
    }
  }

  // 7. Clean up settings.json (remove FVS hooks and statusline). Codex has no
  // settings.json surface — its hook removal runs via the hooks.json path above.
  if (!isCodex) {
    const settingsPath = path.join(targetDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      let settings = readSettings(settingsPath);
      let settingsModified = false;

      // Remove FVS statusline if it references our hook
      if (settings.statusLine && settings.statusLine.command &&
          settings.statusLine.command.includes('fvs-statusline')) {
        delete settings.statusLine;
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed FVS statusline from settings`);
      }

      // Remove FVS hooks from SessionStart
      if (settings.hooks && settings.hooks.SessionStart) {
        const before = settings.hooks.SessionStart.length;
        settings.hooks.SessionStart = settings.hooks.SessionStart.filter(entry => {
          if (entry.hooks && Array.isArray(entry.hooks)) {
            // Filter out FVS hooks
            const hasFvsHook = entry.hooks.some(h =>
              h.command && (h.command.includes('fvs-check-update') || h.command.includes('fvs-statusline'))
            );
            return !hasFvsHook;
          }
          return true;
        });
        if (settings.hooks.SessionStart.length < before) {
          settingsModified = true;
          console.log(`  ${green}✓${reset} Removed FVS hooks from settings`);
        }
        // Clean up empty array
        if (settings.hooks.SessionStart.length === 0) {
          delete settings.hooks.SessionStart;
        }
        // Clean up empty hooks object
        if (Object.keys(settings.hooks).length === 0) {
          delete settings.hooks;
        }
      }

      if (settingsModified) {
        writeSettings(settingsPath, settings);
        removedCount++;
      }
    }
  }

  // 8. For OpenCode, clean up permissions from opencode.json
  if (isOpencode) {
    const opencodeConfigDir = getOpencodeGlobalDir();
    const configPath = path.join(opencodeConfigDir, 'opencode.json');
    if (fs.existsSync(configPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        let modified = false;

        // Remove FVS permission entries
        if (config.permission) {
          for (const permType of ['read', 'external_directory']) {
            if (config.permission[permType]) {
              const keys = Object.keys(config.permission[permType]);
              for (const key of keys) {
                if (key.includes('fv-skills')) {
                  delete config.permission[permType][key];
                  modified = true;
                }
              }
              // Clean up empty objects
              if (Object.keys(config.permission[permType]).length === 0) {
                delete config.permission[permType];
              }
            }
          }
          if (Object.keys(config.permission).length === 0) {
            delete config.permission;
          }
        }

        if (modified) {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
          removedCount++;
          console.log(`  ${green}✓${reset} Removed FVS permissions from opencode.json`);
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    }
  }

  if (removedCount === 0) {
    console.log(`  ${yellow}⚠${reset} No FVS files found to remove.`);
  }

  console.log(`
  ${green}Done!${reset} FVS has been uninstalled from ${runtimeLabel}.
  Your other files and settings have been preserved.
`);
}

/**
 * Parse JSONC (JSON with Comments) by stripping comments and trailing commas.
 * OpenCode supports JSONC format via jsonc-parser, so users may have comments.
 * This is a lightweight inline parser to avoid adding dependencies.
 */
function parseJsonc(content) {
  // Strip BOM if present
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }

  // Remove single-line and block comments while preserving strings
  let result = '';
  let inString = false;
  let i = 0;
  while (i < content.length) {
    const char = content[i];
    const next = content[i + 1];

    if (inString) {
      result += char;
      // Handle escape sequences
      if (char === '\\' && i + 1 < content.length) {
        result += next;
        i += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      i++;
    } else {
      if (char === '"') {
        inString = true;
        result += char;
        i++;
      } else if (char === '/' && next === '/') {
        // Skip single-line comment until end of line
        while (i < content.length && content[i] !== '\n') {
          i++;
        }
      } else if (char === '/' && next === '*') {
        // Skip block comment
        i += 2;
        while (i < content.length - 1 && !(content[i] === '*' && content[i + 1] === '/')) {
          i++;
        }
        i += 2; // Skip closing */
      } else {
        result += char;
        i++;
      }
    }
  }

  // Remove trailing commas before } or ]
  result = result.replace(/,(\s*[}\]])/g, '$1');

  return JSON.parse(result);
}

/**
 * Configure OpenCode permissions to allow reading FVS reference docs
 * This prevents permission prompts when FVS accesses the fv-skills directory
 * @param {boolean} isGlobal - Whether this is a global or local install
 */
function configureOpencodePermissions(isGlobal = true) {
  // For local installs, use ./.opencode/opencode.json
  // For global installs, use ~/.config/opencode/opencode.json
  const opencodeConfigDir = isGlobal
    ? getOpencodeGlobalDir()
    : path.join(process.cwd(), '.opencode');
  const configPath = path.join(opencodeConfigDir, 'opencode.json');

  // Ensure config directory exists
  fs.mkdirSync(opencodeConfigDir, { recursive: true });

  // Read existing config or create empty object
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      config = parseJsonc(content);
    } catch (e) {
      // Cannot parse - DO NOT overwrite user's config
      console.log(`  ${yellow}⚠${reset} Could not parse opencode.json - skipping permission config`);
      console.log(`    ${dim}Reason: ${e.message}${reset}`);
      console.log(`    ${dim}Your config was NOT modified. Fix the syntax manually if needed.${reset}`);
      return;
    }
  }

  // Ensure permission structure exists
  if (!config.permission) {
    config.permission = {};
  }

  // Build the FVS path using the actual config directory
  // Use ~ shorthand if it's in the default location, otherwise use full path
  const defaultConfigDir = path.join(os.homedir(), '.config', 'opencode');
  const fvsPath = opencodeConfigDir === defaultConfigDir
    ? '~/.config/opencode/fv-skills/*'
    : `${opencodeConfigDir.replace(/\\/g, '/')}/fv-skills/*`;

  let modified = false;

  // Configure read permission
  if (!config.permission.read || typeof config.permission.read !== 'object') {
    config.permission.read = {};
  }
  if (config.permission.read[fvsPath] !== 'allow') {
    config.permission.read[fvsPath] = 'allow';
    modified = true;
  }

  // Configure external_directory permission (the safety guard for paths outside project)
  if (!config.permission.external_directory || typeof config.permission.external_directory !== 'object') {
    config.permission.external_directory = {};
  }
  if (config.permission.external_directory[fvsPath] !== 'allow') {
    config.permission.external_directory[fvsPath] = 'allow';
    modified = true;
  }

  if (!modified) {
    return; // Already configured
  }

  // Write config back
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`  ${green}✓${reset} Configured read permission for FVS docs`);
}

/**
 * Verify a directory exists and contains files
 */
function verifyInstalled(dirPath, description) {
  if (!fs.existsSync(dirPath)) {
    console.error(`  ${yellow}✗${reset} Failed to install ${description}: directory not created`);
    return false;
  }
  try {
    const entries = fs.readdirSync(dirPath);
    if (entries.length === 0) {
      console.error(`  ${yellow}✗${reset} Failed to install ${description}: directory is empty`);
      return false;
    }
  } catch (e) {
    console.error(`  ${yellow}✗${reset} Failed to install ${description}: ${e.message}`);
    return false;
  }
  return true;
}

/**
 * Verify a file exists
 */
function verifyFileInstalled(filePath, description) {
  if (!fs.existsSync(filePath)) {
    console.error(`  ${yellow}✗${reset} Failed to install ${description}: file not created`);
    return false;
  }
  return true;
}

// ──────────────────────────────────────────────────────
// Local Patch Persistence
// ──────────────────────────────────────────────────────

const PATCHES_DIR_NAME = 'fvs-local-patches';
const MANIFEST_NAME = 'fvs-file-manifest.json';

/**
 * Compute SHA256 hash of file contents
 */
function fileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Recursively collect all files in dir with their hashes
 */
function generateManifest(dir, baseDir) {
  if (!baseDir) baseDir = dir;
  const manifest = {};
  if (!fs.existsSync(dir)) return manifest;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      Object.assign(manifest, generateManifest(fullPath, baseDir));
    } else {
      manifest[relPath] = fileHash(fullPath);
    }
  }
  return manifest;
}

/**
 * Write file manifest after installation for future modification detection
 */
function writeManifest(configDir, runtime = 'claude') {
  const isOpencode = runtime === 'opencode';
  const isCodex = runtime === 'codex';
  const fvSkillsDir = path.join(configDir, 'fv-skills');
  const commandsDir = path.join(configDir, 'commands', 'fvs');
  const opencodeCommandDir = path.join(configDir, 'command');
  const codexSkillsDir = path.join(configDir, 'skills');
  const agentsDir = path.join(configDir, 'agents');
  const manifest = { version: pkg.version, timestamp: new Date().toISOString(), files: {} };

  const fvHashes = generateManifest(fvSkillsDir);
  for (const [rel, hash] of Object.entries(fvHashes)) {
    manifest.files['fv-skills/' + rel] = hash;
  }
  if (!isOpencode && !isCodex && fs.existsSync(commandsDir)) {
    const cmdHashes = generateManifest(commandsDir);
    for (const [rel, hash] of Object.entries(cmdHashes)) {
      manifest.files['commands/fvs/' + rel] = hash;
    }
  }
  if (isOpencode && fs.existsSync(opencodeCommandDir)) {
    for (const file of fs.readdirSync(opencodeCommandDir)) {
      if (file.startsWith('fvs-') && file.endsWith('.md')) {
        manifest.files['command/' + file] = fileHash(path.join(opencodeCommandDir, file));
      }
    }
  }
  if (isCodex && fs.existsSync(codexSkillsDir)) {
    for (const skillName of listCodexSkillNames(codexSkillsDir)) {
      const skillRoot = path.join(codexSkillsDir, skillName);
      const skillHashes = generateManifest(skillRoot);
      for (const [rel, hash] of Object.entries(skillHashes)) {
        manifest.files[`skills/${skillName}/${rel}`] = hash;
      }
    }
  }
  if (fs.existsSync(agentsDir)) {
    for (const file of fs.readdirSync(agentsDir)) {
      if (file.startsWith('fvs-') && file.endsWith('.md')) {
        manifest.files['agents/' + file] = fileHash(path.join(agentsDir, file));
      }
    }
  }
  // Track hook files so saveLocalPatches() can detect user modifications.
  // Every runtime that lands a hook script participates: Claude/Gemini carry
  // both fvs-*.js hooks, Codex carries the single update-check hook.
  {
    const hooksDir = path.join(configDir, 'hooks');
    if (fs.existsSync(hooksDir)) {
      for (const file of fs.readdirSync(hooksDir)) {
        if (file.startsWith('fvs-') && file.endsWith('.js')) {
          manifest.files['hooks/' + file] = fileHash(path.join(hooksDir, file));
        }
      }
    }
  }
  // Track script files for local-patches detection
  const scriptsDir = path.join(configDir, 'scripts');
  if (fs.existsSync(scriptsDir)) {
    for (const file of fs.readdirSync(scriptsDir)) {
      if (file.startsWith('fvs-')) {
        manifest.files['scripts/' + file] = fileHash(path.join(scriptsDir, file));
      }
    }
  }

  fs.writeFileSync(path.join(configDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Detect user-modified FVS files by comparing against install manifest.
 * Backs up modified files to fvs-local-patches/ for reapply after update.
 */
function saveLocalPatches(configDir) {
  const manifestPath = path.join(configDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return [];

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return []; }

  const patchesDir = path.join(configDir, PATCHES_DIR_NAME);
  const modified = [];

  for (const [relPath, originalHash] of Object.entries(manifest.files || {})) {
    const fullPath = path.join(configDir, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const currentHash = fileHash(fullPath);
    if (currentHash !== originalHash) {
      const backupPath = path.join(patchesDir, relPath);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(fullPath, backupPath);
      modified.push(relPath);
    }
  }

  if (modified.length > 0) {
    const meta = {
      backed_up_at: new Date().toISOString(),
      from_version: manifest.version,
      files: modified
    };
    fs.writeFileSync(path.join(patchesDir, 'backup-meta.json'), JSON.stringify(meta, null, 2));
    console.log('  ' + yellow + 'i' + reset + '  Found ' + modified.length + ' locally modified FVS file(s) — backed up to ' + PATCHES_DIR_NAME + '/');
    for (const f of modified) {
      console.log('     ' + dim + f + reset);
    }
  }
  return modified;
}

/**
 * After install, report backed-up patches for user to reapply.
 */
function reportLocalPatches(configDir, runtime = 'claude') {
  const patchesDir = path.join(configDir, PATCHES_DIR_NAME);
  const metaPath = path.join(patchesDir, 'backup-meta.json');
  if (!fs.existsSync(metaPath)) return [];

  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return []; }

  if (meta.files && meta.files.length > 0) {
    const reapplyCommand = runtime === 'opencode'
      ? '/fvs-reapply-patches'
      : runtime === 'codex'
        ? '$fvs-reapply-patches'
        : '/fvs:reapply-patches';
    console.log('');
    console.log('  ' + yellow + 'Local patches detected' + reset + ' (from v' + meta.from_version + '):');
    for (const f of meta.files) {
      console.log('     ' + orange + f + reset);
    }
    console.log('');
    console.log('  Your modifications are saved in ' + orange + PATCHES_DIR_NAME + '/' + reset);
    console.log('  Run ' + orange + reapplyCommand + reset + ' to merge them into the new version.');
    console.log('  Or manually compare and merge the files.');
    console.log('');
  }
  return meta.files || [];
}

/**
 * Read the version field from the prior install manifest (if any).
 * Guarded the same way saveLocalPatches reads the manifest: existsSync gate
 * plus a try/return around JSON.parse, so a missing, old, or malformed/foreign
 * manifest can never throw and abort the install. Returns the prior
 * version string, or null when there is no prior install or the manifest is
 * unreadable.
 */
function readPriorManifestVersion(configDir) {
  const manifestPath = path.join(configDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest.version || null;
  } catch {
    return null;
  }
}

/**
 * One-time v1.3.x -> v2.0 migration notice. Fires ONLY when a prior
 * install manifest existed AND its version started with "1.3" — never on a
 * fresh install (no prior manifest) and never on a v2.x reinstall (version
 * does not start with "1.3"). Must be called with the version captured BEFORE
 * writeManifest() overwrites the manifest with the current version.
 *
 * Names the /fvs:plan -> /fvs:fc-plan rename, the removed lean-spec-port /
 * lean-proof-port commands, and the 4 removed legacy v1.0 agents. Deleted and
 * renamed commands/agents self-heal via the existing wipe-recopy and the
 * fvs-*.md pre-copy unlink — this helper adds no deletion surface.
 */
function reportV2Migration(priorVersion) {
  if (!priorVersion || !priorVersion.startsWith('1.3')) return false;
  console.log('');
  console.log('  ' + yellow + 'Upgrading FVS v' + priorVersion + ' -> v2.0' + reset + ' — what changed:');
  console.log('     ' + orange + '/fvs:plan' + reset + ' renamed to ' + orange + '/fvs:fc-plan' + reset + ' (clean break, no alias)');
  console.log('     Removed the cross-language port commands ' + dim + 'lean-spec-port' + reset + ' and ' + dim + 'lean-proof-port' + reset);
  console.log('     Removed 4 legacy v1.0 agents ' + dim + '(fvs-dependency-analyzer, fvs-code-reader,' + reset);
  console.log('     ' + dim + 'fvs-lean-spec-generator, fvs-lean-prover)' + reset);
  console.log('     New bundle routers: ' + dim + '/fvs:aeneas /fvs:fc /fvs:formalise /fvs:context /fvs:manage' + reset);
  console.log('     ' + dim + 'If you locally edited plan.md, it is backed up under its old name in' + reset);
  console.log('     ' + dim + PATCHES_DIR_NAME + '/ — merge it into fc-plan.md manually (no automatic rename).' + reset);
  console.log('');
  return true;
}

/**
 * Install to the specified directory for a specific runtime
 * @param {boolean} isGlobal - Whether to install globally or locally
 * @param {string} runtime - Target runtime ('claude', 'opencode', 'gemini')
 */
function install(isGlobal, runtime = 'claude') {
  const isOpencode = runtime === 'opencode';
  const isGemini = runtime === 'gemini';
  const isCodex = runtime === 'codex';
  const dirName = getDirName(runtime);
  const src = path.join(__dirname, '..');

  // Get the target directory based on runtime and install type
  const targetDir = isGlobal
    ? getGlobalDir(runtime, explicitConfigDir)
    : path.join(process.cwd(), dirName);

  const locationLabel = isGlobal
    ? targetDir.replace(os.homedir(), '~')
    : targetDir.replace(process.cwd(), '.');

  // Path prefix for file references in markdown content
  // For global installs: use full path
  // For local installs: use relative
  const pathPrefix = isGlobal
    ? `${targetDir}/`
    : `./${dirName}/`;

  let runtimeLabel = 'Claude Code';
  if (isOpencode) runtimeLabel = 'OpenCode';
  if (isGemini) runtimeLabel = 'Gemini';
  if (isCodex) runtimeLabel = 'Codex';

  console.log(`  Installing for ${orange}${runtimeLabel}${reset} to ${orange}${locationLabel}${reset}\n`);

  // Inform user about existing install of the other type (local overrides global)
  if (isGlobal) {
    const localVersionPath = path.join(process.cwd(), dirName, 'fv-skills', 'VERSION');
    if (fs.existsSync(localVersionPath)) {
      const localVer = fs.readFileSync(localVersionPath, 'utf8').trim();
      console.log(`  ${yellow}ℹ${reset} Local FVS install detected (v${localVer}) at ./${dirName}`);
      console.log(`    ${dim}Local install takes priority when running in this project${reset}\n`);
    }
  } else {
    const globalDir = getGlobalDir(runtime, explicitConfigDir);
    const globalVersionPath = path.join(globalDir, 'fv-skills', 'VERSION');
    if (fs.existsSync(globalVersionPath)) {
      const globalVer = fs.readFileSync(globalVersionPath, 'utf8').trim();
      console.log(`  ${yellow}ℹ${reset} Global FVS install detected (v${globalVer}) at ${globalDir.replace(os.homedir(), '~')}`);
      console.log(`    ${dim}This local install takes priority in this project${reset}\n`);
    }
  }

  // Track installation failures
  const failures = [];

  // Capture the prior install's manifest version BEFORE any wipe/recopy or
  // writeManifest() overwrites it — used for the one-time v1.3 -> v2.0 notice.
  const priorManifestVersion = readPriorManifestVersion(targetDir);

  // Save any locally modified FVS files before they get wiped
  saveLocalPatches(targetDir);

  // OpenCode uses 'command/' (singular) with flat structure
  // Codex uses 'skills/' with skill directories
  // Claude Code & Gemini use 'commands/' (plural) with nested structure
  if (isCodex) {
    // Codex: skill directories in skills/ (skills/fvs-help/SKILL.md)
    const skillsDir = path.join(targetDir, 'skills');
    const fvsSrc = path.join(src, 'commands', 'fvs');
    copyCommandsAsCodexSkills(fvsSrc, skillsDir, 'fvs', pathPrefix, runtime);
    const installedSkillNames = listCodexSkillNames(skillsDir);
    if (installedSkillNames.length > 0) {
      console.log(`  ${green}✓${reset} Installed ${installedSkillNames.length} skills to skills/`);
    } else {
      failures.push('skills/fvs-*');
    }

  } else if (isOpencode) {
    // OpenCode: flat structure in command/ directory
    const commandDir = path.join(targetDir, 'command');
    fs.mkdirSync(commandDir, { recursive: true });

    // Copy commands/fvs/*.md as command/fvs-*.md (flatten structure)
    const fvsSrc = path.join(src, 'commands', 'fvs');
    copyFlattenedCommands(fvsSrc, commandDir, 'fvs', pathPrefix, runtime);
    if (verifyInstalled(commandDir, 'command/fvs-*')) {
      const count = fs.readdirSync(commandDir).filter(f => f.startsWith('fvs-')).length;
      console.log(`  ${green}✓${reset} Installed ${count} commands to command/`);
    } else {
      failures.push('command/fvs-*');
    }
  } else {
    // Claude Code & Gemini: nested structure in commands/ directory
    const commandsDir = path.join(targetDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });

    const fvsSrc = path.join(src, 'commands', 'fvs');
    const fvsDest = path.join(commandsDir, 'fvs');
    copyWithPathReplacement(fvsSrc, fvsDest, pathPrefix, runtime, /* isCommand= */ true);
    if (verifyInstalled(fvsDest, 'commands/fvs')) {
      console.log(`  ${green}✓${reset} Installed commands/fvs`);
    } else {
      failures.push('commands/fvs');
    }
  }

  // Copy fv-skills content with path replacement
  // This recursively copies all subdirectories including:
  //   - references/, templates/, workflows/ (core FVS content)
  //   - upstream/aeneas/ (pinned upstream documentation snapshot + _sync-meta.json)
  // Scripts (scripts/) are copied separately (no path replacement needed)
  const skillSrc = path.join(src, 'fv-skills');
  const skillDest = path.join(targetDir, 'fv-skills');
  copyWithPathReplacement(skillSrc, skillDest, pathPrefix, runtime);
  if (verifyInstalled(skillDest, 'fv-skills')) {
    console.log(`  ${green}✓${reset} Installed fv-skills`);
  } else {
    failures.push('fv-skills');
  }

  // Copy agents to agents directory
  const agentsSrc = path.join(src, 'agents');
  if (fs.existsSync(agentsSrc)) {
    const agentsDest = path.join(targetDir, 'agents');
    fs.mkdirSync(agentsDest, { recursive: true });

    // Remove old FVS agents (fvs-*.md) before copying new ones
    for (const file of fs.readdirSync(agentsDest)) {
      if (file.startsWith('fvs-') && file.endsWith('.md')) {
        fs.unlinkSync(path.join(agentsDest, file));
      }
    }

    // Copy new agents
    const agentEntries = fs.readdirSync(agentsSrc, { withFileTypes: true });
    for (const entry of agentEntries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        let content = fs.readFileSync(path.join(agentsSrc, entry.name), 'utf8');
        // Replace ~/.claude/ and $HOME/.claude/ with runtime-appropriate paths
        content = content.replace(/~\/\.claude\//g, pathPrefix);
        content = content.replace(/\$HOME\/\.claude\//g, toHomePrefix(pathPrefix));
        // Convert frontmatter for runtime compatibility
        if (isOpencode) {
          content = convertClaudeToOpencodeFrontmatter(content);
        } else if (isCodex) {
          content = convertClaudeAgentToCodexAgent(content);
        } else if (isGemini) {
          content = convertClaudeToGeminiAgent(content);
        }
        fs.writeFileSync(path.join(agentsDest, entry.name), content);
      }
    }
    if (verifyInstalled(agentsDest, 'agents')) {
      console.log(`  ${green}✓${reset} Installed agents`);
    } else {
      failures.push('agents');
    }
  }

  // Copy scripts (Python tools like fvs-kb-query.py)
  const scriptsSrc = path.join(src, 'scripts');
  if (fs.existsSync(scriptsSrc)) {
    const scriptsDest = path.join(targetDir, 'scripts');
    fs.mkdirSync(scriptsDest, { recursive: true });

    const scriptEntries = fs.readdirSync(scriptsSrc, { withFileTypes: true });
    for (const entry of scriptEntries) {
      if (entry.isFile() && entry.name.startsWith('fvs-')) {
        fs.copyFileSync(path.join(scriptsSrc, entry.name), path.join(scriptsDest, entry.name));
      }
    }
    if (verifyInstalled(scriptsDest, 'scripts')) {
      console.log(`  ${green}✓${reset} Installed scripts`);
    } else {
      failures.push('scripts');
    }
  }

  // Write VERSION file
  const versionDest = path.join(targetDir, 'fv-skills', 'VERSION');
  fs.writeFileSync(versionDest, pkg.version);
  if (verifyFileInstalled(versionDest, 'VERSION')) {
    console.log(`  ${green}✓${reset} Wrote VERSION (${pkg.version})`);
  } else {
    failures.push('VERSION');
  }

  if (!isCodex) {
    // Write package.json to force CommonJS mode for FVS scripts
    // Prevents "require is not defined" errors when project has "type": "module"
    // Node.js walks up looking for package.json - this stops inheritance from project
    const pkgJsonDest = path.join(targetDir, 'package.json');
    fs.writeFileSync(pkgJsonDest, '{"type":"commonjs"}\n');
    console.log(`  ${green}✓${reset} Wrote package.json (CommonJS mode)`);

    // Copy hooks from dist/ (bundled with dependencies)
    // Template paths for the target runtime (replaces '.claude' with correct config dir)
    const hooksSrc = path.join(src, 'hooks', 'dist');
    if (fs.existsSync(hooksSrc)) {
      const hooksDest = path.join(targetDir, 'hooks');
      fs.mkdirSync(hooksDest, { recursive: true });
      const hookEntries = fs.readdirSync(hooksSrc);
      const configDirReplacement = getConfigDirFromHome(runtime, isGlobal);
      for (const entry of hookEntries) {
        const srcFile = path.join(hooksSrc, entry);
        if (fs.statSync(srcFile).isFile()) {
          const destFile = path.join(hooksDest, entry);
          // Template .js files to replace '.claude' with runtime-specific config dir
          if (entry.endsWith('.js')) {
            let content = fs.readFileSync(srcFile, 'utf8');
            content = content.replace(/'\.claude'/g, configDirReplacement);
            fs.writeFileSync(destFile, content);
          } else {
            fs.copyFileSync(srcFile, destFile);
          }
        }
      }
      if (verifyInstalled(hooksDest, 'hooks')) {
        console.log(`  ${green}✓${reset} Installed hooks (bundled)`);
      } else {
        failures.push('hooks');
      }
    }
  }

  if (failures.length > 0) {
    console.error(`\n  ${yellow}Installation incomplete!${reset} Failed: ${failures.join(', ')}`);
    process.exit(1);
  }

  // Write file manifest for future modification detection
  writeManifest(targetDir, runtime);
  console.log(`  ${green}✓${reset} Wrote file manifest (${MANIFEST_NAME})`);

  // Report any backed-up local patches
  reportLocalPatches(targetDir, runtime);

  // One-time v1.3.x -> v2.0 migration notice (fires only on that transition)
  reportV2Migration(priorManifestVersion);

  // Codex: generate config.toml and per-agent .toml files, register the
  // SessionStart hook in hooks.json, then return early.
  if (isCodex) {
    const agentCount = installCodexConfig(targetDir, agentsSrc);
    console.log(`  ${green}✓${reset} Generated config.toml with ${agentCount} agent roles`);
    console.log(`  ${green}✓${reset} Generated ${agentCount} agent .toml config files`);

    // Copy the update-check hook script (the only FVS hook with a Codex event
    // target) and register it as a SessionStart hook in hooks.json. The
    // statusline has no Codex surface and is not installed here.
    const codexHooksSrc = path.join(src, 'hooks', 'dist');
    const checkUpdateSrc = path.join(codexHooksSrc, 'fvs-check-update.js');
    if (fs.existsSync(checkUpdateSrc)) {
      const hooksDest = path.join(targetDir, 'hooks');
      fs.mkdirSync(hooksDest, { recursive: true });
      const configDirReplacement = getConfigDirFromHome(runtime, isGlobal);
      let hookContent = fs.readFileSync(checkUpdateSrc, 'utf8');
      hookContent = hookContent.replace(/'\.claude'/g, configDirReplacement);
      fs.writeFileSync(path.join(hooksDest, 'fvs-check-update.js'), hookContent);

      const codexNodeRunner = resolveCodexNodeRunner();
      if (!codexNodeRunner) {
        console.warn(`  ${yellow}⚠${reset}  Skipped Codex SessionStart hook — Node executable path unavailable.`);
      } else {
        const hookWrite = ensureCodexHooksJsonSessionStart(targetDir, {
          absoluteRunner: codexNodeRunner,
          platform: process.platform,
        });
        if (hookWrite.wrote) {
          console.log(`  ${green}✓${reset} Configured Codex SessionStart hook (hooks.json)`);
        } else {
          console.log(`  ${green}✓${reset} Verified Codex SessionStart hook (hooks.json)`);
        }
      }
    }

    return { settingsPath: null, settings: null, statuslineCommand: null, runtime };
  }

  // Configure statusline and hooks in settings.json
  // Gemini shares same hook system as Claude Code for now
  const settingsPath = path.join(targetDir, 'settings.json');
  const settings = readSettings(settingsPath);
  const statuslineCommand = isGlobal
    ? buildHookCommand(targetDir, 'fvs-statusline.js')
    : 'node ' + dirName + '/hooks/fvs-statusline.js';
  const updateCheckCommand = isGlobal
    ? buildHookCommand(targetDir, 'fvs-check-update.js')
    : 'node ' + dirName + '/hooks/fvs-check-update.js';

  // Enable experimental agents for Gemini CLI (required for custom sub-agents)
  if (isGemini) {
    if (!settings.experimental) {
      settings.experimental = {};
    }
    if (!settings.experimental.enableAgents) {
      settings.experimental.enableAgents = true;
      console.log(`  ${green}✓${reset} Enabled experimental agents`);
    }
  }

  // Configure SessionStart hook for update checking (skip for opencode)
  if (!isOpencode) {
    if (!settings.hooks) {
      settings.hooks = {};
    }
    if (!settings.hooks.SessionStart) {
      settings.hooks.SessionStart = [];
    }

    const hasFvsUpdateHook = settings.hooks.SessionStart.some(entry =>
      entry.hooks && entry.hooks.some(h => h.command && h.command.includes('fvs-check-update'))
    );

    if (!hasFvsUpdateHook) {
      settings.hooks.SessionStart.push({
        hooks: [
          {
            type: 'command',
            command: updateCheckCommand
          }
        ]
      });
      console.log(`  ${green}✓${reset} Configured update check hook`);
    }
  }

  return { settingsPath, settings, statuslineCommand, runtime };
}

/**
 * Apply statusline config, then print completion message
 */
function finishInstall(settingsPath, settings, statuslineCommand, shouldInstallStatusline, runtime = 'claude', isGlobal = true) {
  const isOpencode = runtime === 'opencode';
  const isCodex = runtime === 'codex';

  if (shouldInstallStatusline && !isOpencode && !isCodex) {
    settings.statusLine = {
      type: 'command',
      command: statuslineCommand
    };
    console.log(`  ${green}✓${reset} Configured statusline`);
  }

  // Write settings when runtime supports settings.json
  if (!isCodex) {
    writeSettings(settingsPath, settings);
  }

  // Configure OpenCode permissions
  if (isOpencode) {
    configureOpencodePermissions(isGlobal);
  }

  let program = 'Claude Code';
  if (runtime === 'opencode') program = 'OpenCode';
  if (runtime === 'gemini') program = 'Gemini';
  if (runtime === 'codex') program = 'Codex';

  let command = '/fvs:help';
  if (isOpencode) command = '/fvs-help';
  if (isCodex) command = '$fvs-help';

  console.log(`
  ${green}Done!${reset} Launch ${program} and run ${orange}${command}${reset}.
`);
}

/**
 * Handle statusline configuration with optional prompt
 */
function handleStatusline(settings, isGlobal, isInteractive, callback) {
  const hasExisting = settings.statusLine != null;

  if (!hasExisting) {
    callback(true);
    return;
  }

  // Detect GSD statusline
  const isGsdStatusline = settings.statusLine.command &&
    settings.statusLine.command.includes('gsd-statusline');
  if (isGsdStatusline) {
    if (isGlobal) {
      // Global: keep GSD's statusline to avoid overhead in non-FVS repos
      console.log(`  ${green}✓${reset} GSD statusline detected, keeping it.`);
      callback(false);
    } else {
      // Local: install FVS statusline (it delegates to GSD internally, appends FVS state)
      console.log(`  ${green}✓${reset} GSD statusline detected, FVS will wrap it locally.`);
      callback(true);
    }
    return;
  }

  if (forceStatusline) {
    callback(true);
    return;
  }

  if (!isInteractive) {
    console.log(`  ${yellow}⚠${reset} Skipping statusline (already configured)`);
    console.log(`    Use ${orange}--force-statusline${reset} to replace\n`);
    callback(false);
    return;
  }

  const existingCmd = settings.statusLine.command || settings.statusLine.url || '(custom)';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log(`
  ${yellow}⚠${reset} Existing statusline detected\n
  Your current statusline:
    ${dim}command: ${existingCmd}${reset}

  FVS includes a statusline showing:
    • Model name
    • Current task (from todo list)
    • Context window usage (color-coded)

  ${orange}1${reset}) Keep existing
  ${orange}2${reset}) Replace with FVS statusline
`);

  rl.question(`  Choice ${dim}[1]${reset}: `, (answer) => {
    rl.close();
    const choice = answer.trim() || '1';
    callback(choice === '2');
  });
}

/**
 * Prompt for runtime selection
 */
function promptRuntime(callback) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let answered = false;

  rl.on('close', () => {
    if (!answered) {
      answered = true;
      console.log(`\n  ${yellow}Installation cancelled${reset}\n`);
      process.exit(0);
    }
  });

  console.log(`  ${yellow}Which runtime(s) would you like to install for?${reset}\n\n  ${orange}1${reset}) Claude Code ${dim}(~/.claude)${reset}
  ${orange}2${reset}) OpenCode    ${dim}(~/.config/opencode)${reset} - open source, free models
  ${orange}3${reset}) Gemini      ${dim}(~/.gemini)${reset}
  ${orange}4${reset}) Codex       ${dim}(~/.codex)${reset}
  ${orange}5${reset}) All
`);

  rl.question(`  Choice ${dim}[1]${reset}: `, (answer) => {
    answered = true;
    rl.close();
    const choice = answer.trim() || '1';
    if (choice === '5') {
      callback(['claude', 'opencode', 'gemini', 'codex']);
    } else if (choice === '4') {
      callback(['codex']);
    } else if (choice === '3') {
      callback(['gemini']);
    } else if (choice === '2') {
      callback(['opencode']);
    } else {
      callback(['claude']);
    }
  });
}

/**
 * Prompt for install location
 */
function promptLocation(runtimes) {
  if (!process.stdin.isTTY) {
    console.log(`  ${yellow}Non-interactive terminal detected, defaulting to global install${reset}\n`);
    installAllRuntimes(runtimes, true, false);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let answered = false;

  rl.on('close', () => {
    if (!answered) {
      answered = true;
      console.log(`\n  ${yellow}Installation cancelled${reset}\n`);
      process.exit(0);
    }
  });

  const pathExamples = runtimes.map(r => {
    const globalPath = getGlobalDir(r, explicitConfigDir);
    return globalPath.replace(os.homedir(), '~');
  }).join(', ');

  const localExamples = runtimes.map(r => `./${getDirName(r)}`).join(', ');

  console.log(`  ${yellow}Where would you like to install?${reset}\n\n  ${orange}1${reset}) Global ${dim}(${pathExamples})${reset} - available in all projects
  ${orange}2${reset}) Local  ${dim}(${localExamples})${reset} - this project only
`);

  rl.question(`  Choice ${dim}[1]${reset}: `, (answer) => {
    answered = true;
    rl.close();
    const choice = answer.trim() || '1';
    const isGlobal = choice !== '2';
    installAllRuntimes(runtimes, isGlobal, true);
  });
}

/**
 * Install FVS for all selected runtimes
 */
function installAllRuntimes(runtimes, isGlobal, isInteractive) {
  const results = [];

  for (const runtime of runtimes) {
    const result = install(isGlobal, runtime);
    results.push(result);
  }

  // Handle statusline for Claude & Gemini (OpenCode uses themes)
  const claudeResult = results.find(r => r.runtime === 'claude');
  const geminiResult = results.find(r => r.runtime === 'gemini');

  if (claudeResult || geminiResult) {
    // Use whichever settings exist to check for existing statusline
    const primaryResult = claudeResult || geminiResult;

    handleStatusline(primaryResult.settings, isGlobal, isInteractive, (shouldInstallStatusline) => {
      if (claudeResult) {
        finishInstall(claudeResult.settingsPath, claudeResult.settings, claudeResult.statuslineCommand, shouldInstallStatusline, 'claude', isGlobal);
      }
      if (geminiResult) {
         finishInstall(geminiResult.settingsPath, geminiResult.settings, geminiResult.statuslineCommand, shouldInstallStatusline, 'gemini', isGlobal);
      }

      const opencodeResult = results.find(r => r.runtime === 'opencode');
      if (opencodeResult) {
        finishInstall(opencodeResult.settingsPath, opencodeResult.settings, opencodeResult.statuslineCommand, false, 'opencode', isGlobal);
      }

      const codexResult = results.find(r => r.runtime === 'codex');
      if (codexResult) {
        finishInstall(codexResult.settingsPath, codexResult.settings, codexResult.statuslineCommand, false, 'codex', isGlobal);
      }
    });
  } else {
    // Only OpenCode and/or Codex (no statusline runtimes)
    const opencodeResult = results.find(r => r.runtime === 'opencode');
    if (opencodeResult) {
      finishInstall(opencodeResult.settingsPath, opencodeResult.settings, opencodeResult.statuslineCommand, false, 'opencode', isGlobal);
    }

    const codexResult = results.find(r => r.runtime === 'codex');
    if (codexResult) {
      finishInstall(codexResult.settingsPath, codexResult.settings, codexResult.statuslineCommand, false, 'codex', isGlobal);
    }
  }
}

// Main logic
if (require.main === module) {
if (hasGlobal && hasLocal) {
  console.error(`  ${yellow}Cannot specify both --global and --local${reset}`);
  process.exit(1);
} else if (explicitConfigDir && hasLocal) {
  console.error(`  ${yellow}Cannot use --config-dir with --local${reset}`);
  process.exit(1);
} else if (hasUninstall) {
  if (!hasGlobal && !hasLocal) {
    console.error(`  ${yellow}--uninstall requires --global or --local${reset}`);
    process.exit(1);
  }
  const runtimes = selectedRuntimes.length > 0 ? selectedRuntimes : ['claude'];
  for (const runtime of runtimes) {
    uninstall(hasGlobal, runtime);
  }
} else if (selectedRuntimes.length > 0) {
  if (!hasGlobal && !hasLocal) {
    promptLocation(selectedRuntimes);
  } else {
    installAllRuntimes(selectedRuntimes, hasGlobal, false);
  }
} else if (hasGlobal || hasLocal) {
  // No runtime specified but location is — prompt for runtime
  if (!process.stdin.isTTY) {
    console.log(`  ${yellow}Non-interactive terminal detected, defaulting to Claude Code${reset}\n`);
    installAllRuntimes(['claude'], hasGlobal, false);
  } else {
    promptRuntime((runtimes) => {
      installAllRuntimes(runtimes, hasGlobal, true);
    });
  }
} else {
  // Interactive
  if (!process.stdin.isTTY) {
    console.log(`  ${yellow}Non-interactive terminal detected, defaulting to Claude Code global install${reset}\n`);
    installAllRuntimes(['claude'], true, false);
  } else {
    promptRuntime((runtimes) => {
      promptLocation(runtimes);
    });
  }
}
}

module.exports = {
  generateCodexConfigBlock,
  generateCodexAgentToml,
  getCodexSkillAdapterHeader,
  convertClaudeToCodexMarkdown,
  convertClaudeCommandToCodexSkill,
  convertClaudeAgentToCodexAgent,
  convertSlashCommandsToCodexSkillMentions,
  stripFvsFromCodexConfig,
  mergeCodexConfig,
  installCodexConfig,
  extractFrontmatterAndBody,
  extractFrontmatterField,
  toSingleLine,
  reconcileCodexHooksJsonEvent,
  reconcileCodexHooksJsonSessionStart,
  ensureCodexHooksJsonSessionStart,
  removeCodexHooksJsonSessionStart,
  buildCodexHookWindowsShimIR,
  rewriteLegacyCodexHookBlock,
  migrateCodexHooksMapFormat,
  ensureCodexHooksFeature,
  hasEnabledCodexHooksFeature,
  resolveCodexNodeRunner,
  FVS_CODEX_MARKER,
  CODEX_AGENT_SANDBOX,
  FVS_CODEX_AGENT_EFFORT,
  CODEX_HOOKS_FEATURE_KEY,
  CODEX_HOOKS_FEATURE_LEGACY_KEYS,
};
