"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import MergeToast from "./MergeToast";
import {
  useNotificationToastQueue,
  useDismissToast,
} from "@/stores/notification.store";

export default function MergeToastContainer() {
  const toastQueue = useNotificationToastQueue();
  const dismissToast = useDismissToast();
  const router = useRouter();

  const currentToast = toastQueue[0];

  const handleAction = useCallback(() => {
    if (!currentToast) return;
    const basePath = `/projects/${encodeURIComponent(currentToast.projectName)}/${encodeURIComponent(currentToast.sessionName)}`;

    if (currentToast.type === "merge-conflicts") {
      router.push(`${basePath}/conflicts`);
    } else {
      router.push(basePath);
    }
    dismissToast();
  }, [currentToast, router, dismissToast]);

  const handleDismiss = useCallback(() => {
    dismissToast();
  }, [dismissToast]);

  if (!currentToast) return null;

  // Map notification type to toast variant
  let variant: "success" | "conflicts" | "error" | "ready-to-land";
  if (currentToast.type === "merge-ready-to-land") {
    variant = "ready-to-land";
  } else if (currentToast.type.endsWith("-completed")) {
    variant = "success";
  } else if (currentToast.type === "merge-conflicts") {
    variant = "conflicts";
  } else {
    variant = "error";
  }

  return (
    <MergeToast
      variant={variant}
      branchName={currentToast.branchName}
      targetBranch={currentToast.targetBranch}
      conflictCount={currentToast.conflictCount}
      mergeHash={currentToast.mergeHash}
      errorMessage={currentToast.errorMessage}
      onAction={handleAction}
      onDismiss={handleDismiss}
      autoDismissMs={8000}
    />
  );
}
