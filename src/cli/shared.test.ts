import { describe, expect, it } from "vitest";
import {
  cliRequest,
  failure,
  failureFromRequest,
  failureFromRequestNotFoundAsUsage,
  render,
  resolveConversationContext,
  resolveLaneContext,
  resolveProjectContext,
  resolveSessionContext,
  type CliEnv,
  type CliHost,
  type CliRequestResult,
  type GlobalFlags,
  type JsonEnvelope,
  type RequestIssue,
} from "./shared";

function fakeHost(overrides: Partial<CliHost> = {}): CliHost {
  return {
    fetch: async () => new Response("{}", { status: 200 }),
    readTextFile: async () => null,
    readFileBytes: async () => null,
    sleep: async () => {},
    platform: "darwin",
    homedir: "/home/test",
    ...overrides,
  };
}

function flagsWith(overrides: Partial<GlobalFlags> = {}): GlobalFlags {
  return { json: false, ...overrides };
}

const STANDARD_USAGE_HINT = "run 'cctl --help'";

/**
 * Every missing-identity failure from the context resolvers carries the standard
 * usage hint in both modes (doc 04 §5.2), keeps its message text, and exits 2.
 */
describe("context resolvers — missing-identity failures get the usage hint", () => {
  const host = fakeHost();

  const cases: Array<{
    name: string;
    message: string;
    run: (
      flags: GlobalFlags,
      env: CliEnv,
    ) => Promise<{
      ok: boolean;
      result?: { exitCode: number; stdout: string; stderr: string };
    }>;
    flags: Partial<GlobalFlags>;
    env: CliEnv;
  }> = [
    {
      name: "no server URL",
      message: "no server URL — pass --server or set CC_SERVER_URL",
      run: (f, e) => resolveProjectContext(f, e, host),
      flags: {},
      env: {},
    },
    {
      name: "no project",
      message: "no project — pass --project or set CC_PROJECT",
      run: (f, e) => resolveProjectContext(f, e, host),
      flags: { server: "http://s" },
      env: {},
    },
    {
      name: "no session",
      message: "no session — pass --session or set CC_SESSION",
      run: (f, e) => resolveSessionContext(f, e, host),
      flags: { server: "http://s", project: "p" },
      env: {},
    },
    {
      name: "no conversation",
      message:
        "no conversation — pass --conversation or set CC_CONVERSATION_ID",
      run: (f, e) => resolveConversationContext(f, e, host),
      flags: { server: "http://s", project: "p", session: "sn" },
      env: {},
    },
    {
      name: "no workflow execution id",
      message:
        "no workflow execution — set CC_WORKFLOW_EXECUTION_ID (lane conversations only)",
      run: (f, e) => resolveLaneContext(f, e, host),
      flags: { server: "http://s", project: "p", session: "sn" },
      env: {},
    },
    {
      name: "no workflow context id",
      message:
        "no workflow context — set CC_WORKFLOW_CONTEXT_ID (lane conversations only)",
      run: (f, e) => resolveLaneContext(f, e, host),
      flags: { server: "http://s", project: "p", session: "sn" },
      env: { CC_WORKFLOW_EXECUTION_ID: "exec-1" },
    },
  ];

  for (const c of cases) {
    it(`text mode: ${c.name} keeps message, exits 2, and gains the usage hint`, async () => {
      const outcome = await c.run(
        flagsWith({ ...c.flags, json: false }),
        c.env,
      );
      expect(outcome.ok).toBe(false);
      const result = outcome.result;
      if (!result) throw new Error("expected a failure result");
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(c.message);
      expect(result.stderr).toContain(`hint: ${STANDARD_USAGE_HINT}`);
    });

    it(`json mode: ${c.name} keeps error text and gains the usage hint`, async () => {
      const outcome = await c.run(flagsWith({ ...c.flags, json: true }), c.env);
      expect(outcome.ok).toBe(false);
      const result = outcome.result;
      if (!result) throw new Error("expected a failure result");
      expect(result.exitCode).toBe(2);
      const parsed = JSON.parse(result.stdout) as JsonEnvelope;
      expect(parsed.error).toBe(c.message);
      expect(parsed.hint).toContain(STANDARD_USAGE_HINT);
    });
  }
});

