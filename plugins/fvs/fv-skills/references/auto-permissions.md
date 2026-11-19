<overview>

An auto-track run stops whenever a step asks for your approval and nobody answers. An approval prompt that
nobody answers is aborted after about 30 minutes (the time depends on your version), and the session that
asked stops. In one setup, about 70% of the wall-clock was waiting for approvals or stopped time after an
aborted prompt.

This page says how `/fvs:auto-init` finds the steps that prompt on your machine, which rules (and, for a push,
which hook) it writes for them only after your yes, what still asks on purpose, and what to do when a step
keeps asking. The commands that do this are in `scripts/fvs-auto-permissions.mjs` and
`scripts/fvs-auto-push-gate.mjs`, run by the orchestrator seat (`auto-seats.md`).

</overview>

## What the check does

A rule file cannot tell you which steps prompt. An ask rule beats an allow rule, a hook can ask although a
rule allows, and a wildcard ask rule matches words anywhere inside a command, such as the text of a message.
So the check runs one low-risk instance of each step of the run, while you are at the keyboard. The agent
cannot see a prompt; you tell it afterwards which steps stopped and asked.

Before it starts, init tells you that some of these may prompt and that you should approve each one. None of
them posts to GitHub or pushes anything. The check itself writes one scratch file in the git-excluded
`.formalising/` folder, and a fetch updates the remote-tracking branches. It cannot promise more than that
about the tools it starts: Lake evaluates your project's own lakefile and can write build caches, and git runs
any hook you configured for a fetch or a push. "Low-risk" means these are the commands the run itself uses, in
their mildest form. It does not mean they are inert, so the check never asks you for blanket approval of
project code.

