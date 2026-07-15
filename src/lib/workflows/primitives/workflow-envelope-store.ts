/**
 * Workflow envelope persistence for the workflow primitive layer.
 *
 * The store seam owns atomicity. The repository is a thin lifecycle service
 * that delegates all read-modify-write through `upsert`, so every store
 * implementation is responsible for serializing concurrent operations on the
 * same `workflowId` (and, for production, against the wider session-state
 * mutex). Two implementations are exposed:
 *
 *  - `createInMemoryWorkflowEnvelopeStore` — used by tests; serializes per
 *    `workflowId` via an in-memory promise chain so concurrent updates do not
 *    interleave a read→merge→write sequence.
 *  - `createSessionStateWorkflowEnvelopeStore` — used by production; routes
 *    every write through `mutateSession` so the session-state write queue
 *    covers the read-modify-write, and envelope writes are serialized
 *    against any other session-state mutation.
 */

import path from "node:path";
import { createLogger } from "@/lib/logging";
import { createKeyedMutex } from "@/lib/shared/keyed-mutex";
import {
  workflowEnvelopeSchema,
  type WorkflowEnvelope,
} from "./workflow-envelope-vocabulary";
import type { ArtifactRegistry } from "./artifact-registry";

const logger = createLogger("workflows.primitives.workflow-envelope.store");

type WorkflowEnvelopeMutator = (
  existing: WorkflowEnvelope | null,
) => WorkflowEnvelope | Promise<WorkflowEnvelope>;

export interface WorkflowEnvelopeStore {
  read(workflowId: string): Promise<WorkflowEnvelope | null>;
  /**
   * Atomic read-modify-write keyed by `workflowId`. The store passes the
   * current envelope (or null when none exists), receives the next envelope,
   * validates it, and persists it before returning. Implementations MUST
   * serialize concurrent calls for the same workflowId so a slow mutator
   * cannot lose a concurrent write.
   */
  upsert(
    workflowId: string,
    mutator: WorkflowEnvelopeMutator,
  ): Promise<WorkflowEnvelope>;
  delete(workflowId: string): Promise<void>;
  listAll(): Promise<WorkflowEnvelope[]>;
}

export function createInMemoryWorkflowEnvelopeStore(): WorkflowEnvelopeStore {
  const records = new Map<string, WorkflowEnvelope>();
  const upsertMutex = createKeyedMutex();

  function withKeyLock<T>(
    workflowId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return upsertMutex.run(workflowId, fn);
  }

  return {
    async read(workflowId) {
      const found = records.get(workflowId);
      return found ? clone(found) : null;
    },

    async upsert(workflowId, mutator) {
      return withKeyLock(workflowId, async () => {
        const existing = records.get(workflowId) ?? null;
        const next = await mutator(existing ? clone(existing) : null);
        const parsed = workflowEnvelopeSchema.parse(next);
        if (parsed.workflowId !== workflowId) {
          throw new Error(
            `Mutator returned an envelope with workflowId "${parsed.workflowId}" but upsert was called with "${workflowId}"`,
          );
        }
        records.set(parsed.workflowId, clone(parsed));
        logger.debug("workflow-envelope.store.upsert", {
          workflowId: parsed.workflowId,
          workflowType: parsed.workflowType,
          status: parsed.status,
          phase: parsed.phase,
        });
        return clone(parsed);
      });
    },

    async delete(workflowId) {
      const removed = records.delete(workflowId);
      if (removed) {
        logger.debug("workflow-envelope.store.delete", { workflowId });
      }
    },

    async listAll() {
      return [...records.values()].map(clone);
    },
  };
}

function clone(envelope: WorkflowEnvelope): WorkflowEnvelope {
  return structuredClone(envelope);
}

export interface SessionStateWorkflowEnvelopeStoreDeps {
  /**
   * Focused single-column mutator of the session's `workflow_envelopes` map. In
   * production this is `mutateSessionWorkflowEnvelopes` from `@/lib/state-store`,
   * which loads only the target session and persists the one column — skipping
   * the whole-state read/validate/diff cycle the generic `mutateSession` runs.
   * Envelope writes still inherit the session-state write queue that serializes
   * every other session-state mutation. The callback receives the envelopes map
   * directly (mutated in place).
   */
  mutateEnvelopes: <T>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (envelopes: Record<string, unknown>) => T | Promise<T>,
  ) => Promise<T>;
  /**
   * Read-only accessor used by `read()` and `listAll()`. Returns `null` when
   * the session does not exist (treated as an empty envelope set).
   */
  getSession: (
    projectPath: string,
    sessionName: string,
  ) => Promise<SessionStateLike | null>;
  projectPath: string;
  sessionName: string;
}

