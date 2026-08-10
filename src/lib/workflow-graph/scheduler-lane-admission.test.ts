/**
 * The staged admission protocol end to end, through the real scheduler
 * (decisions D4 and D5).
 *
 * Every case runs against a REAL directory tree, because the property under
 * test is what `realpath` answers: whether two authored prefixes that read as
 * disjoint actually are, and whether the envelope the scheduler froze is still
 * the one dispatch consumes after the disk changes underneath it. A fake
 * filesystem could only prove the fake behaves as instructed.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionState } from "@/lib/sessions/schemas";
import type { GraphWorkflowArchiveOutcome } from "@/lib/state-store/setters";
import type {
  ContextPlacement,
  ResolvedWorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type {
  DisposeInput,
  DisposeResult,
  ParallelWorktrees,
  ProvisionInput,
  ProvisionLaneInput,
  ProvisionResult,
} from "@/lib/workflow-graph/parallel-worktrees";
import { classifyContextSchedulability } from "./lane-readiness";
import { planContextJoin } from "./lane-join";
import { createGraphWorkflowManager } from "./workflow-manager";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";

const SESSION_DIR = "feature-abc";
const SESSION_NAME = "session-1";

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeProjectRoot(): string {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "cc-scheduler-admission-")),
  );
  createdRoots.push(root);
  return root;
}

function laneWorktreePath(projectPath: string, laneId: string): string {
  return path.join(projectPath, ".worktrees", `${SESSION_DIR}.${laneId}`);
}

function createSession(projectPath: string): SessionState {
  return {
    sessionName: SESSION_NAME,
    worktreePath: path.join(projectPath, ".worktrees", SESSION_DIR),
    branchName: "csm/feature-abc",
    createdAt: "2026-03-27T15:00:00.000Z",
    lastActivityAt: "2026-03-27T15:00:00.000Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  };
}

/** A serialized read-modify-write repository, mirroring the production seam. */
function createRepository(initial: GraphWorkflowExecution) {
  let active = initial;
  let lock: Promise<void> = Promise.resolve();
  return {
    read: (): GraphWorkflowExecution => active,
    async getActive(): Promise<GraphWorkflowExecution> {
      return active;
    },
    async create(): Promise<GraphWorkflowExecution> {
      throw new Error("not used");
    },
    async archiveActive(): Promise<GraphWorkflowArchiveOutcome> {
      return { archived: false, reason: "no_active" };
    },
    async update(
      _projectPath: string,
      _sessionName: string,
      execution: GraphWorkflowExecution,
    ): Promise<void> {
      active = execution;
    },
    async mutateActive(
      _projectPath: string,
      _sessionName: string,
      fn: (
        execution: GraphWorkflowExecution,
      ) =>
        | GraphWorkflowExecution
        | { execution: GraphWorkflowExecution; events: unknown[] },
    ): Promise<GraphWorkflowExecution> {
      const previous = lock;
      let release!: () => void;
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await previous;
        const result = fn(structuredClone(active));
        active =
          "execution" in result && "events" in result
            ? result.execution
            : (result as GraphWorkflowExecution);
        return active;
      } finally {
        release();
      }
    },
    async markContextEventsPreReset(): Promise<number> {
      return 0;
    },
  };
}

function createWorktreesStub(
  projectPath: string,
  options: { onProvision?: (input: ProvisionLaneInput) => Promise<void> } = {},
): ParallelWorktrees & {
  provisionedLaneIds: string[];
  disposeCalls: DisposeInput[];
} {
  const provisionedLaneIds: string[] = [];
  const disposeCalls: DisposeInput[] = [];

  async function provisionLane(
    input: ProvisionLaneInput,
  ): Promise<ProvisionResult> {
    provisionedLaneIds.push(input.laneId);
    const worktreePath = laneWorktreePath(projectPath, input.laneId);
    mkdirSync(worktreePath, { recursive: true });
    if (options.onProvision) await options.onProvision(input);
    return {
      worktreePath,
      branchName: `csm/${SESSION_DIR}-${input.laneId}`,
      ignoredBaseline: [],
    };
  }

  return {
    async provision(input: ProvisionInput): Promise<ProvisionResult> {
      return provisionLane({ ...input, laneId: input.contextId });
    },
    async provisionBatch(): Promise<ProvisionResult[]> {
      throw new Error("not used");
    },
    async dispose(input: DisposeInput): Promise<DisposeResult> {
      disposeCalls.push(input);
      return { status: "removed" };
    },
    provisionLane,
    async provisionLaneBatch(
      inputs: ProvisionLaneInput[],
    ): Promise<ProvisionResult[]> {
      const results: ProvisionResult[] = [];
      for (const input of inputs) results.push(await provisionLane(input));
      return results;
    },
    async disposeLane(input: DisposeInput): Promise<DisposeResult> {
      disposeCalls.push(input);
      return { status: "removed" };
    },
    async cleanupLane(): Promise<DisposeResult> {
      return { status: "removed" };
    },
    provisionedLaneIds,
    disposeCalls,
  };
}

