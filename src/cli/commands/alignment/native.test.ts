import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

describe("CC alignment commands", () => {
  it("proposes a decision batch with author identity and the required handoff", async () => {
    const fixture = createCcRuntimeFixture({
      files: {
        "/decisions.json": JSON.stringify({
          decisions: [{ statement: "Use SQLite" }],
        }),
      },
      respond: () => jsonReply({ batchId: "decision-batch-one", count: 1 }),
    });
    const result = await fixture.run([
      "decisions",
      "propose",
      "--file",
      "/decisions.json",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: { batchId: "decision-batch-one", count: 1 } },
      recovery: {
        references: [{ kind: "decision-batch", id: "decision-batch-one" }],
      },
      instruction: expect.stringContaining("end your turn"),
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0]?.url).toContain(
      "/sessions/session-one/alignment/decisions",
    );
    expect(JSON.parse(fixture.requests[0]?.init.body ?? "null")).toEqual({
      decisions: [{ statement: "Use SQLite" }],
      conversationId: "conversation-one",
    });
  });

  it.each(["draft_ready", "activated"] as const)(
    "reports the server's %s charter result",
    async (status) => {
      const fixture = createCcRuntimeFixture({
        files: {
          "/charter.json": JSON.stringify({
            content: "## Mission\nDeliver the CLI.",
          }),
        },
        respond: () =>
          jsonReply({ status, version: status === "activated" ? 3 : null }),
      });
      const result = await fixture.run([
        "charter",
        "write",
        "--file",
        "/charter.json",
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "applied",
        payload: {
          data: { status, version: status === "activated" ? 3 : null },
        },
      });
      expect(fixture.requests).toHaveLength(1);
      expect(JSON.parse(fixture.requests[0]?.init.body ?? "null")).toEqual({
        content: "## Mission\nDeliver the CLI.",
        conversationId: "conversation-one",
      });
    },
  );

  it("rejects a decision without its required statement", async () => {
    const fixture = createCcRuntimeFixture({
      files: {
        "/invalid.json": JSON.stringify({ decisions: [{}] }),
      },
      respond: () => {
        throw new Error("validation must not mutate");
      },
    });
    const invalid = await fixture.run([
      "decisions",
      "propose",
      "--file",
      "/invalid.json",
    ]);
    expect(invalid.exitCode).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      error: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["decisions", 0, "statement"] }),
        ]),
      },
    });
    expect(fixture.requests).toHaveLength(0);
  });

  it("preserves uncertainty without retrying a lost decision acknowledgment", async () => {
    const fixture = createCcRuntimeFixture({
      files: {
        "/decisions.json": JSON.stringify({
          decisions: [{ statement: "Use SQLite" }],
        }),
      },
      respond: () => {
        throw new Error("connection closed");
      },
    });
    const result = await fixture.run([
      "decisions",
      "propose",
      "--file",
      "/decisions.json",
    ]);
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "unknown",
      recovery: {
        references: [{ kind: "session", id: "session-one" }],
      },
    });
    expect(fixture.requests).toHaveLength(1);
  });
});
