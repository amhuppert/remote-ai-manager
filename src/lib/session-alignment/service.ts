import { randomUUID } from "node:crypto";

import { createLogger } from "@/lib/logging";
import { broadcastEvent } from "@/lib/events/broadcast-event";
import type { BroadcastFn } from "@/lib/events/broadcaster";

import type { SessionAlignmentRepo } from "./repo";
import type { CharterMirrorInput, CharterMirrorWriteResult } from "./mirror";
import type { AlignmentInjection, RenderAlignmentInput } from "./render";
import {
  alignmentDecisionSchema,
  alignmentDiffSchema,
  alignmentStateSchema,
  alignmentVersionSchema,
  decisionProposalSchema,
  sessionAlignmentUpdatedEventSchema,
  type AlignmentDecision,
  type AlignmentDiff,
  type AlignmentState,
  type AlignmentVersion,
  type AlignmentVersionSource,
  type DecisionProposal,
  type SessionAlignmentUpdatedEvent,
} from "./schemas";

const logger = createLogger("session-alignment.service");

// ============================================================
// Method inputs (trusted internal callers; `parse` at the boundary)
// ============================================================

export interface BeginDraftInput {
  projectPath: string;
  sessionName: string;
  /** The conversation that ran `/align`; recorded as the draft's author. */
  conversationId: string;
  /** Optional free-text guidance the user typed after `/align`, steering the charter. */
  guidance?: string;
}

export interface FillDraftInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  content: string;
}

export interface ApproveDraftInput {
  projectPath: string;
  sessionName: string;
  draftId: string;
  approver?: string;
}

export interface RejectDraftInput {
  projectPath: string;
  sessionName: string;
  draftId: string;
}

/** A single agent-proposed decision (pre-approval, free text). */
export interface ProposedDecisionInput {
  statement: string;
  rationale?: string;
  context?: string;
}

export interface ProposeDecisionsInput {
  projectPath: string;
  sessionName: string;
  /** The conversation whose agent proposed the batch; receives the routed reply. */
  conversationId: string;
  decisions: ProposedDecisionInput[];
  /** The agent message the proposal originated from, for decision-log back-links. */
  originMessageId?: string | null;
}

/** Per-decision resolution: approve, or reject with optional feedback. */
export interface DecisionResolutionInput {
  proposalId: string;
  approve: boolean;
  feedback?: string;
}

export interface ResolveProposalsInput {
  projectPath: string;
  sessionName: string;
  batchId: string;
  resolutions: DecisionResolutionInput[];
  approver?: string;
}

export interface RollbackInput {
  projectPath: string;
  sessionName: string;
  /** The prior activated version number whose content is cloned forward. */
  version: number;
  approver?: string;
  /** Optional conversation recorded as the rollback's author. */
  conversationId?: string | null;
}

export interface CopyActiveCharterInput {
  projectPath: string;
  /** The parent session whose active charter is copied. */
  sourceSessionName: string;
  /** The freshly-forked session that inherits the charter. */
  targetSessionName: string;
}

export type FillDraftResult =
  | { status: "draft_ready"; version: null }
  | { status: "activated"; version: number };

export interface SessionAlignmentService {
  /** The charter draft lifecycle: begin a draft, fill it, and approve or reject it. */
  beginDraft(
    input: BeginDraftInput,
  ): Promise<{ authoringPrompt: string; draftId: string }>;
  fillDraft(input: FillDraftInput): Promise<FillDraftResult>;
  approveDraft(input: ApproveDraftInput): Promise<AlignmentVersion>;
  rejectDraft(input: RejectDraftInput): Promise<void>;

  /** Persist a durable, non-blocking bulk proposal batch (never logged here). */
  proposeDecisions(input: ProposeDecisionsInput): Promise<{ batchId: string }>;
  /**
   * Resolve a pending batch per-decision: log the approved, discard the rest,
   * and (if any approved) open an auto-activating draft linked to them and route
   * an incorporation turn; route a feedback turn for any reject-with-feedback.
   */
  resolveProposals(
    input: ResolveProposalsInput,
  ): Promise<{ approved: number; rejected: number }>;

