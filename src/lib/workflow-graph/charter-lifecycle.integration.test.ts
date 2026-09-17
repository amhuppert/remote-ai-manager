import { describe, expect, it } from "vitest";

import type { GlobalConfig } from "@/lib/config/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowSSEEvent,
} from "@/lib/workflow-graph/event-schemas";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";

import { computeCharterHash } from "./charter/render";
import { createWorkflowCharterService } from "./charter/service";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { createGraphWorkflowExecutionRepository } from "./execution-repository";
import {
  createInMemoryLeaseReservation,
  createWorkflowDefinition,
  makeLaunchDocument,
} from "./test-fixtures";
/**
 * Charter lifecycle INTEGRATION suite (task 5.3).
 *
 * The observables are exercised end-to-end through the REAL services with DI
 * seams only (no `vi.mock` of internal modules):
 *
 * - Observability: the real execution-repository seed path with a real charter
 *   service + real event publisher (capturing broadcast) records and broadcasts
 *   a charter-registered event carrying the charter hash (7.1, 7.3).
 *
 * Charter acceptance (create/replace rejecting a charter-less or invalid-charter
 * definition) is now enforced at the plan-validation layer and covered by
 * `plan-validation.test.ts`.
 */

// ---------------------------------------------------------------------------
// Observability: real seed path records + broadcasts charter-registered.
// ---------------------------------------------------------------------------

const WORKTREE_PATH = "/repo/.worktrees/session-1";

function makeSession(): SessionState {
  return {
    worktreePath: WORKTREE_PATH,
    graphWorkflowExecution: null,
  } as unknown as SessionState;
}

/**
 * Real execution repository whose seed path runs the real charter service and
 * real event publisher; the only seams are a capturing broadcast and an
 * in-memory fs writer so no disk is touched.
 */
function setupObservability() {
  const sessions = new Map<string, SessionState>();
  const broadcasts: GraphWorkflowSSEEvent[] = [];
  const appendedEvents: GraphWorkflowExecutionEvent[] = [];

  const eventPublisher = createGraphWorkflowExecutionEventPublisher({
    broadcast(event) {
      broadcasts.push(event);
    },
  });
  const charterService = createWorkflowCharterService({
    writeFile: async () => {},
    ensureDir: async () => {},
    publishCharterRegistered: eventPublisher.publishCharterRegistered,
  });

  const repo = createGraphWorkflowExecutionRepository({
    getGraphWorkflowPendingArtifacts: async () => null,
    clearGraphWorkflowPendingArtifacts: async () => false,

    // No git worktree in this harness; the real exclusion would shell out.
    ensureCcArtifactsExcluded: async () => {},
    async getSession(projectPath, sessionName) {
      const key = `${projectPath}:${sessionName}`;
      let session = sessions.get(key);
      if (!session) {
        session = makeSession();
        sessions.set(key, session);
      }
      return session;
    },
    async getActiveGraphWorkflowExecution(projectPath, sessionName) {
      const key = `${projectPath}:${sessionName}`;
      let session = sessions.get(key);
      if (!session) {
        session = makeSession();
        sessions.set(key, session);
      }
      return session.graphWorkflowExecution;
    },
    async mutateActiveGraphWorkflowExecution(
      projectPath,
      sessionName,
      _label,
      mutate,
    ) {
      const key = `${projectPath}:${sessionName}`;
      let session = sessions.get(key);
      if (!session) {
        session = makeSession();
        sessions.set(key, session);
      }
      const decision = mutate(session.graphWorkflowExecution);
      if (decision.kind === "no_commit")
        return {
          kind: "not_committed" as const,
          execution: session.graphWorkflowExecution,
          value: decision.value,
        };
      const { execution, events, pushes } = decision;
      session.graphWorkflowExecution = execution;
      appendedEvents.push(...events);
      // Mirror the production seam: commit the rows and hand the committed
      // delivery back; the repository performs delivery post-commit.
      return {
        kind: "committed" as const,
        value: decision.value,
        execution,
        delivery: { events, pushes: pushes ?? [] },
      };
    },
    reserveActiveGraphWorkflowExecution: createInMemoryLeaseReservation({
      readActive: (projectPath, sessionName) =>
        sessions.get(`${projectPath}:${sessionName}`)?.graphWorkflowExecution ??
        null,
      installActive: (projectPath, sessionName, execution) => {
        const key = `${projectPath}:${sessionName}`;
        let session = sessions.get(key);
        if (!session) {
          session = makeSession();
          sessions.set(key, session);
        }
        session.graphWorkflowExecution = execution;
      },
      onEvents: (events) => appendedEvents.push(...events),
    }),
    async archiveActiveGraphWorkflowExecution(projectPath, sessionName) {
      const key = `${projectPath}:${sessionName}`;
      const session = sessions.get(key);
      const archived = session?.graphWorkflowExecution ?? null;
      if (session) session.graphWorkflowExecution = null;
      return archived === null
        ? { archived: false as const, reason: "no_active" as const }
        : { archived: true as const, execution: archived };
    },

    eventPublisher,
    charterService,
    readConfig: async () => ({}) as GlobalConfig,
  });

  return { repo, sessions, broadcasts, appendedEvents };
}

describe("charter lifecycle integration — Observability", () => {
  it("broadcasts and records a charter-registered event carrying the charter hash on seed", async () => {
    const charter = makeTestCharter({ mission: "Observe my registration" });
    const definition: WorkflowSemanticDefinition = createWorkflowDefinition({
      charter,
    });
    const { repo, sessions, broadcasts, appendedEvents } = setupObservability();

    await repo.create("/repo", "session-1", {
      definition,
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 3,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(definition),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    // 7.3: broadcast in real time to connected clients.
    const broadcast = broadcasts.find(
      (event) => event.type === "graph-workflow-charter-registered",
    );
    expect(broadcast).toBeDefined();
    expect(broadcast).toMatchObject({
      executionId: "exec-1",
      definitionId: "wf-1",
      definitionRevision: 3,
      charterHash: computeCharterHash(charter),
    });

    // 7.1: recorded in the execution audit log (the persisted history).
    const stored = sessions.get("/repo:session-1")?.graphWorkflowExecution;
    expect(stored).not.toBeNull();
    expect(stored?.charter).toEqual(charter);
    const recorded = appendedEvents.find(
      (entry) => entry.event.type === "graph-workflow-charter-registered",
    );
    expect(recorded).toBeDefined();
    expect(recorded?.event).toMatchObject({
      charterHash: computeCharterHash(charter),
    });
  });
});
