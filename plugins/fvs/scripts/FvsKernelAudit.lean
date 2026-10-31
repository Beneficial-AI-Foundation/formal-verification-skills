import Lean
import Lean.Replay

/- The controller runs this helper independently. Project modules are read as
   data, never imported into the checking environment. No accepted receipt is
   issued here. Deterministic replay patterns adapted from AutoFV (MIT):
   Copyright (c) 2025 curve25519-dalek-verify contributors.

   Permission is hereby granted, free of charge, to any person obtaining a copy
   of this software and associated documentation files (the "Software"), to deal
   in the Software without restriction, including without limitation the rights
   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   copies of the Software, and to permit persons to whom the Software is
   furnished to do so, subject to the following conditions:

   The above copyright notice and this permission notice shall be included in
   all copies or substantial portions of the Software.

   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
   THE SOFTWARE. -/
open Lean
set_option maxRecDepth 10000

abbrev Constants := Std.HashMap Name ConstantInfo
abbrev Families := Std.HashMap Name (List Name)

def requireJson (value : Except String α) : IO α :=
  match value with
  | .ok a => pure a
  | .error e => throw <| IO.userError e

def field (j : Json) (key : String) : IO Json := requireJson (j.getObjVal? key)
def string (j : Json) : IO String := requireJson j.getStr?
def array (j : Json) : IO (Array Json) := requireJson j.getArr?
def strings (j : Json) : IO (Array String) := do (← array j).mapM string

def loadConstants (modules : Array Json) : IO (Constants × Array CompactedRegion) := do
  let mut constants : Constants := {}
  let mut regions := #[]
  for module in modules do
    let parts ← strings (← field module "parts")
    unless parts.size == 1 || (parts.size == 3 && parts[1]! == parts[0]! ++ ".server" && parts[2]! == parts[0]! ++ ".private") do
      throw <| IO.userError "unsupported module-data layout"
    -- Parts share compacted objects with earlier parts: read one ordered prefix
    -- and use its complete private kernel inventory, never concatenate them.
    let loaded ← readModuleDataParts (parts.map System.FilePath.mk)
    let some lastPart := loaded.back? | throw <| IO.userError "empty module-data prefix"
    let data := lastPart.1
    unless data.isModule == (parts.size == 3) do
      throw <| IO.userError "unsupported module-data layout or missing private body part"
    regions := regions ++ loaded.map (·.2)
    for (partData, _) in loaded do
      unless partData.constNames.all (fun n => data.constNames.contains n) do
        throw <| IO.userError "private module inventory omits an exported declaration"
    unless data.constNames.size == data.constants.size do
      throw <| IO.userError "incomplete module constant inventory"
    for name in data.constNames, info in data.constants do
      unless name == info.name && !constants.contains name do
        throw <| IO.userError "duplicate or inconsistent project declaration"
      constants := constants.insert name info
  return (constants, regions)

def named (source : Constants) (spelling : String) : IO Name := do
  let names := source.toList.filterMap fun (name, _) => if name.toString == spelling then some name else none
  match names with
  | [name] => pure name
  | _ => throw <| IO.userError s!"missing or ambiguous declaration {spelling}"

def infoFor (env : Environment) (source : Constants) (name : Name) : IO ConstantInfo :=
  match source[name]? <|> env.toKernelEnv.find? name with
  | some info => pure info
  | none => throw <| IO.userError s!"missing dependency {name}"

def needsBody : ConstantInfo → Bool
  | .defnInfo _ | .thmInfo _ | .opaqueInfo _ => true
  | _ => false

def kindOf : ConstantInfo → String
  | .defnInfo _ => "def"
  | .thmInfo _ => "theorem"
  | .opaqueInfo _ => "opaque"
  | .axiomInfo _ => "axiom"
  | .inductInfo _ => "inductive"
  | .ctorInfo _ => "ctor"
  | .recInfo _ => "recursor"
  | .quotInfo _ => "quot"

