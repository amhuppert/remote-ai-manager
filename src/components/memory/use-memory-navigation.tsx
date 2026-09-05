"use client";

import { useCallback, useEffect, useState } from "react";
import ConfirmDialog from "@/components/ConfirmDialog";
import { createClientLogger } from "@/lib/logging/client-logger";

const logger = createClientLogger("memory-navigation");

export function useMemoryNavigation() {
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const navigate = useCallback(
    (action: () => void) => {
      if (!dirty) {
        action();
        return;
      }
      logger.info("memory.navigation.unsaved_edits", {});
      setPending(() => action);
    },
    [dirty],
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return {
    setDirty,
    navigate,
    dialog: (
      <ConfirmDialog
        open={pending !== null}
        title="Discard memory edits"
        message="Save your edits before leaving, or discard them to continue."
        confirmLabel="Discard edits"
        cancelLabel="Keep editing"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          setDirty(false);
          setPending(null);
          pending?.();
        }}
      />
    ),
  };
}
