# Changelog

All notable changes to FVS (Formal Verification Skills) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

## [3.0.0-rc3] - 2026-11-21

This is prerelease source metadata for the selected-target SWVF candidate. It is meant for the
npm `next` tag only, and stable 2.3.x stays `latest`. Identify the release by the tag
`v3.0.0-rc3` and its full commit SHA. This entry does not claim catalog publication, complete
runtime qualification or a whole-library verification result.

### Added

- **Several crates in one run.** Extraction accepts a repository with several crates. Every crate of
  the repository that has a library is a verification target, unless you decide at `/fvs:auto-init`
  that it is not; the default is all of them. Each target is extracted, and patched when needed,
  with its own Charon run and its own LLBC. Only a crate that comes from outside the repository
  (crates.io or another repository) stays external and opaque, recorded with its pinned version. The
  patch engine's `crates` command lists the crates of a checkout in dependency order, providers
  first, and names the symbolic links a build might read.
- **Import stitching.** When a crate uses an item that another target crate translates, the
  generated Lean imports that crate's module instead of assuming an axiom, so a proof about one crate
  rests on the proved translation of the other. A crate that uses another target without being
  stitched to it stops the extraction, and the message names both crates. A label such as an import
  does not count as a stitch: it must name the Lean modules and the digest of the provider's
  publication. Items from outside the repository stay external axioms. Each axiom that stitching
  leaves or exposes needs an externals record, open until you decide, and so does each crate you
  chose not to verify.
- **Large workspaces and the lock.** When a crate inherits from its workspace, the repository root
  is the extraction root and the member crates are inputs. `check` and `prepare` refuse such a crate
  when no input has a `[workspace]` table, and show the cargo error. For a workspace much larger
  than its targets, `trim-workspace` prints the patches that cut it down, and writes nothing until
  you agree. A symbolic link the build might read is refused; after your yes you can list it as a
  link the build does not read. `Cargo.lock` is a recorded generated input: it is read, or
  generated inside the copy (`--lock update`, with your agreement), hashed into the extraction record
  and checked on restore. The target repository never has to commit it.
- **The proof phase goes crate by crate.** Crates are accepted one at a time, providers first, and a
  crate that depends on another counts as accepted only after the other. A crate the extraction only
  assumes keeps the run from being done until you record your decision about it.
- **The scope is recorded.** Whether a run is one crate or several is recorded when extraction
  prepares the copy, and an unknown scope is never read as one crate. A run recorded by 3.0.0-rc2
  has no scope, so it stays at the extraction step. If its repository holds one library crate,
  `record-scope` settles it from the commit the extraction was made from, after your yes, without
  extracting again. If the repository holds several, extract again.
- **A replaced extraction record leaves a backup.** When `/fvs:auto-extract` replaces an extraction
  record that cannot be read, it keeps the state file as it was beside it, as `state.json.<time>.bak`,
  and changes nothing else in the state.

- `scripts/fvs-build-check.mjs --spec-base SHA` refuses the build when a recalled statement or a
  frozen path (the lakefile, the manifest, `lean-toolchain`, the spec definitions, the trusted
  folder, the extraction folders) changed since the merged spec, so a proof worker cannot weaken
  what the owner approved. A Lean program also compares what each recalled statement rests on
  with the merged spec: a helper, notation or instance in a proof file that changes what an
  unchanged statement means is refused. A hand-written axiom whose type is a proposition that a
  statement rests on must be in `formal/trusted`, cite one accepted record and state exactly that
  record's proposition; an axiom of the merged spec whose record is tied to no frozen proposition
  stays allowed while it is unchanged. A build with no spec base is not an acceptance: it prints
  `built, integrity not checked` and exits non-zero.
- The build check refuses a spec, proof or extraction file that Lake does not build, such as a
  file that no `lean_lib` glob covers, in either lakefile format. Lake itself is asked which
  files it compiled. A Lake path package inside the repository must be the merged spec's own,
  file for file.
- The build check refuses a project file or lakefile that names `debug.skipKernelTC` or
  `addDeclWithoutChecking`, before any build. A `native_decide` or `bv_decide` axiom is refused
  when it is new since the merged spec, and kept and flagged when a statement already rested on it
  there, with or without an allowed-axioms list.
- When an extraction stitched one crate to another, the build check holds each stitched file to
  the digest and Lean check that the extraction recorded for it, and to Lake having compiled it.
  The receipt lists those checks, and the engine counts the receipt only while the recorded
  extraction holds the same ones.
- In a run over several crates the engine writes a list of allowed axioms with one section for each
  crate (`allowed-axioms`), and the build check takes it with `--allow-axioms FILE`: a statement
  passes only when every axiom it rests on, beyond Lean's three, is named in the list by its full
  name as Lean reports it. A statement that rests on an axiom about a function of another targeted
  crate does not pass.
- The trust section of a proof pull request says `not accepted (reason)` for a build-check receipt
  that the engine does not count, and still lists the axioms.

- `/fvs:auto-init` checks permissions before the run, while you are at the keyboard. It sends a
  harmless worker message, makes one author edit and build, reads pull requests, runs `git
  ls-remote` and `git fetch`, and runs the push command with a branch name that cannot exist, so
  nothing is pushed. You tell it which steps stopped and asked; with your yes it writes a minimal
  project allowlist for those steps. It never writes a rule for a GitHub comment or review, for
  marking a pull request ready, for a merge, or for a plain `git push`. It does not check pull
  request creation or editing: approve those yourself. The init summary has a `Permissions:` line
  that names the steps that will wait for your approval.
- Workers and the orchestrator push with one command, `scripts/fvs-auto-push.mjs --branch
  fvs/<name>`. It pushes that one branch to the destination that `/fvs:auto-init` recorded and
  refuses a branch outside the recorded namespace, a changed destination, and a git setting that
  would rewrite the destination. It skips repository hooks, drops git environment variables that
  could redirect a push (you can confirm a few by name at init), and keeps tokens out of every
  message and receipt, including user information in a remote address. The allowlist names this
  command and writes no rule for a plain `git push`, because a glob cannot allow a push safely. If
  your project settings already allow a plain `git push` by rule, init stops before it writes
  anything and lists those entries for you to delete.
- A permissions page, `fv-skills/references/auto-permissions.md`, is linked from the README and read
  by `/fvs:auto-init`. It gives allowlists for Claude Code and Codex, the reason for each rule, what
  still prompts, and what the push command checks and does not stop. A section on unattended runs in
  a sandbox says to use skip-permissions only in a sandbox or on a cloud machine, with a token limited
  to the project's fork, a guard ahead of `gh` that refuses comments, reviews and merges, and branch
  protection on the fork that applies to administrators too. The push command stays required in a
  sandbox. The page names `/fewer-permission-prompts` as tuning after a first run.

- `read-state --brief` prints a short run summary. `record-spec --commit SHA` hashes a spec file
  from git objects instead of the working tree. `list-items` lists the Rust functions that Aeneas
  translated inside a scope you give.
- The spec pull request lists the claims that need a model or an accepted assumption, so you can
  rule on them before the proofs start. The pull request trust section is generated from the run
  records (axioms and gaps for each statement) and checked against the registry. An open owner
  question is shown next to a pass.
- Run overrides are recorded in the run state, so a resumed run keeps them.
- The guides say: take test vectors from the repository or an official source and add a negative
  control; build before you commit and keep the exit status; pass the installed FVS path and
  version to every worker; list the public API items and test the `recall` example; redirect a busy
  AO worker with `ao send --steer`; and keep AO's native reviewer off when you do not want it.

### Changed

- The setup guide no longer says that FVS changes no permission settings. FVS writes a permission
  setting only after your yes.
- The auto-track engine files changed since 3.0.0-rc2, so the engine identity differs from rc2.
  Keep one engine identity for the whole run and do not update the installation in the middle of
  one.
- The extraction guidance no longer says to keep `Cargo.lock` committed in the target repository.
- The build check writes receipt version 2. The run counts an acceptance only from a version 2
  receipt that carries the Lean-level comparison, and stops counting it when an externals record
  that the acceptance relied on changes. A run recorded under 3.0.0-rc2 is back at the extraction
  step until its scope is settled (see Added), and shows `done` again only after the build check
  has run again.