partial def closure (env : Environment) (source : Constants) (pending : List Name)
    (semantic : Bool) (families : Families) (seen : NameSet := {}) : IO NameSet := do
  match pending with
  | [] => pure seen
  | name :: rest =>
    if seen.contains name then closure env source rest semantic families seen
    else do
      let info ← infoFor env source name
      let mut uses := info.type.getUsedConstantsAsSet
      let proofOnly := semantic && info matches .thmInfo _
      if needsBody info && !proofOnly then
        let some value := info.value? (allowOpaque := true)
          | throw <| IO.userError s!"missing required body {name}"
        uses := uses ++ value.getUsedConstantsAsSet
      match info with
      | .inductInfo v =>
        uses := uses ++ NameSet.ofList (v.ctors ++ (families[name]?.getD []))
        for (n, ci) in source.toList do
          if let .recInfo r := ci then
            if r.all.contains name then uses := uses.insert n
      | .ctorInfo v => uses := uses.insert v.induct
      | .recInfo v => uses := uses ++ NameSet.ofList v.all
      | _ => pure ()
      closure env source (uses.toList ++ rest) semantic families (seen.insert name)

def sameInductive (a b : InductiveVal) : Bool :=
  a.name == b.name && a.levelParams == b.levelParams && Expr.equal a.type b.type &&
  a.numParams == b.numParams && a.numIndices == b.numIndices && a.all == b.all &&
  a.ctors == b.ctors && a.numNested == b.numNested && a.isRec == b.isRec &&
  a.isUnsafe == b.isUnsafe && a.isReflexive == b.isReflexive

def sameInfo (a b : ConstantInfo) (proofs : Bool) : Bool :=
  a.name == b.name && a.levelParams == b.levelParams && Expr.equal a.type b.type &&
  match a, b with
  | .defnInfo x, .defnInfo y => x == y && Expr.equal x.value y.value
  | .thmInfo x, .thmInfo y => x.all == y.all && (!proofs || Expr.equal x.value y.value)
  | .opaqueInfo x, .opaqueInfo y => x == y && Expr.equal x.value y.value
  | .axiomInfo x, .axiomInfo y => x == y
  | .inductInfo x, .inductInfo y => sameInductive x y
  | .ctorInfo x, .ctorInfo y => x == y
  | .recInfo x, .recInfo y => x == y && (x.rules.zip y.rules).all (fun (r, s) => Expr.equal r.rhs s.rhs)
  | .quotInfo _, .quotInfo _ => false
  | _, _ => false

def nameStrings (names : NameSet) : Array String :=
  (names.toList.map Name.toString).mergeSort (· ≤ ·) |>.toArray

def importInventory (env : Environment) (project : Array Name) : IO Json := do
  let mut rows := #[]
  for name in env.header.moduleNames do
    let file ← findOLean name
    let mut parts := #[file.toString]
    for extra in #[System.FilePath.mk (file.toString ++ ".server"), System.FilePath.mk (file.toString ++ ".private"), file.withExtension "ir"] do
      if ← extra.pathExists then parts := parts.push extra.toString
    rows := rows.push <| Json.mkObj [("name", toJson name), ("project", toJson (project.contains name)), ("parts", toJson parts)]
  return Json.arr rows

unsafe def enableWitnessInitializersImpl : IO Unit := enableInitializersExecution
@[implemented_by enableWitnessInitializersImpl]
opaque enableWitnessInitializers : IO Unit

