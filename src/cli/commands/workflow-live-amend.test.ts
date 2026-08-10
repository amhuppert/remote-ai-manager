import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import { helpEntryFor } from "../help-registry";
import type { CliEnv, CliHost, FetchInit } from "../shared";

/**
 * `cctl workflow live amend` — the CLI half of the audited amendment. What is
 * proved here is the wire contract the route depends on: the additive operand
 * reaches `/graph-workflow/amend` with the rationale and the caller
 * conversation, and the deterministic local checks refuse before any network
 * call. Whether the amendment actually lands, records its hashes, and leaves the
 * approved candidate alone is proved end-to-end against real state in
 * `src/lib/specs/delivery-plan-amendment.integration.test.ts`.
 */

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  CC_CONVERSATION_ID: "conversation-7",
  CC_AGENT_BACKEND: "codex",
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

const OPS_FILE = ".cc/temp/live-ops.json";
const OPS_BODY = JSON.stringify({
  operations: [
    {
      type: "add-context",
      id: "verify-migration",
      title: "Verify the migration",
      acceptanceCriteria: "The migration round-trips.",
    },
    {
      type: "add-edge",
      id: "edge-impl-verify",
      sourceContextId: "impl",
      targetContextId: "verify-migration",
    },
  ],
});

const ACCEPTED = {
  amended: 2,
  liveRevision: 5,
  policyBasis: "pinned_allow_agent_task_add",
  addedContextIds: ["verify-migration"],
  addedTaskIds: [],
  addedEdgeIds: ["edge-impl-verify"],
  previousWorkingDefinitionHash: "sha256:aaa",
  workingDefinitionHash: "sha256:bbb",
};

describe("cctl workflow live amend", () => {
  it("is registered in the typed workflow help registry with its flags", () => {
    const node = helpEntryFor(["workflow", "live", "amend"]);
    expect(node).toBeDefined();
    expect(node?.flags.map((flag) => flag.name).sort()).toEqual([
      "file",
      "reason",
    ]);
    expect(node?.usage.join(" ")).toContain("--reason");
    expect(node?.usage.join(" ")).toContain("--file");
  });

  it("exits 2 without a request when --reason is missing", async () => {
    const host = makeHost(() => jsonResponse({}), { [OPS_FILE]: OPS_BODY });
    const result = await runCli(
      ["workflow", "live", "amend", "--file", OPS_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 without a request when --file is missing", async () => {
    const host = makeHost(() => jsonResponse({}));
    const result = await runCli(
      ["workflow", "live", "amend", "--reason", "because"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 without a request when the operand file is not valid JSON", async () => {
    const host = makeHost(() => jsonResponse({}), { [OPS_FILE]: "{not json" });
    const result = await runCli(
      ["workflow", "live", "amend", "--reason", "because", "--file", OPS_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("posts the operand with the rationale and the caller conversation", async () => {
    const host = makeHost(() => jsonResponse(ACCEPTED), {
      [OPS_FILE]: OPS_BODY,
    });
    const result = await runCli(
      [
        "workflow",
        "live",
        "amend",
        "--reason",
        "the migration needs its own verification context",
        "--file",
        OPS_FILE,
      ],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(0);
    const request = host.requests[0];
    expect(request?.init.method).toBe("POST");
    expect(new URL(request?.url ?? "").pathname).toBe(
      "/api/projects/cc/sessions/my-session/graph-workflow/amend",
    );
    expect(request?.init.headers?.["x-cc-conversation-id"]).toBe(
      "conversation-7",
    );
    expect(request?.init.headers?.["x-cc-agent-backend"]).toBe("codex");
    const body = JSON.parse(request?.init.body ?? "{}");
    expect(body.reason).toBe(
      "the migration needs its own verification context",
    );
    expect(body.operations).toHaveLength(2);
    expect(result.stdout).toContain("amended 2 operations");
    expect(result.stdout).toContain("liveRev 5");
    expect(result.stdout).toContain("+ context verify-migration");
    expect(result.stdout).toContain("+ edge edge-impl-verify");
    expect(result.stdout).toContain("sha256:aaa -> sha256:bbb");
  });

  it("lets --reason win over a reason inside the operand file", async () => {
    const host = makeHost(() => jsonResponse(ACCEPTED), {
      [OPS_FILE]: JSON.stringify({
        reason: "the file's stale reason",
        operations: JSON.parse(OPS_BODY).operations,
      }),
    });
    await runCli(
      [
        "workflow",
        "live",
        "amend",
        "--reason",
        "the real one",
        "--file",
        OPS_FILE,
      ],
      baseEnv,
      host,
    );
    const body = JSON.parse(host.requests[0]?.init.body ?? "{}");
    expect(body.reason).toBe("the real one");
  });

  it("maps a non-additive refusal to exit 1 with the code and the remedy", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error:
              "An amendment is additive only; it cannot carry remove-task.",
            code: "non_additive_operation",
            instruction: "Remove the non-additive entries…",
          },
          400,
        ),
      { [OPS_FILE]: OPS_BODY },
    );
    const result = await runCli(
      [
        "workflow",
        "live",
        "amend",
        "--reason",
        "because",
        "--file",
        OPS_FILE,
        "--json",
      ],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout) as { code?: string };
    expect(envelope.code).toBe("non_additive_operation");
  });

  it("maps a refusal on a settled run to exit 1 with its code", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          {
            error: 'Execution "exec-7" is paused; only a running execution…',
            code: "not_running",
            instruction: "Resume the run with `cctl workflow live resume`…",
          },
          409,
        ),
      { [OPS_FILE]: OPS_BODY },
    );
    const result = await runCli(
      [
        "workflow",
        "live",
        "amend",
        "--reason",
        "because",
        "--file",
        OPS_FILE,
        "--json",
      ],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stdout) as { code?: string };
    expect(envelope.code).toBe("not_running");
  });
});