/**
 * Minimal shape we touch on the `SessionState`. Kept structural (not a Zod
 * type import) so this store does not pull `schemas.ts` into its module
 * graph.
 */
export interface SessionStateLike {
  workflowEnvelopes?: Record<string, unknown>;
}

export function createSessionStateWorkflowEnvelopeStore(
  deps: SessionStateWorkflowEnvelopeStoreDeps,
): WorkflowEnvelopeStore {
  const { mutateEnvelopes, getSession, projectPath, sessionName } = deps;

  return {
    async read(workflowId) {
      const session = await getSession(projectPath, sessionName);
      const raw = session?.workflowEnvelopes?.[workflowId];
      if (raw === undefined) return null;
      return workflowEnvelopeSchema.parse(raw);
    },

    async upsert(workflowId, mutator) {
      return mutateEnvelopes(
        projectPath,
        sessionName,
        `workflow-envelope.upsert[${workflowId}]`,
        async (envelopes) => {
          const rawExisting = envelopes[workflowId];
          const existing =
            rawExisting === undefined
              ? null
              : workflowEnvelopeSchema.parse(rawExisting);
          const next = await mutator(existing);
          const parsed = workflowEnvelopeSchema.parse(next);
          if (parsed.workflowId !== workflowId) {
            throw new Error(
              `Mutator returned an envelope with workflowId "${parsed.workflowId}" but upsert was called with "${workflowId}"`,
            );
          }
          envelopes[parsed.workflowId] = parsed;
          logger.debug("workflow-envelope.store.upsert", {
            workflowId: parsed.workflowId,
            workflowType: parsed.workflowType,
            status: parsed.status,
            phase: parsed.phase,
            backing: "session-state",
          });
          return parsed;
        },
      );
    },

    async delete(workflowId) {
      await mutateEnvelopes(
        projectPath,
        sessionName,
        `workflow-envelope.delete[${workflowId}]`,
        (envelopes) => {
          if (workflowId in envelopes) {
            delete envelopes[workflowId];
            logger.debug("workflow-envelope.store.delete", {
              workflowId,
              backing: "session-state",
            });
          }
        },
      );
    },

    async listAll() {
      const session = await getSession(projectPath, sessionName);
      const collection = session?.workflowEnvelopes ?? {};
      const envelopes: WorkflowEnvelope[] = [];
      for (const raw of Object.values(collection)) {
        envelopes.push(workflowEnvelopeSchema.parse(raw));
      }
      return envelopes;
    },
  };
}

/**
 * Optional helper for features that need to keep envelope payloads bounded.
 * Writes the snapshot to disk via the supplied `ArtifactRegistry` and returns
 * the artifact-reference shape that should replace the inline snapshot in the
 * envelope. The reference itself is what gets persisted into the envelope so
 * the session-state document stays small even when feature snapshots grow.
 */
export interface SnapshotArtifactReference {
  kind: "artifact_reference";
  artifactId: string;
  relativePath: string;
}

export interface WriteFeatureSnapshotAsArtifactInput {
  registry: ArtifactRegistry;
  worktreePath: string;
  workflowId: string;
  snapshot: unknown;
  /**
   * Suggested relative path inside `.cc/workflow/<workflowId>/`. When omitted,
   * defaults to `snapshot.json`.
   */
  fileName?: string;
  source?: {
    workflowId?: string;
    laneId?: string;
    round?: number;
  };
}

export async function writeFeatureSnapshotAsArtifact(
  input: WriteFeatureSnapshotAsArtifactInput,
): Promise<SnapshotArtifactReference> {
  const fileName = input.fileName ?? "snapshot.json";
  const relativePath = path.posix.join(
    ".cc",
    "workflow",
    input.workflowId,
    fileName,
  );
  const record = await input.registry.write({
    kind: "validation_log",
    worktreePath: input.worktreePath,
    relativePath,
    contents: JSON.stringify(input.snapshot, null, 2),
    audience: "internal_log",
    source: input.source ?? { workflowId: input.workflowId },
  });
  return {
    kind: "artifact_reference",
    artifactId: record.artifactId,
    relativePath: record.relativePath,
  };
}
