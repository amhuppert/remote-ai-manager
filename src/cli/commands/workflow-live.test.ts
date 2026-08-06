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

const OUTLINE_BODY = {
  ok: true,
  section: "outline",
  outline: {
    header: {
      executionId: "exec-7",
      liveRevision: 4,
      status: "running",
      seedDefinitionId: "wf-1",
      seedDefinitionRevision: 12,
      editable: true,
    },
    contexts: [
      {
        id: "plan",
        title: "Plan",
        status: "completed",
        editability: "frozen",
        deps: [],
        completedTaskCount: 3,
        totalTaskCount: 3,
        iterationCount: 2,
        maxIterations: 20,
        outputSchema: null,
      },
      {
        id: "impl",
        title: "Implement",
        status: "running",
        editability: "pause-to-edit",
        deps: ["plan"],
        completedTaskCount: 1,
        totalTaskCount: 4,
        iterationCount: 3,
        maxIterations: 20,
        outputSchema: null,
      },
      {
        id: "verify",
        title: "Verify",
        status: "pending",
        editability: "editable",
        deps: ["impl"],
        completedTaskCount: 0,
        totalTaskCount: 2,
        iterationCount: 0,
        maxIterations: 12,
        outputSchema: { type: "object", fieldCount: 2 },
      },
    ],
    tasks: [
      {
        contextId: "impl",
        order: 1,
        id: "impl-api",
        status: "completed",
        title: "Wire API",
        instructionChars: 812,
      },
      {
        contextId: "impl",
        order: 2,
        id: "impl-ui",
        status: "running",
        title: "Build inspector UI",
        instructionChars: 1800,
      },
      {
        contextId: "impl",
        order: 3,
        id: "impl-tests",
        status: "pending",
        title: "Add tests",
        instructionChars: 704,
      },
    ],
    config: [
      {
        contextId: "plan",
        implementer: {
          assignmentId: "implementer",
          profile: "builtin:general-implementer",
          focus: null,
          revision: 2,
          resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
          backend: "claude",
          model: "opus",
          reasoningEffort: "medium",
        },
        validators: [
          {
            assignmentId: "general",
            profile: "builtin:general-reviewer",
            focus: null,
            revision: 5,
            resolvedInstructionHash: `sha256:${"e".repeat(64)}`,
            strategy: "conversation",
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
        ],
        validatorCohortEnabled: true,
        scriptValidator: { commands: [] },
        humanApprovalGate: false,
        askUserQuestions: false,
        collaboration: null,
      },
      {
        contextId: "impl",
        implementer: {
          assignmentId: "implementer",
          profile: "builtin:general-implementer",
          focus: null,
          revision: 2,
          resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
          backend: "claude",
          model: "opus",
          reasoningEffort: "medium",
        },
        validators: [
          {
            assignmentId: "general",
            profile: "builtin:general-reviewer",
            focus: null,
            revision: 5,
            resolvedInstructionHash: `sha256:${"e".repeat(64)}`,
            strategy: "conversation",
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
        ],
        validatorCohortEnabled: true,
        scriptValidator: { commands: ["typecheck", "test"] },
        agentValidation: {
          implementer: { mode: "all", except: ["format"] },
          contextValidator: { mode: "only", commands: [] },
        },
        humanApprovalGate: true,
        askUserQuestions: false,
        collaboration: null,
      },
      {
        contextId: "verify",
        implementer: {
          assignmentId: "implementer",
          profile: "project:house-implementer",
          focus: "state-store",
          revision: 7,
          resolvedInstructionHash: `sha256:${"d".repeat(64)}`,
          backend: "codex",
          model: "gpt-5.4",
          reasoningEffort: "high",
        },
        // A disabled cohort that retains a seeded assignment: it does not run,
        // but the execution holds it and a live edit can enable it.
        validatorCohortEnabled: false,
        validators: [
          {
            assignmentId: "dormant-security",
            profile: "global:house-reviewer",
            focus: null,
            revision: 3,
            resolvedInstructionHash: `sha256:${"f".repeat(64)}`,
            strategy: "task",
            backend: "codex",
            model: "gpt-5.4",
            reasoningEffort: "low",
          },
        ],
        scriptValidator: { commands: [] },
        humanApprovalGate: false,
        askUserQuestions: false,
        collaboration: null,
      },
    ],
  },
};

describe("cctl workflow live (dispatch + aliases)", () => {
  it("exits 2 with no subcommand and makes no request", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["workflow", "live"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 on an unknown live subcommand", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["workflow", "live", "frobnicate"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("rewrites 'workflow execution get' to the live-outline endpoint", async () => {
    const host = makeHost(() => jsonResponse(OUTLINE_BODY));
    const result = await runCli(
      ["workflow", "execution", "get"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/live-outline",
    );
  });

  it("rewrites 'workflow exec get' to the live-outline endpoint", async () => {
    const host = makeHost(() => jsonResponse(OUTLINE_BODY));
    const result = await runCli(["workflow", "exec", "get"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/live-outline",
    );
  });

  it("resolves 'workflow execution --help' to the live group help node", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["workflow", "execution", "--help"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(host.requests).toHaveLength(0);
    expect(result.stdout).toContain("workflow live");
    expect(result.stdout).toContain("workflow live get");
  });

  it("resolves 'workflow exec edit --help' to the live edit leaf help", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["workflow", "exec", "edit", "--help"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("workflow live edit");
    expect(result.stdout).toContain("baseLiveRevision");
  });
});

describe("cctl workflow live get", () => {
  it("renders the text outline (header, contexts, tasks, config)", async () => {
    const host = makeHost(() => jsonResponse(OUTLINE_BODY));
    const result = await runCli(["workflow", "live", "get"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(host.requests[0]?.init.method).toBe("GET");
    expect(result.stdout).toMatchInlineSnapshot(`
      "execution exec-7  status=running  liveRev=4  seed=wf-1@12
      contexts:
        plan    completed  frozen         deps=-     tasks=3/3  iter=2/20
        impl    running    pause-to-edit  deps=plan  tasks=1/4  iter=3/20
        verify  pending    editable       deps=impl  tasks=0/2  iter=0/12  output schema: object · 2 fields
      tasks:
        impl  1 impl-api    completed  "Wire API"            (812 chars)
              2 impl-ui     running    "Build inspector UI"  (1.8k chars)
              3 impl-tests  pending    "Add tests"           (704 chars)
      config:
        plan    claude opus medium; validator general conversation claude sonnet medium; script off
        impl    claude opus medium; validator general conversation claude sonnet medium; script typecheck+test; roles implementer all-except format, validator none; approval on
        verify  codex gpt-5.4 high; validator off; script off
      staffing (snapshots):
        plan    implementer  implementer       builtin:general-implementer@2  #cccccccccccc  claude opus medium
        plan    validator    general           builtin:general-reviewer@5     #eeeeeeeeeeee  conversation claude sonnet medium
        impl    implementer  implementer       builtin:general-implementer@2  #cccccccccccc  claude opus medium
        impl    validator    general           builtin:general-reviewer@5     #eeeeeeeeeeee  conversation claude sonnet medium
        verify  implementer  implementer       project:house-implementer@7    #dddddddddddd  codex gpt-5.4 high  focus "state-store"
        verify  validator    dormant-security  global:house-reviewer@3        #ffffffffffff  task codex gpt-5.4 low  (cohort disabled)
      "
    `);
  });

  /**
   * R13.1: the live surface is the SNAPSHOT half of the two-shape distinction —
   * a running execution shows the revision it resolved and the hash of the
   * instructions it replays. `cctl workflow get` shows neither, because a saved
   * definition has resolved nothing.
   */
  it("renders one staffing row per seeded assignment with revision and hash", async () => {
    const host = makeHost(() => jsonResponse(OUTLINE_BODY));
    const result = await runCli(["workflow", "live", "get"], baseEnv, host);

    const staffing = result.stdout
      .split("staffing (snapshots):\n")[1]
      ?.split("\n")
      .filter((line) => line.startsWith("  "));

    // One row per SEEDED assignment: three implementers plus three validators,
    // the last of which is dormant. A dormant row is what a disabled cohort
    // holds, and the block reports what the execution holds.
    expect(staffing).toHaveLength(6);
    expect(staffing?.[0]).toContain("builtin:general-implementer@2");
    expect(staffing?.[0]).toContain("#cccccccccccc");
    expect(staffing?.[1]).toContain("builtin:general-reviewer@5");
    expect(staffing?.[1]).toContain("conversation claude sonnet medium");
    expect(staffing?.[4]).toContain('focus "state-store"');
    // The short hash is a prefix of the digest, never the whole 64-char one.
    expect(result.stdout).not.toContain("c".repeat(64));
  });

  /**
   * Hard cutover: the live-outline projection always carries the post-cutover
   * staffing fields, so the CLI REQUIRES them. An outline missing them is not
   * quietly reinterpreted under the old rules — inferring "cohort disabled" from
   * an empty list would be an inbound compatibility parser, which the charter
   * prohibits. It falls back to the raw payload, the same as any other body the
   * renderer cannot honestly render.
   */
  it("refuses to infer staffing from an outline missing the cutover fields", async () => {
    const legacy = structuredClone(OUTLINE_BODY);
    for (const entry of legacy.outline.config) {
      delete (entry as { validatorCohortEnabled?: unknown })
        .validatorCohortEnabled;
    }
    const result = await runCli(
      ["workflow", "live", "get"],
      baseEnv,
      makeHost(() => jsonResponse(legacy)),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("staffing (snapshots):");
    expect(result.stdout).not.toContain("validator off");
  });

  it("refuses to render a staffing row whose seeded provenance is absent", async () => {
    const legacy = structuredClone(OUTLINE_BODY);
    for (const entry of legacy.outline.config) {
      delete (entry.implementer as { revision?: unknown }).revision;
    }
    const result = await runCli(
      ["workflow", "live", "get"],
      baseEnv,
      makeHost(() => jsonResponse(legacy)),
    );

    expect(result.stdout).not.toContain("staffing (snapshots):");
  });

  /**
   * The dormant row carries the SAME marker the saved surface uses, so the two
   * staffing blocks stay readable side by side — and the `config:` line still
   * says "validator off", because dormant assignments are not dispatched.
   */
  it("marks a disabled cohort's rows dormant without claiming it runs them", async () => {
    const host = makeHost(() => jsonResponse(OUTLINE_BODY));
    const result = await runCli(["workflow", "live", "get"], baseEnv, host);

    const staffing = result.stdout
      .split("staffing (snapshots):\n")[1]
      ?.split("\n")
      .filter((line) => line.startsWith("  "));

    const dormant = staffing?.find((line) => line.includes("dormant-security"));
    expect(dormant).toContain("global:house-reviewer@3");
    expect(dormant).toContain("#ffffffffffff");
    expect(dormant).toContain("(cohort disabled)");
    // Enabled rows carry no marker.
    expect(staffing?.[1]).not.toContain("(cohort disabled)");
    // The runtime line is unchanged: nothing in this cohort is invoked.
    expect(result.stdout).toContain(
      "verify  codex gpt-5.4 high; validator off",
    );
  });

  it("renders the workflow-scope lane-merge selection when the projection carries it", async () => {
    const body = {
      ...OUTLINE_BODY,
      outline: {
        ...OUTLINE_BODY.outline,
        laneMergeValidation: {
          strategy: "final-only",
          commands: { mode: "project" },
        },
      },
    };
    const host = makeHost(() => jsonResponse(body));
    const result = await runCli(["workflow", "live", "get"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("laneMerge: final-only project");
  });

  it("renders an explicit lane-merge command list, and 'none' when empty", async () => {
    const withCommands = (commands: string[]) => ({
      ...OUTLINE_BODY,
      outline: {
        ...OUTLINE_BODY.outline,
        laneMergeValidation: {
          strategy: "every-merge",
          commands: { mode: "only", commands },
        },
      },
    });
    const hostOnly = makeHost(() =>
      jsonResponse(withCommands(["typecheck", "test"])),
    );
    const only = await runCli(["workflow", "live", "get"], baseEnv, hostOnly);
    expect(only.stdout).toContain("laneMerge: every-merge typecheck+test");

    const hostNone = makeHost(() => jsonResponse(withCommands([])));
    const none = await runCli(["workflow", "live", "get"], baseEnv, hostNone);
    expect(none.stdout).toContain("laneMerge: every-merge none");
  });

  it("omits the lane-merge line for projections without the snapshot", async () => {
    const host = makeHost(() => jsonResponse(OUTLINE_BODY));
    const result = await runCli(["workflow", "live", "get"], baseEnv, host);
    expect(result.stdout).not.toContain("laneMerge");
  });

  it("passes the endpoint JSON through the envelope with --json", async () => {
    const host = makeHost(() => jsonResponse(OUTLINE_BODY));
    const result = await runCli(
      ["workflow", "live", "get", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.section).toBe("outline");
    expect(parsed.outline.header.executionId).toBe("exec-7");
  });

  it("passes a --context selector through as a query param and renders the slice", async () => {
    const host = makeHost(() =>
      jsonResponse({
        ok: true,
        section: "context",
        context: { id: "impl", title: "Implement", tasks: [] },
      }),
    );
    const result = await runCli(
      ["workflow", "live", "get", "--context", "impl"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const url = new URL(host.requests[0]?.url ?? "");
    expect(url.pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/live-outline",
    );
    expect(url.searchParams.get("context")).toBe("impl");
    expect(result.stdout).toContain('"id": "impl"');
  });

  it("passes a --task selector through as a query param", async () => {
    const host = makeHost(() =>
      jsonResponse({
        ok: true,
        section: "task",
        task: { id: "impl-api", instructions: "do it" },
      }),
    );
    const result = await runCli(
      ["workflow", "live", "get", "--task", "impl-api"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").searchParams.get("task")).toBe(
      "impl-api",
    );
  });

  it("passes --full through and renders the JSON slice", async () => {
    const host = makeHost(() =>
      jsonResponse({ ok: true, section: "full", header: {}, contexts: [] }),
    );
    const result = await runCli(
      ["workflow", "live", "get", "--full"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").searchParams.get("full")).toBe(
      "true",
    );
  });

  it("passes --config <ctx> through as ?config= and renders the full-config slice", async () => {
    const host = makeHost(() =>
      jsonResponse({
        ok: true,
        section: "config",
        config: {
          contextId: "impl",
          implementer: {
            id: "implementer",
            profile: { tier: "builtin", id: "general-implementer" },
            agent: {
              backend: "claude",
              model: "opus",
              reasoningEffort: "medium",
            },
          },
          contextValidator: { enabled: false, assignments: [] },
          scriptValidator: { commands: ["pre-merge"] },
          humanApprovalGate: { enabled: false },
          askUserQuestions: { enabled: false },
          iterationPolicy: { maxIterations: 20 },
          circuitBreaker: {},
          mutability: { allowAgentTaskAdd: false },
          collaboration: null,
        },
      }),
    );
    const result = await runCli(
      ["workflow", "live", "get", "--config", "impl"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    // doc 06: `--config <id>` maps to the endpoint's `?config=<id>` selector.
    expect(
      new URL(host.requests[0]?.url ?? "").searchParams.get("config"),
    ).toBe("impl");
    // The full resolved config slice is rendered (not the compact outline block).
    expect(result.stdout).toContain('"contextId": "impl"');
    expect(result.stdout).toContain('"iterationPolicy"');
    expect(result.stdout).toContain('"mutability"');
  });

  it("exits 2 without a request when selectors are combined", async () => {
    const host = makeHost(() => jsonResponse(OUTLINE_BODY));
    const result = await runCli(
      ["workflow", "live", "get", "--context", "impl", "--task", "impl-api"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("keeps rendering the outline when a row's schema summary is unreadable", async () => {
    const host = makeHost(() =>
      jsonResponse({
        ...OUTLINE_BODY,
        outline: {
          ...OUTLINE_BODY.outline,
          contexts: OUTLINE_BODY.outline.contexts.map((context) =>
            context.id === "verify"
              ? { ...context, outputSchema: { renamedField: 2 } }
              : context,
          ),
        },
      }),
    );
    const result = await runCli(["workflow", "live", "get"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    // The table still renders; only the decoration degrades.
    expect(result.stdout).toContain("contexts:");
    expect(result.stdout).toContain("output schema: declared");
    expect(result.stdout).not.toContain('"executionId"');
  });

  it("exits 2 when --outputs is combined with another selector", async () => {
    const host = makeHost(() => jsonResponse(OUTLINE_BODY));
    const result = await runCli(
      ["workflow", "live", "get", "--outputs", "--full"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("passes --charter through as ?charter=true and renders the charter markdown", async () => {
    const host = makeHost(() =>
      jsonResponse({
        ok: true,
        section: "charter",
        charter: {
          markdown:
            "# Workflow Charter\n\n## Mission\nAmended mission\n\n## Amendment log\n1. 2026-07-29 — changed mission: the mission drifted",
          amendments: [
            {
              seq: 1,
              amendedAt: "2026-07-29T10:00:00.000Z",
              source: "cli",
              rationale: "the mission drifted",
              fieldsChanged: ["mission"],
              charterHash: "hash-1",
            },
          ],
          charterHash: "hash-1",
        },
      }),
    );
    const result = await runCli(
      ["workflow", "live", "get", "--charter"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(
      new URL(host.requests[0]?.url ?? "").searchParams.get("charter"),
    ).toBe("true");
    // The charter renders as its markdown document, not a JSON dump.
    expect(result.stdout).toContain("# Workflow Charter");
    expect(result.stdout).toContain("## Amendment log");
    expect(result.stdout).not.toContain('"markdown"');
  });

  it("exits 2 without a request when --charter is combined with another selector", async () => {
    const host = makeHost(() => jsonResponse(OUTLINE_BODY));
    const result = await runCli(
      ["workflow", "live", "get", "--charter", "--task", "impl-api"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("renders the header's amendment count when the charter has been amended", async () => {
    const host = makeHost(() =>
      jsonResponse({
        ...OUTLINE_BODY,
        outline: {
          ...OUTLINE_BODY.outline,
          header: {
            ...OUTLINE_BODY.outline.header,
            charterAmendmentCount: 2,
          },
        },
      }),
    );
    const result = await runCli(["workflow", "live", "get"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("charter amended ×2");
  });

  it("maps a 404 (no active execution) to exit 2", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { error: "Session does not have an active graph workflow execution" },
        404,
      ),
    );
    const result = await runCli(["workflow", "live", "get"], baseEnv, host);
    expect(result.exitCode).toBe(2);
  });
});

describe("cctl workflow live get --outputs (R7.2)", () => {
  const OUTPUTS_BODY = {
    ok: true,
    section: "outputs",
    outputs: [
      {
        contextId: "plan",
        title: "Plan",
        status: "completed",
        schema: { type: "object", fieldCount: 2 },
        capture: {
          kind: "captured",
          value: { verdict: "pass", notes: "all green" },
          capturedAt: "2026-07-30T10:00:00.000Z",
          iteration: 2,
          parse: { source: "fenced", repaired: true, repairAttempts: 1 },
        },
      },
      {
        contextId: "verify",
        title: "Verify",
        status: "pending",
        schema: { type: "object", fieldCount: 1 },
        capture: { kind: "pending" },
      },
    ],
  };

  it("maps --outputs to ?outputs=true", async () => {
    const host = makeHost(() => jsonResponse(OUTPUTS_BODY));
    const result = await runCli(
      ["workflow", "live", "get", "--outputs"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const url = new URL(host.requests[0]?.url ?? "");
    expect(url.pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/live-outline",
    );
    expect(url.searchParams.get("outputs")).toBe("true");
  });

  it("renders capture status, the payload, and its parse provenance", async () => {
    const host = makeHost(() => jsonResponse(OUTPUTS_BODY));
    const result = await runCli(
      ["workflow", "live", "get", "--outputs"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatchInlineSnapshot(`
      "outputs (2):
        plan    captured  output schema: object · 2 fields  iteration 2  captured 2026-07-30T10:00:00.000Z  parse fenced (repaired ×1)
          {
            "verdict": "pass",
            "notes": "all green"
          }
        verify  pending   output schema: object · 1 field
      "
    `);
  });

  it("says so when no context declares an output contract", async () => {
    const host = makeHost(() =>
      jsonResponse({ ok: true, section: "outputs", outputs: [] }),
    );
    const result = await runCli(
      ["workflow", "live", "get", "--outputs"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no context declares an outputSchema");
  });

  it("passes the outputs payload through the --json envelope", async () => {
    const host = makeHost(() => jsonResponse(OUTPUTS_BODY));
    const result = await runCli(
      ["workflow", "live", "get", "--outputs", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.section).toBe("outputs");
    expect(parsed.outputs[0].capture.value).toEqual({
      verdict: "pass",
      notes: "all green",
    });
  });

  it("falls back to JSON when the payload is not the expected shape", async () => {
    const host = makeHost(() =>
      jsonResponse({ ok: true, section: "outputs", outputs: "nope" }),
    );
    const result = await runCli(
      ["workflow", "live", "get", "--outputs"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"nope"');
  });
});

describe("cctl workflow live edit", () => {
  const opsFile = ".cc/temp/live-ops.json";
  const opsBody = JSON.stringify({
    executionId: "exec-7",
    baseLiveRevision: 4,
    operations: [{ type: "update-context", contextId: "impl", title: "Go" }],
  });

  it("exits 2 without a request when --file is missing", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["workflow", "live", "edit"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 without a request when the file cannot be read", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["workflow", "live", "edit", "--file", opsFile],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 without a request when the file is not valid JSON", async () => {
    const host = makeHost(() => jsonResponse({}), { [opsFile]: "{not json" });
    const result = await runCli(
      ["workflow", "live", "edit", "--file", opsFile],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("posts the parsed body with source cli and renders the applied count", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          applied: 1,
          liveRevision: 5,
          affectedContextIds: ["impl"],
          dryRun: false,
        }),
      { [opsFile]: opsBody },
    );
    const result = await runCli(
      ["workflow", "live", "edit", "--file", opsFile],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/runtime-edits",
    );
    const body = JSON.parse(request?.init.body ?? "{}");
    expect(body.source).toBe("cli");
    expect(body.executionId).toBe("exec-7");
    expect(body.baseLiveRevision).toBe(4);
    expect(body.dryRun).toBeUndefined();
    expect(result.stdout).toContain("applied 1 operation");
    expect(result.stdout).toContain("liveRev 5");
  });

  it("sets dryRun on the body with --dry-run", async () => {
    const host = makeHost(
      () =>
        jsonResponse({
          applied: 1,
          liveRevision: 4,
          affectedContextIds: ["impl"],
          dryRun: true,
        }),
      { [opsFile]: opsBody },
    );
    const result = await runCli(
      ["workflow", "live", "edit", "--file", opsFile, "--dry-run"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(host.requests[0]?.init.body ?? "{}");
    expect(body.dryRun).toBe(true);
  });

  it("maps a code-bearing rejection to exit 1 with the code and issues", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error: "live edit was rejected",
            code: "revision_conflict",
            currentLiveRevision: 6,
            issues: [{ path: "baseLiveRevision", message: "stale revision" }],
          },
          409,
        ),
      { [opsFile]: opsBody },
    );
    const result = await runCli(
      ["workflow", "live", "edit", "--file", opsFile],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("stale revision");
    const jsonResult = await runCli(
      ["workflow", "live", "edit", "--file", opsFile, "--json"],
      baseEnv,
      host,
    );
    expect(JSON.parse(jsonResult.stdout).code).toBe("revision_conflict");
  });

  it("maps a code-bearing invalid_edit (400) to exit 1", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error: "live edit was rejected",
            code: "invalid_edit",
            issues: [{ path: "operations.0", message: "unknown context" }],
          },
          400,
        ),
      { [opsFile]: opsBody },
    );
    const result = await runCli(
      ["workflow", "live", "edit", "--file", opsFile],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
  });

  it("maps a codeless 400 to exit 2", async () => {
    const host = makeHost(
      () =>
        jsonResponse({ error: "Invalid live edit request", issues: [] }, 400),
      { [opsFile]: opsBody },
    );
    const result = await runCli(
      ["workflow", "live", "edit", "--file", opsFile],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
  });

  it("maps a 404 to exit 2", async () => {
    const host = makeHost(
      () => jsonResponse({ error: "no active execution" }, 404),
      { [opsFile]: opsBody },
    );
    const result = await runCli(
      ["workflow", "live", "edit", "--file", opsFile],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
  });
});

describe("cctl workflow live pause / resume", () => {
  it("posts to the pause endpoint", async () => {
    const host = makeHost(() =>
      jsonResponse({ execution: { status: "paused" } }),
    );
    const result = await runCli(["workflow", "live", "pause"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/pause",
    );
  });

  it("posts to the resume endpoint", async () => {
    const host = makeHost(() =>
      jsonResponse({ execution: { status: "running" } }),
    );
    const result = await runCli(["workflow", "live", "resume"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/resume",
    );
  });

  it("renders a server 409 as exit 1 with the server message", async () => {
    const host = makeHost(() =>
      jsonResponse(
        { error: "Only running graph workflow executions can be paused" },
        409,
      ),
    );
    const result = await runCli(["workflow", "live", "pause"], baseEnv, host);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Only running");
  });
});
