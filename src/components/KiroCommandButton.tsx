"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useKiroCommandContext } from "./KiroCommandContext";
import { useCreateConversationMutation } from "@/lib/mutations";
import { useSetPendingForkPrompt } from "@/stores/session-detail.store";
import { supportsAutoApprove, buildKiroPrompt } from "@/lib/kiro-commands";

interface KiroCommandButtonProps {
  commandName: string;
  args: string | null;
  children: React.ReactNode;
}

export function KiroCommandButton({
  commandName,
  args,
  children,
}: KiroCommandButtonProps) {
  const ctx = useKiroCommandContext();

  // Graceful fallback: render plain text when outside provider
  if (!ctx) {
    return <>{children}</>;
  }

  return (
    <KiroCommandButtonInner commandName={commandName} args={args} ctx={ctx}>
      {children}
    </KiroCommandButtonInner>
  );
}

/** Inner component that has guaranteed context access */
function KiroCommandButtonInner({
  commandName,
  args,
  ctx,
  children,
}: KiroCommandButtonProps & {
  ctx: NonNullable<ReturnType<typeof useKiroCommandContext>>;
}) {
  const router = useRouter();
  const setPendingForkPrompt = useSetPendingForkPrompt();
  const createConversation = useCreateConversationMutation(
    ctx.projectName,
    ctx.sessionName,
  );

  const [open, setOpen] = useState(false);
  const [autoApprove, setAutoApprove] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const showAutoApprove = supportsAutoApprove(commandName);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    // Delay to avoid immediate close from the opening click
    const timer = setTimeout(() => {
      document.addEventListener("click", handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handleClick);
    };
  }, [open]);

  const handleRunHere = useCallback(async () => {
    const prompt = buildKiroPrompt(commandName, args, autoApprove);
    setOpen(false);
    await ctx.sendPrompt(prompt, ctx.messageCount, ctx.selectedModel);
  }, [commandName, args, autoApprove, ctx]);

  const handleNewConversation = useCallback(async () => {
    const prompt = buildKiroPrompt(commandName, args, autoApprove);
    setOpen(false);

    try {
      const conversation = await createConversation.mutateAsync();
      setPendingForkPrompt({
        conversationId: conversation.id,
        text: prompt,
      });
      router.push(
        `/projects/${encodeURIComponent(ctx.projectName)}/${encodeURIComponent(ctx.sessionName)}/${encodeURIComponent(conversation.id)}`,
      );
    } catch {
      // Mutation error handling is in the mutation itself
    }
  }, [
    commandName,
    args,
    autoApprove,
    createConversation,
    setPendingForkPrompt,
    router,
    ctx.projectName,
    ctx.sessionName,
  ]);

  return (
    <span className="kiro-cmd-wrapper">
      {children}
      <button
        ref={btnRef}
        className="kiro-cmd-run-btn"
        aria-label="Run command"
        title="Run this command"
        disabled={ctx.isBusy}
        onClick={() => setOpen((v) => !v)}
      >
        {"\u25B6"}
      </button>
      {open && (
        <span
          ref={popoverRef}
          className="kiro-cmd-popover open"
          role="dialog"
          aria-label="Run Kiro command options"
        >
          <span className="kiro-cmd-popover-header">Run Command</span>
          {showAutoApprove && (
            <label className="kiro-cmd-popover-toggle">
              <input
                type="checkbox"
                checked={autoApprove}
                onChange={(e) => setAutoApprove(e.target.checked)}
                aria-label="Auto-approve (-y)"
              />
              Auto-approve (-y)
            </label>
          )}
          <span className="kiro-cmd-popover-actions">
            <button
              className="btn btn-ghost"
              onClick={handleRunHere}
              disabled={ctx.isBusy}
            >
              Run Here
            </button>
            <button
              className="btn btn-primary"
              onClick={handleNewConversation}
              disabled={createConversation.isPending}
            >
              New Conversation
            </button>
          </span>
        </span>
      )}
    </span>
  );
}
