"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CanvasZoomContext } from "../canvas/MachineCanvas";

interface SiblingInfo {
  name: string;
  href: string;
}

interface WorkflowCanvasShellProps {
  title: string;
  character: string;
  index: number;
  total: number;
  prev?: SiblingInfo;
  next?: SiblingInfo;
  onPrev?: () => void;
  onNext?: () => void;
  /** Resets internal pan/zoom whenever this value changes (e.g., on workflow switch). */
  resetKey?: string;
  children: ReactNode;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.15;
const DRAG_THRESHOLD_PX = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Compute max pan offset for current zoom + surface size. The inner canvas
 * auto-fits at zoom=1, so at zoom z the content is z× surface in each dim and
 * the visible-overflow per side is (z-1)/2 × surface. Clamping pan to that
 * range ensures the user can always reach every edge of the content but can
 * never push the diagram fully off-screen.
 */
function clampPan(
  pan: { x: number; y: number },
  zoom: number,
  surfaceWidth: number,
  surfaceHeight: number,
): { x: number; y: number } {
  if (zoom <= 1) return { x: 0, y: 0 };
  const maxX = ((zoom - 1) / 2) * surfaceWidth;
  const maxY = ((zoom - 1) / 2) * surfaceHeight;
  return {
    x: clamp(pan.x, -maxX, maxX),
    y: clamp(pan.y, -maxY, maxY),
  };
}

/**
 * Header + viewport + footer shell wrapping the workflow canvas. Owns the
 * pan/zoom state and the cross-workflow navigation chrome. The viewport itself
 * scales via CSS transform, so the inner MachineCanvas needs no changes — its
 * own auto-fit math runs against this shell's viewport size.
 *
 * Pan is enabled when zoom > 1 (or via middle-mouse). Wheel zooms only with
 * Ctrl/⌘ to avoid hijacking page-level scroll outside the canvas.
 */
export default function WorkflowCanvasShell({
  title,
  character,
  index,
  total,
  prev,
  next,
  onPrev,
  onNext,
  resetKey,
  children,
}: WorkflowCanvasShellProps): React.JSX.Element {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  // Refs mirror current pan/zoom/surface-size so the touch listener (bound once)
  // and other handlers can read fresh values without re-attaching on every change.
  const panRef = useRef(pan);
  const zoomRef = useRef(zoom);
  const surfaceSizeRef = useRef({ w: 0, h: 0 });
  useEffect(() => {
    panRef.current = pan;
  }, [pan]);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // Track the surface size so pan clamping uses real dimensions.
  useEffect(() => {
    const node = surfaceRef.current;
    if (!node) return;
    function update(): void {
      if (!node) return;
      surfaceSizeRef.current = { w: node.offsetWidth, h: node.offsetHeight };
    }
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  // Re-clamp pan whenever zoom shrinks so previously-valid pan offsets snap back
  // into the (now smaller) reachable range.
  useEffect(() => {
    setPan((p) =>
      clampPan(p, zoom, surfaceSizeRef.current.w, surfaceSizeRef.current.h),
    );
  }, [zoom]);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const zoomIn = useCallback(() => {
    setZoom((z) => clamp(z + ZOOM_STEP, MIN_ZOOM, MAX_ZOOM));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((z) => clamp(z - ZOOM_STEP, MIN_ZOOM, MAX_ZOOM));
  }, []);

  // Reset pan/zoom when workflow changes. Use the "adjust state on prop change"
  // pattern (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // instead of an effect to avoid cascading renders.
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  // Wheel-zoom handler. Use a non-passive native listener so preventDefault works.
  useEffect(() => {
    const node = surfaceRef.current;
    if (!node) return;
    function onWheelNative(e: WheelEvent): void {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const direction = e.deltaY < 0 ? 1 : -1;
      setZoom((z) =>
        clamp(z + direction * ZOOM_STEP * (z / 1.0), MIN_ZOOM, MAX_ZOOM),
      );
    }
    node.addEventListener("wheel", onWheelNative, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheelNative);
    };
  }, []);

  // Touch gestures: one finger = pan, two fingers = pinch-zoom.
  // Native non-passive listeners so we can preventDefault to suppress page scroll.
  // The single-finger gesture starts on every touch (including on nodes) so the
  // user can pan from anywhere; we only commit to a drag once movement crosses
  // DRAG_THRESHOLD_PX. Tap-without-drag falls through as a normal click; a real
  // drag is suppressed via a capture-phase click handler so node selection
  // doesn't fire when the user was actually panning.
  useEffect(() => {
    const node = surfaceRef.current;
    if (!node) return;

    type GestureState =
      | {
          mode: "pan";
          startX: number;
          startY: number;
          startPan: { x: number; y: number };
          moved: boolean;
        }
      | {
          mode: "pinch";
          startDistance: number;
          startZoom: number;
          startMidX: number;
          startMidY: number;
          startPan: { x: number; y: number };
        }
      | null;
    let gesture: GestureState = null;
    let suppressNextClick = false;

    function distance(t1: Touch, t2: Touch): number {
      return Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    }

    function midpoint(t1: Touch, t2: Touch): { x: number; y: number } {
      return {
        x: (t1.clientX + t2.clientX) / 2,
        y: (t1.clientY + t2.clientY) / 2,
      };
    }

    function onTouchStart(e: TouchEvent): void {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        if (!t) return;
        gesture = {
          mode: "pan",
          startX: t.clientX,
          startY: t.clientY,
          startPan: { ...panRef.current },
          moved: false,
        };
      } else if (e.touches.length === 2) {
        const [t1, t2] = [e.touches[0], e.touches[1]];
        if (!t1 || !t2) return;
        const mid = midpoint(t1, t2);
        gesture = {
          mode: "pinch",
          startDistance: distance(t1, t2),
          startZoom: zoomRef.current,
          startMidX: mid.x,
          startMidY: mid.y,
          startPan: { ...panRef.current },
        };
        e.preventDefault();
      }
    }

    function onTouchMove(e: TouchEvent): void {
      if (!gesture) return;
      const surface = surfaceSizeRef.current;
      if (gesture.mode === "pan" && e.touches.length === 1) {
        const t = e.touches[0];
        if (!t) return;
        const dx = t.clientX - gesture.startX;
        const dy = t.clientY - gesture.startY;
        if (!gesture.moved && Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) {
          // Below threshold — treat as potential tap. Don't start panning yet
          // and don't preventDefault so the click can fire normally on touchend.
          return;
        }
        gesture.moved = true;
        e.preventDefault();
        setPan(
          clampPan(
            { x: gesture.startPan.x + dx, y: gesture.startPan.y + dy },
            zoomRef.current,
            surface.w,
            surface.h,
          ),
        );
      } else if (gesture.mode === "pinch" && e.touches.length >= 2) {
        const [t1, t2] = [e.touches[0], e.touches[1]];
        if (!t1 || !t2) return;
        e.preventDefault();
        const newDistance = distance(t1, t2);
        const ratio = newDistance / gesture.startDistance;
        const newZoom = clamp(gesture.startZoom * ratio, MIN_ZOOM, MAX_ZOOM);
        const mid = midpoint(t1, t2);
        const dx = mid.x - gesture.startMidX;
        const dy = mid.y - gesture.startMidY;
        setZoom(newZoom);
        setPan(
          clampPan(
            { x: gesture.startPan.x + dx, y: gesture.startPan.y + dy },
            newZoom,
            surface.w,
            surface.h,
          ),
        );
      }
    }

    function onTouchEnd(e: TouchEvent): void {
      if (e.touches.length === 0) {
        if (gesture?.mode === "pan" && gesture.moved) {
          // Pan crossed the drag threshold — suppress the synthesized click so
          // the underlying StateNode doesn't toggle selection from this gesture.
          suppressNextClick = true;
        }
        gesture = null;
      } else if (e.touches.length === 1 && gesture?.mode === "pinch") {
        // Transition pinch → pan when one finger lifts. Treat as moved=true so a
        // tap on whatever finger remains doesn't accidentally select a node.
        const t = e.touches[0];
        if (!t) return;
        gesture = {
          mode: "pan",
          startX: t.clientX,
          startY: t.clientY,
          startPan: { ...panRef.current },
          moved: true,
        };
      }
    }

    function onClickCapture(e: MouseEvent): void {
      if (suppressNextClick) {
        e.preventDefault();
        e.stopPropagation();
        suppressNextClick = false;
      }
    }

    node.addEventListener("touchstart", onTouchStart, { passive: false });
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    node.addEventListener("touchend", onTouchEnd);
    node.addEventListener("touchcancel", onTouchEnd);
    node.addEventListener("click", onClickCapture, { capture: true });
    return () => {
      node.removeEventListener("touchstart", onTouchStart);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("touchend", onTouchEnd);
      node.removeEventListener("touchcancel", onTouchEnd);
      node.removeEventListener("click", onClickCapture, { capture: true });
    };
  }, []);

  // Keyboard shortcuts. Ignore when an input/textarea is focused.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case "+":
        case "=":
          e.preventDefault();
          zoomIn();
          break;
        case "-":
        case "_":
          e.preventDefault();
          zoomOut();
          break;
        case "0":
          e.preventDefault();
          reset();
          break;
        case "[":
          if (onPrev) {
            e.preventDefault();
            onPrev();
          }
          break;
        case "]":
          if (onNext) {
            e.preventDefault();
            onNext();
          }
          break;
        default:
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onPrev, onNext, zoomIn, zoomOut, reset]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Middle-mouse always pans; left-mouse pans only on empty surface (not on a node/control).
      const isMiddle = e.button === 1;
      const isLeft = e.button === 0;
      if (!isMiddle && !isLeft) return;
      const targetEl = e.target as HTMLElement;
      const onInteractive = targetEl.closest("button, a, input");
      if (isLeft && onInteractive) return;

      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startPan = { ...pan };
      let moved = false;

