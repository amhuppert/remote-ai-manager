import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

describe("spec reads", () => {
  it("preserves the invalid handle cause in a CC usage refusal", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () => {
        throw new Error("must not contact server");
      },
    });
    const result = await fixture.run([
      "spec",
      "get",
      `native-sdd/${"invalid".repeat(150)}\nhandle`,
    ]);
    expect(result.exitCode, result.stdout || result.stderr).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.error.code).toBe("CC_USAGE");
    expect(envelope.error.details.cause.length).toBeGreaterThan(512);
    expect(fixture.requests).toHaveLength(0);
  });
  it("reads the addressed project's inventory", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply({ specs: [] }),
    });
    const result = await fixture.run([
      "spec",
      "list",
      "--project",
      "project two",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: { data: { specs: [] } },
    });
    expect(fixture.requests[0]?.url).toBe(
      "http://cc.test/api/specs/project%20two",
    );
  });

  it("shares the domain lint severity projection without turning findings into command failure", async () => {
    const findings = [
      {
        ruleId: "missing-proof",
        severity: "blocks_propose",
        elementHandle: "R1.1",
        message: "Attach a proof",
      },
      {
        ruleId: "style",
        severity: "advisory",
        elementHandle: "R1",
        message: "Describe the outcome",
      },
    ];
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply({ revisionId: "revision-one", findings }),
    });
    const result = await fixture.run(["spec", "lint", "native-sdd"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: {
        data: {
          lint: {
            revisionId: "revision-one",
            total: 2,
            blocking: 1,
            groups: [
              { severity: "blocks_propose", findings: [findings[0]] },
              { severity: "advisory", findings: [findings[1]] },
            ],
          },
        },
      },
    });
  });

  it("preserves query text and distinguishes project search from one-spec search", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply({ query: "space & value", results: [] }),
    });
    const result = await fixture.run([
      "spec",
      "search",
      "native-sdd",
      "space & value",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(
      new URL(fixture.requests[0]?.url ?? "http://invalid").searchParams.get(
        "q",
      ),
    ).toBe("space & value");
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: { data: { scope: "spec", search: { results: [] } } },
    });
  });

  it("refuses malformed handles locally and preserves a historical-read recovery instruction", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply(
          {
            error: "Element is historical",
            code: "historical_only",
            details: { revisionId: "old-revision" },
            instruction: "Read spec get native-sdd/R1 --revision old-revision.",
          },
          409,
        ),
    });
    const invalid = await fixture.run(["spec", "get", "native-sdd/R0"]);
    expect(invalid.exitCode).toBe(2);
    expect(fixture.requests).toHaveLength(0);
    const historical = await fixture.run(["spec", "get", "native-sdd/R1"]);
    expect(historical.exitCode).toBe(1);
    expect(JSON.parse(historical.stdout)).toMatchObject({
      error: {
        details: {
          serverCode: "historical_only",
          serverDetails: { revisionId: "old-revision" },
        },
      },
      instruction: "Read spec get native-sdd/R1 --revision old-revision.",
    });
    expect(fixture.requests).toHaveLength(1);
  });
});

it("generates offline authoring schemas from the server's documents", async () => {
  const fixture = createCcRuntimeFixture({
    respond: () => {
      throw new Error("offline command");
    },
  });
  const result = await fixture.run(["spec", "schema", "requirement"]);
  expect(result.exitCode, result.stdout).toBe(0);
  expect(fixture.requests).toHaveLength(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    payload: {
      data: {
        documents: [
          {
            id: "requirement",
            jsonSchema: { type: "object" },
            example: { kind: "requirement" },
          },
        ],
      },
    },
  });
});
