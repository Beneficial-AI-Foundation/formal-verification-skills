<purpose>
The AO orchestrator's single entry for the auto track: show the compatibility profile with every
stage's readiness up front, reuse a current applicable agreement, or settle only the missing scope,
boundaries, conventions and execution choices with a short roadmap conversation, and record the
agreement. A missing agreement is a warning, never a stop. The goal and the pipeline are fixed; how the
agents get there is theirs to decide. Persist state only through `scripts/fvs-auto.mjs`. A stored
agreement is declared owner evidence, not proof acceptance.
</purpose>

<process>

## Goal

The project's source revision, scope, execution choices and agreement are recorded, the owner knows
up front which stages have a route, and the later stages need no further owner decision until the
spec pull request. Initial scope is what the owner actually agrees: the crates, modules and features
to verify.

## Pipeline

The whole auto track, so the owner sees where this entry leads:

1. `/fvs:auto-init` records the agreement (this command).
2. `/fvs:auto-extract` extracts the recorded revision with FVS's extraction and translation patches.
3. `/fvs:auto-top-specs` lists every public API item in the agreed scope, has an author write the
   statements per Rust file and a fresh adversarial reviewer check them (at most three rounds), and
   opens the spec pull request as a draft.
4. The owner reviews the spec pull request, marks it ready and merges it.
5. `/fvs:auto-execute` has workers prove one file per Rust item, complete first and improve later.
6. FVS's build check in a fresh clean copy decides what is accepted.
7. The proof pull request follows as a draft. Spec refactors found later arrive as new draft pull requests.

## GitHub rule

Agents may open draft pull requests and edit a pull request body. They never post comments or reviews
on GitHub, never mark a pull request ready and never merge: only the owner comments, marks ready and
merges.

## Step 1: Require Agent Orchestrator

```bash
AUTO="${CLAUDE_PLUGIN_ROOT}/scripts/fvs-auto.mjs"
command -v ao >/dev/null 2>&1 || {
  echo "FVS >> ERROR: the auto track requires the Agent Orchestrator ao CLI on PATH." >&2
  echo "Install Agent Orchestrator and put its ao CLI on PATH (see auto-setup.md), then rerun /fvs:auto-init." >&2
  exit 1
}
```

Stop when this fails. Agreement storage alone launches no workers.

## Step 2: Inspect existing state and evidence before asking anything

```bash
node "$AUTO" read-state --project-root .
```

Read `phase`, `warnings` and `nextAction` from the result. Call it plainly, without the strict
stored-context flag: the steps below never call the strict lane (see the last section).

- `no-state`: inspect the project and the profile, and synthesize the known facts for Step 3.
- `ok`: inspect `state.choices`, the extraction history and the latest `state.agreements`, if present.
  Do not ask Keep/Change or repeat an interview when the applicable agreement is current. Reuse the
  owner's actual earlier responses rather than asking again. Read the recorded agreement and the
  roadmap against the current request, and when they conflict settle only that decision with the owner.
  A project that already has an agreement goes straight on to the stage `phase` names, with no
  re-interview, after the one-time permission check of Step 5 when it has no permission record yet. A missing or outdated agreement is a warning: put it in the report, resolve only the
  affected setup through Steps 3 and 4, and do not hold the stages for it. When the owner asks for a
  material change, show only the affected choices and use those steps.
- `malformed-state` or `malformed-externals`: print `message` and `nextStep` verbatim and stop.
  Never repair, delete or overwrite the file.

The roadmap offer (`state.roadmap`, accepted or declined) is a historical preference, not an agreement
or authorization. A recorded decline is not asked again as an optional offer. The updated reader
accepts older state files without writing; an older strict binary may refuse the optional extension.
Never strip history or downgrade state to satisfy an older binary.

## Step 3: Establish only the missing agreement

For a fresh project, show the compatibility profile first:

```bash
node "$AUTO" profile --project-root . --format text
```

Its `stages:` lines say up front whether each stage has a route and what is missing, so the owner
learns of a gap before answering anything (`auto-setup.md`, "Probes and stage lines", explains them).
No probe is needed for setup or extraction, and a missing probe never stops it.

