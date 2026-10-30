import M1demo.M1demo
open Aeneas Aeneas.Std Result

/-! Qualification fixture: each declaration kind with and without external
dependencies in its type and value. -/

namespace m1demo.kinds

/-- def, no external constant in type or value. -/
def idT (α : Type) (a : α) : α := a

/-- def, external constants in type and value. -/
def twice (n : Nat) : Nat := n + n

/-- def using only a local definition. -/
def twiceTwice (n : Nat) : Nat := twice (twice n)

/-- theorem, no external constant in statement or proof. -/
theorem selfImp (p : Prop) (h : p) : p := h

/-- theorem with external constants. -/
theorem twice_eq (n : Nat) : twice n = n + n := rfl

/-- structure with external field types. -/
structure Pt where
  x : Nat
  y : Nat

/-- structure whose only field type is local. -/
structure Wrap where
  pt : Pt

/-- structure over an Aeneas scalar, as generated code has. -/
structure Meter where
  v : U32

/-- class and instances. -/
class Shift (α : Type) where
  shift : α → α

instance shiftPt : Shift Pt := ⟨fun p => p⟩

instance shiftNat : Shift Nat := ⟨fun n => n + 1⟩

/-- inductive with no external constant, and a def that matches on it. -/
inductive Color where
  | red
  | green

def pick (c : Color) : Pt :=
  match c with
  | .red => ⟨0, 0⟩
  | .green => ⟨1, 1⟩

end m1demo.kinds
