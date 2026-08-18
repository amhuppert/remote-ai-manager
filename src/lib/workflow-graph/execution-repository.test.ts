import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig, PerRepoConfig } from "@/lib/config/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { computeCharterHash } from "./charter/render";
import { createWorkflowCharterService } from "./charter/service";
import { createWorkflowSeededDocumentService } from "./shared-documents";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import {
  GraphWorkflowValidationError,
  createGraphWorkflowExecutionRepository,
  type GraphWorkflowExecutionSeed,
} from "./execution-repository";
import { evaluateLeaseAdmission } from "./lifecycle-classifier";
import { LegacyWorkflowSchemaError } from "./schema-cutover-guard";
import { SEEDED_WORKFLOW_DEFAULTS } from "./resolve-config";
import { StaleLoopFenceError, runWithLoopFence } from "./loop-fence";
import {
  ExecutionTurnoverError,
  LaneBindingTurnoverError,
  runWithExecutionPrincipalFence,
} from "./principal-fence";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
  makeLaunchDocument,
} from "./test-fixtures";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowSSEEvent,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowPendingArtifacts,
} from "@/lib/workflow-graph/schemas";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { computeContentHash } from "@/lib/agent-profiles/hashing";

const WORKTREE_PATH = "/repo/.worktrees/session-1";

function makeSession(): SessionState {
  return {
    worktreePath: WORKTREE_PATH,
    graphWorkflowExecution: null,
  } as unknown as SessionState;
}

interface CapturedWrite {
  absolutePath: string;
  contents: string;
}

function createInMemoryRepo(
  config: GlobalConfig = {} as GlobalConfig,
  repoConfig: PerRepoConfig | null = null,
  options: {
    /** Reject the charter file write, standing in for any materialization I/O failure. */
    failCharterWrite?: boolean;
    /** Awaited inside the reservation seam, so a test can hold both racers at the CAS. */
    reserveBarrier?: () => Promise<void>;
    /** Reject the git-exclusion write that must precede every .cc file. */
    failExclusion?: boolean;
  } = {},
) {
  const sessions = new Map<string, SessionState>();
  const broadcasts: GraphWorkflowSSEEvent[] = [];
  const writes: CapturedWrite[] = [];
  /**
   * Ordered log of every durable act create() performs — `reserve` for the
   * authoritative CAS, `write:<path>` for each out-of-row file. The
   * reserve-before-side-effects invariant is an ORDER claim, so it needs an
   * ordered record rather than two independent counters.
   */
  const operations: string[] = [];
  /** Winner-only post-commit teardown of a normalized incumbent's resources. */
  const laneDevServerStops: string[] = [];
  const loggerUnregistrations: string[] = [];
  /**
   * Stand-in for the pending-artifact table: what each reserved execution still
   * owes the filesystem, contents included. Keyed exactly as production keys it,
   * so a test can prove the record outlives a failed materialization and is
   * settled by a successful one.
   */
  const pendingArtifacts = new Map<string, GraphWorkflowPendingArtifacts>();

  // Real event publisher with a capturing broadcast, and a real charter
  // service with an injected capturing fs — so create() exercises the real
  // seed-propagation path (snapshot + kind:"charter" doc + charter-registered
  // event) without touching the disk.
  const eventPublisher = createGraphWorkflowExecutionEventPublisher({
    broadcast(event) {
      broadcasts.push(event);
    },
  });
  const charterService = createWorkflowCharterService({
    writeFile: async (absolutePath, contents) => {
      operations.push(`write:${absolutePath}`);
      if (options.failCharterWrite === true) {
        throw new Error("charter write failed: disk is full");
      }
      writes.push({ absolutePath, contents: String(contents) });
    },
    ensureDir: async () => {},
    publishCharterRegistered: eventPublisher.publishCharterRegistered,
  });
  const capturedDocuments = new Map<string, string>();
  const seededDocumentService = createWorkflowSeededDocumentService({
    writeFile: async (absolutePath, contents) => {
      operations.push(`write:${absolutePath}`);
      writes.push({ absolutePath, contents: String(contents) });
    },
    ensureDir: async () => {},
    store: {
      async captureFromWorktree({ executionId, relativePath }) {
        capturedDocuments.set(`${executionId}:${relativePath}`, "captured");
      },
      async read() {
        return null;
      },
    },
  });

  const appendedEvents: GraphWorkflowExecutionEvent[] = [];
  const mutateCalls: string[] = [];
  const reserveCalls: string[] = [];
  const archived: GraphWorkflowExecution[] = [];

  function getOrCreateSession(projectPath: string, sessionName: string) {
    const key = `${projectPath}:${sessionName}`;
    let session = sessions.get(key);
    if (!session) {
      session = makeSession();
      sessions.set(key, session);
    }
    return session;
  }

  const repo = createGraphWorkflowExecutionRepository({
    async getSession(projectPath, sessionName) {
      return getOrCreateSession(projectPath, sessionName);
    },
    async getActiveGraphWorkflowExecution(projectPath, sessionName) {
      return getOrCreateSession(projectPath, sessionName)
        .graphWorkflowExecution;
    },
    async mutateActiveGraphWorkflowExecution(
      projectPath,
      sessionName,
      label,
      mutate,
    ) {
      mutateCalls.push(label);
      const session = getOrCreateSession(projectPath, sessionName);
      const { execution, events, pushes } = await mutate(
        session.graphWorkflowExecution,
      );
      session.graphWorkflowExecution = execution;
      appendedEvents.push(...events);
      // Mirror the production seam: commit the rows and hand the committed
      // delivery back; the repository performs delivery post-commit.
      return { execution, delivery: { events, pushes: pushes ?? [] } };
    },
    async reserveActiveGraphWorkflowExecution(
      projectPath,
      sessionName,
      label,
      reservation,
    ) {
      // The production seam decides admission against the row it reads inside
      // the write-queue critical section; this double mirrors that ordering
      // (read → decide → commit or refuse) so the repository's contract with
      // it is exercised rather than assumed.
      if (options.reserveBarrier) await options.reserveBarrier();
      const session = getOrCreateSession(projectPath, sessionName);
      const decision = evaluateLeaseAdmission(session.graphWorkflowExecution);
      if (decision.kind === "refuse") {
        return { reserved: false as const, refusal: decision };
      }
      operations.push("reserve");
      reserveCalls.push(label);
      // Committed by the reserving transaction itself, so it lands with the
      // row and only for the winner.
      pendingArtifacts.set(reservation.execution.id, {
        executionId: reservation.execution.id,
        projectPath,
        sessionName,
        documents: [...(reservation.seededDocuments ?? [])],
        recordedAt: "2026-04-04T00:00:00.000Z",
      });
      const normalized =
        decision.kind === "admit-with-normalization"
          ? decision.incumbent
          : null;
      const normalizedExecution =
        normalized !== null ? session.graphWorkflowExecution : null;
      if (normalizedExecution !== null) {
        archived.push(normalizedExecution);
      }
      session.graphWorkflowExecution = reservation.execution;
      appendedEvents.push(...reservation.events);
      return {
        reserved: true as const,
        execution: reservation.execution,
        delivery: {
          events: reservation.events,
          pushes: reservation.pushes ?? [],
        },
        normalized,
        normalizedExecution,
      };
    },
    async archiveActiveGraphWorkflowExecution(projectPath, sessionName) {
      const session = getOrCreateSession(projectPath, sessionName);
      const active = session.graphWorkflowExecution ?? null;
      session.graphWorkflowExecution = null;
      if (active !== null) archived.push(active);
      return active === null
        ? { archived: false as const, reason: "no_active" as const }
        : { archived: true as const, execution: active };
    },
    async markGraphWorkflowContextEventsPreReset() {
      return 0;
    },
    async getGraphWorkflowPendingArtifacts(
      projectPath,
      sessionName,
      executionId,
    ) {
      const pending = pendingArtifacts.get(executionId);
      if (!pending) return null;
      return pending.projectPath === projectPath &&
        pending.sessionName === sessionName
        ? pending
        : null;
    },
    async clearGraphWorkflowPendingArtifacts(executionId) {
      return pendingArtifacts.delete(executionId);
    },
    eventPublisher,
    charterService,
    seededDocumentService,
    readConfig: async () => config,
    readRepoConfig: async () => repoConfig,
    async stopExecutionLaneDevServers(input) {
      laneDevServerStops.push(input.execution.id);
    },
    unregisterExecutionLogger(executionId) {
      loggerUnregistrations.push(executionId);
    },
    async ensureCcArtifactsExcluded(worktreePath) {
      operations.push(`exclude:${worktreePath}`);
      if (options.failExclusion === true) {
        throw new Error("git exclusion failed: .git/info/exclude is read-only");
      }
    },
  });

  return {
    repo,
    sessions,
    broadcasts,
    writes,
    appendedEvents,
    mutateCalls,
    reserveCalls,
    archived,
    operations,
    laneDevServerStops,
    loggerUnregistrations,
    pendingArtifacts,
  };
}

