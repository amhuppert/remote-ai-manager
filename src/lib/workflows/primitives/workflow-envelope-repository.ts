/**
 * Workflow envelope repository for the workflow primitive layer.
 *
 * High-level service over `WorkflowEnvelopeStore` that owns the lifecycle
 * invariants (immutable identity, auto-stamped `updatedAt`, automatic
 * `completedAt` on terminal transitions, automatic `pause` clearing on resume)
 * and the discovery query surface (`listActive`, `listByStatus`, `listAll`,
 * `listChildren`).
 *
 * Atomicity lives in the store layer. The repository delegates every
 * read-modify-write to `store.upsert(workflowId, mutator)`, so the production
 * `createSessionStateWorkflowEnvelopeStore` can route the entire mutation
 * through `mutateSession` / the session-state write queue, and the in-memory
 * store can apply a per-key promise chain — both without extra locking here.
 *
 * The repository deliberately keeps the envelope minimal. Feature-specific
 * recovery decisions stay with the owning workflow's snapshot.
 */

import { createLogger } from "@/lib/logging";
import type { WorkflowEnvelopeStore } from "./workflow-envelope-store";
import {
  workflowEnvelopeSchema,
  type WorkflowEnvelope,
  type WorkflowEnvelopePause,
  type WorkflowEnvelopeStatus,
} from "./workflow-envelope-vocabulary";

const logger = createLogger(
  "workflows.primitives.workflow-envelope.repository",
);

const TERMINAL_STATUSES: ReadonlySet<WorkflowEnvelopeStatus> = new Set([
  "completed",
  "failed",
]);

const ACTIVE_STATUSES: ReadonlySet<WorkflowEnvelopeStatus> = new Set([
  "running",
  "paused",
]);

const IMMUTABLE_FIELDS = ["workflowId", "workflowType", "createdAt"] as const;
type ImmutableField = (typeof IMMUTABLE_FIELDS)[number];

export interface WorkflowEnvelopeRepositoryDeps {
  store: WorkflowEnvelopeStore;
  now?: () => string;
}

export interface WorkflowEnvelopeRepository {
  create(envelope: WorkflowEnvelope): Promise<WorkflowEnvelope>;
  update(
    workflowId: string,
    patch: Partial<WorkflowEnvelope>,
  ): Promise<WorkflowEnvelope>;
  /**
   * Project a paused state onto the envelope. The supplied pause carries the
   * shared `pauseKind` so a mid-turn ask-user pause stays distinguishable from
   * a post-turn approval pause after a server restart.
   */
  markPaused(
    workflowId: string,
    pause: WorkflowEnvelopePause,
  ): Promise<WorkflowEnvelope>;
  /**
   * Mark the envelope as failed with a shared failure summary suitable for
   * restart inspection. Domain-specific recovery decisions stay in the
   * feature-owned snapshot.
   */
  markFailed(
    workflowId: string,
    errorSummary: string,
  ): Promise<WorkflowEnvelope>;
  /** Resume a paused envelope, clearing the pause projection. */
  markRunning(workflowId: string): Promise<WorkflowEnvelope>;
  /** Mark the envelope as completed and clear any residual pause projection. */
  markCompleted(workflowId: string): Promise<WorkflowEnvelope>;
  get(workflowId: string): Promise<WorkflowEnvelope | null>;
  listActive(): Promise<WorkflowEnvelope[]>;
  listByStatus(status: WorkflowEnvelopeStatus): Promise<WorkflowEnvelope[]>;
  listAll(): Promise<WorkflowEnvelope[]>;
  /**
   * Discover child workflows from their parent. Restart-safe because the
   * parent linkage lives in the durable envelope, not in transient memory.
   */
  listChildren(parentWorkflowId: string): Promise<WorkflowEnvelope[]>;
}

export function createWorkflowEnvelopeRepository(
  deps: WorkflowEnvelopeRepositoryDeps,
): WorkflowEnvelopeRepository {
  const now = deps.now ?? (() => new Date().toISOString());
  const { store } = deps;

  return {
    async create(envelope) {
      const timestamp = now();
      const stamped: WorkflowEnvelope = {
        ...envelope,
        createdAt: envelope.createdAt ?? timestamp,
        updatedAt: envelope.updatedAt ?? timestamp,
      };
      const parsed = workflowEnvelopeSchema.parse(stamped);
      const result = await store.upsert(parsed.workflowId, (existing) => {
        if (existing) {
          throw new Error(
            `Workflow envelope for ${parsed.workflowId} already exists`,
          );
        }
        return parsed;
      });
      logger.info("workflow-envelope.repository.create", {
        workflowId: result.workflowId,
        workflowType: result.workflowType,
        status: result.status,
        phase: result.phase,
      });
      return result;
    },

    async update(workflowId, patch) {
      for (const field of IMMUTABLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) {
          throw new Error(
            `Workflow envelope field "${field as ImmutableField}" is immutable`,
          );
        }
      }

      const result = await store.upsert(workflowId, (existing) => {
        if (!existing) {
          throw new Error(`Workflow envelope for ${workflowId} not found`);
        }

        const timestamp = now();
        const nextStatus = patch.status ?? existing.status;
        const merged: WorkflowEnvelope = {
          ...existing,
          ...patch,
          workflowId: existing.workflowId,
          workflowType: existing.workflowType,
          createdAt: existing.createdAt,
          updatedAt: patch.updatedAt ?? timestamp,
        };

        if (
          nextStatus !== "paused" &&
          !Object.prototype.hasOwnProperty.call(patch, "pause")
        ) {
          delete merged.pause;
        }

        if (
          patch.status !== undefined &&
          TERMINAL_STATUSES.has(patch.status) &&
          merged.completedAt === undefined
        ) {
          merged.completedAt = timestamp;
        }

        return workflowEnvelopeSchema.parse(merged);
      });
      logger.info("workflow-envelope.repository.update", {
        workflowId: result.workflowId,
        status: result.status,
        phase: result.phase,
      });
      return result;
    },

    async markPaused(workflowId, pause) {
      return this.update(workflowId, {
        status: "paused",
        pause,
      });
    },

    async markFailed(workflowId, errorSummary) {
      return this.update(workflowId, {
        status: "failed",
        errorSummary,
      });
    },

    async markRunning(workflowId) {
      return this.update(workflowId, {
        status: "running",
      });
    },

    async markCompleted(workflowId) {
      return this.update(workflowId, {
        status: "completed",
      });
    },

    async get(workflowId) {
      return store.read(workflowId);
    },

    async listActive() {
      const all = await store.listAll();
      return all.filter((e) => ACTIVE_STATUSES.has(e.status));
    },

    async listByStatus(status) {
      const all = await store.listAll();
      return all.filter((e) => e.status === status);
    },

    async listAll() {
      return store.listAll();
    },

    async listChildren(parentWorkflowId) {
      const all = await store.listAll();
      return all.filter((e) => e.parentWorkflowId === parentWorkflowId);
    },
  };
}
