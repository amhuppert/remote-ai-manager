"use client";

import { useState } from "react";
import MarkdownViewer from "@/components/MarkdownViewer";
import { Button } from "@/components/ui/Button";
import {
  SectionHeader,
  SectionLabel,
  SectionCount,
} from "@/components/ui/SectionHeader";
import type {
  AlignmentDecision,
  AlignmentDiff,
  AlignmentState,
  AlignmentVersion,
} from "@/lib/session-alignment/schemas";

export interface AlignmentPanelViewProps {
  /** The aggregate alignment state, or null when not yet loaded / absent. */
  state: AlignmentState | null;
  isLoading: boolean;
  /** The diff returned for the currently-selected version pair, if any. */
  diff?: AlignmentDiff | null;
  /** Request a diff between two activated versions. */
  onSelectDiff(from: number, to: number): void;
  /** Roll back to a prior activated version (cloned into a new active one). */
  onRollback(version: number): void;
  /** Version whose rollback mutation is in flight; disables all rollback controls. */
  pendingRollbackVersion?: number | null;
  /** Jump to a decision's originating message in its conversation. */
  onNavigateToMessage?(conversationId: string, messageId: string): void;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Surface container mirrors DocsPanel's wrapper so the panel reads as part of the
// documents surface, not a parallel subsystem (R9.2).
const surfaceClass =
  "flex min-h-0 flex-1 flex-col gap-lg overflow-y-auto rounded-b-lg border border-solid border-border-subtle bg-bg-surface p-md";

function EmptyAlignment(): React.JSX.Element {
  return (
    <div className={surfaceClass}>
      <div className="flex flex-1 flex-col items-center justify-center gap-sm font-mono text-[0.78rem] text-text-tertiary">
        <span>No alignment yet.</span>
        <span className="text-text-tertiary">
          Run /align to draft a session charter.
        </span>
      </div>
    </div>
  );
}

function CharterMarkdown({ content }: { content: string }): React.JSX.Element {
  return (
    <div className="rounded-md border border-solid border-border-subtle bg-bg-base">
      <MarkdownViewer content={content} isLoading={false} />
    </div>
  );
}

function ActiveCharter({
  active,
}: {
  active: AlignmentVersion;
}): React.JSX.Element {
  return (
    <section>
      <SectionHeader>
        <SectionLabel>Active charter</SectionLabel>
        {active.version != null && (
          <SectionCount>v{active.version}</SectionCount>
        )}
      </SectionHeader>
      <CharterMarkdown content={active.content} />
      <div className="mt-xs flex flex-wrap items-center gap-md font-mono text-[0.7rem] text-text-tertiary">
        {active.activatedAt && (
          <span>Updated {formatTimestamp(active.activatedAt)}</span>
        )}
        {active.approver && <span>by {active.approver}</span>}
      </div>
    </section>
  );
}

function DraftSection({
  draft,
}: {
  draft: AlignmentVersion;
}): React.JSX.Element {
  return (
    <section data-testid="alignment-draft">
      <SectionHeader>
        <SectionLabel>Current draft</SectionLabel>
        <SectionCount>pending approval</SectionCount>
      </SectionHeader>
      <CharterMarkdown content={draft.content} />
    </section>
  );
}

function DiffControls({
  versions,
  diff,
  onSelectDiff,
}: {
  versions: number[];
  diff: AlignmentDiff | null | undefined;
  onSelectDiff: (from: number, to: number) => void;
}): React.JSX.Element | null {
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  if (versions.length < 2) return null;

  const selectClass =
    "rounded-sm border border-solid border-border-default bg-bg-base px-[8px] py-[4px] font-mono text-[0.72rem] text-text-primary focus:border-cyan focus:outline-none";

  return (
    <div className="flex flex-col gap-sm">
      <div className="flex flex-wrap items-center gap-sm font-mono text-[0.7rem] text-text-tertiary">
        <label className="flex items-center gap-xs">
          <span>Diff from</span>
          <select
            aria-label="Diff from"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={selectClass}
          >
            <option value="">—</option>
            {versions.map((v) => (
              <option key={v} value={String(v)}>
                v{v}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-xs">
          <span>Diff to</span>
          <select
            aria-label="Diff to"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={selectClass}
          >
            <option value="">—</option>
            {versions.map((v) => (
              <option key={v} value={String(v)}>
                v{v}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="ghost"
          size="sm"
          disabled={from === "" || to === ""}
          onClick={() => onSelectDiff(Number(from), Number(to))}
        >
          Compare
        </Button>
      </div>
      {diff && (
        <div data-testid="alignment-diff" className="grid grid-cols-2 gap-sm">
          <div className="rounded-md border border-solid border-border-subtle bg-bg-base">
            <div className="border-x-0 border-t-0 border-b border-solid border-border-subtle px-[8px] py-[4px] font-mono text-[0.7rem] text-text-tertiary">
              v{diff.from}
            </div>
            <pre className="overflow-x-auto px-[8px] py-[6px] font-mono text-[0.7rem] whitespace-pre-wrap text-text-secondary">
              {diff.fromContent}
            </pre>
          </div>
          <div className="rounded-md border border-solid border-border-subtle bg-bg-base">
            <div className="border-x-0 border-t-0 border-b border-solid border-border-subtle px-[8px] py-[4px] font-mono text-[0.7rem] text-text-tertiary">
              v{diff.to}
            </div>
            <pre className="overflow-x-auto px-[8px] py-[6px] font-mono text-[0.7rem] whitespace-pre-wrap text-text-secondary">
              {diff.toContent}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function HistorySection({
  history,
  activeVersion,
  diff,
  onSelectDiff,
  onRollback,
  pendingRollbackVersion,
}: {
  history: AlignmentVersion[];
  activeVersion: number | null;
  diff: AlignmentDiff | null | undefined;
  onSelectDiff: (from: number, to: number) => void;
  onRollback: (version: number) => void;
  pendingRollbackVersion: number | null;
}): React.JSX.Element {
  const versions = history
    .map((v) => v.version)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);

  return (
    <section>
      <SectionHeader>
        <SectionLabel>Version history</SectionLabel>
        <SectionCount>{history.length}</SectionCount>
      </SectionHeader>
      <DiffControls
        versions={versions}
        diff={diff}
        onSelectDiff={onSelectDiff}
      />
      <ul className="mt-sm flex list-none flex-col gap-xs p-0">
        {history.map((v) => (
          <li
            key={v.id}
            data-testid="alignment-history-row"
            className="flex items-center gap-md rounded-sm border border-solid border-border-subtle bg-bg-base px-[8px] py-[6px] font-mono text-[0.72rem]"
          >
            <span className="font-semibold text-text-primary">
              {v.version != null ? `v${v.version}` : "draft"}
            </span>
            {v.version === activeVersion && (
              <span className="text-cyan">active</span>
            )}
            {v.activatedAt && (
              <span className="text-text-tertiary">
                {formatTimestamp(v.activatedAt)}
              </span>
            )}
            {v.version != null && v.version !== activeVersion && (
              <Button
                variant="ghost"
                size="sm"
                layoutClassName="ml-auto"
                loading={pendingRollbackVersion === v.version}
                disabled={pendingRollbackVersion != null}
                onClick={() => onRollback(v.version!)}
              >
                {pendingRollbackVersion === v.version
                  ? "Rolling back…"
                  : `Roll back to v${v.version}`}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DecisionRow({
  decision,
  history,
  onSelectDiff,
  onNavigateToMessage,
}: {
  decision: AlignmentDecision;
  history: AlignmentVersion[];
  onSelectDiff: (from: number, to: number) => void;
  onNavigateToMessage?: (conversationId: string, messageId: string) => void;
}): React.JSX.Element {
  // A produced version is diffable against its immediate predecessor in history.
  const producedPredecessor =
    decision.producedVersion != null
      ? history
          .map((v) => v.version)
          .filter(
            (v): v is number => v != null && v < decision.producedVersion!,
          )
          .sort((a, b) => b - a)[0]
      : undefined;

  return (
    <li
      data-testid="alignment-decision-row"
      className="flex flex-col gap-xs rounded-sm border border-solid border-border-subtle bg-bg-base px-[8px] py-[6px]"
    >
      <span className="font-mono text-[0.74rem] text-text-primary">
        {decision.statement}
      </span>
      <div className="flex flex-wrap items-center gap-md font-mono text-[0.7rem] text-text-tertiary">
        <span>{formatTimestamp(decision.approvedAt)}</span>
        {decision.approver && <span>by {decision.approver}</span>}
        {decision.originMessageId && onNavigateToMessage && (
          <button
            type="button"
            onClick={() =>
              onNavigateToMessage(
                decision.originConversationId,
                decision.originMessageId!,
              )
            }
            className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[0.7rem] text-text-secondary underline transition-[color] duration-150 ease-[ease] hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
          >
            View message
          </button>
        )}
        {decision.producedVersion != null &&
          (producedPredecessor != null ? (
            <button
              type="button"
              onClick={() =>
                onSelectDiff(producedPredecessor, decision.producedVersion!)
              }
              className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[0.7rem] font-semibold text-cyan transition-[color] duration-150 ease-[ease] hover:text-cyan-dim focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
            >
              v{decision.producedVersion}
            </button>
          ) : (
            <span className="font-semibold text-cyan">
              v{decision.producedVersion}
            </span>
          ))}
      </div>
    </li>
  );
}

function DecisionLog({
  decisions,
  history,
  onSelectDiff,
  onNavigateToMessage,
}: {
  decisions: AlignmentDecision[];
  history: AlignmentVersion[];
  onSelectDiff: (from: number, to: number) => void;
  onNavigateToMessage?: (conversationId: string, messageId: string) => void;
}): React.JSX.Element {
  return (
    <section>
      <SectionHeader>
        <SectionLabel>Decision log</SectionLabel>
        <SectionCount>{decisions.length}</SectionCount>
      </SectionHeader>
      {decisions.length === 0 ? (
        <p className="font-mono text-[0.72rem] text-text-tertiary">
          No approved decisions yet.
        </p>
      ) : (
        <ul className="flex list-none flex-col gap-xs p-0">
          {decisions.map((decision) => (
            <DecisionRow
              key={decision.id}
              decision={decision}
              history={history}
              onSelectDiff={onSelectDiff}
              onNavigateToMessage={onNavigateToMessage}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function LivePreview({ preview }: { preview: string }): React.JSX.Element {
  return (
    <section>
      <SectionHeader>
        <SectionLabel>Live preview</SectionLabel>
        <SectionCount>what agents receive</SectionCount>
      </SectionHeader>
      <pre
        data-testid="alignment-preview"
        className="overflow-x-auto rounded-md border border-solid border-border-subtle bg-bg-base px-[8px] py-[6px] font-mono text-[0.7rem] whitespace-pre-wrap text-text-secondary"
      >
        {preview}
      </pre>
    </section>
  );
}

export default function AlignmentPanelView({
  state,
  isLoading,
  diff,
  onSelectDiff,
  onRollback,
  pendingRollbackVersion = null,
  onNavigateToMessage,
}: AlignmentPanelViewProps): React.JSX.Element {
  if (isLoading && !state) {
    return (
      <div className={surfaceClass}>
        <div className="flex flex-1 flex-col items-center justify-center gap-sm font-mono text-[0.78rem] text-text-tertiary">
          <span>Loading alignment…</span>
        </div>
      </div>
    );
  }

  if (
    !state ||
    (!state.active &&
      !state.draft &&
      state.history.length === 0 &&
      state.decisions.length === 0)
  ) {
    return <EmptyAlignment />;
  }

  return (
    <div className={surfaceClass}>
      {state.active ? (
        <ActiveCharter active={state.active} />
      ) : (
        <section>
          <SectionHeader>
            <SectionLabel>Active charter</SectionLabel>
          </SectionHeader>
          <p className="font-mono text-[0.72rem] text-text-tertiary">
            No active charter.
          </p>
        </section>
      )}

      {state.draft && <DraftSection draft={state.draft} />}

      {state.history.length > 0 && (
        <HistorySection
          history={state.history}
          activeVersion={state.active?.version ?? null}
          diff={diff}
          onSelectDiff={onSelectDiff}
          onRollback={onRollback}
          pendingRollbackVersion={pendingRollbackVersion}
        />
      )}

      <DecisionLog
        decisions={state.decisions}
        history={state.history}
        onSelectDiff={onSelectDiff}
        onNavigateToMessage={onNavigateToMessage}
      />

      {state.preview != null && <LivePreview preview={state.preview} />}
    </div>
  );
}