describe("createGraphWorkflowExecutionRepository.create", () => {
  it("rejects a seed definition that contains contextSoftLimitTokens", async () => {
    const { repo } = createInMemoryRepo();
    const legacyDefinition = {
      ...createWorkflowDefinition(),
      executionContexts: [
        {
          id: "ctx-1",
          title: "Plan",
          acceptanceCriteria: "Plan is documented",
          agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 5,
            contextSoftLimitTokens: 100000,
          },
        },
      ],
    };

    await expect(
      repo.create("/repo", "session-1", {
        definition: legacyDefinition as never,
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(legacyDefinition as never),
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
      }),
    ).rejects.toThrow(LegacyWorkflowSchemaError);
  });

  it("rejects a seed definition that contains contextHardLimitTokens", async () => {
    const { repo } = createInMemoryRepo();
    const legacyDefinition = {
      ...createWorkflowDefinition(),
      executionContexts: [
        {
          id: "ctx-1",
          title: "Plan",
          acceptanceCriteria: "Plan is documented",
          agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
          mutability: { allowAgentTaskAdd: false },
          circuitBreaker: {},
          iterationPolicy: {
            maxIterations: 5,
            contextHardLimitTokens: 150000,
          },
        },
      ],
    };

    await expect(
      repo.create("/repo", "session-1", {
        definition: legacyDefinition as never,
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(legacyDefinition as never),
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
      }),
    ).rejects.toThrow(LegacyWorkflowSchemaError);
  });

  it("rejects a start whose selectors name commands the project registry lacks", async () => {
    const { repo, sessions } = createInMemoryRepo({} as GlobalConfig, {
      validation: {
        commands: {
          typecheck: {
            command: { full: "scripts/validate/typecheck.sh" },
            cost: 2,
            pathArgs: "forbid",
          },
        },
        preMerge: ["typecheck"],
      },
    });
    const definition = createWorkflowDefinition({
      workflowConfig: {
        scriptValidator: { commands: ["typecheck", "ghost"] },
      },
    });

    await expect(
      repo.create("/repo", "session-1", {
        definition,
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(definition),
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
      }),
    ).rejects.toMatchObject({
      name: "GraphWorkflowValidationError",
      errors: [
        expect.objectContaining({
          code: "unknown-validation-command",
          field: "workflowConfig.scriptValidator.commands.1",
        }),
      ],
    });
    // Fails before any execution state is written.
    expect(
      sessions.get("/repo:session-1")?.graphWorkflowExecution ?? null,
    ).toBeNull();
  });

  it("creates an execution successfully for a valid definition", async () => {
    const { repo } = createInMemoryRepo();
    const execution = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    expect(execution.id).toBe("exec-1");
    expect(execution.status).toBe("pending");
  });

  it("rejects create when a non-terminal execution is already active, leaving it untouched", async () => {
    // Concurrent-start race: start()'s active-execution guard runs a long
    // async gauntlet before create, so two starts can both pass it. The
    // second create must fail inside the write-queue critical section
    // instead of silently overwriting the first execution (which would put
    // two loop drivers on one execution under matching fences).
    const { repo, sessions } = createInMemoryRepo();
    const seed: GraphWorkflowExecutionSeed = {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    };
    const first = await repo.create("/repo", "session-1", seed);

    await expect(
      repo.create("/repo", "session-1", {
        ...seed,
        executionId: "exec-2",
      }),
    ).rejects.toMatchObject({
      name: "WorkflowStartGuardError",
      guard: "active_execution",
    });

    const active = sessions.get("/repo:session-1")?.graphWorkflowExecution;
    expect(active?.id).toBe(first.id);
  });

  it("allows create to replace a terminal active execution", async () => {
    // Mirrors start()'s guard semantics: completed/halted/aborted actives
    // are replaceable (start archives them first, but create must not be
    // stricter than the guard it backs).
    for (const status of ["completed", "halted", "aborted"] as const) {
      const { repo, sessions } = createInMemoryRepo();
      const session = (() => {
        sessions.set("/repo:session-1", {
          worktreePath: WORKTREE_PATH,
          graphWorkflowExecution: createWorkflowExecution({
            id: "exec-old",
            status,
            ...(status === "halted"
              ? {
                  haltReason: {
                    type: "recovery_error",
                    message: "old halt",
                  },
                }
              : {}),
          }),
        } as unknown as SessionState);
        return sessions.get("/repo:session-1")!;
      })();

      const created = await repo.create("/repo", "session-1", {
        definition: createWorkflowDefinition(),
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(createWorkflowDefinition()),
        executionId: "exec-new",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
      });

      expect(created.id, `status=${status}`).toBe("exec-new");
      expect(
        (session as unknown as { graphWorkflowExecution: { id: string } })
          .graphWorkflowExecution.id,
      ).toBe("exec-new");
    }
  });

  it("reserves the active row before writing any out-of-row artifact", async () => {
    const { repo, operations } = createInMemoryRepo();

    await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
      seededDocuments: [
        {
          relativePath: ".cc/graph-workflow-docs/spec.md",
          contents: "# spec",
          description: "the spec",
          readWhen: "before implementing",
        },
      ],
    });

    // R3.5/R5.2 are order claims, not count claims: the lease must be won
    // before a single byte lands in `.cc`, so a losing racer has nothing to
    // clean up. Every side effect must therefore follow the reservation — and
    // the git exclusion must precede the writes, so nothing ever lands in a
    // namespace the worktree would commit.
    expect(operations[0]).toBe("reserve");
    expect(operations[1]?.startsWith("exclude:")).toBe(true);
    expect(operations.slice(2).every((op) => op.startsWith("write:"))).toBe(
      true,
    );
    expect(operations.filter((op) => op.startsWith("write:"))).toHaveLength(2);
  });

  it("tears down a normalized incumbent's surviving resources exactly once, after commit", async () => {
    // A legacy terminal row reaches normalization precisely because no explicit
    // release act ever ran for it — so its lane dev servers and registered
    // logger can still be alive. Relocating the record to History without
    // stopping them would leave them competing with the successor for the same
    // lane worktrees.
    const { repo, sessions, laneDevServerStops, loggerUnregistrations } =
      createInMemoryRepo();
    sessions.set("/repo:session-1", {
      worktreePath: WORKTREE_PATH,
      graphWorkflowExecution: createWorkflowExecution({
        id: "exec-terminal",
        status: "completed",
      }),
    } as unknown as SessionState);

    await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-next",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    expect(laneDevServerStops).toEqual(["exec-terminal"]);
    expect(loggerUnregistrations).toEqual(["exec-terminal"]);
  });

  it("runs no incumbent teardown when the launch is refused", async () => {
    const { repo, sessions, laneDevServerStops, loggerUnregistrations } =
      createInMemoryRepo();
    sessions.set("/repo:session-1", {
      worktreePath: WORKTREE_PATH,
      graphWorkflowExecution: createWorkflowExecution({
        id: "exec-holder",
        status: "running",
      }),
    } as unknown as SessionState);

    await expect(
      repo.create("/repo", "session-1", {
        definition: createWorkflowDefinition(),
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(createWorkflowDefinition()),
        executionId: "exec-blocked",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
      }),
    ).rejects.toMatchObject({ guard: "active_execution" });

    // Cleanup is WINNER-ONLY: a refusal that stopped the incumbent's dev
    // servers would be a refusal that ended live work.
    expect(laneDevServerStops).toEqual([]);
    expect(loggerUnregistrations).toEqual([]);
  });

  it("refuses a launch over a lease-holding incumbent without writing anything", async () => {
    const { repo, sessions, writes, appendedEvents, archived, operations } =
      createInMemoryRepo();
    sessions.set("/repo:session-1", {
      worktreePath: WORKTREE_PATH,
      graphWorkflowExecution: createWorkflowExecution({
        id: "exec-holder",
        status: "running",
      }),
    } as unknown as SessionState);
    const before = structuredClone(
      sessions.get("/repo:session-1")!.graphWorkflowExecution,
    );

    await expect(
      repo.create("/repo", "session-1", {
        definition: createWorkflowDefinition(),
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(createWorkflowDefinition()),
        executionId: "exec-blocked",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
      }),
    ).rejects.toMatchObject({
      name: "WorkflowStartGuardError",
      guard: "active_execution",
      blocker: expect.objectContaining({
        executionId: "exec-holder",
        status: "running",
        remedy: "inspect_or_pause",
      }),
    });

    expect(sessions.get("/repo:session-1")!.graphWorkflowExecution).toEqual(
      before,
    );
    expect(operations).toEqual([]);
    expect(writes).toEqual([]);
    expect(appendedEvents).toEqual([]);
    expect(archived).toEqual([]);
  });

  it("admits exactly one of two concurrent launches and leaves the loser no artifacts", async () => {
    // Both racers are held at the reservation seam until each has finished its
    // whole pre-reservation gauntlet, so the winner is decided by the CAS and
    // nothing else.
    let release: () => void = () => {};
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    const { repo, sessions, writes, appendedEvents } = createInMemoryRepo(
      {} as GlobalConfig,
      null,
      {
        reserveBarrier: async () => {
          arrivals += 1;
          if (arrivals >= 2) release();
          await bothArrived;
        },
      },
    );
    const seed: Omit<GraphWorkflowExecutionSeed, "executionId"> = {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    };

    const settled = await Promise.allSettled([
      repo.create("/repo", "session-1", { ...seed, executionId: "exec-a" }),
      repo.create("/repo", "session-1", { ...seed, executionId: "exec-b" }),
    ]);

    const winners = settled.filter((r) => r.status === "fulfilled");
    const losers = settled.filter((r) => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const winnerId = winners[0]!.value.id;
    const loserId = winnerId === "exec-a" ? "exec-b" : "exec-a";
    expect(losers[0]!.reason).toMatchObject({
      name: "WorkflowStartGuardError",
      guard: "active_execution",
      blocker: expect.objectContaining({ executionId: winnerId }),
    });

    // Exactly one execution persisted, and no loser artifact of any kind: no
    // second row, no event carrying the loser id, and only the winner's
    // charter file on disk.
    expect(sessions.get("/repo:session-1")!.graphWorkflowExecution?.id).toBe(
      winnerId,
    );
    expect(
      appendedEvents.filter((row) => JSON.stringify(row).includes(loserId)),
    ).toEqual([]);
    expect(writes).toHaveLength(1);
  });

  it("halts the reserved winner when materialization fails, leaving the run readable", async () => {
    const { repo, sessions } = createInMemoryRepo({} as GlobalConfig, null, {
      failCharterWrite: true,
    });

    await expect(
      repo.create("/repo", "session-1", {
        definition: createWorkflowDefinition(),
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(createWorkflowDefinition()),
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
      }),
    ).rejects.toThrow(/disk is full/);

    // The lease was already won when the write failed, so the record stays —
    // halted for retry or review, never a silently-vanished half-launch.
    const active = sessions.get("/repo:session-1")!.graphWorkflowExecution;
    expect(active?.id).toBe("exec-1");
    expect(active?.status).toBe("halted");
    expect(active?.haltReason).toMatchObject({
      type: "execution_loop_failed",
      cause: "io",
    });
  });

  it("halts the reserved winner when the git exclusion fails, before any .cc file is written", async () => {
    // The exclusion runs FIRST so nothing lands in a namespace the worktree
    // would commit. Treating its failure as best-effort undid that ordering: the
    // charter and seeded documents were written into a now-unignored .cc, the
    // pending record was settled, and the run carried on with a dirty tree and
    // no durable statement that anything was wrong.
    const { repo, sessions, writes, pendingArtifacts } = createInMemoryRepo(
      {} as GlobalConfig,
      null,
      { failExclusion: true },
    );

    await expect(
      repo.create("/repo", "session-1", {
        definition: createWorkflowDefinition(),
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(createWorkflowDefinition()),
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
        seededDocuments: [
          {
            relativePath: ".cc/graph-workflow-docs/spec.md",
            contents: "# spec",
            description: "the spec",
            readWhen: "before implementing",
          },
        ],
      }),
    ).rejects.toThrow(/exclusion failed/);

    const active = sessions.get("/repo:session-1")!.graphWorkflowExecution;
    expect(active?.id).toBe("exec-1");
    expect(active?.status).toBe("halted");
    expect(active?.haltReason).toMatchObject({
      type: "execution_loop_failed",
      cause: "io",
    });
    // Nothing reached the unignored namespace, and the debt still stands so a
    // retry can rewrite everything from durable state.
    expect(writes).toEqual([]);
    expect(pendingArtifacts.has("exec-1")).toBe(true);
  });

  it("materializes idempotently, so a retry rewrites the files and registers nothing new", async () => {
    const { repo, sessions, writes } = createInMemoryRepo();
    const seededDocuments = [
      {
        relativePath: ".cc/graph-workflow-docs/spec.md",
        contents: "# spec",
        description: "the spec",
        readWhen: "before implementing",
      },
    ];
    const created = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
      seededDocuments,
    });
    expect(created.sharedDocuments).toHaveLength(2);

    const retried = await repo.materializeArtifacts({
      projectPath: "/repo",
      sessionName: "session-1",
      executionId: "exec-1",
      seededDocuments,
    });

    // A retry heals the files without touching the registered set — which is
    // what makes it safe to run over a run whose first attempt half-finished.
    expect(writes).toHaveLength(4);
    expect(retried.sharedDocuments).toEqual(created.sharedDocuments);
    expect(
      sessions.get("/repo:session-1")!.graphWorkflowExecution?.sharedDocuments,
    ).toHaveLength(2);
  });

  it("settles the outstanding-artifact record once the writes land", async () => {
    const { repo, pendingArtifacts } = createInMemoryRepo();
    await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
      seededDocuments: [
        {
          relativePath: ".cc/graph-workflow-docs/spec.md",
          contents: "# spec",
          description: "the spec",
          readWhen: "before implementing",
        },
      ],
    });

    // Absence is the durable statement that this run's artifacts are on disk.
    expect(pendingArtifacts.has("exec-1")).toBe(false);
  });

  it("keeps the seeded contents when materialization fails, so a retry can reconstruct them", async () => {
    const { repo, pendingArtifacts } = createInMemoryRepo(
      {} as GlobalConfig,
      null,
      { failCharterWrite: true },
    );
    const seededDocuments = [
      {
        relativePath: ".cc/graph-workflow-docs/spec.md",
        contents: "# spec",
        description: "the spec",
        readWhen: "before implementing",
      },
    ];

    await expect(
      repo.create("/repo", "session-1", {
        definition: createWorkflowDefinition(),
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(createWorkflowDefinition()),
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
        seededDocuments,
      }),
    ).rejects.toThrow(/disk is full/);

    // The execution row carries registrations, not bytes: without this record
    // the halted run could never be repaired, because the contents would exist
    // nowhere.
    expect(pendingArtifacts.get("exec-1")?.documents).toEqual(seededDocuments);
  });

  it("reconstructs a crashed launch's artifacts at kickoff from the durable record alone", async () => {
    const { repo, writes, pendingArtifacts } = createInMemoryRepo();
    await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
      seededDocuments: [
        {
          relativePath: ".cc/graph-workflow-docs/spec.md",
          contents: "# spec",
          description: "the spec",
          readWhen: "before implementing",
        },
      ],
    });
    // Stand in for the crash: the reserving transaction committed both the row
    // and the record, and the process died before the writes landed.
    pendingArtifacts.set("exec-1", {
      executionId: "exec-1",
      projectPath: "/repo",
      sessionName: "session-1",
      documents: [
        {
          relativePath: ".cc/graph-workflow-docs/spec.md",
          contents: "# spec",
          description: "the spec",
          readWhen: "before implementing",
        },
      ],
      recordedAt: "2026-04-04T00:00:00.000Z",
    });
    writes.length = 0;

    // The kickoff caller supplies no contents — only identity. Everything it
    // rewrites comes from what outlived the crash.
    const repaired = await repo.ensureArtifactsMaterialized({
      projectPath: "/repo",
      sessionName: "session-1",
      executionId: "exec-1",
    });

    expect(repaired?.id).toBe("exec-1");
    expect(
      writes.map((write) => path.basename(write.absolutePath)).sort(),
    ).toEqual(["charter.md", "spec.md"]);
    expect(
      writes.find((write) => write.absolutePath.endsWith("spec.md"))?.contents,
    ).toBe("# spec");
    expect(pendingArtifacts.has("exec-1")).toBe(false);
  });

  it("does nothing at kickoff for a run that owes no artifacts", async () => {
    const { repo, writes } = createInMemoryRepo();
    await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });
    writes.length = 0;

    expect(
      await repo.ensureArtifactsMaterialized({
        projectPath: "/repo",
        sessionName: "session-1",
        executionId: "exec-1",
      }),
    ).toBeNull();
    expect(writes).toEqual([]);
  });

  it("refuses to materialize over an execution that no longer holds the row", async () => {
    const { repo, sessions } = createInMemoryRepo();
    await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    await expect(
      repo.materializeArtifacts({
        projectPath: "/repo",
        sessionName: "session-1",
        executionId: "exec-gone",
        seededDocuments: [],
      }),
    ).rejects.toThrow(/exec-gone/);
    expect(sessions.get("/repo:session-1")!.graphWorkflowExecution?.id).toBe(
      "exec-1",
    );
  });

  it("initializes context and task state to execution-start defaults", async () => {
    const { repo } = createInMemoryRepo();
    const execution = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    expect(execution.activeContextIds).toEqual([]);
    expect(execution.haltReason).toBeNull();
    expect(execution.completedAt).toBeNull();
    // The charter document is seeded at create, so the only shared document is
    // the reserved kind:"charter" entry.
    expect(execution.sharedDocuments).toHaveLength(1);
    expect(execution.sharedDocuments[0]?.kind).toBe("charter");
    expect(execution.laneStates).toEqual({});
    expect(execution.machineSnapshot).toBeNull();

    for (const context of execution.workingDefinition.executionContexts) {
      const state = execution.contextStates[context.id];
      expect(state).toEqual({
        contextId: context.id,
        status: "pending",
        totalTaskCount: execution.workingDefinition.tasks.filter(
          (task) => task.contextId === context.id,
        ).length,
        completedTaskCount: 0,
        iterationCount: 0,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
        worktreePath: null,
        branchName: null,
        batchId: null,
        isolation: "session",
        laneId: null,
        joinId: null,
        mergeStatus: "not-applicable",
        cleanupStatus: "not-applicable",
        lastMergeError: null,
        pendingApproval: null,
        pendingUserInputs: {},
        skipReason: null,
        landingIntent: null,
      });
    }

    for (const task of execution.workingDefinition.tasks) {
      expect(execution.taskStates[task.id]).toEqual({
        taskId: task.id,
        contextId: task.contextId,
        order: task.order,
        status: "pending",
        summary: null,
        startedAt: null,
        completedAt: null,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      });
    }
  });

  it("stores a resolved workingDefinition with implementer populated even when the input omits it", async () => {
    const { repo } = createInMemoryRepo();
    const baseline = createWorkflowDefinition();
    const definition = {
      ...baseline,
      executionContexts: baseline.executionContexts.map((context) => {
        const { implementer: _implementer, ...rest } = context;
        return rest;
      }),
    };

    const execution = await repo.create("/repo", "session-1", {
      definition,
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(definition),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    for (const context of execution.workingDefinition.executionContexts) {
      expect(context.implementer).toMatchObject(
        SEEDED_WORKFLOW_DEFAULTS.implementer,
      );

      // Seeded, not merely referenced: the working definition carries the bytes
      // the run will deliver, resolved once here and never looked up again (R4).
      const snapshot = context.implementer.profileSnapshot;
      expect(snapshot.tier).toBe("builtin");
      expect(snapshot.id).toBe("general-implementer");
      expect(snapshot.renderedInstructionBlock).toContain(
        snapshot.instructions,
      );
      expect(snapshot.resolvedInstructionHash).toBe(
        computeContentHash(snapshot.renderedInstructionBlock),
      );
    }
  });

  it("populates contextValidator from seeded defaults and leaves disabled overrides as null", async () => {
    const { repo } = createInMemoryRepo();
    const baseline = createWorkflowDefinition();
    const definition = {
      ...baseline,
      executionContexts: [
        baseline.executionContexts[0]!,
        {
          ...baseline.executionContexts[1]!,
          contextValidator: { enabled: false, assignments: [] },
        },
        baseline.executionContexts[2]!,
      ],
    };

    const execution = await repo.create("/repo", "session-1", {
      definition,
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(definition),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    const byId = Object.fromEntries(
      execution.workingDefinition.executionContexts.map((context) => [
        context.id,
        context,
      ]),
    );

    // Seeding resolves each tier's whole cohort: the two contexts that declare
    // none inherit the enabled global default, and the one that pins a disabled
    // cohort keeps it disabled rather than losing the block.
    expect(byId["context-plan"]?.contextValidator.enabled).toBe(true);
    expect(byId["context-verify"]?.contextValidator.enabled).toBe(true);
    expect(byId["context-implement"]?.contextValidator).toEqual({
      enabled: false,
      assignments: [],
    });
  });

  it("expands and freezes agent selectors to explicit names at seed time", async () => {
    const { repo } = createInMemoryRepo({} as GlobalConfig, {
      validation: {
        commands: {
          typecheck: {
            command: { full: "scripts/validate/typecheck.sh" },
            cost: 2,
            pathArgs: "forbid",
          },
          test: {
            command: {
              full: "scripts/validate/test-full-suite.sh",
              changed: "scripts/validate/test.sh",
            },
            cost: 8,
            pathArgs: "paths",
          },
          format: {
            command: { full: "scripts/validate/format.sh" },
            cost: 1,
            pathArgs: "forbid",
          },
        },
        preMerge: ["typecheck", "test"],
      },
    });
    const definition = createWorkflowDefinition({
      workflowConfig: {
        agentValidation: {
          implementer: { mode: "all", except: ["format"] },
        },
      },
    });

    const execution = await repo.create("/repo", "session-1", {
      definition,
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(definition),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    const byId = Object.fromEntries(
      execution.workingDefinition.executionContexts.map((context) => [
        context.id,
        context,
      ]),
    );
    // `mode:"all"` expands against the registry AT SEED so later registry
    // additions never broaden a running execution (design §6). context-plan
    // inherits the workflow tier's `all except format`; context-implement's
    // own `all except []` override expands to the full registry.
    expect(byId["context-plan"]?.agentValidation?.implementer.commands).toEqual(
      ["typecheck", "test"],
    );
    expect(
      byId["context-implement"]?.agentValidation?.implementer.commands,
    ).toEqual(["typecheck", "test", "format"]);
    for (const context of execution.workingDefinition.executionContexts) {
      // The seeded context-validator default is `{mode:"only", commands:[]}`.
      expect(context.agentValidation?.contextValidator.commands).toEqual([]);
    }
  });

  it("freezes agent selectors on loop templates for later pass materialization", async () => {
    const { repo } = createInMemoryRepo({} as GlobalConfig, {
      validation: {
        commands: {
          typecheck: {
            command: { full: "scripts/validate/typecheck.sh" },
            cost: 2,
            pathArgs: "forbid",
          },
          test: {
            command: {
              full: "scripts/validate/test-full-suite.sh",
              changed: "scripts/validate/test.sh",
            },
            cost: 8,
            pathArgs: "paths",
          },
          format: {
            command: { full: "scripts/validate/format.sh" },
            cost: 1,
            pathArgs: "forbid",
          },
        },
        preMerge: ["typecheck", "test"],
      },
    });
    const baseline = createWorkflowDefinition({
      workflowConfig: {
        agentValidation: {
          implementer: { mode: "all", except: ["format"] },
        },
      },
    });
    const definition = createWorkflowDefinition({
      ...baseline,
      executionContexts: baseline.executionContexts.map((context) =>
        context.id === "context-verify"
          ? {
              ...context,
              outputSchema: {
                type: "object",
                properties: { approved: { type: "boolean" } },
                required: ["approved"],
                additionalProperties: false,
              },
            }
          : context,
      ),
      loopGroups: [
        {
          id: "refine",
          bodyContextIds: ["context-implement", "context-verify"],
          entryContextId: "context-implement",
          exitContextId: "context-verify",
          until: {
            schema: {
              type: "object",
              properties: { approved: { const: true } },
              required: ["approved"],
            },
          },
          maxPasses: 3,
        },
      ],
    });

    const execution = await repo.create("/repo", "session-1", {
      definition,
      source: {
        kind: "template",
        definitionId: "wf-loop",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(definition),
      executionId: "exec-loop",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    const templateContexts = Object.fromEntries(
      execution.workingDefinition.loopGroups?.[0]?.template.contexts.map(
        (context) => [context.id, context],
      ) ?? [],
    );
    expect(
      templateContexts["context-implement"]?.agentValidation?.implementer
        .commands,
    ).toEqual(["typecheck", "test", "format"]);
    expect(
      templateContexts["context-verify"]?.agentValidation?.implementer.commands,
    ).toEqual(["typecheck", "test"]);
    for (const context of Object.values(templateContexts)) {
      expect(context.agentValidation?.contextValidator.commands).toEqual([]);
    }
  });

  it("rejects a start whose INHERITED global selector names an unknown command", async () => {
    const { repo, sessions } = createInMemoryRepo(
      {
        workflowDefaults: {
          agentValidation: {
            implementer: { mode: "all", except: ["ghost"] },
            contextValidator: { mode: "only", commands: [] },
          },
        },
      } as unknown as GlobalConfig,
      {
        validation: {
          commands: {
            typecheck: {
              command: { full: "scripts/validate/typecheck.sh" },
              cost: 2,
              pathArgs: "forbid",
            },
          },
          preMerge: ["typecheck"],
        },
      },
    );

    // The definition itself writes no selector: the unknown name arrives
    // purely through the global-defaults tier, so only the resolved-tier
    // preflight can catch it. `workflowConfig: {}` clears the fixture's own
    // workflow-tier blocks so the global tier is what resolves.
    const baseline = createWorkflowDefinition({ workflowConfig: {} });
    const definition = {
      ...baseline,
      executionContexts: baseline.executionContexts.map((context) => {
        const { agentValidation: _agentValidation, ...rest } = context;
        return rest;
      }),
    };
    await expect(
      repo.create("/repo", "session-1", {
        definition,
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(definition),
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
      }),
    ).rejects.toMatchObject({
      name: "GraphWorkflowValidationError",
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "unknown-validation-command",
          field: expect.stringContaining("agentValidation.implementer"),
        }),
      ]),
    });
    expect(
      sessions.get("/repo:session-1")?.graphWorkflowExecution ?? null,
    ).toBeNull();
  });

  it("rejects an inherited oversized selection at start before writing execution state", async () => {
    const { repo, sessions } = createInMemoryRepo(
      {
        validation: { concurrencyLimit: 4, defaultTimeoutMs: 600_000 },
        workflowDefaults: {
          agentValidation: {
            implementer: { mode: "only", commands: ["test"] },
            contextValidator: { mode: "only", commands: [] },
          },
        },
      } as unknown as GlobalConfig,
      {
        validation: {
          commands: {
            test: {
              command: {
                full: "scripts/validate/test-full-suite.sh",
                changed: "scripts/validate/test.sh",
              },
              cost: 5,
              pathArgs: "paths",
            },
          },
          preMerge: ["test"],
        },
      },
    );
    const baseline = createWorkflowDefinition({ workflowConfig: {} });
    const definition = {
      ...baseline,
      executionContexts: baseline.executionContexts.map((context) => {
        const { agentValidation: _agentValidation, ...rest } = context;
        return rest;
      }),
    };

    await expect(
      repo.create("/repo", "session-1", {
        definition,
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(definition),
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
      }),
    ).rejects.toMatchObject({
      name: "GraphWorkflowValidationError",
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "validation_cost_exceeds_limit",
          field: expect.stringContaining(
            "agentValidation.implementer.value.commands.0",
          ),
          message: expect.stringMatching(/cost 5.*limit 4.*lower-worker/),
        }),
      ]),
    });
    expect(
      sessions.get("/repo:session-1")?.graphWorkflowExecution ?? null,
    ).toBeNull();
  });

  it("snapshots the resolved laneMergeValidation onto the working definition", async () => {
    const { repo } = createInMemoryRepo({} as GlobalConfig, {
      validation: {
        commands: {
          typecheck: {
            command: { full: "scripts/validate/typecheck.sh" },
            cost: 2,
            pathArgs: "forbid",
          },
        },
        preMerge: ["typecheck"],
      },
    });
    const definition = createWorkflowDefinition({
      workflowConfig: {
        laneMergeValidation: {
          strategy: "every-merge",
          commands: { mode: "only", commands: ["typecheck"] },
        },
      },
    });

    const execution = await repo.create("/repo", "session-1", {
      definition,
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(definition),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    expect(execution.workingDefinition.laneMergeValidation).toEqual({
      strategy: "every-merge",
      commands: { mode: "only", commands: ["typecheck"] },
    });
  });

  it("snapshots the seeded laneMergeValidation defaults when no tier overrides", async () => {
    const { repo } = createInMemoryRepo();
    const execution = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    expect(execution.workingDefinition.laneMergeValidation).toEqual({
      strategy: "final-only",
      commands: { mode: "project" },
    });
  });

  it("rejects a start whose inherited laneMergeValidation names an unknown command", async () => {
    const { repo } = createInMemoryRepo(
      {
        workflowDefaults: {
          laneMergeValidation: {
            strategy: "final-only",
            commands: { mode: "only", commands: ["ghost"] },
          },
        },
      } as unknown as GlobalConfig,
      {
        validation: {
          commands: {
            typecheck: {
              command: { full: "scripts/validate/typecheck.sh" },
              cost: 2,
              pathArgs: "forbid",
            },
          },
          preMerge: ["typecheck"],
        },
      },
    );

    // `workflowConfig: {}` clears the fixture's workflow-tier lane-merge
    // block so the global default (naming "ghost") is what resolves.
    await expect(
      repo.create("/repo", "session-1", {
        definition: createWorkflowDefinition({ workflowConfig: {} }),
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(
          createWorkflowDefinition({ workflowConfig: {} }),
        ),
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
      }),
    ).rejects.toMatchObject({
      name: "GraphWorkflowValidationError",
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "unknown-validation-command",
          field: "laneMergeValidation.commands.commands.0",
        }),
      ]),
    });
  });

  it("throws GraphWorkflowValidationError when resolved implementer uses an unsupported reasoning effort", async () => {
    const { repo } = createInMemoryRepo();
    const baseline = createWorkflowDefinition();
    const definition = {
      ...baseline,
      executionContexts: [
        {
          ...baseline.executionContexts[0]!,
          implementer: {
            id: "implementer",
            profile: { tier: "builtin" as const, id: "general-implementer" },
            agent: {
              backend: "codex" as const,
              model: "gpt-5.4" as const,
              reasoningEffort: "minimal" as const,
            },
          },
        },
        ...baseline.executionContexts.slice(1),
      ],
    };

    await expect(
      repo.create("/repo", "session-1", {
        definition,
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(definition),
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
      }),
    ).rejects.toBeInstanceOf(GraphWorkflowValidationError);
  });
});

