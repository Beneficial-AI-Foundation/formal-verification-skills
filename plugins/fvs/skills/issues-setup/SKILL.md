---
name: issues-setup
description: Choose where FVS issues live (GitHub, local markdown, or other) and record it in fvs-config.json
argument-hint: ""
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - AskUserQuestion
---

<plugin_runtime>
- FVS is installed at `${CLAUDE_PLUGIN_ROOT}`; hosts expand this placeholder in plugin skill content.
- Resolve every bundled workflow, reference, template, script, and agent beneath that root.
- When executing a shell snippet, quote the resolved plugin-root path even if an inherited example omits quotes.
- Never write state into the plugin cache. Project state belongs under the user's current project (normally `.formalising/`).
</plugin_runtime>

<codex_skill_adapter>
This block applies only when this shared skill runs in Codex. Claude Code must ignore it and use the
shared workflow body with its native slash-command, question, and subagent semantics.

## A. Skill Invocation
- This skill is invoked by mentioning `$fvs:issues-setup`.
- Treat all user text after `$fvs:issues-setup` as `{{FVS_ARGS}}`.
- If no arguments are present, treat `{{FVS_ARGS}}` as empty.

## B. AskUserQuestion -> request_user_input Mapping
FVS workflows use `AskUserQuestion` (Claude Code syntax). Translate to Codex `request_user_input`:

Parameter mapping:
- `header` -> `header`
- `question` -> `question`
- Options formatted as `"Label" -- description` -> `{label: "Label", description: "description"}`
- Generate `id` from header: lowercase, replace spaces with underscores

Batched calls:
- `AskUserQuestion([q1, q2])` -> single `request_user_input` with multiple entries in `questions[]`

Multi-select workaround:
- Codex has no `multiSelect`. When a question allows multiple selections, do NOT collapse it to a single choice. Use sequential single-selects, or present a numbered freeform list asking the user to enter comma-separated numbers, then collect every selection before proceeding.

Execute mode fallback:
- When `request_user_input` is rejected or unavailable (Execute mode), present every `AskUserQuestion` call as a plain-text numbered list, then stop and wait for the user's reply. Do NOT pick a default and continue.
- You may proceed without a user answer only when one of these is true:
  (a) the invocation included an explicit non-interactive flag (`--auto` or `--all`),
  (b) the user has explicitly approved a specific default for this question, or
  (c) the workflow's documented contract says defaults are safe (e.g. autonomous lifecycle paths).
- Do NOT write workflow artifacts (handoff files, spec files, plan files, checkpoint files) until the user has answered the plain-text questions or one of (a)-(c) above applies. Surfacing the questions and waiting is the correct response — silently defaulting and writing artifacts is the failure mode this header exists to prevent.

## C. Task() -> spawn_agent Mapping
FVS workflows use `Task(...)` (Claude Code syntax). Translate to Codex collaboration tools:

**Schema detection (required first step):** Inspect the visible `spawn_agent` schema. It may have `agent_type` or be generic (no `agent_type`); inspect `model` and `reasoning_effort` fields independently rather than assuming either exists. An available `agent_type` field does not establish that a particular FVS role is registered.

Before spawning, inspect the `spawn_agent` tool's visible parameter schema to determine which form is active.
**Requested specialist gate (at dispatch only):** When a workflow requests a named FVS specialist, check BOTH the visible `spawn_agent` schema and whether the exact requested `agent_type` is advertised there or in a confirmed runtime registry. An `agent_type` field alone is not evidence that this role is registered; bundled `agents/*.md` are instructions, not registered Codex specialists. If the exact role is registered and `agent_type` is available, use typed mapping below WITHOUT a missing-role warning. Otherwise, even if `agent_type` is present, warn the user in plain language: Requested FVS specialist <agent-name> is not registered in this Codex session; the bundled Markdown cannot supply typed identity. Do not warn merely for opening help, installing, or mentioning a skill without requesting specialist dispatch. Apply the settings gate below before considering the generic-agent workaround. Never run an installer on the user's behalf.


