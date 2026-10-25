<overview>

How to get from a clean host to a recorded auto-init state when you are new to functional-correctness
verification: what you install yourself, how to check each tool, what each compatibility verdict means
and what the single next step is, how to keep `.formalising/` out of git, and which operation, tuple
and platforms have a recorded run. This walkthrough installs nothing and makes no claim beyond the
tested matrix at the end. `TESTED_TUPLES` in `scripts/fvs-probe-inventory.mjs` is the authority; the
matrix mirrors it and a test keeps the two in step.

</overview>

## Prerequisites you install yourself

This walkthrough and the profile install nothing: you install every prerequisite below yourself. The
profile described below only detects; it never installs, downloads or modifies anything.

| Prerequisite | Official source | Version check | What the profile reads |
|---|---|---|---|
| Agent Orchestrator | https://github.com/OrchestratorInc/agent-orchestrator/releases and https://docs.orchestrator.inc/installation | `ao --version` | Only that `ao` is on PATH. FVS records no tested Agent Orchestrator version, so a version line shows that the CLI runs and nothing more. In the macOS app bundle the CLI is `Contents/Resources/daemon/ao`: put its directory on PATH. |
| Rust toolchain | https://rustup.rs | `rustup --version`, `cargo --version`, `rustc -vV` | `cargo` and `rustc` on PATH, any `rust-toolchain` pin, and `rustc -vV` run in the crate directory, where a pinned toolchain applies. |
| Lean through elan | https://github.com/leanprover/elan | `elan --version`, `lake --version` | `lean-toolchain`, a `lakefile.toml` or `lakefile.lean`, and `lake --version` run in the project root. |
| Aeneas and Charon | https://github.com/AeneasVerif/aeneas/releases | `aeneas -version`, `charon version` | The Aeneas revision your project pins, and the `aeneas` and `charon` executables for this host. |
| probe-aeneas | https://github.com/Beneficial-AI-Foundation/probe-aeneas/releases | `probe-aeneas --version` | Only after an extraction exists; judged together with the helpers below. |

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
`~/.local/lib/probe-lean-<Lean version>`, so a `probe-lean` elsewhere on PATH does not count. The pinned
downloads, digests and install steps for your host are printed by the resolver, which only reads:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/fvs-probe-inventory.mjs resolve --project-root . --format text
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
node ${CLAUDE_PLUGIN_ROOT}/scripts/fvs-auto.mjs profile --project-root . --format text
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

## What each verdict means

| Verdict | Meaning |
|---|---|
| `supported-and-tested` | An exact tested tuple on this host, for the recorded operation only, with probe-aeneas and every helper at the tested version. The profile names the operation, tuple and platform it covers. |
| `available-but-unverified` | Present, but no recorded FVS run covers it. The reason says exactly why. This is not a failure. |
| `incompatible` | A concrete mismatch: a revision that was tested with a different Charon or Lean, or pins that contradict each other. Being absent from the tested list is never enough. |
| `missing` | A required component is actually absent. |
| `unsupported-platform` | This host's target has no recorded confined run, or no official probe-aeneas asset. Only exploratory work without a graph is possible. |
| `not-extracted-yet` | The expected state of a fresh project: no `translation.json` and no Aeneas-generated Lean file yet. This is not a failure. |

The single next step is the `next:` line. These are printed verbatim:

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
| `translation.json`, `lake-manifest.json` and `aeneas-config.yml` disagree | `aeneas` | Regenerate the extraction so translation.json, lake-manifest.json and aeneas-config.yml agree, then rerun the profile. |
| Charon or Lean contradicts a tested Aeneas revision | `aeneas` | Install the Charon and Lean versions this Aeneas revision was tested with, or move to another Aeneas revision. |
| The installed toolchain matches no tested tuple | `aeneas` | None required to extract; results with this tuple stay unverified until a confined run is recorded for it. |
| The project has not been extracted | `probe` | Extract the crate with the shared aeneas-extract workflow (/fvs:aeneas-extract), then rerun the profile. |
| The extraction contradicts a tested tuple | `probe` | Pin the Charon and Lean versions this Aeneas revision was tested with (or move to another Aeneas revision), then re-extract. |

Other next steps name your own revision, host or paths, so the profile writes them for you: install
Aeneas and Charon for the pinned revision under `.aeneas/releases/<rev>/<platform>/`; run the resolver
above for a missing or drifted probe-aeneas or helper; use a host with a recorded confined run when the
host is `unsupported-platform`. For an untested tuple the `probe` step describes how to qualify it: run
probe-aeneas confined against your project with its own Aeneas, Charon and Lean, record the envelope,
helper versions and platform, and add the tuple to `TESTED_TUPLES` in a reviewed change. Until then it
stays `available-but-unverified`.

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
