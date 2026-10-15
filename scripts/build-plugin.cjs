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
  ALL_RUNTIMES,
  PI_PACKAGE_NAME,
  buildPiPackageSource,
} = require('../bin/install.js');

const ROOT = path.resolve(__dirname, '..');
const COMMITTED_PLUGIN_ROOT = path.join(ROOT, 'plugins', 'fvs');
const COMMITTED_PI_SKILLS_ROOT = path.join(ROOT, 'pi', 'skills');
const COMMITTED_SETUP_ROOT = path.join(ROOT, 'skills', 'fvs-setup');
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
  'fvs-model-external.mjs',
  'fvs-model-review.mjs',
  'fvs-probe-inventory.mjs',
  'fvs-probe-linux.mjs',
  'fvs-review-grounding.mjs',
  'fvs-spec-review.mjs',
];

function renderSetupSkill() {
  const nonPi = ALL_RUNTIMES.filter(runtime => runtime !== 'pi');
  const choices = ALL_RUNTIMES.map(runtime => `| ${runtime} | ${runtime === 'pi' ? 'complete local-source native package; personal or trusted project scope' : `complete source installer --${runtime}; --local or --global`} |`).join('\n');
  return `---
name: fvs-setup
description: Consent-gated native FVS installation and setup guidance, not standalone verification workflows
---

<!-- Generated native setup guidance. -->

## Scope

This is ONE setup entry, not a portable FVS workflow catalog. Installing or copying
this entry does not install FVS, register specialist roles, or grant setup permission.
It works by itself after copy, symlink, relocation, and from any working directory;
there are no adjacent scripts or resources to load. Never infer an FVS sourceRoot
or nativeRoot from this entry's parents. A complete native installation supplies
its own thirty commands, workflows, references, templates, scripts, hooks and roles.

The functional-correctness (FC) track proceeds through understanding, specification,
fresh statement review and explicitly requested interactive proof. Extracted-code
work first needs the project's actual source/translation prerequisites. The crypto
track proceeds through planning, fresh review, explicit execution, adversarial
evaluation and follow-up. Setup does not start either track or choose models.

Source artifact version: ${VERSION}. This is not evidence that an npm version,
public tag, catalog pin or release is available. Public source: ${REPOSITORY_URL}.
Native help source: ${REPOSITORY_URL}/blob/main/commands/fvs/help.md.

## Consent

Before any acquisition or installation, ask for the actual runtime, installation
channel, project/workspace directory or user scope, and whether to perform setup.
Use the host question tool if available; otherwise ask the same questions in plain
text and WAIT. Inspection consent is not installation consent. Copying this entry
alone never authorizes setup. Decline, cancel, undecided scope, missing permission,
unsupported runtime, unavailable tools, or unhonorable requested controls means
STOP with no changes; offer supported explicit choices, setup assistance, or cancel.

Preview the exact public repository and immutable full SHA/tag resolved to a full
SHA; requested and observed FVS/package version; retained complete source location;
qualified executable paths, exact commands and flags; chosen workspace directory;
native installation destination, profile/settings/config paths; existing-install
and local-patch effects; diagnostics preference and any separate permission needed.
Obtain explicit permission for those effects BEFORE executing any command below.
Do not silently stack channels, migrate/remove an existing install or substitute
latest/an older version for a requested unavailable version. A newer unpublished
request remains blocked until a version-matching immutable source or chosen channel
is independently available. Do not install/download tools implicitly.

## Runtime and channel choices

All existing native candidates remain available; an unsupported actual host gets
explicit supported alternatives or cancel, not a claimed generic native fallback:

| Runtime | Native source route |
|---|---|
${choices}

Choose ONE complete installation per runtime. Inspect existing alternate-source
identities and user/project scope before changing anything; channel switching
requires an explicit removal/setup choice, not stacking a plugin and direct install.

Claude native catalog commands are \`claude plugin marketplace add Beneficial-AI-Foundation/plugins\`
and \`claude plugin install fvs@${MARKETPLACE_ID}\`. Claude scopes are host-specific
user/project/local choices; confirm the installed client's actual scope interface.
Codex uses \`codex plugin marketplace add Beneficial-AI-Foundation/plugins\` then
\`codex plugin add fvs@${MARKETPLACE_ID}\`; do not transplant Claude's scope flags.
Catalog source: https://github.com/Beneficial-AI-Foundation/plugins.
A catalog route cannot promise a requested version until its actual source/catalog
pin contains it. Marketplace Markdown does not register specialist Codex agent roles;
check exact roles/settings and stop settings-dependent dispatch/writes if unavailable.
Installing this setup skill does not register FVS specialists.

An explicitly selected npm route uses package ${PI_PACKAGE_NAME}; Pi's exact source
notation for THIS source artifact version is \`${buildPiPackageSource(VERSION)}\`.
That notation is not publication evidence. Independently confirm the exact requested
registry version before choosing an npm command; a requested unpublished npm pin
stays blocked. Do not substitute latest or an older release. The source snapshot's
unified --pi path delegates to npm, NOT that snapshot. Use the complete local-source
Pi lane below instead when it is independently available and explicitly chosen.

## Stop conditions

Every one of these is a STOP with no changes: declined setup; missing runtime;
missing tool; missing setting; required-live without actual live access;
fresh-review missing; source/version mismatch; unpublished npm pin. Ask for an
explicit supported alternative, separately consented setup assistance, or cancel.
These are installed Markdown contract states, not proof of conversational enforcement
by an unobserved native agent. Static refusal assertions never claim a model complied.

## Complete source installation

The npm-independent source route uses an independently acquired and inspected
COMPLETE snapshot of ${REPOSITORY_URL} at the accepted full SHA. The user selects
its retained absolute sourceRoot; do not use the transported entry as that root.
First verify qualified Node/Git are already available, the immutable revision and
requested version match package.json AND fv-skills/VERSION, and complete commands,
agents, fv-skills, scripts and hook sources exist. Preview and consent to the exact
Git acquisition commands/source location before acquiring it. A missing immutable
snapshot or payload/version mismatch stops, rather than falling back to 2.3.6.

Only AFTER the consent barrier and independent complete-source verification, run
these commands using that retained absolute sourceRoot and chosen workspace as cwd.
The explained variable scopeFlag is exactly --local for that workspace, or --global
for the accepted user profile; never omit scope. Node is the verified executable:

\`node "$sourceRoot/scripts/build-hooks.js"\`
\`node "$sourceRoot/bin/install.js" "$runtimeFlag" "$scopeFlag"\`

For non-Pi runtimeFlag, validate the chosen runtime against exactly
${nonPi.map(runtime => `\`--${runtime}\``).join(', ')}; never use --all. Scope is mandatory.
The hook build copies two pure Node hooks; this lane needs no npm install or npx.
Keep the complete source snapshot. Observe actual installed version, all thirty
commands and resources, hook registrations and role/settings footprints. Discover
the nativeRoot from the actual channel's installation/resource metadata, not this
entry's physical/logical location or a guessed transferred path.

