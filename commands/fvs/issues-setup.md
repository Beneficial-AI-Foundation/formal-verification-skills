---
name: fvs:issues-setup
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

<objective>
Let the user choose the issue tracker for this project and record the choice as the `issues` section of `.formalising/fvs-config.json`. Explore the repository first, recommend a default, show the exact section, and write it only after the user confirms.

Output: an `issues` section in `.formalising/fvs-config.json`; every other key unchanged.

This command never creates GitHub labels or issues. It records where issues live and which label vocabulary they use; nothing more.
</objective>

<execution_context>
@~/.claude/fv-skills/references/ui-brand.md
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

For `local`: say that setup creates no directory; issue files appear when issues are first created. Then check, read-only, git's ignore status for one example path per roadmap directory found in Step 1, `<roadmap directory>/issues/probe.md` (the file does not need to exist). Git decides ignore status per path, so each result describes only that exact path. Run this once per roadmap directory, substituting it for `$ROADMAP_DIR`. Exit status 0 means that path is ignored, 1 means it is not ignored, anything else (for example `.formalising` being a symlink) means unknown:

```bash
git check-ignore -q "$ROADMAP_DIR/issues/probe.md"; case $? in 0) echo "PATH_IGNORED $ROADMAP_DIR/issues/probe.md";; 1) echo "PATH_NOT_IGNORED $ROADMAP_DIR/issues/probe.md";; *) echo "PATH_UNKNOWN $ROADMAP_DIR/issues/probe.md";; esac
```

Report each result as the status of that exact path, and say plainly that real issue files and directory-wide status are not checked. Make no claim about whether future issue files will be committed. If no roadmap exists yet there is no example path to check: say so.

Never modify `.gitignore`, `.git/info/exclude` or any other ignore or exclusion setting. If the user wants issue files kept out of commits, they may add `.formalising/` (or a narrower path) to `.git/info/exclude` themselves: show the exact line for `.git/info/exclude` (the per-clone exclusion file that is never committed) and let them add it.

## Step 3: Label vocabulary

Use `AskUserQuestion`: keep the five defaults (Recommended), or map each role to an existing label.

The defaults are `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix`, each mapped to a label of the same name.

For `github`, list the repository's existing labels read-only:

```bash
gh label list --repo "$REPO" --json name --limit 200
```

To map each role to an existing label, offer those labels. For `local` and `other`, ask for the label strings. Every role gets exactly one non-empty label. Reject a mapping in which two roles share the same label, and ask again.

For `github`, compare the final labels, defaults included, with that list: name any that are not found in the returned list and say this command does not create them. The list is capped at 200 labels and can omit some, so a label that is not found in the returned list is not proven absent. If `gh` cannot list the labels, say they could not be checked. Creating labels is outside this command; issue-creating commands ask for separate consent first.

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
[ -f .formalising/fvs-config.json ] || cp ~/.claude/fv-skills/templates/config.json .formalising/fvs-config.json
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
