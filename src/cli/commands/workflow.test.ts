import { describe, expect, it } from "vitest";
import {
  CONVERSATION_CAPABILITY_ENV_VAR,
  CONVERSATION_CAPABILITY_HEADER,
} from "@/lib/agent-gateway/conversation-capability";
import { runCli } from "../core";
import type { CliEnv, CliHost, FetchInit } from "../shared";

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
};

interface RecordedRequest {
  url: string;
  init: FetchInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeHost(
  respond: (req: RecordedRequest) => Response,
  files: Record<string, string> = {},
): CliHost & {
  requests: RecordedRequest[];
  writes: Map<string, string>;
} {
  const requests: RecordedRequest[] = [];
  const writes = new Map<string, string>();
  return {
    requests,
    writes,
    async fetch(url, init) {
      const req = { url, init };
      requests.push(req);
      return respond(req);
    },
    async readTextFile(filePath) {
      return files[filePath] ?? null;
    },
    async readFileBytes() {
      return null;
    },
    async writeTextFile(filePath, content) {
      writes.set(filePath, content);
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

describe("local seeded-document limits", () => {
  it.each(["validate", "create", "replace", "run"])(
    "refuses an oversized document before %s sends any request",
    async (verb) => {
      const host = makeHost(() => jsonResponse({}), {
        ".cc/temp/plan.json": JSON.stringify({
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
      });
      const result = await runCli(
        [
          "workflow",
          verb,
          ...(verb === "replace" ? ["wf-1"] : []),
          "--file",
          ".cc/temp/plan.json",
          "--json",
        ],
        baseEnv,
        host,
      );
      expect(host.requests).toHaveLength(0);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("262144");
      expect(result.stdout).toContain("seededDocuments");
    },
  );
});

describe("cctl workflow list", () => {
  it("lists project definitions and hits the project workflows route", async () => {
    const host = makeHost(() =>
      jsonResponse({
        items: [
          {
            id: "wf-1",
            name: "Auth Setup",
            description: "OAuth2 workflow",
            revision: 3,
            createdAt: "2026-03-30T00:00:00Z",
            updatedAt: "2026-03-30T01:00:00Z",
            parameters: [],
            prerequisites: [],
          },
        ],
      }),
    );
    const result = await runCli(["workflow", "list"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("GET");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/workflows",
    );
    expect(result.stdout).toContain("wf-1");
    expect(result.stdout).toContain("Auth Setup");
    expect(result.stdout).not.toContain("hint:");
  });

  it("reports an empty library plainly", async () => {
    const host = makeHost(() => jsonResponse({ items: [] }));
    const result = await runCli(["workflow", "list"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no workflow definitions");
  });

  it("does not require a session identity", async () => {
    const host = makeHost(() => jsonResponse({ items: [] }));
    const noSession: CliEnv = {
      CC_SERVER_URL: baseEnv.CC_SERVER_URL,
      CC_API_TOKEN: baseEnv.CC_API_TOKEN,
      CC_PROJECT: baseEnv.CC_PROJECT,
    };
    const result = await runCli(["workflow", "list"], noSession, host);
    expect(result.exitCode).toBe(0);
  });
});

describe("cctl workflow get", () => {
  it("prints the compact outline by default (structure + sizes)", async () => {
    const host = makeHost(() =>
      jsonResponse({
        item: {
          id: "wf-1",
          name: "T",
          revision: 3,
          definition: {
            executionContexts: [
              { id: "plan", title: "Plan", acceptanceCriteria: "ok" },
            ],
            tasks: [
              {
                id: "plan-1",
                contextId: "plan",
                order: 1,
                title: "Do it",
                instructions: "x".repeat(120),
              },
            ],
            edges: [],
            charter: { mission: "m", sourcesOfTruth: [{ rank: 1 }] },
            parameters: [],
            prerequisites: [],
          },
        },
        resolved: { ok: 1 },
      }),
    );
    const result = await runCli(["workflow", "get", "wf-1"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/workflows/wf-1",
    );
    expect(result.stdout).toContain('workflow wf-1 "T" rev 3');
    expect(result.stdout).toContain("contexts (1):");
    expect(result.stdout).toContain("(120 chars)");
  });

  it("--full prints the entire record incl. resolved in the json envelope", async () => {
    const host = makeHost(() =>
      jsonResponse({ item: { id: "wf-1", name: "T" }, resolved: { ok: 1 } }),
    );
    const result = await runCli(
      ["workflow", "get", "wf-1", "--full", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/workflows/wf-1",
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.item.id).toBe("wf-1");
    expect(envelope.resolved).toEqual({ ok: 1 });
  });

  it("--full prints the record inline while it fits the stdout budget", async () => {
    const host = makeHost(() =>
      jsonResponse({ item: { id: "wf-1", name: "T" }, resolved: { ok: 1 } }),
    );
    const result = await runCli(
      ["workflow", "get", "wf-1", "--full"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"id": "wf-1"');
    expect(host.writes.size).toBe(0);
  });

  it("--full past the stdout budget writes an artifact and prints its manifest", async () => {
    const blob = "x".repeat(80_000);
    const host = makeHost(() =>
      jsonResponse({
        item: { id: "wf-1", name: "T", notes: blob },
        resolved: { ok: 1 },
      }),
    );
    const result = await runCli(
      ["workflow", "get", "wf-1", "--full"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(blob);
    expect(result.stdout.length).toBeLessThan(1_000);
    expect(result.stdout).toContain("artifact: .cc/temp/");
    expect(result.stdout).toMatch(/sha256: sha256:[a-f0-9]{64}/u);

    const [path, content] = [...host.writes.entries()][0] ?? [];
    expect(result.stdout).toContain(`artifact: ${path}`);
    const written = JSON.parse(content ?? "");
    expect(written.item.notes).toBe(blob);
    expect(written.resolved).toEqual({ ok: 1 });
  });

  it("--full --json past the budget carries the manifest as named fields", async () => {
    const host = makeHost(() =>
      jsonResponse({
        item: { id: "wf-1", name: "T", notes: "x".repeat(80_000) },
        resolved: { ok: 1 },
      }),
    );
    const result = await runCli(
      ["workflow", "get", "wf-1", "--full", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.item).toBeUndefined();
    expect(envelope.storage).toBe("artifact");
    expect(envelope.artifact.reason).toBe("stdout_budget_exceeded");
    expect(envelope.artifact.bytes).toBeGreaterThan(80_000);
    expect(envelope.artifact.format).toBe("json");
    expect(envelope.artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(host.writes.has(envelope.artifact.path)).toBe(true);
  });

  it("--full fails loudly when the artifact cannot be written", async () => {
    const host = makeHost(() =>
      jsonResponse({ item: { id: "wf-1", notes: "x".repeat(80_000) } }),
    );
    host.writeTextFile = async () => {
      throw new Error("read-only file system");
    };
    const result = await runCli(
      ["workflow", "get", "wf-1", "--full"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("could not write");
  });

  it("exits 2 for an unknown workflow (404)", async () => {
    const host = makeHost(() =>
      jsonResponse({ error: "Workflow not found" }, 404),
    );
    const result = await runCli(["workflow", "get", "nope"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not found");
  });

  it("exits 2 when the id is missing", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["workflow", "get"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl workflow status", () => {
  const execution = {
    id: "exec-1",
    status: "running",
    haltReason: null,
    activeContextIds: ["phase-a", "phase-b"],
    workingDefinition: {
      executionContexts: [
        {
          id: "phase-a",
          title: "Phase A",
          placement: { lane: "delivery", mode: "owned" },
        },
        {
          id: "phase-b",
          title: "Phase B",
          placement: { lane: "delivery", mode: "owned" },
        },
      ],
    },
    contextStates: {
      "phase-a": {
        contextId: "phase-a",
        status: "completed",
        totalTaskCount: 2,
        completedTaskCount: 2,
        batchId: "batch-1",
        laneId: "delivery",
      },
      "phase-b": {
        contextId: "phase-b",
        status: "running",
        totalTaskCount: 3,
        completedTaskCount: 1,
        batchId: "batch-1",
        laneId: "delivery",
      },
    },
    executionLanes: {
      delivery: {
        laneId: "delivery",
        kind: "worktree",
        status: "active",
        includedContextIds: ["phase-a"],
      },
    },
  };

  it("renders a compact per-context table from the full execution route", async () => {
    const host = makeHost(() => jsonResponse({ execution }));
    const result = await runCli(["workflow", "status"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/execution",
    );
    expect(result.stdout).toContain("exec-1");
    expect(result.stdout).toContain("phase-a");
    expect(result.stdout).toContain("2/2");
    expect(result.stdout).toContain("phase-b");
    expect(result.stdout).toContain("1/3");
    expect(result.stdout).toContain("delivery");
    expect(result.stdout).toContain("phase-a: active (completed)");
    expect(result.stdout).toContain("phase-b: active (running)");
  });

  it("--json carries the projection the table renders, not the unstripped payload", async () => {
    const host = makeHost(() =>
      jsonResponse({
        execution: { ...execution, charterMarkdown: "a".repeat(400) },
      }),
    );
    const result = await runCli(
      ["workflow", "status", "--json"],
      baseEnv,
      host,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.view).toBe("summary");
    expect(envelope.execution).toEqual({
      id: "exec-1",
      status: "running",
      halted: false,
      haltType: null,
      activeContextIds: ["phase-a", "phase-b"],
    });
    expect(envelope.contexts).toEqual([
      {
        id: "phase-a",
        title: "Phase A",
        lane: "delivery",
        status: "completed",
        completedTaskCount: 2,
        totalTaskCount: 2,
        batchId: "batch-1",
        laneId: "delivery",
      },
      {
        id: "phase-b",
        title: "Phase B",
        lane: "delivery",
        status: "running",
        completedTaskCount: 1,
        totalTaskCount: 3,
        batchId: "batch-1",
        laneId: "delivery",
      },
    ]);
    // The fields the text tier never showed stay behind the explicit selector.
    expect(result.stdout).not.toContain("charterMarkdown");
    expect(envelope.lanes).toEqual([
      {
        laneId: "delivery",
        runtimeLaneId: "delivery",
        kind: "worktree",
        status: "active",
        members: [
          {
            contextId: "phase-a",
            status: "completed",
            activity: "active",
            batchId: "batch-1",
          },
          {
            contextId: "phase-b",
            status: "running",
            activity: "active",
            batchId: "batch-1",
          },
        ],
      },
    ]);
  });

  it("--full returns the unstripped execution the route sent", async () => {
    const durable = {
      ...execution,
      charterMarkdown: "the hand-authored charter",
      startedAt: "2026-08-01T00:00:00.000Z",
    };
    const host = makeHost(() => jsonResponse({ execution: durable }));
    const result = await runCli(
      ["workflow", "status", "--full", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.view).toBe("full");
    expect(envelope.execution).toEqual(durable);
    expect(envelope.lanes).toHaveLength(1);
    expect(host.writes.size).toBe(0);
  });

  it("--full past the stdout budget writes an artifact and prints its manifest", async () => {
    const blob = "x".repeat(80_000);
    const host = makeHost(() =>
      jsonResponse({ execution: { ...execution, charterMarkdown: blob } }),
    );
    const result = await runCli(
      ["workflow", "status", "--full"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(blob);
    expect(result.stdout).toContain("artifact: .cc/temp/");
    expect(result.stdout).toMatch(/sha256: sha256:[a-f0-9]{64}/u);

    const [artifactPath, content] = [...host.writes.entries()][0] ?? [];
    expect(result.stdout).toContain(`artifact: ${artifactPath}`);
    const written = JSON.parse(content ?? "");
    expect(written.execution.charterMarkdown).toBe(blob);
  });

  it("exits 2 when two selectors are combined", async () => {
    const host = makeHost(() => jsonResponse({ execution }));
    const result = await runCli(
      ["workflow", "status", "--full", "--halt"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("at most one section selector");
    expect(host.requests).toHaveLength(0);
  });

  it("reads the same Current-or-History projection by explicit cross-project execution id without a capability", async () => {
    const durableProjection = {
      ...execution,
      id: "exec-history-7",
      durableMarker: "survives-current-to-history",
    };
    const currentHost = makeHost(() =>
      jsonResponse({ execution: durableProjection }),
    );
    const historyHost = makeHost(() =>
      jsonResponse({ execution: durableProjection }),
    );
    const explicitEnv = {
      ...baseEnv,
      [CONVERSATION_CAPABILITY_ENV_VAR]: "must-not-be-used-for-a-read",
    };
    const argv = [
      "workflow",
      "status",
      "exec-history-7",
      "--project",
      "another-project",
      "--session",
      "archived-session",
      "--full",
      "--json",
    ];

    const current = await runCli(argv, explicitEnv, currentHost);
    const history = await runCli(argv, explicitEnv, historyHost);

    expect(current.exitCode).toBe(0);
    expect(history.exitCode).toBe(0);
    expect(JSON.parse(current.stdout).execution).toEqual(durableProjection);
    expect(JSON.parse(history.stdout).execution).toEqual(durableProjection);
    for (const host of [currentHost, historyHost]) {
      const request = host.requests[0];
      expect(request?.init.method).toBe("GET");
      expect(new URL(request?.url ?? "").pathname).toBe(
        "/api/projects/another-project/sessions/archived-session/graph-workflow/executions/exec-history-7",
      );
      expect(
        request?.init.headers[CONVERSATION_CAPABILITY_HEADER],
      ).toBeUndefined();
    }
  });

  // A plan-defect halt reopens nothing and charges no attempt, so the halt row
  // is the ONLY place `status` says why the run stopped — the bare reason type
  // would leave an operator with a verdict and no finding.
  const planDefectHalt = {
    type: "plan_defect",
    contextId: "phase-b",
    roundSeq: 2,
    summary: null,
    planDefects: [
      {
        assignmentId: "seat-contract",
        title: "Criterion 3 requires a schema this context never owns",
        description: "The criterion names src/lib/foo/schemas.ts.",
        whyNotLocallyRemediable: "No task in phase-b may write that module.",
        conflictingContract: "acceptance criterion 3",
      },
      {
        assignmentId: "seat-scope",
        title: "The charter's non-goals exclude the migration task 2 assumes",
        description: "Task 2 assumes a migration the charter forbids.",
        whyNotLocallyRemediable: "The exclusion is a charter clause.",
        conflictingContract: "charter non-goal 1",
      },
    ],
  };

  it("renders a plan_defect halt with the first finding and the repair-round outcome", async () => {
    const host = makeHost(() =>
      jsonResponse({
        execution: {
          ...execution,
          status: "halted",
          haltReason: planDefectHalt,
          planRepairRounds: [
            {
              seq: 4,
              contextId: "phase-b",
              haltType: "plan_defect",
              outcome: "declined",
            },
          ],
        },
      }),
    );
    const result = await runCli(["workflow", "status"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("plan defect: phase-b");
    expect(result.stdout).toContain(
      "finding: Criterion 3 requires a schema this context never owns",
    );
    expect(result.stdout).toContain("contract: acceptance criterion 3");
    expect(result.stdout).toContain("repair: round 4 declined");
    // The omission is explicit and names the command that reveals the rest
    // (steering: a cap without disclosure is a defect).
    expect(result.stdout).toContain(
      "findings: 2 total, 1 shown — rest: cctl workflow status --halt",
    );
    // The contexts table still renders beneath the halt block.
    expect(result.stdout).toContain("phase-b");
    expect(result.stdout).toContain("1/3");
  });

  it("carries the same bounded halt block in --json as the text block shows", async () => {
    const host = makeHost(() =>
      jsonResponse({
        execution: {
          ...execution,
          status: "halted",
          haltReason: planDefectHalt,
          planRepairRounds: [
            {
              seq: 4,
              contextId: "phase-b",
              haltType: "plan_defect",
              outcome: "declined",
            },
          ],
        },
      }),
    );
    const result = await runCli(
      ["workflow", "status", "--json"],
      baseEnv,
      host,
    );

    const envelope = JSON.parse(result.stdout);
    expect(envelope.execution.halted).toBe(true);
    expect(envelope.execution.haltType).toBe("plan_defect");
    expect(envelope.halt).toEqual({
      type: "plan_defect",
      contextId: "phase-b",
      summary: null,
      findings: [
        {
          title: "Criterion 3 requires a schema this context never owns",
          conflictingContract: "acceptance criterion 3",
        },
      ],
      omission: {
        total: 2,
        returned: 1,
        truncated: true,
        reveal: "cctl workflow status --halt",
      },
      repair: { seq: 4, outcome: "declined" },
    });
  });

  // An addressed status read must name its own addressing in the reveal: the
  // ambient `cctl workflow status --halt` resolves the session's CURRENT
  // execution, which is not the execution this table just described.
  it("names the addressed execution in the halt reveal", async () => {
    const host = makeHost(() =>
      jsonResponse({
        execution: {
          ...execution,
          id: "exec-history-7",
          status: "halted",
          haltReason: planDefectHalt,
          planRepairRounds: [],
        },
      }),
    );
    const argv = ["workflow", "status", "exec-history-7"];
    const reveal = "cctl workflow status exec-history-7 --halt";

    const text = await runCli(argv, baseEnv, host);
    const structured = await runCli([...argv, "--json"], baseEnv, host);

    expect(text.stdout).toContain(`rest: ${reveal}`);
    expect(text.stdout).toContain(`next: ${reveal}`);
    const envelope = JSON.parse(structured.stdout);
    expect(envelope.next).toBe(reveal);
    expect(envelope.halt.omission.reveal).toBe(reveal);
  });

  it("carries the caller's --project/--session flags in the halt reveal", async () => {
    const host = makeHost(() =>
      jsonResponse({
        execution: {
          ...execution,
          id: "exec-history-7",
          status: "halted",
          haltReason: planDefectHalt,
          planRepairRounds: [],
        },
      }),
    );
    const argv = [
      "workflow",
      "status",
      "exec-history-7",
      "--project",
      "another-project",
      "--session",
      "archived-session",
    ];
    const reveal =
      "cctl workflow status exec-history-7 --project another-project --session archived-session --halt";

    const text = await runCli(argv, baseEnv, host);
    const structured = await runCli([...argv, "--json"], baseEnv, host);

    expect(text.stdout).toContain(`rest: ${reveal}`);
    expect(text.stdout).toContain(`next: ${reveal}`);
    const envelope = JSON.parse(structured.stdout);
    expect(envelope.next).toBe(reveal);
    expect(envelope.halt.omission.reveal).toBe(reveal);
  });

  it("--halt reveals every finding the bounded block dropped, in full", async () => {
    const rounds = [
      {
        seq: 4,
        contextId: "phase-b",
        haltType: "plan_defect",
        outcome: "declined",
      },
    ];
    const host = makeHost(() =>
      jsonResponse({
        execution: {
          ...execution,
          status: "halted",
          haltReason: planDefectHalt,
          planRepairRounds: rounds,
        },
      }),
    );
    const structured = await runCli(
      ["workflow", "status", "--halt", "--json"],
      baseEnv,
      host,
    );
    const text = await runCli(["workflow", "status", "--halt"], baseEnv, host);

    const envelope = JSON.parse(structured.stdout);
    expect(envelope.view).toBe("halt");
    expect(envelope.haltReason).toEqual(planDefectHalt);
    expect(envelope.planRepairRounds).toEqual(rounds);
    // The fields the bounded block has no vocabulary for are readable here.
    expect(text.stdout).toContain(
      "The charter's non-goals exclude the migration task 2 assumes",
    );
    expect(text.stdout).toContain("The exclusion is a charter clause.");
  });

  it("names the halt selector for a reason the table has no vocabulary for", async () => {
    const host = makeHost(() =>
      jsonResponse({
        execution: {
          ...execution,
          status: "halted",
          haltReason: {
            type: "delivery_gate_failed",
            instruction: "Fix the failing criterion, then resume.",
          },
        },
      }),
    );
    const text = await runCli(["workflow", "status"], baseEnv, host);
    const structured = await runCli(
      ["workflow", "status", "--json"],
      baseEnv,
      host,
    );

    // The type name is not an account of the halt, so the compact read says
    // where the reason, its code, and its instruction live.
    expect(text.stdout).toContain("halted: delivery_gate_failed");
    expect(text.stdout).toContain("next: cctl workflow status --halt");
    expect(JSON.parse(structured.stdout).next).toBe(
      "cctl workflow status --halt",
    );
    expect(JSON.parse(structured.stdout).halt).toBeUndefined();
  });

  it("names no halt selector while the run is healthy", async () => {
    const host = makeHost(() => jsonResponse({ execution }));
    const result = await runCli(
      ["workflow", "status", "--json"],
      baseEnv,
      host,
    );

    expect(JSON.parse(result.stdout).next).toBeUndefined();
  });

  it("--halt says so plainly when the execution is not halted", async () => {
    const host = makeHost(() => jsonResponse({ execution }));
    const result = await runCli(
      ["workflow", "status", "--halt"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("exec-1  running  not halted");
  });

  it("omits the repair line when no plan-repair round answered the halt", async () => {
    const host = makeHost(() =>
      jsonResponse({
        execution: {
          ...execution,
          status: "halted",
          haltReason: {
            ...planDefectHalt,
            planDefects: [planDefectHalt.planDefects[0]],
            summary: "plan repair is disabled for this project",
          },
          planRepairRounds: [
            // A round for a DIFFERENT halt on the same context must not be
            // reported as this halt's repair outcome.
            {
              seq: 1,
              contextId: "phase-b",
              haltType: "circuit_breaker",
              outcome: "repaired",
            },
          ],
        },
      }),
    );
    const result = await runCli(["workflow", "status"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("plan defect: phase-b");
    expect(result.stdout).toContain("findings: 1 total, 1 shown");
    expect(result.stdout).not.toContain("1 shown —");
    expect(result.stdout).not.toContain("repair: round");
    expect(result.stdout).toContain(
      "summary: plan repair is disabled for this project",
    );
  });

  // A candidate_unstable halt is the other reason whose type name says nothing
  // actionable: the count, the stage, and which incident it concluded on are
  // the whole diagnosis, and the repair round that already answered it is the
  // difference between "go look" and "repair already declined".
  const candidateUnstableHalt = {
    type: "candidate_unstable",
    contextId: "phase-b",
    stage: "diff_render",
    driftedComponents: "worktreeHeadSha, diffDigest",
    lastIncident: "candidate_mismatch",
    consecutiveCount: 3,
    message: "validation kept concluding without a verdict",
    summary: null,
  };

  it("renders a candidate_unstable halt with the stage, incident, count and drift", async () => {
    const host = makeHost(() =>
      jsonResponse({
        execution: {
          ...execution,
          status: "halted",
          haltReason: {
            ...candidateUnstableHalt,
            summary: "the lane's worktree is shared with an external writer",
          },
          planRepairRounds: [
            {
              seq: 5,
              contextId: "phase-b",
              haltType: "candidate_unstable",
              outcome: "declined",
            },
          ],
        },
      }),
    );
    const result = await runCli(["workflow", "status"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("candidate unstable: phase-b");
    expect(result.stdout).toContain("stage: diff_render");
    expect(result.stdout).toContain("incident: candidate_mismatch");
    expect(result.stdout).toContain("consecutive rounds: 3");
    expect(result.stdout).toContain("drifted: worktreeHeadSha, diffDigest");
    expect(result.stdout).toContain("repair: round 5 declined");
    expect(result.stdout).toContain(
      "summary: the lane's worktree is shared with an external writer",
    );
    // The contexts table still renders beneath the halt block.
    expect(result.stdout).toContain("1/3");
  });

  it("claims no drift for a stale_result_rejected halt, where nothing moved", async () => {
    const host = makeHost(() =>
      jsonResponse({
        execution: {
          ...execution,
          status: "halted",
          haltReason: {
            ...candidateUnstableHalt,
            stage: "specialist_result",
            lastIncident: "stale_result_rejected",
            driftedComponents: "",
            consecutiveCount: 4,
          },
          planRepairRounds: [
            // A round for a DIFFERENT halt on the same context is not this
            // halt's answer.
            {
              seq: 2,
              contextId: "phase-b",
              haltType: "plan_defect",
              outcome: "repaired",
            },
          ],
        },
      }),
    );
    const result = await runCli(["workflow", "status"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("candidate unstable: phase-b");
    expect(result.stdout).toContain("stage: specialist_result");
    expect(result.stdout).toContain("incident: stale_result_rejected");
    expect(result.stdout).toContain("consecutive rounds: 4");
    expect(result.stdout).not.toContain("drifted:");
    expect(result.stdout).not.toContain("repair: round");
    expect(result.stdout).not.toContain("summary:");
  });

  // The leniency exists for a payload this build does not fully understand, so
  // it must not answer for one. Naming an incident the halt never reported
  // would be an invented diagnosis in exactly the case the leniency is for.
  it("omits the incident line rather than guessing when the halt carries none", async () => {
    const { lastIncident: _omitted, ...withoutIncident } =
      candidateUnstableHalt;
    const host = makeHost(() =>
      jsonResponse({
        execution: {
          ...execution,
          status: "halted",
          haltReason: withoutIncident,
        },
      }),
    );
    const result = await runCli(["workflow", "status"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("candidate unstable: phase-b");
    expect(result.stdout).toContain("stage: diff_render");
    expect(result.stdout).toContain("consecutive rounds: 3");
    expect(result.stdout).not.toContain("incident:");
  });

  it("reports no active execution plainly", async () => {
    const host = makeHost(() => jsonResponse({ execution: null }));
    const result = await runCli(["workflow", "status"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("no active graph workflow");
  });

  it("exits 2 without a session identity", async () => {
    const host = makeHost(() => jsonResponse({ execution: null }));
    const noSession: CliEnv = {
      CC_SERVER_URL: baseEnv.CC_SERVER_URL,
      CC_API_TOKEN: baseEnv.CC_API_TOKEN,
      CC_PROJECT: baseEnv.CC_PROJECT,
    };
    const result = await runCli(["workflow", "status"], noSession, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("session");
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl workflow delete", () => {
  it("deletes via the project workflows route and exits 0 with no hint", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(["workflow", "delete", "wf-1"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("DELETE");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/workflows/wf-1",
    );
    expect(result.stdout).toContain("deleted wf-1");
    expect(result.stdout).not.toContain("hint:");
  });

  it("exits 2 for an unknown workflow (404)", async () => {
    const host = makeHost(() =>
      jsonResponse({ error: "Workflow not found" }, 404),
    );
    const result = await runCli(["workflow", "delete", "nope"], baseEnv, host);
    expect(result.exitCode).toBe(2);
  });
});

describe("cctl workflow start", () => {
  const warnings = [
    {
      path: "definition.tasks.0.instructions",
      message:
        'lint/source-locator-unresolvable: source "docs/launch.md" could not be resolved',
    },
  ];
  const receipt = {
    executionId: "exec-9",
    status: "running",
    origin: {
      kind: "template",
      definitionId: "wf-1",
      definitionRevision: 3,
      tier: "project",
    },
    originConversationId: null,
    deepLink: "/projects/cc/sessions/my-session/workflow?execution=exec-9",
    startedAt: "2026-08-22T12:00:00.000Z",
    warnings,
  };

  it("posts the definitionId, prints the run id + track-progress hint", async () => {
    const host = makeHost((req) => {
      expect(req.init.method).toBe("POST");
      expect(JSON.parse(req.init.body ?? "{}").definitionId).toBe("wf-1");
      return jsonResponse(
        { execution: { executionId: "exec-9", status: "running" } },
        202,
      );
    });
    const result = await runCli(["workflow", "start", "wf-1"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow",
    );
    expect(result.stdout).toContain("exec-9");
    expect(
      result.stdout
        .trimEnd()
        .endsWith("track progress with 'cctl workflow status'"),
    ).toBe(true);
  });

  it("prints launch warnings before the success body and keeps exit 0", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          execution: { executionId: "exec-9", status: "running" },
          receipt,
        },
        202,
      ),
    );
    const result = await runCli(["workflow", "start", "wf-1"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const warningIndex = result.stdout.indexOf(`warning: ${warnings[0]?.path}`);
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeLessThan(
      result.stdout.indexOf("started wf-1 (run exec-9)"),
    );
  });

  it("carries launch warnings into the JSON success envelope", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          execution: { executionId: "exec-9", status: "running" },
          receipt,
        },
        202,
      ),
    );
    const result = await runCli(
      ["workflow", "start", "wf-1", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, warnings });
  });

  it("names the calling conversation so the server can capture it as the run's owner", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { execution: { executionId: "exec-9", status: "running" } },
        202,
      ),
    );
    const result = await runCli(
      ["workflow", "start", "wf-1"],
      {
        ...baseEnv,
        CC_CONVERSATION_ID: "conv-planner",
      },
      host,
    );

    expect(result.exitCode).toBe(0);
    // A header claim, never a body field: the server verifies it against the
    // session's conversations, and a body-supplied owner is ignored outright.
    expect(host.requests[0]?.init.headers["x-cc-conversation-id"]).toBe(
      "conv-planner",
    );
    expect(JSON.parse(host.requests[0]?.init.body ?? "{}")).not.toHaveProperty(
      "ownerConversationId",
    );
  });

  it("omits the caller header when the CLI runs outside a conversation", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { execution: { executionId: "exec-9", status: "running" } },
        202,
      ),
    );
    const result = await runCli(["workflow", "start", "wf-1"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(
      host.requests[0]?.init.headers["x-cc-conversation-id"],
    ).toBeUndefined();
  });

  it("reads parameters from --file and forwards them", async () => {
    const host = makeHost(
      (req) => {
        const body = JSON.parse(req.init.body ?? "{}");
        expect(body.parameters).toEqual({ env: "staging" });
        return jsonResponse(
          { execution: { executionId: "exec-9", status: "running" } },
          202,
        );
      },
      { "/tmp/inputs.json": JSON.stringify({ env: "staging" }) },
    );
    const result = await runCli(
      ["workflow", "start", "wf-1", "--file", "/tmp/inputs.json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
  });

  it("reports an approval-required execution as successfully parked instead of a failed start", async () => {
    // The server accepts a park with a 202 receipt (D7 decision D1); the CLI
    // reads the disposition from the receipt rather than from a refusal.
    const host = makeHost(() =>
      jsonResponse(
        {
          execution: { executionId: "exec-review-9", status: "pending" },
          receipt: {
            executionId: "exec-review-9",
            status: "awaiting_definition_approval",
          },
        },
        202,
      ),
    );

    const result = await runCli(["workflow", "start", "wf-1"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "parked wf-1 (run exec-review-9) awaiting definition approval",
    );
    expect(result.stdout).toContain(
      "Approve the pending workflow definition to resume execution exec-review-9",
    );
  });

  it("returns a successful parked envelope for approval-required executions in JSON mode", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          execution: { executionId: "exec-review-json", status: "pending" },
          receipt: {
            executionId: "exec-review-json",
            status: "awaiting_definition_approval",
          },
        },
        202,
      ),
    );

    const result = await runCli(
      ["workflow", "start", "wf-1", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      executionId: "exec-review-json",
      status: "awaiting_definition_approval",
      instruction:
        "Approve the pending workflow definition to resume execution exec-review-json.",
    });
  });

  it("keeps approval-required responses without an execution id as failures", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error:
            "Workflow definition approval is required before execution can start",
          code: "definition_approval_required",
          instruction:
            "Record approval for the pending workflow definition before starting execution.",
        },
        409,
      ),
    );

    const result = await runCli(["workflow", "start", "wf-1"], baseEnv, host);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("approval is required");
  });

  it("keeps non-conflict responses with the approval code as failures", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "Unexpected approval response",
          code: "definition_approval_required",
          executionId: "exec-not-parked",
        },
        500,
      ),
    );

    const result = await runCli(["workflow", "start", "wf-1"], baseEnv, host);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unexpected approval response");
  });

  it("exits 2 when the --file cannot be read", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["workflow", "start", "wf-1", "--file", "/tmp/missing.json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot read");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when the --file is not valid JSON", async () => {
    const host = makeHost(() => jsonResponse({}), {
      "/tmp/x.json": "{not json",
    });
    const result = await runCli(
      ["workflow", "start", "wf-1", "--file", "/tmp/x.json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toLowerCase()).toContain("not valid json");
  });

  it("exits 2 when the --file is a JSON array, not an object", async () => {
    const host = makeHost(() => jsonResponse({}), { "/tmp/x.json": "[1,2]" });
    const result = await runCli(
      ["workflow", "start", "wf-1", "--file", "/tmp/x.json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 1 on a business guard rejection (409)", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { error: "A workflow is already running", code: "already_running" },
        409,
      ),
    );
    const result = await runCli(["workflow", "start", "wf-1"], baseEnv, host);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already running");
  });
});

describe("cctl workflow run", () => {
  const plan = {
    name: "One-off audit",
    definition: { executionContexts: [], tasks: [], edges: [] },
    layout: { nodes: [] },
  };
  const receipt = {
    executionId: "exec-one-off-9",
    status: "running",
    origin: { kind: "one_off", planName: "One-off audit" },
    originConversationId: "conv-origin",
    deepLink:
      "/projects/cc/sessions/my-session/workflow?execution=exec-one-off-9",
    startedAt: "2026-08-14T12:00:00.000Z",
  };

  it("posts the plan and distinct inputs documents, attaches the verified capability, and returns detached receipt facts", async () => {
    const host = makeHost(
      (request) => {
        expect(request.init.method).toBe("POST");
        expect(JSON.parse(request.init.body ?? "{}")).toEqual({
          plan,
          inputs: { target: "staging" },
        });
        expect(request.init.headers[CONVERSATION_CAPABILITY_HEADER]).toBe(
          "signed-conversation-capability",
        );
        return jsonResponse({ receipt }, 202);
      },
      {
        "/tmp/plan.json": JSON.stringify(plan),
        "/tmp/inputs.json": JSON.stringify({ target: "staging" }),
      },
    );

    const result = await runCli(
      [
        "workflow",
        "run",
        "--file",
        "/tmp/plan.json",
        "--inputs",
        "/tmp/inputs.json",
      ],
      {
        ...baseEnv,
        CC_CONVERSATION_ID: "conv-origin",
        [CONVERSATION_CAPABILITY_ENV_VAR]: "signed-conversation-capability",
      },
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/run",
    );
    expect(result.stdout).toContain("exec-one-off-9");
    expect(result.stdout).toContain("running");
    expect(result.stdout).toContain("one_off");
    expect(result.stdout).toContain("conv-origin");
    expect(result.stdout).toContain(receipt.deepLink);
    expect(result.stdout).not.toContain("definitionId");
    expect(host.requests).toHaveLength(1);
  });

  it("preserves the same receipt facts in JSON without a definition id", async () => {
    const host = makeHost(() => jsonResponse({ receipt }, 202), {
      "/tmp/plan.json": JSON.stringify(plan),
    });
    const result = await runCli(
      ["workflow", "run", "--file", "/tmp/plan.json", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, ...receipt });
    expect(result.stdout).not.toContain("definitionId");
  });

  it("prints launch warnings before the receipt and preserves them in JSON", async () => {
    const warnings = [
      {
        path: "definition.charter.sourcesOfTruth.0.locator",
        message:
          'lint/source-locator-unresolvable: source "docs/runtime.md" could not be resolved',
      },
    ];
    const warnedReceipt = { ...receipt, warnings };
    const textHost = makeHost(
      () => jsonResponse({ receipt: warnedReceipt }, 202),
      { "/tmp/plan.json": JSON.stringify(plan) },
    );
    const textResult = await runCli(
      ["workflow", "run", "--file", "/tmp/plan.json"],
      baseEnv,
      textHost,
    );

    expect(textResult.exitCode).toBe(0);
    expect(textResult.stderr).toBe("");
    const warningIndex = textResult.stdout.indexOf(
      `warning: ${warnings[0]?.path}`,
    );
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(warningIndex).toBeLessThan(
      textResult.stdout.indexOf("launched exec-one-off-9"),
    );

    const jsonHost = makeHost(
      () => jsonResponse({ receipt: warnedReceipt }, 202),
      { "/tmp/plan.json": JSON.stringify(plan) },
    );
    const jsonResult = await runCli(
      ["workflow", "run", "--file", "/tmp/plan.json", "--json"],
      baseEnv,
      jsonHost,
    );

    expect(jsonResult.exitCode).toBe(0);
    expect(JSON.parse(jsonResult.stdout)).toMatchObject({ ok: true, warnings });
  });

  it("accepts --wait with a bounded duration and rejects timeout misuse before a request", async () => {
    const acceptedHost = makeHost(
      (request) =>
        new URL(request.url).pathname.endsWith("/run")
          ? jsonResponse({ receipt }, 202)
          : jsonResponse({ result: null }),
      { "/tmp/plan.json": JSON.stringify(plan) },
    );
    const accepted = await runCli(
      [
        "workflow",
        "run",
        "--file",
        "/tmp/plan.json",
        "--wait",
        "--timeout",
        "1ms",
      ],
      baseEnv,
      acceptedHost,
    );
    expect(accepted.exitCode).toBe(1);
    expect(accepted.stderr).toContain("timed out after 1ms");
    expect(acceptedHost.requests.map((request) => request.init.method)).toEqual(
      ["POST", "GET"],
    );

    for (const argv of [
      ["workflow", "run", "--file", "/tmp/plan.json", "--timeout", "90s"],
      [
        "workflow",
        "run",
        "--file",
        "/tmp/plan.json",
        "--wait",
        "--timeout",
        "soon",
      ],
    ]) {
      const host = makeHost(() => jsonResponse({ receipt }, 202), {
        "/tmp/plan.json": JSON.stringify(plan),
      });
      const result = await runCli(argv, baseEnv, host);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--timeout");
      expect(host.requests).toHaveLength(0);
    }
  });

  it("renders blocker-bearing lease refusals with text/JSON fact parity", async () => {
    const details = {
      executionId: "exec-blocking",
      status: "halted",
      origin: { kind: "one_off", planName: "Blocking audit" },
      originConversationId: "conv-blocking",
      deepLink:
        "/projects/cc/sessions/my-session/workflow?execution=exec-blocking",
      remedy: "resume_or_abandon",
    };
    const response = () =>
      jsonResponse(
        {
          error: "The session execution lease is held",
          code: "lease_held",
          details,
        },
        409,
      );
    const files = { "/tmp/plan.json": JSON.stringify(plan) };

    const textResult = await runCli(
      ["workflow", "run", "--file", "/tmp/plan.json"],
      baseEnv,
      makeHost(response, files),
    );
    expect(textResult.exitCode).toBe(1);
    expect(textResult.stderr).toContain("execution: exec-blocking");
    expect(textResult.stderr).toContain("status: halted");
    expect(textResult.stderr).toContain("origin: one_off");
    expect(textResult.stderr).toContain("origin conversation: conv-blocking");
    expect(textResult.stderr).toContain(`deep link: ${details.deepLink}`);
    expect(textResult.stderr).toContain("remedy: resume_or_abandon");

    const jsonResult = await runCli(
      ["workflow", "run", "--file", "/tmp/plan.json", "--json"],
      baseEnv,
      makeHost(response, files),
    );
    expect(JSON.parse(jsonResult.stdout)).toMatchObject({
      ok: false,
      code: "lease_held",
      details,
    });
  });

  it("uses the same blocker-free refusal details for nesting and project scope", async () => {
    const nestingRemedy =
      "Ask the conversation that launched this run to start the next one.";
    const nestingHost = makeHost(
      () =>
        jsonResponse(
          {
            error: "Workflows cannot nest",
            code: "workflow_nesting_refused",
            instruction: nestingRemedy,
          },
          403,
        ),
      { "/tmp/plan.json": JSON.stringify(plan) },
    );
    const nesting = await runCli(
      ["workflow", "run", "--file", "/tmp/plan.json", "--json"],
      baseEnv,
      nestingHost,
    );
    expect(JSON.parse(nesting.stdout)).toMatchObject({
      ok: false,
      code: "workflow_nesting_refused",
      details: { remedy: nestingRemedy },
    });
    expect(JSON.parse(nesting.stdout).details).not.toHaveProperty(
      "executionId",
    );

    const projectHost = makeHost(() => jsonResponse({ receipt }, 202), {
      "/tmp/plan.json": JSON.stringify(plan),
    });
    for (const sessionArgs of [[], ["--session", "forced-session"]]) {
      const projectResult = await runCli(
        [
          "workflow",
          "run",
          "--file",
          "/tmp/plan.json",
          ...sessionArgs,
          "--json",
        ],
        {
          ...baseEnv,
          CC_CONVERSATION_SCOPE: "project",
          CC_SESSION: "",
        },
        projectHost,
      );
      expect(projectResult.exitCode).toBe(2);
      expect(JSON.parse(projectResult.stdout)).toMatchObject({
        ok: false,
        code: "project_scope_refused",
        details: {
          remedy: expect.stringContaining("session conversation"),
        },
      });
    }
    expect(projectHost.requests).toHaveLength(0);
  });
});

describe("cctl workflow wait", () => {
  function boundary(
    boundaryKind:
      | "definition_approval"
      | "context_approval"
      | "lane_question"
      | "completion",
    cursor = 41,
  ) {
    return {
      cursor,
      occurredAt: "2026-08-14T12:01:00.000Z",
      executionId: "exec-wait-1",
      boundaryKind,
      status: boundaryKind === "completion" ? "completed" : "running",
      contextId:
        boundaryKind === "context_approval" || boundaryKind === "lane_question"
          ? "context-review"
          : null,
      pendingActions:
        boundaryKind === "completion"
          ? []
          : [{ kind: boundaryKind, action: "operator_action_required" }],
      outputs: { kind: "no_declared_structured_result" },
      name: "One-off audit",
      origin: { kind: "one_off", planName: "One-off audit" },
      originConversationId: "conv-origin",
      startedAt: "2026-08-14T12:00:00.000Z",
      completedAt:
        boundaryKind === "completion" ? "2026-08-14T12:01:00.000Z" : null,
      haltReason: null,
      abandonment: null,
      documents: [],
      deepLink:
        "/projects/cc/sessions/my-session/workflow?execution=exec-wait-1",
    };
  }

  for (const boundaryKind of [
    "completion",
    "definition_approval",
    "lane_question",
    "context_approval",
  ] as const) {
    it(`returns exactly once for the next ${boundaryKind} boundary`, async () => {
      let reads = 0;
      const host = makeHost(() => {
        reads += 1;
        return jsonResponse({ result: boundary(boundaryKind) });
      });
      const result = await runCli(
        ["workflow", "wait", "exec-wait-1", "--json"],
        baseEnv,
        host,
      );

      expect(result.exitCode).toBe(0);
      expect(reads).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        result: boundary(boundaryKind),
      });
    });
  }

  it("renders the plan_defect finding on a halt boundary rather than the bare kind", async () => {
    const host = makeHost(() =>
      jsonResponse({
        result: {
          ...boundary("completion"),
          boundaryKind: "halt",
          status: "halted",
          contextId: "context-review",
          completedAt: null,
          haltReason: {
            type: "plan_defect",
            contextId: "context-review",
            roundSeq: 2,
            summary: null,
            planDefects: [
              {
                assignmentId: "seat-contract",
                title: "Criterion 3 requires a schema this context never owns",
                description: "The criterion names src/lib/foo/schemas.ts.",
                whyNotLocallyRemediable:
                  "No task in context-review may write that module.",
                conflictingContract: "acceptance criterion 3",
              },
            ],
          },
        },
      }),
    );

    const result = await runCli(
      ["workflow", "wait", "exec-wait-1"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("plan defect: context-review");
    expect(result.stdout).toContain(
      "finding: Criterion 3 requires a schema this context never owns",
    );
    expect(result.stdout).toContain("contract: acceptance criterion 3");
  });

  it("renders the candidate_unstable diagnosis on a halt boundary rather than the bare kind", async () => {
    const host = makeHost(() =>
      jsonResponse({
        result: {
          ...boundary("completion"),
          boundaryKind: "halt",
          status: "halted",
          contextId: "context-review",
          completedAt: null,
          haltReason: {
            type: "candidate_unstable",
            contextId: "context-review",
            stage: "aggregate",
            driftedComponents: "worktreeHeadSha",
            lastIncident: "candidate_mismatch",
            consecutiveCount: 3,
            message: "validation kept concluding without a verdict",
            summary: null,
          },
        },
      }),
    );

    const result = await runCli(
      ["workflow", "wait", "exec-wait-1"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("candidate unstable: context-review");
    expect(result.stdout).toContain("stage: aggregate");
    expect(result.stdout).toContain("incident: candidate_mismatch");
    expect(result.stdout).toContain("consecutive rounds: 3");
    expect(result.stdout).toContain("drifted: worktreeHeadSha");
  });

  it("passes an opaque cursor through and returns a boundary that already fired without sleeping", async () => {
    const sleeps: number[] = [];
    const host = makeHost((request) => {
      expect(new URL(request.url).searchParams.get("cursor")).toBe("40");
      return jsonResponse({ result: boundary("completion", 41) });
    });
    host.sleep = async (ms) => {
      sleeps.push(ms);
    };

    const result = await runCli(
      ["workflow", "wait", "exec-wait-1", "--cursor", "40", "--timeout", "10s"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("completion");
    expect(result.stdout).toContain("cursor: 41");
    expect(sleeps).toEqual([]);
  });

  it("polls at the established cadence and times out with a non-mutating continuation receipt", async () => {
    let now = 100;
    const sleeps: number[] = [];
    const host = makeHost((request) => {
      expect(request.init.method).toBe("GET");
      return jsonResponse({ result: null });
    });
    host.now = () => now;
    host.sleep = async (ms) => {
      sleeps.push(ms);
      now += ms;
    };

    const result = await runCli(
      [
        "workflow",
        "wait",
        "exec-wait-1",
        "--cursor",
        "40",
        "--timeout",
        "2s",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(host.requests).toHaveLength(2);
    expect(
      host.requests.every((request) => request.init.method === "GET"),
    ).toBe(true);
    expect(sleeps).toEqual([1_000, 1_000]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "wait_timeout",
      details: {
        executionId: "exec-wait-1",
        cursor: "40",
        continueWith: "cctl workflow wait exec-wait-1 --cursor 40 --timeout 2s",
      },
    });
  });

  it("counts request time against the timeout and bounds a hung transport", async () => {
    let now = 100;
    const sleeps: number[] = [];
    const host = Object.assign(
      makeHost((request) => {
        expect(request.init.timeoutMs).toBe(2_000);
        now += 2_000;
        throw new Error("request aborted at its deadline");
      }),
      { now: () => now },
    );
    host.sleep = async (ms) => {
      sleeps.push(ms);
    };

    const result = await runCli(
      [
        "workflow",
        "wait",
        "exec-wait-1",
        "--cursor",
        "40",
        "--timeout",
        "2s",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(host.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "wait_timeout",
      details: {
        executionId: "exec-wait-1",
        cursor: "40",
      },
    });
  });

  it("retains explicit project and session addressing in a continuation receipt", async () => {
    const host = makeHost(() => jsonResponse({ result: null }));
    const result = await runCli(
      [
        "workflow",
        "wait",
        "exec-wait-1",
        "--project",
        "other-project",
        "--session",
        "archived-session",
        "--cursor",
        "40",
        "--timeout",
        "1ms",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/other-project/sessions/archived-session/graph-workflow/executions/exec-wait-1/result",
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "wait_timeout",
      details: {
        executionId: "exec-wait-1",
        cursor: "40",
        project: "other-project",
        session: "archived-session",
        continueWith:
          "cctl workflow wait exec-wait-1 --cursor 40 --project other-project --session archived-session --timeout 1ms",
      },
    });
  });

  // A single unreadable body is a transient the next poll clears; a streak
  // means the binary and the server disagree about the response shape, and
  // polling on turns that disagreement into a silent hang.
  it("fails loud after a streak of unreadable result bodies", async () => {
    const host = makeHost(() => jsonResponse({ result: "not-a-boundary" }));

    const result = await runCli(
      ["workflow", "wait", "exec-wait-1", "--cursor", "40", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(host.requests).toHaveLength(3);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: "unexpected workflow wait response from the CC server",
    });
  });

  it("returns a continuation receipt on disconnect without cancelling or mutating", async () => {
    const host = makeHost(() => {
      throw new Error("socket closed");
    });
    const result = await runCli(
      ["workflow", "wait", "exec-wait-1", "--cursor", "40", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(3);
    expect(host.requests).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "wait_disconnected",
      details: {
        executionId: "exec-wait-1",
        cursor: "40",
        continueWith: expect.stringContaining(
          "cctl workflow wait exec-wait-1 --cursor 40",
        ),
      },
    });
  });

  it("makes run --wait use the same durable result reader", async () => {
    const plan = {
      name: "One-off audit",
      definition: { executionContexts: [], tasks: [], edges: [] },
      layout: { nodes: [] },
    };
    const receipt = {
      executionId: "exec-wait-1",
      status: "running",
      origin: { kind: "one_off", planName: "One-off audit" },
      originConversationId: "conv-origin",
      deepLink:
        "/projects/cc/sessions/my-session/workflow?execution=exec-wait-1",
      startedAt: "2026-08-14T12:00:00.000Z",
    };
    const host = makeHost(
      (request) =>
        new URL(request.url).pathname.endsWith("/run")
          ? jsonResponse({ receipt }, 202)
          : jsonResponse({ result: boundary("completion") }),
      { "/tmp/plan.json": JSON.stringify(plan) },
    );

    const result = await runCli(
      [
        "workflow",
        "run",
        "--file",
        "/tmp/plan.json",
        "--wait",
        "--timeout",
        "10s",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests.map((request) => request.init.method)).toEqual([
      "POST",
      "GET",
    ]);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      ...receipt,
      result: boundary("completion"),
    });
    expect(result.stdout).not.toContain("definitionId");
  });

  it("keeps the text launch receipt when run --wait reaches a later boundary", async () => {
    const plan = {
      name: "One-off audit",
      definition: { executionContexts: [], tasks: [], edges: [] },
      layout: { nodes: [] },
    };
    const receipt = {
      executionId: "exec-wait-1",
      status: "running",
      origin: { kind: "one_off", planName: "One-off audit" },
      originConversationId: "conv-origin",
      deepLink:
        "/projects/cc/sessions/my-session/workflow?execution=exec-wait-1",
      startedAt: "2026-08-14T12:00:00.000Z",
    };
    const host = makeHost(
      (request) =>
        new URL(request.url).pathname.endsWith("/run")
          ? jsonResponse({ receipt }, 202)
          : jsonResponse({ result: boundary("completion") }),
      { "/tmp/plan.json": JSON.stringify(plan) },
    );

    const result = await runCli(
      [
        "workflow",
        "run",
        "--file",
        "/tmp/plan.json",
        "--wait",
        "--timeout",
        "10s",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("launched exec-wait-1  running");
    expect(result.stdout).toContain("origin conversation: conv-origin");
    expect(result.stdout).toContain(`deep link: ${receipt.deepLink}`);
    expect(result.stdout).toContain("exec-wait-1  completion");
    expect(result.stdout).not.toContain("definitionId");
  });
});

describe("cctl workflow templates", () => {
  const items = [
    {
      tier: "global",
      id: "g-1",
      name: "Global One",
      description: "cross-project",
      revision: 1,
      parameters: [],
      prerequisites: [],
    },
    {
      tier: "project",
      id: "p-1",
      name: "Project One",
      description: null,
      revision: 2,
      parameters: [],
      prerequisites: [],
    },
  ];

  it("lists both tiers by default from the project templates route", async () => {
    const host = makeHost(() => jsonResponse({ items }));
    const result = await runCli(["workflow", "templates"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/workflow-templates",
    );
    expect(result.stdout).toContain("g-1");
    expect(result.stdout).toContain("p-1");
  });

  it("filters to a single tier with --tier", async () => {
    const host = makeHost(() => jsonResponse({ items }));
    const result = await runCli(
      ["workflow", "templates", "--tier", "global"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("g-1");
    expect(result.stdout).not.toContain("p-1");
  });

  it("exits 2 for an invalid --tier", async () => {
    const host = makeHost(() => jsonResponse({ items }));
    const result = await runCli(
      ["workflow", "templates", "--tier", "bogus"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl workflow validate", () => {
  const planFile = "/tmp/plan.json";
  const files = {
    [planFile]: JSON.stringify({ name: "X", definition: {}, layout: {} }),
  };

  it("posts the plan to the session validate route and emits the create hint", async () => {
    const host = makeHost((req) => {
      expect(req.init.method).toBe("POST");
      expect(JSON.parse(req.init.body ?? "{}").name).toBe("X");
      return jsonResponse({ ok: true });
    }, files);
    const result = await runCli(
      ["workflow", "validate", "--file", planFile],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/validate",
    );
    expect(
      result.stdout
        .trimEnd()
        .endsWith(
          `valid — create it with 'cctl workflow create --file ${planFile}'`,
        ),
    ).toBe(true);
  });

  // #80 design 3.10: the server attributes a refusal to the conversation that
  // met it, and these routes take no conversationId path segment — the header
  // is the only place that identity can arrive from.
  it("names the calling conversation on the header", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), files);
    const result = await runCli(
      ["workflow", "validate", "--file", planFile],
      { ...baseEnv, CC_CONVERSATION_ID: "conv-planner" },
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests[0]?.init.headers["x-cc-conversation-id"]).toBe(
      "conv-planner",
    );
  });

  it("omits the caller header when the CLI runs outside a conversation", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), files);
    const result = await runCli(
      ["workflow", "validate", "--file", planFile],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(
      host.requests[0]?.init.headers["x-cc-conversation-id"],
    ).toBeUndefined();
  });

  it("groups managed findings by blocked transition and renders each supplied rationale", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          ok: true,
          preflight: {
            specSlug: "delivery-plan",
            findings: [
              {
                ruleId: "launch/advisory",
                severity: "advisory",
                elementHandle: "context-verify",
                recordId: "context-verify",
                message: "The verification context carries broad prose.",
              },
              {
                ruleId: "9.8.rejected-cited-assumption",
                severity: "blocks_signoff",
                elementHandle: "A1",
                message: "Assumption A1 was rejected.",
                rationale:
                  "a rejected premise cannot authorize the signed launch",
              },
              {
                ruleId: "binding/selected-criterion-not-must-run",
                severity: "blocks_propose",
                elementHandle: "R1.1",
                message: "Selected criterion R1.1 is not guaranteed to run.",
                rationale:
                  "a skipped branch can never establish the claimed criterion",
              },
            ],
            summary: {
              selected: 2,
              claimed: 1,
              unclaimed: 1,
              dispositions: [{ kind: "in_scope", count: 2 }],
              charter: {
                state: "authored",
                invariantCount: 1,
                sourceCount: 2,
              },
            },
          },
        }),
      files,
    );

    const result = await runCli(
      [
        "workflow",
        "validate",
        "--file",
        planFile,
        "--definition",
        "managed-wf",
      ],
      baseEnv,
      host,
    );

    const url = new URL(host.requests[0]?.url ?? "");
    expect(url.searchParams.get("definition")).toBe("managed-wf");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      [
        "blocks_propose:",
        "  R1.1 [binding/selected-criterion-not-must-run]: Selected criterion R1.1 is not guaranteed to run.",
        "  why: a skipped branch can never establish the claimed criterion",
        "blocks_signoff:",
        "  A1 [9.8.rejected-cited-assumption]: Assumption A1 was rejected.",
        "  why: a rejected premise cannot authorize the signed launch",
        "advisory:",
        "  context-verify [launch/advisory]: The verification context carries broad prose.",
      ].join("\n"),
    );
  });

  it("prints the explicit clean verdict and replace hint for a managed definition", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          ok: true,
          preflight: {
            specSlug: "delivery-plan",
            findings: [],
            summary: {
              selected: 2,
              claimed: 2,
              unclaimed: 0,
              dispositions: [{ kind: "in_scope", count: 2 }],
              charter: {
                state: "authored",
                invariantCount: 1,
                sourceCount: 2,
              },
            },
          },
        }),
      files,
    );

    const result = await runCli(
      [
        "workflow",
        "validate",
        "--file",
        planFile,
        "--definition",
        "managed-wf",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("propose: nothing refuses");
    expect(result.stdout).toContain(
      `hint: valid — replace it with 'cctl workflow replace managed-wf --file ${planFile}'`,
    );
  });

  it("reports both sides of the ledger beside the preflight findings", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          ok: true,
          preflight: {
            specSlug: "delivery-plan",
            findings: [],
            summary: {
              selected: 3,
              claimed: 2,
              unclaimed: 1,
              dispositions: [
                { kind: "in_scope", count: 3 },
                { kind: "deferred", count: 1 },
              ],
              charter: {
                state: "authored",
                invariantCount: 4,
                sourceCount: 6,
              },
            },
          },
        }),
      files,
    );

    const result = await runCli(
      [
        "workflow",
        "validate",
        "--file",
        planFile,
        "--definition",
        "managed-wf",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      [
        "coverage: 2 of 3 selected criteria covered, 1 uncovered",
        "dispositions: in_scope 3, deferred 1",
        "charter: authored, 4 invariants, 6 sources",
      ].join("\n"),
    );
  });

  it("names the seed stub when the submitted charter is still the seed", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          ok: true,
          preflight: {
            specSlug: "delivery-plan",
            findings: [
              {
                ruleId: "launch/charter-unauthored",
                severity: "blocks_propose",
                elementHandle: "charter.mission",
                message: "The mission is still the seeded text.",
              },
            ],
            summary: {
              selected: 1,
              claimed: 1,
              unclaimed: 0,
              dispositions: [{ kind: "in_scope", count: 1 }],
              charter: {
                state: "seed_stub",
                invariantCount: 0,
                sourceCount: 2,
              },
            },
          },
        }),
      files,
    );

    const result = await runCli(
      [
        "workflow",
        "validate",
        "--file",
        planFile,
        "--definition",
        "managed-wf",
      ],
      baseEnv,
      host,
    );

    expect(result.stdout).toContain("charter: seed stub");
    // A file that still refuses propose is not ready to replace the draft, so
    // the chain's replace row is withheld until it is.
    expect(result.stdout).not.toContain("cctl workflow replace managed-wf");
    expect(result.stdout).toContain(
      `hint: correct the findings above in ${planFile}, then re-run 'cctl workflow validate --file ${planFile} --definition managed-wf'`,
    );
  });

  it("carries transition-named severities and handles in --json", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          ok: true,
          preflight: {
            specSlug: "delivery-plan",
            findings: [
              {
                ruleId: "binding/selected-criterion-unclaimed",
                severity: "blocks_propose",
                elementHandle: "R1.1",
                recordId: "criterion-one",
                message: "Selected criterion R1.1 has no claim.",
              },
            ],
            summary: {
              selected: 1,
              claimed: 0,
              unclaimed: 1,
              dispositions: [{ kind: "in_scope", count: 1 }],
              charter: {
                state: "authored",
                invariantCount: 1,
                sourceCount: 2,
              },
            },
          },
        }),
      files,
    );

    const result = await runCli(
      [
        "workflow",
        "validate",
        "--file",
        planFile,
        "--definition",
        "managed-wf",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(JSON.parse(result.stdout).findings).toEqual([
      {
        ruleId: "binding/selected-criterion-unclaimed",
        severity: "blocks_propose",
        handle: "R1.1",
        recordId: "criterion-one",
        message: "Selected criterion R1.1 has no claim.",
      },
    ]);
  });

  it.each([
    {
      code: "definition_not_managed",
      instruction:
        "Read the managed draft with `cctl spec plan status <slug>` and use the workflow definition id it names.",
    },
    {
      code: "definition_project_mismatch",
      instruction:
        "Switch to that project and run `cctl spec plan status delivery-plan`.",
    },
    {
      code: "delivery_plan_not_draft",
      instruction:
        "Run `cctl spec plan reopen delivery-plan --reason <why>` before validating replacement bytes.",
    },
  ])(
    "preserves the typed $code refusal in --json",
    async ({ code, instruction }) => {
      const host = makeHost(
        () =>
          jsonResponse(
            {
              error: "The managed delivery draft cannot be preflighted.",
              code,
              instruction,
            },
            409,
          ),
        files,
      );

      const result = await runCli(
        [
          "workflow",
          "validate",
          "--file",
          planFile,
          "--definition",
          "managed-wf",
          "--json",
        ],
        baseEnv,
        host,
      );

      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ code, instruction });
    },
  );

  it("renders the non-draft refusal instruction and why line", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error: "Delivery plan delivery-plan is proposed, not draft.",
            code: "delivery_plan_not_draft",
            instruction:
              "Run `cctl spec plan reopen delivery-plan --reason <why>` before validating replacement bytes.",
            rationale:
              "the signed candidate is immutable so sign-off approves exact bytes",
          },
          409,
        ),
      files,
    );

    const result = await runCli(
      [
        "workflow",
        "validate",
        "--file",
        planFile,
        "--definition",
        "managed-wf",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "cctl spec plan reopen delivery-plan --reason <why>",
    );
    expect(result.stderr).toContain(
      "why: the signed candidate is immutable so sign-off approves exact bytes",
    );
  });

  it("refuses to report a clean gate when the server omits the requested preflight", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), files);

    const result = await runCli(
      [
        "workflow",
        "validate",
        "--file",
        planFile,
        "--definition",
        "managed-wf",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "The server did not return the requested managed definition preflight.",
    );
    expect(result.stdout).not.toContain("propose: nothing refuses");
  });

  it("keeps validate output byte-identical at this tip when --definition is absent", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), files);

    const result = await runCli(
      ["workflow", "validate", "--file", planFile],
      baseEnv,
      host,
    );

    expect(result.stdout).toBe(
      `plan is valid\nhint: valid — create it with 'cctl workflow create --file ${planFile}'\n`,
    );
  });

  it("prints server warnings above the create hint and keeps exit 0 (R3.2)", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          ok: true,
          warnings: [
            {
              path: "definition.executionContexts[0].outputSchema.properties.verdict.enum",
              message:
                'Source context "context-plan" branches on "verdict" but no outgoing edge covers "hold"',
            },
          ],
        }),
      files,
    );
    const result = await runCli(
      ["workflow", "validate", "--file", planFile],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'warning: definition.executionContexts[0].outputSchema.properties.verdict.enum: Source context "context-plan" branches on "verdict" but no outgoing edge covers "hold"',
    );
    expect(result.stdout).toContain("plan is valid");
  });

  it("carries the warnings into the --json envelope", async () => {
    const warnings = [
      { path: "definition.edges", message: "uncovered values" },
    ];
    const host = makeHost(() => jsonResponse({ ok: true, warnings }), files);
    const result = await runCli(
      ["workflow", "validate", "--file", planFile, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, warnings });
  });

  it("exits 2 and prints one issue per line with JSON paths on a 400", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error: "Workflow plan is invalid",
            issues: [
              { path: "definition.edges", message: "cycle detected" },
              {
                path: "definition.tasks.0.contextId",
                message: "unknown context",
              },
            ],
          },
          400,
        ),
      files,
    );
    const result = await runCli(
      ["workflow", "validate", "--file", planFile],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("definition.edges: cycle detected");
    expect(result.stderr).toContain(
      "definition.tasks.0.contextId: unknown context",
    );
  });

  it("exits 2 when --file is missing", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(["workflow", "validate"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  // R4.2: a plan destined for the global library must be validatable under the
  // global-document rules, or its project-tier reference passes validate and is
  // only refused at save.
  it("carries --tier global to the route so the scope rule applies", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), files);
    const result = await runCli(
      ["workflow", "validate", "--file", planFile, "--tier", "global"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const url = new URL(host.requests[0]?.url ?? "");
    expect(url.pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/validate",
    );
    expect(url.searchParams.get("tier")).toBe("global");
    // `workflow create` is project-scoped, so it must not be hinted as the next
    // step for a plan deliberately validated as a global template.
    expect(result.stdout).not.toContain("create it with");
  });

  it("sends no tier selector by default (project scope)", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), files);
    const result = await runCli(
      ["workflow", "validate", "--file", planFile],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").searchParams.get("tier")).toBe(
      null,
    );
  });

  it("renders the scope-rule refusal with its JSON path and exits 2", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error: "Workflow plan is invalid",
            issues: [
              {
                path: "definition.executionContexts.0.contextValidator.assignments.0.profile",
                message:
                  "A global-scope workflow document may not reference the project-tier profile project:repo-reviewer.",
              },
            ],
          },
          400,
        ),
      files,
    );
    const result = await runCli(
      ["workflow", "validate", "--file", planFile, "--tier", "global"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "definition.executionContexts.0.contextValidator.assignments.0.profile",
    );
    expect(result.stderr).toContain(
      "project-tier profile project:repo-reviewer",
    );
  });

  it("exits 2 for an invalid --tier without reaching the server", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), files);
    const result = await runCli(
      ["workflow", "validate", "--file", planFile, "--tier", "bogus"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 without a session identity", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), files);
    const noSession: CliEnv = {
      CC_SERVER_URL: baseEnv.CC_SERVER_URL,
      CC_API_TOKEN: baseEnv.CC_API_TOKEN,
      CC_PROJECT: baseEnv.CC_PROJECT,
    };
    const result = await runCli(
      ["workflow", "validate", "--file", planFile],
      noSession,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("session");
  });
});

describe("cctl workflow create", () => {
  const planFile = "/tmp/plan.json";
  const files = {
    [planFile]: JSON.stringify({ name: "X", definition: {}, layout: {} }),
  };

  it("names the calling conversation on the header", async () => {
    const host = makeHost(
      () => jsonResponse({ item: { id: "wf-9", name: "X", revision: 1 } }, 201),
      files,
    );
    const result = await runCli(
      ["workflow", "create", "--file", planFile],
      { ...baseEnv, CC_CONVERSATION_ID: "conv-planner" },
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests[0]?.init.headers["x-cc-conversation-id"]).toBe(
      "conv-planner",
    );
  });

  it("posts the plan and emits the review-first hint after the review advisory", async () => {
    const host = makeHost((req) => {
      expect(req.init.method).toBe("POST");
      return jsonResponse(
        {
          item: { id: "wf-9", name: "Auth Setup", revision: 1 },
          reviewStatus: { state: "unreviewed" },
        },
        201,
      );
    }, files);
    const result = await runCli(
      ["workflow", "create", "--file", planFile],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/workflows",
    );
    expect(result.stdout).toContain("wf-9");
    const advisoryIndex = result.stdout.indexOf("plan review: none recorded");
    const hintIndex = result.stdout.indexOf(
      "hint: review it in the visual builder, then start it with 'cctl workflow start wf-9'",
    );
    expect(advisoryIndex).toBeGreaterThan(
      result.stdout.indexOf("created Auth Setup"),
    );
    expect(hintIndex).toBeGreaterThan(advisoryIndex);
    expect(result.stdout.trimEnd().endsWith("workflow start wf-9'")).toBe(true);
  });

  it("keeps the review-first guidance in the existing JSON hint field", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            item: { id: "wf-9", name: "Auth Setup", revision: 1 },
            reviewStatus: { state: "unreviewed" },
          },
          201,
        ),
      files,
    );
    const result = await runCli(
      ["workflow", "create", "--file", planFile, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      workflowId: "wf-9",
      reviewStatus: { state: "unreviewed" },
      hint: "review it in the visual builder, then start it with 'cctl workflow start wf-9'",
    });
    expect(JSON.parse(result.stdout)).not.toHaveProperty("reminders");
    expect(JSON.parse(result.stdout)).not.toHaveProperty("instruction");
  });

  it("does not require a session identity", async () => {
    const host = makeHost(
      () => jsonResponse({ item: { id: "wf-9", name: "X", revision: 1 } }, 201),
      files,
    );
    const noSession: CliEnv = {
      CC_SERVER_URL: baseEnv.CC_SERVER_URL,
      CC_API_TOKEN: baseEnv.CC_API_TOKEN,
      CC_PROJECT: baseEnv.CC_PROJECT,
    };
    const result = await runCli(
      ["workflow", "create", "--file", planFile],
      noSession,
      host,
    );
    expect(result.exitCode).toBe(0);
  });

  it("exits 2 on a validation rejection (400)", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error: "Workflow plan is invalid",
            issues: [{ path: "definition.charter", message: "Required" }],
          },
          400,
        ),
      files,
    );
    const result = await runCli(
      ["workflow", "create", "--file", planFile],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Workflow plan is invalid");
    // The normalized envelope's issues render one-per-line at their JSON path.
    expect(result.stderr).toContain("definition.charter");
  });

  it("exits 2 when --file is missing", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["workflow", "create"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when the --file cannot be read", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["workflow", "create", "--file", "/tmp/missing.json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("cannot read");
    expect(host.requests).toHaveLength(0);
  });

  it("prints admission warnings as warning: lines and keeps exit 0", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            item: { id: "wf-9", name: "Auth Setup", revision: 1 },
            warnings: [
              {
                path: "definition.executionContexts.0.acceptanceCriteria",
                message:
                  'lint/criteria-density: context "context-plan" declares 30 acceptance criteria',
              },
            ],
          },
          201,
        ),
      files,
    );
    const result = await runCli(
      ["workflow", "create", "--file", planFile],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'warning: definition.executionContexts.0.acceptanceCriteria: lint/criteria-density: context "context-plan" declares 30 acceptance criteria',
    );
    expect(result.stdout).toContain("created Auth Setup");
  });

  it("carries the warnings into the --json envelope", async () => {
    const warnings = [
      {
        path: "definition.tasks.0.instructions",
        message: "lint/oversized-prose: too long",
      },
    ];
    const host = makeHost(
      () =>
        jsonResponse(
          { item: { id: "wf-9", name: "X", revision: 1 }, warnings },
          201,
        ),
      files,
    );
    const result = await runCli(
      ["workflow", "create", "--file", planFile, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, warnings });
  });
});

