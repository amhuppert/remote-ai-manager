import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createExecutionLogger,
  getExecutionLogger,
  registerExecutionLogger,
  unregisterExecutionLogger,
  _resetRegistryForTesting,
  type ExecutionLogger,
} from "./execution-logger";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { createWorkflowDefinition } from "./test-fixtures";

const TEST_DIR = path.join(__dirname, "__test-logs__");
let seq = 0;

function uniqueId(): string {
  seq += 1;
  return `test-exec-${seq}`;
}

function fixedNow(): string {
  return "2025-01-15T10:00:00.000Z";
}

function createTestLogger(): ExecutionLogger {
  return createExecutionLogger(uniqueId(), {
    configDir: TEST_DIR,
    now: fixedNow,
  });
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function readText(filePath: string): string {
  return readFileSync(filePath, "utf-8");
}

function makeExecution(
  executionId: string,
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  const definition = createWorkflowDefinition();
  return {
    id: executionId,
    seedDefinitionId: "def-1",
    seedDefinitionRevision: 1,
    workingDefinition: definition,
    status: "running",
    activeContextIds: ["ctx-1"],
    activeTaskId: null,
    contextStates: {
      "ctx-1": {
        contextId: "ctx-1",
        status: "running",
        totalTaskCount: 2,
        completedTaskCount: 1,
        iterationCount: 3,
        consecutiveFailureCount: 0,
        consecutiveCandidateMismatchCount: 0,
      },
    },
    taskStates: {},
    sharedDocuments: [],
    machineSnapshot: null,
    history: [],
    laneStates: {},
    startedAt: "2025-01-15T09:00:00.000Z",
    completedAt: null,
    haltReason: null,
    ...overrides,
  } as GraphWorkflowExecution;
}

beforeEach(() => {
  _resetRegistryForTesting();
});

afterEach(() => {
  _resetRegistryForTesting();
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("createExecutionLogger", () => {
  it("creates a logger with the execution id and log dir", () => {
    const logger = createTestLogger();
    expect(logger.executionId).toMatch(/^test-exec-/);
    expect(logger.logDir).toContain("workflow-logs");
    expect(logger.logDir).toContain(logger.executionId);
  });
});

describe("lifecycle", () => {
  it("appends a timestamped JSONL entry to lifecycle.jsonl", () => {
    const logger = createTestLogger();
    logger.lifecycle("execution.started", { definitionId: "def-1" });
    logger.lifecycle("context.scheduled", { contextId: "ctx-1" });

    const entries = readJsonl(path.join(logger.logDir, "lifecycle.jsonl"));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      timestamp: "2025-01-15T10:00:00.000Z",
      event: "execution.started",
      executionId: logger.executionId,
      definitionId: "def-1",
    });
    expect(entries[1]!.event).toBe("context.scheduled");
  });
});

describe("iteration", () => {
  it("writes to contexts/<contextId>/iterations.jsonl", () => {
    const logger = createTestLogger();
    logger.iteration("ctx-1", "iteration.started", {
      iterationNumber: 1,
      promptMode: "iteration_seed",
    });

    const entries = readJsonl(
      path.join(logger.logDir, "contexts", "ctx-1", "iterations.jsonl"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: "iteration.started",
      contextId: "ctx-1",
      iterationNumber: 1,
      promptMode: "iteration_seed",
    });
  });
});

describe("task", () => {
  it("writes to contexts/<contextId>/tasks.jsonl", () => {
    const logger = createTestLogger();
    logger.task("ctx-1", "task.completed", {
      taskId: "setup-auth",
      summary: "Added auth middleware",
    });

    const entries = readJsonl(
      path.join(logger.logDir, "contexts", "ctx-1", "tasks.jsonl"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: "task.completed",
      taskId: "setup-auth",
    });
  });
});

describe("validation", () => {
  it("writes to contexts/<contextId>/validation.jsonl", () => {
    const logger = createTestLogger();
    logger.validation("ctx-1", "validator.invoked", {
      engine: "claude",
      lane: "task_validator",
    });

    const entries = readJsonl(
      path.join(logger.logDir, "contexts", "ctx-1", "validation.jsonl"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: "validator.invoked",
      engine: "claude",
    });
  });
});

describe("writePrompt", () => {
  it("writes full prompt text to contexts/<contextId>/prompts/", () => {
    const logger = createTestLogger();
    logger.writePrompt("ctx-1", "iteration-1.md", "# Iteration Prompt\n...");

    const content = readText(
      path.join(
        logger.logDir,
        "contexts",
        "ctx-1",
        "prompts",
        "iteration-1.md",
      ),
    );
    expect(content).toBe("# Iteration Prompt\n...");
  });
});

describe("writeValidatorResponse", () => {
  it("writes structured JSON under the reviewing assignment's directory", () => {
    const logger = createTestLogger();
    logger.writeValidatorResponse(
      { contextId: "ctx-1", assignmentId: "general" },
      "task-validation-setup-auth-response.json",
      {
        raw: '{"pass": true}',
        parsed: {
          pass: true,
          summary: "Looks good",
          issues: [],
        },
        parsePath: "structured_output",
      },
    );

    const data = readJson(
      path.join(
        logger.logDir,
        "contexts",
        "ctx-1",
        "validators",
        "general",
        "task-validation-setup-auth-response.json",
      ),
    ) as Record<string, unknown>;
    expect(data).toMatchObject({
      raw: '{"pass": true}',
      parsePath: "structured_output",
    });
  });

  // R8.1: a cohort's evidence must survive the round. Keyed by lane kind alone,
  // the second specialist's response overwrote the first's.
  it("keeps two assignments' responses for the same context side by side", () => {
    const logger = createTestLogger();
    for (const assignmentId of ["reviewer-a", "reviewer-b"]) {
      logger.writeValidatorResponse(
        { contextId: "ctx-1", assignmentId },
        "context-validator.json",
        {
          raw: `{"reviewer":"${assignmentId}"}`,
          parsed: { reviewer: assignmentId },
          parsePath: "structured_output",
        },
      );
    }

    const read = (assignmentId: string) =>
      readJson(
        path.join(
          logger.logDir,
          "contexts",
          "ctx-1",
          "validators",
          assignmentId,
          "context-validator.json",
        ),
      ) as Record<string, unknown>;
    expect(read("reviewer-a")).toMatchObject({
      raw: '{"reviewer":"reviewer-a"}',
    });
    expect(read("reviewer-b")).toMatchObject({
      raw: '{"reviewer":"reviewer-b"}',
    });
  });
});

describe("writeValidatorTranscript", () => {
  it("appends a begin-marker followed by one item event per entry", () => {
    const logger = createTestLogger();
    logger.writeValidatorTranscript(
      { contextId: "ctx-1", assignmentId: "general" },
      { lane: "context_validator", engine: "codex" },
      [
        {
          seq: 0,
          backend: "codex",
          type: "reasoning",
          raw: { type: "reasoning", text: "weigh AC vs prototype" },
        },
        {
          seq: 1,
          backend: "codex",
          type: "agent_message",
          raw: { type: "agent_message", text: "GO" },
        },
      ],
    );

    const entries = readJsonl(
      path.join(
        logger.logDir,
        "contexts",
        "ctx-1",
        "validators",
        "general",
        "validation-transcript.jsonl",
      ),
    );
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      event: "validator.transcript_begin",
      executionId: logger.executionId,
      contextId: "ctx-1",
      lane: "context_validator",
      engine: "codex",
      attempt: 0,
      entryCount: 2,
    });
    expect(entries[1]).toMatchObject({
      event: "validator.transcript_item",
      contextId: "ctx-1",
      seq: 0,
      backend: "codex",
      itemType: "reasoning",
      raw: { type: "reasoning", text: "weigh AC vs prototype" },
    });
    expect(entries[2]).toMatchObject({ seq: 1, itemType: "agent_message" });
  });

  it("increments attempt per (context, lane) across re-validations", () => {
    const logger = createTestLogger();
    const entry = {
      seq: 0,
      backend: "codex" as const,
      type: "agent_message",
      raw: { type: "agent_message", text: "x" },
    };
    logger.writeValidatorTranscript(
      { contextId: "ctx-1", assignmentId: "general" },
      { lane: "context_validator", engine: "codex" },
      [entry],
    );
    logger.writeValidatorTranscript(
      { contextId: "ctx-1", assignmentId: "general" },
      { lane: "context_validator", engine: "codex" },
      [entry],
    );

    const begins = readJsonl(
      path.join(
        logger.logDir,
        "contexts",
        "ctx-1",
        "validators",
        "general",
        "validation-transcript.jsonl",
      ),
    ).filter((e) => e.event === "validator.transcript_begin");
    expect(begins.map((b) => b.attempt)).toEqual([0, 1]);
  });

  it("continues attempt numbering when a new logger appends to an existing transcript log", () => {
    const executionId = uniqueId();
    const entry = {
      seq: 0,
      backend: "codex" as const,
      type: "agent_message",
      raw: { type: "agent_message", text: "x" },
    };
    const firstLogger = createExecutionLogger(executionId, {
      configDir: TEST_DIR,
      now: fixedNow,
    });
    firstLogger.writeValidatorTranscript(
      { contextId: "ctx-1", assignmentId: "general" },
      { lane: "context_validator", engine: "codex" },
      [entry],
    );

    const resumedLogger = createExecutionLogger(executionId, {
      configDir: TEST_DIR,
      now: fixedNow,
    });
    resumedLogger.writeValidatorTranscript(
      { contextId: "ctx-1", assignmentId: "general" },
      { lane: "context_validator", engine: "codex" },
      [entry],
    );

    const begins = readJsonl(
      path.join(
        resumedLogger.logDir,
        "contexts",
        "ctx-1",
        "validators",
        "general",
        "validation-transcript.jsonl",
      ),
    ).filter((e) => e.event === "validator.transcript_begin");
    expect(begins.map((b) => b.attempt)).toEqual([0, 1]);
  });

  it("writes nothing when there are no entries", () => {
    const logger = createTestLogger();
    logger.writeValidatorTranscript(
      { contextId: "ctx-1", assignmentId: "general" },
      { lane: "context_validator", engine: "claude" },
      [],
    );

    expect(
      existsSync(
        path.join(
          logger.logDir,
          "contexts",
          "ctx-1",
          "validators",
          "general",
          "validation-transcript.jsonl",
        ),
      ),
    ).toBe(false);
  });
});

