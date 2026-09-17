import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgentAuth } from "@/lib/agent-gateway/token";
import {
  createAskQuestionHandlers,
  type AskRouteDeps,
} from "@/lib/conversations/ask-route-handlers";
import {
  askQuestionItemSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";

import { runCcWithHost } from "../testing/domain-runtime";
import type { CliEnv, CliHost } from "../transport";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real ask route
 * handlers in-process, with the real token gate. Proves the CLI's request
 * shape parses on the server, the server's success/409/403 bodies map to the
 * documented output and exit codes, and the ASK_QUESTION event is what
 * ultimately fires.
 */

const PROJECT_NAME = "cc";
const PROJECT_PATH = "/repos/cc";
const SESSION = "sess";
const CONVERSATION_ID = "conv-contract";
const TOKEN = "contract-token";

const ts = "2025-01-01T00:00:00.000Z";

function conv(overrides: Partial<ConversationState> = {}): ConversationState {
  return makeConversationState({
    id: CONVERSATION_ID,
    status: "running",
    promptCount: 1,
    createdAt: ts,
    lastActivityAt: ts,
    ...overrides,
  });
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cctl-ask-"));
  await writeFile(path.join(dir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeHost(
  conversation: ConversationState,
  files: Record<string, string> = {
    ".cc/temp/question.json": JSON.stringify({
      questions: [
        { question: "Which order?", options: [{ label: "A" }, { label: "B" }] },
      ],
    }),
  },
): CliHost & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => true);
  const deps: AskRouteDeps = {
    auth: createAgentAuth({ configDir: dir }),
    async resolveProjectPath(name) {
      return name === PROJECT_NAME ? PROJECT_PATH : null;
    },
    async getSession(projectPath, sessionName) {
      return projectPath === PROJECT_PATH && sessionName === SESSION
        ? { conversations: [conversation] }
        : null;
    },
    registerConversationQuestion: send,
    async resolveLaneAskPermission() {
      return { allowed: false };
    },
    generateQuestionBatchId: () => "q_contract1",
    log: createCapturingLogger(),
  };
  const handlers = createAskQuestionHandlers(deps);

  return {
    send,
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      // api projects <name> sessions <session> conversations <id> ask
      const params = Promise.resolve({
        name: decodeURIComponent(segments[2] ?? ""),
        session: decodeURIComponent(segments[4] ?? ""),
        conversationId: decodeURIComponent(segments[6] ?? ""),
      });
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      return handlers.POST(request, { params });
    },
    async readTextFile(filePath) {
      return files[filePath] ?? null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: os.platform(),
    homedir: os.homedir(),
  };
}

function makeEnv(overrides: CliEnv = {}): CliEnv {
  return {
    CC_SERVER_URL: "http://127.0.0.1:4999",
    CC_API_TOKEN: TOKEN,
    CC_PROJECT: PROJECT_NAME,
    CC_SESSION: SESSION,
    CC_CONVERSATION_ID: CONVERSATION_ID,
    ...overrides,
  };
}

describe("cctl ask against the real ask handlers", () => {
  it("registers the batch, fires ASK_QUESTION with parsed questions, and prints the §2.1 message", async () => {
    const host = makeHost(conv());
    const result = await runCcWithHost(
      ["ask", "--file", ".cc/temp/question.json"],
      makeEnv(),
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("q_contract1");
    expect(result.stdout).toContain("End your turn now");

    expect(host.send).toHaveBeenCalledWith(
      PROJECT_PATH,
      SESSION,
      CONVERSATION_ID,
      expect.objectContaining({
        questionId: "q_contract1",
        questions: [
          expect.objectContaining({
            question: "Which order?",
            options: [
              expect.objectContaining({ label: "A" }),
              expect.objectContaining({ label: "B" }),
            ],
            multiSelect: false,
          }),
        ],
      }),
    );
  });

  it("maps the real single-batch 409 to exit 1 naming the pending batch", async () => {
    const host = makeHost(
      conv({
        status: "waiting_for_input",
        pendingQuestionId: "q_pending7",
        pendingQuestions: [
          askQuestionItemSchema.parse({
            question: "Earlier?",
            options: [{ label: "Yes" }],
          }),
        ],
      }),
    );
    const result = await runCcWithHost(
      ["ask", "--file", ".cc/temp/question.json"],
      makeEnv(),
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("q_pending7");
    expect(result.stderr).toContain("You already asked — end your turn");
    expect(host.send).not.toHaveBeenCalled();
  });

  it("maps the real autonomous 403 to exit 1 with proceed-with-best-judgment", async () => {
    const host = makeHost(conv({ role: "iteration" }));
    const result = await runCcWithHost(
      ["ask", "--file", ".cc/temp/question.json"],
      makeEnv(),
      host,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "autonomous conversation — proceed with best judgment",
    );
    expect(host.send).not.toHaveBeenCalled();
  });

  it("maps the real no-turn 409 to exit 1", async () => {
    const host = makeHost(conv({ status: "awaiting" }));
    const result = await runCcWithHost(
      ["ask", "--file", ".cc/temp/question.json"],
      makeEnv(),
      host,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("no turn is running");
  });

  it("exits 3 through the real token gate when the token is wrong", async () => {
    const host = makeHost(conv());
    const result = await runCcWithHost(
      ["ask", "--file", ".cc/temp/question.json"],
      makeEnv({ CC_API_TOKEN: "wrong" }),
      host,
    );
    expect(result.exitCode).toBe(3);
    expect(host.send).not.toHaveBeenCalled();
  });
});
