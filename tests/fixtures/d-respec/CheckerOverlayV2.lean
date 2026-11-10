import M1demo.M1demo
import Specs.CheckerOverlayV1
open Aeneas Aeneas.Std Result

namespace m1demo.overlay.v2

/-- Revised contract for `root_sum` (node 20): it is the checked `u32` sum, through the protected node-19 proof. -/
theorem root_sum_eq_sum (p : m1demo.Pair) : m1demo.root_sum p = p.a + p.b :=
  m1demo.overlay.v1.helper_eq_sum p

end m1demo.overlay.v2
