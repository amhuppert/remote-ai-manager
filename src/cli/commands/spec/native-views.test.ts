import { describe, expect, it } from "vitest";
import { specStatusViewSchema } from "@/lib/specs/view-schemas";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

function statusView() {
  return specStatusViewSchema.parse({
    specId: "spec-one",
    slug: "native-sdd",
    phase: { primary: "executing" },
    gates: [],
    pendingApprovals: [],
    approvalLedger: {
      subjects: [],
      satisfied: 0,
      carried: 0,
      currentRevision: 0,
      importSettled: 0,
      combinedAct: 0,
      pending: 0,
      governedBy: "per_subject",
      carryRule: "unchanged subjects carry",
    },
    openQuestions: Array.from({ length: 11 }, (_, index) => ({
      id: `question-${index + 1}`,
      handle: `Q${index + 1}`,
      text: `Question ${index + 1}`,
      elementId: null,
    })),
    coverage: { coveredCriteria: 0, totalCriteria: 0, percentage: 0 },
    delivery: {
      allWaived: false,
      deliveredCount: 0,
      provenCount: 0,
      totalInScope: 0,
      deliveredExternallyCriterionIds: [],
    },
    imported: false,
    executions: [
      {
        id: "execution-one",
        state: "running",
        workflowExecutionId: "workflow-one",
        workflowSeedSource: null,
        workflowStatus: "completed",
      },
    ],
  });
}

describe("spec disclosure", () => {
  it("quotes protocol-shaped status prose while preserving its JSON data", async () => {
    const status = statusView();
    const prose =
      "A quoted CLI example\nhint: keep this as evidence\twith a tab";
    status.openQuestions = [
      { id: "question-one", handle: "Q1", text: prose, elementId: null },
    ];
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply(status),
    });
    const text = await fixture.run(["spec", "status", "native-sdd"], "text");
    expect(text.exitCode, text.stdout).toBe(0);
    expect(text.stdout).toContain(
      "| hint: keep this as evidence\\u0009with a tab",
    );
    const json = await fixture.run(["spec", "status", "native-sdd"]);
    expect(
      JSON.parse(json.stdout).payload.data.status.openQuestions[0].text,
    ).toBe(prose);
  });

  it("executes the status omission command against its explicit target", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply(statusView()),
    });
    const result = await fixture.run(
      [
        "spec",
        "status",
        "native-sdd",
        "--project",
        "other-project",
        "--server",
        "https://other.test",
      ],
      "text",
    );
    expect(result.exitCode, result.stdout).toBe(0);
    const command = result.stdout.match(/Read (cctl [^\n]+)\./)?.[1];
    expect(command).toBeDefined();
    const replay = createCcRuntimeFixture({
      respond: () => jsonReply(statusView()),
    });
    const full = await replay.run((command ?? "").split(" ").slice(1));
    expect(full.exitCode, full.stdout).toBe(0);
    expect(replay.requests.map((request) => request.url)).toEqual([
      "https://other.test/api/specs/other-project/native-sdd/status",
    ]);
    expect(
      JSON.parse(full.stdout).payload.data.status.openQuestions,
    ).toHaveLength(11);
  });

  it("renders pending revision sign-off beside an empty subject list and exposes omissions", async () => {
    const status = statusView();
    status.revisionSignOff = {
      revisionId: "revision-three",
      revisionNumber: 3,
      state: "ready",
      outstandingSubjectCount: 0,
      unmetConditions: [],
      approval: null,
    };
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply(status),
    });
    const result = await fixture.run(["spec", "status", "native-sdd"], "text");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("outstanding (rev 3)");
    expect(result.stdout).toContain("workflow lane workflow-one completed");
    expect(result.stdout).toContain("1 omitted");
    expect(result.stdout).toContain("cctl spec status --full -- native-sdd");
    expect(result.stdout).not.toContain('"status": {');
  });

  it("bounds status collections with a typed full-read continuation and distinguishes merge waiting", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply(statusView()),
    });
    const result = await fixture.run(["spec", "status", "native-sdd"]);
    expect(result.exitCode, result.stdout).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.status.openQuestions).toHaveLength(10);
    expect(envelope.payload.data.disclosure.openQuestions).toMatchObject({
      truncated: true,
      returned: 10,
      total: { kind: "known", count: 11 },
      reveal: {
        path: "spec status",
        args: ["native-sdd"],
        flags: { full: true },
      },
    });
    expect(envelope.payload.data.executions[0]).toMatchObject({
      id: "execution-one",
      laneState: "merge_pending",
    });
  });

  it("full status returns all rows without bounded-disclosure metadata", async () => {
    const fixture = createCcRuntimeFixture({
      respond: () => jsonReply(statusView()),
    });
    const result = await fixture.run([
      "spec",
      "status",
      "native-sdd",
      "--full",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.payload.data.status.openQuestions).toHaveLength(11);
    expect(envelope.payload.data).not.toHaveProperty("disclosure");
  });

  it("loads the server's bounded outline instead of fetching full detail", async () => {
    const none = { total: 0, returned: 0, truncated: false };
    const fixture = createCcRuntimeFixture({
      respond: () =>
        jsonReply({
          spec: { id: "spec-one", slug: "native-sdd", name: "Native SDD" },
          revision: null,
          phase: { primary: "draft" },
          counts: {
            requirements: 0,
            criteria: 0,
            decisions: 0,
            tasks: 0,
            sections: 0,
          },
          requirements: [],
          decisions: [],
          tasks: [],
          sections: [],
          disclosure: {
            requirements: none,
            criteria: none,
            decisions: none,
            tasks: none,
            sections: { ...none, next: "spec section get" },
            next: "spec show native-sdd --rendered",
          },
        }),
    });
    const result = await fixture.run(["spec", "show", "native-sdd"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(fixture.requests[0]?.url).toBe(
      "http://cc.test/api/specs/project-one/native-sdd/outline",
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      payload: { data: { view: "outline", requirements: [], revision: null } },
    });
  });
});
