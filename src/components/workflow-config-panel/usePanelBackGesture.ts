import { useEffect, useRef } from "react";

/**
 * The system back gesture unwinding the config panel's drill levels (README
 * §12: "The system back gesture and the back row do the same thing").
 *
 * At and below 768px a drill level fills the screen, so it reads as a place the
 * reader navigated to — and a back gesture that jumped straight off the page
 * from three levels down would be a trap. The levels are still panel state
 * rather than routes, so nothing goes in the URL: the panel pushes one entry
 * per level at the SAME href and answers the pop with exactly one step back.
 *
 * The panel owns only the entries it pushed. Once they are spent, a gesture is
 * the app's again and leaves the page, which is what a reader at the root of
 * the panel means by "back".
 */

export interface PanelBackGestureOptions {
  /** Off above the breakpoint, where the drill is a rail, not the screen. */
  readonly enabled: boolean;
  /** Levels below the root; 0 is the root screen. */
  readonly depth: number;
  /** Step back exactly one level — the back row's own act. */
  readonly onBack: () => void;
}

export function usePanelBackGesture({
  enabled,
  depth,
  onBack,
}: PanelBackGestureOptions): void {
  /** Entries this panel pushed and has not yet given back. */
  const owned = useRef(0);
  /**
   * Traversals the panel started itself, whose pops are not gestures. One per
   * `go()` call, not per entry skipped: `go(-2)` is a single traversal and
   * fires a single `popstate`, so counting entries would leave a pop owed
   * forever and the next real gesture would pay it off.
   */
  const selfTraversals = useRef(0);

  useEffect(() => {
    const onPopState = () => {
      if (selfTraversals.current > 0) {
        selfTraversals.current -= 1;
        return;
      }
      if (owned.current === 0) return;
      owned.current -= 1;
      onBack();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [onBack]);

  useEffect(() => {
    const target = enabled ? depth : 0;
    if (target > owned.current) {
      for (let level = owned.current; level < target; level += 1) {
        window.history.pushState(
          { ccConfigPanelDepth: level + 1 },
          "",
          window.location.href,
        );
      }
      owned.current = target;
      return;
    }
    if (target < owned.current) {
      // The back row (or a scope switch) already left these levels, so the
      // entries standing for them go too — otherwise the next gesture would be
      // a press that does nothing.
      const spent = owned.current - target;
      owned.current = target;
      selfTraversals.current += 1;
      window.history.go(-spent);
    }
  }, [depth, enabled]);
}
