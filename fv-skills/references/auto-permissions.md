<overview>

An auto-track run stops whenever a step asks for your approval and nobody answers. An approval prompt that
nobody answers is aborted after about 30 minutes (the time depends on your version), and the session that
asked stops. In the first rc2 run, about 70% of the wall-clock was waiting for approvals or stopped time
after an aborted prompt.

This page says how `/fvs:auto-init` finds the steps that prompt on your machine, which rules it writes for
them only after your yes, what still asks on purpose, and what to do when a step keeps asking. The commands
that do this are in `scripts/fvs-auto-permissions.mjs`, run by the orchestrator seat (`auto-seats.md`).

</overview>

## What the check does

A rule file cannot tell you which steps prompt. An ask rule beats an allow rule, a hook can ask although a
rule allows, and a wildcard ask rule matches words anywhere inside a command, such as the text of a message.
So the check runs one harmless instance of each step of the run, while you are at the keyboard. The agent
cannot see a prompt; you tell it afterwards which steps stopped and asked.

Before it starts, init tells you that some of these may prompt and that you should approve each one. None of
them posts to GitHub or pushes anything. The only things written are one scratch file in the git-excluded
`.formalising/` folder and the remote-tracking branches that a fetch updates.

| Step | The harmless instance | Why the run needs it |
|---|---|---|
| `worker-message` | `ao send --session fvs-permission-check-no-such-session --message "FVS permission check. Nothing to do."` (the session does not exist, so nothing is delivered) | The orchestrator sends instructions to workers. |
| `author-edit` | one scratch file written under `.formalising/auto-fv/permission-check/` (git-excluded) | Authors write Lean files. |
| `lake-build` | `lake env lean .formalising/auto-fv/permission-check/PermissionCheck.lean` (an import-free file, so it fetches nothing) | Authors and the orchestrator compile Lean files. |
| `gh-read` | `gh pr list --repo OWNER/REPO --limit 1` and `gh pr view 1 --repo OWNER/REPO` | The orchestrator reads pull requests. |
| `git-read` | `git ls-remote --heads origin` and `git fetch origin` | The orchestrator checks and fetches branches. |
| `git-push` | `git push -u origin fvs/permission-check --dry-run` (a dry run: nothing is pushed) | Workers push their branch to the project fork. |

`OWNER/REPO` is the repository the draft pull requests go to: your own repository, never an upstream. The
check refuses to run the push probe when the remote does not point at it. `fvs` is the branch namespace the
run pushes under; you choose it, and it can never be `main`, `master`, `release` or a wildcard.

Creating or editing a pull request is not harmless, so those steps are not probed. They are offered as
optional rules (below).

Then you answer which steps prompted. If none did, nothing is written. If some did, init shows you the exact
rules for those steps, and writes them only after your yes. The record of your answers is
`.formalising/auto-fv/permissions.json`; a resumed run reads it and does not ask again.

After writing, init repeats the probes of the steps it wrote and asks again. A step that still prompts has a
cause that no rule fixes: see "A step still prompts" below.

## Claude Code allowlist

Written to the project's `.claude/settings.json` (or `.claude/settings.local.json`, see "Where the file
goes"), keeping every other key. Only the rules of steps that prompted are written. This is the full set,
with `OWNER/REPO` and `fvs` standing for your own values:

```json
{
  "permissions": {
    "allow": [
      "Bash(ao send *)",
      "Edit(/.formalising/auto-fv/permission-check/**)",
      "Bash(lake env lean *)",
      "Bash(lake build *)",
      "Bash(gh pr view *)",
      "Bash(gh pr list *)",
      "Bash(git fetch *)",
      "Bash(git ls-remote *)",
      "Bash(git push -u origin fvs/*)",
      "Bash(git push origin fvs/*)"
    ],
    "deny": [
      "Bash(git push *--force*)",
      "Bash(git push *--delete*)",
      "Bash(git push *--mirror*)",
      "Bash(git push *--all*)",
      "Bash(git push *--tags*)",
      "Bash(git push *--prune*)",
      "Bash(git push -f*)",
      "Bash(git push * -f*)",
      "Bash(git push -d*)",
      "Bash(git push * -d*)",
      "Bash(git push * +*)",
      "Bash(git push *:*)"
    ]
  }
}
```

Why each rule:

- `ao send *`: the orchestrator's messages to workers.
- `Edit(/.formalising/auto-fv/permission-check/**)`: the scratch file of the check only. Edits in your spec and
  proof folders follow the session's permission mode (see the optional rule below).
- `lake env lean *` and `lake build *`: compiling Lean. Lake runs the project's own lakefile, so these rules
  allow what any build of the project does.
- `gh pr view *` and `gh pr list *`: reading pull requests. Read only.
- `git fetch *` and `git ls-remote *`: reading branches. Neither pushes.
- `git push -u origin fvs/*` and `git push origin fvs/*`: a worker pushes its own branch to the project fork,
  and only under your namespace.
- The `deny` rules are not permissions. They exist because a `*` in an allow rule also matches the rest of the
  command, so `git push origin fvs/x --delete` would match the push rule. Each deny rule starts with
  `git push`, so it cannot match words inside a message or pull request text. They refuse force pushes,
  deletes, mirrors, tags, pruning, `+branch` and `source:destination` pushes outright, because an unanswered
  prompt would only stall the run.

Optional rules, never probed, written only when you pick them:

