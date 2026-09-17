import { describe, expect, it } from "vitest";

import { runCcWithHost } from "../../testing/domain-runtime";
import type { CliEnv, CliHost, FetchInit } from "../../transport";

/**
 * `cctl workflow review` (#69 change 5). The assertions that matter here are
 * about what reaches the WIRE and what reaches the operator: the CLI must never
 * hash a plan itself, must refuse a changes-requested verdict with no artifact
 * before spending a request, and must hand back the reviewer conversation's
 * read commands verbatim.
 */

const PLAN_FILE = "/tmp/plan.json";
const FINDINGS_FILE = "/tmp/findings.md";
const REVIEWER = "conv-reviewer-1";
const HASH = `sha256:${"7c".repeat(32)}`;

const PLAN = { name: "X", definition: {}, layout: {}, expectedRevision: 3 };

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_CONVERSATION_ID: "conv-me",
};

const files: Record<string, string> = {
  [PLAN_FILE]: JSON.stringify(PLAN),
  [FINDINGS_FILE]: "Context 2 carries two unrelated outcomes.\n",
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

function reviewedStatus(overrides: Record<string, unknown> = {}) {
  return {
    status: {
      state: "changes_requested",
      definitionHash: HASH,
      reviewerConversationId: REVIEWER,
      reviewedAt: "2026-08-18T12:00:00.000Z",
      findings: "Context 2 carries two unrelated outcomes.",
      reviewer: {
        conversationId: REVIEWER,
        resolved: true,
        note: null,
        commands: [
          {
            name: "compaction-command",
            command: `cctl conversation compaction get ${REVIEWER} --json`,
          },
          {
            name: "read-command",
            command: `cctl conversation read ${REVIEWER} --outline`,
          },
        ],
      },
      ...overrides,
    },
  };
}

function bodyOf(req: RecordedRequest | undefined): Record<string, unknown> {
  const raw = req?.init.body;
  return typeof raw === "string"
    ? (JSON.parse(raw) as Record<string, unknown>)
    : {};
}

describe("cctl workflow review (status mode)", () => {
  it("posts the whole plan to the status route and prints the verdict, findings, and reader commands", async () => {
    const host = makeHost(() => jsonResponse(reviewedStatus()));
    const result = await runCcWithHost(
      ["workflow", "review", "get", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/workflows/reviews/status",
    );
    // The plan travels whole; the CLI computes no digest of its own.
    expect(bodyOf(request)).toEqual({ plan: PLAN });
    expect(JSON.stringify(bodyOf(request))).not.toContain("sha256:");

    expect(result.stdout).toContain(`Plan review: changes_requested`);
    expect(result.stdout).toContain(HASH);
    expect(result.stdout).toContain(
      "Context 2 carries two unrelated outcomes.",
    );
    expect(result.stdout).toContain(
      `cctl conversation compaction get ${REVIEWER} --json`,
    );
    expect(result.stdout).toContain(
      `cctl conversation read ${REVIEWER} --outline`,
    );
  });

  it("reports an unreviewed revision plainly and exits 0", async () => {
    const host = makeHost(() =>
      jsonResponse({ status: { state: "unreviewed", definitionHash: HASH } }),
    );
    const result = await runCcWithHost(
      ["workflow", "review", "get", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "No review has been recorded for this content.",
    );
    expect(result.stdout).toContain(HASH);
    expect(result.stdout).not.toContain("hint:");
  });

  it("carries the whole status, reader commands included, in the --json envelope", async () => {
    const host = makeHost(() => jsonResponse(reviewedStatus()));
    const result = await runCcWithHost(
      ["workflow", "review", "get", "--file", PLAN_FILE, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout).payload.data as {
      status: {
        state: string;
        findings: string;
        reviewer: { commands: Array<{ command: string }> };
      };
      hint?: string;
    };
    expect(envelope.status.state).toBe("changes_requested");
    expect(envelope.status.findings).toContain("unrelated outcomes");
    expect(envelope.status.reviewer.commands.map((c) => c.command)).toEqual([
      `cctl conversation compaction get ${REVIEWER} --json`,
      `cctl conversation read ${REVIEWER} --outline`,
    ]);
  });

  it("surfaces the degraded reviewer note instead of failing", async () => {
    const host = makeHost(() =>
      jsonResponse(
        reviewedStatus({
          reviewer: {
            conversationId: REVIEWER,
            resolved: false,
            note: "reviewer conversation could not be resolved",
            commands: [
              {
                name: "read-command",
                command: `cctl conversation read ${REVIEWER} --outline`,
              },
            ],
          },
        }),
      ),
    );
    const result = await runCcWithHost(
      ["workflow", "review", "get", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("could not be resolved");
    expect(result.stdout).toContain(
      `cctl conversation read ${REVIEWER} --outline`,
    );
  });
});

describe("cctl workflow review (record mode)", () => {
  const receipt = {
    id: "review-1",
    definitionHash: HASH,
    verdict: "changes_requested",
    reviewerConversationId: "conv-me",
    reviewedAt: "2026-08-18T12:00:00.000Z",
  };

  it("records a changes-requested verdict with the findings file text, mapping the flag onto the stored enum", async () => {
    const host = makeHost(() => jsonResponse(receipt, 201));
    const result = await runCcWithHost(
      [
        "workflow",
        "review",
        "record",
        "--file",
        PLAN_FILE,
        "--verdict",
        "changes-requested",
        "--findings-file",
        FINDINGS_FILE,
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/workflows/reviews",
    );
    const body = bodyOf(request);
    expect(body["verdict"]).toBe("changes_requested");
    expect(body["findings"]).toContain("unrelated outcomes");
    // Reviewer identity defaults from the CLI's own conversation.
    expect(body["reviewerConversationId"]).toBe("conv-me");
    expect(result.stdout).toContain("Recorded changes_requested review");
  });

  it("records an approved verdict with no findings", async () => {
    const host = makeHost(() =>
      jsonResponse({ ...receipt, verdict: "approved" }, 201),
    );
    const result = await runCcWithHost(
      [
        "workflow",
        "review",
        "record",
        "--file",
        PLAN_FILE,
        "--verdict",
        "approved",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(bodyOf(host.requests[0])).not.toHaveProperty("findings");
    expect(result.stdout).toContain("Recorded approved review");
    expect(result.stdout).not.toContain("hint:");
  });

  it("refuses a changes-requested verdict with no findings, before any request", async () => {
    const host = makeHost(() => jsonResponse(receipt, 201));
    const result = await runCcWithHost(
      [
        "workflow",
        "review",
        "record",
        "--file",
        PLAN_FILE,
        "--verdict",
        "changes-requested",
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--findings");
    expect(host.requests).toHaveLength(0);
  });

  it("refuses when no reviewer identity is available, naming --reviewer", async () => {
    const host = makeHost(() => jsonResponse(receipt, 201));
    const noConversation: CliEnv = {
      CC_SERVER_URL: baseEnv.CC_SERVER_URL,
      CC_API_TOKEN: baseEnv.CC_API_TOKEN,
      CC_PROJECT: baseEnv.CC_PROJECT,
    };
    const result = await runCcWithHost(
      [
        "workflow",
        "review",
        "record",
        "--file",
        PLAN_FILE,
        "--verdict",
        "approved",
      ],
      noConversation,
      host,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--reviewer");
    expect(host.requests).toHaveLength(0);
  });

  it("lets --reviewer override the conversation identity", async () => {
    const host = makeHost(() =>
      jsonResponse({ ...receipt, verdict: "approved" }, 201),
    );
    const result = await runCcWithHost(
      [
        "workflow",
        "review",
        "record",
        "--file",
        PLAN_FILE,
        "--verdict",
        "approved",
        "--reviewer",
        REVIEWER,
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(bodyOf(host.requests[0])["reviewerConversationId"]).toBe(REVIEWER);
  });
});

describe("review advisory on create and replace", () => {
  const item = { id: "wf-9", name: "Auth Setup", revision: 4 };

  it("prints one advisory line beside a create and still exits 0", async () => {
    const host = makeHost(() =>
      jsonResponse(
        {
          item,
          reviewStatus: {
            state: "approved",
            reviewerConversationId: REVIEWER,
            reviewedAt: "2026-08-18T12:00:00.000Z",
          },
        },
        201,
      ),
    );
    const result = await runCcWithHost(
      ["workflow", "create", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Review: approved`);
    expect(result.stdout).toContain("Saved Auth Setup");
  });

  it("creates an unreviewed plan successfully, saying so", async () => {
    const host = makeHost(() =>
      jsonResponse({ item, reviewStatus: { state: "unreviewed" } }, 201),
    );
    const result = await runCcWithHost(
      ["workflow", "create", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Saved Auth Setup");
    expect(result.stdout).toContain("Review: unreviewed");
  });

  it("replaces against a changes-requested verdict without refusing", async () => {
    const host = makeHost(() =>
      jsonResponse({
        item,
        reviewStatus: {
          state: "changes_requested",
          reviewerConversationId: REVIEWER,
          reviewedAt: "2026-08-18T12:00:00.000Z",
        },
      }),
    );
    const result = await runCcWithHost(
      ["workflow", "replace", "wf-9", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Saved Auth Setup");
    expect(result.stdout).toContain(`Review: changes_requested`);
  });

  it("carries the advisory in the --json envelope", async () => {
    const host = makeHost(() =>
      jsonResponse({ item, reviewStatus: { state: "unreviewed" } }, 201),
    );
    const result = await runCcWithHost(
      ["workflow", "create", "--file", PLAN_FILE, "--json"],
      baseEnv,
      host,
    );

    const envelope = JSON.parse(result.stdout).payload.data as {
      reviewStatus?: { state: string };
    };
    expect(envelope.reviewStatus?.state).toBe("unreviewed");
  });

  it("prints no advisory line when the server sends no review status", async () => {
    const host = makeHost(() => jsonResponse({ item }, 201));
    const result = await runCcWithHost(
      ["workflow", "create", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("plan review:");
  });
});

/**
 * The acknowledgement gate as the REFUSED CALLER sees it. A refusal that only
 * says "no" would leave an agent guessing; the two commands it needs next —
 * read the findings, then acknowledge — must both be copy-runnable off this
 * output, with this caller's own plan path already in them.
 */
describe("acknowledgement gate on create and replace", () => {
  const item = { id: "wf-9", name: "Auth Setup", revision: 4 };

  function gateRefusal(): Response {
    return jsonResponse(
      {
        error: `Plan revision ${HASH} has a changes-requested review this request did not acknowledge: read the findings, then either revise the plan or re-submit with acknowledgeReviewHash set to ${HASH}`,
        code: "review-changes-requested-unacknowledged",
        details: {
          definitionHash: HASH,
          verdict: "changes_requested",
          reviewerConversationId: REVIEWER,
          reviewedAt: "2026-08-18T12:00:00.000Z",
          findingsCommand: "cctl workflow review get --file <plan.json>",
        },
      },
      409,
    );
  }

  it("threads --acknowledge-review into the create request body", async () => {
    const host = makeHost(() =>
      jsonResponse({ item, reviewStatus: { state: "unreviewed" } }, 201),
    );
    const result = await runCcWithHost(
      ["workflow", "create", "--file", PLAN_FILE, "--acknowledge-review", HASH],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(bodyOf(host.requests[0])).toEqual({
      ...PLAN,
      acknowledgeReviewHash: HASH,
    });
  });

  it("threads --acknowledge-review into the replace request body", async () => {
    const host = makeHost(() => jsonResponse({ item }));
    const result = await runCcWithHost(
      [
        "workflow",
        "replace",
        "wf-9",
        "--file",
        PLAN_FILE,
        "--acknowledge-review",
        HASH,
      ],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(bodyOf(host.requests[0])["acknowledgeReviewHash"]).toBe(HASH);
  });

  it("sends no acknowledgement field when the flag is absent", async () => {
    const host = makeHost(() => jsonResponse({ item }, 201));
    await runCcWithHost(
      ["workflow", "create", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(bodyOf(host.requests[0])).not.toHaveProperty(
      "acknowledgeReviewHash",
    );
  });

  it("renders the create refusal with the expected hash and a runnable findings hint", async () => {
    const host = makeHost(() => gateRefusal());
    const result = await runCcWithHost(
      ["workflow", "create", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(HASH);
    expect(result.stderr).toContain(REVIEWER);
    expect(result.stderr).toContain("cctl workflow review get");
    expect(result.stderr).toContain("acknowledgeReviewHash");
  });

  it("renders the replace refusal the same way", async () => {
    const host = makeHost(() => gateRefusal());
    const result = await runCcWithHost(
      ["workflow", "replace", "wf-9", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(HASH);
    expect(result.stderr).toContain("cctl workflow review get");
    expect(result.stderr).toContain("acknowledgeReviewHash");
  });

  it("carries the code, details, and hint in the --json envelope", async () => {
    const host = makeHost(() => gateRefusal());
    const result = await runCcWithHost(
      ["workflow", "create", "--file", PLAN_FILE, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      error: {
        details: {
          serverCode: "review-changes-requested-unacknowledged",
          serverDetails: {
            definitionHash: HASH,
            verdict: "changes_requested",
            reviewerConversationId: REVIEWER,
            findingsCommand: "cctl workflow review get --file <plan.json>",
          },
        },
      },
    });
  });

  it("preserves other typed semantic refusals without inventing review guidance", async () => {
    const host = makeHost(() =>
      jsonResponse({ error: "workflow not found", code: "not_found" }, 404),
    );
    const result = await runCcWithHost(
      ["workflow", "replace", "wf-9", "--file", PLAN_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("workflow not found");
    expect(result.stderr).not.toContain("--acknowledge-review");
  });
});
