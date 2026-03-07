import { describe, it, expect, vi } from "vitest";
import { createActor, toPromise, fromPromise } from "xstate";
import { createWorkflowSetup } from "./setup";
import type { BaseWorkflowContext } from "./types";

// ============================================================
// Test Types
// ============================================================

interface TestContext extends BaseWorkflowContext {
  value: string;
  error: string | null;
  finalStatus: string | null;
}

type TestEvent = { type: "ABORT" } | { type: "GO" };

interface TestInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  value: string;
}

interface TestOutput {
  status: string;
  error: string | null;
  value: string;
}

// ============================================================
// Tests
// ============================================================

describe("createWorkflowSetup", () => {
  it("returns a setup result that can create a machine", () => {
    const s = createWorkflowSetup<
      TestContext,
      TestEvent,
      TestInput,
      TestOutput
    >({});

    // setup result should have createMachine method
    expect(typeof s.createMachine).toBe("function");
  });

  it("includes onTerminal stub action by default", async () => {
    const s = createWorkflowSetup<
      TestContext,
      TestEvent,
      TestInput,
      TestOutput
    >({});

    const machine = s.createMachine({
      id: "test-setup",
      context: ({ input }) => ({
        _schemaVersion: 1,
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        startedAt: new Date().toISOString(),
        completedAt: null,
        value: input.value,
        error: null,
        finalStatus: null,
      }),
      initial: "working",
      states: {
        working: {
          on: { GO: "done" },
        },
        done: {
          type: "final",
          entry: "onTerminal",
        },
      },
      output: ({ context }) => ({
        status: "completed",
        error: context.error,
        value: context.value,
      }),
    });

    const actor = createActor(machine, {
      input: {
        projectPath: "/p",
        projectName: "p",
        sessionName: "s",
        value: "test",
      },
    });
    actor.start();
    actor.send({ type: "GO" });

    const output = await toPromise(actor);
    expect(output.status).toBe("completed");
    expect(output.value).toBe("test");
  });

  it("includes persistSnapshot stub action by default", () => {
    const s = createWorkflowSetup<
      TestContext,
      TestEvent,
      TestInput,
      TestOutput
    >({});

    // Verify we can create a machine that uses persistSnapshot without error
    const machine = s.createMachine({
      id: "test-persist",
      context: ({ input }) => ({
        _schemaVersion: 1,
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        startedAt: new Date().toISOString(),
        completedAt: null,
        value: input.value,
        error: null,
        finalStatus: null,
      }),
      initial: "working",
      states: {
        working: {
          entry: "persistSnapshot",
          on: { GO: "done" },
        },
        done: { type: "final" },
      },
      output: ({ context }) => ({
        status: "completed",
        error: context.error,
        value: context.value,
      }),
    });

    const actor = createActor(machine, {
      input: {
        projectPath: "/p",
        projectName: "p",
        sessionName: "s",
        value: "v",
      },
    });
    // Should not throw
    actor.start();
    actor.send({ type: "GO" });
  });

  it("includes broadcastStatus stub action by default", () => {
    const s = createWorkflowSetup<
      TestContext,
      TestEvent,
      TestInput,
      TestOutput
    >({});

    const machine = s.createMachine({
      id: "test-broadcast",
      context: ({ input }) => ({
        _schemaVersion: 1,
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        startedAt: new Date().toISOString(),
        completedAt: null,
        value: input.value,
        error: null,
        finalStatus: null,
      }),
      initial: "working",
      states: {
        working: {
          entry: "broadcastStatus",
          on: { GO: "done" },
        },
        done: { type: "final" },
      },
      output: ({ context }) => ({
        status: "completed",
        error: context.error,
        value: context.value,
      }),
    });

    const actor = createActor(machine, {
      input: {
        projectPath: "/p",
        projectName: "p",
        sessionName: "s",
        value: "v",
      },
    });
    actor.start();
    actor.send({ type: "GO" });
  });

  it("merges custom actors into the setup", async () => {
    const s = createWorkflowSetup<
      TestContext,
      TestEvent,
      TestInput,
      TestOutput
    >({
      actors: {
        fetchData: fromPromise(async () => "fetched"),
      },
    });

    const machine = s.createMachine({
      id: "test-custom-actors",
      context: ({ input }) => ({
        _schemaVersion: 1,
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        startedAt: new Date().toISOString(),
        completedAt: null,
        value: input.value,
        error: null,
        finalStatus: null,
      }),
      initial: "fetching",
      states: {
        fetching: {
          invoke: {
            src: "fetchData",
            onDone: {
              target: "done",
            },
          },
        },
        done: { type: "final" },
      },
      output: ({ context }) => ({
        status: "completed",
        error: context.error,
        value: context.value,
      }),
    });

    const actor = createActor(machine, {
      input: {
        projectPath: "/p",
        projectName: "p",
        sessionName: "s",
        value: "v",
      },
    });
    actor.start();
    await toPromise(actor);
    expect(actor.getSnapshot().status).toBe("done");
  });

  it("merges custom actions into the setup", async () => {
    const customActionFn = vi.fn();

    const s = createWorkflowSetup<
      TestContext,
      TestEvent,
      TestInput,
      TestOutput
    >({
      actions: {
        customAction: customActionFn,
      },
    });

    const machine = s.createMachine({
      id: "test-custom-actions",
      context: ({ input }) => ({
        _schemaVersion: 1,
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        startedAt: new Date().toISOString(),
        completedAt: null,
        value: input.value,
        error: null,
        finalStatus: null,
      }),
      initial: "working",
      states: {
        working: {
          entry: "customAction",
          on: { GO: "done" },
        },
        done: { type: "final" },
      },
      output: ({ context }) => ({
        status: "completed",
        error: context.error,
        value: context.value,
      }),
    });

    const actor = createActor(machine, {
      input: {
        projectPath: "/p",
        projectName: "p",
        sessionName: "s",
        value: "v",
      },
    });
    actor.start();
    expect(customActionFn).toHaveBeenCalled();
  });

  it("merges custom guards into the setup", async () => {
    const s = createWorkflowSetup<
      TestContext,
      TestEvent,
      TestInput,
      TestOutput
    >({
      guards: {
        isReady: () => true,
      },
    });

    const machine = s.createMachine({
      id: "test-custom-guards",
      context: ({ input }) => ({
        _schemaVersion: 1,
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        startedAt: new Date().toISOString(),
        completedAt: null,
        value: input.value,
        error: null,
        finalStatus: null,
      }),
      initial: "checking",
      states: {
        checking: {
          always: [{ guard: "isReady", target: "done" }, { target: "waiting" }],
        },
        waiting: {
          type: "final",
        },
        done: { type: "final" },
      },
      output: ({ context }) => ({
        status: "completed",
        error: context.error,
        value: context.value,
      }),
    });

    const actor = createActor(machine, {
      input: {
        projectPath: "/p",
        projectName: "p",
        sessionName: "s",
        value: "v",
      },
    });
    actor.start();
    await toPromise(actor);
    expect(actor.getSnapshot().value).toBe("done");
  });

  it("custom actions can override default stubs", async () => {
    const customOnTerminal = vi.fn();

    const s = createWorkflowSetup<
      TestContext,
      TestEvent,
      TestInput,
      TestOutput
    >({
      actions: {
        onTerminal: customOnTerminal,
      },
    });

    const machine = s.createMachine({
      id: "test-override-terminal",
      context: ({ input }) => ({
        _schemaVersion: 1,
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        startedAt: new Date().toISOString(),
        completedAt: null,
        value: input.value,
        error: null,
        finalStatus: null,
      }),
      initial: "working",
      states: {
        working: {
          on: { GO: "done" },
        },
        done: {
          type: "final",
          entry: "onTerminal",
        },
      },
      output: ({ context }) => ({
        status: "completed",
        error: context.error,
        value: context.value,
      }),
    });

    const actor = createActor(machine, {
      input: {
        projectPath: "/p",
        projectName: "p",
        sessionName: "s",
        value: "v",
      },
    });
    actor.start();
    actor.send({ type: "GO" });
    await toPromise(actor);

    expect(customOnTerminal).toHaveBeenCalled();
  });
});
