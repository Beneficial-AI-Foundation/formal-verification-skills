<overview>

How to get from a clean host to a recorded auto-init state when you are new to functional-correctness
verification: what you install yourself, how to check each tool, what each compatibility verdict means
and what the single next step is, how to keep `.formalising/` out of git, and which operation, tuple
and platforms have a recorded run. It also covers running the auto track under Agent Orchestrator and
Codex: permission and command habits that keep a run from stalling, worktrees and per-worktree installs,
the project config and the model rule, Codex trust, which steps only the owner runs, a `/goal` wording
that accepts an owner gate as done, rule changes reaching live sessions, and how reports link
artifacts. It also says what the five probes add, which stages need them (none is needed for setup or
extraction), how to point FVS at a probe installed elsewhere, and how to read the profile's stage lines.
The guide separates explicit owner-run FVS setup from read-only
prerequisite checks and makes no claim beyond the tested matrix at the end. `TESTED_TUPLES` in `scripts/fvs-probe-inventory.mjs` is the authority; the
matrix mirrors it and a test keeps the two in step.

</overview>

## Rc1 exact-source installation

Use this checklist for the `3.0.0-rc1` selected-target SWVF preview. An approved immutable source pin
and its qualification report identify the candidate; a version string, a floating branch or a stable
marketplace/npm installation does not. Record remaining runtime qualifications honestly. Whole-libcrux
extraction and a full pilot are separate from preparing this installation.

1. **Prepare the host.** Install AO and make `ao` available. Keep the selected harness's existing
   authentication and inspect its actual roles, model/effort and permissions. The source installer
   needs Node and Git; the current Claude actor permission helper also needs Python 3 and
   `/usr/bin/git`. The package's declared Node floor is not a tested SWVF compatibility matrix.
   Install/update only through the owner's chosen route and consent. Use the prerequisites below for
   user-assisted Aeneas/Charon, Rust and Lean setup; keep every project pin unchanged. Run the
   read-only profile and resolver before extraction. FVS installs none of those tools.
2. **Select one complete source snapshot.** Acquire the agreed full SHA through the normal permission
   gate, retain it at an absolute path, and verify its actual HEAD, clean status, package version and
   `fv-skills/VERSION`. Set these variables to actual values; the SHA placeholder is not an install pin:

   ```bash
   FVS_SOURCE="/absolute/retained/fvs-source"
   FVS_SHA="<approved full 40-character commit SHA>"
   WORKTREE="/absolute/selected/actor-worktree"
   test "$(git -C "$FVS_SOURCE" rev-parse HEAD)" = "$FVS_SHA" || exit 1
   FVS_SOURCE_STATUS=$(git -C "$FVS_SOURCE" status --porcelain=v1 --untracked-files=all) || exit 1
   test -z "$FVS_SOURCE_STATUS" || exit 1
   test "$(node -p 'require(process.argv[1]).version' "$FVS_SOURCE/package.json")" = "3.0.0-rc1" || exit 1
   test "$(cat "$FVS_SOURCE/fv-skills/VERSION")" = "3.0.0-rc1" || exit 1
   ```

3. **Install only in the agreed scope.** Inspect existing FVS installations/local patches first and
   choose one channel per runtime. After permission for these exact local writes, the existing
   complete-source Claude route is:

   ```bash
   node "$FVS_SOURCE/scripts/build-hooks.js"
   test -f "$FVS_SOURCE/hooks/dist/fvs-check-update.js" || exit 1
   test -f "$FVS_SOURCE/hooks/dist/fvs-statusline.js" || exit 1
   (cd "$WORKTREE" && node "$FVS_SOURCE/bin/install.js" --claude --local)
   ```

   Run the hook build once per retained source snapshot before actor installs. A raw Git checkout
   omits ignored `hooks/dist`; the build copies the two source hooks without installing dependencies.
   Verify their installed bytes as well as the helper scripts. Keep the retained source fixed afterward.
   Use the selected runtime's existing flag instead of `--claude` when that route is qualified.
   For Pi's complete local-source package use `(cd "$WORKTREE" && pi install "$FVS_SOURCE" --local)`;
   retain that exact source snapshot. The unified `--pi` installer delegates to npm, so it cannot
   install an unpublished source pin. Exact registry prereleases are accepted by `--pi-version`
   only when the requested version is actually published. Plugin users need the actual plugin root
   and runtime role/capability checks; a stable catalog entry is not an rc1 pin.
4. **Verify every actor installation.** Reload/start the normal session when the owner is ready.
   Read its installed version and manifest, compare the actual scripts to the selected source, and
   check role/tool access from that actor. Repeat for each AO worker worktree: ignored local installs
   do not propagate through Git ("Agent Orchestrator setup" below covers worktree installs). To share
   one local install instead, link each entry the install put under `.claude`, one by one, into a
   real per-worktree `.claude` folder. Linking the project's shared
   `settings.json` this way is fine: it holds the hooks, status line and project-wide rules, like a
   committed project settings file. Never link `.claude` itself or `settings.local.json`: that file
   receives each actor's permission grant, so it must stay a real, single-link file in each worktree
   (AO writes it there). The actor permission helper refuses a linked `.claude` folder or a linked
   `settings.local.json`, because a grant written there would reach every worktree that shares it.
   AO created this nested layout from per-entry links on AO 0.14.10 in a throwaway project, and the
   helper then verified the grant; recheck on another AO version. Rules kept in the main clone's
   `settings.local.json` stop reaching worktrees under this layout, and only worktrees created after
   the change get it. Keep one fixed trusted engine identity across the run. Local shell
   paths resolve to the selected installation even from a nested cwd; plugin resources remain rooted
   at the plugin, and Pi resolves package-relative resources from its skill directory.
   For Claude's Lean MCP tools, the project `.mcp.json` server key must be `lean-lsp`
   (`mcpServers.lean-lsp`); the executable/package name is `lean-lsp-mcp`. FVS agent allowlists use
   that server key. Preserve existing MCP entries and the project's pinned tools/resource caps.
   Configure it before native startup, or use a normal reload and verify actual tool discovery.
   Dependencies must be available before its first Lean diagnostic; installation alone proves neither.
