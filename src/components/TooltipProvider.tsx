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

interface DescribedTarget {
  target: Element;
  previousAriaDescribedBy: string | null;
}

const TOOLTIP_ID = "cc-global-tooltip";

const subscribeToMount = () => () => undefined;
const getMountedSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * Global tooltip provider for legacy `data-tooltip` triggers (WAI-ARIA APG
 * Tooltip pattern: https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/).
 *
 * Mouse, keyboard focus, and long press reveal one portalled tooltip above all
 * stacking contexts. The active trigger is associated through
 * `aria-describedby`; blur, pointer leave, touch timeout, and Escape dismiss it.
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
  const describedTargetRef = useRef<DescribedTarget | null>(null);
  const longPressTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null);
  const animationFrameRef = useRef<number | null>(null);

  const unlinkCurrentTarget = useCallback(() => {
    const described = describedTargetRef.current;
    if (described === null) return;
    if (described.previousAriaDescribedBy === null) {
      described.target.removeAttribute("aria-describedby");
    } else {
      described.target.setAttribute(
        "aria-describedby",
        described.previousAriaDescribedBy,
      );
    }
    describedTargetRef.current = null;
  }, []);

  const linkTarget = useCallback(
    (target: Element) => {
      if (describedTargetRef.current?.target === target) return;
      unlinkCurrentTarget();
      const previousAriaDescribedBy = target.getAttribute("aria-describedby");
      const descriptionIds = new Set(
        previousAriaDescribedBy?.split(/\s+/).filter(Boolean) ?? [],
      );
      descriptionIds.add(TOOLTIP_ID);
      target.setAttribute("aria-describedby", [...descriptionIds].join(" "));
      describedTargetRef.current = { target, previousAriaDescribedBy };
    },
    [unlinkCurrentTarget],
  );

  const hideTooltip = useCallback(() => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setTooltip((previous) => ({ ...previous, visible: false }));
    currentTargetRef.current = null;
    unlinkCurrentTarget();
  }, [unlinkCurrentTarget]);

  const positionTooltip = useCallback(
    (target: Element, text: string) => {
      const rect = target.getBoundingClientRect();
      const gap = 6;

      let x = rect.left + rect.width / 2;
      let y = rect.bottom + gap;

      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      currentTargetRef.current = target;
      linkTarget(target);
      setTooltip({ text, x, y, visible: true });

      animationFrameRef.current = requestAnimationFrame(() => {
        animationFrameRef.current = null;
        const el = tooltipRef.current;
        if (!el || currentTargetRef.current !== target) return;

        const tooltipRect = el.getBoundingClientRect();

        if (tooltipRect.bottom > window.innerHeight) {
          y = rect.top - gap - tooltipRect.height;
        }

        const halfWidth = tooltipRect.width / 2;
        if (x - halfWidth < 4) {
          x = halfWidth + 4;
        } else if (x + halfWidth > window.innerWidth - 4) {
          x = window.innerWidth - halfWidth - 4;
        }

        setTooltip({ text, x, y, visible: true });
      });
    },
    [linkTarget],
  );

  useEffect(() => {
    function handleMouseEnter(e: Event) {
      const target = (e.target as Element).closest?.("[data-tooltip]");
      if (!target) return;

      const text = target.getAttribute("data-tooltip");
      if (!text) return;

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
      if (target.contains(document.activeElement)) return;

      hideTimeoutRef.current = setTimeout(() => {
        hideTooltip();
      }, 50);
    }

    function handleFocusIn(e: FocusEvent) {
      const target = (e.target as Element).closest?.("[data-tooltip]");
      if (!target) return;
      const text = target.getAttribute("data-tooltip");
      if (!text) return;
      positionTooltip(target, text);
    }

    function handleFocusOut(e: FocusEvent) {
      const target = (e.target as Element).closest?.("[data-tooltip]");
      if (!target || target !== currentTargetRef.current) return;
      if (e.relatedTarget instanceof Node && target.contains(e.relatedTarget)) {
        return;
      }
      hideTooltip();
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && currentTargetRef.current !== null) {
        hideTooltip();
      }
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
        positionTooltip(target, text);
      }, 500);
    }

    function handleTouchEnd() {
      clearLongPress();
      if (!currentTargetRef.current) return;
      hideTimeoutRef.current = setTimeout(() => {
        hideTooltip();
      }, 1500);
    }

    document.addEventListener("mouseenter", handleMouseEnter, true);
    document.addEventListener("mouseleave", handleMouseLeave, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    document.addEventListener("keydown", handleKeyDown, true);
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
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointermove", handlePointerMove, true);
      document.removeEventListener("touchstart", handleTouchStart, true);
      document.removeEventListener("touchend", handleTouchEnd, true);
      document.removeEventListener("touchcancel", handleTouchEnd, true);
      document.removeEventListener("touchmove", clearLongPress, true);
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      clearLongPress();
      currentTargetRef.current = null;
      unlinkCurrentTarget();
    };
  }, [hideTooltip, positionTooltip, unlinkCurrentTarget]);

  // Watch for attribute changes on the current target (e.g. "Copied!" state)
  useEffect(() => {
    const target = currentTargetRef.current;
    if (!target || !tooltip.visible) return;

    const observer = new MutationObserver(() => {
      const newText = target.getAttribute("data-tooltip");
      if (newText && newText !== tooltip.text) {
        positionTooltip(target, newText);
      } else if (!newText) {
        hideTooltip();
      }
    });

    observer.observe(target, {
      attributes: true,
      attributeFilter: ["data-tooltip"],
    });

    return () => observer.disconnect();
  }, [hideTooltip, tooltip.visible, tooltip.text, positionTooltip]);

  if (!mounted || !tooltip.visible || tooltip.text.length === 0) return null;

  return createPortal(
    <div
      ref={tooltipRef}
      id={TOOLTIP_ID}
      className="tooltip-portal"
      style={{
        position: "fixed",
        left: tooltip.x,
        top: tooltip.y,
        transform: "translateX(-50%)",
        opacity: 1,
        pointerEvents: "none",
        zIndex: 99999,
        transition: "opacity 0.12s ease",
      }}
      role={tooltip.visible ? "tooltip" : undefined}
    >
      {tooltip.text}
    </div>,
    document.body,
  );
}