describe("cctl workflow replace", () => {
  const planFile = "/tmp/plan.json";
  const files = {
    [planFile]: JSON.stringify({ name: "X", definition: {}, layout: {} }),
  };

  it("names the calling conversation on the header", async () => {
    const host = makeHost(
      () => jsonResponse({ item: { id: "wf-1", name: "X", revision: 4 } }),
      files,
    );
    const result = await runCli(
      ["workflow", "replace", "wf-1", "--file", planFile],
      { ...baseEnv, CC_CONVERSATION_ID: "conv-planner" },
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests[0]?.init.headers["x-cc-conversation-id"]).toBe(
      "conv-planner",
    );
  });

  it("puts the plan to the project workflows/[id] route with no hint", async () => {
    const host = makeHost((req) => {
      expect(req.init.method).toBe("PUT");
      return jsonResponse({
        item: { id: "wf-1", name: "Auth Setup", revision: 4 },
      });
    }, files);
    const result = await runCli(
      ["workflow", "replace", "wf-1", "--file", planFile],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/workflows/wf-1",
    );
    expect(result.stdout).toContain("revision: 4");
    expect(result.stdout).not.toContain("hint:");
  });

  it("exits 2 for an unknown workflow (404)", async () => {
    const host = makeHost(
      () => jsonResponse({ error: "Workflow not found" }, 404),
      files,
    );
    const result = await runCli(
      ["workflow", "replace", "nope", "--file", planFile],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not found");
  });

  it("exits 2 when the id is missing", async () => {
    const host = makeHost(() => jsonResponse({}), files);
    const result = await runCli(
      ["workflow", "replace", "--file", planFile],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when --file is missing", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["workflow", "replace", "wf-1"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("prints admission warnings above the replaced line and keeps exit 0", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          item: { id: "wf-1", name: "Auth Setup", revision: 4 },
          warnings: [
            {
              path: "definition.charter.sourcesOfTruth.1.locator",
              message:
                'lint/source-locator-unresolvable: charter source "acceptance-criteria" locator "context.acceptanceCriteria" does not resolve',
            },
          ],
        }),
      files,
    );
    const result = await runCli(
      ["workflow", "replace", "wf-1", "--file", planFile],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const [firstLine] = result.stdout.split("\n");
    expect(firstLine).toBe(
      'warning: definition.charter.sourcesOfTruth.1.locator: lint/source-locator-unresolvable: charter source "acceptance-criteria" locator "context.acceptanceCriteria" does not resolve',
    );
    expect(result.stdout).toContain("revision: 4");
  });
});