/**
 * `context-plan` (lane `plan`, landed) feeding `context-implement` and
 * `context-verify`. The caller decides where those two are placed and what they
 * own — the whole admission surface is expressible by varying just that.
 */
function makeFixture(input: {
  projectPath: string;
  implementPlacement: ContextPlacement;
  verifyPlacement: ContextPlacement;
  /** Lanes with an existing record (and worktree) at the start of the pass. */
  existingLaneIds?: readonly string[];
}): {
  definition: ResolvedWorkflowSemanticDefinition;
  execution: GraphWorkflowExecution;
} {
  const base = createResolvedWorkflowDefinition({
    edges: [
      {
        id: "edge-plan-implement",
        sourceContextId: "context-plan",
        targetContextId: "context-implement",
      },
      {
        id: "edge-plan-verify",
        sourceContextId: "context-plan",
        targetContextId: "context-verify",
      },
    ],
  });
  const definition: ResolvedWorkflowSemanticDefinition = {
    ...base,
    executionContexts: base.executionContexts.map((context) => {
      if (context.id === "context-implement") {
        return { ...context, placement: input.implementPlacement };
      }
      if (context.id === "context-verify") {
        return { ...context, placement: input.verifyPlacement };
      }
      return context;
    }),
  };

  const baseExecution = createWorkflowExecution({
    workingDefinition: definition,
  });
  const timestamp = "2026-03-27T12:00:00.000Z";
  const executionLanes: GraphWorkflowExecution["executionLanes"] = {
    plan: {
      laneId: "plan",
      kind: "worktree",
      status: "active",
      worktreePath: laneWorktreePath(input.projectPath, "plan"),
      branchName: `csm/${SESSION_DIR}-plan`,
      includedContextIds: ["context-plan"],
      lastCommittingContextId: "context-plan",
      commitSnapshots: [],
      ignoredBaseline: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
  for (const laneId of input.existingLaneIds ?? []) {
    executionLanes[laneId] = {
      laneId,
      kind: "worktree",
      status: "active",
      worktreePath: laneWorktreePath(input.projectPath, laneId),
      branchName: `csm/${SESSION_DIR}-${laneId}`,
      // Forked from `plan`, so it already carries the upstream's work and no
      // join is owed.
      includedContextIds: ["context-plan"],
      lastCommittingContextId: "context-plan",
      commitSnapshots: [],
      ignoredBaseline: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  return {
    definition,
    execution: {
      ...baseExecution,
      status: "running",
      workingDefinition: definition,
      executionLanes,
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          iterationCount: 1,
          isolation: "worktree",
          laneId: "plan",
        },
      },
    },
  };
}

function makeManager(input: {
  projectPath: string;
  execution: GraphWorkflowExecution;
  worktrees: ParallelWorktrees;
}) {
  const repository = createRepository(input.execution);
  const manager = createGraphWorkflowManager({
    executionRepository: repository,
    async loadDefinition() {
      return null;
    },
    parallelWorktrees: input.worktrees,
    async getSession() {
      return createSession(input.projectPath);
    },
  });
  return { manager, repository };
}

describe("scheduleEligibleContexts lane admission", () => {
  it("admits two ownership-disjoint members of one lane in a single pass", async () => {
    const projectPath = makeProjectRoot();
    const implWorktree = laneWorktreePath(projectPath, "impl");
    mkdirSync(path.join(implWorktree, "src/api"), { recursive: true });
    mkdirSync(path.join(implWorktree, "src/ui"), { recursive: true });

    const { execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api"],
      },
      verifyPlacement: { lane: "impl", mode: "owned", ownedPaths: ["src/ui"] },
      existingLaneIds: ["impl"],
    });
    const worktrees = createWorktreesStub(projectPath);
    const { manager, repository } = makeManager({
      projectPath,
      execution,
      worktrees,
    });

    const result = await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
    });

    expect(result.scheduled).toMatchObject({ kind: "parallel" });
    const scheduledIds =
      result.scheduled.kind === "parallel"
        ? [...result.scheduled.contextIds].sort()
        : [];
    expect(scheduledIds).toEqual(["context-implement", "context-verify"]);

    const persisted = repository.read();
    expect(persisted.contextStates["context-implement"]?.laneId).toBe("impl");
    expect(persisted.contextStates["context-verify"]?.laneId).toBe("impl");
    // One lane hosts both: no second worktree was provisioned for the group.
    expect(worktrees.provisionedLaneIds).toEqual([]);
    // Each member carries the exact envelope it was admitted under.
    expect(
      persisted.contextStates["context-implement"]?.reservedOwnership,
    ).toEqual({
      mode: "owned",
      canonicalPrefixes: [path.join(implWorktree, "src/api")],
    });
    expect(
      persisted.contextStates["context-verify"]?.reservedOwnership,
    ).toEqual({
      mode: "owned",
      canonicalPrefixes: [path.join(implWorktree, "src/ui")],
    });
    // The reservation is released once the batch finalizes.
    expect(persisted.laneReservations).toEqual({});
  });

  it("admits a read-only member in the same pass as an owning member", async () => {
    // A reader writes nothing, so it is concurrency-safe with an owner rather
    // than merely with a full-access member: it neither collides nor is
    // collided with, and costs the lane no additional worktree.
    const projectPath = makeProjectRoot();
    const implWorktree = laneWorktreePath(projectPath, "impl");
    mkdirSync(path.join(implWorktree, "src/api"), { recursive: true });

    const { execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api"],
      },
      verifyPlacement: { lane: "impl", mode: "readOnly" },
      existingLaneIds: ["impl"],
    });
    const worktrees = createWorktreesStub(projectPath);
    const { manager, repository } = makeManager({
      projectPath,
      execution,
      worktrees,
    });

    const result = await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
    });

    expect(result.scheduled).toMatchObject({ kind: "parallel" });
    const scheduledIds =
      result.scheduled.kind === "parallel"
        ? [...result.scheduled.contextIds].sort()
        : [];
    expect(scheduledIds).toEqual(["context-implement", "context-verify"]);

    const persisted = repository.read();
    expect(persisted.contextStates["context-verify"]?.laneId).toBe("impl");
    expect(
      persisted.contextStates["context-verify"]?.reservedOwnership,
    ).toEqual({ mode: "readOnly", canonicalPrefixes: [] });
    // The reader joins the lane the owner already holds; nothing is provisioned.
    expect(worktrees.provisionedLaneIds).toEqual([]);
  });

  it("refuses a canonical alias that only materializes when the new lane's worktree is checked out", async () => {
    // The alias lives in the SOURCE BRANCH, so it does not exist anywhere on
    // disk while the pass is deciding: the lane has no worktree yet, and
    // canonicalizing `src/mirror` against a directory that has not been created
    // can only append it lexically. `git worktree add` then checks the branch
    // out and the two prefixes become one directory. Admission that trusts the
    // pre-provision freeze here would have already started both writers.
    const projectPath = makeProjectRoot();
    const implWorktree = laneWorktreePath(projectPath, "impl");

    const { execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api"],
      },
      verifyPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/mirror"],
      },
      // No existing lane: this pass mints `impl`.
    });
    const worktrees = createWorktreesStub(projectPath, {
      // Checking out the source branch is what materializes the alias.
      async onProvision() {
        mkdirSync(path.join(implWorktree, "src/api"), { recursive: true });
        symlinkSync(
          path.join(implWorktree, "src/api"),
          path.join(implWorktree, "src/mirror"),
        );
      },
    });
    const { manager, repository } = makeManager({
      projectPath,
      execution,
      worktrees,
    });

    const result = await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
    });

    const scheduledIds =
      result.scheduled.kind === "parallel"
        ? [...result.scheduled.contextIds].sort()
        : result.scheduled.kind === "solo"
          ? [result.scheduled.contextId]
          : [];
    expect(scheduledIds).toEqual(["context-implement"]);

    const persisted = repository.read();
    // The refused member holds no lane and stays eligible for a later pass,
    // where the now-existing worktree makes the collision visible up front.
    expect(persisted.contextStates["context-verify"]?.status).toBe("ready");
    expect(persisted.contextStates["context-verify"]?.laneId).toBeNull();
    expect(
      persisted.contextStates["context-verify"]?.reservedByBatchId,
    ).toBeNull();
    expect(persisted.laneReservations).toEqual({});
    // The admitted member carries the post-checkout canonical envelope, not the
    // lexical one frozen before the worktree existed.
    expect(
      persisted.contextStates["context-implement"]?.reservedOwnership,
    ).toEqual({
      mode: "owned",
      canonicalPrefixes: [path.join(implWorktree, "src/api")],
    });
    // The lane it minted still hosts the admitted member.
    expect(worktrees.provisionedLaneIds).toEqual(["impl"]);
    expect(persisted.contextStates["context-implement"]?.laneId).toBe("impl");
  });

  it("refuses the second same-pass member when a symlink aliases their owned prefixes", async () => {
    const projectPath = makeProjectRoot();
    const implWorktree = laneWorktreePath(projectPath, "impl");
    mkdirSync(path.join(implWorktree, "src/api"), { recursive: true });
    // Lexically disjoint, one directory on disk.
    symlinkSync(
      path.join(implWorktree, "src/api"),
      path.join(implWorktree, "src/mirror"),
    );

    const { execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api"],
      },
      verifyPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/mirror"],
      },
      existingLaneIds: ["impl"],
    });
    const worktrees = createWorktreesStub(projectPath);
    const { manager, repository } = makeManager({
      projectPath,
      execution,
      worktrees,
    });

    const result = await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
    });

    const scheduledIds =
      result.scheduled.kind === "parallel"
        ? result.scheduled.contextIds
        : result.scheduled.kind === "solo"
          ? [result.scheduled.contextId]
          : [];
    expect(scheduledIds).toEqual(["context-implement"]);
    // The refused member stays eligible rather than failing.
    const persisted = repository.read();
    expect(persisted.contextStates["context-verify"]?.status).toBe("ready");
    expect(persisted.contextStates["context-verify"]?.laneId).toBeNull();
  });

  it("refuses owners aliased by a symlink whose target does not exist yet", async () => {
    // Git does not track empty directories, so a checked-out tree routinely
    // holds `src/mirror -> generated` while `src/generated` is absent. Both
    // `realpath` and `mkdir -p` fail on that link (ENOENT), so anything that
    // falls back to the authored spelling freezes the two owners as distinct —
    // and they alias the moment either one creates the directory.
    const projectPath = makeProjectRoot();
    const implWorktree = laneWorktreePath(projectPath, "impl");
    mkdirSync(path.join(implWorktree, "src"), { recursive: true });
    symlinkSync("generated", path.join(implWorktree, "src/mirror"));

    const { execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/mirror"],
      },
      verifyPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/generated"],
      },
      existingLaneIds: ["impl"],
    });
    const worktrees = createWorktreesStub(projectPath);
    const { manager, repository } = makeManager({
      projectPath,
      execution,
      worktrees,
    });

    const result = await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
    });

    const scheduledIds =
      result.scheduled.kind === "parallel"
        ? [...result.scheduled.contextIds].sort()
        : result.scheduled.kind === "solo"
          ? [result.scheduled.contextId]
          : [];
    expect(scheduledIds).toEqual(["context-implement"]);

    const persisted = repository.read();
    expect(persisted.contextStates["context-verify"]?.status).toBe("ready");
    expect(persisted.contextStates["context-verify"]?.laneId).toBeNull();
    // The dangling link resolved to the path it WILL denote, so the collision
    // is visible before either owner creates the directory.
    expect(
      persisted.contextStates["context-implement"]?.reservedOwnership,
    ).toEqual({
      mode: "owned",
      canonicalPrefixes: [path.join(implWorktree, "src/generated")],
    });
  });

  it("refuses owners aliased through a symlinked ancestor of a link target", async () => {
    // The alias is only visible if the link target's OWN components are
    // resolved too: `src/mirror -> alias/handlers` over `src/alias -> api`.
    const projectPath = makeProjectRoot();
    const implWorktree = laneWorktreePath(projectPath, "impl");
    mkdirSync(path.join(implWorktree, "src/api/handlers"), { recursive: true });
    symlinkSync("api", path.join(implWorktree, "src/alias"));
    symlinkSync("alias/handlers", path.join(implWorktree, "src/mirror"));

    const { execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api/handlers"],
      },
      verifyPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/mirror"],
      },
      existingLaneIds: ["impl"],
    });
    const worktrees = createWorktreesStub(projectPath);
    const { manager, repository } = makeManager({
      projectPath,
      execution,
      worktrees,
    });

    const result = await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
    });

    const scheduledIds =
      result.scheduled.kind === "parallel"
        ? [...result.scheduled.contextIds].sort()
        : result.scheduled.kind === "solo"
          ? [result.scheduled.contextId]
          : [];
    expect(scheduledIds).toEqual(["context-implement"]);

    const persisted = repository.read();
    expect(persisted.contextStates["context-verify"]?.status).toBe("ready");
    expect(persisted.contextStates["context-verify"]?.laneId).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses the member whose ownership probe fails, and admits the rest of the pass",
    async () => {
      // A probe that cannot decide whether a component is a symlink is not
      // evidence of absence. The member whose envelope could not be frozen is
      // refused rather than admitted on its authored spelling; the pass is not
      // aborted for members whose envelopes resolved.
      const projectPath = makeProjectRoot();
      const implWorktree = laneWorktreePath(projectPath, "impl");
      mkdirSync(path.join(implWorktree, "src/api"), { recursive: true });
      const locked = path.join(implWorktree, "src/locked");
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);

      try {
        const { execution } = makeFixture({
          projectPath,
          implementPlacement: {
            lane: "impl",
            mode: "owned",
            ownedPaths: ["src/api"],
          },
          verifyPlacement: {
            lane: "impl",
            mode: "owned",
            ownedPaths: ["src/locked/inner"],
          },
          existingLaneIds: ["impl"],
        });
        const worktrees = createWorktreesStub(projectPath);
        const { manager, repository } = makeManager({
          projectPath,
          execution,
          worktrees,
        });

        const result = await manager.scheduleEligibleContexts({
          projectPath,
          sessionName: SESSION_NAME,
        });

        const scheduledIds =
          result.scheduled.kind === "parallel"
            ? [...result.scheduled.contextIds].sort()
            : result.scheduled.kind === "solo"
              ? [result.scheduled.contextId]
              : [];
        expect(scheduledIds).toEqual(["context-implement"]);

        const persisted = repository.read();
        expect(persisted.contextStates["context-verify"]?.status).toBe("ready");
        expect(persisted.contextStates["context-verify"]?.laneId).toBeNull();
        // Nothing was reserved for it: no stamp and no frozen envelope.
        expect(
          persisted.contextStates["context-verify"]?.reservedByBatchId ?? null,
        ).toBeNull();
        expect(
          persisted.contextStates["context-verify"]?.reservedOwnership ?? null,
        ).toBeNull();
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  it("never admits a full-access member alongside an owning member in one pass", async () => {
    const projectPath = makeProjectRoot();
    mkdirSync(path.join(laneWorktreePath(projectPath, "impl"), "src/api"), {
      recursive: true,
    });

    const { execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api"],
      },
      verifyPlacement: { lane: "impl", mode: "full" },
      existingLaneIds: ["impl"],
    });
    const worktrees = createWorktreesStub(projectPath);
    const { manager } = makeManager({ projectPath, execution, worktrees });

    const result = await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
    });

    const scheduledIds =
      result.scheduled.kind === "parallel"
        ? result.scheduled.contextIds
        : result.scheduled.kind === "solo"
          ? [result.scheduled.contextId]
          : [];
    expect(scheduledIds).toEqual(["context-implement"]);
  });

  it("counts a reservation held by another batch against maxConcurrentQueries", async () => {
    const projectPath = makeProjectRoot();
    const implWorktree = laneWorktreePath(projectPath, "impl");
    mkdirSync(path.join(implWorktree, "src/api"), { recursive: true });
    mkdirSync(path.join(implWorktree, "src/ui"), { recursive: true });

    const { execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api"],
      },
      verifyPlacement: { lane: "impl", mode: "owned", ownedPaths: ["src/ui"] },
      existingLaneIds: ["impl"],
    });
    // A sibling batch already holds one of the two slots this pass was offered.
    const withForeignReservation: GraphWorkflowExecution = {
      ...execution,
      laneReservations: {
        other: {
          laneId: "other",
          batchId: "batch-elsewhere",
          provisioning: true,
          members: [
            {
              contextId: "context-elsewhere",
              ownership: { mode: "full", canonicalPrefixes: [] },
            },
          ],
          createdAt: "2026-03-27T12:00:00.000Z",
        },
      },
    };
    const worktrees = createWorktreesStub(projectPath);
    const { manager } = makeManager({
      projectPath,
      execution: withForeignReservation,
      worktrees,
    });

    const result = await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
      capacityRemaining: 2,
    });

    const scheduledIds =
      result.scheduled.kind === "parallel"
        ? result.scheduled.contextIds
        : result.scheduled.kind === "solo"
          ? [result.scheduled.contextId]
          : [];
    expect(scheduledIds).toEqual(["context-implement"]);
  });

  it("dispatches the frozen envelope when a symlink is retargeted between canonicalization and finalize", async () => {
    const projectPath = makeProjectRoot();
    const implWorktree = laneWorktreePath(projectPath, "impl");
    mkdirSync(path.join(implWorktree, "src/original"), { recursive: true });
    mkdirSync(path.join(implWorktree, "src/hijacked"), { recursive: true });
    symlinkSync(
      path.join(implWorktree, "src/original"),
      path.join(implWorktree, "src/owned"),
    );

    const { execution } = makeFixture({
      projectPath,
      // Mints a lane, so provisioning runs out of the lock and the retarget
      // lands in the window between canonicalization and finalize.
      implementPlacement: {
        lane: "impl2",
        mode: "owned",
        ownedPaths: ["src/x"],
      },
      verifyPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/owned"],
      },
      existingLaneIds: ["impl"],
    });
    const worktrees = createWorktreesStub(projectPath, {
      async onProvision() {
        rmSync(path.join(implWorktree, "src/owned"));
        symlinkSync(
          path.join(implWorktree, "src/hijacked"),
          path.join(implWorktree, "src/owned"),
        );
      },
    });
    const { manager, repository } = makeManager({
      projectPath,
      execution,
      worktrees,
    });

    await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
    });

    // What dispatch consumes is what was reserved, not what the disk says now.
    expect(
      repository.read().contextStates["context-verify"]?.reservedOwnership,
    ).toEqual({
      mode: "owned",
      canonicalPrefixes: [path.join(implWorktree, "src/original")],
    });
  });

  it("provisions one worktree and one lane record when a concurrent scheduler admits a second member of the same new lane", async () => {
    const projectPath = makeProjectRoot();

    const { execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api"],
      },
      verifyPlacement: { lane: "impl", mode: "owned", ownedPaths: ["src/ui"] },
    });
    // `context-verify` only becomes eligible once the concurrent pass runs, so
    // the second scheduler meets the lane while it is still being provisioned.
    const gated: GraphWorkflowExecution = {
      ...execution,
      workingDefinition: {
        ...execution.workingDefinition,
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-implement-verify",
            sourceContextId: "context-implement",
            targetContextId: "context-verify",
          },
        ],
      },
    };

    let concurrentRan = false;
    const worktrees = createWorktreesStub(projectPath, {
      async onProvision() {
        if (concurrentRan) return;
        concurrentRan = true;
        await manager.scheduleEligibleContexts({
          projectPath,
          sessionName: SESSION_NAME,
        });
      },
    });
    const { manager, repository } = makeManager({
      projectPath,
      execution: gated,
      worktrees,
    });

    await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
    });

    expect(concurrentRan).toBe(true);
    expect(worktrees.provisionedLaneIds).toEqual(["impl"]);
    const persisted = repository.read();
    expect(Object.keys(persisted.executionLanes).sort()).toEqual([
      "impl",
      "plan",
    ]);
    expect(persisted.laneReservations).toEqual({});
  });

  it("neither starts nor clears a context whose reservation a replacement batch took over mid-provision", async () => {
    const projectPath = makeProjectRoot();

    const { execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api"],
      },
      verifyPlacement: { lane: "review", mode: "owned", ownedPaths: ["docs"] },
    });

    let repositoryRef: ReturnType<typeof createRepository> | null = null;
    const worktrees = createWorktreesStub(projectPath, {
      // Reservation recovery (or a replacement batch) re-claims one context
      // while this pass is still cutting worktrees.
      async onProvision() {
        const repo = repositoryRef;
        if (!repo) return;
        await repo.mutateActive(projectPath, SESSION_NAME, (exec) => {
          const state = exec.contextStates["context-verify"];
          if (state) state.reservedByBatchId = "batch-replacement";
          return exec;
        });
      },
    });
    const { manager, repository } = makeManager({
      projectPath,
      execution,
      worktrees,
    });
    repositoryRef = repository;

    const result = await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
    });

    const scheduledIds =
      result.scheduled.kind === "parallel"
        ? [...result.scheduled.contextIds].sort()
        : result.scheduled.kind === "solo"
          ? [result.scheduled.contextId]
          : [];
    expect(scheduledIds).toEqual(["context-implement"]);

    const persisted = repository.read();
    // The new owner's claim survives: this batch neither ran the context under
    // a plan that owner did not make, nor erased the stamp out from under it.
    expect(persisted.contextStates["context-verify"]?.reservedByBatchId).toBe(
      "batch-replacement",
    );
    expect(persisted.contextStates["context-verify"]?.status).not.toBe(
      "running",
    );
  });

  it("neither materializes the lane nor starts its members when the lane claim is replaced mid-provision", async () => {
    const projectPath = makeProjectRoot();

    const { execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api"],
      },
      verifyPlacement: { lane: "impl", mode: "owned", ownedPaths: ["src/ui"] },
    });

    let repositoryRef: ReturnType<typeof createRepository> | null = null;
    const worktrees = createWorktreesStub(projectPath, {
      // Reservation recovery hands the lane claim to a replacement batch while
      // this pass is still cutting the worktree.
      async onProvision() {
        const repo = repositoryRef;
        if (!repo) return;
        await repo.mutateActive(projectPath, SESSION_NAME, (exec) => {
          const claim = exec.laneReservations["impl"];
          if (claim) claim.batchId = "batch-replacement";
          return exec;
        });
      },
    });
    const { manager, repository } = makeManager({
      projectPath,
      execution,
      worktrees,
    });
    repositoryRef = repository;

    const result = await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
    });

    expect(result.scheduled.kind).toBe("none");
    const persisted = repository.read();
    // The stale batch neither recorded the lane nor started anyone on it.
    expect(Object.keys(persisted.executionLanes)).toEqual(["plan"]);
    for (const contextId of ["context-implement", "context-verify"]) {
      expect(persisted.contextStates[contextId]?.status).not.toBe("running");
      expect(persisted.contextStates[contextId]?.laneId).toBeNull();
    }
    // The replacement owner's claim is left intact for its own finalize.
    expect(persisted.laneReservations["impl"]?.batchId).toBe(
      "batch-replacement",
    );
  });

  it("leaks no lane reservation when provisioning fails, and the retry provisions exactly one worktree", async () => {
    const projectPath = makeProjectRoot();

    const { execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api"],
      },
      verifyPlacement: { lane: "review", mode: "owned", ownedPaths: ["docs"] },
    });

    let attempt = 0;
    const worktrees = createWorktreesStub(projectPath, {
      async onProvision() {
        attempt += 1;
        if (attempt === 1) throw new Error("git worktree add failed");
      },
    });
    const { manager, repository } = makeManager({
      projectPath,
      execution,
      worktrees,
    });

    await expect(
      manager.scheduleEligibleContexts({
        projectPath,
        sessionName: SESSION_NAME,
      }),
    ).rejects.toThrow("git worktree add failed");

    // Both reservations released: neither the per-context stamp nor the lane
    // claim survives a batch that never formed.
    const afterFailure = repository.read();
    expect(afterFailure.laneReservations).toEqual({});
    for (const contextId of ["context-implement", "context-verify"]) {
      expect(
        afterFailure.contextStates[contextId]?.reservedByBatchId ?? null,
      ).toBeNull();
    }

    const retry = await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
    });

    expect(retry.scheduled.kind).toBe("parallel");
    const persisted = repository.read();
    expect(persisted.laneReservations).toEqual({});
    // One worktree per authored lane across the whole retry — the failed
    // attempt left nothing behind that a second pass would double-provision.
    expect(
      Object.keys(persisted.executionLanes).filter(
        (laneId) => laneId !== "plan",
      ).length,
    ).toBe(worktrees.provisionedLaneIds.slice(1).length);
  });
});

