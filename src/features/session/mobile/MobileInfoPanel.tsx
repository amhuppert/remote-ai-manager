"use client";

import { memo, useCallback, useState } from "react";
import { ContextFillIndicator } from "@/components/ContextFillIndicator";
import { deriveSessionPromptCount } from "@/lib/sessions/derived";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

// All of MobileInfoPanel's chrome lived inside session.css's `@media (max-width:
// 768px)` block, so every utility carries the `max-768:` variant. The panel is
// only laid out when the mobile shell exposes the info tab — transcribed 1:1 as
// the shell-state arbitrary variant `[.app[data-mobile-panel=info]_&]`.
const PANEL_CLASS =
  "max-768:[.app[data-mobile-panel=info]_&]:flex max-768:[.app[data-mobile-panel=info]_&]:min-h-0 max-768:[.app[data-mobile-panel=info]_&]:flex-1 max-768:[.app[data-mobile-panel=info]_&]:flex-col max-768:[.app[data-mobile-panel=info]_&]:gap-[2px] max-768:[.app[data-mobile-panel=info]_&]:overflow-y-auto max-768:[.app[data-mobile-panel=info]_&]:px-sm max-768:[.app[data-mobile-panel=info]_&]:py-md";
const ROW_CLASS =
  "max-768:flex max-768:items-center max-768:gap-sm max-768:rounded-sm max-768:p-sm max-768:font-mono max-768:text-[0.78rem] max-768:odd:bg-[var(--cc-bg-surface-a30)]";
const COPYABLE_CLASS =
  "max-768:cursor-pointer max-768:transition-[background] max-768:duration-100 max-768:ease-[ease] max-768:active:bg-bg-hover";
const LABEL_CLASS =
  "max-768:min-w-[80px] max-768:shrink-0 max-768:text-[0.7rem] max-768:font-semibold max-768:uppercase max-768:tracking-[0.06em] max-768:text-text-tertiary";
const VALUE_CLASS =
  "max-768:min-w-0 max-768:flex-1 max-768:overflow-hidden max-768:text-ellipsis max-768:whitespace-nowrap max-768:text-text-secondary";
const COPY_ICON_CLASS =
  "max-768:w-[20px] max-768:shrink-0 max-768:text-center max-768:text-[0.8rem] max-768:text-text-tertiary";
const ACTIONS_CLASS =
  "max-768:border-x-0 max-768:border-b-0 max-768:border-t max-768:border-solid max-768:border-border-subtle max-768:px-sm max-768:py-md";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MobileInfoCopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={`${ROW_CLASS} ${COPYABLE_CLASS}`}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      role="button"
      tabIndex={0}
    >
      <span className={LABEL_CLASS}>{label}</span>
      <span className={VALUE_CLASS}>{value}</span>
      <span className={COPY_ICON_CLASS}>{copied ? "✓" : "⎘"}</span>
    </div>
  );
}

interface MobileInfoPanelProps {
  session: SessionState;
  activeConversation: ConversationState | undefined;
  conversationId: string;
  statusDotClass: string;
  displayStatus: string;
  contextPercent: number | null;
  /** Build the full conversation context string for clipboard. */
  buildContext: () => string | null;
}

function MobileInfoPanel({
  session,
  activeConversation,
  conversationId,
  statusDotClass,
  displayStatus,
  contextPercent,
  buildContext,
}: MobileInfoPanelProps): React.JSX.Element {
  const [contextCopied, setContextCopied] = useState(false);

  const handleCopyContext = useCallback(() => {
    const text = buildContext();
    if (text === null) return;
    void navigator.clipboard.writeText(text).then(() => {
      setContextCopied(true);
      setTimeout(() => setContextCopied(false), 1500);
    });
  }, [buildContext]);

  const backendRefDisplay = activeConversation?.backendRef
    ? activeConversation.backendRef.backend === "claude"
      ? activeConversation.backendRef.sessionId
      : activeConversation.backendRef.backend === "codex"
        ? activeConversation.backendRef.threadId
        : "—"
    : "—";

  return (
    <div className={PANEL_CLASS}>
      <div className={ROW_CLASS}>
        <span className={LABEL_CLASS}>Status</span>
        <span className={VALUE_CLASS}>
          {/* ESCAPE HATCH: retained on `.status-dot`. The StatusDot primitive
              bakes a 7px box, but this row renders a 6px dot via the inline-style
              override. Sizing is appearance the primitive owns, and `size`/`h`
              are not layout-allowed in `layoutClassName` (eslint
              no-appearance-in-layout-classname), so a byte-identical swap is not
              possible from this slice. `.status-dot` survives integration anyway
              (ConversationList + topbar consumers). Remediation: a StatusDot
              `size` prop, then swap. */}
          <span
            className={`status-dot ${statusDotClass}`}
            style={{
              width: 6,
              height: 6,
              display: "inline-block",
              marginRight: 6,
            }}
          />
          {displayStatus}
        </span>
      </div>
      <MobileInfoCopyRow label="Branch" value={session.branchName} />
      <div className={ROW_CLASS}>
        <span className={LABEL_CLASS}>Created</span>
        <span className={VALUE_CLASS}>{formatDate(session.createdAt)}</span>
      </div>
      <div className={ROW_CLASS}>
        <span className={LABEL_CLASS}>Prompts</span>
        <span className={VALUE_CLASS}>{deriveSessionPromptCount(session)}</span>
      </div>
      <MobileInfoCopyRow label="Worktree" value={session.worktreePath} />
      <MobileInfoCopyRow label="Conv ID" value={conversationId} />
      {activeConversation && (
        <>
          <MobileInfoCopyRow
            label="Backend"
            value={activeConversation.agentBackend}
          />
          <MobileInfoCopyRow label="Session Ref" value={backendRefDisplay} />
        </>
      )}
      {contextPercent != null && (
        <div className={ROW_CLASS}>
          <span className={LABEL_CLASS}>Context</span>
          <span className={VALUE_CLASS}>
            <ContextFillIndicator percentage={contextPercent} />
          </span>
        </div>
      )}
      <div className={ACTIONS_CLASS}>
        {/* ESCAPE HATCH: retained on `.btn btn-sm`. The full-width mobile control
            centres its label via `max-768:justify-center` (justify-content), which
            is not on the `layoutClassName` allowlist (only `justify-self`), and the
            Button primitive exposes no content-justify slot. Dropping it would
            left-align the label (regression); extending LAYOUT_ALLOWED is out of
            this slice's ownership. `.btn`/`.btn-sm` survive integration anyway.
            Remediation: allow `justify-*` in LAYOUT_ALLOWED (or a Button content
            prop), then swap to <Button variant="default" size="sm" touch>. */}
        <button
          className="btn btn-sm max-768:flex max-768:w-full max-768:justify-center"
          onClick={handleCopyContext}
        >
          {contextCopied ? "✓ Copied" : "⎘ Copy Context"}
        </button>
      </div>
    </div>
  );
}

export default memo(MobileInfoPanel);