  /** Aggregate alignment state for the session's UI surfaces. */
  getState(projectPath: string, sessionName: string): Promise<AlignmentState>;
  /** Cheap active-version-number accessor for the per-turn recreate gate. */
  getActiveVersion(
    projectPath: string,
    sessionName: string,
  ): Promise<number | null>;
  /** The governing injection for the active charter (null when none). */
  getActiveInjection(
    projectPath: string,
    sessionName: string,
  ): Promise<AlignmentInjection | null>;
  /** Per-version content diff between two activated versions. */
  diff(
    projectPath: string,
    sessionName: string,
    from: number,
    to: number,
  ): Promise<AlignmentDiff>;
  /** Roll back to a prior version: a new active version cloned from its content. */
  rollback(input: RollbackInput): Promise<AlignmentVersion>;
  /**
   * Seed a freshly-forked normal session's active charter by copying the parent
   * session's active charter. No-op (returns null) when the parent has no active
   * charter or the target already has one. Inserts an immediately-active version
   * (no human gate), writes the worktree mirror, and broadcasts. The target must
   * be a normal session; throws {@link AlignmentNotSupportedError} otherwise.
   */
  copyActiveCharter(
    input: CopyActiveCharterInput,
  ): Promise<AlignmentVersion | null>;
}

// ============================================================
// Injected dependencies (method syntax → bivariant params)
// ============================================================

/** The render surface (2.2) the service composes for authoring prompts/hashes. */
export interface SessionAlignmentRenderDeps {
  renderAlignmentPromptSection(input: RenderAlignmentInput): string;
  computeAlignmentHash(content: string): string;
  /** The soft-scaffold template seeded into a first-charter authoring prompt. */
  scaffoldTemplate: string;
}

/** The mirror writer surface (3.1) — only `write` is needed by activation. */
export interface SessionAlignmentMirrorDeps {
  write(input: CharterMirrorInput): Promise<CharterMirrorWriteResult>;
}

/** Recorded mirror call shape; exported so tests can assert materialization. */
export type CharterMirrorCall = CharterMirrorInput;

/** Minimal session metadata the service reads to guard ops and locate the mirror. */
export interface SessionAlignmentSessionInfo {
  worktreePath: string;
  creationMode: "normal" | "optimistic";
}

/**
 * Prompt-queue seam for routing incorporation/feedback messages and authoring
 * turns back into the originating conversation. Not used by the draft lifecycle.
 */
export interface SessionAlignmentPromptQueueDeps {
  enqueue(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    message: string;
  }): Promise<void>;
}

export interface SessionAlignmentServiceDeps {
  repo: SessionAlignmentRepo;
  render: SessionAlignmentRenderDeps;
  mirror: SessionAlignmentMirrorDeps;
  /** Best-effort SSE broadcaster; failures are swallowed + logged, never thrown. */
  broadcast: BroadcastFn;
  promptQueue: SessionAlignmentPromptQueueDeps;
  /** Loads the session's mode + worktree; null when the session does not exist. */
  loadSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionAlignmentSessionInfo | null>;
  /** Injected clock + id source for deterministic tests. */
  now?: () => string;
  newId?: () => string;
}

// ============================================================
// Errors
// ============================================================

export class AlignmentNotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlignmentNotSupportedError";
  }
}

export class AlignmentDraftNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlignmentDraftNotFoundError";
  }
}

export class AlignmentProposalBatchNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlignmentProposalBatchNotFoundError";
  }
}

export class AlignmentVersionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlignmentVersionNotFoundError";
  }
}

// ============================================================
// Factory
// ============================================================

