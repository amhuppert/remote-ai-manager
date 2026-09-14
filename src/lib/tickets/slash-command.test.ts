import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { AppendNoticeInput } from "@/lib/prompt/transcript";
import type { TranscriptEntriesResult } from "@/lib/prompt/transcript";
import { _createTestDb } from "@/lib/state-store/state-db";
import {
  createTicketsRepo,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";
import type {
  EnsureConversationCompactionResult,
  LiveCompaction,
} from "./attachment-service";
import {
  createTicketContentStore,
  type TicketContentStore,
} from "./content-store";
import {
  boundFallbackMarkdown,
  buildTicketGenerationPrompt,
  createTicketCommandRunner,
  FALLBACK_CONTEXT_BUDGET_BYTES,
  resolveTicketGeneration,
  TICKET_COMMAND_JSON_SCHEMA,
  ticketCommandOutputSchema,
  type TicketCommandRunner,
  type TicketCommandRunnerDeps,
} from "./slash-command";

type Db = InstanceType<typeof Database>;

const PROJECT_NAME = "command-center";
const PROJECT_PATH = "/repos/command-center";
const SESSION_NAME = "feature-session";
const CONVERSATION_ID = "conv-1";

const USAGE = {
  costUsd: null,
  durationMs: null,
  contextTokens: null,
  contextWindowMax: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
};

function structuredResult(structuredOutput: unknown): TaskRunResult {
  return {
    kind: "structured",
    structuredOutput,
    text: "",
    usage: USAGE,
    backendRef: null,
    continuationDisposition: "retain",
  };
}

const VALID_OUTPUT = {
  title: "Fix flaky retry",
  description: "Retries fail under load.",
  workType: "bug",
};

let db: Db;
let base: string;
let repo: TicketsRepo;
let contentStore: TicketContentStore;
let events: SSEEvent[];
let notices: AppendNoticeInput[];
let taskRunInputs: ExecuteWorkflowTaskRunInput[];
let taskRunResult: TaskRunResult;
let backendRef: import("@/lib/shared/schemas").AgentSessionRef | null;
let liveCompaction: LiveCompaction | null;
let transcriptEntries: TranscriptEntriesResult;
let ensureResult: EnsureConversationCompactionResult;
let idSeq: number;
let projectDeletionPrecededOperation: boolean;
let deps: TicketCommandRunnerDeps;
let runner: TicketCommandRunner;

beforeEach(async () => {
  db = _createTestDb({ inMemory: true });
  db.prepare("INSERT INTO projects (root_path) VALUES (?)").run(PROJECT_PATH);
  base = await mkdtemp(path.join(tmpdir(), "cc-ticket-command-"));
  repo = createTicketsRepo(db, createWriteQueue());
  contentStore = createTicketContentStore({
    contentRoot: path.join(base, "ticket-content"),
    listTicketIdsForProject: (projectPath) => repo.listTicketIds(projectPath),
  });
  events = [];
  notices = [];
  taskRunInputs = [];
  taskRunResult = structuredResult(VALID_OUTPUT);
  backendRef = { backend: "claude", ref: "sdk-session" };
  liveCompaction = null;
  transcriptEntries = { entries: [], maxSeq: -1 };
  ensureResult = {
    ok: true,
    markdown: "## Compaction\nwhat happened so far",
    capturedAt: "2026-07-10T00:00:00.000Z",
  };
  idSeq = 0;
  projectDeletionPrecededOperation = false;
  deps = {
    repo,
    contentStore,
    runProjectTicketOperation: (_projectPath, operation) =>
      operation({ projectDeletionPrecededOperation }),
    async getConversation() {
      return { backendRef, transcriptPath: "/tmp/does-not-matter.jsonl" };
    },
    async readTranscriptEntries() {
      return transcriptEntries;
    },
    async getLiveCompaction() {
      return liveCompaction;
    },
    async ensureConversationCompaction() {
      return ensureResult;
    },
    async executeWorkflowTaskRun(input) {
      taskRunInputs.push(input);
      return taskRunResult;
    },
    async appendNotice(input) {
      notices.push(input);
    },
    publish(event) {
      events.push(event);
      return { delivered: true };
    },
    now() {
      return "2026-07-10T00:00:01.000Z";
    },
    generateId() {
      idSeq += 1;
      return `id-${idSeq}`;
    },
  };
  runner = createTicketCommandRunner(deps);
});

afterEach(async () => {
  db.close();
  await rm(base, { recursive: true, force: true });
});

function runInput(
  overrides: Partial<Parameters<TicketCommandRunner["run"]>[0]> = {},
) {
  return {
    projectPath: PROJECT_PATH,
    projectName: PROJECT_NAME,
    sessionName: SESSION_NAME,
    conversationId: CONVERSATION_ID,
    hint: "",
    ...overrides,
  };
}

async function snapshotFiles(): Promise<string[]> {
  try {
    return await readdir(path.join(base, "ticket-content"), {
      recursive: true,
    });
  } catch {
    return [];
  }
}

describe("buildTicketGenerationPrompt", () => {
  it("instructs judgment-only work and lists the work types", () => {
    const prompt = buildTicketGenerationPrompt({
      hint: "",
      fallbackContext: null,
    });
    expect(prompt).toContain("Do not run tools");
    for (const workType of [
      "feature",
      "bug",
      "research",
      "tech_debt",
      "performance",
    ]) {
      expect(prompt).toContain(workType);
    }
  });

  it("includes the user hint when present", () => {
    const prompt = buildTicketGenerationPrompt({
      hint: "focus on the retry bug",
      fallbackContext: null,
    });
    expect(prompt).toContain("focus on the retry bug");
  });

  it("embeds the fallback context block only when provided", () => {
    const withFallback = buildTicketGenerationPrompt({
      hint: "",
      fallbackContext: "prior discussion about retries",
    });
    expect(withFallback).toContain("prior discussion about retries");
    const withoutFallback = buildTicketGenerationPrompt({
      hint: "",
      fallbackContext: null,
    });
    expect(withoutFallback).not.toContain("conversation context below");
  });
});

describe("resolveTicketGeneration", () => {
  it("rejects error results with the error reason", () => {
    const resolved = resolveTicketGeneration({
      kind: "error",
      error: "backend exploded",
      aborted: false,
      usage: USAGE,
      backendRef: null,
      continuationDisposition: "retain",
    });
    expect(resolved).toMatchObject({ ok: false });
    if (!resolved.ok) expect(resolved.reason).toContain("backend exploded");
  });

  it("rejects text results (structured output required)", () => {
    const resolved = resolveTicketGeneration({
      kind: "text",
      text: "just prose",
      usage: USAGE,
      backendRef: null,
      continuationDisposition: "retain",
    });
    expect(resolved.ok).toBe(false);
  });

  it("rejects structured output that fails the schema", () => {
    const resolved = resolveTicketGeneration(
      structuredResult({ ...VALID_OUTPUT, workType: "chore" }),
    );
    expect(resolved.ok).toBe(false);
  });

  it("rejects an empty title after trimming", () => {
    const resolved = resolveTicketGeneration(
      structuredResult({ ...VALID_OUTPUT, title: "   " }),
    );
    expect(resolved.ok).toBe(false);
  });

  it("accepts valid output and trims fields", () => {
    const resolved = resolveTicketGeneration(
      structuredResult({
        title: "  Fix flaky retry  ",
        description: " Retries fail. ",
        workType: "bug",
      }),
    );
    expect(resolved).toEqual({
      ok: true,
      fields: {
        title: "Fix flaky retry",
        description: "Retries fail.",
        workType: "bug",
      },
    });
  });
});

describe("ticket command structured-output schema", () => {
  it("matches the canonical Zod contract without changing the established wire shape", () => {
    const derivedSchema = z.toJSONSchema(ticketCommandOutputSchema);
    delete derivedSchema.$schema;

    expect(TICKET_COMMAND_JSON_SCHEMA).toEqual(derivedSchema);
    expect(TICKET_COMMAND_JSON_SCHEMA).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        workType: {
          type: "string",
          enum: ["feature", "bug", "research", "tech_debt", "performance"],
        },
      },
      required: ["title", "description", "workType"],
      additionalProperties: false,
    });
  });
});

