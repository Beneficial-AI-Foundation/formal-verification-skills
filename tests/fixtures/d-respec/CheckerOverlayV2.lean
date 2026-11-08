import M1demo.M1demo
import Specs.CheckerOverlayV1
open Aeneas Aeneas.Std Result

namespace m1demo.overlay.v2

/-- Revised contract for `root_sum` (node 20): it computes the revised helper specification. -/
theorem root_sum_eq_spec (p : m1demo.Pair) : m1demo.root_sum p = m1demo.overlay.v1.helperSpec p :=
  m1demo.overlay.v1.helper_eq_spec p

end m1demo.overlay.v2
