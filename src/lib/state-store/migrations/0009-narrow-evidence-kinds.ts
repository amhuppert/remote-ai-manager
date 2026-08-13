import { createHash } from "node:crypto";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { stableStringify } from "../serialization";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import type { StateMigration } from "./types";

const logger = createLogger("state-store/migrations");

const MIGRATION_NAME = "0009-narrow-evidence-kinds";
const MIGRATION_SCHEMA_VERSION = 2;
const MIGRATION_SCHEMA_DESCRIPTION =
  "Evidence kinds narrowed to commit/test_run/validator_verdict";

/**
 * BREAKING migration (ticket #24). The evidence-kind vocabulary narrows to
 * the machine-producible kinds `commit | test_run | validator_verdict`, and
 * every persisted validation strategy must contain at least one machine kind
 * (`test_run`/`validator_verdict`) — a zero-machine strategy is an authored
 * obligation the delivery gate can never prove.
 *
 * In one immediate transaction, this migration:
 * 1. rewrites every criterion strategy that carries a dropped kind or has no
 *    machine kind (strip dropped kinds; dedupe; append `validator_verdict`
 *    when no machine kind remains, preserving a surviving `commit`),
 * 2. appends a trace note to every strategy the fallback touched,
 * 3. recomputes `payload_hash` for rewritten versions and `content_hash` for
 *    affected frozen revisions,
 * 4. deletes dropped-kind `spec_evidence` rows and invalidates their
 *    dependents (citing verdicts staled, citing accepted claims reopened),
 *    then stales every current verdict whose cited evidence kinds do not
 *    satisfy a strategy the fallback strengthened — a legacy `[]`/commit-only
 *    verdict cites no deleted row, yet no longer proves the strengthened
 *    strategy, and leaving it current would make every stale_at-driven read
 *    projection contradict the gate,
 * 5. writes one durable `spec_events` trace row per touched spec, and
 * 6. stamps `schema_migrations` version 2.
 *
 * The version bump exists because of old-build *writes*: an old build's wide
 * Zod enum plus the legacy permissive `spec_evidence` CHECK would re-insert
 * dropped-kind rows into a repaired database that this build's strict read
 * path then hard-fails on, with the one-shot ledgered repair never re-running.
 *
 * Exported spec bundles: `spec verify --against` a pre-narrowing bundle fails
 * with the integrity mismatch for any spec this migration rewrote — correct,
 * the canonical content genuinely changed; operators re-export. This frozen
 * migration owns no export-format policy; later renderer changes may advance
 * `formatVersion` independently of this persistence repair.
 *
 * Frozen by design: this file binds no live spec schema or domain publisher
 * (the exact lesson of the 0008 freeze) — it carries its own six-kind lenient
 * parser and byte-identical hash helpers; the migration test proves the
 * rewritten state reloads and verifies through the live repositories.
 */
const DROPPED_KINDS = new Set(["diff", "screenshot", "human_signoff"]);
const MACHINE_KINDS = new Set(["test_run", "validator_verdict"]);
const SURVIVING_KINDS = new Set(["commit", "test_run", "validator_verdict"]);

const frozenAuthoringStageSchema = z.enum(["requirements", "design", "plan"]);

const frozenElementKindSchema = z.enum([
  "section",
  "requirement",
  "criterion",
  "decision",
  "task",
]);

const frozenSixKindSchema = z.enum([
  "diff",
  "commit",
  "test_run",
  "validator_verdict",
  "screenshot",
  "human_signoff",
]);

const frozenStrategySchema = z
  .object({
    kinds: z.array(frozenSixKindSchema),
    note: z.string().optional(),
  })
  .strict();

const frozenCriterionPayloadSchema = z
  .object({
    kind: z.literal("criterion"),
    text: z.string(),
    validationStrategy: frozenStrategySchema,
  })
  .strict();

type FrozenKind = z.infer<typeof frozenSixKindSchema>;
type FrozenStrategy = z.infer<typeof frozenStrategySchema>;
type FrozenCriterionPayload = z.infer<typeof frozenCriterionPayloadSchema>;

interface ElementVersionRow {
  revision_id: string;
  element_id: string;
  payload_json: string;
  spec_id: string;
}

interface FrozenRevisionRow {
  id: string;
  authoring_stage: string;
}

interface CanonicalElementRow {
  element_id: string;
  kind: string;
  number: number | null;
  parent_element_id: string | null;
  position: number;
  payload_json: string;
}

interface EvidenceRow {
  id: string;
  spec_id: string;
}

interface CitingRow {
  id: string;
  spec_id: string;
  evidence_ids_json: string;
}

