<overview>

An auto-track run stops whenever a step asks for your approval and nobody answers. An approval prompt that
nobody answers is aborted after about 30 minutes (the time depends on your version), and the session that
asked stops. In one setup, about 70% of the wall-clock was waiting for approvals or stopped time after an
aborted prompt.

This page says how `/fvs:auto-init` finds the steps that prompt on your machine, which rules it writes for them
only after your yes (for a push, the one rule that names the FVS push command), what FVS never allows, and what
to do when a step keeps asking. The commands that do this are in `scripts/fvs-auto-permissions.mjs` and
`scripts/fvs-auto-push.mjs`, run by the orchestrator seat (`auto-seats.md`). A run that skips permission prompts
inside a sandbox keeps the same safety rules and enforces them by other means: see "Unattended runs in a sandbox".

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
any hook you configured for a fetch. "Low-risk" means these are the commands the run itself uses, in
their mildest form. It does not mean they are inert, so the check never asks you for blanket approval of
project code.

| Step | The low-risk instance | Why the run needs it |
|---|---|---|
| `worker-message` | `ao send --session fvs-permission-check-no-such-session --message "FVS permission check. Nothing to do."` (the session does not exist, so nothing is delivered) | The orchestrator sends instructions to workers. |
| `author-edit` | one scratch file written under `.formalising/auto-fv/permission-check/` (git-excluded) | Authors write Lean files. |
| `lake-build` | `lake env lean .formalising/auto-fv/permission-check/PermissionCheck.lean` (an import-free file; skipped while the project's dependencies are not in `.lake/packages`, because Lake would download them and create a manifest) | Authors and the orchestrator compile Lean files. |
| `gh-read` | `gh pr list --repo OWNER/REPO --limit 1` and `gh pr view 1 --repo OWNER/REPO` | The orchestrator reads pull requests. |
| `git-read` | `git ls-remote --heads origin` and `git fetch origin` | The orchestrator checks and fetches branches. |
| `git-push` | `node /PATH/TO/FVS/scripts/fvs-auto-push.mjs --branch fvs/.permission-check` (a branch name that no branch can have, so the push command refuses it before it contacts the fork: nothing is pushed) | Workers push their branch to the project fork with the FVS push command. |

`OWNER/REPO` is the repository the draft pull requests go to: your own repository, never an upstream. Before
any probe runs, init reads every URL git would use for the remote (all fetch URLs and all push URLs, after
git's own URL rewriting) and requires each one to name that host (`github.com`, unless you give another host)
and that repository. A second push URL that names an upstream, the same path on another host, or a URL it
cannot read stops the check. This is a check at setup time and remote settings can change later, which is why
the push command repeats it at every push. `fvs` is the branch namespace the run pushes under; you choose
it, and it can never be `main`, `master`, `release` or a wildcard. Init records the push address as git would use it
after its own rewriting, and it stops when a `url.<base>.insteadOf` or `pushInsteadOf` rule would rewrite that
address again, because the push command refuses such a destination.

Creating or editing a pull request is not part of the check, and init writes no rule for either. Approve
them yourself, or add your own rule if you want them to run unasked.

Then you answer which steps prompted. If none did, nothing is written. If some did, init shows you the exact
rules for those steps, and writes them only after your yes. It also records where pushes go, whichever steps
prompted (see "The push command"). The record of your
answers is `.formalising/auto-fv/permissions.json`; a resumed run reads it, shows its summary and does not ask
again. To check again, ask init to recheck permissions: it runs `recheck`, which repeats the probes of the
steps that last prompted and records the answers as a recheck. This is the entry point
after rules were written, and in a new Codex session, because Codex reads its rules only when a session
starts. To start over, delete the record file yourself and run `/fvs:auto-init`.

The summary that init prints, and reports as the `Permissions:` line, shows the latest answer for each step
across all rounds. A recheck of some steps never hides a step it did not ask about. Steps never asked, and
steps recorded as unknown (for example a Lake step that was skipped), stay visible. The answers describe the
probes that ran. They do not predict every command the run may use later.

After a write, what you can check depends on the tool:

- Claude Code reloads settings files while it runs. Init runs `recheck` for the steps whose rules it wrote,
  repeats their probes and asks again. A step that still prompts: see "A step still prompts".
- Codex reads rules when a session starts. A recheck in the session that was already running proves nothing
  about a new rules file, so init says so, records the write, and leaves the recheck (`recheck` again, on your
  request) for a new session once the project's `.codex/` folder is trusted. It never calls a prompt unfixable because of a retry in the same
  session.
- The push probe is the push command with a branch name that no branch can have. The command refuses that name
  before it contacts the fork, so the probe can be repeated. It shows whether the permission layer lets the
  command run unasked. It does not show a real push: the first real push by a worker is the evidence for that.

## Claude Code allowlist

Written to the project's `.claude/settings.json` (or `.claude/settings.local.json`, see "Where the file
goes"), keeping every other key. Only the rules of steps that prompted are written. FVS writes allow rules only:
no deny rule, no ask rule, and no rule for a `git push`. This is the full set:

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
      "Bash(node /PATH/TO/FVS/scripts/fvs-auto-push.mjs --branch fvs/*)"
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
- `node /PATH/TO/FVS/scripts/fvs-auto-push.mjs --branch fvs/*`: the push command, with the absolute path of this
  machine's copy (replace `/PATH/TO/FVS/scripts` with your scripts folder; init prints the exact rule) and the branch
  namespace you chose, one rule per namespace. It is written only for a push step that prompted, and only after the
  destination is recorded. A `*` in an allow rule also matches the rest of the command text, so this rule cannot check
  the arguments: the command does (see "The push command"). When the scripts folder path has a character that a
  rule cannot spell (a space, a quote, `$` or a glob character), init writes no push rule and says why. The push
  command still works, and your other rules and permission mode decide whether it asks.

## The push command

A glob cannot allow a `git push` safely. `git push origin fvs/x main` pushes to `main`, and
`git push -u origin fvs/x -uf` is a force push, and both match `git push origin fvs/*`. So init writes no rule for
`git push`. Workers and the orchestrator push with one FVS command instead, and the one push rule names that
command:

```
node /PATH/TO/FVS/scripts/fvs-auto-push.mjs --branch fvs/<name>
```

A rule is matched against the command text, and a `*` in it also matches the rest of that text, so the rule cannot
check the arguments. The command checks them itself. Claude Code's documentation warns that a rule which tries to
constrain arguments is fragile, and this rule does not try.

Workers commit first, then run the command in a separate, standalone call, with the path that init printed. They
do not chain it with another command.

### What the command is

The push command is cooperative, with hardening, and not a security boundary. It guards against mistakes and misuse
through its own command line, and it trusts your git setup the way a push that you run yourself would. It is not a
defence against a program that runs as your user.

What it checks:

- It takes exactly `--branch <name>` and refuses anything else on its command line.
- It compares the shared git directory of the repository it runs in with the one recorded for the destination, and
  refuses when they differ or when a work tree points at another repository.
- It refuses a branch that is not a plain local branch under a recorded namespace. It pushes to the destination
  address recorded at init, and refuses that address when a URL rewrite rule applies to it at the time of the check.

What it does for this push, to harden it:

- The push is made with `--no-verify`, which skips the pre-push hook whether it is a file in a hooks folder or is
  set in git configuration (`hook.<name>.event`), and `core.hooksPath` is set to `/dev/null` so that git finds no
  hook in any hooks folder. Your own pre-push checks do not run for it.
- git runs without `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CONFIG`, `GIT_NAMESPACE` and `GIT_EXEC_PATH`. It also runs without
  `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_COUNT`, the `GIT_CONFIG_KEY_n` and
  `GIT_CONFIG_VALUE_n` pairs and `GIT_CONFIG_PARAMETERS`, except the ones whose names you trusted when you confirmed
  the destination at init. Init shows those names with their values. The command keeps each trusted name with
  whatever value it has when it runs, in every git call, and drops every other name. A trusted name that is not set
  is skipped, and a value that changed since init is not refused: the receipt marks it as changed. The configuration
  files that git reads by default stay, and so do your ssh, credential and transport settings that are not set
  through those variables.
- No push option is sent.

What it trusts, and so does not protect against:

- Your git setup, as for any push you run yourself.
- ssh and other transport wrappers (`GIT_SSH_COMMAND`, `core.sshCommand`, proxy and remote helpers): the command
  cannot tell where one of them sends the push.
- Credential helpers.
- The git configuration variables whose names you trusted at init, the way you trust your own git configuration
  files: whatever value they have when the command runs is used for the checks and for the push.
- URL rewrite rules: a rule that is added or changed after the command checks and before it connects is not caught.
- The record file and FVS itself: anything that runs as your user can edit the record, the script and the permission
  rule, and so change where the command pushes or what it checks.
- The git program found on `PATH`.

### What the command refuses

It exits with a plain message and a non-zero status, and pushes nothing, unless all of these hold:

- exactly `--branch <name>` was given. Any other argument, a second `--branch`, `--force`, a refspec or a remote
  name is refused.
- the shared git directory of the repository it runs in is the one recorded at init, and the recorded project root
  is a checkout of that same repository. The main checkout and its linked worktrees pass; a copy of the repository
  and another repository do not. A link that leads into the same repository is that repository, because the
  command goes by the real path that git uses and not by the name of the link; a link into another repository is
  another repository.
- git started in the top of this work tree uses the same repository. A `core.worktree` setting that points a
  repository at the files of another one is refused with `worktree-mismatch`. After these checks, the branch
  checks, the address checks, the read of the branch tip and the push itself each name the git directory and the
  work tree that were found, so none of them finds a repository again from a directory.
- `<name>` is a plain branch name under a recorded namespace (`fvs/...`), `refs/heads/<name>` exists as a local
  branch, it is not a symbolic ref, and no tag has the same name.
- no `url.<base>.insteadOf` or `pushInsteadOf` rule applies to the recorded address, no `[remote "<address>"]`
  section is named after it, and git reads the address as recorded.
- git finds the repository with the git variables that you trusted at init and no others. The command looks for the
  record from the work directory first, then asks git for the shared git directory and compares the two. A variable
  that is set and not trusted never reaches git. In a sandbox that needs one of them (git refuses a repository that
  another user owns unless `safe.directory` is set, often through `GIT_CONFIG_COUNT`), the command refuses with
  `not-a-repository` and names the variables that it left out, never their values. To trust them, run the
  destination step of `/fvs:auto-init` again: it replaces the record after your yes. A trusted name that is not set,
  or that has another value than at init, is not a refusal.

A worker that gets a refusal stops and reports its `code` and `message`. It does not fall back to `git push`.

### What it sends

It pushes to the address recorded at init, never to a remote name. In the tests, none of these settings changed
where the push went or what it sent: `remote.<name>.push`, `remote.<name>.pushurl`, `remote.<name>.mirror`,
`remote.pushDefault`, `branch.<name>.pushRemote`, `push.default`, `push.followTags`, `push.recurseSubmodules` and
`submodule.recurse`. It uses the full refspec `refs/heads/<name>:refs/heads/<name>` without a `+`,
`--no-follow-tags`, `-c push.followTags=false`, `--recurse-submodules=no`, `--porcelain`, `-c core.abbrev=no`,
`-c push.pushOption=`, `-c core.hooksPath=/dev/null` and `--no-verify`, and no other option. `push.pushOption=`
empties the list of push options from every git configuration: push options go to the receiving side, which can act on
them, and this command sends none. `--no-verify` skips the pre-push hook, including one that is set in git
configuration with `hook.<name>.event`, which `core.hooksPath` does not turn off. `core.hooksPath=/dev/null` makes git
find no hook in any hooks folder. Every git call that the command makes (the look for the repository, the checks,
the address checks and the push) runs with the same environment, so the checks see what the push sees. It is without
the variables listed under "What it does for this push", except the git configuration variables whose names you
trusted at init, which every call keeps with the value they have when the command runs. The permissions helper runs
its destination checks with the variables that are set in its session, because it asks you to confirm them. Its look
at the git status of a settings file runs without any. In the tests, a push option set in a trusted variable was not
sent, because git applies the command's own `-c push.pushOption=` after it.

The result is appended to `.formalising/auto-fv/pushes.jsonl` in the recorded project root: `created`,
`fast-forward`, `up-to-date`, `failed` (git says it did not update the branch) or `unknown`. The record names only
object ids that the push itself reported. A fast-forward has both the old and the new id. A new branch and an
up-to-date branch have none in git's summary, so `newRemoteId` is null for them. `localTipBeforePush` is the tip
that the command read just before the push. It is not the id of what was sent, because the branch can move between
that read and the push. To learn the head on the destination, run `git fetch` and read `origin/<name>`, and treat
that as a later observation: another push may have come in since. The command leaves no `origin/<name>` ref and sets no upstream: run `git fetch` to see the branch.

The receipt, in the output and in that file, also has `gitVariables`. For each trusted name it says `same` (the
value is the one that you saw at init), `changed` (another value, which the command used) or `not-set`, and it lists
the names that were set and not trusted, which the push dropped. It holds no value and no hash.

When git ends without a result for the branch (a lost connection, a timeout, a signal), the destination may have
taken the update. The command then reports `push-outcome-unknown` and does not say that nothing changed. Read the
destination before you retry, and report the code and message.

### What it does not stop

- The rule and the worker briefs name an absolute path. An FVS update or reinstall that moves the script leaves both
  stale: run init again to append the rule for the new path, and delete the old rule yourself. FVS deletes none of
  your rules.
- A worker that runs a plain `git push` is not covered by this rule: your other rules and permission mode decide
  that push, as before. That is why a Claude write refuses while a project settings file allows a `git push` by rule
  (next section).
- The report `push-outcome-unknown` after a timeout of the push has no test. The cases of a missing result line and
  of a signal are tested. Read the destination before you retry in every case.
- On Codex, a rule matches the start of a command: `node`, the path and `--branch`. It cannot tell `fvs/work` from
  `main`, and the command refuses a name outside the recorded namespaces. As the Codex rules documentation describes
  it, Codex splits a command run through a shell wrapper such as `bash -lc` into its simple commands only when the
  script is a plain chain joined by `&&`, `||`, `;` or `|`. A script with a redirect, a substitution, a variable
  assignment or a wildcard is not split, and the rules then apply to the whole invocation. That was not observed here.
- On Claude Code, its documentation says that a compound command is split at `&&`, `||`, `;`, `|`, `|&`, `&` and
  newlines and that every part must be allowed, and that a redirect target is checked against your file rules as if
  Claude wrote that file: the rule allows the command, not the target. For a command substitution after the branch
  name it says only that deny and ask rules see the nested command, and not what an allow rule does. None of this
  was observed here. The documentation was read in November 2026; the versions installed where this was written
  were Claude Code 2.1.329 and codex-cli 0.170.0.
- **Branch protection on the project fork is still recommended.** Protect `main` and the release branches and
  forbid force pushes. It is an independent safeguard that works whatever a command looks like.

Nothing in this page promises that a push asks.

### Where the destination is recorded

Init records it with `write-destination`, after your yes, whichever steps prompted: the push command refuses to run
without it. The file is `fvs-auto-push.json` in the shared git directory of the repository (the `.git` of the main
checkout), so every worktree of the repository finds it and no commit contains it:

```json
{
  "schema": "fvs/auto-push-destination",
  "schemaVersion": 1,
  "projectRoot": "/work/proj",
  "commonDir": "/work/proj/.git",
  "url": "git@github.com:OWNER/REPO.git",
  "host": "github.com",
  "repo": "OWNER/REPO",
  "prefixes": ["fvs"]
}
```

Init records the address git would push to after its own rewriting. It replaces a record only to change the git
variables that you trust (below), and only when the destination is the same. A record for another destination, a
record that is not valid and a file that is not JSON stop it with `destination-conflict`, which shows both. To
record another destination, check the file, delete it yourself and run init again. The permission preview for a push
rule shows the record that is on disk, and the push rule is written only while that record names what init would
record now, whatever values the trusted variables have.

If git configuration variables are set when you confirm the destination (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`,
`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_COUNT` with its pairs, `GIT_CONFIG_PARAMETERS`), the preview prints each one with
its value, and your yes trusts these names. The record gains `trustedGitVariables`: each trusted name with a hash of
its value at that moment, so the file never holds a value that may be a credential. The values are printed only in
that preview. The push command keeps each trusted name with whatever value it has when it runs and drops every other
name. A value that changes later, such as a token that a sandbox sets for each session, is not refused: the receipt
marks it `changed`, and the hash is for that information only. A trusted name that is not set is skipped. You trust
these names the way you trust `~/.gitconfig`: whatever they hold is used. Do not trust a variable that carries a
token when a credential helper can do the job. Run the destination step where the workers run, so the names are the
ones they have. A sandbox that gives git `safe.directory` through `GIT_CONFIG_COUNT` needs this, because git does
not answer in a repository that another user owns without it. Trust the whole group (`GIT_CONFIG_COUNT` with its
`GIT_CONFIG_KEY_n` and `GIT_CONFIG_VALUE_n` pairs): a count whose pairs were dropped makes git fail in every call.

To change which names you trust, run the destination step again where the workers run. When the record is the same
except for its trusted names, the preview shows the old record, the new record and the names that are added and
removed, with its own digest. After your yes the record is rewritten (`replaced`) and the old one is not kept. The
digest covers the old record, so a record that changed after the preview needs a new yes.

### Push allow rules already in your settings

FVS writes no rule for `git push`, and it does not delete yours. A worker could run a plain `git push` under such a
rule and skip the push command. When either project settings file (`.claude/settings.json` or
`.claude/settings.local.json`) already has an entry of `permissions.allow` that names `git push`, such as
`Bash(git push origin fvs/*)`, `Bash(git push:*)`, `Bash(git -C * push *)` or `Bash(rtk git push *)`, a Claude write
stops with `legacy-push-rules`, before any preview and before anything is written. Both files stay byte-identical.
The refusal lists, for each file, the exact entries and how many other allow entries stay, so that you can delete
exactly those lines and run init again. `plan` lists them too, because such a rule can also make the push probe
quiet for a reason that has nothing to do with the push command. The rule that names the push command is not a
`git push` rule and is never listed.

What this check does not see: broad rules such as `Bash(git *)` or `Bash(*)`, your user settings
(`~/.claude/settings.json`), managed settings, and the permission mode. Check those yourself.

## Codex rules

Written to `.codex/rules/fvs-auto.rules` in the project, after your yes. The syntax is Codex's own
`prefix_rule`, from the [Codex rules documentation](https://developers.openai.com/codex/rules), and it was
checked with `codex execpolicy check` on codex-cli 0.166.0 and again on 0.170.0. The file lists examples that Codex checks when it
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
prefix_rule(
    pattern = ["node", "/PATH/TO/FVS/scripts/fvs-auto-push.mjs", "--branch"],
    decision = "allow",
    justification = "The FVS push command: one branch of the run, to the destination recorded at init",
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
- Codex rules match only the start of a command, so they cannot say "but not `--force`". The push rule names the
  push command and `--branch`; it cannot tell `fvs/work` from `main`, and the command refuses a name outside the
  recorded namespaces (see "The push command"). A rule for `git push` is never written. Codex edits and Lake builds
  follow the sandbox mode, not a rule file, so no rule is written for them. If only the Lake or edit step prompted,
  there is nothing to write on Codex: init says so and those prompts stay unresolved until you approve them when
  they appear.
- Codex splits a command run through a shell wrapper such as `bash -lc` into its simple commands before it matches
  rules only for a plain chain joined by `&&`, `||`, `;` or `|`; any other script is matched as one invocation, as its
  documentation says. That was not observed here, and `codex execpolicy check` takes the command words directly.

## What FVS never allows

FVS writes no rule that allows any of these, and the check refuses to write a rule for any of them. Whether one
prompts in a session still depends on your other rules and permission mode:

- a GitHub comment or review (`gh pr comment`, `gh pr review`), marking a pull request ready, and a merge;
  only you comment, mark ready and merge;
- every push that is not made with the push command (no rule for a `git push` is written, on either tool);
- `gh api`, `gh issue`, `gh repo`, `gh release` and any other command not in the table above;
- any step you did not confirm, and any step that did not prompt in your check.

## Unattended runs in a sandbox

Some runs start with the permission prompts turned off (skip-permissions in Claude Code, or the same switch in
another tool). Use that mode only inside an isolated sandbox or on a cloud machine. Never
use it on a personal machine with broad access to your files, accounts and credentials.

With skip-permissions nothing prompts, so the rules in "What FVS never allows" (no GitHub comments or reviews, no
merges, no pushes to an upstream) are no longer enforced by a prompt. Enforce them by other means, outside the
agent:

- **A token limited to the project's fork.** Give the sandbox a GitHub token for that one repository, with
  only the access the run needs.
- **A posting guard in the sandbox.** A token that can open draft pull requests can usually also comment, review
  and merge. Put a `gh` wrapper ahead of the real `gh` on `PATH` that refuses the commands that comment on, review,
  mark ready or merge a pull request, and `gh api` calls to those endpoints. The wrapper only catches mistakes: a
  program in the sandbox can call the API directly. The token limits where a comment can land, not whether one is
  posted.
- **Branch protection on the fork.** On its main branches, require a pull request and forbid force pushes and
  branch deletion, and apply the rule to administrators too: GitHub exempts them by default, and an agent that works
  through the owner's own account acts as one. A direct push is then stopped. A merge through a pull request is not:
  the posting guard refuses it, and only the owner merges. A team with a second reviewer can also require an
  approving review, but the owner then needs that reviewer to merge their own pull requests.

In a skip-permissions sandbox only the permission check and the allowlist are optional; the push command and init's
destination step are not. Workers push with the push command and never with `git push`, because it pushes to the
destination recorded at init and records the result. With no destination recorded, a worker's first push is refused and
the worker stops; init records it in a separate step, also when you skip the check. The command is a cooperative
guard and not a security boundary (see "What the command is"), so the token and the branch protection are what limit
a push.

## Where the file goes

Before you confirm, init shows the file it would change, the real path when `.claude` is a link, whether the
file is tracked, ignored or loose in git, and where it applies.

Claude Code reads the project's `.claude/settings.json` from the session's own directory, and rules in a shared
project file apply once you trust the folder.

Your yes is bound to what the preview showed. The digest covers the exact rules, the recorded destination when a push rule is written, the canonical project
root, the real path of the file (every link followed, also when the folder does not exist yet) and the hash of
the file's current content. If any of them changes between the preview and your confirmation, for example a
`.claude` link that now leads to another folder, or an edit to the file, the confirmation is refused, nothing is
written, and init shows a new preview with a new digest that needs a new yes. The write checks again just before
it replaces the file and writes to the path that was shown. This does not lock the file: an edit made in the
instant between that last check and the replacement is not detected.

- A worker works in its own worktree. It sees `.claude/settings.json` only if the file is committed, or if
  `.claude` is linked into the worktree (`auto-setup.md`, "Worktrees"). If neither is true, the allowlist
  helps the orchestrator only.
- `.claude/settings.local.json` is read from the main checkout in every worktree of the repository, and Claude
  Code keeps it out of git. Pick it when you want workers to see the rules without committing anything. The
  check writes it only when the project root is the main checkout, and refuses in a linked worktree.
- A loose or tracked file can end up in a pull request: do not commit it with proof work unless you mean to
  share it.
- If `.claude` is a link, the check writes through it.
- Delete the lines to undo the change. Nothing else is touched. If the settings file is not valid JSON, or its
  `permissions` section has an unexpected shape, the check stops and leaves it alone.

Workers started by Agent Orchestrator run in the permission mode Agent Orchestrator gives them. The check
covers the session that ran init. If your workers run in another mode, check that mode too.

## What was tested

- Unit tests (node, no network): the helper's confirmation, merge, refusals and Codex file handling, the refusal
  while a `git push` allow rule is present, the confirmation
  binding (a `.claude` or `.codex` link retargeted between the preview and the confirmation, a changed file,
  another project root), the `recheck` entry point, and the push command: every refusal listed above, and real
  pushes into a throwaway local bare repository that stands in for the fork, reached through a stand-in for `ssh`.
  Nothing in them contacts GitHub.
- The Codex rules were run through `codex execpolicy check` on codex-cli 0.166.0 and again on 0.170.0: the file parses, each probe
  command is allowed, and `git push`, merge and other commands are not matched. The tests repeat this when a Codex
  CLI is installed.
- One live probe: the message step (`ao send` to a session that does not exist) was run in a Claude Code
  session.
- Not observed: a live Claude Code or Codex session showing that a written rule removes a prompt; the live `gh`,
  `git fetch` and Lake probes; a real push to GitHub through the push command; whether Claude Code screens a
  command substitution (`$(...)`) after the branch name against an allow rule, which its documentation does not say,
  or applies its documented checks of redirect targets and of each part of a compound command to the push rule;
  that Codex splits a shell wrapper before it matches rules; that the push command finds the same `git`,
  `PATH` and shell environment that a worker's shell uses. That is why init asks you to recheck. The recheck pushes
  nothing: its probe uses the branch name `fvs/.permission-check`, which git forbids and the push command refuses
  before it contacts anything. Do not make the first real push the test of the rule.

## After a first run: `/fewer-permission-prompts`

In Claude Code, `/fewer-permission-prompts` reads your session transcripts and proposes a list of common
read-only commands to allow. It needs transcripts, so use it after a first run, not before. It tunes the
list for your habits and does not know the run's steps. Read what it proposes: do not accept a rule that
allows a GitHub comment, review or merge, a force push or a push to an upstream. It is not available in Codex.

## A step still prompts

Work through these in order. Each is specific to a setup, so skip any that is not yours.

1. **The session has not loaded the file.** Claude Code watches settings files and reloads them, but a
   session started before the file existed may need a restart. Codex scans rules only when a session starts:
   open a new session, then ask init to recheck permissions (it runs `recheck`).
2. **An ask rule matches.** An ask rule beats an allow rule. Wildcard ask rules, such as one for any command
   containing `git merge`, match words anywhere in a command, including the text of an
   `ao send` message or a pull request body, so a harmless message that mentions a merge can prompt. Say what
   should happen in plain words ("combine the branches"), or narrow the ask rule so that it starts with the
   command.
3. **A hook asks.** A command hook before a tool call can ask even when a rule allows. A hook that guards
   pushes may ask for every push whose branch name it does not know. FVS cannot change your hook: change the
   hook, or approve those pushes yourself.
4. **A hook rewrites the command (for example `rtk`).** The permission layer then sees the rewritten command,
   so an allow rule written for `git fetch ...` does not match `rtk git fetch ...`, and a hook that rewrites
   `node` commands breaks the push rule the same way. Add a twin rule for the rewritten form, or exempt the
   command from the rewriting hook. Such hooks have also cut JSON output short.
5. **Managed settings** from an organisation can override a project file. `/status` in Claude Code names the
   sources.
6. **The step runs in a different mode.** A worker may use a mode that asks even though your orchestrator
   session does not.

An unanswered prompt is an uncertain outcome, not a refusal: see "Controller permissions in auto mode" in
`auto-setup.md` before you retry anything.