export function createSessionAlignmentService(
  deps: SessionAlignmentServiceDeps,
): SessionAlignmentService {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => randomUUID());

  async function requireNormalSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionAlignmentSessionInfo> {
    const session = await deps.loadSession(projectPath, sessionName);
    if (!session) {
      throw new AlignmentNotSupportedError(
        `session not found: ${projectPath}::${sessionName}`,
      );
    }
    if (session.creationMode !== "normal") {
      throw new AlignmentNotSupportedError(
        `alignment is unavailable for ${session.creationMode} sessions`,
      );
    }
    return session;
  }

  function requireVersion(
    projectPath: string,
    sessionName: string,
    version: number,
  ): AlignmentVersion {
    const found = deps.repo.findVersionByNumber(
      projectPath,
      sessionName,
      version,
    );
    if (!found) {
      throw new AlignmentVersionNotFoundError(
        `alignment version ${version} not found for ${projectPath}::${sessionName}`,
      );
    }
    return found;
  }

  function broadcast(
    event: SessionAlignmentUpdatedEvent,
    context: Record<string, unknown>,
  ): void {
    broadcastEvent({
      broadcast: deps.broadcast,
      build: () => sessionAlignmentUpdatedEventSchema.parse(event),
      logger,
      failureEvent: "align.broadcast_failure",
      context,
    });
  }

  /**
   * Transactionally supersede the prior active row (if any), assign the next
   * monotonic version number, and flip the draft to `active`. Returns the
   * persisted active version. Mirror + broadcast happen by the caller AFTER the
   * transaction so a mirror/SSE failure never rolls back the activation.
   */
  function activateInTransaction(
    projectPath: string,
    sessionName: string,
    draft: AlignmentVersion,
    approver: string | null,
  ): AlignmentVersion {
    return deps.repo.transaction(() => {
      const prior = deps.repo.findActiveVersion(projectPath, sessionName);
      const nextVersion = (prior?.version ?? 0) + 1;

      if (prior) {
        deps.repo.updateVersion(projectPath, sessionName, {
          ...prior,
          status: "superseded",
        });
      }

      const activated: AlignmentVersion = alignmentVersionSchema.parse({
        ...draft,
        version: nextVersion,
        status: "active",
        activatedAt: now(),
        approver,
      });
      deps.repo.updateVersion(projectPath, sessionName, activated);

      // Stamp each linked decision with the version its incorporation produced;
      // empty for `/align` and rollback drafts (no-op).
      for (const decisionId of activated.linkedDecisionIds) {
        deps.repo.setDecisionProducedVersion(
          projectPath,
          sessionName,
          decisionId,
          nextVersion,
        );
      }
      return activated;
    });
  }

  /**
   * Post-commit publication shared by every path that makes a version active:
   * best-effort worktree mirror (a failure must NOT fail activation, R8.3) and
   * the `session-alignment-updated` broadcast. The version is already persisted
   * and consumed any open draft, so `hasDraft` is always false here.
   */
  async function publishActivation(
    projectPath: string,
    sessionName: string,
    worktreePath: string,
    activated: AlignmentVersion,
  ): Promise<void> {
    const mirrorResult = await deps.mirror.write({
      projectPath,
      sessionName,
      worktreePath,
      content: activated.content,
    });
    if (!mirrorResult.ok) {
      logger.warn("align.mirror_write_failure", {
        projectPath,
        sessionName,
        version: activated.version,
      });
    }

    broadcast(
      {
        type: "session-alignment-updated",
        projectPath,
        sessionName,
        activeVersion: activated.version,
        hasDraft: false,
        pendingProposalBatchIds: deps.repo
          .findPendingProposalBatches(projectPath, sessionName)
          .map((batch) => batch.batchId),
      },
      { projectPath, sessionName, version: activated.version },
    );
  }

  async function activate(
    projectPath: string,
    sessionName: string,
    worktreePath: string,
    draft: AlignmentVersion,
    approver: string | null,
  ): Promise<AlignmentVersion> {
    const activated = activateInTransaction(
      projectPath,
      sessionName,
      draft,
      approver,
    );

    logger.info("align.activate", {
      projectPath,
      sessionName,
      version: activated.version,
      conversationId: activated.authorConversationId,
    });

    await publishActivation(projectPath, sessionName, worktreePath, activated);

    return activated;
  }

  return {
    async beginDraft(input) {
      const { projectPath, sessionName, conversationId } = input;
      await requireNormalSession(projectPath, sessionName);

      const active = deps.repo.findActiveVersion(projectPath, sessionName);
      const source: AlignmentVersionSource = active
        ? "align_rerun"
        : "align_initial";
      const authoringBody = active
        ? active.content
        : deps.render.scaffoldTemplate;
      const authoringPrompt = composeAuthoringPrompt(
        source,
        authoringBody,
        input.guidance ?? "",
      );

      // ≤1 draft per session: replace any open draft (last-writer-wins).
      const openDraft = deps.repo.findDraftVersion(projectPath, sessionName);
      const draftId = newId();
      const timestamp = now();
      const draft: AlignmentVersion = alignmentVersionSchema.parse({
        id: draftId,
        version: null,
        content: "",
        contentHash: "",
        status: "draft",
        source,
        authorConversationId: conversationId,
        autoActivate: false,
        linkedDecisionIds: [],
        createdAt: timestamp,
        activatedAt: null,
        approver: null,
      });

      deps.repo.transaction(() => {
        if (openDraft) {
          deps.repo.deleteVersionById(projectPath, sessionName, openDraft.id);
        }
        deps.repo.insertVersion(projectPath, sessionName, draft);
      });

      logger.info("align.begin_draft", {
        projectPath,
        sessionName,
        version: active?.version ?? null,
        conversationId,
        source,
        draftId,
      });

      return { authoringPrompt, draftId };
    },

    async fillDraft(input) {
      const { projectPath, sessionName, conversationId, content } = input;
      const session = await requireNormalSession(projectPath, sessionName);

      const draft = deps.repo.findDraftVersion(projectPath, sessionName);
      if (!draft) {
        throw new AlignmentDraftNotFoundError(
          `no open draft to fill for ${projectPath}::${sessionName}`,
        );
      }

      const filled: AlignmentVersion = alignmentVersionSchema.parse({
        ...draft,
        content,
        contentHash: deps.render.computeAlignmentHash(content),
        authorConversationId: conversationId,
      });
      deps.repo.updateVersion(projectPath, sessionName, filled);

      logger.info("align.fill_draft", {
        projectPath,
        sessionName,
        version: null,
        conversationId,
        autoActivate: filled.autoActivate,
      });

      // `/align` drafts never set `autoActivate`, so the human Approve-Charter
      // gate runs below; decision-origin drafts do, and activate on fill.
      if (filled.autoActivate) {
        const activated = await activate(
          projectPath,
          sessionName,
          session.worktreePath,
          filled,
          null,
        );
        if (activated.version === null) {
          throw new Error("activation did not assign a version number");
        }
        return { status: "activated", version: activated.version };
      }

      return { status: "draft_ready", version: null };
    },

    async approveDraft(input) {
      const { projectPath, sessionName, draftId } = input;
      const session = await requireNormalSession(projectPath, sessionName);

      const draft = deps.repo.findDraftVersion(projectPath, sessionName);
      if (!draft || draft.id !== draftId) {
        throw new AlignmentDraftNotFoundError(
          `no open draft ${draftId} to approve for ${projectPath}::${sessionName}`,
        );
      }

      return activate(
        projectPath,
        sessionName,
        session.worktreePath,
        draft,
        input.approver ?? null,
      );
    },

    async rejectDraft(input) {
      const { projectPath, sessionName, draftId } = input;
      await requireNormalSession(projectPath, sessionName);

      const draft = deps.repo.findDraftVersion(projectPath, sessionName);
      if (!draft || draft.id !== draftId) {
        throw new AlignmentDraftNotFoundError(
          `no open draft ${draftId} to reject for ${projectPath}::${sessionName}`,
        );
      }

      // Discard only; the active charter is untouched and no event fires.
      deps.repo.deleteVersionById(projectPath, sessionName, draftId);

      logger.info("align.reject_draft", {
        projectPath,
        sessionName,
        version: null,
        conversationId: draft.authorConversationId,
        draftId,
      });
    },

    async proposeDecisions(input) {
      const { projectPath, sessionName, conversationId } = input;
      await requireNormalSession(projectPath, sessionName);

      const batchId = newId();
      const createdAt = now();
      const proposals: DecisionProposal[] = input.decisions.map((decision) =>
        decisionProposalSchema.parse({
          id: newId(),
          projectPath,
          sessionName,
          conversationId,
          batchId,
          statement: decision.statement,
          rationale: decision.rationale ?? null,
          context: decision.context ?? null,
          originMessageId: input.originMessageId ?? null,
          createdAt,
        }),
      );
      deps.repo.insertProposals(proposals);

      logger.info("align.decision_propose", {
        projectPath,
        sessionName,
        conversationId,
        batchId,
        count: proposals.length,
      });

      return { batchId };
    },

    async resolveProposals(input) {
      const { projectPath, sessionName, batchId, resolutions } = input;
      await requireNormalSession(projectPath, sessionName);

      const proposals = deps.repo.findProposalsByBatch(
        projectPath,
        sessionName,
        batchId,
      );
      if (proposals.length === 0) {
        throw new AlignmentProposalBatchNotFoundError(
          `no pending proposal batch ${batchId} for ${projectPath}::${sessionName}`,
        );
      }

      const resolutionByProposalId = new Map(
        resolutions.map((resolution) => [resolution.proposalId, resolution]),
      );
      const proposalIds = new Set(proposals.map((proposal) => proposal.id));
      for (const resolution of resolutions) {
        if (!proposalIds.has(resolution.proposalId)) {
          throw new AlignmentProposalBatchNotFoundError(
            `resolution references proposal ${resolution.proposalId} outside batch ${batchId}`,
          );
        }
      }

      // All proposals in a batch share the conversation that proposed them; the
      // incorporation/feedback turn routes back there (R5.5, R5.6).
      const originConversationId = proposals[0]!.conversationId;

      const approvedDecisions: AlignmentDecision[] = [];
      const feedbackNotes: { statement: string; feedback: string }[] = [];
      for (const proposal of proposals) {
        const resolution = resolutionByProposalId.get(proposal.id);
        if (resolution?.approve) {
          approvedDecisions.push(
            alignmentDecisionSchema.parse({
              id: newId(),
              statement: proposal.statement,
              rationale: proposal.rationale,
              originConversationId: proposal.conversationId,
              originMessageId: proposal.originMessageId,
              producedVersion: null,
              approver: input.approver ?? null,
              approvedAt: now(),
              createdAt: now(),
            }),
          );
        } else if (resolution && resolution.feedback) {
          feedbackNotes.push({
            statement: proposal.statement,
            feedback: resolution.feedback,
          });
        }
      }

      const approvedCount = approvedDecisions.length;
      const rejectedCount = proposals.length - approvedCount;

      // One transaction: append approved decisions, open the auto-activate draft
      // linked to them (last-writer-wins vs any open draft), and consume the
      // batch. No broadcast here — only the later activation broadcasts (R11).
      deps.repo.transaction(() => {
        for (const decision of approvedDecisions) {
          deps.repo.appendDecision(projectPath, sessionName, decision);
        }
        if (approvedCount > 0) {
          const openDraft = deps.repo.findDraftVersion(
            projectPath,
            sessionName,
          );
          if (openDraft) {
            deps.repo.deleteVersionById(projectPath, sessionName, openDraft.id);
          }
          const draft: AlignmentVersion = alignmentVersionSchema.parse({
            id: newId(),
            version: null,
            content: "",
            contentHash: "",
            status: "draft",
            source: "decision",
            authorConversationId: originConversationId,
            autoActivate: true,
            linkedDecisionIds: approvedDecisions.map((decision) => decision.id),
            createdAt: now(),
            activatedAt: null,
            approver: null,
          });
          deps.repo.insertVersion(projectPath, sessionName, draft);
        }
        deps.repo.deleteProposalsByBatch(projectPath, sessionName, batchId);
      });

      // Route turns back into the originating conversation after the commit.
      if (approvedCount > 0) {
        const active = deps.repo.findActiveVersion(projectPath, sessionName);
        await deps.promptQueue.enqueue({
          projectPath,
          sessionName,
          conversationId: originConversationId,
          message: composeIncorporationMessage(
            approvedDecisions,
            active?.content ?? null,
          ),
        });
      }
      if (feedbackNotes.length > 0) {
        await deps.promptQueue.enqueue({
          projectPath,
          sessionName,
          conversationId: originConversationId,
          message: composeFeedbackMessage(feedbackNotes),
        });
      }

      logger.info("align.decision_resolve", {
        projectPath,
        sessionName,
        conversationId: originConversationId,
        version: null,
        batchId,
        approved: approvedCount,
        rejected: rejectedCount,
      });

      return { approved: approvedCount, rejected: rejectedCount };
    },

    async getState(projectPath, sessionName) {
      const active = deps.repo.findActiveVersion(projectPath, sessionName);
      return alignmentStateSchema.parse({
        active,
        draft: deps.repo.findDraftVersion(projectPath, sessionName),
        history: deps.repo.findVersionHistory(projectPath, sessionName),
        decisions: deps.repo.findDecisionsReverseChron(
          projectPath,
          sessionName,
        ),
        pendingProposals: deps.repo.findPendingProposalBatches(
          projectPath,
          sessionName,
        ),
        preview: active
          ? deps.render.renderAlignmentPromptSection({
              content: active.content,
            })
          : null,
      });
    },

    getActiveVersion(projectPath, sessionName) {
      return Promise.resolve(
        deps.repo.findActiveVersionNumber(projectPath, sessionName),
      );
    },

    getActiveInjection(projectPath, sessionName) {
      const active = deps.repo.findActiveVersion(projectPath, sessionName);
      if (!active || active.version === null) {
        return Promise.resolve(null);
      }
      const injection: AlignmentInjection = {
        version: active.version,
        contentHash: active.contentHash,
        text: deps.render.renderAlignmentPromptSection({
          content: active.content,
        }),
      };
      return Promise.resolve(injection);
    },

    async diff(projectPath, sessionName, from, to) {
      const fromVersion = requireVersion(projectPath, sessionName, from);
      const toVersion = requireVersion(projectPath, sessionName, to);
      return alignmentDiffSchema.parse({
        from,
        to,
        fromContent: fromVersion.content,
        toContent: toVersion.content,
      });
    },

    async rollback(input) {
      const { projectPath, sessionName, version } = input;
      const session = await requireNormalSession(projectPath, sessionName);
      const target = requireVersion(projectPath, sessionName, version);

      // Clone the target content into a fresh draft, then activate it. The
      // target row is untouched and stays reviewable; the rollback is a new
      // version rather than a mutation of history (R8.5).
      const clone: AlignmentVersion = alignmentVersionSchema.parse({
        id: newId(),
        version: null,
        content: target.content,
        contentHash: target.contentHash,
        status: "draft",
        source: "rollback",
        authorConversationId: input.conversationId ?? null,
        autoActivate: false,
        linkedDecisionIds: [],
        createdAt: now(),
        activatedAt: null,
        approver: null,
      });
      deps.repo.transaction(() => {
        const openDraft = deps.repo.findDraftVersion(projectPath, sessionName);
        if (openDraft) {
          deps.repo.deleteVersionById(projectPath, sessionName, openDraft.id);
        }
        deps.repo.insertVersion(projectPath, sessionName, clone);
      });

      logger.info("align.rollback", {
        projectPath,
        sessionName,
        version: target.version,
        conversationId: input.conversationId ?? null,
      });

      return activate(
        projectPath,
        sessionName,
        session.worktreePath,
        clone,
        input.approver ?? null,
      );
    },

    async copyActiveCharter(input) {
      const { projectPath, sourceSessionName, targetSessionName } = input;
      const target = await requireNormalSession(projectPath, targetSessionName);

      const sourceActive = deps.repo.findActiveVersion(
        projectPath,
        sourceSessionName,
      );
      if (!sourceActive) {
        logger.info("align.copy_charter_skipped", {
          projectPath,
          sourceSessionName,
          targetSessionName,
          reason: "no_active_source",
        });
        return null;
      }

      // A freshly-forked session has no charter; this guard keeps the copy
      // idempotent and refuses to clobber a target that already governs.
      if (deps.repo.findActiveVersion(projectPath, targetSessionName)) {
        logger.info("align.copy_charter_skipped", {
          projectPath,
          sourceSessionName,
          targetSessionName,
          reason: "target_has_active",
        });
        return null;
      }

      // Byte-identical clone of the parent's content (its hash is, by
      // definition, the hash of that content), activated immediately with no
      // human gate and `forked` provenance.
      const copied: AlignmentVersion = alignmentVersionSchema.parse({
        id: newId(),
        version: 1,
        content: sourceActive.content,
        contentHash: sourceActive.contentHash,
        status: "active",
        source: "forked",
        authorConversationId: null,
        autoActivate: false,
        linkedDecisionIds: [],
        createdAt: now(),
        activatedAt: now(),
        approver: null,
      });
      deps.repo.insertVersion(projectPath, targetSessionName, copied);

      logger.info("align.copy_charter", {
        projectPath,
        sourceSessionName,
        targetSessionName,
        version: copied.version,
      });

      await publishActivation(
        projectPath,
        targetSessionName,
        target.worktreePath,
        copied,
      );

      return copied;
    },
  };
}

