---
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
its own 35 commands, workflows, references, templates, scripts, hooks and roles.

The functional-correctness (FC) track proceeds through understanding, specification,
fresh statement review and explicitly requested autonomous proof. Extracted-code
work first needs the project's actual source/translation prerequisites. The crypto
track proceeds through planning, fresh review, explicit execution, adversarial
evaluation and follow-up. Setup does not start either track or choose models.

Source artifact version: 2.3.9. This is not evidence that an npm version,
public tag, catalog pin or release is available. Public source: https://github.com/Beneficial-AI-Foundation/formal-verification-skills.
Native help source: https://github.com/Beneficial-AI-Foundation/formal-verification-skills/blob/main/commands/fvs/help.md.

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
| pi | complete local-source native package; personal or trusted project scope |
| claude | complete source installer --claude; --local or --global |
| opencode | complete source installer --opencode; --local or --global |
| antigravity | complete source installer --antigravity; --local or --global |
| codex | complete source installer --codex; --local or --global |

Choose ONE complete installation per runtime. Inspect existing alternate-source
identities and user/project scope before changing anything; channel switching
requires an explicit removal/setup choice, not stacking a plugin and direct install.

Claude native catalog commands are `claude plugin marketplace add Beneficial-AI-Foundation/plugins`
and `claude plugin install fvs@beneficial-ai-foundation`. Claude scopes are host-specific
user/project/local choices; confirm the installed client's actual scope interface.
Codex uses `codex plugin marketplace add Beneficial-AI-Foundation/plugins` then
`codex plugin add fvs@beneficial-ai-foundation`; do not transplant Claude's scope flags.
Catalog source: https://github.com/Beneficial-AI-Foundation/plugins.
A catalog route cannot promise a requested version until its actual source/catalog
pin contains it. Marketplace Markdown does not register specialist Codex agent roles;
check exact roles/settings and stop settings-dependent dispatch/writes if unavailable.
Installing this setup skill does not register FVS specialists.

An explicitly selected npm route uses package fv-skills-baif; Pi's exact source
notation for THIS source artifact version is `npm:fv-skills-baif@2.3.9`.
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
COMPLETE snapshot of https://github.com/Beneficial-AI-Foundation/formal-verification-skills at the accepted full SHA. The user selects
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

`node "$sourceRoot/scripts/build-hooks.js"`
`node "$sourceRoot/bin/install.js" "$runtimeFlag" "$scopeFlag"`

For non-Pi runtimeFlag, validate the chosen runtime against exactly
`--claude`, `--opencode`, `--antigravity`, `--codex`; never use --all. Scope is mandatory.
The hook build copies two pure Node hooks; this lane needs no npm install or npx.
Keep the complete source snapshot. Observe actual installed version, all 35
commands and resources, hook registrations and role/settings footprints. Discover
the nativeRoot from the actual channel's installation/resource metadata, not this
entry's physical/logical location or a guessed transferred path.

For Pi, qualify the existing native package manager first and preview its exact
local-source declaration/retention/scope effects. After permission use the retained
complete source directory: `pi install "$sourceRoot" --local` for the selected
trusted project, or `pi install "$sourceRoot"` for personal scope. This is a local
source directory, loaded without a registry dependency install, not a transported
skill directory. The explicit package.json pi.skills selects ONLY pi/skills, 35
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
Source-tested narrow diagnostics AND goal grants and the OpenCode converter fix and
Antigravity's YAML tool lists do not prove effective child permissions, inventory/schema exposure or live
feedback; these remain UNKNOWN. Live qualification follows a usable public release,
not setup-source delivery. Conditional IDE diagnostics are not goals. Report actual
unavailability; a required-live request stops. Compiler-only fallback needs that
request's warned explicit acceptance; final compiler/style/trust gates remain.
No automatic diagnostics/toolchain install or enforced readiness/write-promotion
system is delivered. Setup itself runs no Lean/compiler/diagnostics operation.

## Privacy

The skills CLI reports each install (contents below). Setting either DISABLE_TELEMETRY=1
or DO_NOT_TRACK=1 before invoking it disables that reporting. In inspected skills@1.7.1,
opting out also suppresses the external security-audit lookup; retain independent
source, tarball/dependency integrity and legitimacy checks. This entry adds no FVS
collector, private upload or custom telemetry metadata.

Official CLI/FAQ: https://www.skills.sh/docs/cli and https://www.skills.sh/docs/faq.
Privacy notice: https://vercel.com/legal/privacy-policy. Installation reporting can
send public repository/skill/agent/CLI/version/scope/path/CI metadata to
https://www.skills.sh/tele/t; the recipient sees the network source IP. No account,
machine ID, local path, file contents or hashes are sent. Retention,
anonymisation, notice and legal status are not independently verified. No legal
anonymity, harmlessness or EU exemption is promised. No private project, proof,
source or conversation should be uploaded, and no repeated/artificial adoption
counts should be manufactured. QA always disables telemetry.
Local source/contract/transport/resource checks prove neither native model behavior
nor public release/installation or an observed skills.sh listing.