- The build check writes JSON only on stdout, so its output can be parsed as it stands.
- The setup guide's tested matrix no longer names a pilot tuple that no real project uses. It
  lists the tuple the rc3 run used, marked unverified until a recorded confined run, and says that
  FVS does not choose your tools: your project pins its own Aeneas, Charon and Lean.

### Fixed

- Four auto-track scripts no longer crash at load when they are read from standard input, for
  example by a hash snippet in `/fvs:auto-init`. The build check is held to the same cases by a test.

### Not in this release, and known limits

- The strict graph lane still handles one crate. For a repository with several target crates, accept
  through the build check and do not start the strict lane for any of them.
- A run over several crates that an earlier version recorded must be extracted again.
  `record-scope` refuses such a run and says so.
- `record-scope` rewrites the state file. A Lean graph record made over the earlier state is then
  no longer bound to it, and the Lean run behind it repeats, so settle the scope before that run.
- Stitching changes which axioms the theorems rest on. A project that pins its `#print axioms`
  lists, or has hand-written trusted axioms about a function that is now translated, must regenerate
  or replace them in its own Lean project. FVS never rewrites a pin; the next action names the work.
- The push command is a cooperative guard with hardening and not a security boundary. It trusts your
  git setup, ssh and transport wrappers, credential helpers, and anything that runs as your user.
  Protect the main branches of the project fork. In a remote address, only the secret is removed from
  what git prints: a user name that sits next to a different real password stays readable, and a
  very short secret can make a message look garbled. A timeout during a push is reported as
  `push-outcome-unknown` and has no test. How Claude Code and Codex split a compound command was
  read from their documentation and not observed.
- The permission check shows which steps prompted in your session. It does not predict every
  command the run uses later.

## [3.0.0-rc2] - 2026-11-17

This is prerelease source metadata for the selected-target SWVF candidate. It is meant for the
npm `next` tag only, and stable 2.3.x stays `latest`. Identify the release by the tag
`v3.0.0-rc2` and its full commit SHA. This entry does not claim catalog publication, complete
runtime qualification or a whole-library verification result.

### Added

- `/fvs:auto-init` is the single entry to the auto track. It opens with the goal and the whole
  pipeline, shows the profile first so you see which stages can run on your machine, and keeps the
  agreement conversation short: the agent reads the repository, proposes a default for every choice
  and you confirm. After a successful extraction it goes on to the spec phase: it lists the public
  API items, has authors write the statements, has fresh reviewers check them and opens a draft spec
  pull request for you. Agents push the working branch to the project's own repository as the base
  for the workers and the pull requests. They never mark a pull request ready, post comments or
  reviews, or merge. This path no longer asks for an execution grant, a stage profile or a
  permission install.
- Probes are optional. probe-aeneas, probe-rust, scip, rust-analyzer and probe-lean no longer stop
  `/fvs:auto-init`. The profile lists each one with a status (`qualified`, `present-unqualified`,
  `unverified-blocked`, `missing` or `not-checked`) and the loss each missing one causes. It ends with
  one line per later stage: `full`, `ready, unverified`, `ready, reduced` or `no route here`.
  `/fvs:auto-top-specs` and `/fvs:auto-execute` run reduced when only probes are missing.
- `FVS_PROBE_RUST_PATH`, `FVS_SCIP_PATH`, `FVS_PROBE_LEAN_PATH` and `FVS_PROBE_LEAN_LIBRARY_PATH`
  name a probe helper or the probe-lean library at any absolute location. A relative, missing or
  non-executable override is refused, and its probe is reported as not checked.
- The reduced route. Without probe output, the Rust identity record is built from `translation.json`
  alone and the closure plan lists the items in source order, with no dependency order.
  `scripts/fvs-auto-reduced.mjs` then builds each item's proof file with Lean, reads the proof from
  the worker's checkout, collects axioms with Lean's own axiom collection and records one outcome
  per item. Its outcomes report progress. None of them is an acceptance.
- `scripts/fvs-build-check.mjs` builds one commit of a Lean project in a clean copy made from the
  commit's tracked files, never from the author's working tree or build output. Only the prebuilt
  dependency packages are reused, and they are checked first, so Mathlib is never rebuilt. It runs
  `lake build --wfail`, so any `sorry` fails it, and Lake enforces each spec file's `#guard_msgs` on
  `#print axioms`. The report lists every statement with the axioms it rests on. A receipt bound to
  the commit and its tree is written outside the clean copy. A project with no guarded statements is
  never accepted.
- The engine records the spec and proof pull requests. `record-spec` stores one row per review round
  of a spec file and `spec-status` reports whether the files are ready for a pull request.
  `record-pr` stores a draft spec or proof pull request, and `record-pr --merged` records your merge
  and moves the state to the proof phase. The state reports done only when the build check accepted
  the head of the recorded proof pull request.
- `scripts/fvs-lean-constants.mjs` runs FVS's Lean constants extractor in the project's own Lean
  environment, with no probe, and writes the constants record, its run receipt and the import
  manifest. It publishes nothing when a step fails or an input changes during the run.
- The closure plan and the Lean graph step accept axioms, enums, classes and instances. Axiom policy
  is a setting per item: `propext`, `Classical.choice` and `Quot.sound` are always allowed, and a
  project axiom is allowed only when named with `--allow-axioms`. An item that rests on any other
  axiom is blocked, and so are its dependents.
- `scripts/fvs-auto-agreement.mjs` drafts the agreement fence from the recorded choices, prints its
  digest and checks the draft on a scratch copy. It never records the agreement: you run that step.
- Aeneas and Charon are also looked for at the top of the project's git working tree, which suits a
  Lean project in a subfolder next to an install at the repository root.

### Changed

- rc2 carries the changes listed in the 2.3.10, 2.3.11 and 2.3.12 sections below, as they stand in
  this tree. 2.3.12 adds `/fvs:loop-me-in` and `/fvs:loop-me-in --final`, which write a
  self-contained HTML walkthrough of a chunk of work or of the whole formalisation, adds a workflow
  guide (`docs/workflow.md`) with two diagrams in the README, makes `/fvs:crypto-execute` name its run
  report path and `/fvs:crypto-eval` read it, and corrects the `/fvs:fc-plan` wording in `/fvs:help`
  and the README. 2.3.11 resolves bundled script paths for direct installs from the selected
  installation directory and quotes them. 2.3.10 brings the Codex sub-agent dispatch fixes, the
  fresh-child-per-pass rule for loop commands, the measured `Thinker wall time` in
  `/fvs:crypto-eval`, and `/fvs:lean-refactor` for any Lean file whose proofs already compile. The
  merged inventory is 41 commands and 27 workflows.
- The auto-track engine files changed since 3.0.0-rc1, so the engine identity differs from rc1.
  Keep one engine identity for the whole run and do not update the installation in the middle of one.
- A missing Aeneas or Charon is a warning once a recorded extraction has succeeded. The first setup,
  a failed extraction and any other missing tool still stop `/fvs:auto-init`.
- Different Aeneas versions in `translation.json`, `aeneas-config.yml` and `lake-manifest.json` are
  reported as a warning that keeps every version in the reason. They stop the run only when the
  recorded extraction fails to build against the pinned Lean library.
- The extraction guidance checks known tool issues first. Any Rust repair, whichever layer failed,
  gets a two-model review, and a matched recipe has a writer that stages the patch and installs
  nothing. A reviewer verdict is separate from a ratification that an explicitly named model or
  session can give.
- The setup guide covers running the auto track under AO and Codex, the per-worktree `.claude`
  layout and which seat runs each engine operation. Documents explain components in plain words
  instead of private issue shorthand.

### Fixed

- State writes take an exclusive lock and are refused when the file changed since it was read, so a
  concurrent owner choice, agreement or extraction record is never overwritten by an older snapshot.
- A probe that is present but unusable, such as a rust-analyzer proxy that fails `--version` or a
  probe-lean version the graph step refuses, is reported as missing or `unverified-blocked` instead
  of ready. probe-lean 0.24.0 now counts as a route.
