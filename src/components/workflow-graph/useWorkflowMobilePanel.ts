import { useState, useEffect, useCallback, useRef } from "react";

const MOBILE_QUERY = "(max-width: 768px)";

export function useWorkflowMobilePanel<TPanel extends string>(
  defaultPanel: TPanel,
) {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  });
  const [mobilePanel, setMobilePanel] = useState<TPanel>(defaultPanel);
  const isMobileRef = useRef(isMobile);

  useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const autoSwitchPanel = useCallback((panel: TPanel) => {
    if (isMobileRef.current) {
      setMobilePanel(panel);
    }
  }, []);

  return { isMobile, mobilePanel, setMobilePanel, autoSwitchPanel };
}
