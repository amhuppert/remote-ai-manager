"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import {
  nextNavigationRequest,
  type InspectorDestination,
  type InspectorNavigationHandle,
  type InspectorNavigationRequest,
} from "./navigation";

/**
 * The inspector's navigation handle, shared through context.
 *
 * The surfaces that link into the inspector — a halt card on the canvas, an
 * advisory row, a gate in the Overview — are spread across the page and none of
 * them owns the rail. Passing the handle through context means each one states
 * the destination it wants and nothing in between has to carry a prop for it.
 *
 * Outside a provider the handle is inert rather than absent: a surface rendered
 * without a rail (a story, a historical read-only view) still renders, and the
 * link is simply a no-op instead of a crash.
 */

const NOOP_HANDLE: InspectorNavigationHandle = { openContext: () => {} };

const InspectorNavigationContext =
  createContext<InspectorNavigationHandle>(NOOP_HANDLE);

export function useInspectorNavigation(): InspectorNavigationHandle {
  return useContext(InspectorNavigationContext);
}

/**
 * Owns the outstanding request. The host holds this so it can both publish the
 * handle to its descendants and hand the request to the rail; selecting the
 * context stays the host's job, because the rail does not own selection.
 */
export function useInspectorNavigationState(
  onSelectContext: (contextId: string) => void,
): {
  request: InspectorNavigationRequest | null;
  handle: InspectorNavigationHandle;
} {
  const [request, setRequest] = useState<InspectorNavigationRequest | null>(
    null,
  );

  const openContext = useCallback(
    (contextId: string, destination: InspectorDestination) => {
      onSelectContext(contextId);
      setRequest((previous) =>
        nextNavigationRequest(previous, contextId, destination),
      );
    },
    [onSelectContext],
  );

  const handle = useMemo<InspectorNavigationHandle>(
    () => ({ openContext }),
    [openContext],
  );

  return { request, handle };
}

export function InspectorNavigationProvider({
  handle,
  children,
}: {
  handle: InspectorNavigationHandle;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <InspectorNavigationContext.Provider value={handle}>
      {children}
    </InspectorNavigationContext.Provider>
  );
}