/**
 * The dirty-worktree exemption's seed-time tie (R8, decision D10).
 *
 * The launch guard decides eligibility against a resolution it builds from its
 * own config read; THIS is where the resolution the execution will actually run
 * is built, from a second, independent read. Nothing makes the two agree, so a
 * seed that carries the pin has to be re-proven against the definition about to
 * be persisted — otherwise a global default that moved between the two reads
 * lands a write-capable run wearing a read-only pin.
 */
describe("createGraphWorkflowExecutionRepository.create dirty-worktree exemption pin", () => {
  function liveSessionReadOnlyDefinition(): WorkflowSemanticDefinition {
    const contexts = ["read-a", "read-b"].map((id) => ({
      id,
      title: id,
      acceptanceCriteria: `${id} reports what it read`,
      placement: { lane: "session" as const, mode: "readOnly" as const },
      outputSchema: {
        type: "object" as const,
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    }));
    return createWorkflowDefinition({
      executionContexts: contexts,
      tasks: contexts.map((context) => ({
        id: `task-${context.id}`,
        contextId: context.id,
        order: 1,
        title: "Inspect the worktree",
        instructions: "Read the relevant files and report.",
        source: "user" as const,
      })),
      edges: [],
    });
  }

  function pinnedSeed(
    definition: WorkflowSemanticDefinition,
    liveSessionReadOnlyPinned: boolean,
  ): GraphWorkflowExecutionSeed {
    return {
      definition,
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(definition),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
      liveSessionReadOnlyPinned,
    };
  }

  /** Global defaults that turn every context write-capable through the cascade. */
  const COLLABORATION_ENABLED = {
    workflowDefaults: {
      ...SEEDED_WORKFLOW_DEFAULTS,
      collaboration: {
        ...SEEDED_WORKFLOW_DEFAULTS.collaboration,
        enabled: true,
      },
    },
  } as GlobalConfig;

  it("persists the pin when the definition it is about to run is still wholly live-session read-only", async () => {
    const { repo, sessions } = createInMemoryRepo();

    const execution = await repo.create(
      "/repo",
      "session-1",
      pinnedSeed(liveSessionReadOnlyDefinition(), true),
    );

    expect(execution.liveSessionReadOnlyPinned).toBe(true);
    expect(
      sessions.get("/repo:session-1")?.graphWorkflowExecution
        ?.liveSessionReadOnlyPinned,
    ).toBe(true);
  });

  it("refuses a pinned seed whose seed-time cascade resolves collaboration enabled, seeding nothing", async () => {
    const { repo, sessions, operations } = createInMemoryRepo(
      COLLABORATION_ENABLED,
    );

    await expect(
      repo.create(
        "/repo",
        "session-1",
        pinnedSeed(liveSessionReadOnlyDefinition(), true),
      ),
    ).rejects.toMatchObject({
      name: "GraphWorkflowValidationError",
      errors: [
        expect.objectContaining({
          code: "live-session-read-only-collaboration",
          contextId: "read-a",
        }),
        expect.objectContaining({
          code: "live-session-read-only-collaboration",
          contextId: "read-b",
        }),
      ],
    });
    // Refused before the reservation, so neither a row nor a byte survives the
    // launch the guard admitted on a resolution that no longer holds.
    expect(
      sessions.get("/repo:session-1")?.graphWorkflowExecution ?? null,
    ).toBeNull();
    expect(operations).toEqual([]);
  });

  it("refuses a pinned seed whose seed-time cascade inherits a script-validator command", async () => {
    const { repo, sessions } = createInMemoryRepo(
      {
        workflowDefaults: {
          ...SEEDED_WORKFLOW_DEFAULTS,
          scriptValidator: { commands: ["typecheck"] },
        },
      } as GlobalConfig,
      {
        validation: {
          commands: {
            typecheck: {
              command: { full: "scripts/validate/typecheck.sh" },
              cost: 2,
              pathArgs: "forbid",
            },
          },
          preMerge: ["typecheck"],
        },
      },
    );

    await expect(
      repo.create(
        "/repo",
        "session-1",
        pinnedSeed(liveSessionReadOnlyDefinition(), true),
      ),
    ).rejects.toMatchObject({
      name: "GraphWorkflowValidationError",
      errors: [
        expect.objectContaining({
          code: "live-session-read-only-script-validator",
        }),
        expect.objectContaining({
          code: "live-session-read-only-script-validator",
        }),
      ],
    });
    expect(
      sessions.get("/repo:session-1")?.graphWorkflowExecution ?? null,
    ).toBeNull();
  });

  it("leaves an unpinned seed under the same defaults alone: a clean launch asserts nothing to keep", async () => {
    const { repo } = createInMemoryRepo(COLLABORATION_ENABLED);

    const execution = await repo.create(
      "/repo",
      "session-1",
      pinnedSeed(liveSessionReadOnlyDefinition(), false),
    );

    expect(execution.liveSessionReadOnlyPinned).toBe(false);
    expect(execution.status).toBe("pending");
  });
});

describe("createGraphWorkflowExecutionRepository.create charter seed propagation", () => {
  it("stores an execution whose charter snapshot is set and whose shared documents include a kind:'charter' entry", async () => {
    const { repo, sessions } = createInMemoryRepo();
    const definition = createWorkflowDefinition({ charter: makeTestCharter() });

    await repo.create("/repo", "session-1", {
      definition,
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(definition),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    const stored = sessions.get("/repo:session-1")?.graphWorkflowExecution;
    expect(stored).not.toBeNull();
    expect(stored?.charter).toEqual(definition.charter);

    const charterEntries =
      stored?.sharedDocuments.filter((entry) => entry.kind === "charter") ?? [];
    expect(charterEntries).toHaveLength(1);
    expect(charterEntries[0]?.relativePath).toBe(
      ".cc/graph-workflow-docs/charter.md",
    );
  });

  it("writes charter.md inside the session worktree only", async () => {
    const { repo, writes } = createInMemoryRepo();

    await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.absolutePath).toBe(
      path.join(WORKTREE_PATH, ".cc", "graph-workflow-docs", "charter.md"),
    );
  });

  it("records and broadcasts a charter-registered event carrying the charter hash", async () => {
    const charter = makeTestCharter();
    const { repo, broadcasts, appendedEvents } = createInMemoryRepo();

    await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition({ charter }),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 2,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition({ charter })),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    const charterBroadcast = broadcasts.find(
      (event) => event.type === "graph-workflow-charter-registered",
    );
    expect(charterBroadcast).toBeDefined();
    expect(charterBroadcast).toMatchObject({
      executionId: "exec-1",
      definitionId: "wf-1",
      definitionRevision: 2,
      charterHash: computeCharterHash(charter),
    });

    const registeredEvent = appendedEvents.find(
      (entry) => entry.event.type === "graph-workflow-charter-registered",
    );
    expect(registeredEvent).toBeDefined();
  });

  it("throws when the session has no worktree path", async () => {
    const { repo, sessions } = createInMemoryRepo();
    sessions.set("/repo:session-1", {
      worktreePath: "",
      graphWorkflowExecution: null,
    } as unknown as SessionState);

    await expect(
      repo.create("/repo", "session-1", {
        definition: createWorkflowDefinition(),
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(createWorkflowDefinition()),
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: {},
        ownerConversationId: null,
      }),
    ).rejects.toThrow(/worktree/);
  });
});

describe("createGraphWorkflowExecutionRepository.create parameter substitution", () => {
  it("substitutes bound inputs into content + charter and persists boundInputs (R4.7, R6.1)", async () => {
    const { repo, sessions } = createInMemoryRepo();
    const baseline = createWorkflowDefinition();
    const definition: WorkflowSemanticDefinition = {
      ...baseline,
      parameters: [
        {
          name: "feature",
          label: "Feature",
          type: "string",
          required: true,
        },
        {
          name: "ac",
          label: "Acceptance criteria",
          type: "text",
          required: true,
        },
      ],
      charter: makeTestCharter({ mission: "Deliver {{inputs.feature}}" }),
      executionContexts: [
        {
          ...baseline.executionContexts[0]!,
          acceptanceCriteria: "{{inputs.ac}}",
        },
        ...baseline.executionContexts.slice(1),
      ],
    };

    const inputs = {
      feature: "the payments flow",
      ac: "All payment paths covered",
    };

    const execution = await repo.create("/repo", "session-1", {
      definition,
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(definition),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs,
      ownerConversationId: null,
    });

    expect(execution.charter.mission).toBe("Deliver the payments flow");
    expect(execution.charter.mission).not.toContain("{{inputs.");

    const planContext = execution.workingDefinition.executionContexts.find(
      (context) => context.id === "context-plan",
    );
    expect(planContext?.acceptanceCriteria).toBe("All payment paths covered");

    const serialized = JSON.stringify(execution.workingDefinition);
    expect(serialized).not.toContain("{{inputs.");

    expect(execution.boundInputs).toEqual(inputs);

    const stored = sessions.get("/repo:session-1")?.graphWorkflowExecution;
    expect(stored?.boundInputs).toEqual(inputs);
  });

  it("seeds nothing when substitution empties required content (R5.2, R5.3)", async () => {
    const { repo, mutateCalls } = createInMemoryRepo();
    const baseline = createWorkflowDefinition();
    const definition: WorkflowSemanticDefinition = {
      ...baseline,
      parameters: [
        {
          name: "ac",
          label: "Acceptance criteria",
          type: "text",
          required: false,
        },
      ],
      executionContexts: [
        {
          ...baseline.executionContexts[0]!,
          acceptanceCriteria: "{{inputs.ac}}",
        },
        ...baseline.executionContexts.slice(1),
      ],
    };

    await expect(
      repo.create("/repo", "session-1", {
        definition,
        source: {
          kind: "template",
          definitionId: "wf-1",
          definitionRevision: 1,
          tier: "project",
        },
        launchDocument: makeLaunchDocument(definition),
        executionId: "exec-1",
        startedAt: "2026-04-04T00:00:00.000Z",
        inputs: { ac: "   " },
        ownerConversationId: null,
      }),
    ).rejects.toBeInstanceOf(GraphWorkflowValidationError);

    expect(mutateCalls.length).toBe(0);
  });

  it("seeds successfully when a bound value contains a literal {{...}} (R5.5)", async () => {
    const { repo } = createInMemoryRepo();
    const baseline = createWorkflowDefinition();
    const definition: WorkflowSemanticDefinition = {
      ...baseline,
      parameters: [
        {
          name: "ci",
          label: "CI matrix expression",
          type: "string",
          required: true,
        },
      ],
      executionContexts: [
        {
          ...baseline.executionContexts[0]!,
          acceptanceCriteria: "Runs on {{inputs.ci}}",
        },
        ...baseline.executionContexts.slice(1),
      ],
    };

    const literal = "${{ matrix.os }} and a brief mentioning {{inputs.y}}";

    const execution = await repo.create("/repo", "session-1", {
      definition,
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(definition),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: { ci: literal },
      ownerConversationId: null,
    });

    const planContext = execution.workingDefinition.executionContexts.find(
      (context) => context.id === "context-plan",
    );
    expect(planContext?.acceptanceCriteria).toBe(`Runs on ${literal}`);
    expect(planContext?.acceptanceCriteria).toContain("${{ matrix.os }}");
    expect(planContext?.acceptanceCriteria).toContain("{{inputs.y}}");
  });

  it("seeds a static definition with empty boundInputs (R6.5)", async () => {
    const { repo } = createInMemoryRepo();

    const execution = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    expect(execution.boundInputs).toEqual({});
    expect(execution.status).toBe("pending");
  });

  it("snapshots the seed's launchedTier onto the execution, parallel to boundInputs (R3.3)", async () => {
    const { repo, sessions } = createInMemoryRepo();

    const execution = await repo.create("/repo", "session-1", {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "global",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId: "exec-1",
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    });

    expect(execution.launchedTier).toBe("global");

    const stored = sessions.get("/repo:session-1")?.graphWorkflowExecution;
    expect(stored?.launchedTier).toBe("global");
  });
});

describe("createGraphWorkflowExecutionRepository loop-fence enforcement", () => {
  function seedActiveExecution(
    harness: ReturnType<typeof createInMemoryRepo>,
    overrides: Partial<GraphWorkflowExecution> = {},
  ): GraphWorkflowExecution {
    const execution = createWorkflowExecution({
      id: "execution-1",
      ...overrides,
    });
    const key = "/repo:session-1";
    const session = makeSession();
    session.graphWorkflowExecution = execution;
    harness.sessions.set(key, session);
    return execution;
  }

  it("applies a mutation whose ambient fence matches the persisted generation", async () => {
    const harness = createInMemoryRepo();
    seedActiveExecution(harness);

    const next = await runWithLoopFence(
      {
        projectPath: "/repo",
        sessionName: "session-1",
        executionId: "execution-1",
        loopEpoch: 0,
      },
      () =>
        harness.repo.mutateActive("/repo", "session-1", (execution) => ({
          ...execution,
          activeContextIds: ["context-updated"],
        })),
    );

    expect(next.activeContextIds).toEqual(["context-updated"]);
    expect(
      harness.sessions.get("/repo:session-1")?.graphWorkflowExecution
        ?.activeContextIds,
    ).toEqual(["context-updated"]);
  });

  it("rejects a mutation from a stale loop generation without persisting anything", async () => {
    const harness = createInMemoryRepo();
    // Persisted execution has been resumed since the loop captured its fence.
    seedActiveExecution(harness, { loopEpoch: 1 });

    const mutator = vi.fn((execution: GraphWorkflowExecution) => ({
      ...execution,
      activeContextIds: ["context-stale-write"],
    }));

    await expect(
      runWithLoopFence(
        {
          projectPath: "/repo",
          sessionName: "session-1",
          executionId: "execution-1",
          loopEpoch: 0,
        },
        () => harness.repo.mutateActive("/repo", "session-1", mutator),
      ),
    ).rejects.toThrow(StaleLoopFenceError);

    expect(mutator).not.toHaveBeenCalled();
    expect(
      harness.sessions.get("/repo:session-1")?.graphWorkflowExecution
        ?.activeContextIds,
    ).toEqual([]);
    expect(harness.appendedEvents).toEqual([]);
  });

  it("rejects a mutation from a loop whose execution was replaced by a successor", async () => {
    const harness = createInMemoryRepo();
    seedActiveExecution(harness, { id: "execution-2" });

    await expect(
      runWithLoopFence(
        {
          projectPath: "/repo",
          sessionName: "session-1",
          executionId: "execution-1",
          loopEpoch: 0,
        },
        () =>
          harness.repo.mutateActive("/repo", "session-1", (execution) => ({
            ...execution,
            activeContextIds: ["context-stale-write"],
          })),
      ),
    ).rejects.toThrow(StaleLoopFenceError);

    expect(
      harness.sessions.get("/repo:session-1")?.graphWorkflowExecution
        ?.activeContextIds,
    ).toEqual([]);
  });

  it("rejects a fenced mutation when the execution was archived (no active row)", async () => {
    const harness = createInMemoryRepo();

    await expect(
      runWithLoopFence(
        {
          projectPath: "/repo",
          sessionName: "session-1",
          executionId: "execution-1",
          loopEpoch: 0,
        },
        () =>
          harness.repo.mutateActive(
            "/repo",
            "session-1",
            (execution) => execution,
          ),
      ),
    ).rejects.toThrow(StaleLoopFenceError);
  });

  it("keeps unfenced mutations (user/agent routes) unaffected", async () => {
    const harness = createInMemoryRepo();
    seedActiveExecution(harness, { loopEpoch: 7 });

    const next = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({
        ...execution,
        activeContextIds: ["context-route-write"],
      }),
    );

    expect(next.activeContextIds).toEqual(["context-route-write"]);
  });
});

