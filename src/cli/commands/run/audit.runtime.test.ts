import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

const audit = {
  coverage: {
    contextSeatTranscripts: true,
    ephemeralLaneTaskTranscripts: false,
    providerWireRequests: false,
  },
  run: {
    runId: "run-1",
    title: "Review output",
    kind: "workflow",
    projectPath: "/repo",
    sessionName: "elsewhere",
    ownerConversationId: "owner",
    progress: "succeeded",
    revision: 3,
    createdAt: "2026-10-15T10:00:00Z",
    updatedAt: "2026-10-15T10:01:00Z",
  },
  selection: { context: null, full: false, limit: 1, offset: 0 },
  totals: {
    definitions: 2,
    invocations: 2,
    passes: 1,
    conversations: 3,
    missingSeatBindings: 0,
    candidates: 2,
    reviewRounds: 2,
    acceptances: 2,
    unavailableContexts: 0,
    boundaries: 1,
    workspaceOperations: 4,
    deliveries: 1,
    wakeBatches: 1,
  },
  contexts: {
    total: 2,
    returned: 1,
    offset: 0,
    nextOffset: 1,
    items: [
      {
        key: "build",
        pass: 1,
        contextId: "run-1.build",
        started: true,
        current: true,
        available: true,
        progress: "succeeded",
        counts: {
          conversations: 2,
          missingSeatBindings: 0,
          candidates: 1,
          reviewRounds: 1,
          acceptances: 1,
        },
      },
    ],
  },
};

describe("run audit CLI", () => {
  it("reads globally by id and gives exact bounded continuation and context handles", async () => {
    const fixture = createCcRuntimeFixture({
      env: { CC_SESSION: "", CC_CONVERSATION_SCOPE: "project" },
      respond: () => jsonReply(audit),
    });
    const result = await fixture.run(["run", "audit", "run-1", "--limit", "1"]);
    expect(result.exitCode, result.stderr).toBe(0);
    const url = new URL(fixture.requests[0]?.url ?? "http://missing");
    expect(url.pathname).toBe("/api/runs/run-1/audit");
    expect(url.searchParams.get("limit")).toBe("1");
    const data = JSON.parse(result.stdout).payload.data;
    expect(data.audit.contexts).toMatchObject({ total: 2, returned: 1 });
    expect(data.contexts[0].readCommand).toContain("--context=run-1.build");
    expect(data.nextCommand).toContain("--offset=1");
    expect(data.nextCommand).toContain("--limit=1");
  });

  it("keeps explicit scope and context when requesting a full artifact", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          ...audit,
          selection: { ...audit.selection, context: "run-1.build", full: true },
        }),
    });
    const result = await fixture.run([
      "run",
      "audit",
      "run-1",
      "--session",
      "elsewhere",
      "--context",
      "run-1.build",
      "--full",
      "--out",
      "run-audit.json",
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const url = new URL(fixture.requests[0]?.url ?? "http://missing");
    expect(url.pathname).toBe(
      "/api/projects/project-one/sessions/elsewhere/runs/run-1/audit",
    );
    expect(url.searchParams.get("context")).toBe("run-1.build");
    expect(url.searchParams.get("full")).toBe("true");
    expect(JSON.parse(result.stdout).payload.kind).toBe("artifact");
  });

  it("represents the same selected digest in text and JSON", async () => {
    const fixture = createCcRuntimeFixture({ respond: () => jsonReply(audit) });
    const result = await fixture.run(
      ["run", "audit", "run-1", "--limit", "1"],
      "text",
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 of 2");
    expect(result.stdout).toContain("run-1.build");
    expect(result.stdout).toContain("--offset=1");
    expect(result.stdout).toContain("--full");
  });
});
