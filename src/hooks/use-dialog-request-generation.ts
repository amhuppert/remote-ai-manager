"use client";

import { useCallback, useEffect, useRef } from "react";

export interface DialogRequestGeneration {
  capture(): number;
  isCurrent(generation: number): boolean;
  invalidate(): void;
}

/** Keeps async settlements owned by the dialog opening that submitted them. */
export function useDialogRequestGeneration(
  open: boolean,
): DialogRequestGeneration {
  const generationRef = useRef(0);
  const previousOpenRef = useRef(open);

  useEffect(() => {
    if (previousOpenRef.current === open) return;
    previousOpenRef.current = open;
    generationRef.current += 1;
  }, [open]);

  const capture = useCallback(() => generationRef.current, []);
  const isCurrent = useCallback(
    (generation: number) => generation === generationRef.current,
    [],
  );
  const invalidate = useCallback(() => {
    generationRef.current += 1;
  }, []);

  return { capture, isCurrent, invalidate };
}
