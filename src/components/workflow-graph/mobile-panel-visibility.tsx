"use client";

import { createContext, useContext } from "react";

/**
 * Whether the subtree is the primary panel currently on screen (README §12:
 * at and below 768px exactly one panel is visible at a time).
 *
 * Both workflow pages keep every panel mounted and hide the inactive ones in
 * CSS, so a panel that owns a browser-level affordance — the back gesture — has
 * to be told when it is no longer the thing the reader is looking at.
 * Off-screen it must give that affordance back, or a gesture aimed at the
 * visible panel would be spent silently on a hidden one.
 *
 * Defaults to `true`: a panel with no surrounding declaration is on screen
 * whenever it is mounted.
 */
const MobilePanelOnScreenContext = createContext(true);

export function MobilePanelVisibility({
  onScreen,
  children,
}: {
  readonly onScreen: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <MobilePanelOnScreenContext.Provider value={onScreen}>
      {children}
    </MobilePanelOnScreenContext.Provider>
  );
}

export function useMobilePanelOnScreen(): boolean {
  return useContext(MobilePanelOnScreenContext);
}