describe("cctl workflow id-bearing issue locators (#80 design 3.2)", () => {
  const planFile = "/tmp/plan.json";
  const files = {
    [planFile]: JSON.stringify({ name: "X", definition: {}, layout: {} }),
  };
  const locatedIssues = [
    {
      path: "definition.tasks.2 (wire-routes).contextId",
      message: 'Task "wire-routes" references missing context "ghost"',
      recordId: "wire-routes",
    },
    { path: "definition.edges", message: "graph must be acyclic" },
  ];
  const locatedWarnings = [
    {
      path: "definition.executionContexts.9 (memory-cli).acceptanceCriteria",
      message: "lint/criteria-density: too many criteria",
      recordId: "memory-cli",
    },
    { path: "definition.parameters", message: "lint/open-quantifier: sweep" },
  ];

  it("carries recordId beside path on validate's refusal envelope", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          { error: "Workflow plan is invalid", issues: locatedIssues },
          400,
        ),
      files,
    );
    const result = await runCli(
      ["workflow", "validate", "--file", planFile, "--json"],
      baseEnv,
      host,
    );

    expect(JSON.parse(result.stdout).issues).toEqual(locatedIssues);
  });

  it("preserves validate's located refusal when --definition is present", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          { error: "Workflow plan is invalid", issues: locatedIssues },
          400,
        ),
      files,
    );
    const result = await runCli(
      [
        "workflow",
        "validate",
        "--file",
        planFile,
        "--definition",
        "managed-wf",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(
      new URL(host.requests[0]?.url ?? "").searchParams.get("definition"),
    ).toBe("managed-wf");
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).issues).toEqual(locatedIssues);
  });

  it("carries recordId beside path on validate's warning envelope", async () => {
    const host = makeHost(
      () => jsonResponse({ ok: true, warnings: locatedWarnings }),
      files,
    );
    const result = await runCli(
      ["workflow", "validate", "--file", planFile, "--json"],
      baseEnv,
      host,
    );

    expect(JSON.parse(result.stdout).warnings).toEqual(locatedWarnings);
  });

  it("carries recordId beside path on create's warning envelope", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            item: { id: "wf-9", name: "X", revision: 1 },
            warnings: locatedWarnings,
          },
          201,
        ),
      files,
    );
    const result = await runCli(
      ["workflow", "create", "--file", planFile, "--json"],
      baseEnv,
      host,
    );

    expect(JSON.parse(result.stdout).warnings).toEqual(locatedWarnings);
  });

  it("carries recordId beside path on replace's warning envelope", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          item: { id: "wf-1", name: "X", revision: 4 },
          warnings: locatedWarnings,
        }),
      files,
    );
    const result = await runCli(
      ["workflow", "replace", "wf-1", "--file", planFile, "--json"],
      baseEnv,
      host,
    );

    expect(JSON.parse(result.stdout).warnings).toEqual(locatedWarnings);
  });

  it("prints the id-bearing path on the text surfaces", async () => {
    const host = makeHost(
      () => jsonResponse({ ok: true, warnings: locatedWarnings }),
      files,
    );
    const result = await runCli(
      ["workflow", "validate", "--file", planFile],
      baseEnv,
      host,
    );

    expect(result.stdout).toContain(
      "warning: definition.executionContexts.9 (memory-cli).acceptanceCriteria: lint/criteria-density: too many criteria",
    );
  });
});

