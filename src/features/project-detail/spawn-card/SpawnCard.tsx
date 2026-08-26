"use client";

import { useMemo, useRef } from "react";
import { cn } from "@/lib/ui/cn";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StatusDot, type StatusDotTone } from "@/components/ui/StatusDot";
import {
  useBranchPrefixQuery,
  useSessionsQuery,
} from "@/lib/sessions/list-queries";
import type { ProposalValidation } from "@/lib/chat-spawning/proposal-validator";
import type { SpawnProposal } from "@/lib/chat-spawning/schemas";
import type { DerivedSessionStatus } from "@/lib/sessions/schemas";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import SpawnCardRow, { type SpawnCardRowHandle } from "./SpawnCardRow";
import { useSpawnCard } from "./useSpawnCard";

export interface SpawnedSessionStatus {
  sessionName: string;
  derivedStatus: DerivedSessionStatus;
}

export interface SpawnCardProps {
  validation: ProposalValidation;
  projectName: string;
  conversationId: string;
  /**
   * Live status of the linked spawned sessions, supplied by the transcript host
   * from the existing sessions signal (SSE-fresh). Passive: the card only
   * reflects status, it never drives the sessions.
   */
  spawnedStatuses?: SpawnedSessionStatus[];
  backendDefaults: BackendSelectionDefaultsById;
}

// Card shell; the left-border colour distinguishes valid (cyan) from invalid (amber).
const CARD_BASE =
  "flex flex-col gap-md bg-bg-surface border border-solid border-border-subtle border-l-[3px] rounded-lg p-lg my-sm font-mono";
const CARD_HEADER = "flex items-center gap-sm";
const CARD_TITLE =
  "font-mono text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-text-secondary";
const CARD_SUBTITLE = "m-0 font-body text-[0.72rem] text-text-tertiary";
const LIST_RESET = "list-none m-0 p-0 flex flex-col gap-xs";
// Below the mobile spine the action buttons grow to a 44px touch target: the row
// supplies the height from its own flex box (min-height + stretch), since a
// primitive's box height is not reattachable through layoutClassName.
const CARD_ACTIONS =
  "flex items-center gap-sm max-768:flex-wrap max-768:items-stretch max-768:min-h-[44px]";

function statusDotTone(status: DerivedSessionStatus): StatusDotTone {
  if (status === "running") return "cyan";
  if (status === "awaiting" || status === "waiting_for_input") return "amber";
  return "green";
}

/**
 * Branch names eligible as merge targets: every *non-archived* session's branch.
 * Archived sessions are excluded — their branches are no longer live merge
 * destinations, so they must not appear in the "merges into" dropdown.
 */
export function eligibleTargetBranches(
  sessions: { branchName: string; archived: boolean }[],
): string[] {
  return sessions.filter((s) => !s.archived).map((s) => s.branchName);
}

/** Merge target choices: `main`, every eligible project branch, and any target the proposal already names. */
function deriveTargetOptions(
  sessionBranches: string[],
  proposalTargets: string[],
): string[] {
  const options = new Set<string>(["main"]);
  for (const branch of sessionBranches) options.add(branch);
  for (const target of proposalTargets) options.add(target);
  return Array.from(options);
}

/**
 * Inline spawn card rendered into the cockpit transcript mount. Renders a
 * validated proposal as reviewable rows with a per-session include toggle, an
 * always-editable agent/mode, an Edit pass for name/target/prompt, and Create
 * (multi-session batch); a non-actionable invalid state; and — after creation —
 * a passive status read of the linked sessions. The card never offers controls
 * that drive a spawned session beyond its auto-dispatched first turn.
 */
