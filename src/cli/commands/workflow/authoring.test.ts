import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";
const plan = JSON.stringify({
  name: "Plan",
  definition: {},
  expectedRevision: 3,
});
const ops = JSON.stringify({
  expectedRevision: 3,
  operations: [
    {
      type: "update-task",
      taskId: "task-one",
      instructions: "Verify thoroughly",
    },
  ],
});
describe("native workflow authoring", () => {
  it("runs authoritative validation without writing and retains warnings", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/plan.json": plan },
      respond: () =>
        jsonReply({
          ok: true,
          warnings: [
            {
              path: "definition.edges",
              message: "No fallback",
              recordId: "edge-one",
            },
          ],
        }),
    });
    const result = await fixture.run([
      "workflow",
      "validate",
      "--file",
      "/plan.json",
      "--tier",
      "global",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "read",
      payload: { data: { warnings: [{ recordId: "edge-one" }] } },
    });
    expect(fixture.requests[0]?.url).toContain(
      "/graph-workflow/validate?tier=global",
    );
  });
  it("preserves definition receipt, optimistic revision, acknowledgement and managed gate counts", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/plan.json": plan },
      respond: () =>
        jsonReply({
          item: {
            id: "definition-one",
            name: "Plan",
            revision: 4,
            management: { specSlug: "feature-one" },
          },
          proposeGate: { blockingBefore: 3, blockingAfter: 1 },
        }),
    });
    const result = await fixture.run([
      "workflow",
      "replace",
      "definition-one",
      "--file",
      "/plan.json",
      "--acknowledge-review",
      "sha256:abc",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      recovery: { references: [{ id: "definition-one" }] },
      payload: {
        data: {
          item: { revision: 4 },
          expectedRevision: 4,
          proposeGate: { blockingBefore: 3, blockingAfter: 1 },
        },
      },
    });
    expect(JSON.parse(fixture.requests[0]?.init.body ?? "null")).toMatchObject({
      expectedRevision: 3,
      acknowledgeReviewHash: "sha256:abc",
    });
  });
  it("reads complete review findings and records under a separate write command", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/plan.json": plan },
      respond: ({ url }) =>
        url.endsWith("/status")
          ? jsonReply({
              status: { state: "unreviewed", definitionHash: "sha256:abc" },
            })
          : jsonReply({
              id: "review-one",
              definitionHash: "sha256:abc",
              verdict: "changes_requested",
              reviewerConversationId: "conversation-one",
              reviewedAt: "2026-09-17T00:00:00Z",
            }),
    });
    expect(
      (await fixture.run(["workflow", "review", "get", "--file", "/plan.json"]))
        .exitCode,
    ).toBe(0);
    expect(fixture.requests[0]?.url).toContain("/workflows/reviews/status");
    expect(
      (
        await fixture.run([
          "workflow",
          "review",
          "record",
          "--file",
          "/plan.json",
          "--verdict",
          "changes-requested",
        ])
      ).exitCode,
    ).toBe(2);
    const written = await fixture.run([
      "workflow",
      "review",
      "record",
      "--file",
      "/plan.json",
      "--verdict",
      "changes-requested",
      "--findings",
      "Missing recovery test",
    ]);
    expect(JSON.parse(written.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: { review: { id: "review-one" } } },
    });
  });
  it("previews edits as reads and sends the next real edit without dryRun", async () => {
    const fixture = createCcRuntimeFixture({
      files: { "/ops.json": ops },
      respond: ({ init }) =>
        jsonReply({
          item: { id: "definition-one", name: "Plan", revision: 3 },
          applied: 1,
          ...(JSON.parse(init.body ?? "{}").dryRun ? { dryRun: true } : {}),
        }),
    });
    const preview = await fixture.run([
      "workflow",
      "edit-preview",
      "definition-one",
      "--file",
      "/ops.json",
    ]);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      effect: "read",
      payload: { data: { dryRun: true, expectedRevision: 3 } },
    });
    const written = await fixture.run([
      "workflow",
      "edit",
      "definition-one",
      "--file",
      "/ops.json",
    ]);
    expect(written.exitCode).toBe(0);
    expect(
      JSON.parse(fixture.requests[1]?.init.body ?? "null").dryRun,
    ).toBeUndefined();
  });
  it("preserves live parent-hash operations and authoritative semantic refusals", async () => {
    const fixture = createCcRuntimeFixture({
      files: {
        "/live.json": JSON.stringify({
          executionId: "execution-one",
          baseLiveRevision: 4,
          operations: [
            { type: "update-task", taskId: "task-one", instructions: "New" },
          ],
        }),
      },
      respond: () =>
        jsonReply(
          {
            error: "Parent changed",
            code: "revision_conflict",
            details: {
              expectedParentHash: "hash-old",
              actualParentHash: "hash-new",
            },
            instruction: "Read the current live outline.",
          },
          400,
        ),
    });
    const result = await fixture.run([
      "workflow",
      "live",
      "edit",
      "--file",
      "/live.json",
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      instruction: "Read the current live outline.",
      error: {
        details: {
          serverCode: "revision_conflict",
          serverDetails: { actualParentHash: "hash-new" },
        },
      },
    });
    expect(JSON.parse(fixture.requests[0]?.init.body ?? "null")).toMatchObject({
      executionId: "execution-one",
      baseLiveRevision: 4,
      source: "cli",
    });
  });
  it.each(["validate", "create", "replace", "run"])(
    "refuses oversized seeded document bytes before %s sends a request",
    async (verb) => {
      const fixture = createCcRuntimeFixture({
        files: {
          "/plan.json": JSON.stringify({
            expectedRevision: 3,
            definition: {
              seededDocuments: [
                {
                  relativePath: ".cc/graph-workflow-docs/input.md",
                  contents: "é".repeat(131073),
                  description: "Input",
                  readWhen: "Read first",
                },
              ],
            },
          }),
        },
        respond: () => jsonReply({}),
      });
      const result = await fixture.run([
        "workflow",
        verb,
        ...(verb === "replace" ? ["definition-one"] : []),
        "--file",
        "/plan.json",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("seededDocuments");
      expect(result.stdout).toContain("262144");
      expect(fixture.requests).toHaveLength(0);
    },
  );
});