5. **Initialize project choices through `/fvs:auto-init`.** Reuse the existing initial agreement.
   Select source/features, roots, worker/resource limits and execution authority only where missing.
   Recommend local markdown issues for a new preview; preserve any existing tracker choice and use
   `/fvs:issues-setup` for an explicit change. Beads memory does not duplicate that task queue.
   Fresh rc1 setup requires the declared Aeneas and Charon executables locally even when resuming an
   externally prepared, validated extraction. Missing executables still produce `profile-blocked`;
   the retained witness does not bypass that presence check. Installing them does not qualify the
   tuple or replace the extraction's identity, correspondence and eligibility checks. Rerun the profile,
   not the extraction, when the only missing prerequisite was executable presence.
6. **Choose optional memory.** Explicit `memory:{mode:"disabled"}` needs no Beads installation or
   prime. Enabled memory currently uses an existing Beads `1.3.1` embedded/direct store in one primary
   control checkout. Follow `auto-memory.md` to inspect/register that actual store, coordinator-refresh
   it and verify a fresh prime. Missing/unsupported stores require separately authorized setup;
   installing FVS never runs `bd init`, migrates a store or changes Beads settings. Every linked actor
   uses the primary store and its own `worker-readonly` request with its actual caller worktree.
   Fresh startup/resume primes are request-bound; an old ready flag is insufficient. Do not create a
   backing database in each worktree. Remote hosts/independent clones need separately qualified setup.
7. **Run only the granted preview.** Initial scope/permissions and the final human decision remain
   explicit; routine stage transitions use the existing grants. Missing real provider access,
   unavailable extraction tuples or unsupported target shapes remain named partial/blocked outcomes.
   Report which checks used real tools and which used doubles. This setup grants neither publication
   nor the held public-API path. Keep Lean threads at the agreed cap (here `LEAN_NUM_THREADS=2`),
   serialize heavy work and use only controls available in the project's pinned build tools.

Known rc1 issue: a failed worker launch can leave an uncertain reservation with no rc1 closure route.
Stop and retain the old run as a partial, preserving failed-attempt history and applicable limits/accounting.
Start a fresh run root only after the old launch and any created session are conclusively stopped or absent
and existing authorization covers the new attempt. If termination remains uncertain, HOLD.
A fresh root is not a same-run resume; do not synthesize an after-event or delete the pending reservation.
The same applies to a released work packet that its worker can never acknowledge, such as one whose start
marker is not beside the packet file: rc1 has no route to close or re-issue that reservation, so recover in a
fresh run root under the rules above. Release preparation now refuses such a packet before it is sent. An
ordinary acknowledgement that is only still pending is not this case: wait, or recover delivery of the same
handle with `--recover-only`.

Rc1 status: rc1 has no tracer acceptance or rejection. Tracer run 3 (engine `91e9443`) exercised setup through
specification composition only.

Known rc1 issue: a released specification author cannot be closed, so its nodes cannot reach review in the
same run. This manual unblock is an owner-run recovery, not the automatic path from no specifications. It uses
shipped commands only, and only under the fresh-root conditions above: the old run's work is conclusively
stopped or absent, existing authorization covers the new attempt, and the old run's accounting is retained.
1. Create a fresh run root whose primary is the commit with the composed specifications, and complete the
   rc1 setup above, including `lake exe cache get` for projects whose pinned packages provide it.
2. Run `/fvs:auto-init` in that primary, and HOLD continuation after it: `/fvs:auto-init` continues
   automatically once its context is complete. Do not let the controller propose or launch anything until
   steps 3 and 4 are done; otherwise it can launch another specification author.
3. Before the first proposal, register each node's contract in dependency order (helpers first), without
   `--review`. `FVS_SCRIPTS` is the trusted engine's installed scripts directory:
   `node "$FVS_SCRIPTS/fvs-contract-registry.mjs" register --plan "$PLAN" --graph "$GRAPH" --registry "$REGISTRY" --spec-root "$PRIMARY" --contract "$CONTRACT"`
   Exit 6 with state `needs-review` is the expected result, not a failure.
4. Read the registry head with the same tool's `status` and the same `--plan`, `--graph`, `--registry` and
   `--spec-root`.
5. Resume the bootstrap recipe in `auto-transitions.md` with the current registry head, the bound plan and
   graph, and no old assignment. With eligible nodes, a fresh reconciled context and no live assignment, its
   first proposal is `review-or-revise`. The normal review route then continues through the reviewer's close:
   AO's `session kill` may remove the reviewer's worktree, and the stop records that absence (see the
   retirement paragraph in `auto-transitions.md`).