/**
 * The other fence the critical section applies (D7 R9.1/R9.4). A mutation route
 * authorizes an agent principal against the execution it READ and then writes
 * through a session-keyed API; if the lease turned over in that gap, the
 * authorization must not carry to the successor.
 */
describe("createGraphWorkflowExecutionRepository principal-fence enforcement", () => {
  const ORIGIN_PRINCIPAL = {
    kind: "conversation" as const,
    conversationId: "origin-conv",
  };

  function seedActive(
    harness: ReturnType<typeof createInMemoryRepo>,
    id: string,
  ): void {
    const session = makeSession();
    session.graphWorkflowExecution = createWorkflowExecution({ id });
    harness.sessions.set("/repo:session-1", session);
  }

  it("applies a fenced mutation against the execution it was authorized for", async () => {
    const harness = createInMemoryRepo();
    seedActive(harness, "execution-1");

    const next = await runWithExecutionPrincipalFence(
      {
        projectPath: "/repo",
        sessionName: "session-1",
        executionId: "execution-1",
        originConversationId: "origin-conv",
        principal: ORIGIN_PRINCIPAL,
      },
      () =>
        harness.repo.mutateActive("/repo", "session-1", (execution) => ({
          ...execution,
          activeContextIds: ["context-updated"],
        })),
    );

    expect(next.activeContextIds).toEqual(["context-updated"]);
  });

  it("rejects a fenced mutation once a successor took the lease, writing nothing", async () => {
    const harness = createInMemoryRepo();
    // E1 settled and E2 launched between the route's read and this write.
    seedActive(harness, "execution-2");

    const mutator = vi.fn((execution: GraphWorkflowExecution) => ({
      ...execution,
      activeContextIds: ["context-successor-write"],
    }));

    await expect(
      runWithExecutionPrincipalFence(
        {
          projectPath: "/repo",
          sessionName: "session-1",
          executionId: "execution-1",
          originConversationId: "origin-conv",
          principal: ORIGIN_PRINCIPAL,
        },
        () => harness.repo.mutateActive("/repo", "session-1", mutator),
      ),
    ).rejects.toThrow(ExecutionTurnoverError);

    expect(mutator).not.toHaveBeenCalled();
    expect(
      harness.sessions.get("/repo:session-1")?.graphWorkflowExecution
        ?.activeContextIds,
    ).toEqual([]);
    expect(harness.appendedEvents).toEqual([]);
  });

  it("rejects a fenced lane once its binding rotated, writing nothing", async () => {
    const harness = createInMemoryRepo();
    seedActive(harness, "execution-1");
    const session = harness.sessions.get("/repo:session-1")!;
    const execution = session.graphWorkflowExecution!;
    execution.taskStates["task-plan-1"] = {
      ...execution.taskStates["task-plan-1"]!,
      status: "running",
      lastConversationId: "successor-lane-conv",
    };

    const mutator = vi.fn((active: GraphWorkflowExecution) => ({
      ...active,
      activeContextIds: ["context-stale-lane-write"],
    }));

    await expect(
      runWithExecutionPrincipalFence(
        {
          projectPath: "/repo",
          sessionName: "session-1",
          executionId: "execution-1",
          originConversationId: "origin-conv",
          principal: {
            kind: "lane",
            executionId: "execution-1",
            contextId: "context-plan",
            conversationId: "authorized-lane-conv",
          },
        },
        () => harness.repo.mutateActive("/repo", "session-1", mutator),
      ),
    ).rejects.toThrow(LaneBindingTurnoverError);

    expect(mutator).not.toHaveBeenCalled();
    expect(
      harness.sessions.get("/repo:session-1")?.graphWorkflowExecution
        ?.activeContextIds,
    ).toEqual([]);
    expect(harness.appendedEvents).toEqual([]);
  });

  it("keeps human-UI and internal mutations, which carry no fence, unaffected", async () => {
    const harness = createInMemoryRepo();
    seedActive(harness, "execution-2");

    const next = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({ ...execution, activeContextIds: ["context-ui-write"] }),
    );

    expect(next.activeContextIds).toEqual(["context-ui-write"]);
  });
});

