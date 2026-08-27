#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  extractFrontmatterAndBody,
  extractFrontmatterField,
  getCodexSkillAdapterHeader,
} = require('../bin/install.js');

const ROOT = path.resolve(__dirname, '..');
const COMMITTED_PLUGIN_ROOT = path.join(ROOT, 'plugins', 'fvs');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PACKAGE_JSON.version;
const REPOSITORY_URL = 'https://github.com/Beneficial-AI-Foundation/formal-verification-skills';
const MARKETPLACE_ID = 'beneficial-ai-foundation';
const PLUGIN_DESCRIPTION =
  'Formal verification workflows for Lean 4, including Rust extraction through Aeneas and paper or cryptography formalisation.';
const SCRIPT_FILES = [
  'fvs-codex-think.mjs',
  'fvs-kb-query.py',
  'fvs-lean-style-check.mjs',
  'fvs-probe-inventory.mjs',
];

function assertSafePluginRoot(pluginRoot) {
  const resolved = path.resolve(pluginRoot);
  const expectedName = path.join('plugins', 'fvs');
  if (resolved === ROOT || resolved === path.parse(resolved).root) {
    throw new Error(`Refusing to rebuild unsafe plugin path: ${resolved}`);
  }
  if (resolved === COMMITTED_PLUGIN_ROOT) return;
  if (!resolved.endsWith(`${path.sep}fvs`)) {
    throw new Error(`Temporary plugin output must end in ${JSON.stringify(expectedName)} or /fvs`);
  }
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
}

function writeJson(filePath, payload) {
  writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function copyFile(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, fs.statSync(source).mode);
}

function copyTextFile(source, destination) {
  const content = fs.readFileSync(source, 'utf8');
  writeText(destination, portablePluginPaths(content));
  fs.chmodSync(destination, fs.statSync(source).mode);
}