Each contract file must pass the registry's contract checks against the files at `--spec-root`, and must name
its real author. The reviewer must be a different session and run. Never hand-write start markers, progress or
completion records.

Known rc1 issues, untested in v2:
- Closing a proof worker after a completed proof.
- A failing canonical check: the checker returns a typed error (for example `audit-failed`), and the driver
  reports the effect as `execution-unverified`. The orchestration layer has no typed rejection for it, and the
  node stays unaccepted. Continue only through a conclusive failure route the engine admits; otherwise HOLD and report.
- After the first acceptances, an action-less reconcile across a registry revision returns `stale-input`. Only
  a real action with its exact before, completion, basis and current head can proceed past it; otherwise HOLD
  and keep the evidence.

Controller permissions in auto mode:
- Before the run, the owner approves the controller's commands in the controller's own session. These are
  the FVS driver/CLI, `ao`, `git` and the pinned Lean tools. FVS changes no permission settings.
  `auto-seats.md` says which seat (owner, orchestrator or worker) runs each operation. "Permissions and
  command rules" below gives the general habits for every session.
- Run one simple, auditable command per step: one driver or CLI operation with its `--input` file, one
  `ao` call or one `git` call. Compound commands (`&&`, `;`, pipes, `cd` plus a command, subshells) can
  trigger a permission prompt, and an unattended prompt may be aborted.
- A command denied before it started had no effect: re-read state and hold that step. Any other
  abort, or an outcome you cannot establish, is uncertain: the effect may have run. Keep its marker,
  reservation and evidence and follow the uncertain-effect recovery; never assume it did nothing.
- In both cases, never retry the command verbatim or reshape it to avoid review; report the hold if
  a plain command is also refused.
- FVS cannot promise that a host permission classifier allows any command, and it contains nothing
  designed to evade one.