| Step | The low-risk instance | Why the run needs it |
|---|---|---|
| `worker-message` | `ao send --session fvs-permission-check-no-such-session --message "FVS permission check. Nothing to do."` (the session does not exist, so nothing is delivered) | The orchestrator sends instructions to workers. |
| `author-edit` | one scratch file written under `.formalising/auto-fv/permission-check/` (git-excluded) | Authors write Lean files. |
| `lake-build` | `lake env lean .formalising/auto-fv/permission-check/PermissionCheck.lean` (an import-free file; skipped while the project's dependencies are not in `.lake/packages`, because Lake would download them and create a manifest) | Authors and the orchestrator compile Lean files. |
| `gh-read` | `gh pr list --repo OWNER/REPO --limit 1` and `gh pr view 1 --repo OWNER/REPO` | The orchestrator reads pull requests. |
| `git-read` | `git ls-remote --heads origin` and `git fetch origin` | The orchestrator checks and fetches branches. |
| `git-push` | `git push -u origin fvs/permission-check --dry-run` (a dry run: nothing is pushed) | Workers push their branch to the project fork. |

`OWNER/REPO` is the repository the draft pull requests go to: your own repository, never an upstream. Before
any probe runs, init reads every URL git would use for the remote (all fetch URLs and all push URLs, after
git's own URL rewriting) and requires each one to name that host (`github.com`, unless you give another host)
and that repository. A second push URL that names an upstream, the same path on another host, or a URL it
cannot read stops the check. This is a check at setup time and remote settings can change later, which is why
the push gate hook repeats it at every push. `fvs` is the branch namespace the run pushes under; you choose
it, and it can never be `main`, `master`, `release` or a wildcard.

Creating or editing a pull request is not part of the check, and init writes no rule for either. Approve
them yourself, or add your own rule if you want them to run unasked.

Then you answer which steps prompted. If none did, nothing is written. If some did, init shows you the exact
rules for those steps (and, for a push, the hook), and writes them only after your yes. The record of your
answers is `.formalising/auto-fv/permissions.json`; a resumed run reads it and does not ask again. To run the
check again, delete that file yourself and run `/fvs:auto-init`.

The summary that init prints, and reports as the `Permissions:` line, shows the latest answer for each step
across all rounds. A recheck of some steps never hides a step it did not ask about. Steps never asked, and
steps recorded as unknown (for example a Lake step that was skipped), stay visible. The answers describe the
probes that ran. They do not predict every command the run may use later.

After a write, what you can check depends on the tool:

- Claude Code reloads settings files while it runs. Init repeats the probes of the steps whose rules it wrote
  and asks again. A step that still prompts: see "A step still prompts".
- Codex reads rules when a session starts. A recheck in the session that was already running proves nothing
  about a new rules file, so init says so, records the write, and leaves the recheck for a new session once the
  project's `.codex/` folder is trusted. It never calls a prompt unfixable because of a retry in the same
  session.
- The push step has no recheck. The init probe is a dry run, which is not one of the exact forms the hook
  allows, so it asks even with the hook installed. The first real push by a worker is the evidence that the
  hook works.

## Claude Code allowlist

Written to the project's `.claude/settings.json` (or `.claude/settings.local.json`, see "Where the file
goes"), keeping every other key. Only the rules of steps that prompted are written. FVS writes allow rules only:
no deny rule, no ask rule, and no rule that names a push. This is the full set:

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
      "Bash(git ls-remote *)"
    ]
  }
}
```

Why each rule:

- `ao send *`: the orchestrator's messages to workers.
- `Edit(/.formalising/auto-fv/permission-check/**)`: the scratch file of the check only. Edits in your spec and
  proof folders follow the session's permission mode; init writes no rule for them.
- `lake env lean *` and `lake build *`: compiling Lean. Lake runs the project's own lakefile and downloads a
  dependency that is missing, so these rules allow what any build of the project does.
- `gh pr view *` and `gh pr list *`: reading pull requests. Read only.
- `git fetch *` and `git ls-remote *`: reading branches. Neither pushes.
- There is no push rule. A `*` in an allow rule also matches the rest of the command, so no glob can say "this
  branch and nothing else". Pushes are handled by the hook below.

## Push gate hook

A glob cannot allow a push safely. `git push origin fvs/x main` pushes to `main`, and
`git push -u origin fvs/x -uf` is a force push, and both match `git push origin fvs/*`. So init writes no push
rule. When the push step prompted on Claude Code, init offers a small hook instead,
`scripts/fvs-auto-push-gate.mjs`, which reads each Bash command before it runs. It is opt-in: it is installed
only after you have seen the exact entry and said yes, with the same preview and digest as the allowlist, and
`--target local` works the same way. It is added to the `hooks.PreToolUse` list of the settings file, and
every other key and hook in the file stays as it was:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"<FVS scripts folder>/fvs-auto-push-gate.mjs\" --repo OWNER/REPO --host github.com --remote origin --prefix fvs",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

The command names the destination you chose, because a worker's worktree has no run folder to read it from.
The hook answers for every Bash command that contains a push:

- **Allow** only the exact plain forms, each on one line with nothing around it:
  - `git push origin fvs/<name>` and `git push -u origin fvs/<name>`, also after one `git -C <plain path>`. A
    plain path has only letters, digits and `_ . / + @ % : = , -`; a path with a space, quote, `$`, `~` or other
    shell syntax asks.
  - A bare `git push`, only when HEAD is a branch `fvs/<name>`, its upstream and its push target are both
    `origin/<same name>`, `push.default` is `simple`, `current` or `upstream` (not `matching`), and
    `remote.origin.push` is not set.
  - No form is allowed when a setting would make the push send more than the one branch: `remote.origin.mirror`,
    `push.followTags` (common in a global git config), `push.recurseSubmodules` set to `on-demand` or `only`,
    or `submodule.recurse`. Such a push asks, even in the exact forms above. Unset the setting for the
    project, or approve those pushes by hand.
- **Check the destination first.** Before it allows anything it reads every URL git would push to from the
  directory the push runs in (the working directory, or the `-C` path), after git's own URL rewriting, and
  requires each to name the host and repository you chose. Any mismatch, a URL it cannot read, or a git error
  means ask. A URL is read the way git reads it, and a form that programs read differently is refused: a
  backslash, a space or control character, a leading `-`, and an scp-like form such as
  `host:user@github.com:Acme/proj`, which git sends to `host`.
- **Ask** for every other command that contains a push: force flags, `--delete`, `--tags`, `--mirror`, `--all`,
  `--dry-run`, refspecs with `:` or `+`, other remotes, other branch names, several branch names, chains
  (`&&`, `;`), pipes, redirects (`2>&1`), several lines, quotes, `$(...)`, a `-C` path that is not plain, other
  git options before `push`, and a prefix such as `rtk`, `env` or `sudo`.
- **Say nothing** for a command that is not a push.

What it does not do:

- A hook that answers "allow" skips the prompt, but it does not override your own `deny` or `ask` rules. A hook
  that answers "ask" makes the push prompt even where a rule of yours allows it.
- It judges the text of a command. A push it does not recognise as a push (for example one that builds the word
  `git` from a variable) is not judged. It goes through the session's normal permission flow, as it would
  without the hook, and that flow asks because init writes no push rule. A commit message or `ao send` text that
  contains `git push` is treated as a push and asks.
- **Branch protection on the project fork is still recommended.** Protect `main` and the release branches and
  forbid force pushes. It is an independent safeguard that works whatever the command looks like, including a
  push this hook cannot see.
- There is no hook for Codex. A push asks on Codex, and a Codex rule cannot say "but not `--force`".

Workers should push in one standalone, unchained call: `git push -u origin fvs/<name>`, with no `&&`, `;`,
pipe, redirect, `cd` or quote in front of or after it. A commit and a push in one command asks.

The command names this machine's copy of the script. If the script is missing or the hook fails, a push asks
as usual, so it fails safe. After an FVS update or reinstall that moves the script, remove the entry and run
init again: init never replaces or edits a push gate entry it finds, and says so. Use `--target local` so that
a machine path does not end up in a committed file. To undo the hook, delete the entry.

## Codex rules

Written to `.codex/rules/fvs-auto.rules` in the project, after your yes. The syntax is Codex's own
`prefix_rule`, from the [Codex rules documentation](https://developers.openai.com/codex/rules), and it was
checked with `codex execpolicy check` on codex-cli 0.166.0. The file lists examples that Codex checks when it
loads the rules. Whether a live Codex session stops prompting after this file is not observed.

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

- Before it writes, init evaluates the exact text from a temporary file outside the project with the installed
  Codex. It refuses to write when that Codex rejects the rules or does not allow a probe command. Without a
  Codex CLI the file is still written after your yes, and init says plainly that nothing verified it.
- Codex loads project rules only when the project's `.codex/` folder is trusted, and scans rules when a
  session starts. A new file takes effect in a new session.
- Init never replaces or merges an existing rules file. If `.codex/rules/fvs-auto.rules` exists and differs,
  init refuses and shows both texts, because a merge could drop a rule you approved earlier or one you added.
  To change it, save any rule of your own, delete the file yourself, and write every step you want in one
  command.
- Codex rules match only the start of a command, so they cannot say "but not `--force`". No push rule is
  written for Codex, and there is no hook: a push still asks. Codex edits and Lake builds follow the sandbox
  mode, not a rule file, so no rule is written for them either. If only the push, Lake or edit step prompted,
  there is nothing to write on Codex: init says so and those prompts stay unresolved until you approve them
  when they appear.

## What still prompts on purpose

None of these is ever allowed by the files above, and the check refuses to write a rule for any of them:

- a GitHub comment or review (`gh pr comment`, `gh pr review`), marking a pull request ready, and a merge;
  only you comment, mark ready and merge;
- every push that is not one of the exact forms of the push gate hook, and every push on Codex;
- `gh api`, `gh issue`, `gh repo`, `gh release` and any other command not in the table above;
- any step you did not confirm, and any step that did not prompt in your check.

## Where the file goes

Before you confirm, init shows the file it would change, the real path when `.claude` is a link, whether the
file is tracked, ignored or loose in git, and where it applies.

Claude Code reads the project's `.claude/settings.json` from the session's own directory, and rules and hooks
in a shared project file apply once you trust the folder. Whether a hook in `.claude/settings.local.json` needs
the same trust step is not observed.

- A worker works in its own worktree. It sees `.claude/settings.json` only if the file is committed, or if
  `.claude` is linked into the worktree (`auto-setup.md`, "Worktrees"). If neither is true, the allowlist and
  the hook help the orchestrator only.
- `.claude/settings.local.json` is read from the main checkout in every worktree of the repository, and Claude
  Code keeps it out of git. Pick it when you want workers to see the rules without committing anything. The
  check writes it only when the project root is the main checkout, and refuses in a linked worktree.
- A loose or tracked file can end up in a pull request: do not commit it with proof work unless you mean to
  share it.
- If `.claude` is a link, the check writes through it.
- Delete the lines to undo the change. Nothing else is touched. If the settings file is not valid JSON, or its
  `permissions` or `hooks` section has an unexpected shape, the check stops and leaves it alone.

Workers started by Agent Orchestrator run in the permission mode Agent Orchestrator gives them. The check
covers the session that ran init. If your workers run in another mode, check that mode too.

## What was tested

- Unit tests (node, no network): the helper's confirmation, merge, refusals and Codex file handling, and the
  hook's decision table against throwaway repositories with a fake remote. Nothing in them pushes.
- The Codex rules were run through `codex execpolicy check` on codex-cli 0.166.0: the file parses, each probe
  command is allowed, and push, merge and other commands are not matched. The tests repeat this when a Codex
  CLI is installed.
- One live probe: the message step (`ao send` to a session that does not exist) was run in a Claude Code
  session.
- Not observed: a live Claude Code or Codex session showing that a written rule or the hook removes a prompt,
  including that an "allow" answer from the hook skips the prompt; the live `gh`, `git fetch`,
  `git push --dry-run` and Lake probes; a real push through the hook; that the working directory Claude Code
  gives the hook is the directory the shell runs the push in (the `-C` path and the destination check rely on
  it, and a mismatch makes the hook ask, not allow). That is why init asks you to recheck, and why the first
  real push is the evidence for the hook.

## After a first run: `/fewer-permission-prompts`

In Claude Code, `/fewer-permission-prompts` reads your session transcripts and proposes a list of common
read-only commands to allow. It needs transcripts, so use it after a first run, not before. It tunes the
list for your habits and does not know the run's steps. Read what it proposes: do not accept a rule that
allows a GitHub comment, review or merge, a force push or a push to an upstream. It is not available in Codex.

## A step still prompts

Work through these in order. Each is specific to a setup, so skip any that is not yours.

1. **The session has not loaded the file.** Claude Code watches settings files and reloads them, but a
   session started before the file existed may need a restart. Codex scans rules only when a session starts:
   open a new session.
2. **An ask rule matches.** An ask rule beats an allow rule. Wildcard ask rules, such as one for any command
   containing `git merge`, match words anywhere in a command, including the text of an
   `ao send` message or a pull request body, so a harmless message that mentions a merge can prompt. Say what
   should happen in plain words ("combine the branches"), or narrow the ask rule so that it starts with the
   command.
3. **A hook asks.** A command hook before a tool call can ask even when a rule allows. A hook that guards
   pushes may ask for every push whose branch name it does not know, and the push gate hook asks for every push
   that is not an exact plain form (see "Push gate hook"). FVS cannot change your hook: change the hook, or
   approve those pushes yourself.
4. **A hook rewrites the command (for example `rtk`).** The permission layer then sees the rewritten command,
   so an allow rule written for `git push ...` does not match `rtk git push ...`, and the push gate hook sees
   `rtk git push ...`, which is not an exact form, so it asks for every push. Add a twin rule for the rewritten
   form, or exempt the command from the rewriting hook. Such hooks have also cut JSON output short.
5. **Managed settings** from an organisation can override a project file. `/status` in Claude Code names the
   sources.
6. **The step runs in a different mode.** A worker may use a mode that asks even though your orchestrator
   session does not.

An unanswered prompt is an uncertain outcome, not a refusal: see "Controller permissions in auto mode" in
`auto-setup.md` before you retry anything.
