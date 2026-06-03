"use client";

import type { ProposalValidation } from "@/lib/chat-spawning/proposal-validator";
import type { SpawnProposal } from "@/lib/chat-spawning/schemas";
import type { DerivedSessionStatus } from "@/lib/sessions/schemas";
import SpawnCardRow from "./SpawnCardRow";
import SpawnCardEditForm from "./SpawnCardEditForm";
import { useSpawnCard } from "./useSpawnCard";
import "./spawn-card.css";

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

function statusDotClass(status: DerivedSessionStatus): string {
  if (status === "running") return "status-dot cyan";
  if (status === "awaiting" || status === "waiting_for_input") {
    return "status-dot amber";
  }
  return "status-dot idle";
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
        className="spawn-card spawn-card--invalid"
        aria-label="Spawn proposal"
      >
        <header className="spawn-card__header">
          <span className="spawn-card__title">Invalid spawn proposal</span>
        </header>
        <ul className="spawn-card__issues">
          {props.validation.issues.map((issue, i) => (
            <li key={i} className="spawn-card__issue">
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
    <section className="spawn-card" aria-label="Spawn proposal">
      <header className="spawn-card__header">
        <span className="spawn-card__title">Proposed sessions</span>
        <span className="cc-badge cc-badge--count spawn-card__count">
          {count}
        </span>
      </header>

      <div className="spawn-card__rows">
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
        <div className="spawn-card__actions">
          {card.editing ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={card.cancelEditing}
            >
              Done editing
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={card.startEditing}
            >
              Edit
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm spawn-card__create"
            onClick={card.submit}
            disabled={card.isPending}
          >
            {card.isPending ? "Creating…" : createLabel}
          </button>
        </div>
      )}

      {submitted && (
        <div className="spawn-card__result">
          {created.length > 0 && (
            <ul className="spawn-card__created">
              {created.map((c) => {
                const live = spawnedStatuses?.find(
                  (s) => s.sessionName === c.sessionName,
                );
                return (
                  <li key={c.sessionName} className="spawn-card__created-row">
                    <span
                      className={
                        live
                          ? statusDotClass(live.derivedStatus)
                          : "status-dot idle"
                      }
                      aria-hidden
                    />
                    <span className="spawn-card__created-name">{c.name}</span>
                    <span className="spawn-card__created-status">
                      {live ? live.derivedStatus : "created"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {failed.length > 0 && (
            <ul className="spawn-card__failed">
              {failed.map((f) => (
                <li key={f.name} className="spawn-card__failed-row">
                  <span className="spawn-card__failed-name">{f.name}</span>
                  <span className="spawn-card__failed-error">{f.error}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {card.isError && (
        <div className="spawn-card__error" role="alert">
          Failed to create sessions. Try again.
        </div>
      )}
    </section>
  );
}