describe("cctl workflow replace on a managed draft", () => {
  const planFile = "/tmp/plan.json";
  const files = {
    [planFile]: JSON.stringify({ name: "X", definition: {}, layout: {} }),
  };

  it("renders a server-owned refusal as the omit instruction with its why: line", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error: "Managed delivery workflow locked regions cannot be edited.",
            code: "region_locked",
            lockedPath: "/origin",
            sourceUri:
              "spec-plan://spec-1/revisions/r-1/attempts/a-1/candidates/wf-1",
            instruction: "/origin is server-owned; omit it from your plan.",
            rationale:
              "provenance and approval policy are stamped by the server so a signed candidate can prove where it came from",
          },
          409,
        ),
      files,
    );
    const result = await runCli(
      ["workflow", "replace", "wf-1", "--file", planFile],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines).toEqual([
      "Managed delivery workflow locked regions cannot be edited.",
      "why: provenance and approval policy are stamped by the server so a signed candidate can prove where it came from",
      "instruction: /origin is server-owned; omit it from your plan.",
    ]);
  });

  it("carries the rationale and code in the --json envelope", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error: "This managed delivery workflow definition is read-only.",
            code: "managed_workflow_definition_read_only",
            lifecycle: "in_review",
            instruction:
              "Reopen the delivery plan before editing its workflow definition.",
            rationale:
              "the signed candidate is immutable so sign-off approves exact bytes",
          },
          409,
        ),
      files,
    );
    const result = await runCli(
      ["workflow", "replace", "wf-1", "--file", planFile, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      code: "managed_workflow_definition_read_only",
      instruction:
        "Reopen the delivery plan before editing its workflow definition.",
      rationale:
        "the signed candidate is immutable so sign-off approves exact bytes",
    });
  });
});

