# Native Windows probe setup and recovery

<overview>

The `windows-source-v1` distribution builds pinned, patched sources. Its identity
is separate from the official `probe-aeneas` Windows archive. The changed setup
and recovery implementation remains unqualified. Native regressions, authenticated
setup reuse and production installation denial have passed. Fresh installation
was blocked by a differing existing Lean helper, which setup preserved; complete
normal-command acceptance also remains outstanding. The previous qualification
remains historical. Verified support
is available only when the shipped qualification metadata and the project's
Aeneas/Charon/Lean tuple match. The historical native acceptance used the normal
`setup`, `resolve` and `run` commands on Windows 11 x64 with the pinned Dalek
project in a directory containing spaces. Installing tools alone does not
establish that a particular project and runtime are verified.

Use native Windows x64 Node and PowerShell on a supported Windows 11/local NTFS
layout. ARM64 emulation, WSL, network shares, reparse aliases and unsupported path
lengths are not substitutes for native qualification. FVS refuses these layouts
without changing Windows security policy.

</overview>

## Inspect and explicitly set up

Set `$InventoryScript` to the installed `scripts/fvs-probe-inventory.mjs` and
`$ProjectRoot` to the project directory, including quotes when it contains spaces.

```powershell
node $InventoryScript resolve --project-root $ProjectRoot --format json
node $InventoryScript setup --distribution windows-source-v1 --project-root $ProjectRoot --manifest
```

The manifest describes prerequisites, source recipes, destinations and changes.
After setup is authorized, run:

```powershell
node $InventoryScript setup --distribution windows-source-v1 --project-root $ProjectRoot --consent interactive
if ($LASTEXITCODE -ne 0) { throw 'Source setup failed; retain its diagnostics.' }
node $InventoryScript resolve --project-root $ProjectRoot --format json
```

Setup requires the native Rust 1.98.1 MSVC toolchain, Visual Studio 2022 Build
Tools with MSVC 14.44.35207, Windows SDK 10.0.26100.0, Git for Windows, and the
Windows x64 .NET Framework compiler. The manifest reports the discovered paths
and missing prerequisites. Rust must include `cargo`, `rustc`, `rust-std`,
`rustfmt`, `rust-analyzer` and `rust-src` for the pinned toolchain. Additional
default-profile components such as Clippy and Rust documentation are accepted.
Setup checks the required set before copying the full build environment or building helpers;
confined resolution uses the same set check. Other version checks remain exact.
The project must already contain its Cargo lockfile and generated translation
metadata. Setup vendors that locked dependency closure in an isolated project
copy; it does not change the original lockfile.

The bundled `scripts/fvs-probe-native/windows-source/policy.json` is the recipe
authority. It pins the source commits and patch checksums for probe-aeneas
0.20.0, probe-rust 0.11.0, probe-lean 0.14.0 and the Rustup compatibility patch,
plus SCIP 0.10.0 and the Lean 4.31.0 archive. Fresh builds reconstruct those
sources in private directories. Receipts distinguish a fresh build from reuse
of an exact reviewed historical artifact; reuse does not claim a new compilation.
An ordinary subsequent setup also reuses helper outputs from the current
registered installation when its complete source policy and runtime identities
still match. Receipts record that installation and receipt digest in `reusedFrom`.
Project dependencies are vendored again, including for a different project.
Lake `.trace` files are excluded from newly published helper outputs. Existing
historical traces remain untouched and protected with their containing directory.

For explicitly authorized noninteractive setup, set the process environment
`FVS_PROBE_SETUP_POLICY=build` and use `--consent policy`. The official installer
has its separate `FVS_PROBE_INSTALL_POLICY=install` policy; neither implies
permission to continue without a graph.

`--cache-dir` may supply previously downloaded archives or reviewed artifact
groups. Cache paths are untrusted inputs: bundled hashes and recipes determine
what may be reused. No caller-provided policy, receipt or binary hash authorizes
execution. Setup publishes its own receipt and immutable managed installation.

An optional cache has this layout:

```text
archives/<exact archive filename from policy.json>
artifacts/probe-aeneas/probe-aeneas.exe
artifacts/probe-rust/probe-rust.exe
artifacts/scip/scip.exe
artifacts/rustup/rustup-init.exe
artifacts/probe-lean/bin/<approved executable and adjacent DLLs>
artifacts/probe-lean/lib/<complete approved runtime library tree>
```