describe("createGraphWorkflowExecutionRepository.create replacement audit", () => {
  const PROJECT_PATH = "/repo";
  const SESSION_NAME = "session-1";

  let fixture: PersistenceFixture;

  beforeEach(() => {
    fixture = createPersistenceFixture();
    fixture.seedProject(PROJECT_PATH);
    fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  });

  afterEach(() => {
    fixture.close();
  });

  /**
   * Real store, because the audit this proves IS a durable row: the archive
   * writes `graph_workflow_archived_executions` in the same transaction that
   * clears the active slot. A JS-object fake could report "archive was called"
   * while persisting nothing.
   */
  function buildRepository() {
    const eventPublisher = createGraphWorkflowExecutionEventPublisher({
      broadcast: () => {},
      dispatchPush: () => {},
    });
    return createGraphWorkflowExecutionRepository({
      getSession: fixture.store.getSession,
      getActiveGraphWorkflowExecution:
        fixture.store.getActiveGraphWorkflowExecution,
      mutateActiveGraphWorkflowExecution:
        fixture.store.mutateActiveGraphWorkflowExecution,
      reserveActiveGraphWorkflowExecution:
        fixture.store.reserveActiveGraphWorkflowExecution,
      archiveActiveGraphWorkflowExecution:
        fixture.store.archiveActiveGraphWorkflowExecution,
      markGraphWorkflowContextEventsPreReset:
        fixture.store.markGraphWorkflowContextEventsPreReset,
      eventPublisher,
      charterService: createWorkflowCharterService({
        writeFile: async () => {},
        ensureDir: async () => {},
        // The real publisher method: its delivery is combined into the events
        // the create writes, so a stub returning nothing would put an undefined
        // event into the append.
        publishCharterRegistered: eventPublisher.publishCharterRegistered,
      }),
      readConfig: async () => ({}) as GlobalConfig,
      // Injected so materialization does not shell out to git: an exclusion
      // failure now halts the run rather than being logged and stepped over, so
      // an uninjected one would fail every test in this group on `spawn git`.
      ensureCcArtifactsExcluded: async () => {},
    });
  }

  async function seedActive(execution: GraphWorkflowExecution): Promise<void> {
    await fixture.store.mutateActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
      "test.seedActive",
      () => ({ execution, events: [] }),
    );
  }

  function seed(executionId: string): GraphWorkflowExecutionSeed {
    return {
      definition: createWorkflowDefinition(),
      source: {
        kind: "template",
        definitionId: "wf-1",
        definitionRevision: 1,
        tier: "project",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition()),
      executionId,
      startedAt: "2026-04-04T00:00:00.000Z",
      inputs: {},
      ownerConversationId: null,
    };
  }

  it("archives a halted incumbent durably before the replacement takes the slot", async () => {
    const repo = buildRepository();
    await seedActive(
      createWorkflowExecution({
        id: "exec-halted",
        status: "halted",
        haltReason: { type: "recovery_error", message: "old halt" },
      }),
    );

    const created = await repo.create(PROJECT_PATH, SESSION_NAME, {
      ...seed("exec-replacement"),
    });

    expect(created.id).toBe("exec-replacement");
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.id).toBe("exec-replacement");
    // Silent replacement is what this forbids: the displaced run survives as a
    // durable archive row, not as a gap in the record.
    const archived = await fixture.store.listArchivedGraphWorkflowExecutions(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(
      archived.map((entry) => ({ id: entry.id, status: entry.status })),
    ).toEqual([{ id: "exec-halted", status: "halted" }]);
  });

  it("refuses to replace a running incumbent and archives nothing", async () => {
    const repo = buildRepository();
    await seedActive(
      createWorkflowExecution({ id: "exec-running", status: "running" }),
    );

    await expect(
      repo.create(PROJECT_PATH, SESSION_NAME, seed("exec-replacement")),
    ).rejects.toMatchObject({
      name: "WorkflowStartGuardError",
      guard: "active_execution",
    });

    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.id).toBe("exec-running");
    await expect(
      fixture.store.listArchivedGraphWorkflowExecutions(
        PROJECT_PATH,
        SESSION_NAME,
      ),
    ).resolves.toEqual([]);
  });

  it("refuses to replace a paused incumbent, which is resumable rather than terminal", async () => {
    const repo = buildRepository();
    await seedActive(
      createWorkflowExecution({ id: "exec-paused", status: "paused" }),
    );

    await expect(
      repo.create(PROJECT_PATH, SESSION_NAME, seed("exec-replacement")),
    ).rejects.toMatchObject({
      name: "WorkflowStartGuardError",
      guard: "active_execution",
    });

    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.id).toBe("exec-paused");
  });
});

