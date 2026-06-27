import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { PersistenceError, getErrorMessage } from "@/lib/shared/errors";
import {
  parseTrusted,
  registerTrustedSchema,
} from "@/lib/shared/parse-trusted";
import {
  alignmentDecisionSchema,
  alignmentVersionSchema,
  decisionProposalSchema,
  type AlignmentDecision,
  type AlignmentVersion,
  type DecisionProposal,
  type DecisionProposalBatch,
} from "./schemas";
type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.session-alignment");

/**
 * Durable repository over the three session-alignment tables plus the conversation
 * seen-version accessor. App state is authoritative for charter alignment, so this
 * repo is the persistence boundary the `SessionAlignmentService` (3.x) reads and
 * writes through.
 *
 * The decision log is **append-only by contract**: this surface offers
 * `appendDecision` + read accessors and `setDecisionProducedVersion` (a one-time
 * back-link written when the decision's auto-activated draft fills), but
 * deliberately exposes **no** update-statement or delete of a logged decision.
 * Versions and proposals are mutable/transient and carry the operations their
 * lifecycle requires.
 */
export interface SessionAlignmentRepo {
  // --- Charter versions ---
  insertVersion(
    projectPath: string,
    sessionName: string,
    version: AlignmentVersion,
  ): void;
  /**
   * Update an existing version row in place — the activation/supersede/fill
   * transitions assign `version`, flip `status`, and stamp `activatedAt`.
   */
  updateVersion(
    projectPath: string,
    sessionName: string,
    version: AlignmentVersion,
  ): void;
  /**
   * Delete a version row by id. Only ever called for a `draft` row — a draft is
   * discarded on reject (R4.5) or replaced by a newer `beginDraft`
   * (last-writer-wins). Activated versions are never deleted; they are
   * superseded so the history stays auditable (R8.1).
   */
  deleteVersionById(projectPath: string, sessionName: string, id: string): void;
  findVersionById(id: string): AlignmentVersion | null;
  findActiveVersion(
    projectPath: string,
    sessionName: string,
  ): AlignmentVersion | null;
  findDraftVersion(
    projectPath: string,
    sessionName: string,
  ): AlignmentVersion | null;
  findVersionByNumber(
    projectPath: string,
    sessionName: string,
    version: number,
  ): AlignmentVersion | null;
  /** Superseded + active, newest first; drafts (NULL version) excluded. */
  findVersionHistory(
    projectPath: string,
    sessionName: string,
  ): AlignmentVersion[];
  /**
   * Cheap focused accessor for the per-turn recreate gate: the active version
   * number (or null when no active charter). Avoids materializing content.
   */
  findActiveVersionNumber(
    projectPath: string,
    sessionName: string,
  ): number | null;

  // --- Append-only decision log ---
  appendDecision(
    projectPath: string,
    sessionName: string,
    decision: AlignmentDecision,
  ): void;
  findDecisionById(id: string): AlignmentDecision | null;
  /** Approved decisions, reverse-chronological. */
  findDecisionsReverseChron(
    projectPath: string,
    sessionName: string,
  ): AlignmentDecision[];
  /**
   * Back-link a logged decision to the charter version its incorporation
   * produced. The only mutation a logged decision admits — the statement,
   * origin, and approval are immutable once appended.
   */
  setDecisionProducedVersion(
    projectPath: string,
    sessionName: string,
    decisionId: string,
    producedVersion: number,
  ): void;

  // --- Transient decision proposals ---
  insertProposals(proposals: DecisionProposal[]): void;
  findProposalById(id: string): DecisionProposal | null;
  findProposalsByBatch(
    projectPath: string,
    sessionName: string,
    batchId: string,
  ): DecisionProposal[];
  findPendingProposalBatches(
    projectPath: string,
    sessionName: string,
  ): DecisionProposalBatch[];
  deleteProposalsByBatch(
    projectPath: string,
    sessionName: string,
    batchId: string,
  ): void;

  // --- Conversation seen-version accessor ---
  getConversationSeenVersion(conversationId: string): number | null;
  setConversationSeenVersion(
    conversationId: string,
    version: number | null,
  ): boolean;

