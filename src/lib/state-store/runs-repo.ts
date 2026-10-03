import type Database from "better-sqlite3";
import { z } from "zod";
import {
  runBoundarySchema,
  runRecordSchema,
  type RunBoundary,
  type RunRecord,
} from "@/lib/runs/schemas";

type Db = InstanceType<typeof Database>;

const runRow = z.object({
  run_id: z.string(),
  project_path: z.string(),
  session_name: z.string(),
  owner_conversation_id: z.string(),
  owner_session_name: z.string().nullable(),
  launch_cause: z.string(),
  facts_json: z.string(),
  revision: z.number().int(),
  progress_json: z.string(),
  invocations_json: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
const boundaryRow = z.object({
  seq: z.number().int(),
  run_id: z.string(),
  occurrence: z.string(),
  kind: z.string(),
  summary: z.string(),
  detail_json: z.string(),
  recorded_at: z.string(),
  notified_at: z.string().nullable(),
});

const RUN = `run_id, project_path, session_name, owner_conversation_id, owner_session_name, launch_cause,
  facts_json, revision, progress_json, invocations_json, created_at, updated_at`;
const BOUNDARY = `seq, run_id, occurrence, kind, summary, detail_json, recorded_at, notified_at`;

function runFromRow(raw: unknown): RunRecord {
  const r = runRow.parse(raw);
  return runRecordSchema.parse({
    runId: r.run_id,
    projectPath: r.project_path,
    sessionName: r.session_name,
    ownerConversationId: r.owner_conversation_id,
    ownerSessionName: r.owner_session_name,
    launchCause: r.launch_cause,
    facts: JSON.parse(r.facts_json),
    revision: r.revision,
    progress: JSON.parse(r.progress_json),
    invocations: JSON.parse(r.invocations_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function boundaryFromRow(raw: unknown): RunBoundary {
  const r = boundaryRow.parse(raw);
  return runBoundarySchema.parse({
    seq: r.seq,
    runId: r.run_id,
    occurrence: r.occurrence,
    kind: r.kind,
    summary: r.summary,
    detail: JSON.parse(r.detail_json),
    recordedAt: r.recorded_at,
    notifiedAt: r.notified_at,
  });
}

export class RunRevisionConflictError extends Error {
  constructor(runId: string, expected: number) {
    super(`Run ${runId} changed since revision ${expected}`);
    this.name = "RunRevisionConflictError";
  }
}

/** Sole writer of `runs` and `run_boundaries`; Run's host owns every transition. */
export interface RunsRepo {
  insertIfAbsent(record: RunRecord): void;
  get(runId: string): RunRecord | null;
  getByLaunchCause(cause: string): RunRecord | null;
  listActive(): RunRecord[];
  listByOwner(projectPath: string, ownerConversationId: string): RunRecord[];
  update(
    runId: string,
    expectedRevision: number,
    change: Pick<RunRecord, "facts" | "progress" | "invocations" | "updatedAt">,
  ): number;
  recordBoundary(boundary: Omit<RunBoundary, "seq" | "notifiedAt">): void;
  boundaries(runId: string, afterSeq?: number): RunBoundary[];
  unnotifiedBoundaries(runId: string): RunBoundary[];
  markNotified(seq: number, notifiedAt: string): void;
  latestBoundarySeq(runId: string): number;
  /** Every run, finished or not, with a boundary its owner has not been told. */
  runsWithUnnotifiedBoundaries(): string[];
}

export function createRunsRepo(db: Db): RunsRepo {
  const st = {
    insert: db.prepare(`INSERT OR IGNORE INTO runs (${RUN}) VALUES (@runId, @projectPath, @sessionName, @ownerConversationId, @ownerSessionName, @launchCause, @factsJson, @revision, @progressJson, @invocationsJson, @createdAt, @updatedAt)`),
    get: db.prepare(`SELECT ${RUN} FROM runs WHERE run_id = ?`),
    byCause: db.prepare(`SELECT ${RUN} FROM runs WHERE launch_cause = ?`),
    active: db.prepare(`SELECT ${RUN} FROM runs WHERE json_extract(progress_json, '$.kind') NOT IN ('succeeded','cancelled') ORDER BY created_at, rowid`),
    byOwner: db.prepare(`SELECT ${RUN} FROM runs WHERE project_path = ? AND owner_conversation_id = ? ORDER BY created_at DESC, rowid DESC`),
    update: db.prepare(`UPDATE runs SET facts_json = @factsJson, revision = revision + 1, progress_json = @progressJson, invocations_json = @invocationsJson, updated_at = @updatedAt WHERE run_id = @runId AND revision = @expectedRevision`),
    recordBoundary: db.prepare(`INSERT OR IGNORE INTO run_boundaries (run_id, occurrence, kind, summary, detail_json, recorded_at) VALUES (@runId, @occurrence, @kind, @summary, @detailJson, @recordedAt)`),
    boundaries: db.prepare(`SELECT ${BOUNDARY} FROM run_boundaries WHERE run_id = ? AND seq > ? ORDER BY seq`),
    unnotified: db.prepare(`SELECT ${BOUNDARY} FROM run_boundaries WHERE run_id = ? AND notified_at IS NULL ORDER BY seq`),
    markNotified: db.prepare(`UPDATE run_boundaries SET notified_at = ? WHERE seq = ?`),
    latestSeq: db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM run_boundaries WHERE run_id = ?`),
    unnotifiedRuns: db.prepare(`SELECT DISTINCT run_id FROM run_boundaries WHERE notified_at IS NULL ORDER BY run_id`),
  };
  return {
    insertIfAbsent(record) {
      const p = runRecordSchema.parse(record);
      st.insert.run({
        runId: p.runId,
        projectPath: p.projectPath,
        sessionName: p.sessionName,
        ownerConversationId: p.ownerConversationId,
        ownerSessionName: p.ownerSessionName,
        launchCause: p.launchCause,
        factsJson: JSON.stringify(p.facts),
        revision: p.revision,
        progressJson: JSON.stringify(p.progress),
        invocationsJson: JSON.stringify(p.invocations),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      });
    },
    get(runId) {
      const raw: unknown = st.get.get(runId);
      return raw === undefined ? null : runFromRow(raw);
    },
    getByLaunchCause(cause) {
      const raw: unknown = st.byCause.get(cause);
      return raw === undefined ? null : runFromRow(raw);
    },
    listActive() {
      return st.active.all().map(runFromRow);
    },
    listByOwner(projectPath, ownerConversationId) {
      return st.byOwner.all(projectPath, ownerConversationId).map(runFromRow);
    },
    update(runId, expectedRevision, change) {
      const result = st.update.run({
        runId,
        expectedRevision,
        factsJson: JSON.stringify(change.facts),
        progressJson: JSON.stringify(change.progress),
        invocationsJson: JSON.stringify(change.invocations),
        updatedAt: change.updatedAt,
      });
      if (result.changes !== 1) throw new RunRevisionConflictError(runId, expectedRevision);
      return expectedRevision + 1;
    },
    recordBoundary(boundary) {
      st.recordBoundary.run({
        runId: boundary.runId,
        occurrence: boundary.occurrence,
        kind: boundary.kind,
        summary: boundary.summary,
        detailJson: JSON.stringify(boundary.detail ?? null),
        recordedAt: boundary.recordedAt,
      });
    },
    boundaries(runId, afterSeq = 0) {
      return st.boundaries.all(runId, afterSeq).map(boundaryFromRow);
    },
    unnotifiedBoundaries(runId) {
      return st.unnotified.all(runId).map(boundaryFromRow);
    },
    markNotified(seq, notifiedAt) {
      st.markNotified.run(notifiedAt, seq);
    },
    latestBoundarySeq(runId) {
      return z.object({ seq: z.number().int() }).parse(st.latestSeq.get(runId)).seq;
    },
    runsWithUnnotifiedBoundaries() {
      return z.array(z.object({ run_id: z.string() })).parse(st.unnotifiedRuns.all()).map((row) => row.run_id);
    },
  };
}