      function onMove(m: MouseEvent): void {
        const dx = m.clientX - startX;
        const dy = m.clientY - startY;
        if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
          moved = true;
          setIsPanning(true);
        }
        if (moved) {
          const surface = surfaceSizeRef.current;
          setPan(
            clampPan(
              { x: startPan.x + dx, y: startPan.y + dy },
              zoomRef.current,
              surface.w,
              surface.h,
            ),
          );
        }
      }
      function onUp(): void {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setIsPanning(false);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [pan],
  );

  const zoomReadout = useMemo(() => `${Math.round(zoom * 100)}%`, [zoom]);
  const canPan = zoom > 1.001;
  const cursor = isPanning ? "grabbing" : canPan ? "grab" : "default";

  return (
    <section className="workflow-canvas-shell">
      <header className="workflow-canvas-header">
        <div className="workflow-canvas-title-group">
          <h1 className="workflow-canvas-title">{title}</h1>
          <span className="workflow-canvas-character">{character}</span>
        </div>
        <div
          className="workflow-canvas-controls"
          role="group"
          aria-label="Canvas zoom"
        >
          <button
            type="button"
            className="workflow-canvas-control"
            onClick={zoomOut}
            data-tooltip="Zoom out (−)"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM + 0.001}
          >
            −
          </button>
          <span className="workflow-canvas-zoom-readout" aria-live="polite">
            {zoomReadout}
          </span>
          <button
            type="button"
            className="workflow-canvas-control"
            onClick={zoomIn}
            data-tooltip="Zoom in (+)"
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM - 0.001}
          >
            +
          </button>
          <button
            type="button"
            className="workflow-canvas-control"
            onClick={reset}
            data-tooltip="Reset (0)"
            aria-label="Reset zoom and pan"
          >
            ⌖
          </button>
        </div>
      </header>
      <div
        ref={surfaceRef}
        className="workflow-canvas-surface"
        onMouseDown={onMouseDown}
        style={{ cursor }}
      >
        <div
          className="workflow-canvas-transform"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px)`,
          }}
        >
          <CanvasZoomContext.Provider value={zoom}>
            {children}
          </CanvasZoomContext.Provider>
        </div>
      </div>
      <footer className="workflow-canvas-footer">
        <button
          type="button"
          className="workflow-canvas-nav"
          onClick={onPrev}
          disabled={!prev}
          data-tooltip={prev ? `Previous: ${prev.name} ([)` : undefined}
          aria-label={
            prev ? `Previous workflow: ${prev.name}` : "No previous workflow"
          }
        >
          <span className="workflow-canvas-nav-arrow" aria-hidden="true">
            ◀
          </span>
          <span className="workflow-canvas-nav-label">
            {prev ? prev.name : "—"}
          </span>
        </button>
        <span
          className="workflow-canvas-counter"
          aria-label={`Workflow ${index} of ${total}`}
        >
          {index} / {total}
        </span>
        <button
          type="button"
          className="workflow-canvas-nav workflow-canvas-nav--next"
          onClick={onNext}
          disabled={!next}
          data-tooltip={next ? `Next: ${next.name} (])` : undefined}
          aria-label={next ? `Next workflow: ${next.name}` : "No next workflow"}
        >
          <span className="workflow-canvas-nav-label">
            {next ? next.name : "—"}
          </span>
          <span className="workflow-canvas-nav-arrow" aria-hidden="true">
            ▶
          </span>
        </button>
      </footer>
    </section>
  );
}
