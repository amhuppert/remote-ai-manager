import { describe, it, expect } from "vitest";
import { createActor, toPromise, fromPromise } from "xstate";
import { createRetryMachine } from "./retry-machine";

// ============================================================
// Test Types
// ============================================================

interface TestWorkInput {
  url: string;
}

interface TestWorkOutput {
  data: string;
}

// ============================================================
// Helpers
// ============================================================

function createTestRetryMachine(
  _maxRetries: number,
  workFn: (input: TestWorkInput) => Promise<TestWorkOutput>,
  fixFn?: (input: { error: string; workInput: TestWorkInput }) => Promise<void>,
) {
  const machine = createRetryMachine<TestWorkInput, TestWorkOutput>();

  return machine.provide({
    actors: {
      work: fromPromise<TestWorkOutput, TestWorkInput>(async ({ input }) =>
        workFn(input),
      ),
      ...(fixFn
        ? {
            fix: fromPromise<void, { error: string; workInput: TestWorkInput }>(
              async ({ input }) => fixFn(input),
            ),
          }
        : {}),
    },
  });
}

// ============================================================
// Tests
// ============================================================

describe("createRetryMachine", () => {
  describe("happy path — work succeeds on first attempt", () => {
    it("transitions to succeeded with result", async () => {
      const machine = createTestRetryMachine(3, async () => ({
        data: "success",
      }));

      const actor = createActor(machine, {
        input: { maxRetries: 3, workInput: { url: "https://example.com" } },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.success).toBe(true);
      expect(output.result).toEqual({ data: "success" });
      expect(output.error).toBeUndefined();
      expect(output.attempts).toBe(1);
    });
  });

  describe("retry with fix — work fails, fix succeeds, work succeeds on retry", () => {
    it("retries after fix and succeeds", async () => {
      let callCount = 0;

      const machine = createTestRetryMachine(
        3,
        async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error("temporary failure");
          }
          return { data: "recovered" };
        },
        async () => {
          // Fix step (no-op, just allow retry)
        },
      );

      const actor = createActor(machine, {
        input: { maxRetries: 3, workInput: { url: "https://example.com" } },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.success).toBe(true);
      expect(output.result).toEqual({ data: "recovered" });
      expect(output.attempts).toBe(2);
    });
  });

  describe("exhaustion — all retries fail", () => {
    it("returns failure after exhausting all retries", async () => {
      const machine = createTestRetryMachine(
        2,
        async () => {
          throw new Error("persistent failure");
        },
        async () => {
          // Fix doesn't actually fix it
        },
      );

      const actor = createActor(machine, {
        input: { maxRetries: 2, workInput: { url: "https://example.com" } },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.success).toBe(false);
      expect(output.result).toBeUndefined();
      expect(output.error).toBe("persistent failure");
      expect(output.attempts).toBe(3); // 1 initial + 2 retries
    });
  });

  describe("fix failure — fix itself errors", () => {
    it("goes to exhausted immediately when fix fails", async () => {
      const machine = createTestRetryMachine(
        3,
        async () => {
          throw new Error("work error");
        },
        async () => {
          throw new Error("fix also broken");
        },
      );

      const actor = createActor(machine, {
        input: { maxRetries: 3, workInput: { url: "https://example.com" } },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.success).toBe(false);
      expect(output.error).toBe("fix also broken");
      expect(output.attempts).toBe(1); // Only one attempt before fix failed
    });
  });

  describe("no-fix mode — retry without a fix step", () => {
    it("retries directly when no fix actor is provided", async () => {
      let callCount = 0;

      const machine = createRetryMachine<TestWorkInput, TestWorkOutput>();
      const provided = machine.provide({
        actors: {
          work: fromPromise<TestWorkOutput, TestWorkInput>(async () => {
            callCount++;
            if (callCount < 3) {
              throw new Error(`fail ${callCount}`);
            }
            return { data: "third time" };
          }),
        },
      });

      const actor = createActor(provided, {
        input: { maxRetries: 5, workInput: { url: "https://example.com" } },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.success).toBe(true);
      expect(output.result).toEqual({ data: "third time" });
      expect(output.attempts).toBe(3);
    });
  });

  describe("max retries = 0 — no retries allowed", () => {
    it("fails immediately on first error with no retry", async () => {
      const machine = createTestRetryMachine(0, async () => {
        throw new Error("immediate failure");
      });

      const actor = createActor(machine, {
        input: { maxRetries: 0, workInput: { url: "https://example.com" } },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.success).toBe(false);
      expect(output.error).toBe("immediate failure");
      expect(output.attempts).toBe(1);
    });
  });

  describe("fix receives error and workInput", () => {
    it("passes error message and original workInput to fix actor", async () => {
      let receivedFixInput: { error: string; workInput: TestWorkInput } | null =
        null;
      let callCount = 0;

      const machine = createTestRetryMachine(
        1,
        async () => {
          callCount++;
          if (callCount === 1) {
            throw new Error("specific error msg");
          }
          return { data: "fixed" };
        },
        async (input) => {
          receivedFixInput = input;
        },
      );

      const actor = createActor(machine, {
        input: {
          maxRetries: 1,
          workInput: { url: "https://api.example.com/data" },
        },
      });
      actor.start();

      await toPromise(actor);

      expect(receivedFixInput).not.toBeNull();
      expect(receivedFixInput!.error).toBe("specific error msg");
      expect(receivedFixInput!.workInput).toEqual({
        url: "https://api.example.com/data",
      });
    });
  });

  describe("attempt counting", () => {
    it("counts attempts correctly across multiple retries", async () => {
      let callCount = 0;

      const machine = createTestRetryMachine(
        5,
        async () => {
          callCount++;
          if (callCount < 4) {
            throw new Error(`fail ${callCount}`);
          }
          return { data: "fourth attempt" };
        },
        async () => {},
      );

      const actor = createActor(machine, {
        input: { maxRetries: 5, workInput: { url: "https://example.com" } },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.success).toBe(true);
      expect(output.attempts).toBe(4);
    });
  });

  describe("output shape", () => {
    it("succeeded output has success=true, result, no error", async () => {
      const machine = createTestRetryMachine(1, async () => ({
        data: "ok",
      }));

      const actor = createActor(machine, {
        input: { maxRetries: 1, workInput: { url: "u" } },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output).toEqual({
        success: true,
        result: { data: "ok" },
        attempts: 1,
      });
    });

    it("exhausted output has success=false, error, no result", async () => {
      const machine = createTestRetryMachine(0, async () => {
        throw new Error("fail");
      });

      const actor = createActor(machine, {
        input: { maxRetries: 0, workInput: { url: "u" } },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output).toEqual({
        success: false,
        error: "fail",
        attempts: 1,
      });
    });
  });
});