  /**
   * Run `fn` inside a single SQLite transaction over this repo's connection.
   * Activation supersedes the prior active row and inserts the newly active row
   * atomically through this wrapper so the ≤1-active invariant always holds even
   * if the process dies mid-write. Synchronous by design (better-sqlite3): `fn`
   * must not await.
   */
  transaction<T>(fn: () => T): T;
}

// ============================================================
// Raw table-row schemas (validated at the persistence boundary)
// ============================================================

const versionsTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    project_path: z.string(),
    session_name: z.string(),
    version: z.number().int().nullable(),
    content: z.string(),
    content_hash: z.string(),
    status: z.string(),
    source: z.string(),
    author_conversation_id: z.string().nullable(),
    auto_activate: z.union([z.literal(0), z.literal(1)]),
    linked_decision_ids: z.string(),
    approver: z.string().nullable(),
    created_at: z.string(),
    activated_at: z.string().nullable(),
  }),
  "sessionAlignmentVersionsTableRowSchema",
);
type VersionsTableRow = z.infer<typeof versionsTableRowSchema>;

const decisionsTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    project_path: z.string(),
    session_name: z.string(),
    statement: z.string(),
    rationale: z.string().nullable(),
    origin_conversation_id: z.string(),
    origin_message_id: z.string().nullable(),
    produced_version: z.number().int().nullable(),
    approved_at: z.string(),
    approver: z.string().nullable(),
    created_at: z.string(),
  }),
  "sessionAlignmentDecisionsTableRowSchema",
);
type DecisionsTableRow = z.infer<typeof decisionsTableRowSchema>;

const proposalsTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    project_path: z.string(),
    session_name: z.string(),
    conversation_id: z.string(),
    batch_id: z.string(),
    statement: z.string(),
    rationale: z.string().nullable(),
    context: z.string().nullable(),
    origin_message_id: z.string().nullable(),
    created_at: z.string(),
  }),
  "sessionAlignmentProposalsTableRowSchema",
);
type ProposalsTableRow = z.infer<typeof proposalsTableRowSchema>;

const linkedDecisionIdsSchema = z.array(z.string());

// ============================================================
// Encode (domain -> SQLite bind)
// ============================================================

interface VersionBindRow {
  id: string;
  project_path: string;
  session_name: string;
  version: number | null;
  content: string;
  content_hash: string;
  status: string;
  source: string;
  author_conversation_id: string | null;
  auto_activate: number;
  linked_decision_ids: string;
  approver: string | null;
  created_at: string;
  activated_at: string | null;
}

function versionToBind(
  projectPath: string,
  sessionName: string,
  version: AlignmentVersion,
): VersionBindRow {
  const validated = alignmentVersionSchema.parse(version);
  return {
    id: validated.id,
    project_path: projectPath,
    session_name: sessionName,
    version: validated.version,
    content: validated.content,
    content_hash: validated.contentHash,
    status: validated.status,
    source: validated.source,
    author_conversation_id: validated.authorConversationId,
    auto_activate: validated.autoActivate ? 1 : 0,
    linked_decision_ids: JSON.stringify(validated.linkedDecisionIds),
    approver: validated.approver,
    created_at: validated.createdAt,
    activated_at: validated.activatedAt,
  };
}

interface DecisionBindRow {
  id: string;
  project_path: string;
  session_name: string;
  statement: string;
  rationale: string | null;
  origin_conversation_id: string;
  origin_message_id: string | null;
  produced_version: number | null;
  approved_at: string;
  approver: string | null;
  created_at: string;
}

function decisionToBind(
  projectPath: string,
  sessionName: string,
  decision: AlignmentDecision,
): DecisionBindRow {
  const validated = alignmentDecisionSchema.parse(decision);
  return {
    id: validated.id,
    project_path: projectPath,
    session_name: sessionName,
    statement: validated.statement,
    rationale: validated.rationale,
    origin_conversation_id: validated.originConversationId,
    origin_message_id: validated.originMessageId,
    produced_version: validated.producedVersion,
    approved_at: validated.approvedAt,
    approver: validated.approver,
    created_at: validated.createdAt,
  };
}

