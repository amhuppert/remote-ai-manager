"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import InputNeededToast from "./InputNeededToast";
import { conversationsPageHref } from "@/lib/conversations/hrefs";
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
    if (current.scope === "project") {
      router.push(current.href);
      dismissToast();
      return;
    }
    router.push(
      conversationsPageHref({ conversationId: current.conversationId }),
    );
    dismissToast();
  }, [current, router, dismissToast]);

  const handleDismiss = useCallback(() => {
    dismissToast();
  }, [dismissToast]);

  if (!current) return null;

  return (
    <InputNeededToast
      sessionName={
        current.scope === "project" ? undefined : current.sessionName
      }
      contextLabel={
        current.scope === "project"
          ? current.displayContext
          : current.sessionName
      }
      projectName={current.projectName}
      title={current.title}
      variant={current.scope === "project" ? undefined : current.variant}
      contextTitle={
        current.scope === "project" ? undefined : current.contextTitle
      }
      onAction={handleAction}
      onDismiss={handleDismiss}
      autoDismissMs={10_000}
    />
  );
}
