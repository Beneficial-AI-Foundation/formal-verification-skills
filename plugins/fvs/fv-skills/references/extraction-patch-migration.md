# Extraction Modes and Legacy Ledger Migration

<purpose>
Read this when a project's Rust source is changed for extraction (`/fvs:aeneas-extract`), or when a
project still carries a legacy `src-modifications.diff` ledger. It describes what
`scripts/fvs-extract-patches.mjs` does today and nothing else: the two extraction modes, how a
legacy ledger becomes translation patches, what that keeps, and the steps the owner does by hand.
</purpose>

<modes>

## The two modes

`translation-patches` is the default for new projects. Every change to the Rust extraction inputs
is one translation patch in `translation-patches/` (at the crate root), applied only inside a
disposable copy of the inputs while Charon runs. The original checkout is never written by the
engine, and `verify-restore` compares the touched sources with the state recorded before any patch
ran.

`legacy-source-ledger` is the earlier behaviour: the loop edits the source in place and records the
edits in `src-modifications.diff`, `src-modifications.json` and `src-modifications.md`. The engine
refuses to run patches in this mode, and the extraction workflow follows its legacy steps.

The engine reads `extraction.mode` and `extraction.inputs` from `.formalising/fvs-config.json`
under the directory passed as `--project-root` (the crate root):

- `extraction.mode` set to `translation-patches` or `legacy-source-ledger` decides the mode; any
  other value is refused.
- Unset, a project with an active legacy ledger keeps `legacy-source-ledger`, and every other
  project, including a new one with no patches yet, uses `translation-patches`. Nothing is
  reinterpreted silently: a project with an active ledger leaves legacy mode only through the
  explicit migration below, and setting `extraction.mode` to `translation-patches` beside an
  active ledger is refused as a mixed state.
- `extraction.inputs` lists the extraction input paths relative to the crate root. Unset, they are
  the crate root's `Cargo.toml`, `Cargo.lock`, `build.rs` and `src`, whichever exist. A patch may
  touch only these paths.
- An active ledger and a patch list are never both in use. The engine reports `mixed-mode` (exit
  code 4, like `legacy-mode`; read the `code` field of its JSON result) and changes nothing.

</modes>

<patch_format>

## The patch list

`translation-patches/series` lists one patch file name per line, in application order (blank lines
and `#` comments are skipped). Every `.patch` file in the directory is listed exactly once; the
engine never infers an order from file names. A patch is checked against the state the patches
before it leave, never fuzzy-applied, and every patch must undo cleanly.

A patch starts with a header the engine validates: a `Translation patch: <item>` or
`Supporting patch: <item>` line, then `Change:`, `Why:` and `Behaviour:` lines. `Independent: yes`
declares that it also applies alone to the source snapshot, which the engine then tests. The
extraction workflow adds record lines to the same header: `Classification:`, `Assumptions:`,
`Obligations:` and, for a Category-B change, `Evidence:`.

</patch_format>

<migration>

## Migrating a legacy ledger

