import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

describe("native agent commands", () => {
  it.each([
    "instruction: a literal profile rule",
    "Terminal \u001b[31m sample",
  ])("renders profile prose as data: %s", async (instructions) => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          id: "reviewer",
          tier: "global",
          revision: 3,
          name: "Reviewer",
          description: "Inspect changes",
          instructions,
          recommendedFor: ["workflow_validator"],
          tags: ["review"],
          readOnly: false,
        }),
    });
    const result = await fixture.run(
      ["agent", "get", "global:reviewer"],
      "text",
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      instructions.startsWith("instruction:")
        ? "| instruction: a literal profile rule"
        : "Terminal \\u001b[31m sample",
    );
  });

  it("reads profile metadata from project context and rejects unqualified references locally", async () => {
    const fixture = createCcRuntimeFixture({
      env: { CC_SESSION: undefined },
      respond: () =>
        jsonReply({
          profiles: [],
          diagnostics: [
            { tier: "global", id: "broken", reason: "Invalid file" },
          ],
        }),
    });
    const result = await fixture.run(["agent", "list"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: { data: { diagnostics: [{ id: "broken" }] } },
    });
    expect((await fixture.run(["agent", "get", "unqualified"])).exitCode).toBe(
      2,
    );
    expect(fixture.requests).toHaveLength(1);
  });
  it("renders profile instructions from the qualified project library route", async () => {
    const fixture = createCcRuntimeFixture({
      env: { CC_SESSION: undefined },
      respond: () =>
        jsonReply({
          id: "reviewer",
          tier: "global",
          revision: 3,
          name: "Reviewer",
          description: "Inspect changes",
          instructions: "Review the evidence thoroughly.",
          recommendedFor: ["workflow_validator"],
          tags: ["review"],
          readOnly: false,
        }),
    });
    const result = await fixture.run(
      ["agent", "get", "global:reviewer"],
      "text",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Review the evidence thoroughly.");
    expect(fixture.requests[0]?.url).toBe(
      "http://cc.test/api/projects/project-one/agent-profiles/global/reviewer",
    );
  });
});