describe("createGraphWorkflowExecutionRepository executionStateRevision fence", () => {
  function seedActiveExecution(
    harness: ReturnType<typeof createInMemoryRepo>,
    overrides: Partial<GraphWorkflowExecution> = {},
  ): GraphWorkflowExecution {
    const execution = createWorkflowExecution({
      id: "execution-1",
      ...overrides,
    });
    const session = makeSession();
    session.graphWorkflowExecution = execution;
    harness.sessions.set("/repo:session-1", session);
    return execution;
  }

  it("bumps executionStateRevision on every committed mutation, scheduler writes included", async () => {
    const harness = createInMemoryRepo();
    const seeded = seedActiveExecution(harness, { executionStateRevision: 4 });
    expect(seeded.executionStateRevision).toBe(4);

    const first = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({ ...execution, activeContextIds: ["context-plan"] }),
    );
    expect(first.executionStateRevision).toBe(5);

    // A scheduler-shaped write that touches no live-edit field still moves the
    // fence — `liveRevision` alone would miss it, which is the whole point.
    const second = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({
        ...execution,
        laneStates: {},
      }),
    );
    expect(second.executionStateRevision).toBe(6);
    expect(second.liveRevision).toBe(seeded.liveRevision);
    expect(
      harness.sessions.get("/repo:session-1")?.graphWorkflowExecution
        ?.executionStateRevision,
    ).toBe(6);
  });

  it("owns the counter: a reducer cannot set, freeze, or rewind it", async () => {
    const harness = createInMemoryRepo();
    seedActiveExecution(harness, { executionStateRevision: 9 });

    const next = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({ ...execution, executionStateRevision: 2 }),
    );

    expect(next.executionStateRevision).toBe(10);
  });

  it("leaves the counter untouched when the mutation is rejected", async () => {
    const harness = createInMemoryRepo();
    seedActiveExecution(harness, { executionStateRevision: 3, loopEpoch: 1 });

    await expect(
      runWithLoopFence(
        {
          projectPath: "/repo",
          sessionName: "session-1",
          executionId: "execution-1",
          loopEpoch: 0,
        },
        () =>
          harness.repo.mutateActive("/repo", "session-1", (execution) => ({
            ...execution,
            activeContextIds: ["context-stale-write"],
          })),
      ),
    ).rejects.toThrow(StaleLoopFenceError);

    expect(
      harness.sessions.get("/repo:session-1")?.graphWorkflowExecution
        ?.executionStateRevision,
    ).toBe(3);
  });
});