/**
 * Compose the agent authoring turn body: a first charter seeds the soft scaffold
 * and instructs population from the conversation (R3.2); a rerun provides the
 * existing charter to rewrite from without overwriting it (R3.4). Optional
 * `guidance` is the free text the user typed after `/align`; when present it is
 * surfaced as an explicit instruction so the agent weights it while authoring.
 */
function composeAuthoringPrompt(
  source: AlignmentVersionSource,
  body: string,
  guidance: string,
): string {
  const guidanceLines =
    guidance !== "" ? ["", `User guidance for the charter: ${guidance}`] : [];

  if (source === "align_rerun") {
    return [
      "Rewrite the session's Alignment charter from the conversation so far.",
      "Here is the current charter to revise (do not start from scratch unless the conversation calls for it):",
      "",
      body,
      ...guidanceLines,
      "",
      'When the revised charter is ready, save it to a JSON file (`{ "content": "<charter markdown>" }`) and submit it with `cctl charter write --file <file>.json`. The result is a draft pending the user\'s approval; the active charter is unchanged until then.',
    ].join("\n");
  }

  return [
    "Author the session's Alignment charter from the conversation so far.",
    "Use this soft scaffold as a starting point — adapt, restructure, or remove sections as the conversation warrants; the charter is free-text markdown:",
    "",
    body,
    ...guidanceLines,
    "",
    'When the charter is ready, save it to a JSON file (`{ "content": "<charter markdown>" }`) and submit it with `cctl charter write --file <file>.json`. The result is a draft pending the user\'s approval.',
  ].join("\n");
}