Every artifact file is checked against the built-in group before reuse. A cached
receipt cannot approve additional bytes. Missing groups use the pinned source
recipe; altered groups fail explicitly. Long phases report their names and
timings. Keep the installation receipt and build logs for reproducing a result.

The pinned extractor requires versioned Lean helpers in the actual Windows
profile. Setup reuses only explicitly approved identical files and refuses
conflicts. It does not replace the user's official Rustup or silently rewrite
existing helpers. The real known folders, not `HOME`/`USERPROFILE` overrides,
determine these paths. Setup records which files it created for safe recovery.
Differing existing executables or libraries remain conflicts, even if their
reported versions match. A new build never overwrites such files.

## Extract through FVS

Continue only when resolution returns `verified`. The default Windows
distribution selection uses the qualified source build; `--distribution official`
retains the independently gated official release route.

Resolution never installs or downloads tools. It creates a temporary restricted
Windows profile and applies session-specific read/execute permissions to the
approved helper resources. All version and component checks share one session
and run from an empty, read-only private directory. FVS removes those grants and
the profile, drains the process job, and checks protected file inventories before
returning `verified`. These temporary permission changes require a writable
coordinator even though the helper checks are read-only.

```powershell
$Output = Join-Path $ProjectRoot '.formalising\extract.json'
New-Item -ItemType Directory -Path (Split-Path $Output) -Force | Out-Null
node $InventoryScript run --project-root $ProjectRoot --output $Output
if ($LASTEXITCODE -ne 0) { throw 'No graph was accepted; inspect the diagnostic.' }
```

Use a new output filename if one already exists. FVS checks exact tool identities,
runs version/component probes under confinement, and extracts from an independent
project copy. Only private staging/output/temp are writable. Publication requires
a valid nonempty canonical graph, completed process-tree cleanup, a durable cleanup
receipt, unchanged protected inputs and removed staging. Windows `--with-public-api`
is refused until separately qualified.

Prepare project dependencies and the Lean build before offline extraction. Keep
successful build output, including `sorry` warnings, intact. Do not synthesize
build logs or change project pins to make a cache appear valid.

Large prepared caches also make integrity checks expensive. On the historical qualification
host, setup with reviewed helper artifacts took about 17 minutes, explicit
resolution took 68 minutes, and `run` took 165 minutes. The confined extractor
itself took 18 minutes; repeated integrity inventories of roughly 131,000 project
entries accounted for most of the remaining time. The prepared Lean build cache
was reused. These are observations, not time limits or estimates for another
machine. Progress identifies each phase; `run` repeats resolution before staging
and extraction. Keep its diagnostics if you interrupt it, and use the reported
recovery command when required.

## Interrupted work

The coordinator uses the actual profile's `.fvs/windows-confinement` directory,
outside AppData package virtualization. One native session may be active per user.
Resolution reports busy/recovery-required state and does not silently repair it.

```powershell
node $InventoryScript recover --session $SessionId
```

Use only the session ID reported by FVS. Recovery validates the authoritative
journal, drains the exact process job and rolls back the session; it never resumes
an interrupted extraction. Repeated recovery is safe. A live owner, changed resource
identity, corrupt journal, unsupported cross-logon recovery or uncertain cleanup
causes refusal with retained diagnostics. Do not delete the coordinator, alter
resource permissions by hand, or substitute a different launcher to bypass refusal.

Interrupted source setup reports a session such as `setup:0123...`; use the same
`recover --session` command with that entire value. Setup and execution share the
per-user lifecycle lock. Setup recovery drains its build processes, preserves
adopted existing helpers, and removes only journaled files whose identities still
match. A durable marker in the coordinator blocks new sessions until recovery
succeeds, even if `FVS_TOOLS_HOME` has changed. Recovery locates the originally
recorded installation root from that marker. Completed older installations remain available for their original
confinement sessions to recover with the exact responsible launcher.

## Meaning of a successful run

The historical normal-command acceptance produced 279 canonical functions and 189 matched
Charon/Lean joins, exactly matching the retained v10 function inventory and proof
classifications. Its pinned source has eight `sorry` warnings, and the combined graph has
47 Lean dependency references to 22 absent keys. Preserve these warnings and
trust limitations; extraction success does not prove every function. Native
qualification concerns the exact tools, confinement and extraction workflow.