describe("createGraphWorkflowExecutionRepository structuralRevision fence", () => {
  function seedActiveExecution(
    harness: ReturnType<typeof createInMemoryRepo>,
    overrides: Partial<GraphWorkflowExecution> = {},
  ): GraphWorkflowExecution {
    const execution = createWorkflowExecution({
      id: "execution-1",
      ...overrides,
    });
    const session = makeSession();
    session.graphWorkflowExecution = execution;
    harness.sessions.set("/repo:session-1", session);
    return execution;
  }

  it("bumps on a definition write from a reducer that moves no live-edit field", async () => {
    // `iteration-orchestrator` appends script-validator remediation tasks to the
    // working definition inside `mutateActive`, and bumps no `liveRevision`
    // because a failing pre-merge script is not a live edit. The fence has to
    // catch it anyway — a staged batch that installs its definition wholesale
    // would otherwise delete this task and keep its task state.
    const harness = createInMemoryRepo();
    const seeded = seedActiveExecution(harness, { structuralRevision: 5 });

    const next = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => {
        execution.workingDefinition.tasks.push({
          id: "task-remediation-1",
          contextId: "context-implement",
          order: 2,
          title: "Fix pre-merge validation errors",
          instructions: "Re-run the pre-merge script and fix what it reports.",
          source: "user",
        });
        return execution;
      },
    );

    expect(next.structuralRevision).toBe(6);
    expect(next.liveRevision).toBe(seeded.liveRevision);
  });

  it("holds still for a scheduler write that leaves the structural keys alone", async () => {
    // The counterpart property: if every commit bumped it, every interleaved
    // scheduler tick would force a needless reprepare.
    const harness = createInMemoryRepo();
    seedActiveExecution(harness, { structuralRevision: 5 });

    const next = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({
        ...execution,
        activeContextIds: ["context-plan"],
        contextStates: {
          ...execution.contextStates,
          "context-plan": {
            ...execution.contextStates["context-plan"]!,
            status: "running",
          },
        },
      }),
    );

    expect(next.structuralRevision).toBe(5);
    expect(next.executionStateRevision).toBe(1);
  });

  it("owns the counter: a reducer cannot set, freeze, or rewind it", async () => {
    const harness = createInMemoryRepo();
    seedActiveExecution(harness, { structuralRevision: 9 });

    // Claims a bump it did not earn...
    const unearned = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({ ...execution, structuralRevision: 42 }),
    );
    expect(unearned.structuralRevision).toBe(9);

    // ...and hides one it did.
    const hidden = await harness.repo.mutateActive(
      "/repo",
      "session-1",
      (execution) => ({
        ...execution,
        structuralRevision: 9,
        charterAmendments: [
          {
            seq: 1,
            amendedAt: "2026-08-04T00:00:00.000Z",
            source: "cli",
            rationale: "Scope moved after the API review",
            fieldsChanged: ["mission"],
            charterHash: "hash-1",
          },
        ],
      }),
    );
    expect(hidden.structuralRevision).toBe(10);
  });
});