interface ProposalBindRow {
  id: string;
  project_path: string;
  session_name: string;
  conversation_id: string;
  batch_id: string;
  statement: string;
  rationale: string | null;
  context: string | null;
  origin_message_id: string | null;
  created_at: string;
}

function proposalToBind(proposal: DecisionProposal): ProposalBindRow {
  const validated = decisionProposalSchema.parse(proposal);
  return {
    id: validated.id,
    project_path: validated.projectPath,
    session_name: validated.sessionName,
    conversation_id: validated.conversationId,
    batch_id: validated.batchId,
    statement: validated.statement,
    rationale: validated.rationale,
    context: validated.context,
    origin_message_id: validated.originMessageId,
    created_at: validated.createdAt,
  };
}

// ============================================================
// Decode (SQLite row -> domain)
// ============================================================

function logAndThrowValidationFailure(
  entity: string,
  identifier: string,
  issues: unknown,
): never {
  logger.error(`state-store.session-alignment.${entity}.validation_failure`, {
    identifier,
    issues,
  });
  throw new PersistenceError({
    kind: "validation",
    entity,
    identifier,
    issues,
  });
}

function fallbackId(rawRow: unknown): string {
  if (
    typeof rawRow === "object" &&
    rawRow !== null &&
    typeof (rawRow as { id?: unknown }).id === "string"
  ) {
    return (rawRow as { id: string }).id;
  }
  return "<unknown>";
}

function versionRowToDomain(rawRow: unknown): AlignmentVersion {
  const row: VersionsTableRow = parseTrusted(
    versionsTableRowSchema,
    rawRow,
    (issues) =>
      logAndThrowValidationFailure(
        "session_alignment_version",
        fallbackId(rawRow),
        issues,
      ),
  );

  let linkedDecisionIds: string[];
  try {
    const parsed: unknown = JSON.parse(row.linked_decision_ids);
    linkedDecisionIds = linkedDecisionIdsSchema.parse(parsed);
  } catch (err) {
    return logAndThrowValidationFailure("session_alignment_version", row.id, [
      {
        code: "invalid_json",
        path: ["linked_decision_ids"],
        message: getErrorMessage(err),
      },
    ]);
  }

  const candidate = {
    id: row.id,
    version: row.version,
    content: row.content,
    contentHash: row.content_hash,
    status: row.status,
    source: row.source,
    authorConversationId: row.author_conversation_id,
    autoActivate: row.auto_activate === 1,
    linkedDecisionIds,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    approver: row.approver,
  };
  const result = alignmentVersionSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowValidationFailure(
      "session_alignment_version",
      row.id,
      result.error.issues,
    );
  }
  return result.data;
}

function decisionRowToDomain(rawRow: unknown): AlignmentDecision {
  const row: DecisionsTableRow = parseTrusted(
    decisionsTableRowSchema,
    rawRow,
    (issues) =>
      logAndThrowValidationFailure(
        "session_alignment_decision",
        fallbackId(rawRow),
        issues,
      ),
  );

  const candidate = {
    id: row.id,
    statement: row.statement,
    rationale: row.rationale,
    originConversationId: row.origin_conversation_id,
    originMessageId: row.origin_message_id,
    producedVersion: row.produced_version,
    approver: row.approver,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
  const result = alignmentDecisionSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowValidationFailure(
      "session_alignment_decision",
      row.id,
      result.error.issues,
    );
  }
  return result.data;
}

function proposalRowToDomain(rawRow: unknown): DecisionProposal {
  const row: ProposalsTableRow = parseTrusted(
    proposalsTableRowSchema,
    rawRow,
    (issues) =>
      logAndThrowValidationFailure(
        "session_alignment_proposal",
        fallbackId(rawRow),
        issues,
      ),
  );

  const candidate = {
    id: row.id,
    projectPath: row.project_path,
    sessionName: row.session_name,
    conversationId: row.conversation_id,
    batchId: row.batch_id,
    statement: row.statement,
    rationale: row.rationale,
    context: row.context,
    originMessageId: row.origin_message_id,
    createdAt: row.created_at,
  };
  const result = decisionProposalSchema.safeParse(candidate);
  if (!result.success) {
    return logAndThrowValidationFailure(
      "session_alignment_proposal",
      row.id,
      result.error.issues,
    );
  }
  return result.data;
}