describe("boundFallbackMarkdown", () => {
  it("passes text under the budget through unchanged", () => {
    const result = boundFallbackMarkdown("short compaction", 1024);
    expect(result).toEqual({ markdown: "short compaction", truncated: false });
  });

  it("caps over-budget text at the byte budget with an elision marker", () => {
    const result = boundFallbackMarkdown("x".repeat(2_000), 1_000);
    expect(result.truncated).toBe(true);
    expect(result.markdown).toContain("[compaction truncated]");
    // The bounded body respects the budget; only the marker rides on top.
    const bodyBytes = new TextEncoder().encode(result.markdown).byteLength;
    expect(bodyBytes).toBeLessThanOrEqual(1_000 + 64);
  });

  it("never splits a multi-byte code point at the cut", () => {
    // "é" is 2 UTF-8 bytes; an odd budget lands mid-code-point.
    const result = boundFallbackMarkdown("é".repeat(1_000), 501);
    expect(result.truncated).toBe(true);
    expect(result.markdown).not.toContain("�");
  });
});

describe("createTicketCommandRunner", () => {
  it("does not recreate a project when deletion preceded the command", async () => {
    projectDeletionPrecededOperation = true;

    const outcome = await runner.run(runInput());

    expect(outcome).toEqual({
      status: "failed",
      reason: "project was deleted while the command was waiting",
      failureNoticePersisted: true,
    });
    expect(taskRunInputs).toEqual([]);
    expect(await repo.list({ sort: "updated" })).toEqual([]);
    expect(events).toEqual([]);
  });

  it("holds the project gate across generation, snapshot persistence, and confirmation", async () => {
    const phases: string[] = [];
    deps.runProjectTicketOperation = async (projectPath, operation) => {
      phases.push(`gate:${projectPath}:start`);
      const result = await operation({
        projectDeletionPrecededOperation: false,
      });
      phases.push(`gate:${projectPath}:end`);
      return result;
    };
    const execute = deps.executeWorkflowTaskRun;
    deps.executeWorkflowTaskRun = async (input) => {
      phases.push("generate");
      return execute(input);
    };
    const append = deps.appendNotice;
    deps.appendNotice = async (input) => {
      phases.push("notice");
      return append(input);
    };
    runner = createTicketCommandRunner(deps);

    const outcome = await runner.run(runInput());

    expect(outcome.status).toBe("created");
    expect(phases).toEqual([
      `gate:${PROJECT_PATH}:start`,
      "generate",
      "notice",
      `gate:${PROJECT_PATH}:end`,
    ]);
  });

  it.each(["claude", "cursor"] as const)(
    "creates the ticket from %s with a captured conversation and a success notice",
    async (backend) => {
      backendRef = { backend, ref: "agent-conversation" };
      const outcome = await runner.run(runInput({ hint: "retry bug" }));

      expect(outcome).toEqual({
        status: "created",
        identifier: "command-center#1",
        confirmationPersisted: true,
      });

      // Structured turn ran in the originating conversation with the schema.
      expect(taskRunInputs).toHaveLength(1);
      const turn = taskRunInputs[0]!;
      expect(
        conversationTargetStoreSessionName(turn.binding.address.target),
      ).toBe(SESSION_NAME);
      expect(turn.binding.address.target.conversationId).toBe(CONVERSATION_ID);
      expect(turn.outputFormat).toEqual({
        type: "json_schema",
        schema: TICKET_COMMAND_JSON_SCHEMA,
      });
      expect(turn.prompt).toContain("retry bug");
      // Native context: no fallback rendering embedded when a backendRef exists.
      expect(turn.prompt).not.toContain("## Compaction");

      // Read back through the real repo: ticket + attachment in one transaction.
      const detail = await repo.find(PROJECT_PATH, 1);
      expect(detail).not.toBeNull();
      expect(detail!.title).toBe("Fix flaky retry");
      expect(detail!.description).toBe("Retries fail under load.");
      expect(detail!.workType).toBe("bug");
      expect(detail!.status).toBe("not_started");
      expect(detail!.attachments).toHaveLength(1);
      const attachment = detail!.attachments[0]!;
      expect(attachment.payload).toMatchObject({
        kind: "conversation",
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
        snapshotCapturedAt: "2026-07-10T00:00:00.000Z",
        snapshotStatus: "captured",
      });

      // The compaction snapshot blob exists in the content store.
      if (attachment.payload.kind !== "conversation") {
        throw new Error("expected conversation payload");
      }
      if (attachment.payload.snapshotKey === null) {
        throw new Error("expected captured conversation snapshot");
      }
      const blob = await contentStore.read(attachment.payload.snapshotKey);
      expect(Buffer.from(blob).toString("utf8")).toBe(
        "## Compaction\nwhat happened so far",
      );

      // Deterministic success notice reports the identifier.
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        text: expect.stringContaining("command-center#1"),
        storeSessionName: SESSION_NAME,
      });

      // A created change event went out with the attachment counted.
      const created = events.find(
        (event) =>
          "type" in event &&
          event.type === "ticket-changed" &&
          "change" in event &&
          event.change === "created",
      );
      expect(created).toMatchObject({
        projectName: PROJECT_NAME,
        ticketNumber: 1,
        listItem: { attachmentCount: 1 },
      });
    },
  );

  it("uses the admitted complete model selection for ticket field generation", async () => {
    const modelSelection = {
      modelId: "gpt-5.6-sol",
      parameters: { fast: "true", reasoning: "ultra" },
    };

    await runner.run({ ...runInput(), modelSelection });

    expect(taskRunInputs).toHaveLength(1);
    expect(taskRunInputs[0]).toMatchObject({ modelSelection });
  });

  it("reports that fallback delivery is needed when the committed ticket notice cannot be persisted", async () => {
    deps.appendNotice = async () => {
      throw new Error("transcript unavailable");
    };
    runner = createTicketCommandRunner(deps);

    const outcome = await runner.run(runInput());

    expect(outcome).toEqual({
      status: "created",
      identifier: "command-center#1",
      confirmationPersisted: false,
    });
    expect(await repo.find(PROJECT_PATH, 1)).not.toBeNull();
  });

  it("maps project conversations (sessionName null) onto the project sentinel", async () => {
    const outcome = await runner.run(runInput({ sessionName: null }));

    expect(outcome.status).toBe("created");
    expect(
      conversationTargetStoreSessionName(
        taskRunInputs[0]!.binding.address.target,
      ),
    ).toBe("__project__");

    const detail = await repo.find(PROJECT_PATH, 1);
    expect(detail!.attachments[0]!.payload).toMatchObject({
      kind: "conversation",
      sessionName: null,
    });
    expect(notices[0]).toMatchObject({ storeSessionName: "__project__" });
  });

  it("falls back to the live compaction rendering when the backendRef is null", async () => {
    backendRef = null;
    liveCompaction = {
      markdown: "compacted history of the retry investigation",
      capturedAt: "2026-07-09T00:00:00.000Z",
      coveredEndSeq: 0,
    };

    await runner.run(runInput());

    expect(taskRunInputs[0]!.prompt).toContain(
      "compacted history of the retry investigation",
    );
  });

  it("uses the transcript instead of a compaction that does not cover its latest entry", async () => {
    backendRef = null;
    liveCompaction = {
      markdown: "stale compacted history",
      capturedAt: "2026-07-09T00:00:00.000Z",
      coveredEndSeq: 0,
    };
    transcriptEntries = {
      entries: [
        {
          seq: 1,
          entryId: null,
          timestamp: "2026-07-10T00:00:00.000Z",
          role: "user",
          content: [{ type: "text", text: "latest retry finding" }],
        },
      ],
      maxSeq: 1,
    };

    const outcome = await runner.run(runInput());

    expect(outcome.status).toBe("created");
    expect(taskRunInputs[0]!.prompt).toContain("latest retry finding");
    expect(taskRunInputs[0]!.prompt).not.toContain("stale compacted history");
  });

  it("bounds an oversized live compaction to the fallback context budget", async () => {
    backendRef = null;
    liveCompaction = {
      markdown: "z".repeat(FALLBACK_CONTEXT_BUDGET_BYTES + 20_000),
      capturedAt: "2026-07-09T00:00:00.000Z",
      coveredEndSeq: 0,
    };

    const outcome = await runner.run(runInput());

    expect(outcome.status).toBe("created");
    const prompt = taskRunInputs[0]!.prompt;
    expect(prompt).toContain("[compaction truncated]");
    // Whole prompt (scaffolding + bounded context) stays near the budget,
    // nowhere near the unbounded compaction size.
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(
      FALLBACK_CONTEXT_BUDGET_BYTES + 2_048,
    );
  });

  it("fails with a reason notice and persists nothing when the live-compaction read throws", async () => {
    backendRef = null;
    deps.getLiveCompaction = async () => {
      throw new Error("artifact store unavailable");
    };
    runner = createTicketCommandRunner(deps);

    const outcome = await runner.run(runInput());

    expect(outcome.status).toBe("failed");
    expect(taskRunInputs).toHaveLength(0);
    expect(await repo.list({ sort: "updated" })).toHaveLength(0);
    expect(await snapshotFiles()).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("artifact store unavailable");
    expect(notices[0]!.text).toContain("no ticket was created");
  });

  it("fails with a reason notice and persists nothing when the transcript read throws", async () => {
    backendRef = null;
    liveCompaction = null;
    deps.readTranscriptEntries = async () => {
      throw new Error("transcript unreadable");
    };
    runner = createTicketCommandRunner(deps);

    const outcome = await runner.run(runInput());

    expect(outcome.status).toBe("failed");
    expect(taskRunInputs).toHaveLength(0);
    expect(await repo.list({ sort: "updated" })).toHaveLength(0);
    expect(notices[0]!.text).toContain("transcript unreadable");
  });

  it("fails with a reason notice and persists nothing when the compaction trigger throws", async () => {
    deps.ensureConversationCompaction = async () => {
      throw new Error("compaction service crashed");
    };
    runner = createTicketCommandRunner(deps);

    const outcome = await runner.run(runInput());

    expect(outcome.status).toBe("failed");
    expect(await repo.list({ sort: "updated" })).toHaveLength(0);
    expect(await snapshotFiles()).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("compaction service crashed");
    expect(notices[0]!.text).toContain("no ticket was created");
    expect(events).toHaveLength(0);
  });

  it("falls back to bounded transcript rendering when there is no compaction", async () => {
    backendRef = null;
    liveCompaction = null;
    transcriptEntries = {
      entries: [
        {
          seq: 0,
          entryId: null,
          timestamp: "2026-07-09T00:00:00.000Z",
          role: "user",
          content: [
            { type: "text", text: "we found a flaky retry bug in the queue" },
          ],
        },
      ],
      maxSeq: 0,
    };

    await runner.run(runInput());

    expect(taskRunInputs[0]!.prompt).toContain(
      "we found a flaky retry bug in the queue",
    );
  });

  it("fails with a notice and persists nothing when the conversation is unknown", async () => {
    deps.getConversation = async () => null;
    runner = createTicketCommandRunner(deps);

    const outcome = await runner.run(runInput());

    expect(outcome.status).toBe("failed");
    expect(taskRunInputs).toHaveLength(0);
    expect(await repo.list({ sort: "updated" })).toHaveLength(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("no ticket was created");
  });

  it("fails with a notice and persists nothing when generation errors", async () => {
    taskRunResult = {
      kind: "error",
      error: "turn timed out",
      aborted: false,
      usage: USAGE,
      backendRef: null,
      continuationDisposition: "retain",
    };

    const outcome = await runner.run(runInput());

    expect(outcome.status).toBe("failed");
    expect(await repo.list({ sort: "updated" })).toHaveLength(0);
    expect(await snapshotFiles()).toHaveLength(0);
    expect(notices[0]!.text).toContain("turn timed out");
    expect(events).toHaveLength(0);
  });

  it("preserves the root failure when appending its notice also fails", async () => {
    taskRunResult = {
      kind: "error",
      error: "turn timed out",
      aborted: false,
      usage: USAGE,
      backendRef: null,
      continuationDisposition: "retain",
    };
    deps.appendNotice = async () => {
      throw new Error("transcript unavailable");
    };
    runner = createTicketCommandRunner(deps);

    const outcome = await runner.run(runInput());

    expect(outcome).toEqual({
      status: "failed",
      reason: "generation turn failed: turn timed out",
      failureNoticePersisted: false,
    });
    expect(await repo.list({ sort: "updated" })).toHaveLength(0);
  });

  it("fails with a notice and persists nothing when structured output is invalid", async () => {
    taskRunResult = structuredResult({ nope: true });

    const outcome = await runner.run(runInput());

    expect(outcome.status).toBe("failed");
    expect(await repo.list({ sort: "updated" })).toHaveLength(0);
    expect(await snapshotFiles()).toHaveLength(0);
  });

  it("fails with a notice and persists nothing when compaction cannot be ensured", async () => {
    ensureResult = { ok: false, reason: "compaction generation failed" };

    const outcome = await runner.run(runInput());

    expect(outcome.status).toBe("failed");
    expect(await repo.list({ sort: "updated" })).toHaveLength(0);
    expect(await snapshotFiles()).toHaveLength(0);
    expect(notices[0]!.text).toContain("compaction generation failed");
  });

  it("fails with a notice and persists nothing when the snapshot capture throws", async () => {
    deps.contentStore = {
      ...contentStore,
      captureText: async () => {
        throw new Error("disk full");
      },
    };
    runner = createTicketCommandRunner(deps);

    const outcome = await runner.run(runInput());

    expect(outcome.status).toBe("failed");
    expect(await repo.list({ sort: "updated" })).toHaveLength(0);
    expect(notices[0]!.text).toContain("disk full");
  });

  it("compensates the snapshot blob and persists no rows when the transaction fails", async () => {
    // Seed a ticket, then force the runner to reuse its id: the combined
    // create hits a primary-key conflict inside the transaction and rolls
    // everything back.
    await repo.create({
      id: "dup-ticket",
      projectPath: PROJECT_PATH,
      title: "existing",
      description: "",
      workType: "feature",
      status: "not_started",
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    });
    const ids = ["dup-ticket", "att-1"];
    deps.generateId = () => {
      const next = ids.shift();
      if (next === undefined) throw new Error("unexpected extra id request");
      return next;
    };
    runner = createTicketCommandRunner(deps);

    const outcome = await runner.run(runInput());

    expect(outcome.status).toBe("failed");
    // Only the seeded ticket remains; the failed create left no rows.
    const items = await repo.list({ sort: "updated" });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe("existing");
    expect(items[0]!.attachmentCount).toBe(0);
    // The captured blob was compensated away.
    expect(await snapshotFiles()).toHaveLength(0);
    expect(notices[0]!.text).toContain("no ticket was created");
    expect(events).toHaveLength(0);
  });
});
