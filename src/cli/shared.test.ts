import { describe, expect, it } from "vitest";
import {
  checkFlags,
  cliRequest,
  failure,
  failureFromRequest,
  failureFromRequestNotFoundAsUsage,
  render,
  resolveConversationContext,
  resolveLaneContext,
  resolveProjectContext,
  resolveProseArg,
  resolveSessionContext,
  withClientReminder,
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

describe("withClientReminder — client advisories reach both modes", () => {
  const rendered = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });

  it("keeps the tier order, inserting the reminder ahead of the hint", () => {
    const merged = withClientReminder(
      rendered("started run-1\nhint: watch it with `cctl agent status`\n"),
      false,
      "keep payloads under .cc/temp/",
    );
    expect(merged.stdout).toBe(
      "started run-1\n" +
        "reminder: keep payloads under .cc/temp/\n" +
        "hint: watch it with `cctl agent status`\n",
    );
  });

  it("appends to the existing reminders of a JSON envelope", () => {
    const merged = withClientReminder(
      rendered(
        `${JSON.stringify({ ok: true, reminders: ["server said so"] })}\n`,
      ),
      true,
      "keep payloads under .cc/temp/",
    );
    const parsed = JSON.parse(merged.stdout) as JsonEnvelope;
    expect(parsed.reminders).toEqual([
      "server said so",
      "keep payloads under .cc/temp/",
    ]);
  });

  // A --json result whose stdout is not an envelope must not be corrupted: the
  // advisory falls back to stderr rather than breaking the parse.
  it("never writes prose into unparseable --json stdout", () => {
    const merged = withClientReminder(rendered("not json\n"), true, "advice");
    expect(merged.stdout).toBe("not json\n");
    expect(merged.stderr).toBe("reminder: advice\n");
  });
});

describe("failure — instruction tier arbitration (same policy as render)", () => {
  const both = [
    { mode: "text", json: false },
    { mode: "json", json: true },
  ] as const;

  for (const { mode, json } of both) {
    it(`${mode} mode: an instruction suppresses the hint`, () => {
      const result = failure({
        exitCode: 1,
        message: "the plan was refused",
        instruction: "Fix the failing criterion, then propose again.",
        hint: "run `cctl spec status`",
        json,
      });
      const rendered = json ? result.stdout : result.stderr;
      expect(rendered).not.toContain("hint:");
      expect(rendered).toContain(
        "Fix the failing criterion, then propose again.",
      );
      if (json) {
        const parsed = JSON.parse(result.stdout) as JsonEnvelope;
        expect(parsed.hint).toBeUndefined();
        expect(parsed.instruction).toBe(
          "Fix the failing criterion, then propose again.",
        );
      }
    });
  }

  it("text mode: orders message -> detail -> instruction -> reminders", () => {
    const result = failure({
      exitCode: 1,
      message: "the plan was refused",
      detail: "  name: Required",
      instruction: "Fix it, then propose again.",
      reminders: ["stay in your worktree"],
      hint: "run `cctl spec status`",
      json: false,
    });
    expect(result.stderr).toBe(
      "the plan was refused\n" +
        "  name: Required\n" +
        "instruction: Fix it, then propose again.\n" +
        "reminder: stay in your worktree\n",
    );
  });

  it("keeps the hint when no instruction is present", () => {
    const result = failure({
      exitCode: 1,
      message: "it broke",
      hint: "try doctor",
      json: false,
    });
    expect(result.stderr).toBe("it broke\nhint: try doctor\n");
  });
});

