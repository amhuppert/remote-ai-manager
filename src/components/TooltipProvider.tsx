"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

interface TooltipState {
  text: string;
  x: number;
  y: number;
  visible: boolean;
}

/**
 * Global tooltip provider that renders tooltips via portal.
 *
 * Listens for mouseenter/mouseleave on any element with a `data-tooltip`
 * attribute and renders a single positioned tooltip at `document.body` level,
 * ensuring it always renders above all other UI (topbar, modals, etc.)
 * regardless of the trigger element's stacking context.
 */
export default function TooltipProvider(): React.JSX.Element | null {
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

    function handleMouseLeave(e: Event) {
      const target = (e.target as Element).closest?.("[data-tooltip]");
      if (!target || target !== currentTargetRef.current) return;

      hideTimeoutRef.current = setTimeout(() => {
        setTooltip((prev) => ({ ...prev, visible: false }));
        currentTargetRef.current = null;
      }, 50);
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

  if (typeof window === "undefined") return null;

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