describe("cctl workflow replace and edit receipts on a managed definition", () => {
  const planFile = "/tmp/plan.json";
  const opsFile = "/tmp/ops.json";
  const files = {
    [planFile]: JSON.stringify({ name: "X", definition: {}, layout: {} }),
    [opsFile]: JSON.stringify({
      expectedRevision: 1,
      operations: [{ type: "update-workflow", name: "Renamed" }],
    }),
  };
  const management = {
    kind: "native_sdd_delivery",
    specSlug: "native-sdd",
    lifecycle: "draft",
    editable: true,
  };
  const item = { id: "wf-1", name: "Auth Setup", revision: 2, management };

  it("replace prints the findings delta and points at plan status while findings remain", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          item,
          proposeGate: { blockingBefore: 2, blockingAfter: 1 },
        }),
      files,
    );
    const result = await runCli(
      ["workflow", "replace", "wf-1", "--file", planFile],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "replaced Auth Setup (revision: 2)",
      "next write: expectedRevision 2",
      "propose findings: 2 -> 1 (blocks_propose)",
      "hint: read what still refuses propose with 'cctl spec plan status native-sdd'",
    ]);
  });

  it("replace reports nothing refuses and points at propose when the gate is clean, in --json too", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          item,
          proposeGate: { blockingBefore: 1, blockingAfter: 0 },
        }),
      files,
    );
    const text = await runCli(
      ["workflow", "replace", "wf-1", "--file", planFile],
      baseEnv,
      host,
    );
    const json = await runCli(
      ["workflow", "replace", "wf-1", "--file", planFile, "--json"],
      baseEnv,
      host,
    );

    expect(text.stdout.trimEnd().split("\n")).toEqual([
      "replaced Auth Setup (revision: 2)",
      "next write: expectedRevision 2",
      "propose: nothing refuses",
      "hint: propose the draft with 'cctl spec plan propose native-sdd'",
    ]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: true,
      revision: 2,
      blockingBefore: 1,
      blockingAfter: 0,
      hint: "propose the draft with 'cctl spec plan propose native-sdd'",
    });
  });

  it("edit prints the findings delta and the status hint, and carries both counts in --json", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          item: { ...item, name: "Renamed" },
          applied: 1,
          proposeGate: { blockingBefore: 3, blockingAfter: 3 },
        }),
      files,
    );
    const text = await runCli(
      ["workflow", "edit", "wf-1", "--file", opsFile],
      baseEnv,
      host,
    );
    const json = await runCli(
      ["workflow", "edit", "wf-1", "--file", opsFile, "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout.trimEnd().split("\n")).toEqual([
      'edited "Renamed": 1 operation applied, revision 2',
      "next write: expectedRevision 2",
      "propose findings: 3 -> 3 (blocks_propose)",
      "hint: read what still refuses propose with 'cctl spec plan status native-sdd'",
    ]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: true,
      workflowId: "wf-1",
      applied: 1,
      revision: 2,
      blockingBefore: 3,
      blockingAfter: 3,
      hint: "read what still refuses propose with 'cctl spec plan status native-sdd'",
    });
  });

  it("edit reports nothing refuses and the propose hint when the gate is clean", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          item: { ...item, name: "Renamed" },
          applied: 1,
          proposeGate: { blockingBefore: 1, blockingAfter: 0 },
        }),
      files,
    );
    const result = await runCli(
      ["workflow", "edit", "wf-1", "--file", opsFile],
      baseEnv,
      host,
    );

    expect(result.stdout.trimEnd().split("\n")).toEqual([
      'edited "Renamed": 1 operation applied, revision 2',
      "next write: expectedRevision 2",
      "propose: nothing refuses",
      "hint: propose the draft with 'cctl spec plan propose native-sdd'",
    ]);
  });

  it("a managed receipt without a gate reading prints no gate line and still points at plan status", async () => {
    const host = makeHost(() => jsonResponse({ item, applied: 1 }), files);
    const result = await runCli(
      ["workflow", "edit", "wf-1", "--file", opsFile, "--json"],
      baseEnv,
      host,
    );

    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      ok: true,
      hint: "read what still refuses propose with 'cctl spec plan status native-sdd'",
    });
    expect(envelope).not.toHaveProperty("blockingBefore");
    expect(envelope).not.toHaveProperty("blockingAfter");
  });

  it("an unmanaged edit prints neither line and no hint, and keeps today's envelope", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          item: { id: "wf-1", name: "Renamed", revision: 2 },
          applied: 1,
        }),
      files,
    );
    const text = await runCli(
      ["workflow", "edit", "wf-1", "--file", opsFile],
      baseEnv,
      host,
    );
    const json = await runCli(
      ["workflow", "edit", "wf-1", "--file", opsFile, "--json"],
      baseEnv,
      host,
    );

    expect(text.stdout).toBe(
      'edited "Renamed": 1 operation applied, revision 2\nnext write: expectedRevision 2\n',
    );
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      workflowId: "wf-1",
      applied: 1,
      revision: 2,
      expectedRevision: 2,
    });
  });
});

