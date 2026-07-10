"use client";

import {
  useEffect,
  useState,
  useRef,
  useCallback,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

interface TooltipState {
  text: string;
  x: number;
  y: number;
  visible: boolean;
}

const subscribeToMount = () => () => undefined;
const getMountedSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * Global tooltip provider that renders tooltips via portal.
 *
 * Listens for mouseenter/mouseleave on any element with a `data-tooltip`
 * attribute and renders a single positioned tooltip at `document.body` level,
 * ensuring it always renders above all other UI (topbar, modals, etc.)
 * regardless of the trigger element's stacking context.
 */
export default function TooltipProvider(): React.JSX.Element | null {
  const mounted = useSyncExternalStore(
    subscribeToMount,
    getMountedSnapshot,
    getServerSnapshot,
  );
  const [tooltip, setTooltip] = useState<TooltipState>({
    text: "",
    x: 0,
    y: 0,
    visible: false,
  });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const currentTargetRef = useRef<Element | null>(null);
  const longPressTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  const positionTooltip = useCallback((target: Element, text: string) => {
    const rect = target.getBoundingClientRect();
    const GAP = 6;

    // Start with position below the element, centered
    let x = rect.left + rect.width / 2;
    let y = rect.bottom + GAP;

    // We need to set state first to render the tooltip, then adjust if needed
    setTooltip({ text, x, y, visible: true });

    // After render, check if tooltip overflows viewport and adjust
    requestAnimationFrame(() => {
      const el = tooltipRef.current;
      if (!el) return;

      const tooltipRect = el.getBoundingClientRect();

      // Flip to above if not enough space below
      if (tooltipRect.bottom > window.innerHeight) {
        y = rect.top - GAP - tooltipRect.height;
      }

      // Keep within horizontal bounds
      const halfWidth = tooltipRect.width / 2;
      if (x - halfWidth < 4) {
        x = halfWidth + 4;
      } else if (x + halfWidth > window.innerWidth - 4) {
        x = window.innerWidth - halfWidth - 4;
      }

      setTooltip({ text, x, y, visible: true });
    });
  }, []);

  useEffect(() => {
    function handleMouseEnter(e: Event) {
      const target = (e.target as Element).closest?.("[data-tooltip]");
      if (!target) return;

      const text = target.getAttribute("data-tooltip");
      if (!text) return;

      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }

      currentTargetRef.current = target;
      positionTooltip(target, text);
    }

    function hideNow() {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      currentTargetRef.current = null;
      setTooltip((prev) => (prev.visible ? { ...prev, visible: false } : prev));
    }

    function handleMouseLeave(e: Event) {
      const target = (e.target as Element).closest?.("[data-tooltip]");
      if (!target || target !== currentTargetRef.current) return;

      hideTimeoutRef.current = setTimeout(() => {
        setTooltip((prev) => ({ ...prev, visible: false }));
        currentTargetRef.current = null;
      }, 50);
    }

    // A press anywhere dismisses the tooltip — the trigger itself or elsewhere
    // on the page. Essential for triggers that flip to `disabled` on click
    // (e.g. a mutation going pending): a disabled element never fires
    // mouseleave, so the hover-hide path above can never run for it.
    function handlePointerDown() {
      if (currentTargetRef.current) hideNow();
    }

    // Self-heal when a mouseleave was never delivered — the trigger was
    // disabled or unmounted while hovered. As soon as the pointer is over
    // anything outside the tracked trigger (or the trigger has detached), drop
    // the tooltip. Cheap: no-ops entirely unless a tooltip is currently shown.
    function handlePointerMove(e: Event) {
      const active = currentTargetRef.current;
      if (!active) return;
      const node = e.target;
      const stillInside =
        node instanceof Node && active.isConnected && active.contains(node);
      if (!stillInside) hideNow();
    }

    function clearLongPress() {
      if (longPressTimeoutRef.current) {
        clearTimeout(longPressTimeoutRef.current);
        longPressTimeoutRef.current = null;
      }
    }

    function handleTouchStart(e: Event) {
      const target = (e.target as Element).closest?.("[data-tooltip]");
      if (!target) return;

      const text = target.getAttribute("data-tooltip");
      if (!text) return;

      clearLongPress();
      longPressTimeoutRef.current = setTimeout(() => {
        if (hideTimeoutRef.current) {
          clearTimeout(hideTimeoutRef.current);
          hideTimeoutRef.current = null;
        }
        currentTargetRef.current = target;
        positionTooltip(target, text);
      }, 500);
    }

    function handleTouchEnd() {
      clearLongPress();
      if (!currentTargetRef.current) return;
      hideTimeoutRef.current = setTimeout(() => {
        setTooltip((prev) => ({ ...prev, visible: false }));
        currentTargetRef.current = null;
      }, 1500);
    }

    document.addEventListener("mouseenter", handleMouseEnter, true);
    document.addEventListener("mouseleave", handleMouseLeave, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointermove", handlePointerMove, {
      capture: true,
      passive: true,
    });
    document.addEventListener("touchstart", handleTouchStart, {
      capture: true,
      passive: true,
    });
    document.addEventListener("touchend", handleTouchEnd, true);
    document.addEventListener("touchcancel", handleTouchEnd, true);
    document.addEventListener("touchmove", clearLongPress, {
      capture: true,
      passive: true,
    });

    return () => {
      document.removeEventListener("mouseenter", handleMouseEnter, true);
      document.removeEventListener("mouseleave", handleMouseLeave, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("touchstart", handleTouchStart, true);
      document.removeEventListener("touchend", handleTouchEnd, true);
      document.removeEventListener("touchcancel", handleTouchEnd, true);
      document.removeEventListener("touchmove", clearLongPress, true);
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
      clearLongPress();
    };
  }, [positionTooltip]);

  // Watch for attribute changes on the current target (e.g. "Copied!" state)
  useEffect(() => {
    const target = currentTargetRef.current;
    if (!target || !tooltip.visible) return;

    const observer = new MutationObserver(() => {
      const newText = target.getAttribute("data-tooltip");
      if (newText && newText !== tooltip.text) {
        positionTooltip(target, newText);
      }
    });

    observer.observe(target, {
      attributes: true,
      attributeFilter: ["data-tooltip"],
    });

    return () => observer.disconnect();
  }, [tooltip.visible, tooltip.text, positionTooltip]);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={tooltipRef}
      className="tooltip-portal"
      style={{
        position: "fixed",
        left: tooltip.x,
        top: tooltip.y,
        transform: "translateX(-50%)",
        opacity: tooltip.visible ? 1 : 0,
        pointerEvents: "none",
        zIndex: 99999,
        transition: "opacity 0.12s ease",
      }}
      role="tooltip"
    >
      {tooltip.text}
    </div>,
    document.body,
  );
}
