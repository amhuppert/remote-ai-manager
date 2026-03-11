"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import InputNeededToast from "./InputNeededToast";
import {
  useInputToastQueue,
  useDismissInputToast,
} from "@/stores/notification.store";

export default function InputNeededToastContainer() {
  const queue = useInputToastQueue();
  const dismissToast = useDismissInputToast();
  const router = useRouter();

  const current = queue[0];

  const handleAction = useCallback(() => {
    if (!current) return;
    const basePath = `/projects/${encodeURIComponent(current.projectName)}/${encodeURIComponent(current.sessionName)}`;
    router.push(`${basePath}/${current.conversationId}`);
    dismissToast();
  }, [current, router, dismissToast]);

  const handleDismiss = useCallback(() => {
    dismissToast();
  }, [dismissToast]);

  if (!current) return null;

  return (
    <InputNeededToast
      sessionName={current.sessionName}
      projectName={current.projectName}
      onAction={handleAction}
      onDismiss={handleDismiss}
      autoDismissMs={10_000}
    />
  );
}
