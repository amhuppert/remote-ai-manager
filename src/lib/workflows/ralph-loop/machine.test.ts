import { describe, it, expect, vi, afterEach } from "vitest";
import { createActor, fromPromise, toPromise, type AnyActorRef } from "xstate";
import { ralphLoopMachine } from "./machine";
import type {
  RalphLoopInput,
  GeneratePlanInput,
  GeneratePlanOutput,
  RunIterationInput,
  RunIterationOutput,
} from "./types";
import type {
  FixPlanTask,
  RalphLoopIterationMeta,
  CircuitBreakerState,
} from "@/types";

// ============================================================
// Test Helpers
// ============================================================

/** Yield to the macrotask queue to prevent microtask starvation. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Mock fromPromise actors include a macrotask boundary to prevent
 * XState's evaluatingExit → executingIteration loop from starving
 * the event loop when mocks resolve immediately.
 */
function mockGeneratePlan(
  fn: (ctx: { input: GeneratePlanInput }) => Promise<GeneratePlanOutput>,
) {
  return fromPromise<GeneratePlanOutput, GeneratePlanInput>(
    async ({ input }) => {
      await tick();
      return fn({ input });
    },
  );
}

function mockRunIteration(
  fn: (ctx: { input: RunIterationInput }) => Promise<RunIterationOutput>,
) {
  return fromPromise<RunIterationOutput, RunIterationInput>(
    async ({ input }) => {
      await tick();
      return fn({ input });
    },
  );
}

/** Wait for an actor to reach a specific state value. */
function waitForState(
  actor: AnyActorRef,
  stateName: string,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(
        new Error(
          `Timed out waiting for state "${stateName}" (current: ${JSON.stringify(actor.getSnapshot().value)})`,
        ),
      );
    }, timeoutMs);

    // Check immediately
    if (actor.getSnapshot().value === stateName) {
      clearTimeout(timer);
      resolve();
      // Return early — subscription not needed
      return;
    }

    const sub = actor.subscribe((snapshot) => {
      if (snapshot.value === stateName) {
        clearTimeout(timer);
        sub.unsubscribe();
        resolve();
      }
    });
  });
}

