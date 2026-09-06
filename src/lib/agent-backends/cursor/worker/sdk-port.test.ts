import { describe, expect, it } from "vitest";

import {
  toCursorModelSelection,
  resumeWithAbandonedRunRecovery,
} from "./sdk-port";

describe("toCursorModelSelection", () => {
  it("translates the complete parameter record in stable key order", () => {
    expect(
      toCursorModelSelection({
        modelId: "claude-opus-5",
        parameters: {
          context: "1m",
          cyber: "false",
          effort: "high",
          fast: "false",
          thinking: "true",
        },
      }),
    ).toEqual({
      id: "claude-opus-5",
      params: [
        { id: "context", value: "1m" },
        { id: "cyber", value: "false" },
        { id: "effort", value: "high" },
        { id: "fast", value: "false" },
        { id: "thinking", value: "true" },
      ],
    });
  });

  it("keeps an explicit empty parameter array for parameterless models", () => {
    expect(
      toCursorModelSelection({ modelId: "default", parameters: {} }),
    ).toEqual({ id: "default", params: [] });
  });
});

describe("abandoned local run recovery", () => {
  it("clears a persisted active run even when resume itself succeeds", async () => {
    let active = true;
    const result = await resumeWithAbandonedRunRecovery(
      {
        resume: async () => ({ canSend: !active }),
        listRuns: async () => ({
          items: [{ id: "abandoned", status: "running" as const }],
        }),
        cancelRun: async () => {
          active = false;
        },
      },
      true,
    );
    expect(result.canSend).toBe(true);
  });
  it.each([false, true])(
    "recovers a busy agent only with worker ownership (%s)",
    async (allowed) => {
      const busy = new Error("active run");
      let active = true;
      const cancelled: string[] = [];
      const result = resumeWithAbandonedRunRecovery(
        {
          resume: async () => {
            if (active) throw busy;
            return "same-agent";
          },
          listRuns: async (cursor) =>
            cursor === undefined
              ? {
                  items: [{ id: "finished", status: "finished" as const }],
                  nextCursor: "next",
                }
              : { items: [{ id: "abandoned", status: "running" as const }] },
          cancelRun: async (id) => {
            cancelled.push(id);
            if (id === "abandoned") active = false;
          },
        },
        allowed,
      );
      if (!allowed) {
        await expect(result).rejects.toBe(busy);
        expect(active).toBe(true);
        expect(cancelled).toEqual([]);
        return;
      }
      await expect(result).resolves.toBe("same-agent");
      expect(cancelled).toEqual(["abandoned"]);
    },
  );

  it("propagates a resume failure after one cancellation", async () => {
    const busy = new Error("active run");
    let attempts = 0;
    await expect(
      resumeWithAbandonedRunRecovery(
        {
          resume: async () => {
            attempts++;
            throw busy;
          },
          listRuns: async () => ({
            items: [{ id: "abandoned", status: "running" as const }],
          }),
          cancelRun: async () => {},
        },
        true,
      ),
    ).rejects.toBe(busy);
    expect(attempts).toBe(1);
  });
});
