import M1demo.M1demo
open Aeneas Aeneas.Std Result

namespace m1demo.spec

/-- Semantic model of `m1demo.double`. -/
def doubleNat (n : Nat) : Nat := n + n

/-- Precondition of `double_spec`: the doubled value fits in a `u32`. -/
def DoubleFits (x : U32) : Prop := doubleNat x.val ≤ U32.max

/-- Proof-only helper: used by the proof of `double_spec`, not by its statement. -/
theorem doubleNat_eq (n : Nat) : doubleNat n = n + n := rfl

theorem double_spec (x : U32) (h : DoubleFits x) :
    m1demo.double x ⦃ y => y.val = doubleNat x.val ⦄ := by
  rw [DoubleFits, doubleNat_eq] at h
  unfold m1demo.double
  step
  rw [doubleNat_eq]
  assumption

end m1demo.spec
