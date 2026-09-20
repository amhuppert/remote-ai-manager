import {
  asCollaborationAgent,
  collaborationAgentsMapSchema,
  collaborationArtifactSchema,
  type CollaborationAgent,
  type CollaborationArtifact,
  type CollaborationAutonomousResolutionThreshold,
  type CollaborationResolvedAgent,
} from "@/lib/workflows/collaboration/types";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";

/**
 * One lane's display identity. The persisted `agents` entry carries the full
 * profile SNAPSHOT (instructions and rendered block included, for server-side
 * replay); only the identity fields cross into UI props, with the profile
 * reduced to its display name — and omitted entirely for the no-op Standard
 * Agent default.
 */
export interface CollabAgentDisplay {
  backend: CollaborationAgent;
  modelSelection: BackendModelSelection;
  profileName?: string;
}

export interface CollabAgentsDisplayMap {
  agent_one: CollabAgentDisplay;
  agent_two: CollabAgentDisplay;
}

function toAgentDisplay(agent: CollaborationResolvedAgent): CollabAgentDisplay {
  const profile = agent.profileSnapshot;
  const isDefaultProfile =
    profile !== undefined &&
    profile.tier === "builtin" &&
    profile.id === "standard-agent";
  return {
    backend: agent.backend,
    modelSelection: agent.modelSelection,
    ...(profile !== undefined && !isDefaultProfile
      ? { profileName: profile.name }
      : {}),
  };
}

export interface CollabEnvelopeView {
  workflowId: string;
  status: "running" | "paused" | "completed" | "failed";
  phase: string;
  featureSnapshot: unknown;
  errorSummary?: string;
}

export type CollabPassageStatus =
  | "drafting"
  | "negotiating"
  | "paused"
  | "converged"
  | "unresolved"
  | "user-stopped"
  | "failed";

export interface CollabFeatureSnapshot {
  mode: "asymmetric";
  brief: string;
  primaryAgentBackend: CollaborationAgent;
  agents?: CollabAgentsDisplayMap;
  negotiationRounds: number;
  negotiationRoundsCompleted: number;
  autonomousResolutionThreshold: CollaborationAutonomousResolutionThreshold;
  artifacts: CollaborationArtifact[];
  userAnswersByQuestionId: Record<string, string>;
}

export interface CollabPassageProps {
  workflowId: string;
  primary: CollaborationAgent;
  agents?: CollabAgentsDisplayMap;
  status: CollabPassageStatus;
  artifacts: CollaborationArtifact[];
  submittedAnswers: Record<string, string>;
  errorSummary?: string;
  /**
   * Whether a failed run may be resumed. Read off the envelope rather than
   * discovered by attempting one, so an ineligible run never offers a control
   * that would only ever 409 — and offering it is a promise, not a guess.
   */
  resumable?: boolean;
  /** What the run failed at, when it recorded a backend classification. */
  failureKind?: string;
}

