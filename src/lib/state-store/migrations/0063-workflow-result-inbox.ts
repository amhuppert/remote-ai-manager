import type { StateMigration } from "./types";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "../schemas";
import {
  WORKFLOW_RESULT_EVIDENCE_SCHEMA_VERSION,
  KNOWN_SCHEMA_VERSION,
  migrateWorkflowResultEvidenceSchema,
} from "../state-db";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { createGraphWorkflowResultDeliveriesRepo } from "../graph-workflow-result-deliveries-repo";
import { importSubscriptionDelivery } from "../subscription-delivery-import";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
  type SourceFact,
  type SubscriptionDelivery,
} from "@/lib/subscriptions/schemas";
import {
  projectRecordedWorkflowSourceFact,
  projectLegacyWorkflowSourceFact,
} from "@/lib/subscriptions/workflow-source";
import type { GraphWorkflowResultDelivery } from "@/lib/workflow-graph/schemas";
import { createGraphWorkflowEventsRepo } from "../graph-workflow-events-repo";
import { stableStringify } from "@/lib/shared/stable-stringify";
import {
  activeSubscriptionWaitSchema,
  subscriptionWakeBatchSchema,
} from "@/lib/subscriptions/active-wait-schemas";

const resultIdentitySchema = z.object({
  project_path: z.string(),
  session_name: z.string(),
  execution_id: z.string(),
  boundary_seq: z.number(),
});
const savedDeliverySchema = subscriptionDeliverySchema
  .omit({ recipient: true, source: true, fact: true })
  .extend({
    projectPath: z.string(),
    conversationId: z.string(),
    sourceId: z.string(),
    factJson: z.string(),
  });