function portablePluginPaths(content) {
  return content
    .replace(/\$HOME\/\.claude\//g, '${CLAUDE_PLUGIN_ROOT}/')
    .replace(/~\/\.claude\//g, '${CLAUDE_PLUGIN_ROOT}/')
    .replace(/[ \t]+$/gm, '');
}

function copyTextTree(sourceRoot, destinationRoot, options = {}, relativeRoot = '') {
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    const relative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (options.exclude?.has(relative)) continue;
    if (entry.isDirectory()) {
      copyTextTree(source, destination, options, relative);
    } else if (entry.isFile()) {
      copyTextFile(source, destination);
    }
  }
}

function renderPluginFrontmatter(frontmatter, skillName) {
  const lines = frontmatter.split(/\r?\n/);
  let replacedName = false;
  const rendered = [];
  for (const line of lines) {
    if (/^name:\s*/.test(line)) {
      rendered.push(`name: ${skillName}`);
      replacedName = true;
      continue;
    }
    // `requires` is an FVS router registry used by the npm-installed command
    // surface, not a portable Agent Skills frontmatter field.
    if (/^requires:\s*/.test(line)) continue;
    rendered.push(line);
  }
  if (!replacedName) rendered.unshift(`name: ${skillName}`);
  return rendered.join('\n');
}

function pluginRuntimeHeader() {
  return `<plugin_runtime>\n- FVS is installed at \`\${CLAUDE_PLUGIN_ROOT}\`; hosts expand this placeholder in plugin skill content.\n- Resolve every bundled workflow, reference, template, script, and agent beneath that root.\n- When executing a shell snippet, quote the resolved plugin-root path even if an inherited example omits quotes.\n- Never write state into the plugin cache. Project state belongs under the user's current project (normally \`.formalising/\`).\n</plugin_runtime>`;
}

function renderPluginUpdateSkill() {
  return `---
name: update
description: Update the FVS marketplace plugin to its latest published version
allowed-tools: Bash, AskUserQuestion
---

${pluginRuntimeHeader()}

${getCodexSkillAdapterHeader('update', { pluginName: 'fvs' })}

<objective>
Refresh the installed FVS plugin from the Beneficial AI Foundation marketplace. Use only the command
for the host running this skill, obtain confirmation before changing the installation, and remind
the user to start a new session afterward.
</objective>

<process>
1. Read the installed version from \`\${CLAUDE_PLUGIN_ROOT}/fv-skills/VERSION\`.
2. Tell the user which host-specific update will run and ask for confirmation.
3. On Claude Code, run:

   \`claude plugin update fvs@${MARKETPLACE_ID}\`

4. On Codex, refresh the marketplace snapshot and reinstall from it:

   \`codex plugin marketplace upgrade ${MARKETPLACE_ID}\`
   \`codex plugin add fvs@${MARKETPLACE_ID}\`

5. Report the command output. Do not fall back to the npm installer: marketplace and npm installs
   are separate distribution channels.
6. Ask the user to start a new Claude Code or Codex session so the refreshed skills are loaded.
</process>
`;
}

function renderPluginReapplySkill() {
  return `---
name: reapply-patches
description: Explain how to preserve FVS customizations when using the marketplace plugin
---

${pluginRuntimeHeader()}

${getCodexSkillAdapterHeader('reapply-patches', { pluginName: 'fvs' })}

<objective>
Keep marketplace plugin installations immutable and direct custom FVS changes into a maintained
fork or a project-local skill override.
</objective>

<process>
Marketplace installs run from versioned caches, so the npm installer's \`fvs-local-patches\`
workflow does not apply. Never edit or merge files inside \`\${CLAUDE_PLUGIN_ROOT}\`.

If the user needs a persistent customization:

1. Fork \`Beneficial-AI-Foundation/formal-verification-skills\`.
2. Make the change in the canonical source files and run \`npm run build:plugin\`.
3. Add the fork as a marketplace and install \`fvs\` from that marketplace, or keep a narrowly
   scoped project-local skill that overrides the published behavior.
4. Start a new session after installing the customized plugin.
</process>
`;
}

function renderPluginSkill(sourcePath, skillName) {
  if (skillName === 'update') return renderPluginUpdateSkill();
  if (skillName === 'reapply-patches') return renderPluginReapplySkill();

  const raw = fs.readFileSync(sourcePath, 'utf8');
  const { frontmatter, body } = extractFrontmatterAndBody(raw);
  if (!frontmatter) throw new Error(`Missing frontmatter: ${sourcePath}`);
  const description = extractFrontmatterField(frontmatter, 'description');
  if (!description) throw new Error(`Missing description: ${sourcePath}`);

  let portableBody = portablePluginPaths(body);
  if (skillName === 'help') {
    portableBody = portableBody
      .replace('- Runs `npx fv-skills-baif` to update', '- Refreshes FVS from the configured plugin marketplace')
      .replace('- Run after `/fvs:update` if local patches were detected', '- Explains fork or project-local customization for immutable plugin installs');
  }

  return `---\n${renderPluginFrontmatter(frontmatter, skillName)}\n---\n\n${pluginRuntimeHeader()}\n\n${getCodexSkillAdapterHeader(skillName, { pluginName: 'fvs' })}\n\n${portableBody.trimStart()}`;
}

function renderClaudeManifest() {
  return {
    $schema: 'https://json.schemastore.org/claude-code-plugin-manifest.json',
    name: 'fvs',
    version: VERSION,
    description: PLUGIN_DESCRIPTION,
    author: { name: 'Beneficial AI Foundation' },
    homepage: REPOSITORY_URL,
    repository: REPOSITORY_URL,
    license: 'MIT',
    keywords: ['formal-verification', 'lean4', 'aeneas', 'rust', 'cryptography'],
    skills: './skills/',
  };
}

function renderCodexManifest() {
  return {
    name: 'fvs',
    version: VERSION,
    description: PLUGIN_DESCRIPTION,
    author: {
      name: 'Beneficial AI Foundation',
      url: REPOSITORY_URL,
    },
    homepage: REPOSITORY_URL,
    repository: REPOSITORY_URL,
    license: 'MIT',
    keywords: ['formal-verification', 'lean4', 'aeneas', 'rust', 'cryptography'],
    skills: './skills/',
    interface: {
      displayName: 'Formal Verification Skills',
      shortDescription: 'Lean 4 specification, proof, and audit workflows',
      longDescription: PLUGIN_DESCRIPTION,
      developerName: 'Beneficial AI Foundation',
      category: 'Productivity',
      capabilities: ['Interactive', 'Read', 'Write'],
      websiteURL: REPOSITORY_URL,
      defaultPrompt: [
        'Map this Lean project and plan the next verification target.',
        'Generate and prove a Lean specification for this function.',
        'Audit the sorry and axiom trust surface of this Lean target.',
      ],
      brandColor: '#F97316',
      logo: './assets/fvs.png',
    },
  };
}

function buildPlugin(pluginRoot) {
  assertSafePluginRoot(pluginRoot);
  fs.rmSync(pluginRoot, { recursive: true, force: true });
  fs.mkdirSync(pluginRoot, { recursive: true });

  writeJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), renderClaudeManifest());
  writeJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), renderCodexManifest());

  const commandsRoot = path.join(ROOT, 'commands', 'fvs');
  for (const entry of fs.readdirSync(commandsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const skillName = entry.name.slice(0, -3);
    const skillPath = path.join(pluginRoot, 'skills', skillName, 'SKILL.md');
    writeText(skillPath, renderPluginSkill(path.join(commandsRoot, entry.name), skillName));
  }

  copyTextTree(path.join(ROOT, 'agents'), path.join(pluginRoot, 'agents'));
  // The npm-specific updater probes mutable ~/.claude and ./.claude installs.
  // Marketplace installs are immutable and use the self-contained update skill.
  copyTextTree(path.join(ROOT, 'fv-skills'), path.join(pluginRoot, 'fv-skills'), {
    exclude: new Set(['workflows/update.md']),
  });
  for (const scriptName of SCRIPT_FILES) {
    copyTextFile(path.join(ROOT, 'scripts', scriptName), path.join(pluginRoot, 'scripts', scriptName));
  }
  copyFile(path.join(ROOT, 'assets', 'FVS.png'), path.join(pluginRoot, 'assets', 'fvs.png'));
  copyFile(path.join(ROOT, 'LICENSE'), path.join(pluginRoot, 'LICENSE'));
}