describe("render — reminders tier (tier 2)", () => {
  it("emits reminder lines after the body and before the hint (text mode)", () => {
    const out = render(false, "server ok\n", {
      ok: true,
      reminders: ["keep the build green", "stay in your worktree"],
      hint: "run 'cctl workflow start'",
    });
    expect(out).toBe(
      "server ok\n" +
        "reminder: keep the build green\n" +
        "reminder: stay in your worktree\n" +
        "hint: run 'cctl workflow start'\n",
    );
  });

  it("renders reminders with no hint (text mode)", () => {
    const out = render(false, "body\n", {
      ok: true,
      reminders: ["only reminder"],
    });
    expect(out).toBe("body\nreminder: only reminder\n");
  });

  it("passes reminders through the JSON envelope unchanged", () => {
    const out = render(true, "ignored\n", {
      ok: true,
      reminders: ["r1"],
      hint: "h",
    });
    const parsed = JSON.parse(out) as JsonEnvelope;
    expect(parsed.reminders).toEqual(["r1"]);
    expect(parsed.hint).toBe("h");
  });
});

describe("render — instruction tier (obey-first; suppresses the hint)", () => {
  it("suppresses the hint when an instruction is present (text mode, doc 01 §6)", () => {
    // The instruction's human phrasing lives in the caller's primary body; the
    // renderer's job is to ensure a "continue" hint never sits beside it.
    const out = render(
      false,
      "completed impl-1\nCONTEXT LIMIT REACHED — end your turn.\n",
      {
        ok: true,
        stopInstruction: "CONTEXT LIMIT REACHED — end your turn.",
        hint: "3 tasks remain",
      },
    );
    expect(out).toBe(
      "completed impl-1\nCONTEXT LIMIT REACHED — end your turn.\n",
    );
    expect(out).not.toContain("hint:");
  });

  it("still renders reminders before the (suppressed) hint slot", () => {
    const out = render(false, "completed impl-1\nend your turn\n", {
      ok: true,
      instruction: "end your turn",
      reminders: ["stay in your worktree"],
      hint: "3 tasks remain",
    });
    expect(out).toBe(
      "completed impl-1\n" +
        "end your turn\n" +
        "reminder: stay in your worktree\n",
    );
    expect(out).not.toContain("hint:");
  });

  it("carries the instruction in the JSON envelope", () => {
    const out = render(true, "ignored\n", {
      ok: true,
      instruction: "End your turn now.",
    });
    const parsed = JSON.parse(out) as JsonEnvelope;
    expect(parsed.instruction).toBe("End your turn now.");
  });

  it("strips the hint from the JSON envelope when an instruction is present", () => {
    // The caller may pass both (its remaining-count hint plus a rotation
    // stopInstruction); the renderer drops the hint so the two tiers never
    // co-occur in the structured envelope either (workflow.test.ts:778).
    const out = render(true, "ignored\n", {
      ok: true,
      remainingTaskCount: 2,
      stopInstruction: "end your turn",
      hint: "2 tasks remain",
    });
    const parsed = JSON.parse(out) as JsonEnvelope;
    expect(parsed.stopInstruction).toBe("end your turn");
    expect(parsed.hint).toBeUndefined();
    expect(parsed.remainingTaskCount).toBe(2);
  });

  it("renders the hint normally when no instruction is present", () => {
    const out = render(false, "completed impl-1\n", {
      ok: true,
      hint: "3 tasks remain",
    });
    expect(out).toBe("completed impl-1\nhint: 3 tasks remain\n");
  });
});

describe("failure — reminders tier ordering", () => {
  it("orders message -> detail -> reminders -> hint (text mode)", () => {
    const result = failure({
      exitCode: 1,
      message: "it broke",
      detail: "  path: nope",
      reminders: ["reminder one", "reminder two"],
      hint: "try doctor",
      json: false,
    });
    expect(result.stderr).toBe(
      "it broke\n" +
        "  path: nope\n" +
        "reminder: reminder one\n" +
        "reminder: reminder two\n" +
        "hint: try doctor\n",
    );
    expect(result.stdout).toBe("");
  });

  it("renders reminders with no hint present (text mode)", () => {
    const result = failure({
      exitCode: 1,
      message: "halted",
      reminders: ["end your turn"],
      json: false,
    });
    expect(result.stderr).toBe("halted\nreminder: end your turn\n");
  });

  it("carries reminders in the JSON failure envelope", () => {
    const result = failure({
      exitCode: 1,
      message: "halted",
      reminders: ["end your turn"],
      hint: "h",
      json: true,
    });
    const parsed = JSON.parse(result.stdout) as JsonEnvelope;
    expect(parsed).toMatchObject({
      ok: false,
      error: "halted",
      reminders: ["end your turn"],
      hint: "h",
    });
    // JSON mode keeps stderr to the message line only.
    expect(result.stderr).toBe("halted\n");
  });
});