For Pi, qualify the existing native package manager first and preview its exact
local-source declaration/retention/scope effects. After permission use the retained
complete source directory: \`pi install "$sourceRoot" --local\` for the selected
trusted project, or \`pi install "$sourceRoot"\` for personal scope. This is a local
source directory, loaded without a registry dependency install, not a transported
skill directory. The explicit package.json pi.skills selects ONLY pi/skills, thirty
native skills, not this setup entry. Keep sourceRoot at its verified location.
Project declarations require project trust; review it explicitly. Project identities
normally take precedence over personal entries; inspect both and do not silently
remove/migrate an existing alternate source or scope. Observe the actual native
resolver's packageRoot/sourceRoot metadata and every selected physical resource.
Pi Git refs are alternatives ONLY after exact manager/dependency/lifecycle/source-root
qualification with immutable version-matching refs; they can install dependencies,
so do not silently fall back to Git/npm or run an unqualified install.

Reload/start a new session afterward. Invoke only that channel's actual help entry when the user
requests it (Claude: /fvs:help); do not start proof or execution from setup.

## Native controls

The complete native installation owns role, tool, model, effort and sandbox checks.
Unavailable exact roles/settings or required fresh reviewers stop settings-dependent
dispatch/writes; a generic full-role prompt is not native identity/settings parity.
Preserve automatic adversarial FC/crypto review, author-owned triage and explicit
approval after revisions. Never perform required fresh review inline; failed,
skipped or pending review is not approval and never starts proof/execution.

Strongly recommend existing lean-lsp-mcp: https://github.com/oOo0oOo/lean-lsp-mcp.
Source-tested narrow diagnostics AND goal grants and the Gemini/OpenCode converter
fix do not prove effective child permissions, inventory/schema exposure or live
feedback; these remain UNKNOWN. Live qualification follows a usable public release,
not setup-source delivery. Conditional IDE diagnostics are not goals. Report actual
unavailability; a required-live request stops. Compiler-only fallback needs that
request's warned explicit acceptance; final compiler/style/trust gates remain.
No automatic diagnostics/toolchain install or enforced readiness/write-promotion
system is delivered. Setup itself runs no Lean/compiler/diagnostics operation.

## Privacy

Installation analytics can occur BEFORE any setup conversation. Public instructions
and automation must establish BOTH DISABLE_TELEMETRY=1 and DO_NOT_TRACK=1 BEFORE
invoking the skills CLI. Later setup consent cannot retroactively consent to those
requests. In inspected skills@1.7.1, these opt-outs also suppress external security-
audit lookup; retain independent source, tarball/dependency integrity and legitimacy
checks. This entry adds no FVS collector, private upload or custom telemetry metadata.

Official CLI/FAQ: https://www.skills.sh/docs/cli and https://www.skills.sh/docs/faq.
Privacy notice: https://vercel.com/legal/privacy-policy. Installation reporting can
send public repository/skill/agent/CLI/version/scope/path/CI metadata to
https://www.skills.sh/tele/t; the recipient sees the network source IP. Retention,
anonymisation, notice and legal status are not independently verified. No legal
anonymity, harmlessness or EU exemption is promised. No private project, proof,
source or conversation should be uploaded, and no repeated/artificial adoption
counts should be manufactured. QA always disables telemetry. Maintainer choice
about ONE genuine reporting-enabled public installation after validated release
is a separate owner gate, not consent for all users; this entry does not opt in.
Local source/contract/transport/resource checks prove neither native model behavior
nor public release/installation or an observed skills.sh listing.
`;
}