describe("cctl workflow (dispatch)", () => {
  it("exits 2 on an unknown subcommand", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["workflow", "frobnicate"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when no subcommand is given", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["workflow"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 3 when the server rejects the token", async () => {
    const host = makeHost(() => jsonResponse({ error: "nope" }, 401));
    const result = await runCli(["workflow", "list"], baseEnv, host);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("token");
  });
});

// --- Lane verbs (docs/design/cc-cli/02 §4) -----------------------------------

const laneEnv: CliEnv = {
  ...baseEnv,
  CC_WORKFLOW_EXECUTION_ID: "exec-7",
  CC_WORKFLOW_CONTEXT_ID: "context-plan",
};

describe("cctl workflow task complete", () => {
  it("posts to the lane task-complete endpoint with env-derived identity", async () => {
    const host = makeHost(() =>
      jsonResponse({ ok: true, remainingTaskCount: 3 }),
    );
    const result = await runCli(
      [
        "workflow",
        "task",
        "complete",
        "task-1",
        "--summary",
        "Wrote the plan.",
      ],
      laneEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/contexts/context-plan/tasks/task-1/complete",
    );
    const body = JSON.parse(request?.init.body ?? "{}");
    expect(body).toEqual({ executionId: "exec-7", summary: "Wrote the plan." });
    expect(result.stdout).toContain("completed task-1");
  });

  // Shell substitution has blanked a backticked summary in production, so the
  // file source must deliver the bytes the agent wrote, verbatim.
  it("sends the summary read from --summary-file, backticks intact", async () => {
    const host = makeHost(
      () => jsonResponse({ ok: true, remainingTaskCount: 0 }),
      {
        ".cc/temp/summary.md": "Ran `bun test`; 12 files green.\n",
      },
    );
    const result = await runCli(
      [
        "workflow",
        "task",
        "complete",
        "task-1",
        "--summary-file",
        ".cc/temp/summary.md",
      ],
      laneEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(host.requests[0]?.init.body ?? "{}")).toEqual({
      executionId: "exec-7",
      summary: "Ran `bun test`; 12 files green.",
    });
  });

  it("refuses --summary together with --summary-file before any request", async () => {
    const host = makeHost(
      () => jsonResponse({ ok: true, remainingTaskCount: 0 }),
      {
        ".cc/temp/summary.md": "from the file",
      },
    );
    const result = await runCli(
      [
        "workflow",
        "task",
        "complete",
        "task-1",
        "--summary",
        "inline",
        "--summary-file",
        ".cc/temp/summary.md",
      ],
      laneEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("names the file alternative when neither source is passed", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(
      ["workflow", "task", "complete", "task-1"],
      laneEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--summary-file");
  });

  // The remaining count is the outcome of the call, not an optional next step:
  // it is primary output, and no `hint:` competes with it.
  it("states the remaining count in the primary body when there is no stop instruction", async () => {
    const host = makeHost(() =>
      jsonResponse({ ok: true, remainingTaskCount: 3 }),
    );
    const result = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done"],
      laneEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "completed task-1\n3 tasks remain in this context\n",
    );
  });

  it("singularizes the remaining count for one task", async () => {
    const host = makeHost(() =>
      jsonResponse({ ok: true, remainingTaskCount: 1 }),
    );
    const result = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done"],
      laneEnv,
      host,
    );
    expect(result.stdout).toContain("1 task remains in this context");
    expect(result.stdout).not.toContain("hint:");
  });

  it("prints the stop instruction verbatim and OMITS the hint on rotation", async () => {
    const stop =
      "CONTEXT LIMIT REACHED for this context. End your turn now with a brief handoff note.";
    const host = makeHost(() =>
      jsonResponse({ ok: true, remainingTaskCount: 2, stopInstruction: stop }),
    );
    const result = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done"],
      laneEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(stop);
    expect(result.stdout).not.toContain("hint:");
    expect(result.stdout).not.toContain("tasks remain");
  });

  it("carries the stop instruction in the json envelope, with no hint at all", async () => {
    const stop = "CONTEXT LIMIT REACHED. End your turn now.";
    const host = makeHost(() =>
      jsonResponse({ ok: true, remainingTaskCount: 2, stopInstruction: stop }),
    );
    const result = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done", "--json"],
      laneEnv,
      host,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.stopInstruction).toBe(stop);
    expect(envelope.hint).toBeUndefined();
  });

  it("prints the halt reason verbatim and exits 1 on a 409 halt", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error: "iteration halted: circuit_breaker",
          halt: true,
          reason: "iteration halted: circuit_breaker",
        },
        409,
      ),
    );
    const result = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done"],
      laneEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("iteration halted: circuit_breaker");
  });

  it("renders reminder lines between the primary output and the hint on success", async () => {
    const host = makeHost(() =>
      jsonResponse({
        ok: true,
        remainingTaskCount: 2,
        reminders: [
          "This context has used 2 of 3 iterations.",
          "This lane is autonomous — use `cctl workflow collab request`.",
        ],
      }),
    );
    const result = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done"],
      laneEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const out = result.stdout;
    expect(out).toContain("completed task-1");
    expect(out).toContain("reminder: This context has used 2 of 3 iterations.");
    expect(out).toContain(
      "reminder: This lane is autonomous — use `cctl workflow collab request`.",
    );
    expect(out).toContain("2 tasks remain in this context");
    // Tier order (doc 04 §5.1): primary output → reminders.
    const primaryIdx = out.indexOf("completed task-1");
    const countIdx = out.indexOf("2 tasks remain in this context");
    const reminderIdx = out.indexOf("reminder:");
    expect(primaryIdx).toBeLessThan(countIdx);
    expect(countIdx).toBeLessThan(reminderIdx);
    expect(out).not.toContain("hint:");
  });

  it("carries reminders in the --json envelope on success", async () => {
    const host = makeHost(() =>
      jsonResponse({
        ok: true,
        remainingTaskCount: 2,
        reminders: ["r1", "r2"],
      }),
    );
    const result = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done", "--json"],
      laneEnv,
      host,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.reminders).toEqual(["r1", "r2"]);
  });

  it("emits no reminder lines and no reminders field when the server sends none", async () => {
    const host = makeHost(() =>
      jsonResponse({ ok: true, remainingTaskCount: 3 }),
    );
    const textResult = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done"],
      laneEnv,
      host,
    );
    expect(textResult.stdout).not.toContain("reminder:");

    const jsonHost = makeHost(() =>
      jsonResponse({ ok: true, remainingTaskCount: 3 }),
    );
    const jsonResult = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done", "--json"],
      laneEnv,
      jsonHost,
    );
    expect(JSON.parse(jsonResult.stdout).reminders).toBeUndefined();
  });

  it("renders reminders in addition to a stop instruction, still omitting the hint", async () => {
    const stop = "CONTEXT LIMIT REACHED. End your turn now.";
    const host = makeHost(() =>
      jsonResponse({
        ok: true,
        remainingTaskCount: 2,
        stopInstruction: stop,
        reminders: ["This context has used 2 of 3 iterations."],
      }),
    );
    const result = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done"],
      laneEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(stop);
    expect(result.stdout).toContain(
      "reminder: This context has used 2 of 3 iterations.",
    );
    expect(result.stdout).not.toContain("hint:");
  });

  it("surfaces reminders on the 409 halt in both stderr and the json envelope", async () => {
    const haltReminder =
      "This workflow is halted: iteration halted: circuit_breaker. Do not continue task work; end your turn.";
    const body = {
      error: "iteration halted: circuit_breaker",
      halt: true,
      reason: "iteration halted: circuit_breaker",
      reminders: [haltReminder],
    };
    const textResult = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done"],
      laneEnv,
      makeHost(() => jsonResponse(body, 409)),
    );
    expect(textResult.exitCode).toBe(1);
    expect(textResult.stderr).toContain(`reminder: ${haltReminder}`);

    const jsonResult = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done", "--json"],
      laneEnv,
      makeHost(() => jsonResponse(body, 409)),
    );
    expect(jsonResult.exitCode).toBe(1);
    expect(JSON.parse(jsonResult.stdout).reminders).toEqual([haltReminder]);
  });

  it("exits 2 naming CC_WORKFLOW_EXECUTION_ID when the lane env is absent", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("CC_WORKFLOW_EXECUTION_ID");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when --summary is missing", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(
      ["workflow", "task", "complete", "task-1"],
      laneEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl workflow task add", () => {
  it("posts title/instructions/slug to the lane tasks endpoint", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(
      [
        "workflow",
        "task",
        "add",
        "--title",
        "Edge case",
        "--instructions",
        "Handle empty input.",
        "--slug",
        "edge-case",
      ],
      laneEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/contexts/context-plan/tasks",
    );
    expect(JSON.parse(request?.init.body ?? "{}")).toEqual({
      executionId: "exec-7",
      title: "Edge case",
      instructions: "Handle empty input.",
      slug: "edge-case",
    });
    expect(result.stdout).toContain('added task "Edge case"');
  });

  it("omits slug when not provided", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    await runCli(
      ["workflow", "task", "add", "--title", "T", "--instructions", "Do it."],
      laneEnv,
      host,
    );
    expect(JSON.parse(host.requests[0]?.init.body ?? "{}")).not.toHaveProperty(
      "slug",
    );
  });

  it("surfaces a 403 capability gate verbatim and exits 1", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error:
            "This execution context does not allow agent-added tasks (mutability.allowAgentTaskAdd is disabled).",
        },
        403,
      ),
    );
    const result = await runCli(
      ["workflow", "task", "add", "--title", "T", "--instructions", "Do it."],
      laneEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not allow agent-added tasks");
  });

  it("exits 2 when --title or --instructions is missing", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }));
    const result = await runCli(
      ["workflow", "task", "add", "--title", "T"],
      laneEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl workflow graph expand", () => {
  const payloadFile = "/tmp/expand.json";
  const payload = {
    requestId: "req-1",
    rationale: "Fan out one candidate per approach.",
    contexts: [
      {
        handle: "candidate-a",
        title: "Candidate A",
        acceptanceCriteria: "A works",
      },
    ],
    tasks: [
      {
        contextHandle: "candidate-a",
        title: "Build A",
        instructions: "Build approach A.",
      },
    ],
    edges: [
      { from: "context-plan", to: "candidate-a" },
      { from: "candidate-a", to: "context-verify" },
    ],
  };
  const files = { [payloadFile]: JSON.stringify(payload) };
  const capabilityEnv: CliEnv = {
    ...laneEnv,
    CC_WORKFLOW_LANE_CAPABILITY: "cclc1.payload.signature",
  };

  it("posts the payload to the lane expand endpoint with the capability header", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          ok: true,
          liveRevision: 4,
          createdContextIds: ["context-plan-xdeadbeef-candidate-a"],
          createdTaskIds: ["context-plan-xdeadbeef-candidate-a-t1"],
          rejoinContextIds: ["context-verify"],
        }),
      files,
    );

    const result = await runCli(
      ["workflow", "graph", "expand", "--file", payloadFile],
      capabilityEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/contexts/context-plan/expand",
    );
    expect(request?.init.headers?.["x-cc-lane-capability"]).toBe(
      "cclc1.payload.signature",
    );
    expect(JSON.parse(request?.init.body ?? "{}")).toEqual({
      executionId: "exec-7",
      request: payload,
    });
    expect(result.stdout).toContain("context-plan-xdeadbeef-candidate-a");
  });

  it("tells the lane a retried request replayed rather than expanded again", async () => {
    // A lane whose response was lost retries the SAME requestId. The server
    // answers from the acceptance receipt, and the CLI must not report that as
    // a second expansion — the ids it lists are already in the graph (R6.3).
    const host = makeHost(
      () =>
        jsonResponse({
          ok: true,
          replayed: true,
          liveRevision: 4,
          createdContextIds: ["context-plan-xdeadbeef-candidate-a"],
          createdTaskIds: ["context-plan-xdeadbeef-candidate-a-t1"],
          rejoinContextIds: ["context-verify"],
        }),
      files,
    );

    const result = await runCli(
      ["workflow", "graph", "expand", "--file", payloadFile],
      capabilityEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("already applied");
    expect(result.stdout).not.toContain("added 1 context(s)");
    expect(result.stdout).toContain("context-plan-xdeadbeef-candidate-a");
  });

  it("exits 2 naming the capability variable when the lane has none", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), files);

    const result = await runCli(
      ["workflow", "graph", "expand", "--file", payloadFile],
      laneEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("CC_WORKFLOW_LANE_CAPABILITY");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 without a request when --file is missing", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), files);

    const result = await runCli(
      ["workflow", "graph", "expand"],
      capabilityEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--file");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 without a request when the payload file is not a valid expansion", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), {
      [payloadFile]: JSON.stringify({ requestId: "req-1" }),
    });

    const result = await runCli(
      ["workflow", "graph", "expand", "--file", payloadFile],
      capabilityEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 1 printing the server's refusal", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error:
              'Context "context-plan" does not allow agent graph expansion',
            code: "expansion-not-authorized",
          },
          403,
        ),
      files,
    );

    const result = await runCli(
      ["workflow", "graph", "expand", "--file", payloadFile],
      capabilityEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not allow agent graph expansion");
  });
});