Fresh rc2 setup requires the declared Aeneas and Charon executables locally even for an externally
prepared, validated extraction. A missing executable still blocks `init-state`; preserve and report
its `profile-blocked` next step. After separately authorized prerequisite setup, rerun the profile and
resume this workflow. Executable presence does not qualify a tuple or replace the bound extraction's
identity, correspondence and eligibility checks; it does not require repeating a valid extraction.
Once a recorded extraction has succeeded, a missing Aeneas or Charon is a warning, and the run goes on to the
spec phase.

Keep the conversation short. Read the repository first, then propose a default for every choice and let
the owner confirm or change it, instead of interviewing from scratch. Use
`/fvs:roadmap .formalising/auto-fv/ROADMAP.md <the project goal>` with its existing light/deep/reuse
route. The owner agrees the scope as crates, modules and features, kept distinct from discovered
roots. `auto-top-specs` lists the public API items inside that scope later. Write the scope in the
agreement's `boundaries` and `claims`; its `mode` keeps the first-release name `nonpublic-intent`,
which does not limit the scope to non-public items.

Record only the missing owner choices, using the current applicable evidence for known ones:

- source revision and configuration/features (prefer an exact full commit; moving refs are not immutable);
- the agreed scope, boundaries, conventions and single-crate/monorepo layout;
- the observer set, named once: what a caller or user of the target can see and therefore must not be
  able to tell apart after a source patch (return values, errors as callers match them, external
  effects, panic occurrence and the file and line a panic reports), and what is deliberately not observed;
- concurrent workers (default 3), an optional explicitly chosen total budget, and an optional memory
  disposition (new choices use no elapsed budget and explicitly disabled memory unless a backend is configured);
- the repository the draft pull requests go to: the project's own repository, never an upstream, and
  separately from any delegated execution actions and limits.

New choices use `limits:{workers}`, `budget:{kind:"none"}` or an explicitly selected wall budget, and
`memory:{mode:"disabled"|"beads"}`. Follow `auto-execution.md` for cancellation and small-proof progress
diagnosis. There is no arbitrary per-node proof timeout. Existing v1 `nodeHours` stays inactive metadata,
not enforced; retain its original finite budget unchanged. Existing resource and spending limits are
never raised or reset automatically. The initial owner agreement is the setup human gate. Later
provisional specify/review/revise cycles are autonomous within it;
there is no per-round human contract approval.
The owner's merge of the spec pull request is the sign-off before any proof starts.
Final PR acceptance remains human. Agreement storage does not dispatch; Step 6 hands off to the stages.

Write the known and answered choices to a temporary file outside the project:

```bash
node "$AUTO" init-state --project-root . --input "$CHOICES"
```

`init-state` reruns and records the profile; never copy it into state by hand. On `profile-blocked`,
show every `blocking` item's verdict, reason and next step and stop. On `invalid-input`, resolve only
the named fields. On `confirmation-required`, show every listed change. Only on an explicit yes rerun
the same command with `--confirm-overwrite`; otherwise keep the recorded state. Existing applicable
explicit confirmation may be cited; never infer it. A confirmed material choice change advances the
persistent generation. Changing A→B→A cannot revive approval of A0.

## Step 4: Retain the exact approved context in the existing roadmap

Use exactly one current, unindented `fvs-auto-agreement` JSON fence in the roadmap's `## Decisions`
section (a heading such as `## Decisions log` also works). No separate agreement/config store. Keep
historical versions in state and distinctly referenced historical Decisions entries using ordinary
JSON fences; never duplicate the current marker. The bounded reader recognizes active ATX Decisions
headings and ignores complete fenced examples/standalone HTML comments. Unclosed/ambiguous markup,
mixed comment/prose lines and other raw HTML blocks refuse; use ordinary prose or closed code examples.
Only the documented active unindented triple-backtick tag establishes current context. LF/CRLF are
supported. Generic roadmap invocations outside auto-init do not require this auto-specific fence.

The closed envelope is:

```json
{
  "schema": "fvs/auto-agreement",
  "schemaVersion": 2,
  "mode": "nonpublic-intent",
  "payload": {
    "choicesGeneration": 0,
    "choices": {
      "source": { "revision": "<selected revision>", "configuration": "<configuration>" },
      "scope": "<owner-agreed initial scope>",
      "limits": { "workers": 3 },
      "budget": { "kind": "none" },
      "memory": { "mode": "disabled" }
    },
    "contextVersion": 1,
    "boundaries": ["<explicit boundary>"],
    "conventions": ["<agreed convention>"],
    "layout": "single-crate",
    "claims": ["<claim to establish>"],
    "trust": ["<trust and axiom policy>"],
    "acceptance": ["<acceptance evidence and authority>"],
    "ownerReserved": ["<human final PR decision and other reserved decisions>"],
    "execution": null,
    "draftPr": null
  },
  "ownerEvidence": { "reference": "<actual response reference>", "response": "<actual owner response text>" },
  "approvedPayloadSha256": "<computed canonical approval-payload SHA-256>"
}
```

This is a schema example, **not** an owner answer, limit or grant. Copy exact normalized choices and
`choicesGeneration` from the post-init state; absent generation means 0 for the first agreement.
`layout` is `single-crate` or `monorepo`. Boundaries/conventions may be explicit empty arrays; the other
text lists require at least one entry. An execution grant is null or
`{"actions":["<explicit delegated action>"],"reference":"<actual grant evidence>"}`; a draft-PR grant is
null or `{"destination":"<the project's own repository>","reference":"<actual grant evidence>"}`. Null
remains ungranted; an owner-response reference, roadmap offer or passing check grants neither by
inference. The draft pull requests of the later stages go to that recorded destination and nowhere else.

The observer set has no payload key of its own, and none may be added. Record it as one `conventions`
entry that starts with the fixed prefix `Observer set:`, listing what is observed and, after `Not
observed:`, what is not. Name it once, here; later equivalence gates and patch reviews cite this entry
instead of defining "observable" again. A project that has no auto agreement states the same set in an
`observer-set.md` file in the target's extraction workspace directory (`<extract_workspace>/<target>/`).

Prepare the actual payload and present its exact content/version in the initial discussion. The
drafting helper `fvs-auto-agreement.mjs`, installed next to the engine, builds it: the choices, the
choices generation and the state schema version come from the recorded state, so they are never
retyped, and the digest is computed by the engine's own `agreementPayloadSha256` (compact UTF-8 JSON of
`{schema,schemaVersion,mode,payload}` with recursively sorted keys, preserved array order and string
bytes, no newline). Write the owner-visible fields to a temporary `$DRAFT` JSON file: `layout`,
`claims`, `trust`, `acceptance`, `ownerReserved`, plus `boundaries`, `conventions`, `execution` and
`draftPr` where agreed. Then draft without creating an approval:

```bash
HELPER="$(dirname "$AUTO")/fvs-auto-agreement.mjs"
node "$HELPER" --project-root . --input "$DRAFT"
```

Without `ownerEvidence` the helper prints the payload and its digest and nothing else. It checks the
payload against the engine's own record rules on a scratch copy in a temporary directory outside the
project (a project-local `TMPDIR` is skipped), so a refusal appears now, naming the field. This dry run
writes nothing in the project. Show the owner the printed payload: the owner only confirms it.

Only after reading the actual applicable response/grants associate them with that exact payload: add
the owner's reply, word for word, to `$DRAFT` as `"ownerEvidence": {"reference": "<where the reply
is>", "response": "<the reply text>"}`. Never write that reply yourself. Human authenticity is declared
workflow evidence, not independent authentication. Run the helper again with `--out "$AGREEMENT"`, a
new file it never overwrites. Choose it outside the project's `.formalising` directory (a temporary
file is fine); the helper resolves links on both the destination and the `.formalising` directory (a
linked `.formalising` or `auto-fv` counts where it really lives) and refuses a destination under
`.formalising` or among the engine scripts, so it does not create or replace the state, the externals
record or the roadmap. A new file elsewhere, even inside the project, is allowed. These checks are
static; `auto-seats.md` says what they do not cover:

```bash
node "$HELPER" --project-root . --input "$DRAFT" --out "$AGREEMENT"
```