describe("same-lane visibility (R3.2)", () => {
  it("runs a same-lane downstream in the shared worktree, with its upstream's landed files present and no join planned", async () => {
    const projectPath = makeProjectRoot();
    const implWorktree = laneWorktreePath(projectPath, "impl");
    mkdirSync(path.join(implWorktree, "src/api"), { recursive: true });
    mkdirSync(path.join(implWorktree, "src/ui"), { recursive: true });
    // The upstream member's landed work, sitting in the shared lane worktree.
    writeFileSync(path.join(implWorktree, "src/api/handler.ts"), "export {};");

    const { execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api"],
      },
      verifyPlacement: { lane: "impl", mode: "owned", ownedPaths: ["src/ui"] },
      existingLaneIds: ["impl"],
    });
    const chained: GraphWorkflowExecution = {
      ...execution,
      workingDefinition: {
        ...execution.workingDefinition,
        edges: [
          {
            id: "edge-plan-implement",
            sourceContextId: "context-plan",
            targetContextId: "context-implement",
          },
          {
            id: "edge-implement-verify",
            sourceContextId: "context-implement",
            targetContextId: "context-verify",
          },
        ],
      },
      executionLanes: {
        ...execution.executionLanes,
        impl: {
          ...execution.executionLanes.impl!,
          // The upstream ran here and its commit landed on the lane.
          includedContextIds: ["context-plan", "context-implement"],
          lastCommittingContextId: "context-implement",
        },
      },
      contextStates: {
        ...execution.contextStates,
        "context-implement": {
          ...execution.contextStates["context-implement"]!,
          status: "completed",
          completedTaskCount: 1,
          iterationCount: 1,
          isolation: "worktree",
          laneId: "impl",
          worktreePath: implWorktree,
        },
      },
    };

    const worktrees = createWorktreesStub(projectPath);
    const { manager } = makeManager({
      projectPath,
      execution: chained,
      worktrees,
    });

    const result = await manager.scheduleEligibleContexts({
      projectPath,
      sessionName: SESSION_NAME,
    });

    const scheduledIds =
      result.scheduled.kind === "parallel"
        ? result.scheduled.contextIds
        : result.scheduled.kind === "solo"
          ? [result.scheduled.contextId]
          : [];
    expect(scheduledIds).toEqual(["context-verify"]);

    // No join was needed, and no second worktree: the downstream's turn runs in
    // the shared lane worktree where the upstream's files already are.
    const verifyState = result.execution.contextStates["context-verify"];
    expect(verifyState?.laneId).toBe("impl");
    expect(verifyState?.worktreePath).toBe(implWorktree);
    expect(worktrees.provisionedLaneIds).toEqual([]);
    expect(
      planContextJoin({
        contextId: "context-verify",
        execution: chained,
        now: () => "2026-03-27T13:00:00.000Z",
        generateJoinId: () => "join-should-not-exist",
      }),
    ).toBeNull();
    expect(
      existsSync(path.join(verifyState!.worktreePath!, "src/api/handler.ts")),
    ).toBe(true);
  });

  it("keeps a cross-lane downstream waiting for the join that carries its upstream into the authored lane", async () => {
    const projectPath = makeProjectRoot();
    mkdirSync(laneWorktreePath(projectPath, "impl"), { recursive: true });

    const { definition, execution } = makeFixture({
      projectPath,
      implementPlacement: {
        lane: "impl",
        mode: "owned",
        ownedPaths: ["src/api"],
      },
      verifyPlacement: { lane: "impl", mode: "owned", ownedPaths: ["src/ui"] },
      existingLaneIds: ["impl"],
    });
    // `impl` did NOT fork from `plan`, so `context-plan`'s work is not in it.
    const isolated: GraphWorkflowExecution = {
      ...execution,
      executionLanes: {
        ...execution.executionLanes,
        impl: { ...execution.executionLanes.impl!, includedContextIds: [] },
      },
    };

    expect(
      classifyContextSchedulability({
        contextId: "context-verify",
        definition,
        execution: isolated,
      }),
    ).toEqual({ kind: "wait-for-join", sourceLaneIds: ["plan"] });

    const planned = planContextJoin({
      contextId: "context-verify",
      execution: isolated,
      now: () => "2026-03-27T13:00:00.000Z",
      generateJoinId: () => "join-plan-into-impl",
    });
    expect(planned).toMatchObject({
      targetLaneId: "impl",
      contextId: "context-verify",
    });
    expect(planned!.sourceLaneIds.sort()).toEqual(["impl", "plan"]);

    // Once that join succeeds, the same downstream is schedulable on `impl`.
    const joined: GraphWorkflowExecution = {
      ...isolated,
      joins: {
        [planned!.joinId]: {
          ...planned!,
          status: "succeeded",
          mergedSourceLaneIds: ["plan"],
        },
      },
    };
    expect(
      classifyContextSchedulability({
        contextId: "context-verify",
        definition,
        execution: joined,
      }),
    ).toEqual({
      kind: "schedulable",
      targetLaneId: "impl",
      requiresFork: false,
      forkFromLaneId: null,
    });
  });
});
