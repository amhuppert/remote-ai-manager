"use client";

import { cn } from "@/lib/ui/cn";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StatusDot, type StatusDotTone } from "@/components/ui/StatusDot";
import type { ProposalValidation } from "@/lib/chat-spawning/proposal-validator";
import type { SpawnProposal } from "@/lib/chat-spawning/schemas";
import type { DerivedSessionStatus } from "@/lib/sessions/schemas";
import SpawnCardRow from "./SpawnCardRow";
import SpawnCardEditForm from "./SpawnCardEditForm";
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
}

// Card shell; the left-border colour distinguishes valid (cyan) from invalid (amber).
const CARD_BASE =
  "flex flex-col gap-md bg-bg-surface border border-solid border-border-subtle border-l-[3px] rounded-lg p-lg my-sm font-mono";
const CARD_HEADER = "flex items-center gap-sm";
const CARD_TITLE =
  "font-mono text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-text-secondary";
const LIST_RESET = "list-none m-0 p-0 flex flex-col gap-xs";
// Below the mobile spine the action buttons grow to a 44px touch target: the row
// supplies the height from its own flex box (min-height + stretch), since a
// primitive's box height is not reattachable through layoutClassName.
const CARD_ACTIONS =
  "flex items-center justify-end gap-sm max-768:items-stretch max-768:min-h-[44px]";

function statusDotTone(status: DerivedSessionStatus): StatusDotTone {
  if (status === "running") return "cyan";
  if (status === "awaiting" || status === "waiting_for_input") return "amber";
  return "green";
}

/**
 * Inline spawn card rendered into the cockpit transcript mount. Renders a
 * validated proposal as reviewable rows with Edit + Create (multi-session
 * batch), a non-actionable invalid state, and — after creation — a passive
 * status read of the linked sessions. The card never offers controls that drive
 * a spawned session beyond its auto-dispatched first turn.
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
    <ValidSpawnCard
      proposal={props.validation.proposal}
      projectName={props.projectName}
      conversationId={props.conversationId}
      spawnedStatuses={props.spawnedStatuses}
    />
  );
}

function ValidSpawnCard({
  proposal,
  projectName,
  conversationId,
  spawnedStatuses,
}: {
  proposal: SpawnProposal;
  projectName: string;
  conversationId: string;
  spawnedStatuses: SpawnedSessionStatus[] | undefined;
}): React.JSX.Element {
  const card = useSpawnCard({ projectName, conversationId, proposal });
  const count = proposal.sessions.length;
  const createLabel = count > 1 ? `Create ${count} sessions` : "Create";
  const created = card.result?.created ?? [];
  const failed = card.result?.failed ?? [];
  const submitted = card.result !== undefined;

  return (
    <section
      className={cn(CARD_BASE, "border-l-cyan")}
      aria-label="Spawn proposal"
    >
      <header className={CARD_HEADER}>
        <span className={CARD_TITLE}>Proposed sessions</span>
        <Badge tier="count">{count}</Badge>
      </header>

      <div className="flex flex-col gap-sm">
        {card.editing
          ? card.draft.map((session, i) => (
              <SpawnCardEditForm
                key={i}
                index={i}
                session={session}
                onChange={card.updateField}
              />
            ))
          : proposal.sessions.map((proposed, i) => (
              <SpawnCardRow key={i} proposed={proposed} />
            ))}
      </div>

      {!submitted && (
        <div className={CARD_ACTIONS}>
          {card.editing ? (
            <Button variant="ghost" size="sm" onClick={card.cancelEditing}>
              Done editing
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={card.startEditing}>
              Edit
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            layoutClassName="ml-xs"
            onClick={card.submit}
            disabled={card.isPending}
          >
            {card.isPending ? "Creating…" : createLabel}
          </Button>
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
