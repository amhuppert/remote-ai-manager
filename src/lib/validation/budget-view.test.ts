import { describe, expect, it } from "vitest";
import type {
  ValidationBudgetResponse,
  ValidationBudgetRun,
} from "@/lib/validation/api-schemas";
import {
  buildValidationBudgetView,
  validationRunHref,
} from "@/lib/validation/budget-view";

function run(
  overrides: Partial<ValidationBudgetRun> = {},
): ValidationBudgetRun {
  return {
    runId: "run-1",
    commandName: "test",
    status: "running",
    cost: 1,
    projectName: "command-center",
    sessionName: "csm/validation-budget",
    conversationId: "conv-1",
    position: null,
    ...overrides,
  };
}

function response(
  overrides: Partial<ValidationBudgetResponse> = {},
): ValidationBudgetResponse {
  return {
    available: true,
    capacity: { limit: 8, inUse: 1, queueDepth: 0 },
    runs: [run()],
    ...overrides,
  };
}

/**
 * The prototype's canonical scenario: limit 8, three running commands holding
 * 4 + 2 + 1 units, nine queued behind them.
 */
function designScenario(): ValidationBudgetResponse {
  return {
    available: true,
    capacity: { limit: 8, inUse: 7, queueDepth: 9 },
    runs: [
      run({ runId: "r-test", commandName: "test", cost: 4 }),
      run({
        runId: "r-lint",
        commandName: "lint",
        cost: 2,
        projectName: "taskgarden",
      }),
      run({ runId: "r-format", commandName: "format", cost: 1 }),
      ...Array.from({ length: 9 }, (_, index) =>
        run({
          runId: `q-${index}`,
          commandName: index === 1 ? "typecheck" : "test",
          status: "queued",
          cost: index === 1 ? 2 : 4,
          position: index,
        }),
      ),
    ],
  };
}

