"use client";

import type { CollaborationEnvelopeView } from "@/lib/api-client";

export interface CollaborationStatusCardProps {
  envelope: CollaborationEnvelopeView;
  onResumeClick?: (workflowId: string) => void;
  onSelect?: (workflowId: string) => void;
  isSelected?: boolean;
}

function getStatusAccent(status: CollaborationEnvelopeView["status"]): {
  color: string;
  icon: string;
  label: string;
} {
  switch (status) {
    case "running":
      return { color: "var(--cyan)", icon: "\u25CF", label: "Running" };
    case "paused":
      return { color: "var(--amber)", icon: "\u25A0", label: "Paused" };
    case "completed":
      return { color: "var(--green)", icon: "\u2713", label: "Completed" };
    case "failed":
      return { color: "var(--red)", icon: "\u26A0", label: "Failed" };
  }
}

function readSnapshotString(
  snapshot: unknown,
  field: string,
): string | undefined {
  if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    const value = (snapshot as Record<string, unknown>)[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readSnapshotNumber(
  snapshot: unknown,
  field: string,
): number | undefined {
  if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    const value = (snapshot as Record<string, unknown>)[field];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readArtifactId(snapshot: unknown, field: string): string | undefined {
  return readSnapshotString(snapshot, field);
}

export function CollaborationStatusCard({
  envelope,
  onResumeClick,
  onSelect,
  isSelected = false,
}: CollaborationStatusCardProps): React.JSX.Element {
  const accent = getStatusAccent(envelope.status);
  const brief = readSnapshotString(envelope.featureSnapshot, "brief");
  const rounds = readSnapshotNumber(envelope.featureSnapshot, "rounds");
  const maxIterations = readSnapshotNumber(
    envelope.featureSnapshot,
    "maxIterations",
  );
  const mergedDesignArtifactId = readArtifactId(
    envelope.featureSnapshot,
    "mergedDesignArtifactId",
  );
  const transcriptArtifactId = readArtifactId(
    envelope.featureSnapshot,
    "transcriptArtifactId",
  );
  const openQuestionsArtifactId = readArtifactId(
    envelope.featureSnapshot,
    "openQuestionsArtifactId",
  );

  const handleSelect = (): void => {
    onSelect?.(envelope.workflowId);
  };

  return (
    <article
      className={`collaboration-status-card ${
        isSelected ? "collaboration-status-card--selected" : ""
      }`}
      data-status={envelope.status}
      data-testid="collaboration-status-card"
      onClick={handleSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleSelect();
        }
      }}
    >
      <header className="collaboration-status-card-header">
        <span
          className="collaboration-status-card-icon"
          style={{ color: accent.color }}
          aria-hidden="true"
        >
          {accent.icon}
        </span>
        <span
          className="collaboration-status-card-status"
          style={{ color: accent.color }}
        >
          {accent.label}
        </span>
        <span className="collaboration-status-card-phase">
          {envelope.phase}
        </span>
      </header>

      {brief ? (
        <p className="collaboration-status-card-brief" title={brief}>
          {brief}
        </p>
      ) : null}

      <dl className="collaboration-status-card-meta">
        {rounds !== undefined ? (
          <>
            <dt>Rounds</dt>
            <dd>
              {rounds}
              {maxIterations !== undefined ? ` / ${maxIterations}` : ""}
            </dd>
          </>
        ) : null}
        <dt>Updated</dt>
        <dd>
          <time dateTime={envelope.updatedAt}>
            {new Date(envelope.updatedAt).toLocaleString()}
          </time>
        </dd>
      </dl>

      {envelope.status === "paused" && envelope.pause ? (
        <section className="collaboration-status-card-paused">
          <p className="collaboration-status-card-paused-reason">
            {envelope.pause.reason ?? "Awaiting human input before continuing."}
          </p>
          {onResumeClick ? (
            <button
              type="button"
              className="collaboration-status-card-resume-btn"
              onClick={(e) => {
                e.stopPropagation();
                onResumeClick(envelope.workflowId);
              }}
            >
              Resume
            </button>
          ) : null}
        </section>
      ) : null}

      {envelope.status === "failed" && envelope.errorSummary ? (
        <p className="collaboration-status-card-error">
          {envelope.errorSummary}
        </p>
      ) : null}

      {envelope.status === "completed" ? (
        <ul className="collaboration-status-card-artifacts">
          {mergedDesignArtifactId ? (
            <li data-artifact="merged-design">
              Merged design — {mergedDesignArtifactId}
            </li>
          ) : null}
          {transcriptArtifactId ? (
            <li data-artifact="transcript">
              Transcript — {transcriptArtifactId}
            </li>
          ) : null}
          {openQuestionsArtifactId ? (
            <li data-artifact="open-questions">
              Open questions — {openQuestionsArtifactId}
            </li>
          ) : null}
        </ul>
      ) : null}
    </article>
  );
}
