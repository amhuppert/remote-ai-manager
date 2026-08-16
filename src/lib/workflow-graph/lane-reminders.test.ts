import { describe, expect, it } from "vitest";
import {
  LANE_REMINDER_RULES,
  computeLaneReminders,
  type LaneReminderInput,
  type LaneVerb,
} from "./lane-reminders";

/**
 * Pure-function boundary tests for the lane-reminder rule engine (doc 04 §6.3,
 * §6.4). No mocking: `computeLaneReminders` and each rule predicate are pure.
 */

function input(overrides: Partial<LaneReminderInput> = {}): LaneReminderInput {
  return {
    verb: "task-complete",
    iterationCount: 0,
    circuitBreakerThreshold: 3,
    remainingTaskCount: 1,
    halted: null,
    contextLimitStopped: false,
    allowAgentCollaboration: true,
    ...overrides,
  };
}

const ALL_VERBS: LaneVerb[] = [
  "task-complete",
  "task-add",
  "shared-doc-upsert",
  "collab-request",
];

describe("lane reminder rules — metadata (admission rule)", () => {
  it("exposes exactly the four rules in priority order, each with a non-empty evidence field", () => {
    expect(LANE_REMINDER_RULES.map((r) => r.id)).toEqual([
      "iteration-budget",
      "halted-stop",
      "final-task-self-check",
      "lane-autonomy",
    ]);
    for (const rule of LANE_REMINDER_RULES) {
      expect(rule.evidence.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("iteration-budget rule", () => {
  it("fires exactly at the threshold−iterationCount = 2 boundary", () => {
    // threshold 3, iteration 1 → 3 − 1 = 2 ≤ 2 → fires.
    const reminders = computeLaneReminders(
      input({ iterationCount: 1, circuitBreakerThreshold: 3 }),
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain("used 1 of 3 iterations");
    expect(reminders[0]).toContain("halts the workflow at 3");
    expect(reminders[0]).toContain(
      "script validators run before agent validators",
    );
  });

  it("does not fire when threshold−iterationCount = 3 (just outside the window)", () => {
    // threshold 3, iteration 0 → 3 − 0 = 3 > 2 → no rule fires.
    expect(
      computeLaneReminders(
        input({ iterationCount: 0, circuitBreakerThreshold: 3 }),
      ),
    ).toEqual([]);
  });

  it("interpolates the real N of M numbers", () => {
    const reminders = computeLaneReminders(
      input({ iterationCount: 8, circuitBreakerThreshold: 10 }),
    );
    expect(reminders[0]).toContain("used 8 of 10 iterations");
    expect(reminders[0]).toContain("halts the workflow at 10");
  });

  it("only fires for the task-complete verb", () => {
    for (const verb of ALL_VERBS) {
      const reminders = computeLaneReminders(
        input({ verb, iterationCount: 1, circuitBreakerThreshold: 3 }),
      );
      if (verb === "task-complete") {
        expect(reminders).toHaveLength(1);
      } else {
        expect(reminders).toEqual([]);
      }
    }
  });
});

describe("halted-stop rule", () => {
  it("fires for every verb when halted is set and includes the reason + end-turn guidance", () => {
    for (const verb of ALL_VERBS) {
      const reminders = computeLaneReminders(
        input({
          verb,
          iterationCount: 0,
          circuitBreakerThreshold: 3,
          halted: "iteration halted: circuit_breaker",
        }),
      );
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toContain("iteration halted: circuit_breaker");
      expect(reminders[0]).toContain("end your turn");
    }
  });

  it("does not fire when halted is null", () => {
    expect(computeLaneReminders(input({ halted: null }))).toEqual([]);
  });
});

describe("lane-autonomy rule", () => {
  it("fires for task-complete at iterationCount = 2 and mentions collab request", () => {
    const reminders = computeLaneReminders(
      // iteration 2, threshold 5 → iteration-budget silent (5 − 2 = 3 > 2), so
      // lane-autonomy is the only rule firing.
      input({ iterationCount: 2, circuitBreakerThreshold: 5 }),
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain("cctl ask");
    expect(reminders[0]).toContain("cctl workflow collab request");
  });

  it("does not fire at iterationCount = 1", () => {
    // threshold 5 keeps iteration-budget silent, isolating lane-autonomy.
    expect(
      computeLaneReminders(
        input({ iterationCount: 1, circuitBreakerThreshold: 5 }),
      ),
    ).toEqual([]);
  });

  it("does not mention collaboration when collaboration is disabled", () => {
    const reminders = computeLaneReminders(
      input({
        iterationCount: 2,
        circuitBreakerThreshold: 5,
        allowAgentCollaboration: false,
      }),
    );

    expect(reminders).toEqual([]);
    expect(reminders.join(" ").toLowerCase()).not.toContain("collab");
  });

  it("only fires for the task-complete verb", () => {
    for (const verb of ALL_VERBS) {
      // threshold 6 keeps iteration-budget silent (6 − 3 = 3 > 2), isolating
      // lane-autonomy as the sole eligible rule for task-complete.
      const reminders = computeLaneReminders(
        input({ verb, iterationCount: 3, circuitBreakerThreshold: 6 }),
      );
      if (verb === "task-complete") {
        expect(reminders).toHaveLength(1);
        expect(reminders[0]).toContain("cctl workflow collab request");
      } else {
        expect(reminders).toEqual([]);
      }
    }
  });
});

describe("final-task-self-check rule", () => {
  it("fires when the last task completes and directs a pre-validation self-check", () => {
    // threshold 5 keeps iteration-budget silent; iteration 0 keeps lane-autonomy
    // silent, isolating the self-check.
    const reminders = computeLaneReminders(
      input({
        remainingTaskCount: 0,
        iterationCount: 0,
        circuitBreakerThreshold: 5,
      }),
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain("acceptance criterion");
    expect(reminders[0]).toContain("charter invariant");
    expect(reminders[0]).toContain("applicable charter invariant");
    expect(reminders[0]).toContain("production call path");
    expect(reminders[0]).toContain("end your turn");
  });

  it("does not fire while tasks remain", () => {
    expect(
      computeLaneReminders(
        input({
          remainingTaskCount: 1,
          iterationCount: 0,
          circuitBreakerThreshold: 5,
        }),
      ),
    ).toEqual([]);
  });

  it("does not fire when the rotation gate stopped this turn", () => {
    // A context-limit stop instructs an immediate handoff; starting a
    // self-check pass would contradict it.
    expect(
      computeLaneReminders(
        input({
          remainingTaskCount: 0,
          contextLimitStopped: true,
          iterationCount: 0,
          circuitBreakerThreshold: 5,
        }),
      ),
    ).toEqual([]);
  });

  it("yields to halted-stop when the workflow is halted", () => {
    const reminders = computeLaneReminders(
      input({
        remainingTaskCount: 0,
        halted: "iteration halted: circuit_breaker",
        iterationCount: 0,
        circuitBreakerThreshold: 5,
      }),
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toContain("iteration halted: circuit_breaker");
  });

  it("only fires for the task-complete verb", () => {
    for (const verb of ALL_VERBS) {
      const reminders = computeLaneReminders(
        input({
          verb,
          remainingTaskCount: 0,
          iterationCount: 0,
          circuitBreakerThreshold: 5,
        }),
      );
      if (verb === "task-complete") {
        expect(reminders).toHaveLength(1);
        expect(reminders[0]).toContain("acceptance criterion");
      } else {
        expect(reminders).toEqual([]);
      }
    }
  });

  it("outranks lane-autonomy under the cap on the final completion", () => {
    // iteration 2, threshold 3 → iteration-budget AND lane-autonomy eligible;
    // remaining 0 adds the self-check. Cap 2 keeps budget + self-check — at the
    // final completion the self-check beats the generic collab pointer.
    const reminders = computeLaneReminders(
      input({
        remainingTaskCount: 0,
        iterationCount: 2,
        circuitBreakerThreshold: 3,
      }),
    );
    expect(reminders).toHaveLength(2);
    expect(reminders[0]).toContain("used 2 of 3 iterations");
    expect(reminders[1]).toContain("acceptance criterion");
  });
});

describe("computeLaneReminders — cap and ordering", () => {
  it("caps at 2 in rule-array order when all three are eligible", () => {
    const reminders = computeLaneReminders(
      input({
        verb: "task-complete",
        iterationCount: 2,
        circuitBreakerThreshold: 3,
        halted: "iteration halted: circuit_breaker",
      }),
    );
    // Eligible: iteration-budget (3−2=1≤2), halted-stop (halted set),
    // lane-autonomy (2≥2). Cap → first two in array order.
    expect(reminders).toHaveLength(2);
    expect(reminders[0]).toContain("used 2 of 3 iterations");
    expect(reminders[1]).toContain("iteration halted: circuit_breaker");
  });
});
