<purpose>
Record the auto track's minimal setup state for the current project: the compatibility profile,
the owner's source revision and configuration, the bounded initial scope and the execution and
resource limits. Offer the project roadmap once. Every write goes through `scripts/fvs-auto.mjs`,
which writes atomically, validates the schema and never overwrites a malformed file or a recorded
owner choice without confirmation.
</purpose>

<process>

## Step 1: Require Agent Orchestrator

```bash
AUTO=~/.claude/scripts/fvs-auto.mjs
command -v ao >/dev/null 2>&1 || {
  echo "FVS >> ERROR: the auto track requires the Agent Orchestrator ao CLI on PATH." >&2
  echo "Install Agent Orchestrator and put its ao CLI on PATH (see auto-setup.md), then rerun /fvs:auto-init." >&2
  exit 1
}
```

Stop when this fails.

## Step 2: Read the recorded state

```bash
node "$AUTO" read-state --project-root .
```

Read the `code` field of the JSON result:

- `no-state`: a fresh project; continue with Step 3.
- `ok`: show the recorded choices (`state.choices`), the extraction status and `nextAction`. Ask the
  owner whether to keep them or change any of them (AskUserQuestion: "Keep the recorded setup" /
  "Change a choice"). On keep, skip to Step 6 without writing anything.
- `malformed-state` or `malformed-externals`: print `message` and `nextStep` verbatim and stop.
  Never repair, delete or overwrite the file.

## Step 3: Show the compatibility profile

```bash
node "$AUTO" profile --project-root . --format text
```

Show the output as is. Each item that is not green has one `next:` line; `auto-setup.md` explains
every verdict. `init-state` reruns the profile itself and records that result, so nothing from this
output is copied into the state by hand.

## Step 4: Ask the owner

Ask with AskUserQuestion, one question per choice, starting from the recorded value on a rerun:

- **Source revision**: the exact revision to extract, preferably a full commit hash (a tag or
  branch moves; it is resolved again when the extraction is recorded).
- **Configuration**: the cargo features, target and extraction options that define the build.
- **Initial scope**: the bounded part of the crate to start with (a module or a short list of
  functions), not the whole crate.
- **Limits**: concurrent workers (default 3) and one total wall-clock cap in hours, which has no
  default: the owner names it. The per-node hours (`nodeHours`, default 2) are recorded metadata only
  and not enforced: milestone 1 runs no proofs, and the owner has decided there is
  no arbitrary per-node proof timeout. Keep the default unless the owner wants to note another value.

Write the answers to a temporary file outside the project and run `init-state`:

```bash
CHOICES="$(mktemp)"
cat > "$CHOICES" <<'JSON'
{
  "source": { "revision": "<revision>", "configuration": "<configuration>" },
  "scope": "<initial scope>",
  "limits": { "nodeHours": 2, "workers": 3, "wallClockHours": <cap> }
}
JSON
node "$AUTO" init-state --project-root . --input "$CHOICES"
```

## Step 5: Act on the init-state result

Read the `code` field:

- `created` or `updated`: the state is written.
- `unchanged`: the recorded state already holds these choices; nothing was written.
- `confirmation-required`: show every entry of `changes` (field, recorded value, requested value)
  and ask the owner to confirm them. Only on an explicit yes rerun the same command with
  `--confirm-overwrite`; otherwise keep the recorded state.
- `profile-blocked`: print every `blocking` item with its verdict, reason and next step, and stop.
  Nothing was written; rerun `/fvs:auto-init` after following those steps.
- `invalid-input`: show `errors` and ask again for the affected choices.
- `malformed-state`: print `message` and `nextStep` and stop.

## Step 6: Offer the project roadmap

Make this offer only while `roadmap` is in the `pendingDecisions` of the `init-state` result from
Step 5 (the state just written), or when the owner asks for it. When Step 2 kept the recorded setup
without running `init-state`, use the `pendingDecisions` of that `read-state` instead. Never use the
pre-init `no-state` result: it has no pending decisions. A recorded decline is not asked again.

Ask: "Write the project roadmap now? It records the claims, scope, external boundaries and
milestones of this verification project in `.formalising/auto-fv/ROADMAP.md`. It is optional and
extraction does not wait for it."

- Yes: `node "$AUTO" record-roadmap --project-root . --decision accepted`, then run
  `/fvs:roadmap .formalising/auto-fv/ROADMAP.md <the recorded scope as the goal>`. An existing
  roadmap there is updated by that command, never rewritten.
- No: `node "$AUTO" record-roadmap --project-root . --decision declined`.

When the owner asks to change a recorded decision, pass `--confirm-overwrite`. The proof graph and
`state.json` are machine state and never become issues.

## Step 7: Report

Run `read-state` again and print:

```
FVS >> AUTO-INIT

State:            revision {revision} ({configuration}); scope {scope}; limits {workers} workers, {wallClockHours} h total (per-node hours {nodeHours} recorded, not enforced); extraction {not run | succeeded | failed}
Next action:      {nextAction}
Pending decision: {pendingDecisions, or none}
```

When the run stopped early, print the same three lines with the reason as the state and the
script's `nextStep` (or the profile's next steps) as the next action.

</process>