- `init-state` profiles on every run, so installing a missing probe clears the gap in a stage line.
- With the project root at a repository root and the Lean project one folder down, the profile
  names that folder. An extraction crate must be in the same git working tree as the project root,
  inside or beside the Lean project. A nested repository or a linked worktree is refused.
  `record-extraction --out` resolves a relative path against the project root.
- The actor permission helper pins the settings directory by descriptor, so a swapped path or a
  staged-file link cannot redirect a grant. It refuses a linked `.claude` folder and a linked
  `settings.local.json`, and names the layout that works: a real `.claude` folder per worktree with
  only the FVS entries linked into it.
- The agreement helper keeps its output and its scratch copy out of the control area and the
  project, and resolves the protected folders through links. These checks are static: a process of
  the same user that swaps a directory or a link between the check and the write is outside the
  threat boundary of this release.
- The Lean constants producer refuses `.ilean` files the graph step would reject, accepts the
  `lake-manifest.json` that Lake creates on a first build, builds modules that no library root
  imports and names them in a warning, and gives import advice only for a module Lake never compiled.
- The closure plan checks the axioms of generated constants that an item passes through.
- A bundle request with a malformed closure plan names the record it needs. Messages in the closure
  plan, Rust identity and transition scripts name records in plain words.

## [3.0.0-rc1] - 2026-11-10

This is prerelease source metadata for the selected-target SWVF candidate. Use an approved exact
source pin; this entry does not claim npm/catalog publication, complete runtime qualification or a
whole-library verification result.

### Added

- `scripts/fvs-extract-patches.mjs` applies ordered translation patches to a disposable copy of
  the Rust extraction inputs and never writes to your checkout. `check` rehearses the patch list
  (every patch applies in order and undoes to the exact starting state), `prepare` builds the copy
  and a manifest with the base source identity and the ordered patch hashes, `verify-tree` shows
  that the tree Charon consumed is the recorded one, `verify-restore` shows that your original
  sources are byte for byte what they were, and `migrate` converts a legacy ledger. A stale or
  already-applied patch fails and is never fuzzy-applied.

- The opt-in v2 auto track uses stock AO and the shared production driver for initial agreement,
  specification and fresh bound review, bottom-up proof dispatch, independent checker acceptance and
  a final human review bundle. Original execution/memory policy and accounting persist across resumes.
  Complete current grants, actor profiles, source identities and request-bound evidence remain required;
  legacy/read-only and missing-context routes retain explicit stops. Component tests or AO/reviewer
  doubles do not establish real-provider qualification. Extraction, reviewed specifications, checked
  proofs and open correspondence assumptions remain separate results.
- The setup checklist documents exact-source installations in every AO worker worktree, user-assisted
  pinned toolchain setup, optional existing primary Beads memory and separate local issue guidance.
  No prerequisite downloads, global installs or memory initialization run automatically.
- Installed shell paths reuse the 2.3.11 safety fix for local/root/nested cwd, spaced paths and literal
  replacement tokens. Pi exact-version selectors accept SemVer prereleases, including `3.0.0-rc1`;
  registry selection still requires that exact version to be published.
- The compatibility profile no longer reports an extraction made with an Aeneas release as conflicting
  with its own lake-manifest pin: Aeneas releases report their release tag (`nightly-YYYY.MM.DD-<commit>`)
  as `aeneas_version`, and the resolver now compares that tag's commit suffix with the pinned commit. A
  different commit is still a conflict. `/fvs:auto-extract` now explains the `aeneas-config.yml` keys the
  resolver reads to find the extraction metadata.
- The patch-mode run-end summary of `/fvs:aeneas-extract` names the copy of the last cycle, that
  cycle's build exit status and the final success-oracle verdict (complete, refused or unknown).

### Changed

- Breaking for new projects: `/fvs:aeneas-extract` now extracts through translation patches by
  default. Every change to the Rust inputs is one patch in `translation-patches/`, listed in order
  in `translation-patches/series`, and the loop writes no `src-modifications.*` files for such a
  project. Extraction runs Charon inside the engine's copy, and a run completes only when the
  build is clean, the copy still matches its recorded tree (an unrecorded repair made inside it
  fails the run), your original sources are restored, every Category-B patch has a human
  ratification bound to its current hash, and the records match the patches by name and hash. The run reports
  extraction, restored source, evidence and the remaining correspondence obligations separately.
- The native inventory is 40 commands and 25 workflows, with the auto commands and their
  workflows added to the explicit inventory allowlists.
- Projects that already carry an active `src-modifications.diff` ledger keep the legacy in-place
  flow, unchanged, until they migrate. The engine picks the mode (`extraction.mode` in
  `.formalising/fvs-config.json` under the crate root overrides it), and a project with both an
  active ledger and a patch list stops with a mixed-mode message instead of picking one.
- To migrate a legacy project, set `CRATE_ROOT` to the crate's absolute path and run
  `node "$HOME/.claude/scripts/fvs-extract-patches.mjs" migrate --project-root "$CRATE_ROOT"`.
  It writes one patch per ledger hunk, copies each entry's
  classification, assumptions, correspondence obligations, assessor evidence and ratification into
  its patch header, and marks the ledger inactive without editing it or the source. If you had set
  `extraction.mode` to the legacy value, set it to `translation-patches` now, then restore the
  pristine source and run `check`. The copied assessor evidence and ratification are history: they
  approved the legacy hunk, so every migrated Category-B patch needs a new ratification bound to
  its hash before a run completes, and editing it afterwards invalidates that ratification.
  Migration is never automatic, and it does not re-establish anything: the steps and limits are
  in `fv-skills/references/extraction-patch-migration.md`.
- A translation patch changes the program the extractor sees, so a clean extraction of a patched
  function does not prove equivalence with the original source. The correspondence obligations each
  patch records stay open until correspondence evidence closes them.

## [2.3.12] - 2026-11-16

### Added

