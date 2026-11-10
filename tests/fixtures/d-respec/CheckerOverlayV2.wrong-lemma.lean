import M1demo.M1demo
import Specs.CheckerOverlayV1
open Aeneas Aeneas.Std Result

namespace m1demo.overlay.v2

-- Deliberately failing first attempt at node 20's target: the commutativity lemma does not exist.
theorem root_sum_eq_sum (p : m1demo.Pair) : m1demo.root_sum p = p.a + p.b := by
  simp [m1demo.helper_add_comm]

end m1demo.overlay.v2
