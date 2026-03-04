import { describe, it, expect } from "vitest";
import { createActor, toPromise } from "xstate";
import {
  circuitBreakerMachine,
  mapMachineStateToEnum,
  type CircuitBreakerMachineInput,
} from "./circuit-breaker-machine";

// ============================================================
// Helpers
// ============================================================

function createCB(input?: CircuitBreakerMachineInput) {
  return createActor(circuitBreakerMachine, {
    input: input ?? {},
  });
}

function progress() {
  return {
    type: "ITERATION_RESULT" as const,
    classification: "progress" as const,
  };
}

function noProgress() {
  return {
    type: "ITERATION_RESULT" as const,
    classification: "no_progress" as const,
  };
}

function errorResult(pattern: string) {
  return {
    type: "ITERATION_RESULT" as const,
    classification: "no_progress" as const,
    errorPattern: pattern,
  };
}

// ============================================================
// Tests
// ============================================================

describe("circuitBreakerMachine", () => {
  describe("initial state", () => {
    it("starts in closed state with zeroed counters", () => {
      const actor = createCB();
      actor.start();
      const snap = actor.getSnapshot();

      expect(snap.value).toBe("closed");
      expect(snap.context.consecutiveNoProgress).toBe(0);
      expect(snap.context.consecutiveSameError).toBe(0);
      expect(snap.context.lastErrorPattern).toBeNull();
      expect(snap.context.lastProgressIteration).toBe(0);
    });

    it("accepts custom thresholds via input", () => {
      const actor = createCB({
        noProgressThreshold: 5,
        sameErrorThreshold: 10,
      });
      actor.start();
      const snap = actor.getSnapshot();

      expect(snap.context.noProgressThreshold).toBe(5);
      expect(snap.context.sameErrorThreshold).toBe(10);
    });

    it("uses default thresholds when not provided", () => {
      const actor = createCB();
      actor.start();
      const snap = actor.getSnapshot();

      expect(snap.context.noProgressThreshold).toBe(3);
      expect(snap.context.sameErrorThreshold).toBe(5);
    });
  });

  describe("CLOSED state transitions", () => {
    it("stays closed on progress", () => {
      const actor = createCB();
      actor.start();
      actor.send(progress());

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("closed");
      expect(snap.context.consecutiveNoProgress).toBe(0);
      expect(snap.context.lastProgressIteration).toBe(1);
    });

    it("increments no-progress counter on no_progress", () => {
      const actor = createCB();
      actor.start();
      actor.send(noProgress());

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("closed");
      expect(snap.context.consecutiveNoProgress).toBe(1);
    });

    it("resets no-progress counter on progress after no-progress", () => {
      const actor = createCB();
      actor.start();
      actor.send(noProgress());
      actor.send(noProgress());
      expect(actor.getSnapshot().context.consecutiveNoProgress).toBe(2);

      actor.send(progress());
      expect(actor.getSnapshot().context.consecutiveNoProgress).toBe(0);
      expect(actor.getSnapshot().value).toBe("closed");
    });

    it("transitions to halfOpen when noProgressThreshold reached", () => {
      const actor = createCB();
      actor.start();
      actor.send(noProgress());
      actor.send(noProgress());
      expect(actor.getSnapshot().value).toBe("closed");

      actor.send(noProgress());
      expect(actor.getSnapshot().value).toBe("halfOpen");
      expect(actor.getSnapshot().context.consecutiveNoProgress).toBe(3);
    });

    it("respects custom noProgressThreshold", () => {
      const actor = createCB({ noProgressThreshold: 1 });
      actor.start();
      actor.send(noProgress());

      expect(actor.getSnapshot().value).toBe("halfOpen");
    });

    it("transitions directly to open on sameErrorThreshold", () => {
      const actor = createCB({ sameErrorThreshold: 3 });
      actor.start();

      actor.send(errorResult("ERR_A"));
      actor.send(errorResult("ERR_A"));
      expect(actor.getSnapshot().value).toBe("closed");

      actor.send(errorResult("ERR_A"));
      expect(actor.getSnapshot().value).toBe("open");
      expect(actor.getSnapshot().status).toBe("done");
    });

    it("resets error counter when error pattern changes", () => {
      // Use high noProgressThreshold to avoid state transition from no-progress
      const actor = createCB({
        sameErrorThreshold: 5,
        noProgressThreshold: 10,
      });
      actor.start();

      actor.send(errorResult("ERR_A"));
      actor.send(errorResult("ERR_A"));
      expect(actor.getSnapshot().context.consecutiveSameError).toBe(2);

      actor.send(errorResult("ERR_B"));
      expect(actor.getSnapshot().context.consecutiveSameError).toBe(1);
      expect(actor.getSnapshot().context.lastErrorPattern).toBe("ERR_B");
      expect(actor.getSnapshot().value).toBe("closed");
    });

    it("resets error counter on non-error iteration", () => {
      const actor = createCB();
      actor.start();

      actor.send(errorResult("ERR_A"));
      actor.send(errorResult("ERR_A"));
      expect(actor.getSnapshot().context.consecutiveSameError).toBe(2);

      actor.send(progress());
      expect(actor.getSnapshot().context.consecutiveSameError).toBe(0);
      expect(actor.getSnapshot().context.lastErrorPattern).toBeNull();
    });

    it("tracks lastProgressIteration across multiple progress events", () => {
      const actor = createCB();
      actor.start();

      actor.send(progress());
      actor.send(progress());
      actor.send(progress());

      expect(actor.getSnapshot().context.lastProgressIteration).toBe(3);
    });
  });

  describe("HALF_OPEN state transitions", () => {
    function toHalfOpen() {
      const actor = createCB();
      actor.start();
      actor.send(noProgress());
      actor.send(noProgress());
      actor.send(noProgress());
      expect(actor.getSnapshot().value).toBe("halfOpen");
      return actor;
    }

    it("transitions to open on no-progress during probation", async () => {
      const actor = toHalfOpen();
      actor.send(noProgress());

      expect(actor.getSnapshot().value).toBe("open");
      expect(actor.getSnapshot().status).toBe("done");

      // Machine should produce output when reaching final state
      const output = await toPromise(actor);
      expect(output).toBeUndefined(); // final state with no output defined
    });

    it("transitions back to closed on progress during probation", () => {
      const actor = toHalfOpen();
      actor.send(progress());

      expect(actor.getSnapshot().value).toBe("closed");
      expect(actor.getSnapshot().context.consecutiveNoProgress).toBe(0);
      expect(actor.getSnapshot().context.lastProgressIteration).toBe(1);
    });

    it("transitions to open on sameErrorThreshold from halfOpen", () => {
      const actor = createCB({
        noProgressThreshold: 1,
        sameErrorThreshold: 2,
      });
      actor.start();

      // Get to halfOpen
      actor.send(noProgress());
      expect(actor.getSnapshot().value).toBe("halfOpen");

      // First error from halfOpen
      actor.send(errorResult("ERR_X"));
      // This should go to open because: halfOpen + no_progress → open
      // But the same-error check is higher priority
      // With 1 error it won't hit threshold of 2, but it IS no_progress
      // so halfOpen → open via no_progress
      expect(actor.getSnapshot().value).toBe("open");
    });

    it("opens on same error threshold even from halfOpen", () => {
      // Use errors to get to halfOpen (errors count as no-progress)
      const actor = createCB({
        noProgressThreshold: 2,
        sameErrorThreshold: 3,
      });
      actor.start();

      // Two same errors in closed → halfOpen (noProgressThreshold=2)
      actor.send(errorResult("ERR_Y"));
      actor.send(errorResult("ERR_Y"));
      expect(actor.getSnapshot().value).toBe("halfOpen");
      expect(actor.getSnapshot().context.consecutiveSameError).toBe(2);

      // Third same error hits sameErrorThreshold=3 → open
      actor.send(errorResult("ERR_Y"));
      expect(actor.getSnapshot().value).toBe("open");
      expect(actor.getSnapshot().context.consecutiveSameError).toBe(3);
    });
  });

  describe("OPEN state (terminal)", () => {
    it("is a final state — actor completes", () => {
      const actor = createCB({ sameErrorThreshold: 1 });
      actor.start();
      actor.send(errorResult("ERR"));

      expect(actor.getSnapshot().value).toBe("open");
      expect(actor.getSnapshot().status).toBe("done");
    });

    it("does not accept events after reaching open", () => {
      const actor = createCB({ sameErrorThreshold: 1 });
      actor.start();
      actor.send(errorResult("ERR"));
      expect(actor.getSnapshot().value).toBe("open");

      // These should be no-ops
      actor.send(progress());
      actor.send({ type: "RESET" });

      expect(actor.getSnapshot().value).toBe("open");
    });
  });

  describe("RESET event", () => {
    it("resets closed state counters", () => {
      const actor = createCB();
      actor.start();
      actor.send(noProgress());
      actor.send(noProgress());
      actor.send(errorResult("ERR_A"));
      expect(actor.getSnapshot().context.consecutiveNoProgress).toBe(3);

      actor.send({ type: "RESET" });

      const snap = actor.getSnapshot();
      expect(snap.value).toBe("closed");
      expect(snap.context.consecutiveNoProgress).toBe(0);
      expect(snap.context.consecutiveSameError).toBe(0);
      expect(snap.context.lastErrorPattern).toBeNull();
    });

    it("resets from halfOpen back to closed", () => {
      const actor = createCB();
      actor.start();
      actor.send(noProgress());
      actor.send(noProgress());
      actor.send(noProgress());
      expect(actor.getSnapshot().value).toBe("halfOpen");

      actor.send({ type: "RESET" });

      expect(actor.getSnapshot().value).toBe("closed");
      expect(actor.getSnapshot().context.consecutiveNoProgress).toBe(0);
    });
  });

  describe("same-error tracking across state transitions", () => {
    it("accumulates same errors across closed → halfOpen boundary", () => {
      const actor = createCB({
        noProgressThreshold: 2,
        sameErrorThreshold: 5,
      });
      actor.start();

      // Two errors in closed (also counts as no-progress)
      actor.send(errorResult("ERR_Z"));
      actor.send(errorResult("ERR_Z"));
      // Now at halfOpen (noProgressThreshold=2 reached)
      expect(actor.getSnapshot().value).toBe("halfOpen");
      expect(actor.getSnapshot().context.consecutiveSameError).toBe(2);
    });

    it("sameError threshold takes priority over noProgress in closed", () => {
      const actor = createCB({
        noProgressThreshold: 10,
        sameErrorThreshold: 3,
      });
      actor.start();

      actor.send(errorResult("SAME"));
      actor.send(errorResult("SAME"));
      expect(actor.getSnapshot().value).toBe("closed");

      actor.send(errorResult("SAME"));
      // Should go to open (sameError threshold) not stay closed
      expect(actor.getSnapshot().value).toBe("open");
    });

    it("interleaved error and progress resets same-error count", () => {
      const actor = createCB({ sameErrorThreshold: 3 });
      actor.start();

      actor.send(errorResult("ERR"));
      actor.send(errorResult("ERR"));
      expect(actor.getSnapshot().context.consecutiveSameError).toBe(2);

      actor.send(progress());
      expect(actor.getSnapshot().context.consecutiveSameError).toBe(0);

      actor.send(errorResult("ERR"));
      expect(actor.getSnapshot().context.consecutiveSameError).toBe(1);
    });
  });

  describe("complex scenarios", () => {
    it("full lifecycle: closed → halfOpen → closed → halfOpen → open", () => {
      const actor = createCB({ noProgressThreshold: 2 });
      actor.start();

      // closed → halfOpen
      actor.send(noProgress());
      actor.send(noProgress());
      expect(actor.getSnapshot().value).toBe("halfOpen");

      // halfOpen → closed (recovery)
      actor.send(progress());
      expect(actor.getSnapshot().value).toBe("closed");

      // closed → halfOpen again
      actor.send(noProgress());
      actor.send(noProgress());
      expect(actor.getSnapshot().value).toBe("halfOpen");

      // halfOpen → open (failed recovery)
      actor.send(noProgress());
      expect(actor.getSnapshot().value).toBe("open");
    });

    it("mixed progress and errors don't cause premature transitions", () => {
      const actor = createCB({
        noProgressThreshold: 3,
        sameErrorThreshold: 4,
      });
      actor.start();

      actor.send(noProgress());
      actor.send(progress());
      actor.send(noProgress());
      actor.send(progress());
      actor.send(noProgress());

      // No consecutive run of 3 no-progress
      expect(actor.getSnapshot().value).toBe("closed");
      expect(actor.getSnapshot().context.consecutiveNoProgress).toBe(1);
    });
  });

  describe("mapMachineStateToEnum", () => {
    it("maps closed correctly", () => {
      expect(mapMachineStateToEnum("closed")).toBe("closed");
    });

    it("maps halfOpen to half_open", () => {
      expect(mapMachineStateToEnum("halfOpen")).toBe("half_open");
    });

    it("maps open correctly", () => {
      expect(mapMachineStateToEnum("open")).toBe("open");
    });

    it("defaults unknown values to closed", () => {
      expect(mapMachineStateToEnum("unknown")).toBe("closed");
    });
  });
});
