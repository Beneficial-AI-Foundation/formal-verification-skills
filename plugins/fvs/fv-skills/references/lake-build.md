<overview>
# Practical Lake builds

Use Lake to choose the smallest meaningful check, then run the existing final project/style/trust
gates. A selected target is not whole-project acceptance. This reference grants no tool permission,
changes no consumer pins, and does not replace role, review, statement or write constraints.

Inspired by [Understanding Lake](https://github.com/mpenciak/lean_build_talk/tree/551c61ba0263a59279ffaa892d2927b269e713c9)
([slides](https://github.com/mpenciak/lean_build_talk/blob/551c61ba0263a59279ffaa892d2927b269e713c9/slides.md)).
The talk's example toolchain is Lean **4.34.1**; do not upgrade a consumer to match it.
Behavior below is source-checked against official **v4.31.0** and **v4.33.1** Lake sources.
Examples, missing-import negative/positive checks, native facets, final builds and timing are
**UNRUN**, operator-postrelease measurements, not successful compiler receipts.
</overview>

<quick_reference>
## Select work, not an acceptance label

Official selector grammar: `[@[<package>]/][<target>|[+]<module>][:<facet>]`.
The `@` package and `+` module markers disambiguate names from targets/files.

| Selector | Meaning |
|---|---|
| `a` | Target `a`, its configured default facets |
| `@a` | Package `a`, its configured default targets |
| `+A` | Module `A`, default module facets |
| `@/a` | Target `a` in the root package |
| `@a/b` | Target `b` in package `a` |
| `@a/+A:c` | Module `A` of package `a`, C facet |
| `Foo/Bar.lean:o` | Workspace source module `Foo.Bar`, native object facet |
| no selector | Root package's configured default targets, not every `.lean` file |

[Help v4.31.0](https://github.com/leanprover/lean4/blob/v4.31.0/src/lake/Lake/CLI/Help.lean#L115-L165),
[Help v4.33.1](https://github.com/leanprover/lean4/blob/v4.33.1/src/lake/Lake/CLI/Help.lean#L115-L165).
Library **roots** determine membership; **globs** choose built modules (default: each root itself).
Local imports of selected modules are recursively built. An unimported, unselected bad file can
remain unchecked by a green default build. Inspect actual configured gates and test/lint drivers.
[Library configuration](https://github.com/leanprover/lean4/blob/v4.31.0/src/lake/README.md#lean-libraries).

## Facets and outputs

- `:olean`: binary Lean import data, not a proof of the intended specification.
- `:ilean`: editor metadata; not interchangeable with import data.
- `:leanArts`: default library/module facet in these checked versions: `.olean`, `.ilean`, `.c`.
  Newer module systems may split additional artifacts; inspect the matching pinned version.
- Module `:c`, `:o` and `:dynlib` are different native work; library `:static` / `:shared`
  build archives / shared libraries. Native compiler, linker and dynamic library closure need
  their own exact qualification. Do not infer native linking from successful elaboration.
- Conventional outputs: `.lake/build/lib/lean`, `.lake/build/ir`, `.lake/build/bin`;
  package configuration may override these locations.

## Before any operation that loads Lean

Honor the request's exact separate consent and actual tool/source/confinement requirements.
For these illustrative measurements, establish **ONE simultaneous compiler**, at most **TWO threads**
per compiler, **nice19** through **ALL descendants**, including Lake configuration loading,
Lean metaprograms, downstream compilers and native linkers. A command prefix, timeout,
`LEAN_NUM_THREADS=2`, scheduler flag or JSON boolean is NOT whole-chain enforcement.
Verify owned writable root, HOME/TMP/toolchain/cache paths, executables/dylibs, source identities,
OS confinement and lifecycle effects before loading anything. Stop on unavailable/unverifiable
controls; do not install shims, fetch caches or change global settings to make qualification green.
These specific measurement gates do not invent a global metadata veto for ordinary authorized FVS
commands. Existing commands retain their own policy and final gates; a stricter request wins.
</quick_reference>

<patterns>
## Concrete teaching names (prose only; never generated or executed here)

For illustration, package `a` has libraries `a`, `b` and `Foo`, with respective roots `A`, `B`,
`Foo`; only target `a` is a package default. Matching `lakefile.toml` data would be:

```toml
name = "a"
defaultTargets = ["a"]
[[lean_lib]]
name = "a"
roots = ["A"]
[[lean_lib]]
name = "b"
roots = ["B"]
[[lean_lib]]
name = "Foo"
roots = ["Foo"]
```

`A.lean` imports `Foo.Bar` and defines `answer : Nat := Foo.Bar.value`;
`Foo/Bar.lean` defines `Foo.Bar.value : Nat := 7`;
`B.lean` imports `A` and states `example : answer = 7 := rfl`;
`Foo.lean` imports `Foo.Bar`. Thus every selector above names a defined target/module.
`Unselected.lean` is outside these roots/imports and could contain an error without changing default
coverage. A future deliberately bad **selected** `B.lean` must make `lake build b` fail;
correcting only that teaching file is not permission to repair a consumer's statement.
Native object/static/shared selectors remain conditional on compatible native tools.

## Imports before a direct check

`lake env [command] [arguments]` supplies Lake's toolchain/search environment; it **does not build
imports**. Building a dependency's `:olean` first can supply missing import data, whereas a direct
file check alone does not populate normal package outputs or run all project linters.
[Env vs exe implementation](https://github.com/leanprover/lean4/blob/v4.31.0/src/lake/Lake/CLI/Actions.lean#L20-L30).

Only inside a separately approved, actually enforced scope, these illustrative argv sequences
would select the teaching work (not copy-ready permission to run them):

```text
lake env lean A.lean          # missing Foo.Bar import data: future negative check
lake build +Foo.Bar:olean     # build import prerequisite
lake env lean A.lean          # future positive direct-file check
lake build a                  # selected library default facets
lake build @a/b               # distinct, non-default target
lake build @a/+A:c            # C output, not an object/link gate
lake build Foo/Bar.lean:o     # requires qualified native compiler
lake build a:static           # separate native archive work
lake build a:shared           # separate native linking work
lake build @a                # configured defaults, not all source files
```

Do not infer negative/positive compiler semantics from these source-cited examples: all are UNRUN.
Capture real exit status independently from displayed logs: Bash pipelines need `set -o pipefail`
and `${PIPESTATUS[0]}` captured immediately; also check `tee`/log-write failure. A green tail/grep
is not a build result. Run the existing configured full package/style/tests/trust gates after a
useful targeted check; preserve the FC cheat audit, whole-unit crypto and one-change refactor discipline.

## Configuration, locks and caches are different

| Input/state | Purpose; safe response |
|---|---|
| `lakefile.lean` or `lakefile.toml` | Package/target/options configuration; inspect actual roots/defaults |
| `lake-manifest.json` | Resolved dependency revisions; preserve and compare locked identities |
| `lean-toolchain` | Consumer compiler/toolchain pin; do not adopt the talk's pin |
| `.lake/packages` | Resolved dependency sources; missing dependency can trigger fetching, even during a build |
| `.lake/build` and traces | Project outputs and input/dependency hashes; not global caches |
| Lake artifact/release caches | Optional reuse of compatible artifacts, version/configuration dependent |
| Mathlib `lake exe cache get` | Project-provided executable, NOT a universal Lake builtin |

Preserve the existing FVS cache-first policy where applicable, with its actual request-local
permission/confinement checks. A dependency-free teaching package does not define Mathlib's cache
executable. An offline miss is not consent to fetch or rebuild a huge dependency.
[Dependencies and Mathlib](https://github.com/leanprover/lean4/blob/v4.31.0/src/lake/README.md#adding-dependencies).

In v4.31.0, `LAKE_NO_CACHE`, `LAKE_ARTIFACT_CACHE`, `LAKE_RESTORE_ARTIFACTS`, `LAKE_CONFIG` and
`LAKE_CACHE_DIR` are separate controls. `LAKE_CACHE_DIR` sets Lake's cache locations; an empty value
disables the system cache, not every possible write. Do not infer Mathlib cache relocation from it.
Inspect the matching toolchain source before choosing values; do not enable remote cache upload,
copy credentials or delete caches as triage.
[Env v4.31.0](https://github.com/leanprover/lean4/blob/v4.31.0/src/lake/Lake/Config/Env.lean#L175-L203),
[Env v4.33.1](https://github.com/leanprover/lean4/blob/v4.33.1/src/lake/Lake/Config/Env.lean).
`lake update` is for an **intentional dependency change**, with reviewed configuration/lock diff;
it can download/upgrade dependencies. It is not generic error repair.

## Failure decision table

| Observation | First inspect / exact repair to request |
|---|---|
| Unknown target/module | Correct project cwd/root, spelling, package qualifier and source path |
| Green build ignores a file | Library roots/globs, imports, configured default targets and gate coverage |
| Missing imported `.olean` | Exact pinned dependency/module artifacts; approved targeted prerequisite build |
| Toolchain/manifest mismatch | Compare locked identities and artifact provenance; no automatic upgrade |
| Fetch/offline failure | Expected dependency source/hash and allowed offline scope; stop for exact consent |
| Native/FFI/link failure | Compiler/linker/dylib identity, platform/backend/options, approved native outputs |
| Semantic or style diagnostic | Preserve the statement; use actual diagnostics, then final package/style gate |

Live feedback is separate from Lake: recommend existing lean-lsp-mcp, report actual unavailable
access, honor required-live stops and request-specific warned explicit compiler fallback.
Conditional IDE diagnostics are not goal access. No Beam backend/readiness promotion is supplied.
Reviewers follow [diagnostic-only confinement](review-diagnostics.md), not writer permissions.
</patterns>

<anti_patterns>
Never replace a project gate with a selected module check; confuse `lake env` with import building;
run indiscriminate `lake update`; delete project/global caches wholesale; silently upgrade pins;
or treat source/Node tests as compiler timing/semantic proof. Do not guess Lake job flags.

## Future operator procedure

The optional `tests/helpers/lake-reference-live.cjs --qualification <absolute-file>` is currently
read-only preflight/refusal, not an executable measuring backend. No accepted real whole-chain
control surface exists here. It refuses before loading tools even when synthetic input looks valid.
Before future measuring implementation/invocation, separately qualify and independently review
real controls and exact-operation consent, all owned toolchain/cache/executable/dylib/root/source
and lifecycle boundaries. Then measure missing-import red/green, every selected/default facet,
unselected-source coverage and selected final-build failure/success, preserving input/manifest/
toolchain hashes, exact argv/env/exit/stdout/stderr/native artifacts and timings in persistent owned
storage. No cleanup before independently verified durable retention. None of those measurements
or live issue acceptance is passed by this source release.
</anti_patterns>