The helper then prints the finished fence and the one command only the owner runs. Put the fence under
the roadmap's `## Decisions` as the only current fence, then ask the owner to run the printed command
in their own terminal: it is `fvs-auto.mjs record-agreement`
with `--input` the new file and `--project-root` the project. The helper never records the agreement
and never edits the roadmap or the state. The record step compares actual retained content and never
treats a supplied hash alone as approval. When the owner has run it, read the state again (Step 2);
until then the missing agreement is a warning and the stages go on. `auto-seats.md` lists which seat
(owner, orchestrator or worker) runs each engine operation: only `record-agreement` is the owner's, and
the orchestrator runs the other state-changing steps itself, such as recording the extraction and the
externals.

A changed successor needs a greater `contextVersion` and explicit confirmation of the exact affected
agreement before `--confirm-overwrite`; the helper picks the next free version, and the command it
prints carries `--confirm-overwrite` only for a successor. History is retained. `unchanged` replays write
nothing. Missing, malformed, unknown or future mode, mismatched content or stale generation/context
refuses; show the actual reason and resolve only the affected agreement. No operation selects roots or
grants publication, launches workers, resets budgets or reinterprets `nodeHours`.

## Step 5: Check which run steps stop for approval

An approval prompt that nobody answers is aborted after about 30 minutes and the session that asked
stops; in one setup, waiting for approvals took most of the elapsed time. So, while the owner is
present, check which steps of the run prompt on this machine, and offer a small allowlist for exactly
those, and for a push the one rule that names the FVS push command. `auto-permissions.md` has the steps, the
rules, the reason for each rule, the push command, what FVS never allows, what was tested and the
troubleshooting notes. Run
the check once: a project that already has a record is not checked again, unless the owner asks to check
permissions again (Recheck on request, below).

