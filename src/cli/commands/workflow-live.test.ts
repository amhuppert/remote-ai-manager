import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import type { CliEnv, CliHost, FetchInit } from "../shared";
import {
  CONVERSATION_CAPABILITY_ENV_VAR,
  CONVERSATION_CAPABILITY_HEADER,
} from "@/lib/agent-gateway/conversation-capability";
import {
  LANE_CAPABILITY_ENV_VAR,
  LANE_CAPABILITY_HEADER,
} from "@/lib/agent-gateway/lane-capability";

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  [CONVERSATION_CAPABILITY_ENV_VAR]: "conversation-capability",
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
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "medium" },
          },
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
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
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
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "medium" },
          },
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
            modelSelection: {
              modelId: "sonnet",
              parameters: { effort: "medium" },
            },
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
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { reasoning: "high", fast: "false" },
          },
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
            modelSelection: {
              modelId: "gpt-5.4",
              parameters: { reasoning: "low", fast: "false" },
            },
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
  /**
   * A halted run says nothing about whether a repair agent is on it: the status
   * and the round COUNT read identically mid-turn and an hour after the agent
   * gave up. The header names the open round for that reason.
   */
  it("names the working plan-repair round in the header", async () => {
    const host = makeHost(() =>
      jsonResponse({
        ...OUTLINE_BODY,
        outline: {
          ...OUTLINE_BODY.outline,
          header: {
            ...OUTLINE_BODY.outline.header,
            status: "halted",
            planRepairRoundCount: 1,
            openPlanRepairRound: {
              seq: 1,
              contextId: "impl",
              startedAt: "2026-08-25T12:04:00.000Z",
              conversationId: "__plan_repair__:exec-7:impl:1",
            },
          },
        },
      }),
    );

    const result = await runCli(["workflow", "live", "get"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "plan-repair round 1 working impl (since 2026-08-25T12:04:00.000Z)",
    );
    // The history count would be the wrong answer to "is anything running?".
    expect(result.stdout).not.toContain("plan-repair ×1");
  });

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
        plan    claude opus effort=medium; validator general conversation claude sonnet effort=medium; script off
        impl    claude opus effort=medium; validator general conversation claude sonnet effort=medium; script typecheck+test; roles implementer all-except format, validator none; approval on
        verify  codex gpt-5.4 fast=false reasoning=high; validator off; script off
      staffing (snapshots):
        plan    implementer  implementer       builtin:general-implementer@2  #cccccccccccc  claude opus effort=medium
        plan    validator    general           builtin:general-reviewer@5     #eeeeeeeeeeee  conversation claude sonnet effort=medium
        impl    implementer  implementer       builtin:general-implementer@2  #cccccccccccc  claude opus effort=medium
        impl    validator    general           builtin:general-reviewer@5     #eeeeeeeeeeee  conversation claude sonnet effort=medium
        verify  implementer  implementer       project:house-implementer@7    #dddddddddddd  codex gpt-5.4 fast=false reasoning=high  focus "state-store"
        verify  validator    dormant-security  global:house-reviewer@3        #ffffffffffff  task codex gpt-5.4 fast=false reasoning=low  (cohort disabled)
      next write: baseLiveRevision 4
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
    expect(staffing?.[1]).toContain("conversation claude sonnet effort=medium");
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
      "verify  codex gpt-5.4 fast=false reasoning=high; validator off",
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

  it("--full past the stdout budget writes an artifact and prints its manifest", async () => {
    const blob = "y".repeat(80_000);
    const host = makeHost(() =>
      jsonResponse({
        ok: true,
        section: "full",
        header: {},
        contexts: [{ id: "impl", instructions: blob }],
      }),
    );
    const result = await runCli(
      ["workflow", "live", "get", "--full"],
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
    expect(JSON.parse(content ?? "").contexts[0].instructions).toBe(blob);
  });

  it("--full --json past the budget carries the manifest as named fields", async () => {
    const host = makeHost(() =>
      jsonResponse({
        ok: true,
        section: "full",
        header: {},
        contexts: [{ id: "impl", instructions: "y".repeat(80_000) }],
      }),
    );
    const result = await runCli(
      ["workflow", "live", "get", "--full", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.contexts).toBeUndefined();
    expect(envelope.storage).toBe("artifact");
    expect(envelope.artifact.reason).toBe("stdout_budget_exceeded");
    expect(envelope.artifact.format).toBe("json");
    expect(envelope.artifact.bytes).toBeGreaterThan(80_000);
    expect(envelope.artifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(host.writes.has(envelope.artifact.path)).toBe(true);
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
              modelSelection: {
                modelId: "opus",
                parameters: { effort: "medium" },
              },
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
    expect(request?.init.headers[CONVERSATION_CAPABILITY_HEADER]).toBe(
      "conversation-capability",
    );
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
    expect(request?.init.headers[CONVERSATION_CAPABILITY_HEADER]).toBe(
      "conversation-capability",
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
    expect(host.requests[0]?.init.headers[CONVERSATION_CAPABILITY_HEADER]).toBe(
      "conversation-capability",
    );
  });

  it("forwards a lane capability instead of inventing conversation authority", async () => {
    const host = makeHost(() =>
      jsonResponse({ execution: { status: "paused" } }),
    );
    const result = await runCli(
      ["workflow", "live", "pause"],
      {
        ...baseEnv,
        [CONVERSATION_CAPABILITY_ENV_VAR]: undefined,
        [LANE_CAPABILITY_ENV_VAR]: "lane-capability",
      },
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(host.requests[0]?.init.headers[LANE_CAPABILITY_HEADER]).toBe(
      "lane-capability",
    );
    expect(
      host.requests[0]?.init.headers[CONVERSATION_CAPABILITY_HEADER],
    ).toBeUndefined();
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

/**
 * The recovery verbs the orphan dead end lacked: before these, abort and clear
 * existed only as API routes, so an agent that stranded a run had to call them
 * raw (ticket #47 note 9e5ba960).
 */
describe("cctl workflow live abort", () => {
  it("posts the reason to the abort endpoint and claims no separate release step", async () => {
    const host = makeHost(() =>
      jsonResponse({ execution: { status: "aborted" } }),
    );
    const result = await runCli(
      ["workflow", "live", "abort", "--reason", "superseded"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/abort",
    );
    expect(JSON.parse(String(request?.init.body))).toEqual({
      reason: "superseded",
    });
    expect(request?.init.headers[CONVERSATION_CAPABILITY_HEADER]).toBe(
      "conversation-capability",
    );
    // `aborted` releases the lease on its own, and no release verb exists to
    // point at — a receipt naming one would send the operator nowhere.
    expect(result.stdout).not.toContain("cctl workflow live release");
  });

  it("reports the abort as having released the slot", async () => {
    const host = makeHost(() =>
      jsonResponse({ execution: { status: "aborted" }, released: true }),
    );
    const result = await runCli(
      ["workflow", "live", "abort", "--reason", "superseded", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      aborted: true,
      released: true,
    });
  });

  it("refuses abort without a reason before reaching the server", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["workflow", "live", "abort"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--reason");
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl workflow abandon", () => {
  const execution = {
    executionId: "exec-halted-7",
    status: "halted",
    origin: { kind: "one_off", planName: "Recovery run" },
    archived: true,
  };

  it("posts the execution id and reason with signed mutation identity", async () => {
    const host = makeHost(() => jsonResponse({ execution, abandoned: true }));
    const result = await runCli(
      [
        "workflow",
        "abandon",
        "exec-halted-7",
        "--reason",
        "superseded",
        "--json",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(new URL(host.requests[0]?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/abandon",
    );
    expect(host.requests[0]?.init.method).toBe("POST");
    expect(JSON.parse(host.requests[0]?.init.body ?? "{}")).toEqual({
      executionId: "exec-halted-7",
      reason: "superseded",
    });
    expect(host.requests[0]?.init.headers[CONVERSATION_CAPABILITY_HEADER]).toBe(
      "conversation-capability",
    );
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      abandoned: true,
      execution,
    });
  });

  it("requires an execution id and durable reason before making a request", async () => {
    for (const argv of [
      ["workflow", "abandon", "--reason", "superseded"],
      ["workflow", "abandon", "exec-halted-7"],
    ]) {
      const host = makeHost(() => jsonResponse({}));
      const result = await runCli(argv, baseEnv, host);
      expect(result.exitCode).toBe(2);
      expect(host.requests).toHaveLength(0);
    }
  });

  it("does not retain workflow live release as a dispatchable mutation", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(["workflow", "live", "release"], baseEnv, host);

    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});

describe("cctl workflow live ledger (D4 R16.2)", () => {
  const LOOP_DECISION = {
    loopGroupId: "refine",
    pass: 1,
    loopControlRevision: 0,
    templateVersion: 1,
    exitContextId: "refine__p1__judge",
    exitCaptureIteration: 1,
    verdict: "unsatisfied" as const,
    outcome: "materialized" as const,
    nextPass: 2,
    decidedAt: "2026-08-04T00:00:00.000Z",
  };
  const PASS_TWO_CONCLUDED = {
    ...LOOP_DECISION,
    pass: 2,
    exitContextId: "refine__p2__judge",
    verdict: "satisfied" as const,
    outcome: "concluded" as const,
    nextPass: null,
  };
  const PASS_TWO_AMENDED = {
    ...PASS_TWO_CONCLUDED,
    loopControlRevision: 1,
    verdict: "unsatisfied" as const,
    outcome: "materialized" as const,
    nextPass: 3,
  };

  /**
   * The shape an ACTIVATED loop really persists: activation pins the boundary
   * snapshot as an array of resolved upstream rows (empty when the loop has no
   * external inputs). A `null` here is the pre-activation shape only — reading
   * the ledger against it would let the CLI's wire mirror drift into rejecting
   * every normal running loop.
   */
  const BOUNDARY_INPUTS = [
    {
      contextId: "seed",
      title: "Seed",
      declared: true,
      schemaFields: [
        {
          name: "goal",
          type: "string",
          required: true,
          description: null,
        },
      ],
      output: {
        value: { goal: "tighten the summariser" },
        iteration: 1,
        capturedAt: "2026-08-04T00:00:00.000Z",
        parse: { source: "native" },
      },
      skipped: false,
    },
  ];

  function executionBody(
    loopStateOverrides: Record<string, unknown> = {},
  ): unknown {
    return {
      execution: {
        id: "exec-7",
        workingDefinition: {
          loopGroups: [{ id: "refine", maxPasses: 4 }],
        },
        loopStates: {
          refine: {
            loopGroupId: "refine",
            activation: "running",
            loopControlRevision: 1,
            passCount: 3,
            slotLedger: [],
            boundaryInputs: BOUNDARY_INPUTS,
            decisions: { "1": LOOP_DECISION, "2": PASS_TWO_AMENDED },
            passTemplateVersions: { "1": 1, "2": 1, "3": 1 },
            concludingExitContextId: null,
            activatedAt: "2026-08-04T00:00:00.000Z",
            settledAt: "2026-08-04T00:00:00.000Z",
            ...loopStateOverrides,
          },
        },
      },
    };
  }

  function decisionRow(
    seq: number,
    decision:
      | typeof LOOP_DECISION
      | typeof PASS_TWO_CONCLUDED
      | typeof PASS_TWO_AMENDED,
  ) {
    return {
      seq,
      occurredAt: decision.decidedAt,
      preReset: false,
      event: {
        type: "graph-workflow-loop-decision",
        projectName: "cc",
        sessionName: "my-session",
        executionId: "exec-7",
        ...decision,
      },
    };
  }

  function ledgerHost(loopStateOverrides: Record<string, unknown> = {}) {
    return makeHost((req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/graph-workflow/execution")) {
        return jsonResponse(executionBody(loopStateOverrides));
      }
      if (url.pathname.endsWith("/graph-workflow/events")) {
        // Ascending pages, so the CLI reads the log in the order it happened.
        return url.searchParams.get("cursor") === "2"
          ? jsonResponse({
              events: [decisionRow(3, PASS_TWO_AMENDED)],
              nextCursor: null,
            })
          : jsonResponse({
              events: [
                decisionRow(1, LOOP_DECISION),
                decisionRow(2, PASS_TWO_CONCLUDED),
              ],
              nextCursor: 2,
            });
      }
      return jsonResponse({ error: `unexpected ${url.pathname}` }, 404);
    });
  }

  it("walks the paginated reader and prints every decision beside the markers", async () => {
    const host = ledgerHost();
    const result = await runCli(["workflow", "live", "ledger"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    const eventRequests = host.requests.filter((req) =>
      new URL(req.url).pathname.endsWith("/graph-workflow/events"),
    );
    expect(eventRequests).toHaveLength(2);
    expect(new URL(eventRequests[0]?.url ?? "").searchParams.get("page")).toBe(
      "true",
    );
    expect(
      new URL(eventRequests[1]?.url ?? "").searchParams.get("cursor"),
    ).toBe("2");

    expect(result.stdout).toContain("refine");
    expect(result.stdout).toContain("running");
    expect(result.stdout).toContain("pass 3 of 4");
    // The superseded conclusion is history the blob no longer holds, and the
    // CLI reports it rather than only the current record.
    expect(result.stdout).toContain("satisfied");
    expect(result.stdout).toContain("superseded");
    expect(result.stdout).toContain("rev 1");
  });

  it("returns the derived ledger as JSON", async () => {
    const host = ledgerHost();
    const result = await runCli(
      ["workflow", "live", "ledger", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.loops).toHaveLength(1);
    expect(parsed.loops[0].loopGroupId).toBe("refine");
    expect(
      parsed.loops[0].decisions.map(
        (entry: { pass: number; loopControlRevision: number }) => [
          entry.pass,
          entry.loopControlRevision,
        ],
      ),
    ).toEqual([
      [1, 0],
      [2, 0],
      [2, 1],
    ]);
  });

  it("reads a loop whose activation pinned an empty boundary snapshot", async () => {
    // A loop with no external inputs pins `[]`, not null — the degenerate case
    // of the same production shape, and the one a permissive mirror must not
    // confuse with "no active execution".
    const host = ledgerHost({ boundaryInputs: [] });
    const result = await runCli(["workflow", "live", "ledger"], baseEnv, host);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("refine");
    expect(result.stdout).toContain("pass 3 of 4");
  });

  /**
   * A log longer than any single bounded walk. D9 bounds each PAGE; complete
   * history has to stay reachable, so the walk continues until the reader
   * reports exhaustion.
   */
  function longLogHost(pageCount: number) {
    return makeHost((req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/graph-workflow/execution")) {
        return jsonResponse(executionBody());
      }
      if (url.pathname.endsWith("/graph-workflow/events")) {
        const cursor = Number(url.searchParams.get("cursor") ?? "0");
        const page = cursor + 1;
        // Only the very first page carries decisions; every later page is
        // unrelated traffic, so reaching the LAST page is what proves the walk
        // is not silently bounded.
        const isLast = page >= pageCount;
        return jsonResponse({
          events:
            page === pageCount
              ? [decisionRow(page, PASS_TWO_AMENDED)]
              : [
                  {
                    seq: page,
                    occurredAt: "2026-08-04T00:00:00.000Z",
                    preReset: false,
                    event: { type: "graph-workflow-status", status: "running" },
                  },
                ],
          nextCursor: isLast ? null : page,
        });
      }
      return jsonResponse({ error: `unexpected ${url.pathname}` }, 404);
    });
  }

  it("walks past any fixed page cap until the reader reports exhaustion", async () => {
    const host = longLogHost(40);
    const result = await runCli(
      ["workflow", "live", "ledger", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const eventRequests = host.requests.filter((req) =>
      new URL(req.url).pathname.endsWith("/graph-workflow/events"),
    );
    expect(eventRequests).toHaveLength(40);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.complete).toBe(true);
    expect(parsed.resumeCursor).toBeNull();
    // The decision on the LAST page is in the ledger, marked against the blob's
    // current record rather than reported only "from current state".
    const passTwo = parsed.loops[0].decisions.filter(
      (entry: { pass: number }) => entry.pass === 2,
    );
    expect(passTwo).toHaveLength(1);
    expect(passTwo[0].markerOnly).toBe(false);
    expect(result.stdout).not.toContain("older decisions");
  });

  it("bounds a walk on request and names the cursor to resume from", async () => {
    const host = longLogHost(40);
    const result = await runCli(
      ["workflow", "live", "ledger", "--max-pages", "3", "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(
      host.requests.filter((req) =>
        new URL(req.url).pathname.endsWith("/graph-workflow/events"),
      ),
    ).toHaveLength(3);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.complete).toBe(false);
    expect(parsed.resumeCursor).toBe(3);
  });

  it("resumes a bounded walk from --cursor", async () => {
    const host = longLogHost(40);
    const result = await runCli(
      ["workflow", "live", "ledger", "--cursor", "3", "--max-pages", "2"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const eventRequests = host.requests.filter((req) =>
      new URL(req.url).pathname.endsWith("/graph-workflow/events"),
    );
    expect(
      eventRequests.map((req) => new URL(req.url).searchParams.get("cursor")),
    ).toEqual(["3", "4"]);
    expect(result.stdout).toContain("--cursor 5");
  });

  it("points at the resume read through the shared disclosure vocabulary", async () => {
    const host = longLogHost(40);
    const result = await runCli(
      ["workflow", "live", "ledger", "--max-pages", "2"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "next: cctl workflow live ledger --cursor 2",
    );
    expect(result.stdout).not.toContain("note:");
  });

  it("discloses a stalled walk without a resume pointer it cannot honour", async () => {
    const host = makeHost((req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/graph-workflow/execution")) {
        return jsonResponse(executionBody());
      }
      return jsonResponse({
        events: [decisionRow(1, LOOP_DECISION)],
        nextCursor: 1,
      });
    });

    const result = await runCli(["workflow", "live", "ledger"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("older decisions are not shown");
    expect(result.stdout).not.toContain("note:");
    expect(result.stdout).not.toContain("next:");
  });

  it("discloses a bounded walk even when no loop group has an entry", async () => {
    // A declared group with no persisted state yields no entry, but the walk
    // still ran — dropping its bound here would hide the omission entirely.
    const host = makeHost((req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/graph-workflow/execution")) {
        return jsonResponse({
          execution: {
            id: "exec-7",
            workingDefinition: { loopGroups: [{ id: "refine", maxPasses: 4 }] },
            loopStates: {},
          },
        });
      }
      return jsonResponse({ events: [], nextCursor: 9 });
    });

    const result = await runCli(
      ["workflow", "live", "ledger", "--max-pages", "1"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "next: cctl workflow live ledger --cursor 9",
    );
  });

  it("rejects a non-numeric --cursor before any network call", async () => {
    const host = ledgerHost();
    const result = await runCli(
      ["workflow", "live", "ledger", "--cursor", "abc"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--cursor");
    expect(host.requests).toHaveLength(0);
  });

  it("stops instead of spinning when the reader repeats a cursor", async () => {
    // A cursor that does not advance would otherwise walk forever; the walk
    // stops and says the history is incomplete rather than hanging.
    const host = makeHost((req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/graph-workflow/execution")) {
        return jsonResponse(executionBody());
      }
      return jsonResponse({
        events: [decisionRow(1, LOOP_DECISION)],
        nextCursor: 1,
      });
    });

    const result = await runCli(
      ["workflow", "live", "ledger", "--json"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    expect(
      host.requests.filter((req) =>
        new URL(req.url).pathname.endsWith("/graph-workflow/events"),
      ).length,
    ).toBeLessThanOrEqual(2);
    expect(JSON.parse(result.stdout).complete).toBe(false);
  });

  it("says so plainly when the execution declares no loops", async () => {
    const host = makeHost((req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/graph-workflow/execution")) {
        return jsonResponse({
          execution: { id: "exec-7", workingDefinition: {}, loopStates: {} },
        });
      }
      return jsonResponse({ events: [], nextCursor: null });
    });

    const result = await runCli(["workflow", "live", "ledger"], baseEnv, host);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no loop groups");
    // A loop-free execution must not walk the log at all.
    expect(
      host.requests.filter((req) =>
        new URL(req.url).pathname.endsWith("/graph-workflow/events"),
      ),
    ).toHaveLength(0);
  });

  it("exits 2 when the session has no active execution", async () => {
    const host = makeHost(() => jsonResponse({ execution: null }));
    const result = await runCli(["workflow", "live", "ledger"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      "no active graph workflow execution in this session",
    );
  });
});

describe("live write receipts name baseLiveRevision (#80 I-7, I-12)", () => {
  const opsFile = ".cc/temp/live-ops.json";
  const opsBody = JSON.stringify({
    executionId: "exec-7",
    baseLiveRevision: 4,
    operations: [{ type: "update-context", contextId: "impl", title: "Go" }],
  });

  it("names the token on the live outline the next edit is addressed from", async () => {
    const host = makeHost(() => jsonResponse(OUTLINE_BODY));
    const text = await runCli(["workflow", "live", "get"], baseEnv, host);
    const structured = await runCli(
      ["workflow", "live", "get", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("next write: baseLiveRevision 4");
    expect(JSON.parse(structured.stdout)).toMatchObject({
      baseLiveRevision: 4,
    });
  });

  it("names the token the next edit needs on the live edit receipt", async () => {
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
    const text = await runCli(
      ["workflow", "live", "edit", "--file", opsFile],
      baseEnv,
      host,
    );
    const structured = await runCli(
      ["workflow", "live", "edit", "--file", opsFile, "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("next write: baseLiveRevision 5");
    expect(JSON.parse(structured.stdout)).toMatchObject({
      baseLiveRevision: 5,
    });
  });

  it("renders the requires-pause reason and the pause/edit/resume act", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error: "live edit was rejected",
            code: "requires_pause",
            issues: [
              {
                path: "operations[0]",
                message:
                  "Structural edits require a quiescent execution; pause it first",
              },
            ],
            rationale:
              "structural edits apply atomically against a quiescent scheduler so no lane reads a half-applied definition",
            instruction:
              "pause, edit, resume: cctl workflow live pause, then this edit, then cctl workflow live resume",
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
    expect(result.stderr).toContain(
      "why: structural edits apply atomically against a quiescent scheduler so no lane reads a half-applied definition",
    );
    expect(result.stderr).toContain("instruction: pause, edit, resume");
  });

  // `--full` is header-bearing too, so it owes the same token as the default
  // outline — on both disclosure paths, since a spilled record is still the map
  // the next edit is addressed from.
  const fullBody = (instructions: string) => ({
    ok: true,
    section: "full",
    header: { ...OUTLINE_BODY.outline.header },
    contexts: [{ id: "impl", instructions }],
  });

  it("names the token on the inline --full projection", async () => {
    const host = makeHost(() => jsonResponse(fullBody("short")));
    const text = await runCli(
      ["workflow", "live", "get", "--full"],
      baseEnv,
      host,
    );
    const structured = await runCli(
      ["workflow", "live", "get", "--full", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("next write: baseLiveRevision 4");
    expect(JSON.parse(structured.stdout)).toMatchObject({
      baseLiveRevision: 4,
    });
  });

  it("names the token on the spilled --full manifest", async () => {
    const host = makeHost(() => jsonResponse(fullBody("y".repeat(80_000))));
    const text = await runCli(
      ["workflow", "live", "get", "--full"],
      baseEnv,
      host,
    );
    const structured = await runCli(
      ["workflow", "live", "get", "--full", "--json"],
      baseEnv,
      host,
    );

    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("artifact: .cc/temp/");
    expect(text.stdout).toContain("next write: baseLiveRevision 4");
    expect(JSON.parse(structured.stdout)).toMatchObject({
      storage: "artifact",
      baseLiveRevision: 4,
    });
  });
});