The one migration command is the engine's `migrate` subcommand. There is no other migration
command, and the extraction workflow never runs it; migration is the owner's explicit step.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/fvs-extract-patches.mjs migrate --project-root "$CRATE_ROOT"
```

It turns an active `src-modifications.diff` into translation patches:

- One patch per hunk of the ledger diff, in order, paired with the entries of
  `src-modifications.json` (an array of entries, or an object with an `entries` array). The hunk
  count must equal the entry count, and an entry that names a `file` must name the file its hunk
  changes; otherwise nothing is written. A file section without hunks stays one patch.
- Patch files are named `<file stem>-legacy-<id>.patch`, where `<id>` is the entry's `id` (for
  example `M2`), or `hunk<N>` when the entry has none. Ids must be unique. The patches are listed
  in `translation-patches/series` in hunk order.
- Every patch body is the ledger's hunk, verbatim. Every patch touches only extraction inputs.
- Before anything is written, the engine rebuilds the pin in a scratch copy by reversing the
  ledger from the working source, rehearses the new patches on it (apply in order, undo last to
  first), and requires them to rebuild the working source exactly. A working source that does not
  carry the ledger, or patches that do not rebuild it, stop the migration with nothing written.
- It refuses when `translation-patches/` already holds a patch or a `series` file, when more than
  one active ledger is found, and when a leftover `src-modifications.inactive.json` exists (remove
  that file explicitly before migrating again).

## What is preserved

Each legacy entry's values are copied into its patch header, and the entry itself is kept verbatim
in the inactive marker:

| Legacy entry key | Patch header line | Kept as |
|---|---|---|
| `classification` | `Classification:` | the recorded value (A-mechanical, A-opacity or B) |
| `assumptions` | `Assumptions:` | the recorded assumptions |
| `obligations` | `Obligations:` | the correspondence obligations the entry recorded |
| `evidence` | `Evidence:` | historical metadata: the assessor evidence reference (the gate packet path) |
| `ratification` | `Ratification:` | historical metadata: the human ratification token, verbatim |

A key that is absent or empty gets no line. Every patch also states in its header that it is
migrated verbatim from the ledger and that migration does not re-establish equivalence. The
classification, assumptions and obligations are the patch's record from now on. The assessor
evidence and the ratification are kept so the history is not lost, but they approved the legacy
hunk, not the patch file in its current bytes, so they never count toward completion: every
migrated Category-B patch needs a new gate whose packet names the patch (`patch-file:`) and
records its current sha256 (`patch-sha256:`), and editing the patch afterwards makes that packet
stale. The gate packets in the extraction workspace and `src-assumptions.md` are not touched.

`src-assumptions.md` keeps naming the legacy ids (`M2`). Each migrated patch is named
`<file stem>-legacy-<id>.patch`, repeats its entry's assumptions in its `Assumptions:` header, and
is listed in the marker with its file name, sha256 and entry, so an old reference resolves to a
patch by id. The extraction run's record check reads one reference field in `src-assumptions.md`,
a line `patch-file: <exact file name>`, and compares the rest of the line, whole, with the patches
in the manifest. An entry that carries no such line names no patch, so the check does not treat it
as an orphan, and prose that merely mentions a file name is not a reference; add a `patch-file:`
line to an entry (step 7 below) to give it a current identity. A patch's identity is its file name
and the sha256 recorded in the run's manifest; the marker's sha256 only records the bytes at
migration.

## The inactive state

A successful migration writes `src-modifications.inactive.json` next to the ledger. It records the
exact content and mode of every ledger file at that moment, the file name and sha256 of every
migrated patch with its hunk number, and each legacy entry verbatim. The ledger files themselves
stay in place, byte for byte. A ledger whose files still match the marker is **inactive**: it
does not make the project legacy or mixed, and the extraction workflow never reads it as evidence
for a patch. The classification, assumptions and obligations copied into patch headers are the
patch's record; the copied approval is historical metadata only.

A ledger file edited after migration no longer matches the marker, so the ledger is active again
and the engine reports `mixed-mode` until the owner resolves it. Nothing is deleted automatically;
whether to keep the retained ledger files is the owner's decision.

## The manual steps

`migrate` never edits the ledger or the source, so the owner does the rest by hand:

1. Before migrating, make sure the working source carries exactly the changes the ledger
   records (the migration checks this) and that you can get back to it, for example with a commit.
2. Run `migrate` as above and read the patches it wrote.
3. If `extraction.mode` is set to `legacy-source-ledger`, set it to `translation-patches` now,
   before any `check`: while the old value stays, the engine refuses with `mixed-mode` because a
   patch list now exists, and no later step can succeed.
4. Restore the pristine source (the pin the ledger was made against). The working source still
   carries the legacy edits, so until it is restored `check` stops at the first patch, reporting
   it as already applied. The engine does not restore the source for you.
5. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/fvs-extract-patches.mjs check --project-root "$CRATE_ROOT"`. It
   must report `translation-patches` and that every patch applies in order and undoes exactly.
6. Review each migrated patch's `Obligations:`. They are still open obligations; the copied
   `Evidence:` and `Ratification:` are history. The patches are per hunk, not per function;
   regrouping them is a manual edit the engine does not check against the marker.
7. In `src-assumptions.md`, add a line `patch-file: <exact file name>` to each entry for a legacy
   id, naming the migrated patch (`<file stem>-legacy-<id>.patch`).
8. Run `/fvs:aeneas-extract`. The first run records a manifest with the base source identity and
   the ordered patch hashes, and its completion check asks for a new, hash-bound gate for every
   migrated Category-B patch. Ratifying a migrated patch changes nothing in
   `translation-patches/`: the patch and its `series` entry stay as migration wrote them.

</migration>

<limits>

## What translation patches do not establish

A translation patch changes the program the extractor sees. A clean extraction of a patched
function does not prove equivalence with the original source, and a migrated patch carries no
more than the legacy run recorded: its old approval is history, not a ratification of the patch
as it now stands. The correspondence obligations in the patch headers stay open
until correspondence evidence closes them, and the extraction run reports them separately from
extraction success, restored source and valid evidence.

</limits>