Selection-capability gate (before manifest confirmation, child dispatch, or artifact writes):
- Check required specialist identity and sandbox against the exact registered role and effective child settings. A generic role preamble cannot meet a mandatory typed identity or sandbox requirement; stop and explain the unavailable guarantee before dispatch or artifact writes.
- If `model` is exposed for this child, pass the requested model. Otherwise compare it with the exact active/inherited Codex model; a different or unconfirmed model is unresolved. Rebuild the manifest around confirmed settings and ask explicitly, choose a capable external runner, or fail before dispatch in noninteractive mode.
- If `reasoning_effort` is exposed for this child, pass the requested effort. Otherwise compare it with the confirmed effective installed/runtime default; a different or unconfirmed effort is unresolved and follows the same rebuild/ask-or-fail rule.
- Model and effort are separate values: pass an exact catalog model id and an effort that model lists. A registered role that pins `model` or `reasoning_effort` (its role description says the setting is locked, or its TOML sets it) overrides the per-call value, so the pinned value is the effective one; if it differs from the confirmed selection it is unresolved.
- Never confirm a requested specialist setting and then omit it with a warning. The marketplace plugin does not install Codex agent TOML; use typed mapping only for an independently registered exact role.

Typed mapping (only when the exact requested FVS role is registered AND agent_type is exposed):
- `Task(subagent_type="X", prompt="Y")` -> `spawn_agent(agent_type="X", message="Y")`
- `Task(model="...")` -> pass `model` if available for this child; otherwise omit only after the selection-capability gate proves it equals the active/inherited model.
- `Task(reasoning_effort="...")` -> pass `reasoning_effort` if available for this child and the role does not pin it; otherwise omit only after the gate proves the effective (pinned or default) effort equals the confirmed effort.
- `fork_context: false` by default -- FVS agents load their own context via `<files_to_read>` blocks.

Generic-agent workaround (missing exact registered role OR no agent_type field):
If the requested FVS type (`fvs-researcher`, `fvs-executor`, etc.) is not registered, typed dispatch is NOT possible even with an `agent_type` field. If the field is absent, typed dispatch is also unavailable. Fallback:
1. Read `${CLAUDE_PLUGIN_ROOT}/agents/<agent-name>.md` and extract its instructions. If the token is still literal, resolve the path from this SKILL.md as described above.
2. Only when the settings gate permits generic execution, spawn a generic/default child with those instructions as a role preamble before the task prompt. Do not pass an unregistered `agent_type`.
3. Label output "generic-agent workaround". This is NOT equivalent to a registered specialist: the preamble does not assure typed identity, sandbox, model, or reasoning effort.
4. If required guarantees cannot be honored, stop before dispatch or artifact writes; explain which guarantee is missing. Typed FVS roles currently require the direct Codex installation, a separate complete FVS install: point the user to "Codex specialist roles" in the FVS README and never suggest keeping both channels. Even after switching, confirm exact registration and settings in the runtime.