- `/fvs:loop-me-in` writes a self-contained HTML walkthrough of the last chunk of work, so you can
  catch up after an automated run. It states what was established in terms of the mathematics or
  protocol rather than the files. It shows where that step sits on the topic roadmap, as a
  milestone track with every status quoted verbatim and this step and the next steps marked. It
  explains how the work was made as an argument in prose, with links to the declarations and
  statement-only excerpts, never proof scripts. It ends with a multiple-choice quiz whose
  collapsible answers cite the code. (#96, #120)
- The command is offered once after an interactive `/fvs:crypto-eval` ACCEPT. You can also run it
  on demand with a plain-language description, an exact `<topic> nN`, `--commit` or
  `--working-tree`; a bare call ranks the most recently active work and shows one correction screen
  before anything is written. (#96, #120)
- Audience, documentation and style references come from a new `loop_me_in` block in the FVS config
  or from flags. Every code and record link opens the file in your editor at the cited line through
  the editor's URL scheme (`--editor`, `loop_me_in.editor`, or detection from the terminal,
  `$VISUAL`/`$EDITOR`/`core.editor` and `PATH`, with VS Code as the stated fallback), so a browser
  never has to read project files. (#96, #120)
- Output goes under `.formalising/loop-me-in/<slug>/` and is never overwritten. The command runs in
  the current session with no subagent, and never commits, edits project files or changes a
  recorded decision. (#96, #120)
- `/fvs:loop-me-in --final [<topic>]` explains the whole work instead of a chunk, typically at the
  end of a formalisation. It is a tutorial at the level of the top-level theorems, with every idea
  stated mathematically and in prose, no Lean beyond a reading table and editor links, and a trust
  section whose "standard axioms only" claim is made only after a bounded `#print axioms` check.
  The work is the roadmap plus the branch against the branch it diverged from (pull-request base,
  then the reflog, then `main` as the stated default), shown with the other candidates and the
  top-level theorems for correction before anything is written. (#96, #120)
- A workflow guide, `docs/workflow.md`, follows a project from planning through the Rust, paper and
  crypto tracks, the review commands and the session commands, with a diagram for each flow. The
  README shows the functional-correctness and crypto-formalisation pipelines as two diagrams and
  links to the guide, and `/fvs:help` links to it too. The guide lives in the repository and is not
  part of the npm package. (#121, #125)

### Changed

- `/fvs:crypto-execute` names the executor's run report path explicitly,
  `.formalising/fv-plans/<topic>/IMPLEMENTATION_nN.md` next to `build.log` (where it already landed
  in practice), checks it after the run and writes the returned report there itself when missing.
  `/fvs:loop-me-in` reads it as the authoritative list of files an iteration touched. (#96, #120)
- `/fvs:crypto-eval` reads that same report by name, `.formalising/fv-plans/<topic>/IMPLEMENTATION_nN.md`,
  as its source for the files the iteration touched, and checks that the iteration argument is `n`
  followed by digits before it builds the path. When the report is missing, as for an iteration run
  before it was persisted, the eval says so and takes the files from `git diff --stat` and
  `git status --porcelain` instead of rebuilding the list from chat context. (#119)

### Fixed

- `/fvs:help` and the README no longer say that `/fvs:fc-plan` computes a bottom-up verification
  order or sorts functions into "ready now" and "blocked". They now say that it refreshes the graph
  and progress facts in `.formalising/CODEMAP.md`, writes qualitative complexity, leverage and risk
  notes to `.formalising/PLAN.md`, and lets you pick a target; the notes do not certify that a
  target's dependencies are proved. (#124, #125)
- The one-line `/fvs:fc-plan` summary in `/fvs:help`, "Pick next verification targets via dependency
  graph analysis.", now matches those bullets: "Choose a verification target, with qualitative
  notes on complexity, leverage and risk." (#124)

## [2.3.11] - 2026-11-03

### Fixed

- Direct installs resolve bundled script paths from the selected installation directory, including
  project-local installs invoked from a nested working directory. Shell examples quote those paths,
  so spaces and literal shell characters in direct-install paths do not split or expand them.
  Generated plugin examples keep the plugin root, and Pi examples keep package-relative resources.

## [2.3.10] - 2026-11-02

### Fixed

- Codex: crypto and other FVS commands now dispatch their sub-agents without a manual request. Codex
  only spawns sub-agents when the user or a skill explicitly asks; the Codex skill adapter now states
  that invoking an FVS skill is that request, discovers a deferred `spawn_agent` tool first, and stops
  with an explanation instead of silently doing a delegated role inline when sub-agents are
  unavailable (#114).
- Codex: FVS sub-agents start with fresh context on both spawn schemas. The adapter passes
  `fork_turns: "none"` (MultiAgentV2, used by most current models) or `fork_context: false` (V1)
  instead of an unconditional `fork_context: false` that V2 rejects or treats as a full-history fork,
  which also refused the confirmed model and effort (#114).
- Codex: the adapter no longer implies that a role's `sandbox_mode` is enforced. Codex children run
  in the parent session's sandbox; the effective sandbox is reported as the parent's, and a child is
  never called read-only when the parent can write.
- Loop commands that delegate a sub-agent per pass or round (lean-refactor, lean-verify, aeneas-extract,
  lean-specify repair passes, lean-formalise researcher re-dispatch, model-external revision rounds, and
  crypto-plan, crypto-followup and crypto-eval re-authoring or recheck) now state one uniform rule for
  Claude Code and Codex: a fresh child per pass with current inputs, no inline substitution by the parent,
  and a stop when a dispatch fails or ends in a terminal error, while valid results keep their routing.
  lean-refactor no longer starts another pass after a refactorer `## ERROR`. This is an instruction
  contract; it is not host enforcement of each pass (#114).

### Added

- `/fvs:crypto-eval` records a measured `Thinker wall time` in each eval: the `--codex` helper's
  measured process time, or the parent's clock from launch to the thinker's terminal response, or
  `not measured (<reason>)`. Failed or timed-out runs still persist no eval. This is timing
  instrumentation only, with no change to decisions or reviewer policy (#115).
- `/fvs:lean-refactor` works on any Lean file whose proofs already compile, an FVS spec or an ordinary
  Lean project file. Aeneas conventions apply only in Aeneas-extracted projects. Files with `sorry` or
  build errors go to `/fvs:lean-verify`; statements, signatures, attributes, definition meaning and the
  axiom policy stay unchanged, and new helpers stay as local as possible. A selected-file gate checks
  the chosen file with its imports at baseline and after every change (a default build may skip it),
  with real exit status. Outside configured library roots, `lake lean` rebuilds the actual imports,
  including non-default libraries, before each direct check. The Mathlib cache preflight runs only
  in projects that provide it. The argument label is now `<lean_file_path>`. Existing flags remain
  recognized; legacy mode mappings and pass budgets are described below.
  Credit: ideas from `/lean4:refactor` in Cameron Freer's
  lean4-skills (MIT, commit `83582df`), paraphrased.
- The protocol-prose guidance used by existing authoring calls adds a light plain-English wording pass
  after the exposition, guided by ASD-STE100 Simplified Technical English (Issue 9) but not
  STE-compliant. It freezes quotations, citations, code, Lean names, commands and formulas, keeps the
  mathematical register and house style, treats sentence lengths as soft guidance, and preserves
  every claim, quantifier and hedge. It adds no agent or review step.

### Changed

- Lean refactoring resolves the effective installed project toolchain, including overrides, and
  checks Lake's actual compiler path and binary hash before cache/proof work and at baseline/final
  capture. Targets, inspection, tactics and profiling use the project's available capabilities;
  unsupported capabilities use explicit project/review routes without upgrading a pin. Dependency-free
  checks cover Lean/Lake 4.25.2, 4.31.0 and 4.35.0; this is not universal compatibility qualification.
- Lean refactoring proposes a protected boundary and editable file/module/project scope before
  editing. It seeks net LoC reduction through reuse and shared lemmas, including new helper/import
  costs, while preserving useful prose. Broader scope and new public interfaces require proposals.
- Refactor acceptance records actual comparable build/elaboration samples and stops for an owner
  trade-off on a repeatable material performance regression. Tactic tiers, fixed reduction targets
  and unsupported speed guarantees are removed. Legacy mode flags remain explicit search hints
  warned when explicitly supplied; defaults need no migration prompt. Pass ceilings remain budgets.
- Parent-only serial compiler gates and a pristine printed-boundary comparison replace child builds.
  Net-code-LoC reporting excludes comment deletion and known formatting-only packing; operator
  counts are hints, not a hard acceptance limit or a complete Lean parser. Unsupported printed
  coverage or interpolation metrics use explicit reviewed comparisons; helper limitations do not
  block valid refactoring or waive compilation/axiom safeguards. Unavailable counts are not guessed.
  Printed comparisons support review; they are not kernel identity proofs.

## [2.3.9] - 2026-10-27

### Added

- `/fvs:ask-baif` orients users and agents to the current goal and evidence, routes one existing FVS
  command or bounded ordinary-task handoff, and reconciles/books existing issues when authorized.
  Within/between-batch checkpoints preserve ownership, goal acceptance and publication consent without another executor or scheduler.

- `/fvs:to-issues` breaks a roadmap or conversation into reviewable outcomes with blockers and
  acceptance evidence, exporting local markdown or publishing an approved, sanitized GitHub batch
  with explicit relationships and a recovery log.

- `/fvs:roadmap` turns the current conversation or a short prompt into a long-horizon verification
  roadmap (`ROADMAP.md`): the claims to establish, scope and exclusions, external boundaries,
  milestones that an existing FVS command or checker decides, and decisions and status logs that a
  rerun only appends to. It synthesizes facts first, clarifies lightly by default or in adaptive deep
  rounds for material uncertainty/disagreement, and confirms new or changed shared intent explicitly.
  Current owner-approved agreements are reused without redundant questions; unresolved owner choices
  stay blocked, including in autonomous use. It writes under `.formalising/fv-plans/<topic>/` after
  checking that git excludes the file, offers to add `.formalising/` to the repository's local
  `info/exclude` rather than any tracked ignore file, and records unknowns as blocked milestones.
  Approving a roadmap grants no execution, spending or publication authority.
- `/fvs:issues-setup` lets you choose where a project's issues live (GitHub, local markdown, or another
  tracker) and records the choice, with its label vocabulary, in `.formalising/fvs-config.json`. A
  roadmap can override it in its own frontmatter. It only records the choice: it never creates GitHub
  labels or issues, and never edits ignore files.

- `/fvs:protocol-prose <file-or-topic>` revises protocol explanations against the source paper and
  repository conventions while preserving formal content. Lean edits require before/after builds
  and a prose-only comparison. Existing crypto and paper authoring calls receive the same guidance.
- Optional `/fvs:crypto-eval <topic> nN --fix-prose` permits one qualified editorial correction in
  the parent seat, followed by a fresh eval of the corrected files and all findings. Immutable
  baseline/correction/recheck records preserve history; semantic followup remains available when
  current acceptance cannot be established. This does not change the thinker's role or tool rights.

### Changed

- Crypto executors use the host's precise editing tool for localized changes, with unique-preimage
  checks and readback. Dispatch first checks effective edit access; a missing tool or uncertain
  policy blocks instead of silently rewriting whole files. Native whole-file writes remain for
  new files and genuine full rewrites within the approved scope (#107).
- Crypto plan reviews read the cited context needed to settle a question rather than repeatedly
  rereading whole sources. Fresh review, source fidelity, reuse and statement/trust checks remain;
  this wording change does not establish a model speedup or complete the broader #101 work.
- The native inventory is 35 commands and 21 workflows. Setup and package discovery counts derive
  from canonical commands, with explicit inventory allowlists retained in tests.

## [2.3.8] - 2026-10-23

### Added

- Antigravity's `agy` CLI replaces the retired Gemini CLI. `npx fv-skills-baif --antigravity` (or
  `--agy`) installs FVS as a native agy plugin in `~/.gemini/config/plugins/fvs/`, or
  `.agents/plugins/fvs/` for a local install, and the model profiles add an Antigravity planner
  row (Argon 4). Installing or uninstalling for Antigravity removes FVS's own files left by an
  earlier Gemini install and leaves everything else in `~/.gemini` alone; `--gemini` now points to
  `--antigravity`. The plugin passes `agy plugin validate`; how agy uses the agents' tools and the
  update hook at runtime has not been verified yet (#93).
- Argon (`gemini-4-argon-*` through agy) can review Claude- or OpenAI-authored crypto plans,
  specifications and external models. agy runs sandboxed in a temporary copy of the project without
  proof-engineering memory, and the review stops if agy's settings allow access outside the
  workspace. An Argon review sends the review packet to Google under your own agy account terms; on
  consumer accounts Google may use that content (#93).
- Each reviewer process records its start, end and duration, and crypto review records show the
  reviewer's wall time, so slow rounds can be measured (#94).
- The verified probe-aeneas workflow also runs on Linux x86_64. Extraction is confined with
  bubblewrap and works on a separate copy of the project. You need native tools, `/usr/bin/xz`
  and `/usr/bin/bwrap` with working unprivileged namespaces and seccomp; FVS does not install
  them, and it stops if confinement is unavailable. Native Windows and Linux arm64 are still
  unsupported (#77).

### Changed

- `/fvs:lean-verify` proves on its own: it works through every `sorry`, checks compilation itself
  and no longer asks for approval at each step. `--budget` (for example `90m` or `2h`, default `4h`)
  replaces `--max-attempts`. It asks you only to change a theorem statement, when the budget runs
  out or it is stuck, or when the audit flags something. VERIFIED now requires a cheat audit:
  `#print axioms` shows only `propext`, `Classical.choice` and `Quot.sound`; theorem statements,
  the definitions they use and the other Lean sources are unchanged; and no axiom,
  `implemented_by`, `extern`, `@[csimp]`, `unsafe` or kernel-weakening option was added (#90).
- Plan and specification reviews spend less time on checks that add no assurance. Reviewers default
  to `xhigh` effort, with `max` as an explicit choice. They check that verification commands are
  runnable by reading them, not running them. The numeric probe budget is gone: a check the
  available tools could not run is recorded in coverage and is not by itself a finding or a
  BLOCKED reason. Plan-review checklist items are narrower, reviewers no longer re-confirm the
  branch, base or already verified source spans, and triage after a review is lighter (#94).
- The README and `fvs-setup` describe what a skills CLI install report contains and how to opt out,
  instead of telling every user to opt out (#89).

### Fixed

- A completed review is no longer thrown away when its findings are out of order, a suggested edit
  is long, or the reviewer reports a different model than requested; the record lists the warning
  or mismatch instead. Reviewer and planner deadlines default to 30 minutes (#94).

## [2.3.7] - 2026-10-15

### Added

- The GitHub repository has a self-contained `skills/fvs-setup` entry, so the skills CLI can
  discover FVS. It explains the native installation for Pi, Claude Code, Codex, OpenCode and Gemini
  and asks before running an installer. Copying it alone does not install the FVS workflows (#81).
- A practical Lake builds reference covers targeted checks, import artifacts and caches without
  changing your project's toolchain or dependency pins, and credits its source talk. The Lean
  writing commands load it (#79).

### Changed

- The README is shorter and organised around installation for each runtime, the two workflows,
  commands, and updates and removal (#70).
- Codex thinking stages for `/fvs:crypto-plan`, `/fvs:crypto-eval` and `/fvs:crypto-followup`
  receive the full crypto-thinker role and a complete context file, run read-only, and return their
  response. The parent command checks the response and writes the stage files (#63).
- Crypto stages record requested, resolved and observed model settings separately and report a real
  settings mismatch instead of completing the stage. Choosing OpenCode or Gemini as a statement
  reviewer now says that route is unavailable and offers Codex, Claude, a fresh Pi session or an
  acknowledged other reviewer, rather than substituting one (#63).

### Fixed

- Every Lean-writing specialist (executor, crypto executor, external modeler and Lean refactorer)
  is granted lean-lsp-mcp diagnostics and goal states, and the Gemini and OpenCode conversions keep
  those grants. Effective access inside each host has not been verified yet (#74).
- The README lists OpenCode's help command as `/fvs-help`, the name the installer creates.
- `npm run check:plugin`, which `npm publish` runs, no longer fails on macOS, where the default
  temporary directory is reached through a symlink.

## [2.3.6] - 2026-09-29

### Added

- `/fvs:map-code`, `/fvs:fc-plan`, and `/fvs:trust-audit` first check whether the project has a
  verified probe-aeneas: its Aeneas, Charon, and Lean versions must match a tested combination and
  every helper must report the tested version. On macOS arm64, FVS can install the pinned official
  probe-aeneas v0.20.0 into its own versioned directory after you agree, and it runs extraction in
  a sandbox with no network access and no writes outside the project's build directories, the
  output, and a private temporary directory. Without a verified probe you can set it up, continue
  without a graph (qualitative notes only, no counts or verdicts), or cancel. Linux support is
  tracked in #77 (#69).
- Crypto and Lean specification reviews report how many grounding signature lines they charge and
  the first reference that exceeds the budget. A read-only `preflight` checks a request without
  contacting a reviewer (#73).
- In Codex marketplace installs, a workflow that requests an unregistered FVS specialist now warns.
  It then runs a labeled generic agent, or stops before dispatch when the step depends on the
  specialist's settings. The README explains how to switch to the direct Codex installation, which
  registers the specialist roles (#71).

### Fixed

- Completed Claude and Codex reviews are no longer rejected when the reviewer writes one plain
  progress sentence before the required title (#72).
- Native reviewers run in their own process group with a 20-minute review deadline and a 30-second
  version and authentication deadline (`FVS_REVIEW_TIMEOUT_MS`, `FVS_REVIEW_AUTH_TIMEOUT_MS`). On
  timeout or interruption FVS stops the whole group, including descendants. Cleanup is tested on
  macOS and Linux; Windows refuses to launch native reviewers (#75).
- When its sync metadata is missing, `/fvs:sync-aeneas-verif` points only to `/fvs:update`, which
  updates the installation you already have, and no longer suggests the npm installer.

## [2.3.5] - 2026-09-21

### Added

- `/fvs:model-external` resolves one external Rust stub and its bounded dependency closure from
  locked registry, git, vendor, or rustc sysroot source. Candidate changes are reversible and must
  pass separate model-fidelity and specification reviews, completed proofs, a guarded build, and a
  clean trust audit (#33).
- The unified npm installer now installs and removes FVS through Pi's native package manager. It
  supports updateable or exact versions, user and project scopes, explicit conflict handling,
  Pi-first mixed-runtime preflight and installation, and matching Pi installation guidance (#67,
  #68).

### Fixed

- Aeneas guidance synchronization now uses frozen upstream revisions, hash-verified snapshots,
  proposal-before-write review, blocker reconciliation, and project-scoped `native_decide` policy
  without weakening generated-file boundaries (#57).
- Crypto workflows no longer depend on functional-correctness executor names, Aeneas analogies, or
  obsolete sorry-grind assumptions. The dedicated crypto executor and fail-closed bridge boundary
  remain explicit (#65).

## [2.3.4] - 2026-09-20

### Fixed

- Crypto evaluation now trusts Lean's kernel for checked proof terms and concentrates adversarial
  review on statement/source conformance and trust-boundary evidence. It reuses a current executor
  build log or runs one bounded fallback without retry, rather than repeating proof derivations,
  executor gates, or external numeric computations.

## [2.3.3] - 2026-09-20

### Added

- FVS is now a native Pi package with 29 generated skills, provider-qualified model handling,
  `/skill:fvs-*` invocation guidance, and direct `pi install npm:fv-skills-baif` support (#62).
- `/fvs:configure` and every delegated workflow now use stage-scoped, runtime-aware model profiles.
  Quality selects authority, execution, and scout tiers from the live runtime catalog; commands show
  one confirmable model/effort manifest and fail closed when a provider or dispatch cannot honor it
  (#64).

### Fixed

- Fresh local Codex installs create their configuration directory before patch discovery. Local
  patch metadata now separates immutable history from active pending patches, preserves real edits
  without treating unchanged generated TOML as custom, and retires resolved patches atomically
  (#60).
- FC and crypto reviews require explicit catalog-resolved model/effort selections, preserve raw and
  normalized responses separately, retain writable diagnostic scratch without exposing source
  writes, and enforce consistent verdict, severity, authority, and thread-count contracts (#60).

## [2.3.2] - 2026-09-10

### Fixed

- Updates preserve added and modified local FVS files in complete, versioned patch bundles,
  recover legacy unlisted backups, and track generated Codex agent/hook files. Failed backup
  validation stops installation before replacement (#55).
- Claude crypto and FC reviewers can run bounded diagnostic probes in native-sandboxed scratch
  space with explicit generated Lake output paths. Failed launches and invalid responses retain
  local evidence. Sources/plans remain protected; model/effort selection is unchanged (#58).

### Added

- Crypto and FC reviews receive bounded source/reuse inventories with verbatim signature spans
  and freshness checks. FC grounds behavior in implementation source and checks project/mathlib
  helper reuse. Review contracts cover scope economy, CONTENT/PROCESS findings, mathematical
  coverage, and explicit author dispositions. Complete finding validation and mechanical-only
  formatting repair preserve review substance; APPROVE-WITH-EDITS remains terminal (#56).

## [2.3.1] - 2026-09-09

### Added
- Crypto plan and follow-up review now support selected Codex, Claude, or external reviewers with
  explicit model/effort choices, read-only execution, honest provenance, immutable hash-bound
  packets, and a three-round author/reviewer loop. Automatic handoff stays interactive, while
  one-run Skip and `crypto_review.automatic: false` retain an explicit unreviewed trusted path.
  This resolves
  [GitHub issue #51](https://github.com/Beneficial-AI-Foundation/formal-verification-skills/issues/51).

### Changed
- Crypto and functional-correctness review now treat `APPROVE-WITH-EDITS` as terminal once the
  authoring seat applies the exhaustively named bounded edits and reruns its gates. Reviewer output
  remains immutable; only true `REJECT`, `REVISE`, or `BLOCKED` verdicts start a fresh review.
  This resolves
  [GitHub issue #52](https://github.com/Beneficial-AI-Foundation/formal-verification-skills/issues/52).

## [2.3.0] - 2026-09-07

### Added
- `/fvs:lean-spec-review` adversarially reviews a functional-correctness specification against
  its Rust implementation, extracted Lean definitions, and interpretation layer before proof work.
  Users choose the reviewer runtime, model, and effort: Codex offers GPT Sol and Astra, Claude
  offers Fable, cheaper or custom models remain available, and effort defaults to `max`.
- `/fvs:lean-specify` now offers the same review flow automatically after successful generation
  checks. Existing projects need no migration: a missing `spec_review.automatic` setting enables
  the menu, while `{"spec_review":{"automatic":false}}` disables only the automatic handoff.
- Review records preserve runtime/model provenance, source hashes, immutable history, validated
  `PASS | REVISE | BLOCKED` verdicts, and orchestrator triage. Other providers use an exported
  review packet and imported response rather than arbitrary command execution. This resolves
  [GitHub issue #46](https://github.com/Beneficial-AI-Foundation/formal-verification-skills/issues/46)
  and delivers the functional-correctness slice of
  [GitHub issue #32](https://github.com/Beneficial-AI-Foundation/formal-verification-skills/issues/32).

### Fixed
- Lean workflows now retrieve the project cache before build-capable work and cap Lake concurrency
  at four threads unless the caller overrides it. Crypto execution accepts IDE diagnostics when
  available and keeps a documented headless fallback. This resolves
  [GitHub issue #49](https://github.com/Beneficial-AI-Foundation/formal-verification-skills/issues/49)
  and [GitHub issue #50](https://github.com/Beneficial-AI-Foundation/formal-verification-skills/issues/50).

## [2.2.1] - 2026-08-28

### Fixed
- `/fvs:map-code`, `/fvs:fc-plan`, and `/fvs:trust-audit` now derive function membership,
  dependency endpoints, specification state, verification state, and progress totals from
  probe-aeneas output instead of model inference. Targeted runs retain project-wide endpoint truth,
  and public top-level functions are reported only when exact public-API extraction succeeds. This
  resolves [GitHub issue #39](https://github.com/Beneficial-AI-Foundation/formal-verification-skills/issues/39).

## [2.2.0] - 2026-08-24

### Added
- FVS is now packaged as a deterministic dual-runtime plugin payload for Claude Code and Codex,
  with 27 shared skills, 13 Claude agents, portable plugin-root paths, and runtime-specific update
  guidance.

### Changed
- Marketplace distribution now uses the organization-level
  `Beneficial-AI-Foundation/plugins` catalog and the `beneficial-ai-foundation` marketplace ID.
  The catalog pins the independently released FVS payload by immutable tag and full commit SHA;
  the FVS repository no longer publishes its own repository-level marketplace catalogs.
- Plugin installation documentation now distinguishes the BAIF Git catalog from OpenAI's separate
  universal public Plugins Directory.

## [2.1.2] - 2026-08-12

### Added
- Project-local proof engineering now uses an index-first store under
  `.formalising/proof-engineering/`, with one bounded Markdown record per FC, crypto, or shared
  lesson. Formalisation commands retrieve only the most relevant reviewed records and reconcile
  evidence-gated candidates after a run; crypto modeling decisions require source citations and
  remain provisional until adversarial evaluation or an explicit human ruling. Independent crypto
  plan review remains memory-blind. This resolves
  [GitHub issue #38](https://github.com/Beneficial-AI-Foundation/formal-verification-skills/issues/38).

### Fixed
- Codex installation now emits each FVS agent role exactly once in its standalone TOML and keeps
  `config.toml` limited to shared agent settings. Reinstall migrates legacy duplicate declarations
  without disturbing foreign GSD or user configuration. This resolves
  [GitHub issue #43](https://github.com/Beneficial-AI-Foundation/formal-verification-skills/issues/43).

## [2.1.1] - 2026-08-10

### Fixed
- `/fvs:lean-specify` now generates specification module docstrings in the requested style-guide
  form: a standalone opener, a lower-case theorem title, a concise description, and a plain quoted
  Rust source path. This resolves [GitHub issue #42](https://github.com/Beneficial-AI-Foundation/formal-verification-skills/issues/42).

## [2.1.0] - 2026-07-26

### Added
- `/fvs:crypto-review` sends an initial or follow-up crypto plan to authenticated Codex for an
  independent pre-execution adversarial review. Codex runs xhigh, effort-only, ephemeral, and
  read-only; the FVS wrapper persists one validated review artifact and the primary planning seat
  records its evidence-backed response. Codex-authored/unknown-provenance plans and non-APPROVE
  verdicts fail closed before execution.

### Changed
- `/fvs:lean-specify` and `/fvs:lean-verify` now discover and fully load the target repository's
  style guide (configurable with `project.style_guide_path`) into both research and execution
  prompts. A shipped post-write checker enforces the repository line limit (100-column fallback)
  and rejects new ordinary identifiers with three or more namespace dots; verification preserves
  legacy debt only through an explicit baseline and requires full compliance for statement edits.

### Fixed
- FVS installs now verify the shipped Aeneas `_sync-meta.json` mapping and the sync command reports
  real update/reinstall recovery instead of a nonexistent Aeneas installer option.
- The config template now uses the top-level model schema consumed by commands and defaults
  `fvs-crypto-thinker` to `inherit`.

## [2.0.3] - 2026-07-04

### Changed
- The crypto formalisation loop now drives a dedicated crypto executor with an `implement -> check -> complete -> escalate -> BLOCKED` discipline, replacing the borrowed functional-correctness one-sorry-at-a-time proof-attempt grind that did not fit crypto work.
- `/fvs:crypto-execute` gained a runtime-agnostic executor model/effort knob resolved at dispatch time (explicit flag, then a config `model_overrides` entry, then an interactive ask, then inherit the default) so the executor is never hard-pinned to one model.
- The crypto thinker's plan mode is fenced to producing statements rather than proofs, with an added escalate-to-user tier when a step exceeds its remit.
- Guidance now treats `lake build` as the style authority for crypto work, and isolation checks skip the package's own style linters to avoid contradictory signals.
- `/fvs:lean-verify` received a minimal refresh keeping proof-attempt behavior functional-correctness-scoped, decoupling it from the crypto executor without a rewrite.

### Fixed
- Codex `hooks.json` is now written in the nested `{ hooks: { ... } }` shape that current Codex expects; pre-existing flat hook files are migrated on reinstall while foreign entries are preserved.
- Corrected the crypto-plan knowledge-base invocation path so KB querying resolves the intended interpreter and script location.

## [2.0.2] - 2026-07-02

### Fixed
- Codex installs now enable hooks with `[features].hooks = true` instead of an invalid root-level `hooks = true`, which current Codex parses as the hooks config table and rejects at startup.

## [2.0.1] - 2026-07-01

Documentation polish. No code or behavior changes.

### Changed
- README "How It Works" now documents the Aeneas extraction repair loop, the trust audit, and the paper track's crypto loop -- previously only the v1.x five-stage functional-correctness flow was described; the tagline and Prerequisites now cover both the code and paper tracks
- `/fvs:help` documents the crypto loop's `--codex` single- vs dual-runtime flag (which stages accept it, what it swaps, and the no-silent-fallback behavior), and Quick Start / Core Workflow now surface the extraction and crypto-loop entry points
- Install screenshot (`assets/terminal.svg`) version label updated to the v2.0 line

## [2.0.0] - 2026-06-30

Structural cleanup and bundle architecture. Updating from v1.3 applies all renames, moves, and removals automatically (deleted and renamed commands/agents self-heal on install); the installer prints a one-time summary of the changes below.

### Added
- Five bundle router commands grouping the command surface by track: `/fvs:aeneas`, `/fvs:fc`, `/fvs:formalise`, `/fvs:context`, `/fvs:manage` -- each carries a `requires:` frontmatter list and a "User wants -> Invoke" routing table; invoked bare they print the table, invoked with a prompt they route to the matched member skill
- Aeneas extraction repair loop -- `/fvs:aeneas-extract` drives an extract -> classify -> fix -> document -> re-extract loop over a Rust crate, reached via the `/fvs:aeneas` router; six dedicated agents back it: `fvs-extract-classifier` (categorises each extraction blocker), `fvs-extract-applier` (applies the chosen fix), `fvs-extract-bisector` (isolates the failing construct), `fvs-equivalence-assessor` (independent semantic-equivalence review), `fvs-draft-investigator` (drafts upstream issues/PRs), and `fvs-doc-syncer` (reconciles docs)
- Reversible source-modification records for extraction -- every source change is captured as `src-modifications.diff` + a derived `src-modifications.json` and `src-assumptions.md` at the crate root; annotations are preferred over edits and generated files are never written into the source tree, so an extraction run is always reversible and auditable
- Orchestrator-fired Category-B equivalence gate -- an ungated source rewrite halts the loop with a reviewable 7-field gate packet rendered to disk; an independent assessor produces the review, and the loop does not re-extract until the `equivalence-ratified:` oracle token is stamped by hand (self-ratification is impossible)
- Extraction pin audit -- the Charon / Aeneas / Lean / Rust toolchain pins plus lakefile rev drift are checked with a warn-and-confirm prompt before extraction starts; the acknowledgment is stamped into the reversible records as `pin_context`
- Per-blocker attempt caps + no-progress escalation for the extraction loop -- a same-signature recurrence escalates after the attempt cap rather than looping indefinitely; minimal working/failing examples (MWE/MFE) and drafted Charon/Aeneas issues and PRs are written to disk as HTML+MD and never auto-opened
- `/fvs:sync-aeneas-verif` config-driven clone mining -- mines local Charon and Aeneas clones at configured paths and reports clone staleness gracefully when a clone lags upstream
- Crypto formalisation loop -- `/fvs:crypto-plan` / `/fvs:crypto-execute` / `/fvs:crypto-eval` / `/fvs:crypto-followup` drive a topic-based iteration loop laid out under `fv-plans/<topic>/{plans,reviews,sources,merge}`, reached via the new `/fvs:formalise` router; the executor plans are bounded and runtime-neutral, and the eval writes exactly one of ACCEPT / FOLLOWUP / HUMAN_RULING / BLOCKED per round
- `fvs-crypto-thinker` agent + dual-runtime Codex-thinker mode -- single-runtime mode pairs a high-effort `fvs-crypto-thinker` with `fvs-executor`; dual-runtime mode delegates the thinking step to an FVS-owned minimal Codex CLI invocation via `scripts/fvs-codex-think.mjs`, artifact-mediated with no live bridge; NotebookLM KB querying is intensive with a loud-fail-once contract, a labeled degraded mode when the KB is unconfigured, and on-disk answer caching
- `/fvs:trust-audit` + `fvs-axiom-auditor` agent -- a build-backed `#print axioms` audit of a Lean target that inventories only the target's own declarations in fully-qualified strict scope, classifies each as verified / sorry / axiom (treating any `sorryAx` dependence as a `sorry`), notes the classical trio (`propext` / `Classical.choice` / `Quot.sound`) as Lean/Mathlib-standard, and reports NOT-CLEAN while any project-custom axiom lacks a justification, in a dependency-ordered table
- `/fvs:pause-work [path] [note]` destination argument -- write a handoff to a chosen file (path ending `.md`) or directory (`<path>/.continue-here.md`), enabling per-topic handoffs without clobbering the default; every handoff carries an `fvs_handoff: true` frontmatter marker
- `/fvs:resume-work` discovers custom-named handoffs via the `fvs_handoff` marker scan in addition to the `.continue-here.md` glob, and presents a recency-sorted picker

### Changed
- Renamed `/fvs:plan` to `/fvs:fc-plan` (clean break, no alias stub); all cross-references, the underlying workflow, and tests updated in lockstep
- Superseded `/fvs:sync-aeneas` with `/fvs:sync-aeneas-verif` (clean break, no alias stub) -- the doc sync now fans out to two specialised agents: tactics/Lean-syntax sync (the existing `_sync-meta.json` mapping + tactic-rename machinery) and extraction-docs sync, which also reconciles the Aeneas extraction blocker catalog against live upstream (retire / update-signature / still-open, reconcile-not-append); mines the config-driven local Charon + Aeneas clones and reports clone staleness gracefully
- `help.md` and README regrouped by bundle (`lean-refactor` is dual-listed in both `fc` and `formalise`; `map-code` in `context`; `sync-aeneas` in `aeneas`); Quick Start and Core Workflow narrative kept up top
- Codex re-sync from upstream GSD -- the Codex install now follows an effort-only model policy (each agent carries a `model_reasoning_effort`, the `model` is inherited from Codex with no `model` line emitted); the Codex skill-adapter header was re-derived from GSD with a fail-closed execute mode and multi-select handling, dropping the old blanket `Task(` / `AskUserQuestion` word-replace
- Codex config strip is now TOML-section-aware -- it handles legacy `[[agents]]` tables and prunes orphaned per-agent `.toml` files; GSD and FVS coexist across both surfaces (`config.toml` `[agents.*]` / `[model]` tables and the `hooks.json` SessionStart entries), with full Codex hooks parity (the `fvs-check-update` SessionStart hook)

### Removed
- Cross-language port commands `lean-spec-port` and `lean-proof-port` and their workflows (Verus / F* / Coq / Dafny porting); v2.0 is Lean-focused
- The Verus framework-detection branch in `checkpoint` (no more `checkpoint(verus):` commit prefix)
- The four legacy v1.0 agents `fvs-dependency-analyzer`, `fvs-code-reader`, `fvs-lean-spec-generator`, `fvs-lean-prover`
- "Extensible to Verus" positioning from README and help

### Migration
- Updating from v1.3 applies all renames and removals automatically -- no orphaned commands, agents, or manifest entries
- If you locally edited `plan.md`, it is backed up under its old name in `fvs-local-patches/` and must be merged into `fc-plan.md` manually (there is no automatic rename-alias map)
- The Codex per-agent `.toml` cleanup for removed agents lands in a future release

## [1.3.1] - 2026-04-07

### Fixed
- Statusline not showing FVS state in GSD delegation mode -- now detects `.formalising/` as FVS project indicator
- Update/staleness indicators never shown when GSD statusline active -- `readFvsCache()` shared across both modes
- Local install skipping FVS statusline when GSD globally present -- now wraps GSD locally via project-level settings

## [1.3.0] - 2026-04-05

### Added
- `/fvs:lean-formalise` command -- paper track for formalising mathematical papers into Lean 4 specs, 4 interactive prompts, two-phase researcher→executor dispatch, KB integration
- `/fvs:kb-setup` command -- interactive NotebookLM knowledge base setup (venv, auth, KB registration)
- `fvs-kb-query.py` composable CLI tool -- ask/list/health subcommands for querying NotebookLM KBs with structured JSON output
- `fvs-researcher` formalise mode (6th mode) -- reads resources (PDF, images, LaTeX, text), queries KB with domain gating, extracts mathematical structure, proposes Lean file layout
- `/fvs:sync-aeneas` command and workflow for continuous Aeneas upstream integration
- Aeneas upstream documentation snapshot (`fv-skills/upstream/aeneas/`) with sync mapping (`_sync-meta.json`)
- Aeneas staleness detection in session start hook -- queries GitHub API, shows warning in statusline
- Protocol verification domain pattern (Spec_pro/Spec_sec/Spec_pro|=Spec_sec) in lean-formalise
- `knowledge_bases` array in config template for domain-gated KB entries
- Installer copies `scripts/` directory to target with manifest tracking and uninstall cleanup
- Acknowledgements section in README

### Changed
- `/fvs:lean-simplify` renamed to `/fvs:lean-refactor` with expanded refactoring corpus
- `fvs-lean-simplifier` agent renamed to `fvs-lean-refactorer`
- All tactic names migrated to current Aeneas conventions: `progress`→`step`, `@[progress]`→`@[step]`, `omega` BANNED, `agrind` as default
- References enriched from upstream: aeneas-patterns (+400 lines), tactic-usage (+260 lines), proof-strategies (+300 lines), lean-refactoring (+400 lines)
- Test suite expanded from 154 to 167 tests (scripts, new commands, updated counts)

## [1.2.0] - 2026-03-16

### Added
- `/fvs:lean-spec-port` command for porting formal verification specs from other languages (Verus, F*, Coq, Dafny) to Lean -- interactive prompts, cross-project Rust source comparison, semantic blueprint translation, `--scan` flag
- `/fvs:lean-proof-port` command for porting proofs from other languages to Lean -- source proof as strategy blueprint, iterative one-sorry-at-a-time dispatch, tactic mapping (grind, bvify+bv_decide)
- `/fvs:reapply-patches` command for merging backed-up local modifications after updates
- Local patches persistence in installer -- file manifest with SHA256 hashing, automatic backup of modified files before update, runtime-specific restore suggestions
- SVG terminal logo replacing static PNG screenshot

### Changed
- Update command and workflow now include `check_local_patches` step

## [1.1.5] - 2026-03-09

### Fixed
- Codex install uses `skills/fvs-*/SKILL.md` only (removed incorrect `commands/fvs/`), matching GSD pattern
- Codex launch message shows `$fvs-help` (skill invocation syntax)

## [1.1.3] - 2026-03-09

### Fixed
- Codex install now creates `commands/fvs/` for `/fvs:*` slash commands (previously only installed skills)
- Installer shows info when both global and local installs exist (local takes priority)
- Update version detection uses path canonicalization to handle CWD=$HOME edge case

## [1.1.2] - 2026-03-09

### Fixed
- Installer now shows interactive runtime menu when `--local` or `--global` is passed without a runtime flag (previously defaulted to Claude silently)

## [1.1.1] - 2026-03-09

### Fixed
- `/fvs:update` now fetches and displays changelog entries before updating (previously showed no changelog)
- Update workflow uses local-first version detection instead of hardcoded paths
- Update cache clearing covers all runtime directories

## [1.1.0] - 2026-03-09

### Added
- `/fvs:lean-refactor` command for post-verification proof cleanup (#17) -- three modes (safe/balanced/aggressive), tiered heuristics, one change per invocation with build verification
- `fvs-lean-refactorer` agent for iterative proof refactoring
- `lean-refactoring.md` reference with proof-fuel rule, refactoring ordering, layering strategy, target selection heuristics, and repo-specific lessons
- Codex runtime support in installer (#18) -- `npx fv-skills-baif --codex`
- `/fvs:pause-work` command for session context handoff (#10)
- `/fvs:resume-work` command for session context restoration (#10)
- `/fvs:checkpoint` command for structured verification commits (#12)
- `fvs-researcher` generic research subagent for two-phase command dispatch
- `fvs-executor` generic executor subagent with VS Code diff file writing
- Model profile system (quality/balanced/budget) in `fv-skills/references/model-profiles.md`
- `npm test` regression suite -- 132 tests covering frontmatter integrity, installer round-trip, help/README parity, and cross-reference validation

### Fixed
- NL stubs now written to `.formalising/stubs/` instead of project root `stubs/` (#6)
- Statusline delegates to GSD when installed, uses correct 16.5% autocompact buffer in standalone mode (#11)

### Changed
- `/fvs:map-code` refactored to agentic two-phase dispatch (research -> execute)
- `/fvs:plan` refactored to agentic two-phase dispatch (research -> execute)
- `/fvs:lean-specify` refactored to agentic two-phase dispatch (research -> execute)
- `/fvs:lean-verify` refactored to agentic two-phase dispatch with iterative one-sorry-at-a-time executor
- Installer description updated to include Codex

## [0.1.0] - 2026-02-07

### Added
- Initial release: 7 commands, 5 agents, 5 references, 6 workflows, 3 templates
- Multi-runtime installer (Claude Code, OpenCode, Gemini)
- Session hooks (update checker, statusline)