const VALID_THRESHOLDS: ReadonlySet<CollaborationAutonomousResolutionThreshold> =
  new Set(["none", "minor", "major", "blocking"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseAgent(value: unknown): CollaborationAgent | null {
  const backend = agentBackendSchema.safeParse(value);
  return backend.success ? asCollaborationAgent(backend.data) : null;
}

function parseThreshold(
  value: unknown,
): CollaborationAutonomousResolutionThreshold | null {
  return typeof value === "string" &&
    VALID_THRESHOLDS.has(value as CollaborationAutonomousResolutionThreshold)
    ? (value as CollaborationAutonomousResolutionThreshold)
    : null;
}

function parseArtifacts(value: unknown): CollaborationArtifact[] {
  if (!Array.isArray(value)) return [];
  const out: CollaborationArtifact[] = [];
  for (const entry of value) {
    const parsed = collaborationArtifactSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function parseUserAnswers(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function parseCollabFeatureSnapshot(
  snapshot: unknown,
): CollabFeatureSnapshot | null {
  const record = asRecord(snapshot);
  if (!record) return null;
  if (record["mode"] !== "asymmetric") return null;
  const brief = record["brief"];
  if (typeof brief !== "string") return null;
  const primaryAgentBackend = parseAgent(record["primaryAgentBackend"]);
  if (!primaryAgentBackend) return null;
  const negotiationRounds = record["negotiationRounds"];
  if (
    typeof negotiationRounds !== "number" ||
    !Number.isFinite(negotiationRounds)
  ) {
    return null;
  }
  const negotiationRoundsCompleted = record["negotiationRoundsCompleted"];
  if (
    typeof negotiationRoundsCompleted !== "number" ||
    !Number.isFinite(negotiationRoundsCompleted)
  ) {
    return null;
  }
  const autonomousResolutionThreshold = parseThreshold(
    record["autonomousResolutionThreshold"],
  );
  if (!autonomousResolutionThreshold) return null;
  const agents = collaborationAgentsMapSchema.safeParse(record["agents"]);
  const agentsView = agents.success
    ? {
        agent_one: toAgentDisplay(agents.data.agent_one),
        agent_two: toAgentDisplay(agents.data.agent_two),
      }
    : undefined;
  return {
    mode: "asymmetric",
    brief,
    primaryAgentBackend,
    ...(agentsView !== undefined ? { agents: agentsView } : {}),
    negotiationRounds: Math.max(0, Math.floor(negotiationRounds)),
    negotiationRoundsCompleted: Math.max(
      0,
      Math.floor(negotiationRoundsCompleted),
    ),
    autonomousResolutionThreshold,
    artifacts: parseArtifacts(record["artifacts"]),
    userAnswersByQuestionId: parseUserAnswers(
      record["userAnswersByQuestionId"],
    ),
  };
}

function passageStatusFor(
  envelope: CollabEnvelopeView,
  artifacts: CollaborationArtifact[],
): CollabPassageStatus {
  if (envelope.status === "failed") return "failed";
  if (envelope.status === "paused") return "paused";
  if (envelope.status === "completed") {
    if (envelope.phase === "asymmetric_user_stopped") return "user-stopped";
    if (envelope.phase === "asymmetric_completed_final") return "converged";
    return "unresolved";
  }
  const hasNegotiationBeat = artifacts.some(
    (a) =>
      a.kind === "cross_review" ||
      a.kind === "proposed_changes" ||
      a.kind === "counter_proposal" ||
      a.kind === "resolution_decision" ||
      a.kind === "open_conflicts" ||
      a.kind === "final_answer",
  );
  return hasNegotiationBeat ? "negotiating" : "drafting";
}

export function envelopeToCollabPassageProps(
  envelope: CollabEnvelopeView,
): CollabPassageProps | null {
  const snapshot = parseCollabFeatureSnapshot(envelope.featureSnapshot);
  if (!snapshot) return null;
  return {
    workflowId: envelope.workflowId,
    primary: snapshot.primaryAgentBackend,
    ...(snapshot.agents !== undefined ? { agents: snapshot.agents } : {}),
    status: passageStatusFor(envelope, snapshot.artifacts),
    artifacts: snapshot.artifacts,
    submittedAnswers: snapshot.userAnswersByQuestionId,
    ...(envelope.errorSummary !== undefined
      ? { errorSummary: envelope.errorSummary }
      : {}),
    ...(envelope.status === "failed"
      ? { resumable: readResumable(envelope.featureSnapshot) }
      : {}),
    ...(readFailureKind(envelope.featureSnapshot) !== null
      ? { failureKind: readFailureKind(envelope.featureSnapshot)! }
      : {}),
  };
}

function snapshotRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Only an OPERATIONAL failure is worth offering a resume for. A run the agents
 * decided to fail, or one whose premises are gone, would reach the same place
 * again. An envelope written before failures were classified says nothing, and
 * silence means no offer.
 */
function readResumable(featureSnapshot: unknown): boolean {
  const snapshot = snapshotRecord(featureSnapshot);
  return snapshot?.["failureClass"] === "operational";
}

function readFailureKind(featureSnapshot: unknown): string | null {
  const cause = snapshotRecord(
    snapshotRecord(featureSnapshot)?.["failureCause"],
  );
  const kind = cause?.["kind"];
  if (kind !== "agent_call") return typeof kind === "string" ? kind : null;
  const failureKind = cause?.["failureKind"];
  return typeof failureKind === "string" ? failureKind : null;
}
