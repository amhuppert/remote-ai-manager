"use client";

import { useCallback } from "react";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import { cn } from "@/lib/ui/cn";
import { toPaneViewModel } from "./pane-view-model";
import PaneConversationBody from "./PaneConversationBody";

export interface PaneProps {
  conversation: SessionActiveConversation;
  active: boolean;
  onActivate: (id: string) => void;
  onOpenFull: (id: string) => void;
  onClose: (id: string) => void;
  /**
   * External-geometry utilities applied by the parent grid — the asym-5 shape's
   * per-pane column span (layout-only; docs/tailwind-conventions §2). Appended
   * after the pane's own appearance, never overriding it.
   */
  layoutClassName?: string;
}

type ConversationStatus = SessionActiveConversation["status"];

// Duplicated-private in ConversationSidebarRow and PeekPopover (each owns its own
// copy, neither exports it). Kept local here rather than reaching across feature
// boundaries; a shared-util extraction is deferred.
const STATUS_LABEL: Record<ConversationStatus, string> = {
  new: "new",
  running: "running",
  awaiting: "awaiting",
  waiting_for_input: "waiting for input",
};

// Pane frame box: layout, gap, border width/style, radius, surface bg, cursor,
// and the resting transition. Border-colour and box-shadow vary by active state
// (plus the composer-focus emphasis driven from the `.panes` group), so they
// live in the maps below — no two applied utilities target one CSS property.
const paneBase =
  "flex flex-col gap-xs min-h-0 min-w-0 overflow-hidden p-sm border border-solid rounded-md bg-bg-surface cursor-pointer " +
  "[transition:box-shadow_0.15s_ease,border-color_0.15s_ease,opacity_0.2s_ease]";

// Active: cyan ring, intensified while the shared composer holds focus (the
// parent `.panes` group carries data-composer-focused). Inactive: the separator
// shadow, dimmed under composer focus. The composer-focus variants override the
// resting box-shadow/opacity by ancestor specificity (group-data selector beats
// the plain class), so the cascade is order-independent (§8.2).
//
const paneActive =
  "border-cyan shadow-[0_0_0_1px_var(--cyan),0_0_12px_var(--cyan-glow)] " +
  "group-data-[composer-focused=true]:shadow-[0_0_0_1px_var(--cyan),0_0_18px_var(--cyan-glow-strong)]";
const paneInactive =
  "border-border-subtle shadow-[0_2px_10px_var(--cc-black-a35)] " +
  "group-data-[composer-focused=true]:opacity-45";

const headClass = "flex items-center gap-xs shrink-0";

// Status dot — the same transcription as the sibling AddConversationMenu /
// ConversationTab dots: a static class map keyed by the status union (a
// `data-[status=…]` arbitrary variant can't carry the `waiting_for_input`
// underscore — Tailwind rewrites `_` to a space), no base background (every
// status supplies one).
const dotBase = "w-[7px] h-[7px] rounded-full shrink-0";
const dotBgClass: Record<ConversationStatus, string> = {
  new: "bg-blue",
  running: "bg-cyan",
  awaiting: "bg-green",
  waiting_for_input: "bg-amber",
};
const dotGlowClass: Record<ConversationStatus, string> = {
  new: "shadow-[0_0_6px_var(--blue-glow)]",
  running: "shadow-[0_0_6px_var(--cyan-glow-strong)]",
  awaiting: "shadow-[0_0_6px_var(--green-glow)]",
  waiting_for_input: "shadow-[0_0_6px_var(--amber-glow)]",
};

const titleClass =
  "flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-text-primary font-mono text-[0.78rem] font-medium";

// Open-full / close — 20px borderless icon buttons, smaller than the IconButton
// `square`/`ghost` recipes, so authored locally.
const iconBtnClass =
  "inline-flex items-center justify-center w-[20px] h-[20px] p-0 border-0 rounded-sm bg-transparent text-text-secondary font-mono text-[0.9rem] leading-none cursor-pointer shrink-0 " +
  "[transition:background_0.15s_ease,color_0.15s_ease] hover:bg-bg-hover hover:text-text-primary";

const metaClass =
  "flex items-center gap-sm shrink-0 overflow-hidden text-text-tertiary font-mono text-[0.7rem]";
const metaLocClass = "overflow-hidden text-ellipsis whitespace-nowrap";
const metaTimeClass = "ml-auto shrink-0";

// Pending-question banner (amber) — mirrors the sidebar row's pending-question
// treatment. Single left border, so the other sides are zeroed (Preflight is
// OFF; §1.5). `line-clamp-3` carries the -webkit-box / line-clamp / overflow set.
const bannerClass =
  "shrink-0 py-xs px-sm border-y-0 border-r-0 border-l-2 border-solid border-amber rounded-sm bg-amber-glow text-amber font-mono text-[0.72rem] leading-[1.4] line-clamp-3";

const statusLineClass =
  "shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-text-secondary font-mono text-[0.72rem]";

export default function Pane({
  conversation,
  active,
  onActivate,
  onOpenFull,
  onClose,
  layoutClassName,
}: PaneProps): React.JSX.Element {
  const vm = toPaneViewModel(conversation);

  const handleActivate = useCallback(() => {
    if (!active) onActivate(conversation.id);
  }, [active, conversation.id, onActivate]);

  const handleOpenFull = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onOpenFull(conversation.id);
    },
    [conversation.id, onOpenFull],
  );

  const handleClose = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onClose(conversation.id);
    },
    [conversation.id, onClose],
  );

  // Banner when the agent is blocked on the operator; otherwise the latest
  // status line. When neither applies, the slot renders nothing.
  const showBanner =
    vm.status === "waiting_for_input" && vm.pendingQuestion !== null;

  return (
    <section
      className={cn(
        paneBase,
        active ? paneActive : paneInactive,
        layoutClassName,
      )}
      data-active={active ? "true" : undefined}
      onClick={handleActivate}
    >
      <header className={headClass}>
        <span
          className={cn(
            dotBase,
            dotBgClass[vm.status],
            dotGlowClass[vm.status],
          )}
          aria-hidden="true"
        />
        <span className={titleClass}>{vm.title}</span>
        <button
          type="button"
          className={iconBtnClass}
          aria-label="Open full"
          onClick={handleOpenFull}
        >
          ↗
        </button>
        <button
          type="button"
          className={iconBtnClass}
          aria-label="Close pane"
          onClick={handleClose}
        >
          ×
        </button>
      </header>

      <div className={metaClass}>
        <span>{STATUS_LABEL[vm.status]}</span>
        <span className={metaLocClass}>
          {vm.projectName}
          {vm.sessionName !== null && ` / ${vm.sessionName}`}
        </span>
        <span className={metaTimeClass}>{vm.relativeTime}</span>
      </div>

      {showBanner && vm.pendingQuestion !== null ? (
        <div className={bannerClass}>{vm.pendingQuestion}</div>
      ) : vm.statusLine !== null ? (
        <div className={statusLineClass}>{vm.statusLine}</div>
      ) : null}

      <PaneConversationBody
        projectName={conversation.projectName}
        sessionName={conversation.sessionName}
        conversationId={conversation.id}
        selectedBackend={conversation.agentBackend}
        isActive={active}
      />
    </section>
  );
}