interface StrategyChange {
  revisionId: string;
  criterionElementId: string;
  beforeKinds: FrozenKind[];
  afterKinds: FrozenKind[];
  fallbackApplied: boolean;
}

interface SpecTrace {
  strategyChanges: StrategyChange[];
  removedEvidenceIds: string[];
  staledVerdictIds: string[];
  reopenedClaimIds: string[];
}

/** Frozen byte-identical copy of the live `computeSpecElementPayloadHash`. */
function frozenPayloadHash(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/**
 * Frozen byte-identical copy of the live
 * `computeSpecRevisionContentHashFromCanonical` — the live function's payload
 * type narrows with the vocabulary, so frozen code hashes the same canonical
 * shape itself. The migration test proves the result verifies through the
 * live repository.
 */
function frozenRevisionContentHash(
  authoringStage: z.infer<typeof frozenAuthoringStageSchema>,
  elements: readonly unknown[],
): string {
  return createHash("sha256")
    .update(stableStringify({ authoringStage, elements }))
    .digest("hex");
}

/**
 * The normalization rule, applied in order: remove dropped kinds; dedupe; if
 * no machine kind remains, append `validator_verdict` (preserving a surviving
 * `commit`). Returns null when the strategy already satisfies the narrowed
 * vocabulary and the machine-kind invariant — the idempotence predicate.
 */
function normalizeStrategy(strategy: FrozenStrategy): {
  strategy: FrozenStrategy;
  beforeKinds: FrozenKind[];
  afterKinds: FrozenKind[];
  fallbackApplied: boolean;
} | null {
  const hasDropped = strategy.kinds.some((kind) => DROPPED_KINDS.has(kind));
  const hasMachine = strategy.kinds.some((kind) => MACHINE_KINDS.has(kind));
  if (!hasDropped && hasMachine) return null;

  const surviving = [
    ...new Set(strategy.kinds.filter((kind) => SURVIVING_KINDS.has(kind))),
  ];
  const fallbackApplied = !surviving.some((kind) => MACHINE_KINDS.has(kind));
  const afterKinds = fallbackApplied
    ? [...surviving, "validator_verdict" as const]
    : surviving;

  let note = strategy.note;
  if (fallbackApplied) {
    const original =
      strategy.kinds.length === 0 ? "(none)" : strategy.kinds.join(", ");
    const marker = `[migration 0009] Evidence kinds ${original} could not machine-prove this criterion after the vocabulary narrowed; a validator verdict is now required.`;
    note = note === undefined ? marker : `${note}\n\n${marker}`;
  }

  return {
    strategy: { kinds: afterKinds, ...(note === undefined ? {} : { note }) },
    beforeKinds: [...strategy.kinds],
    afterKinds,
    fallbackApplied,
  };
}

function traceFor(traces: Map<string, SpecTrace>, specId: string): SpecTrace {
  const existing = traces.get(specId);
  if (existing !== undefined) return existing;
  const created: SpecTrace = {
    strategyChanges: [],
    removedEvidenceIds: [],
    staledVerdictIds: [],
    reopenedClaimIds: [],
  };
  traces.set(specId, created);
  return created;
}

function parseEvidenceIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export const narrowEvidenceKinds: StateMigration = {
  name: MIGRATION_NAME,
  up: async ({ context }) => {
    const { db } = context;
    // Fail-closed external barrier before SQLite can expose narrowed-only
    // bytes; a rolled-back transaction leaves it published, which is the safe
    // direction (older readers stay excluded while this build retries).
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        MIGRATION_SCHEMA_VERSION,
      );
    }

    const migratedAt = new Date().toISOString();
    const migrate = db.transaction(() => {
      // Recheck under the write lock, witnessing the build's known version
      // (0006 precedent) so a same-build replay after any future cutover
      // still converges while a newer build's advance refuses.
      enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
      const traces = new Map<string, SpecTrace>();

      // (1)+(2) Strategy normalization with trace notes.
      const versionRows = db
        .prepare(
          `SELECT v.revision_id, v.element_id, v.payload_json, e.spec_id
           FROM spec_element_versions v
           JOIN spec_elements e ON e.id = v.element_id
           ORDER BY v.revision_id ASC, v.element_id ASC`,
        )
        .all() as ElementVersionRow[];
      const updateVersion = db.prepare(
        `UPDATE spec_element_versions
         SET payload_json = ?, payload_hash = ?
         WHERE revision_id = ? AND element_id = ?`,
      );
      const rewrittenRevisionIds = new Set<string>();
      const strengthenedStrategies: StrategyChange[] = [];
      for (const row of versionRows) {
        let rawPayload: unknown;
        try {
          rawPayload = JSON.parse(row.payload_json);
        } catch {
          continue;
        }
        if (
          typeof rawPayload !== "object" ||
          rawPayload === null ||
          !("kind" in rawPayload) ||
          rawPayload.kind !== "criterion"
        ) {
          continue;
        }
        const parsed = frozenCriterionPayloadSchema.safeParse(rawPayload);
        if (!parsed.success) {
          logger.error("state-store.migration_row_skipped", {
            migration: MIGRATION_NAME,
            table: "spec_element_versions",
            revisionId: row.revision_id,
            elementId: row.element_id,
          });
          continue;
        }
        const normalized = normalizeStrategy(parsed.data.validationStrategy);
        if (normalized === null) continue;
        const newPayload: FrozenCriterionPayload = {
          ...parsed.data,
          validationStrategy: normalized.strategy,
        };
        updateVersion.run(
          stableStringify(newPayload),
          frozenPayloadHash(newPayload),
          row.revision_id,
          row.element_id,
        );
        rewrittenRevisionIds.add(row.revision_id);
        const change: StrategyChange = {
          revisionId: row.revision_id,
          criterionElementId: row.element_id,
          beforeKinds: normalized.beforeKinds,
          afterKinds: normalized.afterKinds,
          fallbackApplied: normalized.fallbackApplied,
        };
        traceFor(traces, row.spec_id).strategyChanges.push(change);
        if (change.fallbackApplied) strengthenedStrategies.push(change);
      }

      // (3) Content-hash recompute for frozen revisions containing rewrites.
      if (rewrittenRevisionIds.size > 0) {
        const revisionStmt = db.prepare(
          `SELECT id, authoring_stage FROM spec_revisions
           WHERE id = ? AND content_hash IS NOT NULL`,
        );
        const elementsStmt = db.prepare(
          `SELECT
             e.id AS element_id,
             e.kind AS kind,
             e.number AS number,
             e.parent_element_id AS parent_element_id,
             v.position AS position,
             v.payload_json AS payload_json
           FROM spec_element_versions v
           JOIN spec_elements e ON e.id = v.element_id
           WHERE v.revision_id = ?
           ORDER BY v.position ASC, e.id ASC`,
        );
        const updateContentHash = db.prepare(
          "UPDATE spec_revisions SET content_hash = ? WHERE id = ?",
        );
        for (const revisionId of rewrittenRevisionIds) {
          const revision = revisionStmt.get(revisionId) as
            | FrozenRevisionRow
            | undefined;
          if (revision === undefined) continue;
          const canonical = (
            elementsStmt.all(revisionId) as CanonicalElementRow[]
          ).map((row) => ({
            elementId: row.element_id,
            kind: frozenElementKindSchema.parse(row.kind),
            number: row.number,
            parentElementId: row.parent_element_id,
            position: row.position,
            payload: JSON.parse(row.payload_json) as unknown,
          }));
          updateContentHash.run(
            frozenRevisionContentHash(
              frozenAuthoringStageSchema.parse(revision.authoring_stage),
              canonical,
            ),
            revisionId,
          );
        }
      }

      // (4) Dropped evidence rows and dependent invalidation.
      const droppedEvidence = db
        .prepare(
          `SELECT id, spec_id FROM spec_evidence
           WHERE kind IN ('diff', 'screenshot', 'human_signoff')
           ORDER BY id ASC`,
        )
        .all() as EvidenceRow[];
      const deletedIds = new Set<string>();
      for (const row of droppedEvidence) {
        deletedIds.add(row.id);
        traceFor(traces, row.spec_id).removedEvidenceIds.push(row.id);
      }
      const staleVerdict = db.prepare(
        `UPDATE spec_proof_verdicts SET stale_at = ?, stale_reason = ?
         WHERE id = ?`,
      );
      if (deletedIds.size > 0) {
        db.prepare(
          `DELETE FROM spec_evidence
           WHERE kind IN ('diff', 'screenshot', 'human_signoff')`,
        ).run();

        // Two projection layers treat `stale_at IS NULL` as proven without
        // resolving cited evidence, so deletion alone would leave detail
        // status and linked-ticket read-through showing false proof.
        const verdicts = db
          .prepare(
            `SELECT id, spec_id, evidence_ids_json FROM spec_proof_verdicts
             WHERE stale_at IS NULL ORDER BY id ASC`,
          )
          .all() as CitingRow[];
        for (const verdict of verdicts) {
          const cited = parseEvidenceIds(verdict.evidence_ids_json);
          if (!cited.some((id) => deletedIds.has(id))) continue;
          staleVerdict.run(
            migratedAt,
            "evidence kind removed from vocabulary by migration 0009",
            verdict.id,
          );
          traceFor(traces, verdict.spec_id).staledVerdictIds.push(verdict.id);
        }

        const claims = db
          .prepare(
            `SELECT id, spec_id, evidence_ids_json FROM spec_task_claims
             WHERE status = 'accepted' ORDER BY id ASC`,
          )
          .all() as CitingRow[];
        const reopenClaim = db.prepare(
          "UPDATE spec_task_claims SET status = 'reopened' WHERE id = ?",
        );
        for (const claim of claims) {
          const cited = parseEvidenceIds(claim.evidence_ids_json);
          if (!cited.some((id) => deletedIds.has(id))) continue;
          reopenClaim.run(claim.id);
          traceFor(traces, claim.spec_id).reopenedClaimIds.push(claim.id);
        }
      }

      // (4b) Strengthened strategies invalidate the verdicts that satisfied
      // only the weaker legacy form. Only a fallback rewrite can strengthen:
      // a strip-only rewrite leaves afterKinds a subset of beforeKinds, so a
      // verdict whose citations covered the old strategy still covers the new
      // one, and reevaluating it could stale only pre-existing insufficiency
      // — outside this migration's mandate. The check mirrors the gate's
      // kind-coverage rule (every strategy kind must be cited); freshness
      // stays the gate's own job. Runs after (4) so cited kinds resolve
      // against surviving rows and already-staled verdicts drop out of the
      // current set.
      const currentVerdictsForCriterion = db.prepare(
        `SELECT id, spec_id, evidence_ids_json FROM spec_proof_verdicts
         WHERE stale_at IS NULL AND criterion_element_id = ? AND revision_id = ?
         ORDER BY id ASC`,
      );
      const evidenceKindById = db.prepare(
        "SELECT kind FROM spec_evidence WHERE id = ?",
      );
      for (const change of strengthenedStrategies) {
        const verdicts = currentVerdictsForCriterion.all(
          change.criterionElementId,
          change.revisionId,
        ) as CitingRow[];
        for (const verdict of verdicts) {
          const citedKinds = new Set<string>();
          for (const evidenceId of parseEvidenceIds(
            verdict.evidence_ids_json,
          )) {
            const evidence = evidenceKindById.get(evidenceId) as
              | { kind: string }
              | undefined;
            if (evidence !== undefined) citedKinds.add(evidence.kind);
          }
          if (change.afterKinds.every((kind) => citedKinds.has(kind))) {
            continue;
          }
          staleVerdict.run(
            migratedAt,
            "validation strategy strengthened by migration 0009",
            verdict.id,
          );
          traceFor(traces, verdict.spec_id).staledVerdictIds.push(verdict.id);
        }
      }

      // (5) Durable trace, one row per touched spec. Written with frozen raw
      // SQL matching the spec_events column shape — a migration must not bind
      // the live SpecEventsPublisher (the 0008 freeze lesson); the migration
      // test proves the row parses through the live events repo. Guarded on
      // "something changed" so a replay writes no duplicate trace.
      const insertTrace = db.prepare(
        `INSERT INTO spec_events
           (spec_id, occurred_at, event_type, actor_json, payload_json)
         VALUES (?, ?, 'spec-evidence-changed', ?, ?)`,
      );
      for (const [specId, trace] of traces) {
        insertTrace.run(
          specId,
          migratedAt,
          stableStringify({ kind: "system" }),
          stableStringify({
            kind: "evidence-kind-vocabulary-migrated",
            strategyChanges: trace.strategyChanges,
            removedEvidenceIds: trace.removedEvidenceIds,
            staledVerdictIds: trace.staledVerdictIds,
            reopenedClaimIds: trace.reopenedClaimIds,
          }),
        );
      }

      // (6) Unconditional compatibility stamp: the chain runs on fresh
      // databases too, and an unstamped fresh DB would let an old build open
      // it later and re-insert dropped-kind rows.
      const stamped = db
        .prepare(
          `INSERT OR IGNORE INTO schema_migrations (version, description)
           VALUES (?, ?)`,
        )
        .run(MIGRATION_SCHEMA_VERSION, MIGRATION_SCHEMA_DESCRIPTION);

      logger.info("state-store.migration_evidence_kinds_narrowed", {
        migration: MIGRATION_NAME,
        rewrittenStrategyCount: [...traces.values()].reduce(
          (sum, trace) => sum + trace.strategyChanges.length,
          0,
        ),
        removedEvidenceCount: deletedIds.size,
        touchedSpecCount: traces.size,
        versionStamped: stamped.changes === 1,
      });
    });
    migrate.immediate();
  },
};