function buildSetupSkill(setupRoot) {
  const resolved = path.resolve(setupRoot);
  if (resolved === ROOT || resolved === path.parse(resolved).root) {
    throw new Error(`Refusing unsafe setup path: ${resolved}`);
  }
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (!fs.existsSync(current) && !fs.lstatSync(path.dirname(current)).isSymbolicLink()) {
      // Missing suffixes are created only after every existing ancestor is checked.
      break;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Symlink/non-directory setup ancestor: ${current}`);
  }
  if (!resolved.endsWith(`${path.sep}skills${path.sep}fvs-setup`)) {
    throw new Error('Setup output must end in skills/fvs-setup');
  }
  if (fs.existsSync(resolved)) {
    const directory = fs.lstatSync(resolved);
    if (process.getuid && directory.uid !== process.getuid()) throw new Error('Unowned setup output');
    for (const name of fs.readdirSync(resolved)) {
      if (name !== 'SKILL.md') throw new Error(`Unknown setup output file: ${name}`);
      const file = path.join(resolved, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
          (process.getuid && stat.uid !== process.getuid()) ||
          !fs.readFileSync(file, 'utf8').includes('<!-- Generated native setup guidance. -->')) {
        throw new Error('Unexpected or unowned setup SKILL.md');
      }
    }
  }
  writeText(path.join(resolved, 'SKILL.md'), renderSetupSkill());
}

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

function portablePiPaths(content) {
  return content
    .replace(/@\$HOME\/\.claude\//g, '@../../../')
    .replace(/@~\/\.claude\//g, '@../../../')
    .replace(/\$HOME\/\.claude\//g, '../../../')
    .replace(/~\/\.claude\//g, '../../../')
    .replace(/\.\/\.claude\//g, '../../../')
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

function piRuntimeHeader() {
  return `<pi_package_runtime>\n- This skill lives under \`pi/skills/<name>/SKILL.md\`; the FVS package root is \`../../..\` relative to its directory.\n- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.\n- Agent role instructions live under \`../../../agents/\`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.\n- Use Pi's structured question tool when available; otherwise ask the same question in plain text.\n- Never write state into the managed package. Project state belongs under the user's current project (normally \`.formalising/\`).\n</pi_package_runtime>`;
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

function renderPiUpdateSkill() {
  return `---
name: fvs-update
description: Update the installed FVS Pi package to its latest npm release
---

${piRuntimeHeader()}

<objective>
Update the managed FVS Pi package without modifying its installed files directly.
</objective>

<process>
1. Read the installed version from \`../../../fv-skills/VERSION\`, resolving it against this skill directory.
2. Run \`npm view fv-skills-baif version\` and report whether an update is available.
3. If an update is available, summarize its changelog entry and ask for confirmation.
4. On confirmation, run \`pi update npm:fv-skills-baif\`.
5. Report the result and ask the user to run \`/reload\` or start a new Pi session.
</process>
`;
}

function renderPiReapplySkill() {
  return `---
name: fvs-reapply-patches
description: Explain how to preserve FVS customizations when using the managed Pi package
---

${piRuntimeHeader()}

<objective>
Keep the managed Pi package immutable and direct custom FVS changes into a maintained fork or a project-local skill override.
</objective>

<process>
The npm installer's \`fvs-local-patches\` workflow does not apply to a managed Pi package. Never edit files in Pi's package cache.

If the user needs a persistent customization:

1. Fork \`Beneficial-AI-Foundation/formal-verification-skills\`.
2. Make and test the change in the canonical source files.
3. Install the fork with \`pi install git:github.com/<owner>/formal-verification-skills@<ref>\`, or keep a narrowly scoped project-local skill override.
4. Run \`/reload\` or start a new Pi session.
</process>
`;
}

function renderPiSkill(sourcePath, skillName) {
  if (skillName === 'update') return renderPiUpdateSkill();
  if (skillName === 'reapply-patches') return renderPiReapplySkill();

  const raw = fs.readFileSync(sourcePath, 'utf8');
  const { frontmatter, body } = extractFrontmatterAndBody(raw);
  if (!frontmatter) throw new Error(`Missing frontmatter: ${sourcePath}`);
  const description = extractFrontmatterField(frontmatter, 'description');
  if (!description) throw new Error(`Missing description: ${sourcePath}`);

  let portableBody = body;
  if (skillName === 'help') {
    portableBody = portableBody
      .replace(/\/fvs:([a-z0-9-]+)/g, '/skill:fvs-$1')
      .replace('- Runs `npx fv-skills-baif` to update', '- Runs `pi update npm:fv-skills-baif` to update')
      .replace('- Detects backed-up patches from `fvs-local-patches/` directory', '- Explains fork or project-local overrides for managed Pi packages')
      .replace('- Merges user modifications into newly installed version', '- Keeps package-managed files immutable')
      .replace('- Handles conflicts with user input', '- Avoids update-time merge conflicts')
      .replace('- Run after `/skill:fvs-update` if local patches were detected', '- Use before creating a persistent customization')
      .replace('~/.claude/                   # Installed FVS content (global)', 'Pi package root              # Managed FVS content')
      .replace('Inspect `~/.claude/fv-skills/references/`', 'Inspect the package\'s `fv-skills/references/`');
  }
  portableBody = portablePiPaths(portableBody);

  return `---\nname: fvs-${skillName}\ndescription: ${description}\n---\n\n${piRuntimeHeader()}\n\n${portableBody.trimStart()}`;
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

function assertSafePiSkillsRoot(piSkillsRoot) {
  const resolved = path.resolve(piSkillsRoot);
  if (resolved === ROOT || resolved === path.parse(resolved).root) {
    throw new Error(`Refusing to rebuild unsafe Pi skills path: ${resolved}`);
  }
  if (resolved !== COMMITTED_PI_SKILLS_ROOT && !resolved.endsWith(`${path.sep}pi${path.sep}skills`)) {
    throw new Error(`Pi skills output must end in ${path.join('pi', 'skills')}`);
  }
}

function buildPiSkills(piSkillsRoot) {
  assertSafePiSkillsRoot(piSkillsRoot);
  fs.rmSync(piSkillsRoot, { recursive: true, force: true });
  fs.mkdirSync(piSkillsRoot, { recursive: true });

  const commandsRoot = path.join(ROOT, 'commands', 'fvs');
  for (const entry of fs.readdirSync(commandsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const skillName = entry.name.slice(0, -3);
    const skillPath = path.join(piSkillsRoot, `fvs-${skillName}`, 'SKILL.md');
    writeText(skillPath, renderPiSkill(path.join(commandsRoot, entry.name), skillName));
  }
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
    buildPiSkills(COMMITTED_PI_SKILLS_ROOT);
    buildSetupSkill(COMMITTED_SETUP_ROOT);
    console.log(`Built plugins/fvs, pi/skills and skills/fvs-setup for v${VERSION}`);
    return;
  }

  // The setup builder refuses symlinked ancestors, and macOS's default TMPDIR sits under /var.
  const temporaryRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-plugin-check-'));
  const generatedPluginRoot = path.join(temporaryRoot, 'fvs');
  const generatedPiSkillsRoot = path.join(temporaryRoot, 'pi', 'skills');
  const generatedSetupRoot = path.join(temporaryRoot, 'skills', 'fvs-setup');
  try {
    buildPlugin(generatedPluginRoot);
    buildPiSkills(generatedPiSkillsRoot);
    buildSetupSkill(generatedSetupRoot);
    const differences = [
      ...compareTrees(COMMITTED_PLUGIN_ROOT, generatedPluginRoot).map((relative) => `plugins/fvs/${relative}`),
      ...compareTrees(COMMITTED_PI_SKILLS_ROOT, generatedPiSkillsRoot).map((relative) => `pi/skills/${relative}`),
      ...(fs.existsSync(COMMITTED_SETUP_ROOT) ? compareTrees(COMMITTED_SETUP_ROOT, generatedSetupRoot) : ['SKILL.md missing'])
        .map((relative) => `skills/fvs-setup/${relative}`),
    ];
    if (differences.length > 0) {
      console.error('Generated packages are stale. Run: npm run build:plugin');
      for (const relative of differences.slice(0, 50)) console.error(`- ${relative}`);
      if (differences.length > 50) console.error(`- ...and ${differences.length - 50} more`);
      process.exitCode = 1;
      return;
    }
    console.log(`Plugin, Pi and setup packages are synchronized for v${VERSION}`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (require.main === module) main();

module.exports = {
  buildSetupSkill,
  renderSetupSkill,
  buildPiSkills,
  buildPlugin,
  portablePiPaths,
  portablePluginPaths,
  renderPiSkill,
  renderPluginSkill,
};
