import { describe, expect, it } from "vitest";
import { runCli } from "../core";
import type { CliEnv, CliHost, FetchInit } from "../shared";

const baseEnv: CliEnv = {
  CC_SERVER_URL: "http://127.0.0.1:3000",
  CC_API_TOKEN: "env-token",
  CC_PROJECT: "cc",
  CC_SESSION: "my-session",
  CC_CONVERSATION_ID: "conv-1",
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
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

const QUESTIONS_FILE = "/tmp/questions.json";
const questionsPayload = {
  questions: [
    {
      id: "approach",
      question: "Which migration order?",
      options: [{ label: "Phases in order" }, { label: "Fast path" }],
    },
  ],
};

const registered = { ok: true, questionBatchId: "q_ab12" };

// Doc 03 §2.1: printed EXACTLY on success.
const SUCCESS_TEXT =
  "Question batch q_ab12 registered. The user has been notified.\n" +
  "End your turn now with a brief handoff note (what you asked, what you'll do with the answer).\n" +
  "The answer will arrive as your next user message.\n";

describe("cctl ask", () => {
  it("POSTs the --file payload to the conversation ask endpoint and prints the exact §2.1 message", async () => {
    const host = makeHost(() => jsonResponse(registered), {
      [QUESTIONS_FILE]: JSON.stringify(questionsPayload),
    });
    const result = await runCli(
      ["ask", "--file", QUESTIONS_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(SUCCESS_TEXT);
    const request = host.requests[0];
    expect(request).toBeDefined();
    if (!request) return;
    expect(new URL(request.url).pathname).toBe(
      "/api/projects/cc/sessions/my-session/conversations/conv-1/ask",
    );
    expect(request.init.method).toBe("POST");
    expect(request.init.headers["authorization"]).toBe("Bearer env-token");
    expect(JSON.parse(request.init.body ?? "{}")).toEqual(questionsPayload);
  });

  it("builds a single-question batch from --question/--option sugar", async () => {
    const host = makeHost(() => jsonResponse(registered));
    const result = await runCli(
      ["ask", "--question", "Which order?", "--option", "A", "--option", "B"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(host.requests[0]?.init.body ?? "{}")).toEqual({
      questions: [
        {
          question: "Which order?",
          options: [{ label: "A" }, { label: "B" }],
        },
      ],
    });
  });

  it("threads --multi-select, --header, and --context into the sugar question", async () => {
    const host = makeHost(() => jsonResponse(registered));
    await runCli(
      [
        "ask",
        "--question",
        "Pick any",
        "--option",
        "A",
        "--option",
        "B",
        "--multi-select",
        "--header",
        "Scope",
        "--context",
        "Implications differ.",
      ],
      baseEnv,
      host,
    );
    expect(JSON.parse(host.requests[0]?.init.body ?? "{}")).toEqual({
      questions: [
        {
          question: "Pick any",
          header: "Scope",
          context: "Implications differ.",
          options: [{ label: "A" }, { label: "B" }],
          multiSelect: true,
        },
      ],
    });
  });

  it("returns { ok, questionBatchId, instruction } with --json — instruction is NOT the hint field", async () => {
    const host = makeHost(() => jsonResponse(registered), {
      [QUESTIONS_FILE]: JSON.stringify(questionsPayload),
    });
    const result = await runCli(
      ["ask", "--file", QUESTIONS_FILE, "--json"],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.questionBatchId).toBe("q_ab12");
    expect(envelope.instruction).toBe(
      "End your turn now with a brief handoff note (what you asked, what you'll do with the answer). The answer will arrive as your next user message.",
    );
    expect("hint" in envelope).toBe(false);
  });

  it("maps 409 already-pending to exit 1 printing the pending batch id and end-turn guidance", async () => {
    const host = makeHost(
      () =>
        jsonResponse({ error: "question batch q_old99 already pending" }, 409),
      { [QUESTIONS_FILE]: JSON.stringify(questionsPayload) },
    );
    const result = await runCli(
      ["ask", "--file", QUESTIONS_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("q_old99");
    expect(result.stderr).toContain("you already asked — end your turn");
  });

  it("maps 403 autonomous to exit 1 printing the proceed-with-best-judgment text", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          { error: "autonomous conversation — proceed with best judgment" },
          403,
        ),
      { [QUESTIONS_FILE]: JSON.stringify(questionsPayload) },
    );
    const result = await runCli(
      ["ask", "--file", QUESTIONS_FILE],
      baseEnv,
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "autonomous conversation — proceed with best judgment",
    );
  });

  it("maps the 409 no-running-turn rejection to exit 1 with the server's reason", async () => {
    const host = makeHost(
      () =>
        jsonResponse(
          { error: "no turn is running — ask requires an in-progress turn" },
          409,
        ),
      { [QUESTIONS_FILE]: JSON.stringify(questionsPayload) },
    );
    const result = await runCli(
      ["ask", "--file", QUESTIONS_FILE],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no turn is running");
  });

  it("exits 2 when neither --file nor --question is given", async () => {
    const host = makeHost(() => jsonResponse(registered));
    const result = await runCli(["ask"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when both --file and --question are given", async () => {
    const host = makeHost(() => jsonResponse(registered), {
      [QUESTIONS_FILE]: JSON.stringify(questionsPayload),
    });
    const result = await runCli(
      ["ask", "--file", QUESTIONS_FILE, "--question", "Which?"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 when --question has no --option", async () => {
    const host = makeHost(() => jsonResponse(registered));
    const result = await runCli(["ask", "--question", "Which?"], baseEnv, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--option");
    expect(host.requests).toHaveLength(0);
  });

  it("exits 2 naming CC_CONVERSATION_ID when conversation identity is missing", async () => {
    const host = makeHost(() => jsonResponse(registered), {
      [QUESTIONS_FILE]: JSON.stringify(questionsPayload),
    });
    const env: CliEnv = { ...baseEnv };
    delete env["CC_CONVERSATION_ID"];
    const result = await runCli(["ask", "--file", QUESTIONS_FILE], env, host);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("CC_CONVERSATION_ID");
    expect(host.requests).toHaveLength(0);
  });

  it("rejects unknown flags with exit 2", async () => {
    const host = makeHost(() => jsonResponse(registered));
    const result = await runCli(
      ["ask", "--question", "Q?", "--option", "A", "--frob", "x"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--frob");
  });

  it("takes no positional arguments", async () => {
    const host = makeHost(() => jsonResponse(registered));
    const result = await runCli(
      ["ask", "stray", "--question", "Q?", "--option", "A"],
      baseEnv,
      host,
    );
    expect(result.exitCode).toBe(2);
    expect(host.requests).toHaveLength(0);
  });
});