describe("failureFromRequest — reminders threading", () => {
  it("threads reminders from a non-2xx error result (409 halt path)", () => {
    const result: Extract<CliRequestResult, { kind: "error" }> = {
      kind: "error",
      status: 409,
      error: "this workflow is halted",
      reminders: ["do not continue task work; end your turn"],
    };
    const text = failureFromRequest(result, false);
    expect(text.stderr).toBe(
      "this workflow is halted\n" +
        "reminder: do not continue task work; end your turn\n",
    );

    const jsonResult = failureFromRequest(result, true);
    const parsed = JSON.parse(jsonResult.stdout) as JsonEnvelope;
    expect(parsed.reminders).toEqual([
      "do not continue task work; end your turn",
    ]);
  });
});

describe("failure — issues/code in the JSON envelope, text unchanged", () => {
  it("carries structured issues in the JSON envelope", () => {
    const issues: RequestIssue[] = [
      { path: "name", message: "Required" },
      { path: "definition.tasks", message: "must not be empty" },
    ];
    const result = failure({
      exitCode: 2,
      message: "Workflow plan is invalid",
      detail: "  name: Required\n  definition.tasks: must not be empty",
      issues,
      json: true,
    });
    const parsed = JSON.parse(result.stdout) as JsonEnvelope;
    expect(parsed.error).toBe("Workflow plan is invalid");
    expect(parsed.issues).toEqual(issues);
  });

  it("carries a machine-readable code in the JSON envelope", () => {
    const result = failure({
      exitCode: 1,
      message: "no dev servers configured",
      code: "NO_DEV_SERVERS_CONFIGURED",
      json: true,
    });
    const parsed = JSON.parse(result.stdout) as JsonEnvelope;
    expect(parsed.code).toBe("NO_DEV_SERVERS_CONFIGURED");
  });

  it("produces byte-identical text output whether or not issues/code are present", () => {
    const base = {
      exitCode: 2,
      message: "Workflow plan is invalid",
      detail: "  name: Required",
      json: false,
    } as const;
    const withoutStructured = failure(base);
    const withStructured = failure({
      ...base,
      issues: [{ path: "name", message: "Required" }],
      code: "SOME_CODE",
    });
    expect(withStructured.stderr).toBe(withoutStructured.stderr);
    expect(withStructured.stdout).toBe(withoutStructured.stdout);
  });
});