export default function SpawnCard(props: SpawnCardProps): React.JSX.Element {
  if (props.validation.kind === "invalid") {
    return (
      <section
        className={cn(CARD_BASE, "border-l-amber")}
        aria-label="Spawn proposal"
      >
        <header className={CARD_HEADER}>
          <span className={CARD_TITLE}>Invalid spawn proposal</span>
        </header>
        <ul className={LIST_RESET}>
          {props.validation.issues.map((issue, i) => (
            <li key={i} className="text-[0.75rem] text-amber">
              {issue}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <ConnectedSpawnCard
      proposal={props.validation.proposal}
      projectName={props.projectName}
      conversationId={props.conversationId}
      spawnedStatuses={props.spawnedStatuses}
      backendDefaults={props.backendDefaults}
    />
  );
}

/**
 * Fetching wrapper: resolves the project's effective branch prefix and merge
 * target options from server state, then hands them to the presentational card.
 * Both degrade gracefully — an unresolved prefix shows the bare slug; missing
 * sessions just narrow the target list to `main` plus the proposal's own
 * targets — so the card is always actionable.
 */
function ConnectedSpawnCard({
  proposal,
  projectName,
  conversationId,
  spawnedStatuses,
  backendDefaults,
}: {
  proposal: SpawnProposal;
  projectName: string;
  conversationId: string;
  spawnedStatuses: SpawnedSessionStatus[] | undefined;
  backendDefaults: BackendSelectionDefaultsById;
}): React.JSX.Element {
  const sessionsQuery = useSessionsQuery(projectName);
  const branchPrefixQuery = useBranchPrefixQuery(projectName);

  const targetOptions = useMemo(
    () =>
      deriveTargetOptions(
        eligibleTargetBranches(sessionsQuery.data ?? []),
        proposal.sessions.map((s) => s.target),
      ),
    [sessionsQuery.data, proposal.sessions],
  );

  return (
    <ValidSpawnCard
      proposal={proposal}
      projectName={projectName}
      conversationId={conversationId}
      spawnedStatuses={spawnedStatuses}
      branchPrefix={branchPrefixQuery.data}
      targetOptions={targetOptions}
      backendDefaults={backendDefaults}
    />
  );
}

/**
 * Presentational valid-proposal card. Takes the resolved `branchPrefix` and
 * `targetOptions` as props (no data fetching) so it renders deterministically in
 * Storybook and unit tests.
 */
export function ValidSpawnCard({
  proposal,
  projectName,
  conversationId,
  spawnedStatuses,
  branchPrefix,
  targetOptions,
  backendDefaults,
}: {
  proposal: SpawnProposal;
  projectName: string;
  conversationId: string;
  spawnedStatuses: SpawnedSessionStatus[] | undefined;
  branchPrefix: string | undefined;
  targetOptions: string[];
  backendDefaults: BackendSelectionDefaultsById;
}): React.JSX.Element {
  const card = useSpawnCard({
    projectName,
    conversationId,
    proposal,
    backendDefaults,
  });
  const count = proposal.sessions.length;
  const n = card.includedCount;
  const createLabel = `Create ${n} session${n === 1 ? "" : "s"}`;
  const created = card.result?.created ?? [];
  const failed = card.result?.failed ?? [];
  const submitted = card.result !== undefined;
  const rowRefs = useRef<Array<SpawnCardRowHandle | null>>([]);
  const handleCreate = () => {
    const voiceRow = rowRefs.current.find((row) => row?.isVoiceBusy());
    if (voiceRow) {
      voiceRow.primaryAction();
      return;
    }
    card.submit();
  };

  return (
    <section
      className={cn(CARD_BASE, "border-l-cyan")}
      aria-label="Spawn proposal"
    >
      <div className="flex flex-col gap-2xs">
        <header className={CARD_HEADER}>
          <span className={CARD_TITLE}>Proposed sessions</span>
          <Badge tier="count">{count}</Badge>
        </header>
        <p className={CARD_SUBTITLE}>
          Toggle which to create · each branch is auto-named from its session
          name.
        </p>
      </div>

      <div className="flex flex-col gap-sm">
        {card.draft.map((session, i) => (
          <SpawnCardRow
            ref={(node) => {
              rowRefs.current[i] = node;
            }}
            key={i}
            projectName={projectName}
            index={i}
            session={session}
            editing={card.editing}
            branchPrefix={branchPrefix}
            targetOptions={targetOptions}
            expanded={!!card.expanded[i]}
            onFieldChange={card.updateField}
            onModelSelectionChange={card.setModelSelection}
            onIncludedChange={card.setIncluded}
            onImagesChange={card.setImages}
            onDocumentChange={card.setPromptDocument}
            onPrimaryAction={(document) =>
              card.submitPromptDocument(i, document)
            }
            onToggleExpanded={card.toggleExpanded}
          />
        ))}
      </div>

      {!submitted && (
        <div className={CARD_ACTIONS}>
          <span className="font-mono text-[0.7rem] text-text-tertiary">
            {n} of {count} selected
          </span>
          <div className="ml-auto flex items-center gap-sm">
            <Button variant="ghost" size="sm" onClick={card.toggleEditing}>
              {card.editing ? "Done" : "Edit"}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleCreate}
              disabled={card.isPending || n === 0}
            >
              {card.isPending ? "Creating…" : createLabel}
            </Button>
          </div>
        </div>
      )}

      {submitted && (
        <div className="flex flex-col gap-sm">
          {created.length > 0 && (
            <ul className={LIST_RESET}>
              {created.map((c) => {
                const live = spawnedStatuses?.find(
                  (s) => s.sessionName === c.sessionName,
                );
                return (
                  <li
                    key={c.sessionName}
                    className="flex items-center gap-sm text-[0.75rem]"
                  >
                    <StatusDot
                      tone={live ? statusDotTone(live.derivedStatus) : "green"}
                      aria-hidden
                    />
                    <span className="text-text-primary">{c.name}</span>
                    <span className="font-mono text-[0.7rem] text-text-tertiary">
                      ⎇ {c.branchName}
                    </span>
                    <span className="ml-auto text-[0.7rem] tracking-[0.04em] text-text-tertiary uppercase">
                      {live ? live.derivedStatus : "created"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {failed.length > 0 && (
            <ul className={LIST_RESET}>
              {failed.map((f) => (
                <li
                  key={f.name}
                  className="flex items-center gap-sm text-[0.75rem]"
                >
                  <span className="text-text-primary">{f.name}</span>
                  <span className="text-red">{f.error}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {card.isError && (
        <div className="text-[0.75rem] text-red" role="alert">
          Failed to create sessions. Try again.
        </div>
      )}
    </section>
  );
}