function treeHashes(root) {
  const result = new Map();
  function walk(current, relative) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(absolute, childRelative);
      else if (entry.isFile()) {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
        result.set(childRelative, digest);
      }
    }
  }
  walk(root, '');
  return result;
}

function compareTrees(expectedRoot, actualRoot) {
  if (!fs.existsSync(expectedRoot)) return ['committed plugin directory is missing'];
  const expected = treeHashes(expectedRoot);
  const actual = treeHashes(actualRoot);
  const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  return paths.filter((relative) => expected.get(relative) !== actual.get(relative));
}

function main() {
  const checkOnly = process.argv.includes('--check');
  if (!checkOnly) {
    buildPlugin(COMMITTED_PLUGIN_ROOT);
    console.log(`Built plugins/fvs for v${VERSION}`);
    return;
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-plugin-check-'));
  const generatedRoot = path.join(temporaryRoot, 'fvs');
  try {
    buildPlugin(generatedRoot);
    const differences = compareTrees(COMMITTED_PLUGIN_ROOT, generatedRoot);
    if (differences.length > 0) {
      console.error('Generated plugin is stale. Run: npm run build:plugin');
      for (const relative of differences.slice(0, 50)) console.error(`- ${relative}`);
      if (differences.length > 50) console.error(`- ...and ${differences.length - 50} more`);
      process.exitCode = 1;
      return;
    }
    console.log(`Plugin package is synchronized for v${VERSION}`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (require.main === module) main();

module.exports = {
  buildPlugin,
  portablePluginPaths,
  renderPluginSkill,
};