describe("buildValidationBudgetView", () => {
  it("hides the indicator when validation is unavailable", () => {
    expect(
      buildValidationBudgetView(
        response({
          available: false,
          capacity: { limit: 8, inUse: 4, queueDepth: 2 },
        }),
      ),
    ).toBeNull();
  });

  it("hides the indicator when nothing is running or queued", () => {
    expect(
      buildValidationBudgetView(
        response({ capacity: { limit: 8, inUse: 0, queueDepth: 0 }, runs: [] }),
      ),
    ).toBeNull();
  });

  it("reports the gauge numbers for the design scenario", () => {
    const view = buildValidationBudgetView(designScenario());

    expect(view).not.toBeNull();
    expect(view?.inUse).toBe(7);
    expect(view?.limit).toBe(8);
    expect(view?.free).toBe(1);
    expect(view?.fraction).toBeCloseTo(0.875);
    expect(view?.compactLabel).toBe("7/8");
    expect(view?.headline).toBe("7 of 8 units");
  });

  it("names the queue head's cost when it is larger than the free units", () => {
    // 1 unit free, head of queue costs 4 — FIFO never skips the head, so the
    // free unit is unusable until something releases.
    const view = buildValidationBudgetView(designScenario());

    expect(view?.detail).toBe("1 unit free — next up needs 4u");
  });

  it("blames the head, not fit, when a smaller run waits behind a large head", () => {
    // 2 free, head 4u, and a 2u run behind it that WOULD fit. Claiming
    // "nothing in the queue fits" would be false — FIFO is the blocker.
    const view = buildValidationBudgetView(
      response({
        capacity: { limit: 8, inUse: 6, queueDepth: 2 },
        runs: [
          run({ runId: "r-a", cost: 6 }),
          run({
            runId: "q-head",
            commandName: "test",
            status: "queued",
            cost: 4,
            position: 0,
          }),
          run({
            runId: "q-small",
            commandName: "lint",
            status: "queued",
            cost: 2,
            position: 1,
          }),
        ],
      }),
    );

    expect(view?.detail).toBe("2 units free — next up needs 4u");
  });

  it("reports free capacity plainly when the queue is empty", () => {
    const view = buildValidationBudgetView(
      response({
        capacity: { limit: 8, inUse: 3, queueDepth: 0 },
        runs: [run({ cost: 3 })],
      }),
    );

    expect(view?.detail).toBe("5 units free · queue empty");
  });

  it("reports the queue when the head still fits the free units", () => {
    const view = buildValidationBudgetView(
      response({
        capacity: { limit: 8, inUse: 3, queueDepth: 2 },
        runs: [
          run({ cost: 3 }),
          run({ runId: "q-0", status: "queued", cost: 2, position: 0 }),
          run({ runId: "q-1", status: "queued", cost: 4, position: 1 }),
        ],
      }),
    );

    expect(view?.detail).toBe("5 units free · 2 queued");
  });

  it("reports saturation when every unit is held", () => {
    const view = buildValidationBudgetView(
      response({
        capacity: { limit: 8, inUse: 8, queueDepth: 3 },
        runs: [run({ cost: 8 })],
      }),
    );

    expect(view?.free).toBe(0);
    expect(view?.detail).toBe("At capacity — 3 queued");
  });

  it("reads as saturated whenever work is waiting, and active otherwise", () => {
    expect(buildValidationBudgetView(designScenario())?.tone).toBe("saturated");
    expect(
      buildValidationBudgetView(
        response({ capacity: { limit: 8, inUse: 2, queueDepth: 0 } }),
      )?.tone,
    ).toBe("active");
  });

  it("maps running costs onto allocation segments and trails with the free units", () => {
    const view = buildValidationBudgetView(designScenario());

    expect(view?.allocation).toEqual([
      { kind: "run", units: 4, label: "test", runId: "r-test" },
      { kind: "run", units: 2, label: "lint", runId: "r-lint" },
      // One unit is too narrow to seat a command name.
      { kind: "run", units: 1, label: null, runId: "r-format" },
      { kind: "free", units: 1, label: null, runId: null },
    ]);
    expect(view?.allocationCaption).toBe("4 + 2 + 1 allocated · 1 free of 8");
  });

  it("omits the free segment when the budget is fully allocated", () => {
    const view = buildValidationBudgetView(
      response({
        capacity: { limit: 8, inUse: 8, queueDepth: 0 },
        runs: [run({ cost: 8, commandName: "test" })],
      }),
    );

    expect(view?.allocation).toEqual([
      { kind: "run", units: 8, label: "test", runId: "run-1" },
    ]);
    expect(view?.allocationCaption).toBe("8 allocated · 0 free of 8");
  });

  it("lists every running run and previews only the head of the queue", () => {
    const view = buildValidationBudgetView(designScenario());

    expect(view?.running.map((row) => row.commandName)).toEqual([
      "test",
      "lint",
      "format",
    ]);
    expect(view?.queued).toHaveLength(3);
    expect(view?.queuedOverflow).toBe(6);
  });

  it("numbers queued rows from one in FIFO order", () => {
    const view = buildValidationBudgetView(designScenario());

    expect(view?.queued.map((row) => row.queuePosition)).toEqual([1, 2, 3]);
    expect(view?.running.every((row) => row.queuePosition === null)).toBe(true);
  });

  it("orders running rows by the units they hold", () => {
    const view = buildValidationBudgetView(
      response({
        capacity: { limit: 8, inUse: 7, queueDepth: 0 },
        runs: [
          run({ runId: "a", commandName: "format", cost: 1 }),
          run({ runId: "b", commandName: "test", cost: 4 }),
          run({ runId: "c", commandName: "lint", cost: 2 }),
        ],
      }),
    );

    expect(view?.running.map((row) => row.commandName)).toEqual([
      "test",
      "lint",
      "format",
    ]);
  });
});

describe("validationRunHref", () => {
  it("links a session conversation to the conversations page", () => {
    expect(
      validationRunHref(
        run({ sessionName: "csm/budget", conversationId: "conv-9" }),
      ),
    ).toBe("/conversations?c=conv-9");
  });

  it("links a project conversation to the project it is focused in", () => {
    expect(
      validationRunHref(
        run({
          projectName: "command-center",
          sessionName: null,
          conversationId: "conv-9",
        }),
      ),
    ).toBe("/projects/command-center?focus=conv-9");
  });

  it("falls back to the session when the run names no conversation", () => {
    expect(
      validationRunHref(
        run({
          projectName: "command-center",
          sessionName: "csm/budget",
          conversationId: null,
        }),
      ),
    ).toBe("/projects/command-center/csm%2Fbudget");
  });

  it("falls back to the project when the run names neither", () => {
    expect(
      validationRunHref(
        run({
          projectName: "command-center",
          sessionName: null,
          conversationId: null,
        }),
      ),
    ).toBe("/projects/command-center");
  });
});