describe("failureFromRequest — issues/code threading", () => {
  it("keeps one-issue-per-line text AND threads structured issues on 422", () => {
    const result: Extract<CliRequestResult, { kind: "error" }> = {
      kind: "error",
      status: 422,
      error: "Workflow plan is invalid",
      issues: [
        { path: "name", message: "Required" },
        { path: "definition", message: "must be an object" },
      ],
      code: "PLAN_INVALID",
    };

    const text = failureFromRequest(result, false);
    expect(text.stderr).toBe(
      "Workflow plan is invalid\n" +
        "  name: Required\n" +
        "  definition: must be an object\n",
    );

    const json = failureFromRequest(result, true);
    const parsed = JSON.parse(json.stdout) as JsonEnvelope;
    expect(parsed.error).toBe("Workflow plan is invalid");
    expect(parsed.issues).toEqual(result.issues);
    expect(parsed.code).toBe("PLAN_INVALID");
  });

  /**
   * The one-line contract belongs to the surface that renders lines, not to
   * every producer remembering to escape: a message is assembled from an
   * untrusted document (and partly by Zod), so a raw newline arriving in one
   * must not be able to render as a second, forged located issue.
   */
  it("keeps a newline-bearing message to one rendered line while the envelope keeps it raw", () => {
    const forged = "  name: this issue is fake";
    const result: Extract<CliRequestResult, { kind: "error" }> = {
      kind: "error",
      status: 422,
      error: "Workflow plan is invalid",
      issues: [{ path: "definition", message: `bad id "x\n${forged}"` }],
    };

    const text = failureFromRequest(result, false);
    const located = text.stderr
      .split("\n")
      .filter((line) => line.startsWith("  "));
    expect(located).toEqual([
      '  definition: bad id "x\\n  name: this issue is fake"',
    ]);

    // Structured output is unflattened — JSON quoting is already unambiguous.
    const json = failureFromRequest(result, true);
    const parsed = JSON.parse(json.stdout) as JsonEnvelope;
    expect(parsed.issues).toEqual(result.issues);
  });

  it("threads code on a non-validation error branch", () => {
    const result: Extract<CliRequestResult, { kind: "error" }> = {
      kind: "error",
      status: 500,
      error: "no dev servers configured",
      code: "NO_DEV_SERVERS_CONFIGURED",
    };
    const json = failureFromRequest(result, true);
    const parsed = JSON.parse(json.stdout) as JsonEnvelope;
    expect(parsed.code).toBe("NO_DEV_SERVERS_CONFIGURED");
    // Text output is unchanged: just the error line, no issues/code leakage.
    const text = failureFromRequest(result, false);
    expect(text.stderr).toBe("no dev servers configured\n");
  });
});

describe("failureFromRequestNotFoundAsUsage — structured fields on 404", () => {
  it("forwards a server code into the JSON envelope while exiting 2 and leaving text unchanged", () => {
    const result: Extract<CliRequestResult, { kind: "error" }> = {
      kind: "error",
      status: 404,
      error: "Conversation not found",
      code: "conversation_not_found",
    };
    const json = failureFromRequestNotFoundAsUsage(result, true);
    expect(json.exitCode).toBe(2);
    const parsed = JSON.parse(json.stdout) as JsonEnvelope;
    expect(parsed.code).toBe("conversation_not_found");
    expect(parsed.error).toBe("Conversation not found");
    // Text mode is byte-identical to the pre-change output: the message only.
    const text = failureFromRequestNotFoundAsUsage(result, false);
    expect(text.exitCode).toBe(2);
    expect(text.stderr).toBe("Conversation not found\n");
  });

  it("forwards structured issues on a 404 into the JSON envelope, text unchanged", () => {
    const result: Extract<CliRequestResult, { kind: "error" }> = {
      kind: "error",
      status: 404,
      error: "Not found",
      issues: [{ path: "conversationId", message: "unknown" }],
    };
    const json = failureFromRequestNotFoundAsUsage(result, true);
    const parsed = JSON.parse(json.stdout) as JsonEnvelope;
    expect(parsed.issues).toEqual([
      { path: "conversationId", message: "unknown" },
    ]);
    const text = failureFromRequestNotFoundAsUsage(result, false);
    expect(text.stderr).toBe("Not found\n");
  });

  it("delegates non-404 errors to failureFromRequest and still threads code", () => {
    const result: Extract<CliRequestResult, { kind: "error" }> = {
      kind: "error",
      status: 500,
      error: "boom",
      code: "SERVER_BOOM",
    };
    const json = failureFromRequestNotFoundAsUsage(result, true);
    expect(json.exitCode).toBe(1);
    const parsed = JSON.parse(json.stdout) as JsonEnvelope;
    expect(parsed.code).toBe("SERVER_BOOM");
  });
});

describe("classifyErrorBody — reminders coercion", () => {
  it("coerces a reminders string[] from a non-2xx body via cliRequest", async () => {
    const host = fakeHost({
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: "halted",
            code: "HALTED",
            reminders: ["stop now", 42, "and also this"],
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    });
    const result = await cliRequest(host, {
      server: "http://127.0.0.1:3000",
      token: null,
      tokenSource: null,
      method: "GET",
      path: "/api/x",
    });
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("expected error result");
    // Non-string entries are dropped, same defensive style as coerceIssues.
    expect(result.reminders).toEqual(["stop now", "and also this"]);
    expect(result.code).toBe("HALTED");
  });
});
