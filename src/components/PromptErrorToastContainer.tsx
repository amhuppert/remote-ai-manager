"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import PromptErrorToast from "./PromptErrorToast";
import {
  usePromptErrorQueue,
  useDismissPromptErrorToast,
} from "@/stores/notification.store";

export default function PromptErrorToastContainer() {
  const queue = usePromptErrorQueue();
  const dismissToast = useDismissPromptErrorToast();
  const router = useRouter();

  const current = queue[0];

  const handleAction = useCallback(() => {
    if (!current || current.scope !== "project") return;
    router.push(current.href);
    dismissToast();
  }, [current, router, dismissToast]);

  const handleDismiss = useCallback(() => {
    dismissToast();
  }, [dismissToast]);

  if (!current) return null;

  return (
    <PromptErrorToast
      sessionName={
        current.scope === "project" ? undefined : current.sessionName
      }
      projectName={
        current.scope === "project" ? current.projectName : undefined
      }
      contextLabel={
        current.scope === "project"
          ? current.displayContext
          : current.sessionName
      }
      error={current.error}
      onAction={current.scope === "project" ? handleAction : undefined}
      onDismiss={handleDismiss}
      autoDismissMs={12_000}
    />
  );
}