| Step | Rule | Why |
|---|---|---|
| `draft-pr-create` | `Bash(gh pr create --draft --repo OWNER/REPO *)` | A worker opens a draft pull request on your repository. The order of the words matters: `--draft` then `--repo`. |
| `draft-pr-edit` | `Bash(gh pr edit *)` | A worker edits the body of a pull request. |
| `edit-folders` | `Edit(/formal/**)` | Authors edit your spec and proof folder without asking each time. It never names `.claude`, `.git` or `.formalising`. |

## Codex rules

Written to `.codex/rules/fvs-auto.rules` in the project, after your yes. The syntax is Codex's own
`prefix_rule` (checked against Codex's rules documentation and with `codex execpolicy check`), and the file
lists examples that Codex checks when it loads the rules. Codex loads project rules only when the project's
`.codex/` folder is trusted. Whether a live Codex session stops prompting after this file is not observed.

```python
prefix_rule(
    pattern = ["ao", "send"],
    decision = "allow",
    justification = "Orchestrator messages to workers",
)
prefix_rule(
    pattern = ["gh", "pr", "view"],
    decision = "allow",
    justification = "Read a pull request",
)
prefix_rule(
    pattern = ["gh", "pr", "list"],
    decision = "allow",
    justification = "List pull requests",
)
prefix_rule(
    pattern = ["git", "fetch", "origin"],
    decision = "allow",
    justification = "Fetch from origin",
)
prefix_rule(
    pattern = ["git", "ls-remote"],
    decision = "allow",
    justification = "List remote branches",
)
```

Codex rules match only the start of a command, so they cannot say "but not `--force`". For that reason no push
rule is written for Codex: a push still asks. Codex edits and Lake builds follow the sandbox mode, not a rule
file, so no rule is written for them either. If you want a push rule anyway, write it yourself and keep it
for one exact command.

## What still prompts on purpose

None of these is ever allowed by the files above, and the check refuses to write a rule for any of them:

- a GitHub comment or review (`gh pr comment`, `gh pr review`), marking a pull request ready, and a merge;
  only you comment, mark ready and merge;
- a push to any remote other than the project fork, and a push to a branch outside your namespace;
- a force push, a delete, a mirror push, a tag push (the `deny` rules refuse these outright);
- `gh api`, `gh issue`, `gh repo`, `gh release` and any other command not in the table above;
- any step you did not confirm, and any step that did not prompt in your check.

A push written another way, such as `git -C . push`, is not matched by these rules and keeps asking. Workers
should push in one standalone, unchained call: `git push -u origin fvs/<name>`, with no `&&`, `;`, pipe or
`cd` in front of it. A compound command is allowed only when every part of it is allowed.

## Where the file goes

Claude Code reads the project's `.claude/settings.json` from the session's own directory, and rules in a
shared project file apply once you trust the folder.

- A worker works in its own worktree. It sees `.claude/settings.json` only if the file is committed, or if
  `.claude` is linked into the worktree (`auto-setup.md`, "Worktrees"). If neither is true, the allowlist helps
  the orchestrator only.
- `.claude/settings.local.json` is read from the main checkout in every worktree of the repository, and Claude
  Code keeps it out of git. Pick it when you want workers to see the rules without committing anything.
- The check tells you whether the file it wrote is tracked, ignored or loose in git. A loose or tracked file
  can end up in a pull request: do not commit it with proof work unless you mean to share it.
- If `.claude` is a link, the check writes through it and tells you the real path.
- Delete the lines to undo the change. Nothing else is touched. If the settings file is not valid JSON, the
  check stops and leaves it alone.

Workers started by Agent Orchestrator run in the permission mode Agent Orchestrator gives them. The check
covers the session that ran init. If your workers run in another mode, check that mode too.

## After a first run: `/fewer-permission-prompts`

In Claude Code, `/fewer-permission-prompts` reads your session transcripts and proposes a list of common
read-only commands to allow. It needs transcripts, so use it after a first run, not before. It tunes the
list for your habits and does not know the run's steps. Read what it proposes: do not accept a rule that
allows a GitHub comment, review or merge, a force push or a push to an upstream. It is not available in Codex.

## A step still prompts

Work through these in order. Each is specific to a setup, so skip any that is not yours.

1. **The session has not reloaded the file.** Claude Code watches settings files and reloads them, but a
   session started before the file existed may need a restart.
2. **An ask rule matches.** An ask rule beats an allow rule. Wildcard ask rules, such as one for any command
   containing `gh pr edit` or `git merge`, match words anywhere in a command, including the text of an
   `ao send` message or a pull request body, so a harmless message that mentions a merge can prompt. Say what
   should happen in plain words ("combine the branches"), or narrow the ask rule so that it starts with the
   command.
3. **A hook asks.** A command hook before a tool call can ask even when a rule allows. A hook that guards
   pushes, for example, may ask for every push whose branch name it does not know. FVS cannot change your hook:
   change the hook, or approve those pushes yourself.
4. **A hook rewrites the command (for example `rtk`).** The permission layer then sees the rewritten command,
   so an allow rule written for `git push ...` does not match `rtk git push ...`. Add a twin rule for the
   rewritten form, or exempt the command from the hook. Such hooks have also cut JSON output short.
5. **Managed settings** from an organisation can override a project file. `/status` in Claude Code names the
   sources.
6. **The step runs in a different mode.** A worker may use a mode that asks even though your orchestrator
   session does not.

An unanswered prompt is an uncertain outcome, not a refusal: see "Controller permissions in auto mode" in
`auto-setup.md` before you retry anything.