describe("cctl workflow shared-doc upsert", () => {
  const docFile = "/tmp/doc.json";
  const files = {
    [docFile]: JSON.stringify({
      description: "API contract",
      readWhen: "before implementing any route",
    }),
  };

  it("PUTs description/readWhen to the encoded catch-all doc path", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), files);
    const result = await runCli(
      [
        "workflow",
        "shared-doc",
        "upsert",
        ".cc/graph-workflow-docs/api-contract.md",
        "--file",
        docFile,
      ],
      laneEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("PUT");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/shared-documents/.cc/graph-workflow-docs/api-contract.md",
    );
    expect(JSON.parse(request?.init.body ?? "{}")).toEqual({
      executionId: "exec-7",
      contextId: "context-plan",
      description: "API contract",
      readWhen: "before implementing any route",
    });
    expect(result.stdout).toContain(
      "registered shared document .cc/graph-workflow-docs/api-contract.md",
    );
  });

  it("exits 2 when the file lacks description/readWhen", async () => {
    const host = makeHost(() => jsonResponse({ ok: true }), {
      [docFile]: JSON.stringify({ description: "only this" }),
    });
    const result = await runCli(
      ["workflow", "shared-doc", "upsert", "doc.md", "--file", docFile],
      laneEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl workflow collab request", () => {
  it("posts the brief and prints the workflowId + stop-and-wait directive", async () => {
    const host = makeHost(() =>
      jsonResponse({ ok: true, status: "started", workflowId: "wf-42" }),
    );
    const result = await runCli(
      ["workflow", "collab", "request", "--brief", "Which storage layer?"],
      laneEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/contexts/context-plan/collaboration-requests",
    );
    expect(JSON.parse(request?.init.body ?? "{}")).toEqual({
      executionId: "exec-7",
      brief: "Which storage layer?",
    });
    expect(result.stdout).toContain("wf-42");
    expect(result.stdout.toLowerCase()).toContain("wait for the follow-up");
    expect(result.stdout).not.toContain("hint:");
  });

  it("surfaces a 403 collaboration gate verbatim and exits 1", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error:
            "This execution context does not allow agent-initiated collaboration requests.",
        },
        403,
      ),
    );
    const result = await runCli(
      ["workflow", "collab", "request", "--brief", "?"],
      laneEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "does not allow agent-initiated collaboration",
    );
  });
});

