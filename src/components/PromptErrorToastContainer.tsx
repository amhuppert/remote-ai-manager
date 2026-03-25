"use client";

import { useCallback } from "react";
import PromptErrorToast from "./PromptErrorToast";
import {
  usePromptErrorQueue,
  useDismissPromptErrorToast,
} from "@/stores/notification.store";

export default function PromptErrorToastContainer() {
  const queue = usePromptErrorQueue();
  const dismissToast = useDismissPromptErrorToast();

  const current = queue[0];

  const handleDismiss = useCallback(() => {
    dismissToast();
  }, [dismissToast]);

  if (!current) return null;

  return (
    <PromptErrorToast
      sessionName={current.sessionName}
      error={current.error}
      onDismiss={handleDismiss}
      autoDismissMs={12_000}
    />
  );
}
