"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";

import { conversationsPageHref } from "@/lib/conversations/hrefs";
import {
  useNotificationToastQueue,
  useDismissToast as useDismissMergeToast,
  useInputToastQueue,
  useDismissInputToast,
  usePromptErrorQueue,
  useDismissPromptErrorToast,
} from "@/stores/notification.store";
import { useToasts, useDismissToast } from "@/stores/toast.store";

import Toast from "./Toast";
import MergeToast from "./MergeToast";
import InputNeededToast from "./InputNeededToast";
import PromptErrorToast from "./PromptErrorToast";

function MergeToastSource(): React.JSX.Element | null {
  const toastQueue = useNotificationToastQueue();
  const dismissToast = useDismissMergeToast();
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

function InputNeededToastSource(): React.JSX.Element | null {
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

function PromptErrorToastSource(): React.JSX.Element | null {
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

/**
 * The store-driven generic toast list, exported on its own for surfaces that
 * need toast feedback without the router-dependent merge/input/prompt-error
 * sources (e.g. Storybook stories rendered outside an app router).
 */
export function GenericToastSource(): React.JSX.Element | null {
  const toasts = useToasts();
  const dismiss = useDismissToast();
  if (toasts.length === 0) return null;
  return (
    <section
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-md left-1/2 z-toast flex max-h-[calc(100vh_-_var(--spacing-3xl))] w-max max-w-[calc(100vw_-_var(--spacing-lg))] [transform:translateX(-50%)] flex-col items-center gap-sm overflow-y-auto p-sm"
    >
      {toasts.map((t) => (
        <Toast
          key={t.id}
          message={t.message}
          action={t.action}
          actions={t.actions}
          onDismiss={() => dismiss(t.id)}
          placement="stacked"
        />
      ))}
    </section>
  );
}

/**
 * Single mount point for every toast source. Each source reads its own queue in
 * the notification/toast stores and renders its own surface; hosting them under
 * one component keeps the app to one toast mount instead of four sibling
 * containers in the root layout.
 */
export default function ToastHost(): React.JSX.Element {
  return (
    <>
      <MergeToastSource />
      <InputNeededToastSource />
      <PromptErrorToastSource />
      <GenericToastSource />
    </>
  );
}