describe("decision", () => {
  it("writes to decisions.jsonl", () => {
    const logger = createTestLogger();
    logger.decision("retry.evaluated", {
      lane: "implementer",
      outcome: "retry",
    });

    const entries = readJsonl(path.join(logger.logDir, "decisions.jsonl"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: "retry.evaluated",
      lane: "implementer",
    });
  });
});

describe("writeManifest", () => {
  it("writes _manifest.json with execution metadata", () => {
    const logger = createTestLogger();
    const execution = makeExecution(logger.executionId);
    logger.writeManifest(execution);

    const manifest = readJson(
      path.join(logger.logDir, "_manifest.json"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      executionId: logger.executionId,
      definitionId: "def-1",
      status: "running",
    });
    expect(manifest).toHaveProperty("files");
    expect(manifest).toHaveProperty("definition");
    expect(manifest).toHaveProperty("contexts");
    const contexts = manifest.contexts as Array<Record<string, unknown>>;
    expect(contexts[0]).toMatchObject({
      contextId: "context-plan",
      iterationCount: 0,
    });
  });
});

describe("registry", () => {
  it("registers and retrieves loggers by execution id", () => {
    const logger = createTestLogger();
    expect(getExecutionLogger(logger.executionId)).toBeNull();

    registerExecutionLogger(logger);
    expect(getExecutionLogger(logger.executionId)).toBe(logger);

    unregisterExecutionLogger(logger.executionId);
    expect(getExecutionLogger(logger.executionId)).toBeNull();
  });
});

describe("silent failure", () => {
  it("does not throw on write errors", () => {
    // Logger with an invalid config dir that can't be written to
    const logger = createExecutionLogger("test-silent", {
      configDir: "/dev/null/invalid",
      now: fixedNow,
    });

    expect(() => {
      logger.lifecycle("test.event", { key: "value" });
      logger.iteration("ctx-1", "test.event");
      logger.task("ctx-1", "test.event");
      logger.validation("ctx-1", "test.event");
      logger.decision("test.event");
      logger.writePrompt("ctx-1", "test.md", "content");
      logger.writeValidatorTranscript(
        { contextId: "ctx-1", assignmentId: "general" },
        { lane: "context_validator", engine: "codex" },
        [{ seq: 0, backend: "codex", type: "agent_message", raw: {} }],
      );
    }).not.toThrow();
  });
});