describe("write receipts name the next write's token (#80 I-7)", () => {
  const planFile = "/tmp/plan.json";
  const opsFile = "/tmp/ops.json";
  const files = {
    [planFile]: JSON.stringify({ name: "X", definition: {}, layout: {} }),
    [opsFile]: JSON.stringify({
      expectedRevision: 3,
      operations: [{ type: "update-workflow", name: "X" }],
    }),
  };

  it("names expectedRevision on the create receipt, in text and JSON", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          { item: { id: "wf-9", name: "Auth Setup", revision: 1 } },
          201,
        ),
      files,
    );
    const text = await runCli(
      ["workflow", "create", "--file", planFile],
      baseEnv,
      host,
    );
    const structured = await runCli(
      ["workflow", "create", "--file", planFile, "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("next write: expectedRevision 1");
    expect(JSON.parse(structured.stdout)).toMatchObject({
      expectedRevision: 1,
    });
  });

  it("names expectedRevision on the replace receipt, in text and JSON", async () => {
    const host = makeHost(
      () =>
        jsonResponse({ item: { id: "wf-1", name: "Auth Setup", revision: 4 } }),
      files,
    );
    const text = await runCli(
      ["workflow", "replace", "wf-1", "--file", planFile],
      baseEnv,
      host,
    );
    const structured = await runCli(
      ["workflow", "replace", "wf-1", "--file", planFile, "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("next write: expectedRevision 4");
    expect(JSON.parse(structured.stdout)).toMatchObject({
      expectedRevision: 4,
    });
  });

  it("names expectedRevision on the edit receipt, in text and JSON", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          applied: 1,
          item: { id: "wf-1", name: "Auth Setup", revision: 4 },
        }),
      files,
    );
    const text = await runCli(
      ["workflow", "edit", "wf-1", "--file", opsFile],
      baseEnv,
      host,
    );
    const structured = await runCli(
      ["workflow", "edit", "wf-1", "--file", opsFile, "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("next write: expectedRevision 4");
    expect(JSON.parse(structured.stdout)).toMatchObject({
      expectedRevision: 4,
    });
  });
});