describe("hint tier contract — one line, whatever it was assembled from", () => {
  it("flattens a multi-line hint on the failure path", () => {
    const result = failure({
      exitCode: 1,
      message: "it broke",
      hint: "run `cctl doctor`\n  name: forged issue",
      json: false,
    });
    expect(result.stderr.split("\n").filter((line) => line !== "")).toEqual([
      "it broke",
      "hint: run `cctl doctor`\\n  name: forged issue",
    ]);
  });

  it("flattens a multi-line hint on the success path, in both modes", () => {
    const out = render(false, "body\n", {
      ok: true,
      hint: "first\nsecond",
    });
    expect(out).toBe("body\nhint: first\\nsecond\n");

    const parsed = JSON.parse(
      render(true, "body\n", { ok: true, hint: "first\nsecond" }),
    ) as JsonEnvelope;
    expect(parsed.hint).toBe("first\\nsecond");
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

describe("failureFromRequest — bounded issue rendering", () => {
  const manyIssues: RequestIssue[] = Array.from({ length: 9 }, (_, index) => ({
    path: `definition.tasks.${index}`,
    message: `issue ${index}`,
  }));

  it("caps the rendered issue lines and discloses the omission", () => {
    const result: Extract<CliRequestResult, { kind: "error" }> = {
      kind: "error",
      status: 422,
      error: "Workflow plan is invalid",
      issues: manyIssues,
    };
    const text = failureFromRequest(result, false);
    const located = text.stderr
      .split("\n")
      .filter((line) => line.startsWith("  "));
    expect(located).toHaveLength(6);
    expect(located.slice(0, 5)).toEqual([
      "  definition.tasks.0: issue 0",
      "  definition.tasks.1: issue 1",
      "  definition.tasks.2: issue 2",
      "  definition.tasks.3: issue 3",
      "  definition.tasks.4: issue 4",
    ]);
    expect(located[5]).toContain("…and 4 more");
    expect(located[5]).toContain("9");
  });

  it("keeps every issue in the JSON envelope", () => {
    const result: Extract<CliRequestResult, { kind: "error" }> = {
      kind: "error",
      status: 422,
      error: "Workflow plan is invalid",
      issues: manyIssues,
    };
    const parsed = JSON.parse(
      failureFromRequest(result, true).stdout,
    ) as JsonEnvelope;
    expect(parsed.issues).toEqual(manyIssues);
  });

  it("adds no overflow line at exactly the cap", () => {
    const result: Extract<CliRequestResult, { kind: "error" }> = {
      kind: "error",
      status: 422,
      error: "Workflow plan is invalid",
      issues: manyIssues.slice(0, 5),
    };
    const text = failureFromRequest(result, false);
    expect(text.stderr).not.toContain("more");
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

describe("checkFlags — the allowlist is the registry entry's own flags", () => {
  it("accepts a flag the named entry declares", () => {
    expect(
      checkFlags({ description: "why" }, "docs register", false),
    ).toBeNull();
  });

  it("rejects a flag the named entry does not declare", () => {
    const denied = checkFlags({ frob: "x" }, "docs register", false);
    expect(denied?.exitCode).toBe(2);
    expect(denied?.stderr).toContain('unknown flag "--frob"');
  });

  it("rejects a sibling leaf's flag, so entries do not share an allowlist", () => {
    const denied = checkFlags({ description: "why" }, "docs list", false);
    expect(denied?.exitCode).toBe(2);
    expect(denied?.stderr).toContain('unknown flag "--description"');
  });

  it("accepts the global value flags on an entry that declares none", () => {
    expect(
      checkFlags({ session: "s", project: "p" }, "docs list", false),
    ).toBeNull();
  });

  it("throws when the path names no registry entry, even with no flags to check", () => {
    expect(() => checkFlags({}, "docs bogus", false)).toThrowError(
      /no entry for "docs bogus"/,
    );
  });

  it("accepts the file source a fileSource flag derives, with no entry edit", () => {
    expect(
      checkFlags(
        { "summary-file": ".cc/temp/s.md" },
        "workflow task complete",
        false,
      ),
    ).toBeNull();
  });

  it("still rejects a file source for a flag that declares no fileSource", () => {
    const denied = checkFlags({ "slug-file": "x" }, "workflow task add", false);
    expect(denied?.exitCode).toBe(2);
    expect(denied?.stderr).toContain('unknown flag "--slug-file"');
  });
});

describe("resolveProseArg — one prose value from a flag or a file (doc 09 §7)", () => {
  const fileHost = (files: Record<string, string>): CliHost =>
    fakeHost({ readTextFile: async (p) => files[p] ?? null });

  it("returns the inline flag value when only the flag is present", async () => {
    const resolved = await resolveProseArg(
      { summary: "wrote the parser" },
      fakeHost(),
      "summary",
      false,
    );
    expect(resolved).toEqual({ ok: true, value: "wrote the parser" });
  });

  it("returns undefined when neither source is present, leaving the requirement to the command", async () => {
    const resolved = await resolveProseArg({}, fakeHost(), "summary", false);
    expect(resolved).toEqual({ ok: true, value: undefined });
  });

  it("reads the file source and strips the editor's trailing newline", async () => {
    const resolved = await resolveProseArg(
      { "summary-file": ".cc/temp/s.md" },
      fileHost({ ".cc/temp/s.md": "ran `bun test`; green\n" }),
      "summary",
      false,
    );
    expect(resolved).toEqual({ ok: true, value: "ran `bun test`; green" });
  });

  it("reads stdin through the host when the path is '-'", async () => {
    const resolved = await resolveProseArg(
      { "summary-file": "-" },
      fileHost({ "-": "piped body" }),
      "summary",
      false,
    );
    expect(resolved).toEqual({ ok: true, value: "piped body" });
  });

  it("refuses both sources at once with exit 2 before any request", async () => {
    const resolved = await resolveProseArg(
      { summary: "inline", "summary-file": ".cc/temp/s.md" },
      fileHost({ ".cc/temp/s.md": "from file" }),
      "summary",
      false,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.exitCode).toBe(2);
    expect(resolved.result.stderr).toContain("--summary");
    expect(resolved.result.stderr).toContain("--summary-file");
  });

  it("fails with exit 2 when the file cannot be read", async () => {
    const resolved = await resolveProseArg(
      { "summary-file": ".cc/temp/missing.md" },
      fileHost({}),
      "summary",
      false,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.exitCode).toBe(2);
    expect(resolved.result.stderr).toContain(".cc/temp/missing.md");
  });

  it("fails with exit 2 on an empty file rather than sending blank prose", async () => {
    const resolved = await resolveProseArg(
      { "summary-file": ".cc/temp/s.md" },
      fileHost({ ".cc/temp/s.md": "\n  \n" }),
      "summary",
      false,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.exitCode).toBe(2);
    expect(resolved.result.stderr).toContain("empty");
  });

  it("fails with exit 2 past the sanity byte cap", async () => {
    const oversized = "x".repeat(256 * 1024 + 1);
    const resolved = await resolveProseArg(
      { "summary-file": ".cc/temp/huge.md" },
      fileHost({ ".cc/temp/huge.md": oversized }),
      "summary",
      false,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.exitCode).toBe(2);
    expect(resolved.result.stderr).toContain("262144");
  });

  it("accepts a file exactly at the cap", async () => {
    const atCap = "x".repeat(256 * 1024);
    const resolved = await resolveProseArg(
      { "summary-file": ".cc/temp/big.md" },
      fileHost({ ".cc/temp/big.md": atCap }),
      "summary",
      false,
    );
    expect(resolved).toEqual({ ok: true, value: atCap });
  });

  it("emits the failure into the json envelope when --json is set", async () => {
    const resolved = await resolveProseArg(
      { summary: "inline", "summary-file": "-" },
      fakeHost(),
      "summary",
      true,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(JSON.parse(resolved.result.stdout).ok).toBe(false);
  });
});
