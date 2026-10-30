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

/-- theorem whose statement reaches structures only through projections. -/
theorem wrap_x (w : Wrap) : w.pt.x = w.pt.x := rfl

/-- theorem over a structure holding an Aeneas scalar. -/
theorem meter_v (m : Meter) : m.v = m.v := rfl

end m1demo.kinds