function identity(prefix: string, parts: readonly (string | number)[]) {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}
export function workflowResultMigrationFollowId(
  recipient: SubscriptionDelivery["recipient"],
  executionId: string,
): string {
  return identity("workflow-result-follow", [
    recipient.projectPath,
    recipient.conversationId,
    executionId,
  ]);
}
export function workflowResultMigrationDeliveryId(
  recipient: SubscriptionDelivery["recipient"],
  executionId: string,
  boundarySeq: number,
): string {
  return identity("workflow-result-import", [
    recipient.projectPath,
    recipient.conversationId,
    executionId,
    boundarySeq,
  ]);
}
function subscriptionFor(db: Db, delivery: SubscriptionDelivery) {
  const head = z
    .object({ head: z.number().int().nonnegative() })
    .parse(
      db
        .prepare(
          "SELECT COALESCE(MAX(id),0) AS head FROM graph_workflow_events WHERE project_path=? AND execution_id=?",
        )
        .get(delivery.recipient.projectPath, delivery.source.id),
    ).head;
  return conversationSubscriptionSchema.parse({
    id: workflowResultMigrationFollowId(delivery.recipient, delivery.source.id),
    recipient: delivery.recipient,
    source: delivery.source,
    reason: "Workflow result evidence",
    mode: "passive",
    eventKinds: null,
    expiresAt: null,
    status: "following",
    // Outstanding ledger rows are imported directly; an automatic follow
    // must not reinterpret unrelated pre-cutover boundaries as new feedback.
    cursor: String(head),
    createdAt: delivery.recordedAt,
    updatedAt: delivery.recordedAt,
    unfollowedAt: null,
    pausedAt: null,
    missingAt: null,
    lastError: null,
  });
}
export function readSavedWorkflowDeliveries(db: Db): SubscriptionDelivery[] {
  const rows = db
    .prepare(
      `SELECT id,subscription_id AS subscriptionId,
    project_path AS projectPath,conversation_id AS conversationId,source_id AS sourceId,
    fact_json AS factJson,recorded_at AS recordedAt,state,attempt_id AS attemptId,
    attempt_count AS attemptCount,queued_at AS queuedAt,accepted_at AS acceptedAt,
    finished_at AS finishedAt,last_error AS lastError
    FROM conversation_subscription_deliveries WHERE source_kind='workflow'`,
    )
    .all();
  return rows.map((raw) => {
    try {
      const { projectPath, conversationId, sourceId, factJson, ...receipt } =
        savedDeliverySchema.parse(raw);
      return subscriptionDeliverySchema.parse({
        ...receipt,
        recipient: { projectPath, conversationId },
        source: { kind: "workflow", id: sourceId },
        fact: JSON.parse(factJson) as unknown,
      });
    } catch (error) {
      const identity = z.object({ id: z.string() }).safeParse(raw);
      throw new Error(
        `Cannot migrate historical workflow inbox delivery ${identity.success ? identity.data.id : "unknown"}: invalid saved fact or receipt`,
        { cause: error },
      );
    }
  });
}
interface RecordedBoundary {
  projectPath: string;
  executionId: string;
  boundarySeq: number;
  recordedAt: string;
  kind: string;
  status: string;
  terminalTimes: string[];
  fact: SourceFact;
}
function recordedBoundary(
  result: GraphWorkflowResultDelivery,
): RecordedBoundary {
  const fact = projectRecordedWorkflowSourceFact(result);
  const abandonment = z
    .object({ abandonedAt: z.string() })
    .safeParse(result.payload.abandonment);
  return {
    projectPath: result.projectPath,
    executionId: result.executionId,
    boundarySeq: result.boundarySeq,
    recordedAt: result.recordedAt,
    kind:
      typeof result.payload.boundaryKind === "string"
        ? result.payload.boundaryKind
        : "unknown",
    status: fact.outcome ?? "unknown",
    terminalTimes: [
      result.recordedAt,
      ...(typeof result.payload.completedAt === "string"
        ? [result.payload.completedAt]
        : []),
      ...(abandonment.success ? [abandonment.data.abandonedAt] : []),
    ],
    fact,
  };
}
function readBoundaries(
  db: Db,
  results: readonly GraphWorkflowResultDelivery[],
) {
  const boundaries = new Map(
    results.map((result) => {
      const boundary = recordedBoundary(result);
      return [
        JSON.stringify([
          boundary.projectPath,
          boundary.executionId,
          boundary.boundarySeq,
        ]),
        boundary,
      ] as const;
    }),
  );
  const events = createGraphWorkflowEventsRepo(db);
  for (const raw of db
    .prepare(
      "SELECT project_path,session_name,execution_id,id AS boundary_seq FROM graph_workflow_events WHERE event_type='graph-workflow-boundary'",
    )
    .all()) {
    const identity = resultIdentitySchema.parse(raw);
    const key = JSON.stringify([
      identity.project_path,
      identity.execution_id,
      identity.boundary_seq,
    ]);
    if (boundaries.has(key)) continue;
    const record = events.findRecordById(
      identity.project_path,
      identity.session_name,
      identity.execution_id,
      identity.boundary_seq,
    );
    if (!record || record.event.type !== "graph-workflow-boundary")
      throw Error("A stored workflow boundary disappeared during migration");
    const event = record.event;
    boundaries.set(key, {
      projectPath: record.projectPath,
      executionId: record.executionId,
      boundarySeq: record.id,
      recordedAt: record.occurredAt,
      kind: event.boundaryKind,
      status: event.workflowStatus,
      terminalTimes: [
        record.occurredAt,
        ...(typeof event.completedAt === "string" ? [event.completedAt] : []),
        ...(event.abandonment ? [event.abandonment.abandonedAt] : []),
      ],
      fact: projectLegacyWorkflowSourceFact(record),
    });
  }
  return boundaries;
}
function redirectDeliveryLinks(db: Db, oldId: string, newId: string) {
  for (const raw of db
    .prepare(
      "SELECT id,payload_json FROM conversation_subscription_waits WHERE delivery_id=?",
    )
    .all(oldId)) {
    const row = z
      .object({ id: z.string(), payload_json: z.string() })
      .parse(raw);
    const wait = activeSubscriptionWaitSchema.parse(
      JSON.parse(row.payload_json),
    );
    db.prepare(
      "UPDATE conversation_subscription_waits SET delivery_id=?,payload_json=? WHERE id=?",
    ).run(newId, JSON.stringify({ ...wait, deliveryId: newId }), row.id);
  }
  for (const raw of db
    .prepare(
      "SELECT id,payload_json FROM conversation_subscription_wake_batches",
    )
    .all()) {
    const row = z
      .object({ id: z.string(), payload_json: z.string() })
      .parse(raw);
    const batch = subscriptionWakeBatchSchema.parse(
      JSON.parse(row.payload_json),
    );
    if (!batch.deliveryIds.includes(oldId)) continue;
    db.prepare(
      "UPDATE conversation_subscription_wake_batches SET payload_json=? WHERE id=?",
    ).run(
      JSON.stringify({
        ...batch,
        deliveryIds: [
          ...new Set(
            batch.deliveryIds.map((id) => (id === oldId ? newId : id)),
          ),
        ],
      }),
      row.id,
    );
  }
  db.prepare(
    `INSERT OR IGNORE INTO conversation_subscription_read_state(project_path,conversation_id,delivery_id,read_at)
    SELECT project_path,conversation_id,?,read_at FROM conversation_subscription_read_state WHERE delivery_id=?`,
  ).run(newId, oldId);
  db.prepare(
    "DELETE FROM conversation_subscription_read_state WHERE delivery_id=?",
  ).run(oldId);
}
function normalizeLegacyTerminalDeliveries(
  db: Db,
  boundaries: readonly RecordedBoundary[],
) {
  for (const saved of readSavedWorkflowDeliveries(db)) {
    if (
      saved.fact.eventKind !== "graph-workflow-terminal" ||
      saved.fact.occurrenceId !==
        `one-time-terminal:workflow:${saved.source.id}`
    )
      continue;
    const candidates = boundaries.filter(
      (boundary) =>
        boundary.projectPath === saved.recipient.projectPath &&
        boundary.executionId === saved.source.id &&
        ["halt", "completion", "abandon", "abort"].includes(boundary.kind) &&
        boundary.status === saved.fact.outcome &&
        Date.parse(boundary.recordedAt) <= Date.parse(saved.recordedAt),
    );
    const exact = candidates.filter((boundary) =>
      boundary.terminalTimes.some(
        (time) => Date.parse(time) === Date.parse(saved.fact.occurredAt),
      ),
    );
    const matching = exact.length ? exact : candidates;
    if (matching.length === 1) {
      const boundary = matching[0];
      if (!boundary) throw Error("Expected one matching workflow boundary");
      const normalizedFact =
        saved.fact.sourceText === undefined
          ? boundary.fact
          : { ...saved.fact, occurrenceId: boundary.fact.occurrenceId };
      const existing = db
        .prepare(
          `SELECT id FROM conversation_subscription_deliveries
        WHERE project_path=? AND conversation_id=? AND source_kind='workflow' AND source_id=? AND occurrence_id=?`,
        )
        .get(
          saved.recipient.projectPath,
          saved.recipient.conversationId,
          saved.source.id,
          boundary.fact.occurrenceId,
        );
      if (!existing)
        db.prepare(
          "UPDATE conversation_subscription_deliveries SET occurrence_id=?,fact_json=? WHERE id=?",
        ).run(
          boundary.fact.occurrenceId,
          JSON.stringify(normalizedFact),
          saved.id,
        );
      const merged = importSubscriptionDelivery(db, {
        subscription: subscriptionFor(db, saved),
        delivery: { ...saved, fact: normalizedFact },
      });
      if (merged.id !== saved.id) {
        redirectDeliveryLinks(db, saved.id, merged.id);
        db.prepare(
          "DELETE FROM conversation_subscription_deliveries WHERE id=?",
        ).run(saved.id);
      }
      continue;
    }
    importSubscriptionDelivery(db, {
      subscription: subscriptionFor(db, saved),
      delivery: {
        ...saved,
        fact: {
          ...saved.fact,
          sourceText: stableStringify({
            evidence: "legacy-terminal-receipt",
            fact: saved.fact,
            limitations: matching.length
              ? "The exact historical terminal boundary is ambiguous; candidate notices require inspection before replay."
              : "No exact historical terminal boundary evidence is available.",
          }),
        },
      },
    });
    if (!["accepted", "uncertain", "queued"].includes(saved.state)) continue;
    for (const boundary of matching) {
      const delivery: SubscriptionDelivery = {
        ...saved,
        id: identity("workflow-result-ambiguous", [
          saved.recipient.projectPath,
          saved.recipient.conversationId,
          saved.source.id,
          boundary.boundarySeq,
        ]),
        fact: boundary.fact,
        state: "uncertain",
        acceptedAt: null,
        lastError:
          "Legacy workflow terminal receipt has ambiguous boundary identity; inspect before replay.",
      };
      importSubscriptionDelivery(db, {
        subscription: subscriptionFor(db, delivery),
        delivery,
      });
    }
  }
}