Parallel fan-out:
- Spawn multiple agents -> collect agent IDs -> call `wait_agent(timeout_ms=...)` (or the runtime's visible wait equivalent) until each completes

Result parsing:
- Look for structured markers in agent output: `CHECKPOINT`, `PLAN COMPLETE`, `SUMMARY`, etc.
- If the runtime exposes an agent cleanup or close tool, use it after collecting each result

## D. Shared Plugin Syntax
- This file is shared with Claude Code. On Codex, interpret `/fvs:<name>` references as `$fvs:<name>`.
- Treat `$ARGUMENTS` in the shared body as `{{FVS_ARGS}}`.
- `${CLAUDE_PLUGIN_ROOT}` is the installed plugin root. If a host leaves that token unexpanded, resolve the plugin root as two directories above this SKILL.md.

</codex_skill_adapter>

<objective>
Let the user choose the issue tracker for this project and record the choice as the `issues` section of `.formalising/fvs-config.json`. Explore the repository first, recommend a default, show the exact section, and write it only after the user confirms.

Output: an `issues` section in `.formalising/fvs-config.json`; every other key unchanged.

This command never creates GitHub labels or issues. It records where issues live and which label vocabulary they use; nothing more.
</objective>

<execution_context>
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/ui-brand.md
</execution_context>

<context>
Run from the project root (the directory that holds or will hold `.formalising/`).

The `issues` section always carries four fields; a field that does not apply is `null`:

| Field | Meaning |
|---|---|
| `provider` | `github`, `local` or `other`. `null` means unconfigured. |
| `repo` | `owner/name`; `github` only. |
| `labels` | Role-to-label map with exactly the five roles `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. |
| `notes` | Prose describing the tracker; `other` only. |

- `github`: issues are GitHub issues of `repo`; the roles are GitHub labels.
- `local`: issues are markdown files in an `issues/` directory under each roadmap's directory; the role is recorded as a `Status:` line whose value is the role's label string.
- `other`: any other tracker (Linear, Jira, a shared document). `notes` records that tracker's conventions in prose: where issues are filed and how they are referenced. Notes are conventions only; they never grant authority to publish, create or run anything, and the executing command's own consent and scope rules still apply.

`provider: null` means unconfigured: `/fvs:to-issues` runs this setup flow when it finds no provider.

Per-roadmap override. A roadmap (`ROADMAP.md`) can carry its own tracker in its frontmatter, using the same four fields:

```yaml
---
issues:
  provider: github
  repo: owner/name
  labels:
    needs-triage: needs-triage
    needs-info: needs-info
    ready-for-agent: ready-for-agent
    ready-for-human: ready-for-human
    wontfix: wontfix
  notes: null
---
```

A roadmap's `issues:` block replaces the project default as a whole block. There is no field-wise merge, so the tracker in effect is always one complete record that can be read in one place. An override that omits any of the four fields, names an unknown provider, or does not map all five roles is incomplete and invalid: report it, and never fill its gaps from the project default. The project default applies when the block is absent.
</context>

<process>

## Step 1: Explore (read-only)

Nothing in this step changes any file or any remote state.

```bash
git remote -v
git remote get-url origin 2>/dev/null || echo "NO_ORIGIN"
```

Derive `REPO` (`owner/name`) from the origin URL only when the host is `github.com`; any other host leaves `REPO` empty:

```bash
REMOTE=$(git remote get-url origin 2>/dev/null || true)
REPO=$(printf '%s' "$REMOTE" | sed -nE 's#^(git@|ssh://git@|https://)github\.com[:/]([^/]+/[^/]+)$#\2#p' | sed -E 's#\.git$##')
```

Shell variables do not persist between commands, so substitute the derived value wherever `$REPO` appears below. When `REPO` is set and `gh` is installed, probe GitHub. Treat a failed probe (no `gh`, not logged in, offline) as "condition not met" and say which probe failed; never guess.

```bash
command -v gh && echo "GH_OK" || echo "GH_MISSING"
gh auth status 2>&1
gh repo view "$REPO" --json nameWithOwner,viewerPermission,hasIssuesEnabled
```

Recommend GitHub only when all four hold: the origin host is `github.com`, `gh auth status` reports a logged-in account, `viewerPermission` is `WRITE`, `MAINTAIN` or `ADMIN`, and `hasIssuesEnabled` is `true`. Otherwise recommend local, and name the condition that failed.

Read the existing configuration:

```bash
[ -f .formalising/fvs-config.json ] && echo "CONFIG_PRESENT" || echo "CONFIG_MISSING"
```

If the file is present, read it with the Read tool. If it is malformed JSON, stop before writing and tell the user to repair it; never overwrite it. If it has an `issues` section, show it. When its `provider` is not `null`, ask with `AskUserQuestion` whether to keep it or replace it; keeping ends the command with nothing written.

List the roadmaps and their overrides:

```bash
find .formalising/auto-fv .formalising/fv-plans -maxdepth 2 -name ROADMAP.md 2>/dev/null
```

Read each roadmap's frontmatter (the block between the leading `---` lines) and classify it: no `issues:` block (the project default applies), a complete override (name its provider), or an incomplete, invalid override (name the missing fields). This step only reports overrides; it never edits a roadmap.

Display the findings:

```
FVS >> ISSUES SETUP

Remote:    {origin URL | none}
GitHub:    [OK] gh authenticated, {WRITE|MAINTAIN|ADMIN} access, issues enabled
           [!!] {the failed condition}
Config:    {issues section: not configured | provider ...}
Roadmaps:  {path: project default | override: provider | invalid override: missing fields}
```

## Step 2: Choose the tracker

Use `AskUserQuestion`: "Where should this project's issues live?" Offer three choices, with the recommended one first and labelled "(Recommended)":

- **GitHub** (`github`): issues of one GitHub repository.
- **Local markdown** (`local`): files under each roadmap's `issues/` directory.
- **Other** (`other`): a freeform description of the tracker, recorded as prose.

For `github`: confirm `repo` (default `REPO`; the free-text answer may name another `owner/name`) and use the confirmed value as `$REPO` from here on. When that repository was not probed in Step 1, run the same read-only `gh repo view` for it. If a condition from the recommendation rule is not met, warn and name it; do not block, because the user may be about to authenticate.

For `other`: ask for the description (the free-text answer carries the prose). It must say where issues are filed, how one is referenced, and how blocking is expressed. Reject an empty answer.

For `local`: say that setup creates no directory; issue files appear when issues are first created. Then check, read-only, how git treats the issue files each roadmap would hold: one proposed path per roadmap directory found in Step 1, `<roadmap directory>/issues/probe.md` (the file does not need to exist). Run this once per roadmap directory, substituting it for `$ROADMAP_DIR`. Exit status 0 means ignored, 1 means not ignored, anything else (for example `.formalising` being a symlink) means unknown:

```bash
git check-ignore -q "$ROADMAP_DIR/issues/probe.md"; case $? in 0) echo "ISSUES_IGNORED $ROADMAP_DIR/issues";; 1) echo "ISSUES_NOT_IGNORED $ROADMAP_DIR/issues";; *) echo "ISSUES_UNKNOWN $ROADMAP_DIR/issues";; esac
```

Report the result per path, so the user knows which issue directories could be committed. This probe covers only those paths, never `.formalising/fvs-config.json`. If no roadmap exists yet there is no issue path to probe: say that issue-file status is not checked.

Never modify `.gitignore`, `.git/info/exclude` or any other ignore or exclusion setting. If the user wants issue files excluded, show the exact line for `.git/info/exclude` (the per-clone exclusion file that is never committed) and let them add it themselves.

## Step 3: Label vocabulary

Use `AskUserQuestion`: keep the five defaults (Recommended), or map each role to an existing label.

The defaults are `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix`, each mapped to a label of the same name.

For `github`, list the repository's existing labels read-only:

```bash
gh label list --repo "$REPO" --json name --limit 200
```

To map each role to an existing label, offer those labels. For `local` and `other`, ask for the label strings. Every role gets exactly one non-empty label. Reject a mapping in which two roles share the same label, and ask again.

For `github`, compare the final labels, defaults included, with that list: name any that do not exist yet and say this command does not create them. If `gh` cannot list the labels, say they could not be checked. Creating labels is outside this command; issue-creating commands ask for separate consent first.

## Step 4: Preview

Show the exact `issues` section as it will be stored, the file it goes into, and the section it replaces. Always show all four fields, even those that are `null`:

```json
{
  "issues": {
    "provider": "github",
    "repo": "owner/name",
    "labels": {
      "needs-triage": "needs-triage",
      "needs-info": "needs-info",
      "ready-for-agent": "ready-for-agent",
      "ready-for-human": "ready-for-human",
      "wontfix": "wontfix"
    },
    "notes": null
  }
}
```

Say whether `.formalising/fvs-config.json` will be updated or created from the template, and which roadmaps keep their own `issues:` block and are unaffected.

Use `AskUserQuestion`: write it, change something (return to Step 2), or cancel. Nothing is written until the user confirms.

## Step 5: Write .formalising/fvs-config.json

```bash
mkdir -p .formalising
[ -f .formalising/fvs-config.json ] || cp ${CLAUDE_PLUGIN_ROOT}/fv-skills/templates/config.json .formalising/fvs-config.json
```

Read the file and keep its content in memory. If it is malformed JSON, stop before writing.

Replace only the top-level `issues` key with the confirmed record. Preserve every other top-level key and every nested value, unknown keys included, along with key order and two-space indentation. Never write or replace the file with a partial settings object. Write it with the Write tool.

Verify by reading the file back: it parses as JSON, `issues` equals the confirmed record, and every other top-level key is unchanged from the content read before writing. If verification fails, restore the content read before writing (or remove the file if this step created it) and report the failure.

## Step 6: Report

```
FVS >> ISSUES SETUP COMPLETE