function makeTask(overrides: Partial<FixPlanTask> = {}): FixPlanTask {
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2, 8)}`,
    description: overrides.description ?? "Test task",
    group: overrides.group ?? 1,
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    completedAt: overrides.completedAt ?? null,
    skipReason: overrides.skipReason ?? null,
    addedByIteration: overrides.addedByIteration ?? null,
  };
}

function makeIterationMeta(
  overrides: Partial<RalphLoopIterationMeta> = {},
): RalphLoopIterationMeta {
  return {
    iterationNumber: overrides.iterationNumber ?? 1,
    conversationId: overrides.conversationId ?? "conv-test",
    status: overrides.status ?? "completed",
    startedAt: overrides.startedAt ?? new Date().toISOString(),
    completedAt: overrides.completedAt ?? new Date().toISOString(),
    durationMs: overrides.durationMs ?? 5000,
    costUsd: overrides.costUsd ?? 0.05,
    turns: overrides.turns ?? 10,
    gitMetrics: overrides.gitMetrics ?? {
      filesChanged: 2,
      linesAdded: 50,
      linesRemoved: 10,
      changedFiles: ["src/foo.ts", "src/bar.ts"],
    },
    statusReport: overrides.statusReport ?? {
      status: "in_progress",
      exit_signal: false,
      work_summary: "Made progress",
      work_type: "implementation",
    },
    tasksCompleted: overrides.tasksCompleted ?? [],
    tasksSkipped: overrides.tasksSkipped ?? [],
    tasksAdded: overrides.tasksAdded ?? [],
    progressClassification: overrides.progressClassification ?? "progress",
    peakContextTokens: overrides.peakContextTokens ?? 50000,
  };
}

function makeIterationOutput(
  overrides: Partial<RunIterationOutput> & {
    iterationOverrides?: Partial<RalphLoopIterationMeta>;
    planOverrides?: FixPlanTask[];
    cbOverrides?: Partial<CircuitBreakerState>;
  } = {},
): RunIterationOutput {
  const iteration = makeIterationMeta(overrides.iterationOverrides);
  return {
    iteration: overrides.iteration ?? iteration,
    updatedFixPlan: overrides.planOverrides ??
      overrides.updatedFixPlan ?? [makeTask({ status: "pending" })],
    updatedCircuitBreaker: overrides.updatedCircuitBreaker ?? {
      state: "closed",
      consecutiveNoProgress: 0,
      consecutiveSameError: 0,
      lastErrorPattern: null,
      lastProgressIteration: 1,
      ...(overrides.cbOverrides ?? {}),
    },
  };
}

const defaultInput: RalphLoopInput = {
  projectPath: "/projects/app",
  projectName: "app",
  sessionName: "test-session",
  objective: "Implement feature X",
  config: {
    maxIterations: 20,
    iterationTimeoutMs: 3_600_000,
    contextSoftLimitTokens: 160_000,
    contextHardLimitTokens: 180_000,
    circuitBreaker: {
      noProgressThreshold: 3,
      sameErrorThreshold: 5,
    },
  },
  fixPlan: [makeTask({ id: "task-1" }), makeTask({ id: "task-2" })],
  worktreePath: "/projects/app/.worktrees/test-session",
};

type ActorOverrides = {
  generatePlan?: ReturnType<typeof mockGeneratePlan>;
  runIteration?: ReturnType<typeof mockRunIteration>;
};

function createTestMachine(overrides: ActorOverrides = {}) {
  return ralphLoopMachine.provide({
    actors: {
      generatePlan:
        overrides.generatePlan ??
        mockGeneratePlan(async () => ({
          tasks: [makeTask({ id: "gen-1", description: "Generated task" })],
        })),
      runIteration:
        overrides.runIteration ??
        mockRunIteration(async () =>
          makeIterationOutput({
            planOverrides: [
              makeTask({ id: "task-1", status: "completed" }),
              makeTask({ id: "task-2", status: "completed" }),
            ],
          }),
        ),
    },
    actions: {
      broadcastWorkflowStatus: () => {},
      broadcastIterationComplete: () => {},
      broadcastCircuitBreaker: () => {},
      persistSnapshot: () => {},
    },
  });
}

// Track actors for cleanup
const activeActors: AnyActorRef[] = [];

function startMachine(
  overrides: ActorOverrides = {},
  inputOverrides: Partial<RalphLoopInput> = {},
) {
  const machine = createTestMachine(overrides);
  const actor = createActor(machine, {
    input: { ...defaultInput, ...inputOverrides },
  });
  activeActors.push(actor);
  actor.start();
  return actor;
}

afterEach(() => {
  // Stop all actors to prevent dangling subscriptions/promises
  for (const actor of activeActors) {
    try {
      actor.stop();
    } catch {
      // already stopped
    }
  }
  activeActors.length = 0;
});

// ============================================================
// Tests
// ============================================================

describe("Ralph Loop Machine", () => {
  // ──────────────────────────────────────────────────────
  // Initial State
  // ──────────────────────────────────────────────────────
  describe("initial state", () => {
    it("starts in planning state", () => {
      const actor = startMachine();
      expect(actor.getSnapshot().value).toBe("planning");
    });

    it("initializes context from input", () => {
      const actor = startMachine();
      const ctx = actor.getSnapshot().context;
      expect(ctx.objective).toBe("Implement feature X");
      expect(ctx.projectPath).toBe("/projects/app");
      expect(ctx.sessionName).toBe("test-session");
      expect(ctx.fixPlan).toHaveLength(2);
      expect(ctx.iterations).toHaveLength(0);
      expect(ctx.haltReason).toBeNull();
      expect(ctx.circuitBreaker.state).toBe("closed");
    });
  });

  // ──────────────────────────────────────────────────────
  // Plan Generation
  // ──────────────────────────────────────────────────────
  describe("plan generation", () => {
    it("transitions to generatingPlan on GENERATE_PLAN", () => {
      const actor = startMachine();
      actor.send({ type: "GENERATE_PLAN" });
      expect(actor.getSnapshot().value).toBe("generatingPlan");
      expect(actor.getSnapshot().context.generatingPlan).toBe(true);
    });

    it("transitions to awaitingConfirmation after plan generated", async () => {
      const generatedTasks = [
        makeTask({ id: "gen-1", description: "New task" }),
      ];
      const actor = startMachine({
        generatePlan: mockGeneratePlan(async () => ({
          tasks: generatedTasks,
        })),
      });
      actor.send({ type: "GENERATE_PLAN" });

      await waitForState(actor, "awaitingConfirmation");

      const ctx = actor.getSnapshot().context;
      expect(ctx.generatingPlan).toBe(false);
      expect(ctx.fixPlan).toHaveLength(3);
      expect(ctx.fixPlan[2]?.id).toBe("gen-1");
    });

    it("transitions to awaitingConfirmation on plan generation failure", async () => {
      const actor = startMachine({
        generatePlan: mockGeneratePlan(async () => {
          throw new Error("SDK timeout");
        }),
      });
      actor.send({ type: "GENERATE_PLAN" });

      await waitForState(actor, "awaitingConfirmation");

      const ctx = actor.getSnapshot().context;
      expect(ctx.generatingPlan).toBe(false);
      expect(ctx.fixPlan).toHaveLength(2);
    });

    it("allows re-generating plan from awaitingConfirmation", async () => {
      const callCount = { value: 0 };
      const actor = startMachine({
        generatePlan: mockGeneratePlan(async () => {
          callCount.value++;
          return {
            tasks: [
              makeTask({
                id: `gen-${callCount.value}`,
                description: `Task ${callCount.value}`,
              }),
            ],
          };
        }),
      });
      actor.send({ type: "GENERATE_PLAN" });
      await waitForState(actor, "awaitingConfirmation");
      expect(actor.getSnapshot().context.fixPlan).toHaveLength(3);

      // Re-generate
      actor.send({ type: "GENERATE_PLAN" });
      expect(actor.getSnapshot().value).toBe("generatingPlan");
      await waitForState(actor, "awaitingConfirmation");
      expect(actor.getSnapshot().context.fixPlan).toHaveLength(4);
    });
  });

  // ──────────────────────────────────────────────────────
  // Full Lifecycle
  // ──────────────────────────────────────────────────────
  describe("full lifecycle", () => {
    it("completes when all tasks are resolved (plan_complete)", async () => {
      const actor = startMachine({
        runIteration: mockRunIteration(async ({ input }) =>
          makeIterationOutput({
            iterationOverrides: { iterationNumber: input.iterationNumber },
            planOverrides: [
              makeTask({ id: "task-1", status: "completed" }),
              makeTask({ id: "task-2", status: "completed" }),
            ],
          }),
        ),
      });

      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output.status).toBe("completed");
      expect(output.haltReason?.type).toBe("plan_complete");
      expect(output.iterations).toHaveLength(1);
      expect(output.totalCostUsd).toBeGreaterThan(0);
    });

    it("flows through planning → generatingPlan → awaitingConfirmation → running → completed", async () => {
      const states: string[] = [];
      const actor = startMachine(
        {
          generatePlan: mockGeneratePlan(async () => ({
            tasks: [makeTask({ id: "gen-1" })],
          })),
          runIteration: mockRunIteration(async () =>
            makeIterationOutput({
              planOverrides: [
                makeTask({ id: "task-1", status: "completed" }),
                makeTask({ id: "task-2", status: "completed" }),
                makeTask({ id: "gen-1", status: "completed" }),
              ],
            }),
          ),
        },
        { fixPlan: [] },
      );

      actor.subscribe((snapshot) => {
        const value = snapshot.value;
        const stateStr =
          typeof value === "string"
            ? value
            : `running.${Object.values(value)[0]}`;
        if (states[states.length - 1] !== stateStr) {
          states.push(stateStr);
        }
      });

      // No tasks → CONFIRM_PLAN should be ignored
      actor.send({ type: "CONFIRM_PLAN" });
      expect(actor.getSnapshot().value).toBe("planning");

      actor.send({ type: "GENERATE_PLAN" });
      await waitForState(actor, "awaitingConfirmation");

      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output.status).toBe("completed");
      expect(states).toContain("planning");
      expect(states).toContain("generatingPlan");
      expect(states).toContain("awaitingConfirmation");
    });
  });

  // ──────────────────────────────────────────────────────
  // Exit Conditions
  // ──────────────────────────────────────────────────────
  describe("exit conditions", () => {
    it("halts on iteration cap reached", async () => {
      const actor = startMachine(
        {
          runIteration: mockRunIteration(async ({ input }) =>
            makeIterationOutput({
              iterationOverrides: { iterationNumber: input.iterationNumber },
              planOverrides: [makeTask({ id: "task-1", status: "pending" })],
            }),
          ),
        },
        { config: { ...defaultInput.config, maxIterations: 2 } },
      );

      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output.status).toBe("halted");
      expect(output.haltReason?.type).toBe("iteration_cap");
      expect(output.iterations).toHaveLength(2);
    });

    it("halts on circuit breaker open", async () => {
      const actor = startMachine({
        runIteration: mockRunIteration(async ({ input }) =>
          makeIterationOutput({
            iterationOverrides: {
              iterationNumber: input.iterationNumber,
              progressClassification: "no_progress",
            },
            planOverrides: [makeTask({ id: "task-1", status: "pending" })],
            cbOverrides: { state: "open" },
          }),
        ),
      });

      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output.status).toBe("halted");
      expect(output.haltReason?.type).toBe("circuit_breaker");
    });

    it("halts on permission denied (2+ consecutive)", async () => {
      let callCount = 0;
      const actor = startMachine({
        runIteration: mockRunIteration(async ({ input }) => {
          callCount++;
          return makeIterationOutput({
            iterationOverrides: {
              iterationNumber: input.iterationNumber,
              statusReport: {
                status: "blocked",
                exit_signal: false,
                work_summary: "Permission denied for file access",
                work_type: "implementation",
              },
            },
            planOverrides: [makeTask({ id: "task-1", status: "pending" })],
          });
        }),
      });

      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output.status).toBe("halted");
      expect(output.haltReason?.type).toBe("permission_denied");
      expect(callCount).toBe(2);
    });

    it("halts on test saturation (3+ of last 5 test-only)", async () => {
      let callCount = 0;
      const actor = startMachine({
        runIteration: mockRunIteration(async ({ input }) => {
          callCount++;
          return makeIterationOutput({
            iterationOverrides: {
              iterationNumber: input.iterationNumber,
              statusReport: {
                status: "in_progress",
                exit_signal: false,
                work_summary: "Running tests",
                work_type: "testing",
              },
            },
            planOverrides: [makeTask({ id: "task-1", status: "pending" })],
          });
        }),
      });

      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output.status).toBe("halted");
      expect(output.haltReason?.type).toBe("test_saturation");
      expect(callCount).toBe(3);
    });

    it("halts on stalled exit signal (2+ of last 3 signal exit, tasks remain)", async () => {
      let callCount = 0;
      const actor = startMachine({
        runIteration: mockRunIteration(async ({ input }) => {
          callCount++;
          return makeIterationOutput({
            iterationOverrides: {
              iterationNumber: input.iterationNumber,
              statusReport: {
                status: "complete",
                exit_signal: true,
                work_summary: "All done",
                work_type: "implementation",
              },
            },
            planOverrides: [makeTask({ id: "task-1", status: "pending" })],
          });
        }),
      });

      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output.status).toBe("halted");
      expect(output.haltReason?.type).toBe("stalled_exit_signal");
      if (output.haltReason?.type === "stalled_exit_signal") {
        expect(output.haltReason.remainingTasks).toBe(1);
      }
      expect(callCount).toBe(2);
    });
  });

  // ──────────────────────────────────────────────────────
  // Pause / Resume
  // ──────────────────────────────────────────────────────
  describe("pause and resume", () => {
    it("can be paused and resumed during running state", async () => {
      const iterationResolvers: Array<{
        resolve: (v: RunIterationOutput) => void;
      }> = [];

      const actor = startMachine({
        runIteration: fromPromise<RunIterationOutput, RunIterationInput>(
          () =>
            new Promise<RunIterationOutput>((resolve) => {
              iterationResolvers.push({ resolve });
            }),
        ),
      });

      actor.send({ type: "CONFIRM_PLAN" });

      // Wait for first iteration to be invoked
      await vi.waitFor(() => {
        expect(iterationResolvers).toHaveLength(1);
      });

      // Complete first iteration with pending tasks
      iterationResolvers[0]!.resolve(
        makeIterationOutput({
          iterationOverrides: { iterationNumber: 1 },
          planOverrides: [makeTask({ id: "task-1", status: "pending" })],
        }),
      );

      // Wait for second iteration to be invoked
      await vi.waitFor(() => {
        expect(iterationResolvers).toHaveLength(2);
      });

      // Pause during second iteration
      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().value).toBe("paused");

      // Resume
      actor.send({ type: "RESUME" });

      // Wait for third iteration to be invoked
      await vi.waitFor(() => {
        expect(iterationResolvers).toHaveLength(3);
      });

      // Complete with all tasks done
      iterationResolvers[2]!.resolve(
        makeIterationOutput({
          iterationOverrides: { iterationNumber: 3 },
          planOverrides: [makeTask({ id: "task-1", status: "completed" })],
        }),
      );

      const output = await toPromise(actor);
      expect(output.status).toBe("completed");
    });
  });

  // ──────────────────────────────────────────────────────
  // Abort
  // ──────────────────────────────────────────────────────
  describe("abort", () => {
    it("aborts from planning state", async () => {
      const actor = startMachine();
      actor.send({ type: "ABORT" });

      const output = await toPromise(actor);
      expect(output.status).toBe("aborted");
      expect(output.haltReason?.type).toBe("aborted");
    });

    it("aborts from awaitingConfirmation state", async () => {
      const actor = startMachine();
      actor.send({ type: "GENERATE_PLAN" });
      await waitForState(actor, "awaitingConfirmation");

      actor.send({ type: "ABORT" });

      const output = await toPromise(actor);
      expect(output.status).toBe("aborted");
    });

    it("aborts from running state", async () => {
      let resolveIteration: ((v: RunIterationOutput) => void) | null = null;

      const actor = startMachine({
        runIteration: fromPromise<RunIterationOutput, RunIterationInput>(
          () =>
            new Promise<RunIterationOutput>((resolve) => {
              resolveIteration = resolve;
            }),
        ),
      });

      actor.send({ type: "CONFIRM_PLAN" });

      await vi.waitFor(() => {
        expect(resolveIteration).not.toBeNull();
      });

      actor.send({ type: "ABORT" });

      const output = await toPromise(actor);
      expect(output.status).toBe("aborted");
      expect(output.haltReason?.type).toBe("aborted");
    });

    it("aborts from paused state", async () => {
      const resolvers: Array<{ resolve: (v: RunIterationOutput) => void }> = [];

      const actor = startMachine({
        runIteration: fromPromise<RunIterationOutput, RunIterationInput>(
          () =>
            new Promise<RunIterationOutput>((resolve) => {
              resolvers.push({ resolve });
            }),
        ),
      });

      actor.send({ type: "CONFIRM_PLAN" });
      await vi.waitFor(() => expect(resolvers).toHaveLength(1));

      // Complete first iteration
      resolvers[0]!.resolve(
        makeIterationOutput({
          iterationOverrides: { iterationNumber: 1 },
          planOverrides: [makeTask({ status: "pending" })],
        }),
      );

      // Wait for second iteration to start
      await vi.waitFor(() => expect(resolvers).toHaveLength(2));

      // Pause then abort
      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().value).toBe("paused");

      actor.send({ type: "ABORT" });

      const output = await toPromise(actor);
      expect(output.status).toBe("aborted");
    });
  });

  // ──────────────────────────────────────────────────────
  // Context Accumulation
  // ──────────────────────────────────────────────────────
  describe("context accumulation", () => {
    it("accumulates cost, duration, and peak tokens across iterations", async () => {
      let callCount = 0;
      const actor = startMachine({
        runIteration: mockRunIteration(async ({ input }) => {
          callCount++;
          const allDone = callCount >= 3;
          return makeIterationOutput({
            iterationOverrides: {
              iterationNumber: input.iterationNumber,
              costUsd: 0.1,
              durationMs: 10000,
              peakContextTokens: callCount * 20000,
            },
            planOverrides: [
              makeTask({
                id: "task-1",
                status: allDone ? "completed" : "pending",
              }),
            ],
          });
        }),
      });

      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output.status).toBe("completed");
      expect(output.iterations).toHaveLength(3);
      expect(output.totalCostUsd).toBeCloseTo(0.3, 5);
      expect(output.totalDurationMs).toBe(30000);
    });

    it("tracks circuit breaker state from iteration output", async () => {
      let callCount = 0;
      const actor = startMachine({
        runIteration: mockRunIteration(async ({ input }) => {
          callCount++;
          return makeIterationOutput({
            iterationOverrides: {
              iterationNumber: input.iterationNumber,
              progressClassification: "no_progress",
            },
            planOverrides: [makeTask({ id: "task-1", status: "pending" })],
            cbOverrides:
              callCount >= 2
                ? { state: "open" }
                : { state: "closed", consecutiveNoProgress: callCount },
          });
        }),
      });

      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output.status).toBe("halted");
      expect(output.haltReason?.type).toBe("circuit_breaker");
    });
  });

  // ──────────────────────────────────────────────────────
  // Multi-iteration
  // ──────────────────────────────────────────────────────
  describe("multi-iteration", () => {
    it("runs multiple iterations before completing", async () => {
      let callCount = 0;
      const actor = startMachine({
        runIteration: mockRunIteration(async ({ input }) => {
          callCount++;
          return makeIterationOutput({
            iterationOverrides: { iterationNumber: input.iterationNumber },
            planOverrides: [
              makeTask({
                id: "task-1",
                status: callCount >= 3 ? "completed" : "pending",
              }),
              makeTask({
                id: "task-2",
                status: callCount >= 2 ? "completed" : "pending",
              }),
            ],
          });
        }),
      });

      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output.status).toBe("completed");
      expect(output.iterations).toHaveLength(3);
      expect(callCount).toBe(3);
    });

    it("passes updated context to subsequent iterations", async () => {
      const receivedInputs: RunIterationInput[] = [];
      let callCount = 0;

      const actor = startMachine({
        runIteration: mockRunIteration(async ({ input }) => {
          receivedInputs.push({ ...input });
          callCount++;
          return makeIterationOutput({
            iterationOverrides: { iterationNumber: input.iterationNumber },
            planOverrides: [
              makeTask({
                id: "task-1",
                status: callCount >= 2 ? "completed" : "pending",
              }),
              makeTask({
                id: "task-2",
                status: callCount >= 2 ? "completed" : "pending",
              }),
            ],
          });
        }),
      });

      actor.send({ type: "CONFIRM_PLAN" });
      await toPromise(actor);

      expect(receivedInputs).toHaveLength(2);
      expect(receivedInputs[0]!.iterationNumber).toBe(1);
      expect(receivedInputs[0]!.previousIterations).toHaveLength(0);
      expect(receivedInputs[1]!.iterationNumber).toBe(2);
      expect(receivedInputs[1]!.previousIterations).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────────────
  // Iteration Errors
  // ──────────────────────────────────────────────────────
  describe("iteration errors", () => {
    it("continues after iteration error (retries next iteration)", async () => {
      let callCount = 0;
      const actor = startMachine(
        {
          runIteration: mockRunIteration(async ({ input }) => {
            callCount++;
            if (callCount === 1) {
              throw new Error("SDK connection failed");
            }
            return makeIterationOutput({
              iterationOverrides: { iterationNumber: input.iterationNumber },
              planOverrides: [
                makeTask({ id: "task-1", status: "completed" }),
                makeTask({ id: "task-2", status: "completed" }),
              ],
            });
          }),
        },
        { config: { ...defaultInput.config, maxIterations: 3 } },
      );

      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output.status).toBe("completed");
      expect(callCount).toBe(2);
    });
  });

  // ──────────────────────────────────────────────────────
  // Output Mapping
  // ──────────────────────────────────────────────────────
  describe("output mapping", () => {
    it("maps completed output correctly", async () => {
      const actor = startMachine();
      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output).toMatchObject({
        status: "completed",
        haltReason: { type: "plan_complete" },
      });
      expect(output.iterations).toBeDefined();
      expect(output.totalCostUsd).toBeDefined();
      expect(output.totalDurationMs).toBeDefined();
    });

    it("maps halted output correctly", async () => {
      const actor = startMachine(
        {
          runIteration: mockRunIteration(async ({ input }) =>
            makeIterationOutput({
              iterationOverrides: { iterationNumber: input.iterationNumber },
              planOverrides: [makeTask({ status: "pending" })],
            }),
          ),
        },
        { config: { ...defaultInput.config, maxIterations: 1 } },
      );

      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output.status).toBe("halted");
      expect(output.haltReason?.type).toBe("iteration_cap");
    });

    it("maps aborted output correctly", async () => {
      const actor = startMachine();
      actor.send({ type: "ABORT" });

      const output = await toPromise(actor);
      expect(output.status).toBe("aborted");
      expect(output.haltReason?.type).toBe("aborted");
    });
  });

  // ──────────────────────────────────────────────────────
  // Guards
  // ──────────────────────────────────────────────────────
  describe("guard logic", () => {
    it("CONFIRM_PLAN from planning requires tasks (hasTasks guard)", () => {
      const actor = startMachine({}, { fixPlan: [] });
      actor.send({ type: "CONFIRM_PLAN" });
      expect(actor.getSnapshot().value).toBe("planning");
    });

    it("CONFIRM_PLAN from planning works with tasks", () => {
      const actor = startMachine();
      actor.send({ type: "CONFIRM_PLAN" });
      expect(actor.getSnapshot().value).toEqual({
        running: "executingIteration",
      });
    });
  });

  // ──────────────────────────────────────────────────────
  // Task Resolution
  // ──────────────────────────────────────────────────────
  describe("task resolution", () => {
    it("completes when all tasks are either completed or skipped", async () => {
      const actor = startMachine({
        runIteration: mockRunIteration(async ({ input }) =>
          makeIterationOutput({
            iterationOverrides: { iterationNumber: input.iterationNumber },
            planOverrides: [
              makeTask({ id: "task-1", status: "completed" }),
              makeTask({
                id: "task-2",
                status: "skipped",
                skipReason: "Not needed",
              }),
            ],
          }),
        ),
      });

      actor.send({ type: "CONFIRM_PLAN" });

      const output = await toPromise(actor);
      expect(output.status).toBe("completed");
      expect(output.haltReason?.type).toBe("plan_complete");
    });
  });
});