For the Beads CLI itself, use its [official versioned installation guide](https://github.com/gastownhall/beads/blob/v1.3.1/docs/getting-started/installation.md).
A generic latest install may differ from the Beads `1.3.1` version recorded for this adapter. No Beads plugin, MCP server
or external Dolt server is required by the embedded adapter. Existing stores/settings are preserved;
initialization has native Git side effects and needs its own explained setup permission.

## V2 run policy and runner boundary

For a new v2 project, read `auto-execution.md` for optional budgets, optional memory, cancellation and
small-proof progress/handoff. Stock AO may run locally or on the user's cloud host; no Linux-first
choice is imposed. Orchestration/research and pinned acquisition are network-enabled through the
configured tools and grants. The profile below only detects tools.

The confinement/tool matrix below qualifies a particular probe-inventory operation. It is not a
blanket SWVF networking or nested-sandbox requirement. The v2 compiler path uses the actual trusted
host with pinned inputs and strict checker integrity, and needs its own real qualification. Keep
per-tool availability/distribution constraints and unsupported tuples explicit. Neither an installed
version line nor unit fixtures establish full AO/Lean factory or cloud support.

## Prerequisites you install yourself

The profile and resolver install no prerequisites: you install every prerequisite below yourself.
These checks only detect; they never install, download or modify anything. The separate FVS install
example above is an explicit owner-run step after permission for its local writes.

| Prerequisite | Official source | Version check | What the profile reads |
|---|---|---|---|
| Agent Orchestrator | https://github.com/OrchestratorInc/agent-orchestrator/releases and https://docs.orchestrator.inc/installation | `ao --version` | Only that `ao` is on PATH. FVS records no tested Agent Orchestrator version, so a version line shows that the CLI runs and nothing more. In the macOS app bundle the CLI is `Contents/Resources/daemon/ao`: put its directory on PATH. |
| Rust toolchain | https://rustup.rs | `rustup --version`, `cargo --version`, `rustc -vV` | `cargo` and `rustc` on PATH, any `rust-toolchain` pin, and `rustc -vV` run in the crate directory, where a pinned toolchain applies. |
| Lean through elan | https://github.com/leanprover/elan | `elan --version`, `lake --version` | `lean-toolchain`, a `lakefile.toml` or `lakefile.lean`, and `lake --version` run in the project root. |
| Aeneas and Charon | https://github.com/AeneasVerif/aeneas/releases | `aeneas -version`, `charon version` | The Aeneas revision your project pins, and the `aeneas` and `charon` executables for this host. |
| probe-aeneas | https://github.com/Beneficial-AI-Foundation/probe-aeneas/releases | `probe-aeneas --version` | Only after an extraction exists; judged together with the helpers below. Not needed for setup or extraction; "Probes and stage lines" below says what needs it. |

Aeneas and Charon come in one release archive per CPU and OS (asset names look like
`aeneas-macos-aarch64.tar.gz`). It holds `aeneas`, `charon`, `charon-driver`, a `rust-toolchain` file and
the Lean backend: unpack all of it, not just the two executables. Put it under
`.aeneas/releases/<rev>/<platform>/` in your project, or put `aeneas` and `charon` on PATH. `<rev>` is the
exact string your project pins (the `rev` in `lakefile.toml` or its `inputRev` in `lake-manifest.json`; a
release tag such as `nightly-2026.09.30-0855ce1` or a commit hash) and `<platform>` is your host's target
triple, which the first line of the profile prints. Charon works against one Rust nightly: the
`rust-toolchain` file in the archive names it and `charon toolchain-version` prints it. Make sure
`rustup toolchain list` shows it before you extract.

The confined probe-aeneas inventory also needs four helpers at exact versions: probe-rust
(https://github.com/Beneficial-AI-Foundation/probe-rust), scip (https://github.com/scip-code/scip/releases),
probe-lean (https://github.com/Beneficial-AI-Foundation/probe-lean/releases) and rust-analyzer with its
`rust-src` component (installed through rustup). Check them with `probe-rust --version`,
`scip --version`, `~/.local/bin/probe-lean-v4.31.0 --version` and `rust-analyzer --version`. That last
check can pass without `rust-src`, so also run `rustup component list --installed --toolchain 1.98.1`
and confirm that it lists an entry for `rust-analyzer` (such as `rust-analyzer-<target>`) and one for
`rust-src`. The resolver runs the same listing in the crate directory, so that toolchain must be the
one active there. The resolver finds probe-lean only as `~/.local/bin/probe-lean-<Lean version from lean-toolchain>`, with its libraries in
`~/.local/lib/probe-lean-<Lean version>`, so a `probe-lean` elsewhere on PATH does not count unless you
name it with a path override (see "Probes and stage lines" below). The pinned
downloads, digests and install steps for your host are printed by the resolver, which only reads:

```bash
node "$HOME/.claude/scripts/fvs-probe-inventory.mjs" resolve --project-root . --format text
```

The confined probe-aeneas inventory runs every tool check and the probe itself under the operating
system's confinement. On Linux x86_64 the confined probe-aeneas inventory uses bubblewrap, so you need `/usr/bin/bwrap`
(https://github.com/containers/bubblewrap; check it with `/usr/bin/bwrap --version`) and `/usr/bin/xz`
(check it with `/usr/bin/xz --version`) to unpack the probe-aeneas archive. The confined probe-aeneas
inventory there also needs native Linux tools, a PATH of absolute Linux directories without
Windows-mounted entries, and a HOME and project outside `/tmp`, `/var/tmp` and `/run`. The resolver's
guidance for the last prerequisite is: Check whether unprivileged user namespaces are permitted,
including any AppArmor restrictions. FVS does not change system security policy. Neither should you: if
confinement stays unavailable, the profile and the resolver say so and nothing runs, so use a host where
it is already permitted. On macOS the confinement is the system's `/usr/bin/sandbox-exec`, which needs no
installation.

## Check your host

Run the profile from your project root. It prints one verdict per item and, for every item that is not
green, one `next:` line:

```bash
node "$HOME/.claude/scripts/fvs-auto.mjs" profile --project-root . --format text
```

Add `--format json` for the same result with the raw evidence. The items are:

| Item | What it checks |
|---|---|
| `host` | Whether this host's target has a recorded confined run. It is never green, because the evidence covers one operation. |
| `ao` | The Agent Orchestrator CLI. |
| `rust` | The Rust toolchain and its host target. |
| `lean` | The Lean project files and Lake. |
| `aeneas` | The Aeneas pin, the installed Aeneas and Charon, and how they compare with the tested tuples. |
| `probe` | probe-aeneas, its helpers and the extraction provenance. |

`/fvs:auto-init` stops on a `missing`, `incompatible` or `unsupported-platform` verdict for any item
except `host` and `probe`. Those two never stop it, because no probe is needed for setup or extraction.
Below the items the text output also prints a `probes:` list and a `stages:` list; "Probes and stage
lines" below explains them.

## What each verdict means

| Verdict | Meaning |
|---|---|
| `supported-and-tested` | An exact tested tuple on this host, for the recorded operation only, with probe-aeneas and every helper at the tested version. The profile names the operation, tuple and platform it covers. |
| `available-but-unverified` | Present, but no recorded FVS run covers it. The reason says exactly why. This is not a failure. A reason that starts with `warning:` (pins that contradict each other, or a Charon or Lean that contradicts a tested Aeneas revision) is also this verdict and never stops setup. |
| `incompatible` | A concrete mismatch. Only the `probe` item prints it, and it never stops setup. Either `translation.json` records an Aeneas revision that was tested with a different Charon or Lean, or the project is on a tested tuple and probe-aeneas or one of its helpers is at a different version than the tested one, or this host cannot confine the run. Being absent from the tested list is never enough. |
| `missing` | A component is actually absent. For `ao`, `rust`, `lean` and `aeneas` this stops `/fvs:auto-init`. A missing `probe` is only noted, because no probe is needed for setup or extraction. |
| `unsupported-platform` | This host's target has no recorded confined run, or no official probe-aeneas asset. Setup and extraction go on here. "Probes and stage lines" below says what the stages then need. |
| `not-extracted-yet` | The expected state of a fresh project: no `translation.json` and no Aeneas-generated Lean file yet. This is not a failure. |

The single next step is the `next:` line. These are printed verbatim; where the profile adds a lead-in
or a second sentence, the cell shows it:

| Situation | Item | Next step |
|---|---|---|
| `ao` is not on PATH | `ao` | Install Agent Orchestrator and put its ao CLI on PATH, then rerun the profile. |
| `cargo` or `rustc` is not on PATH | `rust` | Install Rust with rustup (https://rustup.rs), then rerun the profile. |
| The Rust version could not be checked on this host | `rust` | Run rustc -vV in the crate directory yourself to confirm the toolchain. |
| `lean-toolchain` is missing or empty | `lean` | Add a lean-toolchain file to the project root pinning the Lean version your Aeneas backend uses. |
| No lakefile in the project root | `lean` | Create the Lean project (a lakefile.toml that requires the Aeneas Lean backend) in the project root. |
| `lake` is not on PATH | `lean` | Install elan (https://github.com/leanprover/elan); it provides lake and the pinned Lean toolchain. |
| The Lake version could not be checked on this host | `lean` | Run lake --version in the project root yourself to confirm the pinned toolchain. |
| No Aeneas requirement in the project | `aeneas` | Require the Aeneas Lean backend in lakefile.toml ([[require]] name = "aeneas" with a pinned rev). |
| `translation.json`, `lake-manifest.json` and `aeneas-config.yml` disagree (a warning: the run goes on) | `aeneas` | The usual step for the verdict, then the sentence that only clears the warning. Nothing here blocks the run: To clear the provenance warning: Regenerate the extraction so translation.json, lake-manifest.json and aeneas-config.yml agree, then rerun the profile. |
| Charon or Lean contradicts a tested Aeneas revision (a warning, not a stop) | `aeneas` | None required; the tuple is recorded as evidence, not a gate. To match the tested tuple instead: Install the Charon and Lean versions this Aeneas revision was tested with, or move to another Aeneas revision. |
| The installed toolchain matches no tested tuple | `aeneas` | None required to extract; results with this tuple stay unverified until a confined run is recorded for it. |
| The project has not been extracted | `probe` | Extract the crate with the shared aeneas-extract workflow (/fvs:aeneas-extract), then rerun the profile. |
| The extraction contradicts a tested tuple | `probe` | Not needed for setup or extraction: Pin the Charon and Lean versions this Aeneas revision was tested with (or move to another Aeneas revision), then re-extract. |

Other next steps name your own revision, host or paths, so the profile writes them for you: install
Aeneas and Charon for the pinned revision under `.aeneas/releases/<rev>/<platform>/`; run the resolver
above for a missing or drifted probe-aeneas or helper. On an `unsupported-platform` host, setup and
extraction go on, and a host with recorded confined-run evidence can also run the confined probe
inventory. Every `probe` step except the one for a project that is not extracted yet, and the `host`
step on an `unsupported-platform` host, starts with "Not needed for setup or extraction:", because no
probe is needed for setup or extraction. For an untested tuple the
`probe` step describes how to qualify it: run probe-aeneas confined against your project with its own
Aeneas, Charon and Lean, record the envelope, helper versions and platform, and add the tuple to
`TESTED_TUPLES` in a reviewed change. Until then it stays `available-but-unverified`.

## Probes and stage lines

The text profile ends with a `probes:` list and a `stages:` list. No probe is needed for setup or
extraction: `/fvs:auto-init`, the extraction and `record-extraction` go on without them, and a missing
probe never stops `auto-init`. Each probe adds one thing, and the profile names what you lose without it:

| Probe | What it adds | Without it |
|---|---|---|
| `probe-aeneas` | Rust-to-Lean mappings confirmed independently of Aeneas. | Every mapping is declared by Aeneas in `translation.json`, never exact, and generated Lean functions are not checked against `functions.json`. |
| `probe-rust` | The Rust atom inventory. | Rust names and spans come from `translation.json` alone, and Rust functions Aeneas did not translate are not detected. |
| `scip` | The code index `probe-rust` reads. | `probe-rust` cannot run. |
| `rust-analyzer` | The indexer `probe-rust` uses. | `probe-rust` cannot run. |
| `probe-lean` | The Lean atom list for the dependency graph. | No Lean graph is built, so the closure plan has source order only, no dependency order, and proof acceptance refuses it. |

Each probe has one status in the `probes:` list:

| Status | Meaning |
|---|---|
| `qualified` | The resolver checked it for the exact tested tuple of this project. |
| `present-unqualified` | Found, and it answers `--version`, but no tested tuple covers this project. Its output is used and labelled unverified. |
| `unverified-blocked` | Found, but the profile does not count its output as usable: its `--version` run fails, or it is a `probe-lean` at a version the Lean graph step refuses. A stage that needs it runs reduced, without it, until you replace it with one this engine accepts. The reason is printed. The profile accepts `probe-lean` 0.14.0. Version 0.24.0 is accepted by the Lean graph step only beside a version 2 Lean constants record, and the profile does not look for that record, so it prints `unverified-blocked` for 0.24.0. |
| `missing` | Not found. A `rust-analyzer` that is only the rustup proxy and fails to run counts as missing. |
| `not-checked` | The check did not run, and the reason is printed: an unreadable `lean-toolchain`, a refused path override, or no read-only confinement on this host to run the `--version` check in. A stage that needs it runs reduced, without it, until the check can run. |

The stages `auto-top-specs` and `auto-execute` each need `ao` and `lean` to have a route at all. A lost
probe does not stop them: the stage runs without that probe's output, and the output is labelled reduced.
Proof acceptance (freeze, check, accept) needs a verified Lean graph from `probe-lean` and a Rust identity
confirmed by `probe-aeneas` and `probe-rust`, which in turn needs `scip` and `rust-analyzer`. So reduced
output never promises proof acceptance, and without `probe-lean` acceptance refuses until it is usable.
The `stages:` list has one line for each stage, and the line starts with one of these:

| Stage line | Meaning |
|---|---|
| `full` | Every probe is qualified for this toolchain tuple. |
| `ready, unverified` | Every probe is present and usable, and some are not qualified for this toolchain tuple. Their output is used and labelled unverified: a warning, not a stop. |
| `ready, reduced` | `ao` and `lean` are present, and only probes are missing, not checked or unusable. The stage runs without them, and its output is labelled reduced. The line names each lost probe and what that costs, says reduced output never promises proof acceptance, and ends with `To restore, the owner can ...` and `(warning, not a stop)`. |
| `no route here` | `ao` or `lean` is missing, or the recorded profile has no usable status for a probe. The line names what, then `first, the owner must ...` or `first, the agent must ...`: the first step and who does it. The owner installs software or fixes the host. The agent only reruns `/fvs:auto-init` with the recorded choices. |

The recorded profile changes only when `init-state` runs again, so each step ends by naming that rerun.
Read the stage line before you start a stage. A `ready, reduced` line says what you lose and who can
restore it, and a `no route here` line says what is missing and who supplies it. The next step after
setup goes on as usual and repeats a `ready, unverified` or `ready, reduced` line as a warning.

FVS looks for each helper in a fixed place: `probe-rust` on PATH or in `~/.cargo/bin`, `scip` in
`~/.probe-rust/tools` or on PATH, `rust-analyzer` on PATH, and `probe-lean` only as
`~/.local/bin/probe-lean-<Lean version>` with its libraries in `~/.local/lib/probe-lean-<Lean version>`.
When yours lives elsewhere, set the matching variable to an absolute path in the environment of the
command that runs the profile, the resolver or the engine:

| Variable | Names |
|---|---|
| `FVS_PROBE_RUST_PATH` | The `probe-rust` executable. |
| `FVS_SCIP_PATH` | The `scip` executable. |
| `FVS_PROBE_LEAN_PATH` | The `probe-lean` executable. |
| `FVS_PROBE_LEAN_LIBRARY_PATH` | The directory that holds the probe-lean libraries. |

Each path must be absolute and name an executable file (a directory, for the library). An empty
variable counts as unset, and the default place is used. A variable with a value that is unusable is
refused with its name in the reason, and the lookup never falls back to the default place, so you
cannot get a different binary than the one you named. The profile then still prints its table, with
the helpers `not-checked` and the refusal as the reason, and setup does not abort. Fix or unset the
variable and rerun. `rust-analyzer` and `probe-aeneas` have no override: put them on PATH.

Without probe output the Rust identity record rests on `translation.json` alone. The
`fvs-rust-identity.mjs record` command takes the probe outputs as optional inputs (`--rust`,
`--mappings`, `--lean` and `--functions`) beside the required `--manifest`. A named probe file that is
missing leaves the record translation-only and lists the missing outputs in its provenance. A closure
plan made without a dependency graph, or from a translation-only record, is degraded: it lists every
identity item in source order, computes no closure, and the contract registry refuses it. The workflow
`auto-top-specs.md` says how the controller reports that. Install the probes and plan again, and do not
substitute a guess for the missing probe output.

Two contradictions are warnings, never stops: Aeneas versions that disagree across `translation.json`,
`lake-manifest.json` and `aeneas-config.yml`, and a Charon or Lean that contradicts a tested Aeneas
revision. The `aeneas` item prints both as `available-but-unverified` with a `warning:` reason. The
`probe` item prints the second one as `incompatible`, which also never stops setup. The run goes on if
the recorded extraction builds against the pinned Lean library, and a failed build stops at
`record-extraction`.

## Keep `.formalising/` out of git

FVS keeps its local notes and auto-track state under `.formalising/` in your project. Nothing in this
walkthrough edits your git configuration, so exclude it yourself if you do not want it committed.
`.git/info/exclude` is local to your clone and is shared by its linked worktrees:

```bash
printf '/.formalising\n' >> "$(git rev-parse --git-path info/exclude)"
git check-ignore -v .formalising/
```

The second command prints the rule that matches; no output means the path is not ignored. An ignore
rule does not untrack files already committed: if `git ls-files .formalising/` lists anything, remove
it from the index yourself with `git rm -r --cached .formalising/`. Use `.gitignore` instead only if
your team agrees to share the rule.

## Permissions and command rules

These habits apply to every session in a run: the owner's, the orchestrator's and each worker's. FVS
changes no permission settings. The habits keep a run from stalling on a prompt nobody answers. The
FVS-specific part, what the controller needs approved and how to treat a denied or aborted command, is
in "Controller permissions in auto mode" above.

- **One simple command per call, for every worker.** No `;`, `&&`, `||`, pipes or subshells, and no `cd`
  followed by a command. Use `git -C <path> status` rather than changing directory first. Compound
  commands are the ones a permission layer most often stops.
- **Keep scratch work inside the worktree and plain.** Do not delete or move files, and avoid commands
  that wait for an answer.
- **A prompt nobody answers is aborted.** In one setup, permission prompts and dialogs left unanswered
  were each aborted after about 30 minutes ("Tool use aborted"), five times in a row, and the run
  stalled. The time and wording may differ on your version. An abort is an uncertain outcome, not a
  refusal: treat it as the uncertain-effect case above. Before you leave a run unattended, approve the
  commands each seat needs, or choose the host's permission mode on purpose.

The notes below apply only in the setup each one names. If it is not yours, skip the note.

- **Describe commands in words when you write to another session (optional note).** This applies only if
  you wrote a permission rule that asks before any command starting with a wildcard. Such a rule can
  match words inside quoted text, such as the message of `ao send`. If that message mentions a delete, a
  download or a version-control command, the host may prompt although nothing runs it. An allow rule for
  `ao *` does not help, because an ask rule takes precedence over an allow rule. Say what should happen
  in plain words ("remove the file", "fetch the branch"), and call `ao` itself directly, not through a
  wrapper, so the rule sees the command it was written for. `ao send` has no option to read its message
  from a file.
- **Read pull requests without `gh api` (optional note).** This applies only if your permission rules or
  your project's own rules block `gh api`. Read a pull request with `gh pr view` and `gh pr diff`
  instead. `/fvs:aeneas-extract`'s read-only known-issues search uses `gh api` with an explicit read
  method, `gh search` or `curl` on a public page; where `gh api` is blocked it uses the other two, or
  records the search as `not checked`.
- **A command-rewriting hook changes what a rule sees (optional note).** Some setups install a hook that
  rewrites every shell command, for example to shorten its output; RTK is one such tool. The permission
  layer then sees the rewritten command. An allow rule written for the original form, such as `ao *`,
  no longer covers it, and every ask rule anchored on the start of a command needs a twin for the
  rewritten form. Such hooks have also been seen cutting JSON output short, which breaks any step that
  parses it. If a result looks cut off, exempt that command from the hook or switch the hook off for
  the run.

## Agent Orchestrator setup

Stock Agent Orchestrator (AO) needs nothing from FVS except the `ao` command, which the profile checks.
The settings below belong to AO and to your project. Run `ao <command> --help` on your version: it is
the authority, and this section can lag behind it.

**Worktrees.** Every worker runs in its own linked git worktree. Ignored local files do not follow it: a
project-level FVS install (the `.claude` or `.codex` folder), `.formalising/` and local settings live
only in the checkout where they were made. Choose one route per runtime and keep one trusted engine
identity for the whole run:
- Install FVS in each worker worktree once the worktree exists, repeating the exact-source steps above.
- Or install FVS once for your user account (`bin/install.js` with `--global`) so every worktree finds
  the same scripts.

The Claude actor permission helper, `fvs-auto-actor-permissions.py`, writes each actor's rules to a real
`.claude/settings.local.json` inside that actor's own worktree and refuses a `.claude` that is a link. So
do not point AO's `--symlink` option at `.claude` itself. The one file never to share between actors is
`settings.local.json`, the per-actor grants file: one actor's grants would become every actor's. A real
per-worktree `.claude` folder whose entries link to a shared install, including the shared
`settings.json`, with `settings.local.json` kept a real file in each worktree, was checked end to end on
AO 0.14.10 in a throwaway project: AO created it from per-entry links and the helper then verified the
grant. Recheck it on other AO versions.

AO rewrites `.claude/settings.local.json` when a worker starts. After a start, read the merged rules the
worker really has (in Claude Code, the `/permissions` view) before you rely on them. Whether FVS's actor
rules survive that rewrite is untested. Rules held in a `.claude` folder that is a link also wait until
that folder is trusted.

**Project config.** `ao project set-config <id>` changes only the fields whose flags you pass:
`--agent-rules` or `--agent-rules-file` (standing instructions for workers), `--orchestrator-rules` or
`--orchestrator-rules-file` (the same for the orchestrator; a rules file is a path inside the repository),
`--model`, `--permission` (`default`, `accept-edits`, `auto` or `bypass-permissions`), `--worker-agent`,
`--orchestrator-agent`, `--env`, `--symlink`, `--post-create` and `--pre-remove`. `ao project get <id>
--json` prints what is saved. `--config-json` is different: it replaces the whole config, and a key it
does not know is ignored without a message, so a typo can leave the config nearly empty. Read the saved
config first, change one field, send the whole object back, and read it again.

**Model aliases and the model rule.** Put short aliases and one rule into the project's standing rules, so
every session picks models the same way: which job, which model, which effort. A shape to adapt:

```text
Model aliases: writer = <model id>; deep-review = <model id>; quick-review = <model id>.
Rule: start implementation workers with writer at <effort>. Start a hard review with deep-review at
<effort> and an easy review with quick-review at <effort>. A reviewer is never the model that wrote
the work it reviews.
```

FVS names no model: use ids and efforts your harness offers. `--model <id>` sets the project default and
`ao spawn --model <id>` overrides it for one session. A reasoning effort has no field flag of its own: it
sits in the agent's `agentConfig` and needs `--config-json`, with the warning above. This is separate from
FVS's own model settings (`/fvs:configure`, `model-profiles.md`), which choose models for FVS's stages.

**Rule changes reach only sessions that start afterwards.** AO resolves the config when a session
spawns, and a session reads its rules once, at its start. After you change rules, message every live
session in plain words that the rules changed and that it should re-read them with `ao project get <id>
--json`, or restart it. A session re-reads the saved rules the same way when it resumes and after its
context is compacted.

## Codex trust

This applies when a seat runs Codex. What follows was seen in one setup; re-check it on your version.
- Skills load without trust. A project-level `.codex` install (its config and hooks) loads only when the
  project's exact path is trusted in `~/.codex/config.toml`: a `[projects."<absolute path>"]` table with
  `trust_level = "trusted"`. The owner makes that edit; FVS never writes it.
- An AO worktree resolves to its main repository root for this purpose, so one entry covers every
  worktree of the project. A parent folder does not pass trust to a child path, there is no wildcard
  form, and the `-c` command-line option cannot grant trust.
- A project hook also needs its own trusted hash: a
  `[hooks.state."<clone>/.codex/hooks.json:session_start:0:0"]` table holding `trusted_hash`. A reinstall
  at another path changes both the key and the hash, so trust it again after any move.
- Check without a model call: `codex debug prompt-input` prints what a session would load.

## Owner-run steps

Some steps belong to the owner alone. The owner types them in a terminal of their own; an orchestrator or
worker only prepares them or hands over the exact command. `auto-seats.md` lists every operation by seat.
- Installing FVS in a scope, and installing the prerequisites.
- Changing host trust or permissions: the Codex trust entry, the project's AO config
  (`ao project set-config`), a permission mode.
- Recording the scope agreement. The orchestrator drafts it with `fvs-auto-agreement.mjs`, which prints
  the fence, its digest and the one record command. The owner compares the digest with what they
  approved, then runs that command. A later agreement for a changed scope needs the overwrite
  confirmation, which is owner-run as well: in one setup the host's permission classifier refused it from
  the orchestrator, and the owner ran it. The helper never records anything.
- The final decision on a pull request.

If the owner explicitly delegates one of these steps to a session, that session writes the delegation and
the step it covers into its report.

## Starting a run with /goal

In Claude Code, `/goal` keeps a session working until a condition holds. An owner gate, such as waiting
for the owner to record the agreement, means the session cannot finish on its own. A goal that does not
accept the gate as done keeps the stop hook from ending the turn: in one setup the session sent nine
near-identical messages and then hit the cap of nine, twice. Use wording that accepts the gate:

```text
/goal Run the auto track under the current agreement until the first checked proof. Reaching an owner
gate, reported once in plain chat, counts as done for now.
```

Add a standing rule next to it: at an owner gate, say so once in plain chat and stop. If the session has
already started repeating itself, clear the goal and set it again with this wording.

## Reports, links and owner questions

- **Links and paths.** A link that only one app opens, for example an in-app `ao://` link, is always
  followed by the plain absolute path of the file it points to. Every report and every next action that
  points to an artifact gives that path.
- **Owner questions in plain words.** Offer a short menu and leave room for free text. Each option says
  what happens next, what it costs and what stays blocked. Mark one option as recommended, with a
  one-line reason.

## Reading the primary checkout safely

While a run is going, look at the primary checkout through a read-only worktree at the same commit
rather than opening it in an editor. An editor's Rust language server can re-resolve `Cargo.lock` and
silently change an extraction input. Making Cargo fail instead of changing the lock file (its
`--locked` option) is an idea, not a tested rule: FVS has not checked that the extraction tools accept it.

## Tested matrix

This table mirrors `TESTED_TUPLES`; the code is the authority. The only tested operation is the confined
probe-aeneas inventory, on the rows below. No other auto-track operation has a recorded run on any host.

| Operation | Tuple | Platform | Isolation | Evidence |
|---|---|---|---|---|
| confined probe-aeneas inventory | aeneas-6e167c9b-charon-0.1.225-lean-v4.31.0 | aarch64-apple-darwin | sandbox-exec | recorded confined run |
| confined probe-aeneas inventory | aeneas-6e167c9b-charon-0.1.225-lean-v4.31.0 | x86_64-unknown-linux-gnu | bubblewrap | recorded confined run |
| Pilot tuple, any operation | Aeneas nightly-2026.09.30-0855ce1, Charon 0.1.274, Lean 4.31.0 | any | none | unverified until a recorded confined run |

The tuple is Aeneas 6e167c9b, Charon 0.1.225 and Lean 4.31.0, run with probe-aeneas v0.20.0 and tested with Beneficial-AI-Foundation/curve25519-dalek-lean-verify@0a22c281a9a14b6465a5473c200c7d3f1ac92df8.

Recorded helpers for the confined probe-aeneas inventory on aarch64-apple-darwin: probe-rust 0.11.0, scip version v0.10.0, probe-lean 0.14.0, rust-analyzer 1.98.1 (48a229ce 2026-09-01), with the rust-analyzer and rust-src components.

Recorded helpers for the confined probe-aeneas inventory on x86_64-unknown-linux-gnu: probe-rust 0.11.0, scip version v0.10.0, probe-lean 0.14.0, rust-analyzer 1.98.1 (48a229c 2026-09-01), with the rust-analyzer and rust-src components.

The pilot tuple is the combination the first real target project uses. It stays unverified until a
confined run is recorded against it and it is added to `TESTED_TUPLES` in a reviewed change.

Linux x86_64 is not validated for FVS extraction or acceptance, even though official binaries exist and the confined probe-aeneas inventory has a recorded run there. One probe run never qualifies the whole auto track. Everything else is unsupported: other platforms, other tuples and every other operation.
