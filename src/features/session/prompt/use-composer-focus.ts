import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent, RefObject } from "react";
import { useSetComposerFocused } from "@/stores/session-detail.store";

export interface ComposerFocusHandle {
  /** Attach to the composer region wrapper. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Attach to the region container; bubbles (focusin) from any descendant. */
  onFocus: () => void;
  /** Attach to the region container; bubbles (focusout) from any descendant. */
  onBlur: (event: FocusEvent) => void;
  /** Portal overlays (capabilities drawer, mobile sheet) report open/closed. */
  setControlActive: (key: string, active: boolean) => void;
}

// composerFocused = editorHasFocus OR aComposerControlIsActive. The editor
// signal covers focus inside the region DOM; the control signal covers overlay
// controls rendered in portals OUTSIDE the region (drawer, mobile sheet) that
// take focus away from the region but should still hold the composer "focused".
export function useComposerFocus(): ComposerFocusHandle {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const setComposerFocused = useSetComposerFocused();

  const [editorHasFocus, setEditorHasFocus] = useState(false);
  const [activeControls, setActiveControls] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const onFocus = useCallback(() => {
    setEditorHasFocus(true);
  }, []);

  const onBlur = useCallback((event: FocusEvent) => {
    // Focus moving between in-flow controls inside the region (model/effort
    // dropdown triggers, debug toggle, voice button) keeps the editor focused.
    const next = event.relatedTarget;
    if (next instanceof Node && containerRef.current?.contains(next)) return;
    setEditorHasFocus(false);
  }, []);

  const setControlActive = useCallback((key: string, active: boolean) => {
    setActiveControls((prev) => {
      if (active === prev.has(key)) return prev;
      const next = new Set(prev);
      if (active) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setComposerFocused(editorHasFocus || activeControls.size > 0);
  }, [editorHasFocus, activeControls, setComposerFocused]);

  // Leaving the composer entirely (unmount) clears the emphasis flag.
  useEffect(() => () => setComposerFocused(false), [setComposerFocused]);

  return { containerRef, onFocus, onBlur, setControlActive };
}