export const workflowResultInbox: StateMigration = {
  name: "0063-workflow-result-inbox",
  up: async ({ context }) => {
    if (context.configDir !== null)
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        WORKFLOW_RESULT_EVIDENCE_SCHEMA_VERSION,
      );
    context.db
      .transaction(() => {
        const db = context.db;
        enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
        migrateWorkflowResultEvidenceSchema(db);
        const repo = createGraphWorkflowResultDeliveriesRepo(db);
        const results = db
          .prepare(
            "SELECT project_path,session_name,execution_id,boundary_seq FROM graph_workflow_result_deliveries",
          )
          .all()
          .map((raw) => {
            const row = resultIdentitySchema.parse(raw);
            try {
              const result = repo.findByBoundary(
                row.project_path,
                row.session_name,
                row.execution_id,
                row.boundary_seq,
              );
              if (!result)
                throw Error(
                  "A recorded workflow boundary disappeared during migration",
                );
              return result;
            } catch (error) {
              throw new Error(
                `Cannot migrate historical workflow boundary ${row.execution_id}:${row.boundary_seq} (${row.project_path}/${row.session_name}): invalid saved evidence`,
                { cause: error },
              );
            }
          });
        const byIdentity = readBoundaries(db, results);
        normalizeLegacyTerminalDeliveries(db, [...byIdentity.values()]);
        const savedReceipts = new Map(
          readSavedWorkflowDeliveries(db).map((saved) => [
            JSON.stringify([
              saved.recipient.projectPath,
              saved.recipient.conversationId,
              saved.source.id,
              saved.fact.occurrenceId,
            ]),
            saved,
          ]),
        );
        for (const result of results) {
          if (result.originConversationId === null) continue;
          const exists = db
            .prepare(
              `SELECT 1 FROM conversations WHERE project_path=? AND id=?
          UNION ALL SELECT 1 FROM project_conversations WHERE project_path=? AND id=? LIMIT 1`,
            )
            .get(
              result.projectPath,
              result.originConversationId,
              result.projectPath,
              result.originConversationId,
            );
          if (!exists) continue;
          const fallback =
            result.state === "delivered" && result.attemptId === null;
          const delivery = subscriptionDeliverySchema.parse({
            id: workflowResultMigrationDeliveryId(
              {
                projectPath: result.projectPath,
                conversationId: result.originConversationId,
              },
              result.executionId,
              result.boundarySeq,
            ),
            subscriptionId: identity("workflow-result-follow", [
              result.projectPath,
              result.originConversationId,
              result.executionId,
            ]),
            recipient: {
              projectPath: result.projectPath,
              conversationId: result.originConversationId,
            },
            source: { kind: "workflow", id: result.executionId },
            fact: projectRecordedWorkflowSourceFact(result),
            recordedAt: result.recordedAt,
            state:
              fallback || result.state === "delivering"
                ? "uncertain"
                : result.state === "delivered"
                  ? "accepted"
                  : "pending",
            attemptId: result.attemptId,
            attemptCount: result.attemptCount,
            queuedAt: null,
            acceptedAt:
              !fallback && result.state === "delivered"
                ? result.deliveredAt
                : null,
            finishedAt: result.deliveredAt,
            lastError: fallback
              ? "Legacy missing-origin fallback settled this evidence without backend acceptance."
              : result.state === "delivering"
                ? "Legacy workflow result claim has no durable backend acceptance receipt."
                : null,
          });
          const incumbent = fallback
            ? savedReceipts.get(
                JSON.stringify([
                  delivery.recipient.projectPath,
                  delivery.recipient.conversationId,
                  delivery.source.id,
                  delivery.fact.occurrenceId,
                ]),
              )
            : undefined;
          // A missing-origin fallback contains no runtime admission attempt.
          // It can enrich recorded evidence, but cannot outrank an inbox receipt.
          importSubscriptionDelivery(db, {
            subscription: subscriptionFor(db, delivery),
            delivery: incumbent
              ? { ...incumbent, fact: delivery.fact }
              : delivery,
          });
        }
        // Other subscribers already use the canonical boundary id. Upgrade their
        // saved summary while retaining their independent acceptance/read receipt.
        for (const saved of readSavedWorkflowDeliveries(db)) {
          const boundary = byIdentity.get(
            JSON.stringify([
              saved.recipient.projectPath,
              saved.source.id,
              Number(saved.fact.occurrenceId),
            ]),
          );
          if (!boundary) continue;
          importSubscriptionDelivery(db, {
            subscription: subscriptionFor(db, saved),
            delivery: { ...saved, fact: boundary.fact },
          });
        }
        db.prepare(
          "INSERT OR IGNORE INTO schema_migrations(version,description) VALUES (?,?)",
        ).run(
          WORKFLOW_RESULT_EVIDENCE_SCHEMA_VERSION,
          "workflow boundary delivery moves to canonical subscription receipts",
        );
      })
      .immediate();
  },
};
