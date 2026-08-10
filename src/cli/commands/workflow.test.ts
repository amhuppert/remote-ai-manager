import { describe, expect, it } from "vitest";
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
): CliHost & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
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
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

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

  it("--json returns the full execution payload", async () => {
    const host = makeHost(() => jsonResponse({ execution }));
    const result = await runCli(
      ["workflow", "status", "--json"],
      baseEnv,
      host,
    );
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.execution.id).toBe("exec-1");
    expect(envelope.execution.contextStates["phase-b"].completedTaskCount).toBe(
      1,
    );
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
    const host = makeHost(() =>
      jsonResponse(
        {
          error:
            "Workflow definition approval is required before execution can start",
          code: "definition_approval_required",
          executionId: "exec-review-9",
          instruction:
            "Record approval for the pending workflow definition before starting execution.",
        },
        409,
      ),
    );

    const result = await runCli(["workflow", "start", "wf-1"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "parked wf-1 (run exec-review-9) awaiting definition approval",
    );
    expect(result.stdout).toContain(
      "Record approval for the pending workflow definition",
    );
  });

  it("returns a successful parked envelope for approval-required executions in JSON mode", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          error:
            "Workflow definition approval is required before execution can start",
          code: "definition_approval_required",
          executionId: "exec-review-json",
          instruction:
            "Record approval for the pending workflow definition before starting execution.",
        },
        409,
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
        "Record approval for the pending workflow definition before starting execution.",
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

  it("posts the plan to the project workflows route and emits the start hint", async () => {
    const host = makeHost((req) => {
      expect(req.init.method).toBe("POST");
      return jsonResponse(
        { item: { id: "wf-9", name: "Auth Setup", revision: 1 } },
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
    expect(
      result.stdout
        .trimEnd()
        .endsWith("start it with 'cctl workflow start wf-9'"),
    ).toBe(true);
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
});

describe("cctl workflow replace", () => {
  const planFile = "/tmp/plan.json";
  const files = {
    [planFile]: JSON.stringify({ name: "X", definition: {}, layout: {} }),
  };

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

  it("emits the remaining-count hint when there is no stop instruction", async () => {
    const host = makeHost(() =>
      jsonResponse({ ok: true, remainingTaskCount: 3 }),
    );
    const result = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done"],
      laneEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hint: 3 tasks remain in this context");
  });

  it("singularizes the remaining-count hint for one task", async () => {
    const host = makeHost(() =>
      jsonResponse({ ok: true, remainingTaskCount: 1 }),
    );
    const result = await runCli(
      ["workflow", "task", "complete", "task-1", "--summary", "done"],
      laneEnv,
      host,
    );
    expect(result.stdout).toContain("hint: 1 task remains in this context");
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

  it("carries the stop instruction in the json envelope, without a hint", async () => {
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
    expect(out).toContain("hint: 2 tasks remain in this context");
    // Tier order (doc 04 §5.1): primary output → reminders → hint.
    const primaryIdx = out.indexOf("completed task-1");
    const reminderIdx = out.indexOf("reminder:");
    const hintIdx = out.indexOf("hint:");
    expect(primaryIdx).toBeLessThan(reminderIdx);
    expect(reminderIdx).toBeLessThan(hintIdx);
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