The check needs the repository the draft pull requests go to (the agreement's `draftPr.destination`, or the
repository the owner named in Step 3: the project's own, never an upstream), the git remote that points at
it (usually `origin`), its host if it is not `github.com` (`--host`), and the branch namespace workers push
under (default `fvs`; ask the owner once, and never `main`, `master` or a release name).

```bash
PERM="$(dirname "$AUTO")/fvs-auto-permissions.mjs"
node "$PERM" plan --project-root . --repo "$DRAFT_REPO" --remote origin --branch-prefix fvs
```

- `record.present` true: print its `summary` for the report line, say nothing more, and go to Step 6 (after
  "Where pushes go" below, unless `pushDestination.status` is `matches`). The one exception is the owner's request to
  check permissions again: see "Recheck on request" below.
- `legacyPushRules` present (Claude Code): a project settings file already has a push allow rule. Show the
  owner the listed entries before you probe. FVS deletes none of them, and a Claude `write-allowlist` refuses
  until the owner has removed those entries; the push probe may also be quiet because of them, not because of
  the push command. Go on with the check if the owner wants, and say that writing waits for the cleanup.
- `remote-mismatch`, `remote-ambiguous`, `remote-missing`, `remote-credential`, `destination-rewritten` or
  `invalid-input`: no probe runs against a remote that is not the project's own repository. Every URL of the remote
  (all fetch and push URLs) must name it, and no `insteadOf` or `pushInsteadOf` rule may rewrite the push address
  again. `remote-credential` means an http or https address has user information (`https://user:token@host/...`),
  whether the remote holds it or a git setting adds it: the address is written down and shown, so the owner uses a
  credential helper or an ssh address. Report the refusal, skip the check and go to Step 6.
- `not-a-repository` or `worktree-mismatch`: the project root is not a git work tree, or a `core.worktree` setting
  points the repository at the files of another one. The push command would refuse in each case, so nothing is
  recorded. Report the refusal, skip the check and go to Step 6; the owner has to fix the repository first.

**Where pushes go.** The push command (`fvs-auto-push.mjs`) pushes to the destination that init records, so
record it whatever the check finds: also when the owner skips the check, and also for a project whose check was
recorded earlier (`pushDestination.status` is not `matches`). It is a separate yes. Run `write-destination` without
`--confirm`:

```bash
node "$PERM" write-destination --project-root . --repo "$DRAFT_REPO" --remote origin --branch-prefix fvs
```

It writes nothing and refuses with `confirmation-required`, printing the `record` (the push address as git will use
it after its own rewriting, the host, the repository, the branch namespaces, the project root and the git
directory), the `file` (in the repository's shared git directory, so no commit contains it), a `note`, the
`gitConfigVariables` (every git configuration variable that is set in this session and can be trusted, by name with
the length of its value, never the value) with its `gitConfigNote`, the `contract` (what the push command checks, hardens and trusts) and a digest. Show the owner
exactly that, with the contract as printed, and ask. The yes also trusts the names of those variables: the push
command keeps each of them with whatever value it has when it runs, drops every other name, and does not refuse a
value that changed (the receipt marks it). `GIT_CONFIG_COUNT` and the pairs it addresses are one unit. The owner
trusts them as they trust their own `~/.gitconfig`. Say that a value can be a credential, so the preview never shows
it and the record keeps only a hash, for information. A variable that is not set when the owner confirms stays
untrusted: if one holds a token the owner does not want trusted, the owner unsets it and runs this step again. Run
this step in the environment the workers will have. Only on the yes, rerun the same command with `--confirm <digest>`. On a no,
nothing is recorded: the push command then refuses to run (`no-destination-recorded`), workers stop and report that
refusal instead of falling back to `git push`, and the owner pushes branches by hand. If
`pushDestination.status` is already `matches` there is nothing to do (`unchanged`): a value that rotated since the
record was written is no difference. With `confirmation-required` and a `replaces` field, the record exists with the
same destination and another set of trusted names: show `replaces` (the old record), `record` (the new one),
`variableChanges` (added, removed, kept), `replaceNote` and `gitConfigVariables`, and ask for a separate yes; on it,
rerun with `--confirm <digest>` and the record is rewritten (`replaced`). With `destination-conflict` another
destination, or a record that is not valid, exists: show `existing` and `record`, and name the variables in
`changedVariables` when it is printed. FVS replaces a record only to change its trusted names, never the
destination: to change the destination itself, the owner checks the file, deletes the record on purpose and runs
init again.

Otherwise ask the owner whether to run the check or skip it. A skip is recorded with every step as
`unknown` (below) so that a resume does not ask again.

**Tell the owner first**, in these words or close to them: some of the next commands may stop and ask you
to approve them; please approve each one when it appears, that is what the check is for. None of them posts
to GitHub or pushes anything. They send a message to a session that does not exist, write one scratch file
under `.formalising/`, compile it (only when the project's dependencies are already downloaded), read pull
requests, fetch, and run the push command with a branch name that cannot exist, which it refuses before it
contacts anything. Say also that "low-risk" is not "inert": Lake evaluates the project's own lakefile and can write
build caches, and git runs any hook configured for a fetch.

Then run every probe of the `plan` output as its own plain call: one `Bash` call per command exactly as
printed, with no `&&`, `;`, pipe, `cd` or wrapper, and the scratch file with the `Write` tool (its `path` and
`content` are in the plan; if the file already exists from an earlier run, `Read` it first, because `Write`
refuses to replace a file it has not read). A command that fails is fine; the question is only whether it
stopped and asked. Do not retry or reshape a command that was refused outright. A step with `skipped` in the
plan has no probe (Lake would download a missing dependency): do not ask about it, tell the owner why, and
record it as `unknown`.

**You cannot see prompts**, so ask. Two multi-select questions with at most four options each, each with a
"none of these" option: first `worker-message`, `author-edit`, `lake-build`; then `gh-read`, `git-read`,
`git-push`. The owner's answer is the result. Write it to a temporary file outside the project and record it:

```bash
node "$PERM" record --project-root . --repo "$DRAFT_REPO" --remote origin --branch-prefix fvs --input "$ANSWER"
```

`$ANSWER` is `{"runtime":"claude","kind":"check","results":{"<step>":"prompted"|"quiet"|"unknown"}}`
with one entry for each probed step (`"runtime":"codex"` on Codex).

If nothing prompted, say so and write nothing. If some steps prompted:

1. Show the owner `auto-permissions.md` in plain words: the rules for those steps and why each exists; what
   FVS never allows (GitHub comments, reviews, merges, and every push that is not made with the push command);
   and that an unanswered prompt aborts after about 30 minutes. A `git push` never gets an allow rule. If
   `git-push` prompted, explain the push rule: it names the FVS push command
   (`node <scripts folder>/fvs-auto-push.mjs --branch fvs/<name>`), which pushes one branch under the namespace
   to the recorded destination. A `*` in a rule matches the rest of the command text, so the rule cannot check
   arguments and the command does. Say what the command is as the helper prints it (`pushContract` in the `plan`
   output, `contract` in every preview), not in your own words: it is a cooperative guard with hardening and not a
   security boundary. It checks its own command line, the repository and the destination. It does not run
   repository hooks for the push (it passes `--no-verify` and reads no hooks folder), so the owner's own pre-push
   checks do not run for it, and it drops the listed git environment variables, except the git configuration
   variables whose names the owner trusted in the destination step: it keeps those with whatever value they have
   when it runs, and does not refuse a value that changed. It trusts the owner's git setup, as any push the owner runs: ssh and transport
   wrappers, credential helpers, URL rewrite rules, the record file and FVS itself, so anything that runs as the
   owner's user. Also say that a worker that runs a plain `git push` is not covered, and that the owner's other
   rules and permission mode decide it. Say that branch protection on the fork is still recommended. Never
   promise that a push will be asked about.
   On a no, leave `git-push` out of `--steps`: that prompt stays unresolved and the owner approves pushes as
   they appear. Codex gets the same rule as a prefix rule for the program and `--branch`: say that it cannot
   tell `fvs/work` from `main`, and that the command refuses a name outside the namespace.
2. Run `write-allowlist` without `--confirm` for the steps the owner agreed to, for example
   `node "$PERM" write-allowlist --project-root . --repo "$DRAFT_REPO" --branch-prefix fvs --runtime claude --steps worker-message,git-push`
   (add `--host HOST` when the repository is not on `github.com`). It writes nothing and refuses with
   `confirmation-required`, printing the file, its real path (`resolvedPath`, `viaLink`), its `gitStatus` and
   where it applies (`appliesTo`), the exact rules, for `git-push` the push command and the recorded destination
   (`push`), and a digest. Show the owner exactly that preview. Offer `--target local`
   (`.claude/settings.local.json`, read from the main checkout by every worktree and kept out of git) beside
   the default shared file; the push rule names this machine's copy of the script, so the local file is the
   better home for it. On Codex, use `--runtime codex`; it writes only the rules Codex can express. Other
   answers to this command, each reported plainly and never worked around:
   - `nothing-to-write` (Codex): none of the steps that prompted can be a Codex rule (push, Lake and edit
     steps cannot). Say so: those prompts stay unresolved, and the owner approves them when they appear. Do
     not ask for a confirmation and do not recheck.
   - `rules-file-conflict` (Codex): `.codex/rules/fvs-auto.rules` exists and differs. Show `existing` and
     `wouldWrite`. FVS neither replaces nor merges it; the owner saves any rule of their own, deletes the file
     and writes every step they want in one command.
   - `destination-not-recorded`: the push rule needs the recorded destination, and it is missing or no longer
     what init would record. Do "Where pushes go" first, then run this command again.
   - `legacy-push-rules` (Claude): `.claude/settings.json` or `.claude/settings.local.json` already allows a
     push by rule. Show `legacyPushRules` and `cleanup`: for each file the exact entries to delete and how many
     other entries stay. FVS deletes nothing and writes nothing, and you do not edit the file either: the
     owner removes exactly those entries and runs init again. Say what `notExamined` lists.
   - `changed-since-preview`: the file or a link in front of it changed while the command ran. Nothing was
     written. Run the command again without `--confirm`, show the new preview and ask again.
   - `evaluator-rejected` or `evaluator-mismatch` (Codex): the installed Codex rejects the rules or does not
     allow a probe command. Nothing was written. Show `evaluation`.
   - `malformed-settings`: the settings file is not valid JSON, or its `permissions` section has an
     unexpected shape. Leave it alone and tell the owner.
3. Only on the owner's explicit yes, rerun the same command with `--confirm <digest>`. Never pass a digest
   the owner has not seen, and never write without the yes. The digest covers the rules, the recorded destination for a push rule, the canonical project
   root, the real path of the file and the hash of its content: if any of them changed since the preview
   (a `.claude` link now leads elsewhere, or the file was edited), the command refuses with
   `confirmation-required`, writes nothing and prints a new preview with a new digest. Show that new preview:
   the new digest needs a new yes, and the old yes does not carry over. A decline writes nothing and the run
   goes on; the steps that prompted then wait for the owner's approval during the run.
4. Report where the file landed (`realPath`) and its `gitStatus` (a loose or tracked file can end up in a
   pull request; `unknown` means git cannot say, as for a file reached through a link). On Codex, report `verified`: `true` means the installed Codex (name its `evaluator.version`)
   allowed every probe command against the exact content before it was written, which checks the rules and not
   a live session; `false` means nothing verified the file, and `message` says why. Do not say the rules work.
5. Recheck, which depends on the tool. The entry point is the `recheck` command (next section), never a
   second `plan` and never deleting the record:
   - Claude Code: run `recheck --steps ID,ID` now, naming the steps whose rules were just written (without
     `--steps` it lists every step that last prompted, including steps the owner declined), run the probes it
     lists, ask again which prompted, and record the answers with `"kind":"recheck"`. A step that still prompts: show the owner the "A step still prompts" section of
     `auto-permissions.md` and leave it at that. `recheck` lists the push probe too: it is the push command with a
     branch name that cannot exist, refused before it contacts the fork, so it shows only whether the permission
     layer lets the command run unasked. Say that the first real worker push is the evidence for the rule.
   - Codex: rules load when a session starts, so a recheck in this session proves nothing about them. Do not
     run `recheck` now. Tell the owner to start a new session after the project's `.codex/` folder is trusted
     and ask init to recheck permissions there, and record that round as a recheck. Never say that a prompt
     cannot be fixed because of a retry in this session. The summary says that the recheck is pending.

**Recheck on request.** When the owner asks to check permissions again (for example "recheck permissions" in a
new Codex session, or after they removed a rule or changed a setting), a record already exists, so the
resume rule above does not apply to this request. Run:

```bash
node "$PERM" recheck --project-root . --repo "$DRAFT_REPO" --remote origin --branch-prefix fvs
```

It needs a record (`no-record` otherwise: run the check first). It lists the probes of the steps whose latest
answer is `prompted`, or of the steps named with `--steps ID,ID`, with the same skips as `plan`. If `steps` is empty, say there is nothing to repeat. Otherwise tell the owner first, as in the check,
run each probe as its own plain call, ask which prompted, and record with `"kind":"recheck"`. A recheck writes
no rule and no destination record.

Never write any rule by hand, never allow a GitHub comment, review or merge, never write a rule for `git push` or a deny
rule, and never edit a settings or rules file other than through the command above. Agreement storage and
this check launch no workers.

## Step 6: Hand off to the stages

With a recorded agreement, or its absence reported as a warning, the pipeline above takes over and the
orchestrator does not ask the owner to launch each stage. `/fvs:auto-extract` comes next, then
`/fvs:auto-top-specs`, which ends at the draft spec pull request. Fill operational inputs from the
recorded state and existing decisions; a genuinely missing capability or input is partial, not another
scope interview. Do not infer dispatch permission from a stored agreement, a remembered grant, a partial
result or a worker verdict.

## Step 7: Report

Use the refreshed post-init or post-record state, not the pre-init `no-state` result. Print:

```
FVS >> AUTO-INIT

State:            revision {revision} ({configuration}); scope {scope}; resources {workers} workers; budget {none | original explicitly selected deadline | literal legacy v1 budget}; extraction {not run | succeeded | failed}; agreement {missing | outdated | recorded}
Next action:      {the next stage, the partial reason, or the standalone extraction continuation}
Warnings:         {the warnings from read-state, such as a missing agreement, or none}
Stages:           {the profile's stage lines, one per stage, as printed}
Draft PRs:        {the recorded destination repository | not recorded}
Permissions:      {the `summary` of the permission record, which names the steps that will wait for the owner's approval | not checked | skipped by the owner}
Memory:           {explicitly disabled | enabled: its status from the strict lane below}
Pending decision: {only affected missing initial decisions, or none}
```

Report the script's actual refusal or next step when blocked. Successful agreement storage is agreement
and scope readiness only. The engine's `nextAction` string is a suggestion, not executable authority.
Report only actual current checker receipts and whole-scope gaps.

## Optional strict lane

Everything above works without this section, and the relaxed path never calls what is in it: the
stored-context gate (`read-state` with its strict flag), the memory commands, owned work, the driver,
the review bundle and the re-specification command. Use it only when the owner wants the strict graph
lane and `probe-lean` works, or when the agreement records enabled Beads memory. The strict lane's
human re-specification is not available in 3.0.0-rc3; on the relaxed path a spec refactor is a new
draft pull request.

### Stored-context gate AND semantic applicability check

```bash
node "$AUTO" read-state --project-root . --require-agreement
```

A refusal stops the strict route; nothing on it is dispatched without an agreement. `agreement-required`
means the state has no initial agreement. `stale-agreement` requires an explicitly approved successor
for the current choices generation; reverting values does not revive an old generation.
Missing/duplicate/changed, unknown or superseded current context and changed retained owner evidence
also refuse. Malformed state never gets repaired. Earlier extraction records remain readable.

Success is narrowly `agreement.status: stored-context-current`. Before reporting **applicable**
agreement readiness or using it, read the actual referenced owner response and the current roadmap
Goal, Claims to establish, Assumptions and external boundaries, scope/conventions/layout and
Owner-reserved decisions together with non-superseded Decisions. Compare their effective intent to
the marked payload, current request and selected source/configuration. A moving revision is not a
source-identity receipt. A conflicting/missing/superseding canonical statement stops the affected
decision even if the stored gate succeeds. This mandatory workflow check cannot be replaced by an
agent approval header or a CLI hash; the CLI does not classify natural-language prose or authenticate
its author.

A material goal/claim/trust/scope/configuration change updates the explicit context/version and
reconsiders only affected decisions. Routine Status log appends outside the fence, permitted helper
contract/proof revisions and ordinary progress within the agreement do not cause new owner questions.
Never refresh approval from candidate-generated contracts. Record declared uncertainties and report
outside/unresolved discovered roots before any later dispatch; never silently add them or reduce scope.

### Memory

When the strict lane reuses a current agreement it proceeds to the recorded memory disposition below.
Every start/resume needs its own current request; enabled memory also needs the fresh prime: never
reuse an old memory-ready result.

For disabled memory, retain the explicit disabled disposition and continue with
`memoryRequest:null`; no backend command or substitute prime receipt is produced. For enabled Beads,
follow the existing bootstrap path below. Existing v1 records keep their original memory requirements.

Follow `auto-memory.md` after the stored-context AND semantic applicability checks. Use the recorded
canonical primary control root and existing store, never worker-cwd discovery or FVS's development store.
Register it through the state operation when needed; do not initialize/migrate a missing real store:

```bash
node "$AUTO" record-memory --project-root "$PRIMARY" --input "$REGISTRATION"
```

The caller owns a fresh UUID, actual target project/session/resume identity and expected canonical
binding/context. Prepare and retain its current request before invoking a route. For a resume, follow
the resume paragraph below and `auto-resume.md`; its `state` operation performs this fresh memory
refresh and independent consumption. The standalone coordinator route remains:

```bash
node "$AUTO" refresh-memory --project-root "$PRIMARY" --request "$REQUEST" --out "$MEMORY_OUT"
```

Workers on start/resume use a separate fresh `worker-readonly` request and the read-only route:

```bash
node "$AUTO" prime-memory --project-root "$PRIMARY" --request "$REQUEST" --out "$MEMORY_OUT"
```

This route rejects refresh selectors. Verify actual request-bound prime bytes through `verifyMemoryBootstrap` against the
caller's independently held request, then read/inject the text; status/hash alone or a returned request
is insufficient. Missing/stale/malformed/foreign store/context, partial output, wrong identity or drift
stops readiness with its actual reason. No automatic setup, task queue, worker launch or receipt/proof
authority is introduced. Current target IDs come from caller context, never a new owner policy interview;
if the necessary invocation context is unavailable, report that missing input and stop continuation.
The configured memory adapter reports current memory-primed; the resume coordinator records checkpoints
and current observations. Local FVS-development Beads is not target-project memory.

### Resume

On a resume, read `auto-resume.md`: prepare the fresh caller-owned request from the actual AO
associations, Git inputs and recorded accounting, call `state`, then consume it with
`verifyReconciliation` against that same independently held request. Stop on partial, missing or
uncertain context with its actual reason, and preserve all reservations and original budgets. The
strict graph lane, when `probe-lean` works, follows `fv-skills/references/auto-transitions.md`.

</process>