function timed<T>(
  op: string,
  identifier: {
    id?: string;
    projectPath?: string;
    sessionName?: string;
    batchId?: string;
    conversationId?: string;
  },
  fn: () => T,
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = +(performance.now() - start).toFixed(3);
    const payload: Record<string, unknown> = { durationMs };
    if (identifier.id !== undefined) payload.id = identifier.id;
    if (identifier.projectPath !== undefined) {
      payload.projectPath = identifier.projectPath;
    }
    if (identifier.sessionName !== undefined) {
      payload.sessionName = identifier.sessionName;
    }
    if (identifier.batchId !== undefined) payload.batchId = identifier.batchId;
    if (identifier.conversationId !== undefined) {
      payload.conversationId = identifier.conversationId;
    }
    logger.info(`state-store.session-alignment.${op}.timing`, payload);
  }
}

export function createSessionAlignmentRepo(db: Db): SessionAlignmentRepo {
  const insertVersionStmt = db.prepare(
    `INSERT INTO session_alignment_versions (
       id, project_path, session_name, version, content, content_hash,
       status, source, author_conversation_id, auto_activate,
       linked_decision_ids, approver, created_at, activated_at
     ) VALUES (
       @id, @project_path, @session_name, @version, @content, @content_hash,
       @status, @source, @author_conversation_id, @auto_activate,
       @linked_decision_ids, @approver, @created_at, @activated_at
     )`,
  );
  const updateVersionStmt = db.prepare(
    `UPDATE session_alignment_versions SET
       version                = @version,
       content                = @content,
       content_hash           = @content_hash,
       status                 = @status,
       source                 = @source,
       author_conversation_id = @author_conversation_id,
       auto_activate          = @auto_activate,
       linked_decision_ids    = @linked_decision_ids,
       approver               = @approver,
       created_at             = @created_at,
       activated_at           = @activated_at
     WHERE id = @id AND project_path = @project_path AND session_name = @session_name`,
  );
  const deleteVersionByIdStmt = db.prepare(
    `DELETE FROM session_alignment_versions
      WHERE id = ? AND project_path = ? AND session_name = ?`,
  );
  const findVersionByIdStmt = db.prepare(
    `SELECT * FROM session_alignment_versions WHERE id = ? LIMIT 1`,
  );
  const findVersionByStatusStmt = db.prepare(
    `SELECT * FROM session_alignment_versions
      WHERE project_path = ? AND session_name = ? AND status = ?
      ORDER BY version DESC, created_at DESC
      LIMIT 1`,
  );
  const findVersionByNumberStmt = db.prepare(
    `SELECT * FROM session_alignment_versions
      WHERE project_path = ? AND session_name = ? AND version = ?
      LIMIT 1`,
  );
  const findVersionHistoryStmt = db.prepare(
    `SELECT * FROM session_alignment_versions
      WHERE project_path = ? AND session_name = ?
        AND status IN ('active', 'superseded')
      ORDER BY version DESC`,
  );
  const findActiveVersionNumberStmt = db.prepare(
    `SELECT version FROM session_alignment_versions
      WHERE project_path = ? AND session_name = ? AND status = 'active'
      LIMIT 1`,
  );

  const appendDecisionStmt = db.prepare(
    `INSERT INTO session_alignment_decisions (
       id, project_path, session_name, statement, rationale,
       origin_conversation_id, origin_message_id, produced_version,
       approved_at, approver, created_at
     ) VALUES (
       @id, @project_path, @session_name, @statement, @rationale,
       @origin_conversation_id, @origin_message_id, @produced_version,
       @approved_at, @approver, @created_at
     )`,
  );
  const findDecisionByIdStmt = db.prepare(
    `SELECT * FROM session_alignment_decisions WHERE id = ? LIMIT 1`,
  );
  const findDecisionsReverseChronStmt = db.prepare(
    `SELECT * FROM session_alignment_decisions
      WHERE project_path = ? AND session_name = ?
      ORDER BY approved_at DESC, id DESC`,
  );
  const setDecisionProducedVersionStmt = db.prepare(
    `UPDATE session_alignment_decisions SET produced_version = ?
      WHERE project_path = ? AND session_name = ? AND id = ?`,
  );

  const insertProposalStmt = db.prepare(
    `INSERT INTO session_alignment_decision_proposals (
       id, project_path, session_name, conversation_id, batch_id,
       statement, rationale, context, origin_message_id, created_at
     ) VALUES (
       @id, @project_path, @session_name, @conversation_id, @batch_id,
       @statement, @rationale, @context, @origin_message_id, @created_at
     )`,
  );
  const insertProposalsTxn = db.transaction((rows: ProposalBindRow[]) => {
    for (const bind of rows) insertProposalStmt.run(bind);
  });
  const findProposalByIdStmt = db.prepare(
    `SELECT * FROM session_alignment_decision_proposals WHERE id = ? LIMIT 1`,
  );
  const findProposalsByBatchStmt = db.prepare(
    `SELECT * FROM session_alignment_decision_proposals
      WHERE project_path = ? AND session_name = ? AND batch_id = ?
      ORDER BY created_at ASC, id ASC`,
  );
  const findPendingProposalsStmt = db.prepare(
    `SELECT * FROM session_alignment_decision_proposals
      WHERE project_path = ? AND session_name = ?
      ORDER BY created_at ASC, id ASC`,
  );
  const deleteProposalsByBatchStmt = db.prepare(
    `DELETE FROM session_alignment_decision_proposals
      WHERE project_path = ? AND session_name = ? AND batch_id = ?`,
  );

  const getConversationSeenVersionStmt = db.prepare(
    `SELECT last_seen_alignment_version FROM conversations WHERE id = ? LIMIT 1`,
  );
  const setConversationSeenVersionStmt = db.prepare(
    `UPDATE conversations SET last_seen_alignment_version = ? WHERE id = ?`,
  );

  function findVersionByStatus(
    projectPath: string,
    sessionName: string,
    status: AlignmentVersion["status"],
  ): AlignmentVersion | null {
    const row: unknown = findVersionByStatusStmt.get(
      projectPath,
      sessionName,
      status,
    );
    if (row === undefined) return null;
    return versionRowToDomain(row);
  }

  return {
    insertVersion(projectPath, sessionName, version) {
      timed(
        "insertVersion",
        { id: version.id, projectPath, sessionName },
        () => {
          insertVersionStmt.run(
            versionToBind(projectPath, sessionName, version),
          );
        },
      );
    },
    updateVersion(projectPath, sessionName, version) {
      timed(
        "updateVersion",
        { id: version.id, projectPath, sessionName },
        () => {
          updateVersionStmt.run(
            versionToBind(projectPath, sessionName, version),
          );
        },
      );
    },
    deleteVersionById(projectPath, sessionName, id) {
      timed("deleteVersionById", { id, projectPath, sessionName }, () => {
        deleteVersionByIdStmt.run(id, projectPath, sessionName);
      });
    },
    findVersionById(id) {
      return timed("findVersionById", { id }, () => {
        const row: unknown = findVersionByIdStmt.get(id);
        if (row === undefined) return null;
        return versionRowToDomain(row);
      });
    },
    findActiveVersion(projectPath, sessionName) {
      return timed("findActiveVersion", { projectPath, sessionName }, () =>
        findVersionByStatus(projectPath, sessionName, "active"),
      );
    },
    findDraftVersion(projectPath, sessionName) {
      return timed("findDraftVersion", { projectPath, sessionName }, () =>
        findVersionByStatus(projectPath, sessionName, "draft"),
      );
    },
    findVersionByNumber(projectPath, sessionName, version) {
      return timed("findVersionByNumber", { projectPath, sessionName }, () => {
        const row: unknown = findVersionByNumberStmt.get(
          projectPath,
          sessionName,
          version,
        );
        if (row === undefined) return null;
        return versionRowToDomain(row);
      });
    },
    findVersionHistory(projectPath, sessionName) {
      return timed("findVersionHistory", { projectPath, sessionName }, () => {
        const rows = findVersionHistoryStmt.all(
          projectPath,
          sessionName,
        ) as unknown[];
        return rows.map(versionRowToDomain);
      });
    },
    findActiveVersionNumber(projectPath, sessionName) {
      return timed(
        "findActiveVersionNumber",
        { projectPath, sessionName },
        () => {
          const row = findActiveVersionNumberStmt.get(
            projectPath,
            sessionName,
          ) as { version: number | null } | undefined;
          if (row === undefined) return null;
          return row.version;
        },
      );
    },

    appendDecision(projectPath, sessionName, decision) {
      timed(
        "appendDecision",
        { id: decision.id, projectPath, sessionName },
        () => {
          appendDecisionStmt.run(
            decisionToBind(projectPath, sessionName, decision),
          );
        },
      );
    },
    findDecisionById(id) {
      return timed("findDecisionById", { id }, () => {
        const row: unknown = findDecisionByIdStmt.get(id);
        if (row === undefined) return null;
        return decisionRowToDomain(row);
      });
    },
    findDecisionsReverseChron(projectPath, sessionName) {
      return timed(
        "findDecisionsReverseChron",
        { projectPath, sessionName },
        () => {
          const rows = findDecisionsReverseChronStmt.all(
            projectPath,
            sessionName,
          ) as unknown[];
          return rows.map(decisionRowToDomain);
        },
      );
    },
    setDecisionProducedVersion(
      projectPath,
      sessionName,
      decisionId,
      producedVersion,
    ) {
      timed(
        "setDecisionProducedVersion",
        { id: decisionId, projectPath, sessionName },
        () => {
          setDecisionProducedVersionStmt.run(
            producedVersion,
            projectPath,
            sessionName,
            decisionId,
          );
        },
      );
    },

    insertProposals(proposals) {
      if (proposals.length === 0) return;
      const first = proposals[0]!;
      timed(
        "insertProposals",
        {
          projectPath: first.projectPath,
          sessionName: first.sessionName,
          batchId: first.batchId,
        },
        () => {
          insertProposalsTxn(proposals.map(proposalToBind));
        },
      );
    },
    findProposalById(id) {
      return timed("findProposalById", { id }, () => {
        const row: unknown = findProposalByIdStmt.get(id);
        if (row === undefined) return null;
        return proposalRowToDomain(row);
      });
    },
    findProposalsByBatch(projectPath, sessionName, batchId) {
      return timed(
        "findProposalsByBatch",
        { projectPath, sessionName, batchId },
        () => {
          const rows = findProposalsByBatchStmt.all(
            projectPath,
            sessionName,
            batchId,
          ) as unknown[];
          return rows.map(proposalRowToDomain);
        },
      );
    },
    findPendingProposalBatches(projectPath, sessionName) {
      return timed(
        "findPendingProposalBatches",
        { projectPath, sessionName },
        () => {
          const rows = findPendingProposalsStmt.all(
            projectPath,
            sessionName,
          ) as unknown[];
          const byBatch = new Map<string, DecisionProposal[]>();
          for (const raw of rows) {
            const proposal = proposalRowToDomain(raw);
            const existing = byBatch.get(proposal.batchId);
            if (existing) {
              existing.push(proposal);
            } else {
              byBatch.set(proposal.batchId, [proposal]);
            }
          }
          return Array.from(byBatch.entries()).map(([batchId, proposals]) => ({
            batchId,
            proposals,
          }));
        },
      );
    },
    deleteProposalsByBatch(projectPath, sessionName, batchId) {
      timed(
        "deleteProposalsByBatch",
        { projectPath, sessionName, batchId },
        () => {
          deleteProposalsByBatchStmt.run(projectPath, sessionName, batchId);
        },
      );
    },

    getConversationSeenVersion(conversationId) {
      return timed("getConversationSeenVersion", { conversationId }, () => {
        const row = getConversationSeenVersionStmt.get(conversationId) as
          | { last_seen_alignment_version: number | null }
          | undefined;
        if (row === undefined) return null;
        return row.last_seen_alignment_version;
      });
    },
    setConversationSeenVersion(conversationId, version) {
      return timed("setConversationSeenVersion", { conversationId }, () => {
        const info = setConversationSeenVersionStmt.run(
          version,
          conversationId,
        );
        return info.changes > 0;
      });
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}
