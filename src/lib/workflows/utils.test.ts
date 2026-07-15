import { describe, it, expect } from "vitest";
import {
  extractErrorMessage,
  errorAssign,
  createTerminalStates,
} from "./utils";
import { setup, createActor, toPromise, fromPromise } from "xstate";

// ============================================================
// extractErrorMessage
// ============================================================

describe("extractErrorMessage", () => {
  it("extracts message from Error objects", () => {
    const error = new Error("something went wrong");
    expect(extractErrorMessage(error)).toBe("something went wrong");
  });

  it("includes gitOutput when present on Error", () => {
    const error = new Error("git merge failed") as Error & {
      gitOutput?: string;
    };
    error.gitOutput = "CONFLICT (content): Merge conflict in src/index.ts";
    expect(extractErrorMessage(error)).toBe(
      "git merge failed\nCONFLICT (content): Merge conflict in src/index.ts",
    );
  });

  it("converts non-Error values to string", () => {
    expect(extractErrorMessage("string error")).toBe("string error");
    expect(extractErrorMessage(42)).toBe("42");
    expect(extractErrorMessage(null)).toBe("null");
    expect(extractErrorMessage(undefined)).toBe("undefined");
  });
});

// ============================================================
// errorAssign
// ============================================================

describe("errorAssign", () => {
  it("returns an assign action that sets error and completedAt", () => {
    // errorAssign() returns an XState assign action — verify by using it in a machine
    const machine = setup({
      types: {
        context: {} as { error: string | null; completedAt: string | null },
        events: {} as { type: "FAIL" },
      },
      actors: {
        work: fromPromise(async () => {
          throw new Error("boom");
        }),
      },
    }).createMachine({
      id: "test-error-assign",
      context: { error: null, completedAt: null },
      initial: "working",
      states: {
        working: {
          invoke: {
            src: "work",
            onError: {
              target: "failed",
              actions: errorAssign(),
            },
          },
        },
        failed: { type: "final" },
      },
    });

    const actor = createActor(machine);
    actor.start();

    // The machine should reach "failed" and have error + completedAt set
    return toPromise(actor).then(() => {
      const ctx = actor.getSnapshot().context;
      expect(ctx.error).toBe("boom");
      expect(ctx.completedAt).toBeTruthy();
      expect(new Date(ctx.completedAt!).getTime()).toBeGreaterThan(0);
    });
  });

  it("handles non-Error values via extractErrorMessage", async () => {
    const machine = setup({
      types: {
        context: {} as { error: string | null; completedAt: string | null },
        events: {} as { type: "FAIL" },
      },
      actors: {
        work: fromPromise(async () => {
          throw "string thrown";
        }),
      },
    }).createMachine({
      id: "test-error-assign-string",
      context: { error: null, completedAt: null },
      initial: "working",
      states: {
        working: {
          invoke: {
            src: "work",
            onError: {
              target: "failed",
              actions: errorAssign(),
            },
          },
        },
        failed: { type: "final" },
      },
    });

    const actor = createActor(machine);
    actor.start();
    await toPromise(actor);

    expect(actor.getSnapshot().context.error).toBe("string thrown");
  });
});

// ============================================================
// createTerminalStates
// ============================================================

describe("createTerminalStates", () => {
  it("generates final states for each requested status", () => {
    const terminals = createTerminalStates(["completed", "failed"] as const);
    // Cast to inspect runtime shape (return type is `never` for XState compatibility)
    const raw = terminals as unknown as Record<string, { type: string }>;

    expect(raw.completed).toBeDefined();
    expect(raw.completed!.type).toBe("final");

    expect(raw.failed).toBeDefined();
    expect(raw.failed!.type).toBe("final");
  });

  it("works in a real machine — sets finalStatus on entry", async () => {
    const terminals = createTerminalStates(["completed", "failed"] as const);

    const machine = setup({
      types: {
        context: {} as {
          finalStatus: "completed" | "failed" | null;
        },
        events: {} as { type: "GO" },
      },
    }).createMachine({
      id: "test-terminal",
      context: { finalStatus: null },
      initial: "working",
      states: {
        working: {
          on: { GO: "completed" },
        },
        ...terminals,
      },
      output: ({ context }) => ({ finalStatus: context.finalStatus }),
    });

    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "GO" });

    await toPromise(actor);

    expect(actor.getSnapshot().context.finalStatus).toBe("completed");
  });

  it("supports custom terminal statuses like 'conflicts'", () => {
    const terminals = createTerminalStates([
      "completed",
      "failed",
      "conflicts",
    ] as const);
    const raw = terminals as unknown as Record<string, { type: string }>;

    expect(raw.completed!.type).toBe("final");
    expect(raw.failed!.type).toBe("final");
    expect(raw.conflicts!.type).toBe("final");
  });

  it("each terminal state assigns its own finalStatus value", async () => {
    const terminals = createTerminalStates(["completed", "failed"] as const);

    const machine = setup({
      types: {
        context: {} as {
          finalStatus: "completed" | "failed" | null;
          shouldFail: boolean;
        },
        events: {} as { type: "GO" },
      },
      guards: {
        shouldFail: ({ context }) => context.shouldFail,
      },
    }).createMachine({
      id: "test-terminal-failed",
      context: { finalStatus: null, shouldFail: true },
      initial: "working",
      states: {
        working: {
          on: {
            GO: [
              { guard: "shouldFail", target: "failed" },
              { target: "completed" },
            ],
          },
        },
        ...terminals,
      },
      output: ({ context }) => ({ finalStatus: context.finalStatus }),
    });

    const actor = createActor(machine);
    actor.start();
    actor.send({ type: "GO" });

    await toPromise(actor);

    expect(actor.getSnapshot().context.finalStatus).toBe("failed");
  });
});
