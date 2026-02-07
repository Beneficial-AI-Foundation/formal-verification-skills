<purpose>
Orchestrate natural-language explanation generation for a Rust function or module.

Takes a target function or module, analyzes both the Rust source and Lean extraction,
and produces a detailed natural-language stub file explaining what the code does, its
preconditions, postconditions, bounds reasoning, and mathematical meaning.

Stubs serve as the bridge between Rust understanding and Lean verification -- they
capture the human reasoning that informs spec writing.

Output: stubs/{module_path}/{function_name}.md
</purpose>

<process>

<step name="resolve_target">
Accept function or module name from user and resolve to source files.

**Input:** Function name (Rust or Lean), or module path.

Search for the target:
1. In CODEMAP.md if available (fastest lookup)
2. In Funs.lean (search for `def {target}`)
3. In Rust source (search for `fn {target}`)

**Resolve:**
- Rust source file path and line range
- Corresponding Lean function name in Funs.lean
- Module context (which Rust file/module contains this function)
- Output stub path: `stubs/{module_path}/{function_name}.md`

**If not found:**
```
Function "{target}" not found.

Did you mean one of these?
[fuzzy matches]

Or run /fvs:map-code to build the function index.
```

Wait for user clarification.
</step>

<step name="analyze_module">
Dispatch **fvs-explainer** agent to read the Rust module containing the target.

Agent inputs:
- Full Rust source file (not just the function -- the entire module)
- Module path in the crate hierarchy

Expected outputs:
- **Module purpose**: What this module provides to the crate
- **Data flow**: Where inputs come from, where outputs go
- **Placement**: Leaf module vs orchestrator, position in call hierarchy
- **Key types**: Structs/enums defined or used heavily in this module
- **Conventions**: Any naming patterns, implicit invariants, or domain-specific
  idioms used across the module

This step provides context that a function-only analysis would miss. Understanding
the module helps identify implicit preconditions that callers maintain but never
state explicitly.

Reference: @fv-skills/references/aeneas-patterns.md (project structure, type mapping)
</step>

<step name="analyze_function">
Same **fvs-explainer** agent continues with deep function analysis.

Agent inputs:
- Rust function source (with full surrounding context from step 2)
- Lean translation from Funs.lean
- Type definitions from Types.lean (for parameter/return types)

Expected outputs:
- **Algorithm description**: Step-by-step explanation of what the code does
- **Preconditions**: What must be true of inputs (bounds, invariants, validity)
- **Postconditions**: What is guaranteed about outputs (bounds, mathematical properties)
- **Bounds reasoning**: Worst-case arithmetic for each operation, overflow/underflow analysis
- **Mathematical meaning**: Bridge between implementation and mathematical object
- **Dependencies**: Which other functions this calls and what it expects from them

The Rust source is the primary source of truth. The Lean extraction is secondary --
use it to confirm type mappings and identify how Aeneas translated specific patterns.

Reference: @fv-skills/references/lean-spec-conventions.md (postcondition patterns, bound analysis)
</step>

<step name="generate_stub">
Agent writes stub file using the stub.md template.

Template: @fv-skills/templates/stub.md

**Output path:** `stubs/{module_path}/{function_name}.md`

```bash
mkdir -p stubs/{module_path}
```

The stub must include all required sections:
- Module Context (from step 2)
- Function header (signature, Lean extraction name, source location)
- What It Does (algorithmic description)
- Preconditions (with both informal and formal versions)
- Postconditions (structural and semantic)
- Bounds Reasoning (worst-case arithmetic walkthrough)
- Mathematical Meaning (interpretation functions, core theorem in English)

Write the stub file.
</step>

<step name="validate_stub">
Check that the stub file has all required sections.

**Checklist:**
- [ ] File exists at expected path
- [ ] Module Context section present with purpose, data flow, placement
- [ ] What It Does section describes the algorithm, not just the purpose
- [ ] Preconditions section maps to Lean hypothesis patterns
- [ ] Postconditions section has both structural and semantic properties
- [ ] Bounds Reasoning section walks through worst-case arithmetic
- [ ] Mathematical Meaning section bridges code to math

**Report result:**
```
FVS >> STUB GENERATED

Function: {function_name}
Module:   {rust_module_path}
Stub:     stubs/{module_path}/{function_name}.md
Sections: [OK] all required sections present

---

Next: /fvs:lean-specify {function_name} to generate the Lean spec
```
</step>

</process>

<success_criteria>
- Target resolved to Rust source and Lean extraction
- Module-level context captured (not just function-level)
- Algorithm described step-by-step with bounds reasoning
- Preconditions and postconditions stated in both natural language and formal notation
- Stub file written with all required sections from stub.md template
- Clear next step offered to user
</success_criteria>
