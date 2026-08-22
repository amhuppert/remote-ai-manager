import { useCallback, useEffect, useRef, useState } from "react";
import { useMediaQueryMatch } from "@/hooks/use-media-query";

/** §12: at and below this width one primary panel is on screen at a time. */
const MOBILE_QUERY = "(max-width: 768px)";

export function useWorkflowMobilePanel<TPanel extends string>(
  defaultPanel: TPanel,
) {
  // The viewport is external state the server cannot snapshot, so it is read
  // through the shared subscriber rather than seeded into state at mount. Both
  // pages mount the bottom tab bar behind this flag, and a first client render
  // that disagreed with the server HTML would throw the hydrated tree away.
  const isMobile = useMediaQueryMatch(MOBILE_QUERY);
  const [mobilePanel, setMobilePanel] = useState<TPanel>(defaultPanel);
  // Read at call time, not closed over: an auto-switch is a reaction to
  // something the user did, and the callback is handed to children that would
  // otherwise re-create every dependent callback on each breakpoint crossing.
  const isMobileRef = useRef(isMobile);

  useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);

  const autoSwitchPanel = useCallback((panel: TPanel) => {
    if (isMobileRef.current) {
      setMobilePanel(panel);
    }
  }, []);

  return { isMobile, mobilePanel, setMobilePanel, autoSwitchPanel };
}