Provider:  {github | local | other}
Repo:      {owner/name | --}
Labels:    {role: label, ...}
Config:    .formalising/fvs-config.json

Roadmaps with their own `issues:` block keep it; every other roadmap uses this default.
```

Name any invalid overrides found in Step 1 and the missing fields of each. If labels were missing on GitHub, repeat that this command did not create them.

</process>

<success_criteria>
- [ ] Exploration was read-only: `git remote -v`, `gh auth status`, `gh repo view`, the existing `issues` section, the roadmaps and their overrides
- [ ] Malformed `fvs-config.json` stopped the command before any write
- [ ] The three providers (`github`, `local`, `other`) were offered, GitHub recommended only for a `github.com` remote with an authenticated, write-capable `gh` and issues enabled
- [ ] Labels: the five defaults kept or each role mapped to one existing label; no two roles share a label
- [ ] The exact `issues` section, all four fields, was shown and confirmed before anything was written
- [ ] `.formalising/fvs-config.json` was created from the template if missing; only the top-level `issues` key was replaced and every other key preserved; the write was verified by reading it back
- [ ] The per-roadmap `issues:` override was explained as a whole-block replacement, and invalid overrides were reported
- [ ] No GitHub labels or issues were created, no roadmap was edited, and no ignore or exclusion setting was changed
</success_criteria>