/**
 * Compose the incorporation turn for approved decisions (R5.5). Folding the
 * decisions into the charter fills the auto-activate draft, so it activates with
 * no separate Approve-Charter gate.
 */
function composeIncorporationMessage(
  decisions: AlignmentDecision[],
  activeContent: string | null,
): string {
  const list = decisions
    .map((decision, index) => `${index + 1}. ${decision.statement}`)
    .join("\n");
  const lines = [
    "The user approved the following decisions; fold them into the session's Alignment charter:",
    "",
    list,
    "",
  ];
  if (activeContent) {
    lines.push(
      "Here is the current charter to update — incorporate the decisions above and preserve everything still accurate:",
      "",
      activeContent,
      "",
    );
  } else {
    lines.push(
      "There is no charter yet; author one that captures these decisions and the session's shared context.",
      "",
    );
  }
  lines.push(
    'When the updated charter is ready, save it to a JSON file (`{ "content": "<charter markdown>" }`) and submit it with `cctl charter write --file <file>.json`. It activates automatically — no separate approval is needed.',
  );
  return lines.join("\n");
}

/**
 * Compose the feedback turn for decisions the user rejected with a note (R5.6).
 * The charter is unchanged; the agent revises or re-proposes.
 */
function composeFeedbackMessage(
  notes: { statement: string; feedback: string }[],
): string {
  const list = notes
    .map(
      (note, index) => `${index + 1}. "${note.statement}" — ${note.feedback}`,
    )
    .join("\n");
  return [
    "The user reviewed your proposed decisions and rejected the following with feedback. Revise or re-propose as appropriate; the active charter is unchanged:",
    "",
    list,
  ].join("\n");
}
