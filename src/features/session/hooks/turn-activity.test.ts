import { describe, expect, it } from "vitest";
import { canStopTurn } from "./turn-activity";

describe("canStopTurn", () => {
  it("offers stop while a turn is running", () => {
    expect(
      canStopTurn({
        sending: false,
        status: "running",
        drivenByWorkflow: false,
      }),
    ).toBe(true);
  });

  it("does NOT offer a turn-abort in waiting_for_input — no turn is running", () => {
    expect(
      canStopTurn({
        sending: false,
        status: "waiting_for_input",
        drivenByWorkflow: false,
      }),
    ).toBe(false);
  });

  it("keeps stop available while the asking turn is still streaming in this tab", () => {
    // Mid-turn ask: status already flipped to waiting_for_input but this tab's
    // stream is open (sending) — there IS a turn to abort.
    expect(
      canStopTurn({
        sending: true,
        status: "waiting_for_input",
        drivenByWorkflow: false,
      }),
    ).toBe(true);
  });

  it("suppresses stop for workflow-driven turns", () => {
    expect(
      canStopTurn({
        sending: false,
        status: "running",
        drivenByWorkflow: true,
      }),
    ).toBe(false);
  });

  it("offers nothing when idle", () => {
    expect(
      canStopTurn({
        sending: false,
        status: "awaiting",
        drivenByWorkflow: false,
      }),
    ).toBe(false);
    expect(
      canStopTurn({
        sending: false,
        status: undefined,
        drivenByWorkflow: false,
      }),
    ).toBe(false);
  });
});