-- This runs in a separate process. Importing project metadata here supplies
-- type/context facts only; this environment never supplies checked proofs.
def witness (j : Json) : IO Json := do
  let moduleRows ← array (← field j "referenceModules")
  let (_, sourceRegions) ← loadConstants moduleRows
  let wanted ← moduleRows.mapM fun row => do pure (← string (← field row "name")).toName
  enableWitnessInitializers
  let imports := (#[`Lean, `Lean.Replay] ++ wanted).toList.eraseDups.toArray
  let env ← importModules (imports.map fun n => { module := n }) {} 0 (loadExts := true)
  let mut facts := #[]
  let mut declarations := #[]
  for (name, info) in env.constants.toList do
    let owned := (env.getModuleIdxFor? name).any fun idx => wanted.contains env.header.moduleNames[idx.toNat]!
    if owned then
      declarations := declarations.push <| Json.mkObj [("name", toJson name), ("kind", toJson (kindOf info)),
        ("levelParams", toJson info.levelParams), ("type", toJson (repr info.type).pretty)]
      if info matches .inductInfo _ then
        let isStruct := isStructure env name
        let fields := if isStruct then (getStructureFields env name).map (fun f =>
          Json.mkObj [("name", toJson f), ("projection", toJson (getProjFnForField? env name f))]) else #[]
        facts := facts.push <| Json.mkObj [("name", toJson name), ("structure", toJson isStruct), ("fields", Json.arr fields)]
  return Json.mkObj [("schema", toJson "fvs-type-witness/structures"), ("version", toJson (1 : Nat)),
    ("runId", ← field j "runId"), ("facts", Json.arr facts), ("declarations", Json.arr declarations),
    ("imports", ← importInventory env wanted), ("regions", toJson sourceRegions.size)]

def familyFacts (j : Json) (reference : Constants) : IO Families := do
  let rows ← array (← field j "structureFacts")
  let mut families : Families := {}
  let mut seen : NameSet := {}
  for row in rows do
    let name ← named reference (← string (← field row "name"))
    unless (reference[name]! matches .inductInfo _) && !seen.contains name do
      throw <| IO.userError "inconsistent baseline family witness"
    seen := seen.insert name
    let mut projections : List Name := []
    for f in (← array (← field row "fields")) do
      let p ← field f "projection"
      if p != Json.null then projections := (← named reference (← string p)) :: projections
    families := families.insert name projections
  let expected := NameSet.ofList <| reference.toList.filterMap fun (n, i) =>
    if i matches .inductInfo _ then some n else none
  unless seen.toList.length == expected.toList.length && seen.toList.all expected.contains do
    throw <| IO.userError "incomplete baseline family witness"
  return families

-- Parse a whole term before the controller embeds it in an expectation module.
-- No candidate context is used, and tactic-valued propositions are unsupported.
partial def containsTactic (stx : Syntax) : Bool :=
  stx.getKind == ``Parser.Term.byTactic || stx.getArgs.any containsTactic

def validateTerms (j : Json) : IO Json := do
  let modules ← array (← field j "referenceModules")
  let wanted ← modules.mapM fun row => do pure (← string (← field row "name")).toName
  enableWitnessInitializers
  let env ← importModules ((#[`Lean] ++ wanted).map fun n => { module := n }) {} 0 (loadExts := true)
  for term in (← strings (← field j "terms")) do
    let stx ← requireJson <| Parser.runParserCategory env `term term
    if containsTactic stx then throw <| IO.userError "unsupported tactic-valued contract proposition"
  return Json.mkObj [("schema", toJson "fvs-checker/parsed-terms"), ("version", toJson (1 : Nat)), ("runId", ← field j "runId")]

def audit (j : Json) (baseline := false) : IO Json := do
  let runId ← string (← field j "runId")
  let (candidate, candidateRegions) ← loadConstants (← array (← field j "modules"))
  let (reference, referenceRegions) ← loadConstants (← array (← field j "referenceModules"))
  let families ← familyFacts j reference
  let imports ← (#["Lean", "Lean.Replay"] ++ (← strings (← field j "externalImports"))).toList.eraseDups.toArray.mapM fun s => do
    pure ({ module := s.toName } : Import)
  let env ← importModules imports {} 0 (loadExts := false)
  for (name, _) in candidate.toList do
    if (env.toKernelEnv.find? name).isSome then
      throw <| IO.userError s!"project shadows trusted declaration {name}"
  let mut actualRoots : List Name := []
  let mut meaningSeeds : List Name := []
  for target in (← array (← field j "targets")) do
    let actual ← named candidate (← string (← field target "name"))
    let expected ← named reference (← string (← field target "expectedName"))
    let a := candidate[actual]!
    let e := reference[expected]!
    unless a matches .thmInfo _ do throw <| IO.userError s!"target is not a theorem {actual}"
    unless e.levelParams == a.levelParams && Expr.equal e.type a.type do
      throw <| IO.userError s!"statement identity mismatch {actual}"
    actualRoots := actual :: actualRoots
    meaningSeeds := e.type.getUsedConstantsAsSet.toList ++ meaningSeeds
  unless !actualRoots.isEmpty do throw <| IO.userError "missing selected targets"
  for root in (← strings (← field j "meaningRoots")) do
    meaningSeeds := (← named reference root) :: meaningSeeds
  let semantic ← closure env reference meaningSeeds true families
  let mut projectMeaning : NameSet := {}
  for name in semantic.toList do
    if let some expected := reference[name]? then
      let some actual := candidate[name]?
        | throw <| IO.userError s!"missing semantic definition {name}"
      unless sameInfo expected actual false do
        throw <| IO.userError s!"semantic definition identity mismatch {name}"
      projectMeaning := projectMeaning.insert name
  let mut auxiliaryRoots : List Name := []
  if let .ok rows := j.getObjVal? "auxiliaryRoots" then
    for spelling in (← strings rows) do
      let name ← named candidate spelling
      unless !reference.contains name && (candidate[name]! matches .thmInfo _) do
        throw <| IO.userError s!"invalid new proof auxiliary {name}"
      auxiliaryRoots := name :: auxiliaryRoots
  let required ← closure env candidate ((if baseline then [] else actualRoots ++ auxiliaryRoots) ++ semantic.toList) false families
  if let .ok rows := j.getObjVal? "proofIdentityRoots" then
    let roots ← (← strings rows).toList.mapM (named candidate)
    let proofClosure ← closure env candidate roots false families
    for name in proofClosure.toList do
      if let some actual := candidate[name]? then
        let some expected := reference[name]? | throw <| IO.userError s!"changed accepted helper proof closure {name}"
        unless sameInfo expected actual true do
          throw <| IO.userError s!"changed accepted helper proof identity {name}"
  let mut project : Constants := {}
  let mut axioms : NameSet := {}
  for name in required.toList do
    let info ← infoFor env candidate name
    if info matches .axiomInfo _ then
      unless [``propext, ``Classical.choice, ``Quot.sound].contains name do
        throw <| IO.userError s!"forbidden axiom {name}"
      axioms := axioms.insert name
    if candidate.contains name then
      if info.isUnsafe || info.isPartial then
        throw <| IO.userError s!"unsupported unsafe/partial project declaration {name}"
      if let .inductInfo i := info then
        unless i.all.length == 1 do throw <| IO.userError "unsupported mutual inductive group"
      project := project.insert name info
  -- Every required project declaration is absent from env and must be checked;
  -- equality to a reference artifact never exempts a project proof.
  let checked ← env.replay project
  for (name, expected) in project.toList do
    let some actual := checked.toKernelEnv.find? name
      | throw <| IO.userError s!"kernel replay omitted {name}"
    unless sameInfo expected actual true do
      throw <| IO.userError s!"kernel replay identity mismatch {name}"
  if baseline then
    let mut kernel := checked.toKernelEnv
    for (target, index) in (← array (← field j "targets")).toList.zipIdx do
      let expected ← named reference (← string (← field target "expectedName"))
      let info := reference[expected]!
      let anchor := Name.str `FvsCheckerInternal s!"type_{index}"
      let decl := Declaration.defnDecl {
        name := anchor
        levelParams := info.levelParams
        type := mkSort .zero
        value := info.type
        hints := .abbrev
        safety := .safe }
      kernel ← match kernel.addDeclCore 0 decl none with
        | .ok result => pure result
        | .error e => throw <| IO.userError s!"invalid baseline expected type {expected}: {← e.toMessageData {} |>.toString}"
  let replayed := NameSet.ofList (project.toList.map (·.1))
  -- Keep module regions live until all expressions and kernel checks are done.
  let regionCount := candidateRegions.size + referenceRegions.size
  return Json.mkObj [
    ("schema", toJson (if baseline then "fvs-kernel-baseline/result" else "fvs-kernel-audit/result")), ("version", toJson (1 : Nat)),
    ("runId", toJson runId), ("status", toJson (if baseline then "meaning-checked" else "kernel-checked")),
    ("targetProofsChecked", toJson (!baseline)),
    ("targets", toJson (actualRoots.map Name.toString)),
    ("auxiliaryRoots", toJson (auxiliaryRoots.map Name.toString)),
    ("replayed", toJson (nameStrings replayed)),
    ("meaning", toJson (nameStrings projectMeaning)),
    ("imports", ← importInventory env #[]),
    ("axioms", toJson (nameStrings axioms)), ("regions", toJson regionCount)]

def main (args : List String) : IO UInt32 := do
  try
    let [mode, file] := args | throw <| IO.userError "expected mode and request file"
    let j ← requireJson <| Json.parse (← IO.FS.readFile file)
    let result ← match mode with
      | "audit" => audit j
      | "baseline" => audit j true
      | "witness" => witness j
      | "validate-terms" => validateTerms j
      | _ => throw <| IO.userError "unsupported helper mode"
    IO.println result.compress
    return (0 : UInt32)
  catch e =>
    let message := e.toString
    let code := if message.startsWith "unsupported" then "unsupported" else "audit-failed"
    IO.println <| (Json.mkObj [("schema", toJson "fvs-checker/helper-error"),
      ("status", toJson "unverified"), ("code", toJson code), ("error", toJson message)]).compress
    return (1 : UInt32)
