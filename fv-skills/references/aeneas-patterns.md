# Aeneas Pipeline Patterns (REF-01)

<overview>
The Aeneas pipeline translates Rust code into Lean 4 for formal verification. It produces
auto-generated type definitions (Types.lean) and function bodies (Funs.lean) that serve as
the ground truth for verification. Understanding the pipeline output, project layout, and
working modes is essential before writing any specification or proof.
</overview>

<quick_reference>

| File / Directory | Description | Editable? |
|---|---|---|
| `Types.lean` | Auto-generated Rust type translations (structs, enums) | NEVER |
| `Funs.lean` | Auto-generated Rust function translations | NEVER |
| `TypesExternal.lean` | Opaque external type stubs | Rarely (project-specific) |
| `FunsExternal.lean` | Opaque external function stubs | Rarely (project-specific) |
| `Defs.lean` | Hand-written mathematical definitions and constants | Yes |
| `Specs/` | Hand-written specification theorems and proofs | Yes |
| `Defs/` | Hand-written extended definitions (e.g., curve representations) | Yes |
| `lakefile.toml` | Build configuration; pins Aeneas backend revision | Carefully |
| `lean-toolchain` | Lean version pinning (e.g., `leanprover/lean4:v4.24.0`) | Carefully |
| `functions.json` | Metadata index of all extracted functions | Generated |

</quick_reference>

<patterns>

## Pattern 1: Project Directory Structure

A verified Lean project produced by Aeneas follows a consistent top-level layout
(Types.lean, Funs.lean, lakefile.toml, lean-toolchain). The Specs/ and Defs/ directories
are hand-created by the verification team and their internal structure varies by project.

**Example layout (curve25519-dalek-lean-verify):**

```
ProjectRoot/
  lakefile.toml              # Build config; requires aeneas backend
  lean-toolchain             # Lean version pin
  functions.json             # Function metadata index
  extraction_notes.md        # Documents Aeneas limitations encountered

  ProjectName/               # Main Lean library (e.g., Curve25519Dalek/)
    Types.lean               # AUTO-GENERATED: all Rust types
    Funs.lean                # AUTO-GENERATED: all Rust function bodies
    TypesExternal.lean       # Stubs for opaque external types
    FunsExternal.lean        # Stubs for opaque external functions
    TypesAux.lean            # Auxiliary type definitions
    Aux.lean                 # Auxiliary lemmas
    Tactics.lean             # Project-specific tactics

    Defs.lean                # Mathematical constants and interpretation functions
    Defs/                    # Extended definitions
      Edwards/
        Representation.lean
        Curve.lean

    Specs/                   # Specification theorems and proofs
      Backend/
        Serial/
          U64/
            Field/
              FieldElement51/
                Add.lean
                Sub.lean
                Mul.lean
                Reduce.lean
                ...
            Scalar/
              Scalar52/
                Add.lean
                MontgomeryMul.lean
                ...
          CurveModels/
            CompletedPoint/
              AsExtended.lean
              ...
      Edwards/
        EdwardsPoint/
          Add.lean
          Double.lean
          ...
      Montgomery/
        MontgomeryPoint/
          Mul.lean
          ...
      Scalar/
        Scalar/
          Reduce.lean
          ...

  Utils/                     # Utility executables (e.g., ListFuns, SyncStatus)
```

The `Specs/` directory mirrors the Rust module hierarchy. Each Lean spec file corresponds
to one Rust function.

## Pattern 2: Aeneas Extraction Pipeline

The translation from Rust to Lean follows this pipeline:

```
Rust source code
    |
    v
  Charon (Rust compiler frontend plugin)
    |  - Compiles Rust to MIR
    |  - Produces LLBC (Low-Level Borrow Calculus) representation
    v
  LLBC (.llbc file)
    |
    v
  Aeneas (Lean backend)
    |  - Translates LLBC to functional Lean 4
    |  - Resolves borrows, lifetimes, mutability
    |  - Produces Types.lean + Funs.lean
    v
  Lean 4 project
    |  - Types.lean: struct/enum definitions
    |  - Funs.lean: function bodies as pure Lean functions
    |  - Result type wraps all functions (ok/error for panics)
    v
  Human writes Specs/ and Defs/
```

Key details:
- All extracted functions return `Result T` to model Rust panics
- Array indexing becomes bounds-checked operations returning `Result`
- Mutable borrows are translated to functional updates
- The `cfg(not(verify))` flag in Rust excludes functions from extraction
- The Aeneas backend is pinned by git revision in `lakefile.toml`

### Aeneas Limitations

Not all Rust patterns can be extracted. Known limitations include:

- **Dynamic array indexing**: `output[i] = val` where `i` is computed at runtime
- **Iterator trait machinery**: `.map()`, `.collect()`, complex iterator chains
- **Dynamic dispatch**: `dyn Trait` objects
- **Async/await**: Not supported

When extraction fails, the standard workaround is `#[cfg(not(verify))]` to exclude the
function and all its transitive callers. Document these exclusions in `extraction_notes.md`.

## Pattern 3: Working Modes

Verification work falls into three modes, each with different tactics and approaches:

### Mode 1: Rust Code Verification
Start from the Aeneas-generated function signature. Focus on proving the implementation
matches a mathematical specification.

```lean
-- Primary tactics for verification:
unfold rust_function_name    -- Expand the auto-generated definition
progress                     -- Make forward progress on verification goals
simp [relevant_lemmas]       -- Simplify
scalar_tac                   -- Resolve scalar arithmetic goals
```

### Mode 2: Mathematical Bridge Building
Connect high-level mathlib abstractions with low-level crypto implementations.
Create new definitions and bridge theorems.

```lean
-- Primary tactics for mathematical work:
ring                         -- Ring arithmetic
field_simp                   -- Field simplification
simp [group_laws]            -- Abstract algebraic simplification
```

### Mode 3: Technical Debt and Refactoring
Identify repeated proof patterns, extract common lemmas, improve organization.
Focus on maintainability and proof reuse.

## Pattern 4: functions.json Metadata Format

The `functions.json` file indexes every extracted function with verification status:

```json
{
  "functions": [
    {
      "rust_name": "curve25519_dalek::backend::serial::u64::field::FieldElement51::add",
      "lean_name": "curve25519_dalek.backend.serial.u64.field.FieldElement51.add",
      "source": "curve25519-dalek/src/backend/serial/u64/field.rs",
      "lines": "L120-L135",
      "verified": true,
      "specified": true,
      "fully_verified": true,
      "spec_file": "Curve25519Dalek/Specs/Backend/Serial/U64/Field/FieldElement51/Add.lean",
      "spec_statement": "theorem add_spec ...",
      "spec_docstring": "...",
      "is_relevant": true,
      "is_hidden": false,
      "is_extraction_artifact": false,
      "dependencies": ["...other_lean_function_names..."],
      "nested_children": []
    }
  ]
}
```

Key fields for workflow:
- `verified` / `specified` / `fully_verified`: Track progress
- `spec_file`: Path to the spec theorem
- `dependencies`: Which other extracted functions this calls (for dependency analysis)
- `is_hidden`: Trait wrapper functions that delegate to inner implementations
- `is_extraction_artifact`: Functions generated by Aeneas without Rust counterpart

</patterns>

<anti_patterns>

## NEVER edit Types.lean or Funs.lean

These files are auto-generated by Aeneas. Any manual edits will be overwritten on
re-extraction. If a type or function definition looks wrong, the fix must happen in the
Rust source or in the Aeneas pipeline configuration, not in the generated Lean files.

## NEVER hallucinate lemma or tactic names

Always verify that a lemma, theorem, or tactic exists before using it in a proof.
Lean 4 will reject undefined names at compile time, but hallucinated names waste
significant build cycles (full builds can take 30+ minutes). Use exploratory tactics
like `exact?`, `apply?`, or `simp?` to discover available lemmas.

## NEVER skip dependency analysis

Before writing a spec for function `f`, check `functions.json` to identify all functions
that `f` calls. Each dependency must have a proven spec (with `@[progress]` attribute)
before `progress` can make headway on `f`. Working bottom-up through the dependency
graph is essential.

## NEVER assume extraction is complete

Aeneas cannot extract all Rust patterns. Always check `extraction_notes.md` for known
exclusions and verify that the target function actually appears in `Funs.lean` before
attempting to write a specification. Functions behind `#[cfg(not(verify))]` will be
silently absent.

## NEVER run `lake build` without resource limits

Full project compilation is computationally expensive (30+ minutes). Always use
`nice -n 19 lake build` to avoid monopolizing system resources. For iterative
development, build individual files when possible.

</anti_patterns>

<summary>
The Aeneas pipeline produces a structured Lean 4 project from Rust source code.
Types.lean and Funs.lean are auto-generated and must never be edited. Human verification
work lives in Specs/ (theorems) and Defs/ (mathematical definitions). Functions.json
provides the metadata index for tracking progress and analyzing dependencies.
Understanding Aeneas limitations and working bottom-up through the dependency graph
are prerequisites for productive verification work.
</summary>
