import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskRunner,
} from "@/lib/agent-backends/task";
import { materializeGlobalConfig } from "@/lib/config/loader";
import type { GlobalConfig } from "@/lib/config/schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { buildConversation } from "./build-conversation";
import {
  CONVERSATION_NAME_OUTPUT_SCHEMA,
  DEFAULT_NAMING_TIMEOUT_MS,
  NAME_MAX_LENGTH,
  buildNamingPrompt,
  generateAndApplyConversationName,
  sanitizeGeneratedName,
  type ConversationNamingDeps,
} from "./name-generation";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";
import { conversationRenamedEventSchema } from "./schemas";

const PROJECT_PATH = "/repo-conversation-naming";
const PROJECT_NAME = "conversation-naming";
const SESSION_NAME = "feature-session";
const CONVERSATION_ID = "conversation-name-generation";

function taskResult(overrides: Partial<AgentTaskResult> = {}): AgentTaskResult {
  return {
    backendRef: null,
    text: null,
    structuredOutput: { name: "Generated Conversation Name" },
    usage: null,
    error: null,
    timedOut: false,
    failure: null,
    continuationDisposition: "retain",
    ...overrides,
  };
}

function configWithNaming(
  overrides: Partial<NonNullable<GlobalConfig["conversationNaming"]>> = {},
): GlobalConfig {
  return {
    ...materializeGlobalConfig({}),
    conversationNaming: {
      enabled: true,
      backend: "claude",
      modelSelection: {
        modelId: "haiku",
        parameters: {},
      },
      timeoutMs: null,
      ...overrides,
    },
  };
}

interface Harness {
  deps: ConversationNamingDeps;
  requests: AgentTaskRequest[];
  runnerBackends: AgentTaskRunner["backend"][];
  published: SSEEvent[];
}

function createHarness(
  options: {
    config?: GlobalConfig;
    run?: (request: AgentTaskRequest) => Promise<AgentTaskResult>;
  } = {},
): Harness {
  const requests: AgentTaskRequest[] = [];
  const runnerBackends: AgentTaskRunner["backend"][] = [];
  const published: SSEEvent[] = [];
  const resolvedConfig = options.config ?? configWithNaming();
  const run = options.run ?? (async () => taskResult());

  const deps: ConversationNamingDeps = {
    getTaskRunner(backend) {
      runnerBackends.push(backend);
      return {
        backend,
        async run(request) {
          requests.push(request);
          return run(request);
        },
      };
    },
    async readConfig() {
      return resolvedConfig;
    },
    mutateConversation: fixture.deps.mutateConversation,
    publish(event) {
      published.push(event);
      return { delivered: true };
    },
  };

  return { deps, requests, runnerBackends, published };
}

function generationInput(
  overrides: Partial<
    Parameters<typeof generateAndApplyConversationName>[0]
  > = {},
): Parameters<typeof generateAndApplyConversationName>[0] {
  return {
    projectPath: PROJECT_PATH,
    projectName: PROJECT_NAME,
    sessionName: SESSION_NAME,
    conversationId: CONVERSATION_ID,
    content: "Implement background conversation naming",
    trigger: "auto",
    ...overrides,
  };
}

async function reloadConversation(sessionName = SESSION_NAME) {
  return fixture.deps.getConversation(
    PROJECT_PATH,
    sessionName,
    CONVERSATION_ID,
  );
}

let fixture: PersistenceFixture;

beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  await fixture.seedConversation(
    PROJECT_PATH,
    SESSION_NAME,
    buildConversation({
      id: CONVERSATION_ID,
      scope: "session",
      name: `${SESSION_NAME} 1`,
      createdAt: "2026-08-04T12:00:00.000Z",
      agentBackend: "claude",
    }),
  );
});

afterEach(() => {
  fixture.close();
});

describe("generateAndApplyConversationName", () => {
  it.each(["claude", "cursor"] as const)(
    "applies %s output and persists a project-scoped rename",
    async (backend) => {
      await fixture.seedProjectConversation(
        PROJECT_PATH,
        buildConversation({
          id: CONVERSATION_ID,
          scope: "project",
          name: `${PROJECT_NAME} chat 1`,
          createdAt: "2026-08-04T12:00:00.000Z",
          agentBackend: "claude",
        }),
      );
      const modelSelection: AgentTaskRequest["modelSelection"] =
        backend === "cursor"
          ? { modelId: "composer-2.5", parameters: { fast: "false" } }
          : { modelId: "haiku", parameters: {} };
      const harness = createHarness({
        config: configWithNaming({ backend, modelSelection }),
      });

      await expect(
        generateAndApplyConversationName(
          generationInput({
            sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
          }),
          harness.deps,
        ),
      ).resolves.toBe("Generated Conversation Name");

      const reloaded = await reloadConversation(
        PROJECT_CONVERSATION_SESSION_SENTINEL,
      );
      expect(reloaded).toMatchObject({
        name: "Generated Conversation Name",
        nameOrigin: "auto",
      });
      expect(harness.runnerBackends).toEqual([backend]);
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0]).toMatchObject({
        workingDirectory: PROJECT_PATH,
        modelSelection,
        timeoutMs: DEFAULT_NAMING_TIMEOUT_MS,
        executionProfile: "isolated-one-shot",
        autonomous: true,
        outputSchema: CONVERSATION_NAME_OUTPUT_SCHEMA,
      });
      expect(harness.requests[0]?.prompt).toContain(
        "Implement background conversation naming",
      );
      expect(harness.published).toHaveLength(1);
      expect(
        conversationRenamedEventSchema.safeParse(harness.published[0]).success,
      ).toBe(true);
      expect(harness.published[0]).toEqual({
        type: "conversation-renamed",
        scope: "project",
        projectName: PROJECT_NAME,
        conversationId: CONVERSATION_ID,
        name: "Generated Conversation Name",
      });
    },
  );

  it("skips an automatic apply when a manual rename wins during generation", async () => {
    const harness = createHarness({
      async run() {
        await fixture.deps.mutateConversation(
          PROJECT_PATH,
          SESSION_NAME,
          CONVERSATION_ID,
          "manualRenameDuringGeneration",
          (conversation) => {
            conversation.name = "Chosen Manually";
            conversation.nameOrigin = "manual";
          },
        );
        return taskResult({ structuredOutput: { name: "Generated Too Late" } });
      },
    });

    await generateAndApplyConversationName(generationInput(), harness.deps);

    expect(await reloadConversation()).toMatchObject({
      name: "Chosen Manually",
      nameOrigin: "manual",
    });
    expect(harness.published).toHaveLength(0);
  });

  it("allows an explicit generation to replace a manual name", async () => {
    await fixture.deps.mutateConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
      "seedManualName",
      (conversation) => {
        conversation.name = "Chosen Manually";
        conversation.nameOrigin = "manual";
      },
    );
    const harness = createHarness({
      run: async () =>
        taskResult({ structuredOutput: { name: "Replacement Name" } }),
    });

    await generateAndApplyConversationName(
      generationInput({ trigger: "explicit" }),
      harness.deps,
    );

    expect(await reloadConversation()).toMatchObject({
      name: "Replacement Name",
      nameOrigin: "auto",
    });
    expect(harness.published).toHaveLength(1);
  });

  it.each([
    ['"Wrapped Name"', "Wrapped Name"],
    ["`Wrapped Name`", "Wrapped Name"],
    ["'Wrapped Name'", "Wrapped Name"],
    ["  Too   Much\nWhitespace  ", "Too Much Whitespace"],
    ["Trailing Period.", "Trailing Period"],
    ["Trailing Colon:", "Trailing Colon"],
    ["x".repeat(NAME_MAX_LENGTH + 25), "x".repeat(NAME_MAX_LENGTH)],
    ['  "."  ', null],
  ])("sanitizes %j to %j", (raw, expected) => {
    expect(sanitizeGeneratedName(raw)).toBe(expected);
  });

  it("falls back to the first non-empty text line when structured output is missing", async () => {
    const harness = createHarness({
      run: async () =>
        taskResult({
          structuredOutput: undefined,
          text: "\n  Fallback From Text  \nIgnored second line",
        }),
    });

    await generateAndApplyConversationName(generationInput(), harness.deps);

    expect(await reloadConversation()).toMatchObject({
      name: "Fallback From Text",
      nameOrigin: "auto",
    });
  });

  it.each([
    taskResult({
      structuredOutput: undefined,
      error: "backend unavailable",
      failure: {
        kind: "backend_error",
        message: "backend unavailable",
        retryable: true,
      },
    }),
    taskResult({
      structuredOutput: undefined,
      timedOut: true,
      failure: { kind: "timeout", message: "timed out", retryable: true },
    }),
  ])(
    "leaves persisted state untouched when the runner fails",
    async (result) => {
      const harness = createHarness({ run: async () => result });

      await expect(
        generateAndApplyConversationName(generationInput(), harness.deps),
      ).rejects.toThrow();

      expect(await reloadConversation()).toMatchObject({
        name: `${SESSION_NAME} 1`,
        nameOrigin: "default",
      });
      expect(harness.published).toHaveLength(0);
    },
  );

  it("coalesces concurrent calls for one conversation into one runner invocation", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      async run() {
        await gate;
        return taskResult();
      },
    });

    const first = generateAndApplyConversationName(
      generationInput(),
      harness.deps,
    );
    const second = generateAndApplyConversationName(
      generationInput({ content: "A concurrent duplicate basis" }),
      harness.deps,
    );
    await Promise.resolve();
    release?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      "Generated Conversation Name",
      "Generated Conversation Name",
    ]);
    expect(harness.requests).toHaveLength(1);
    expect(harness.published).toHaveLength(1);
  });

  it("blocks automatic generation when disabled without blocking explicit generation", async () => {
    const harness = createHarness({
      config: configWithNaming({ enabled: false }),
    });

    await expect(
      generateAndApplyConversationName(generationInput(), harness.deps),
    ).resolves.toBeNull();
    expect(harness.requests).toHaveLength(0);
    expect(await reloadConversation()).toMatchObject({
      name: `${SESSION_NAME} 1`,
      nameOrigin: "default",
    });

    await expect(
      generateAndApplyConversationName(
        generationInput({ trigger: "explicit" }),
        harness.deps,
      ),
    ).resolves.toBe("Generated Conversation Name");
    expect(harness.requests).toHaveLength(1);
    expect(await reloadConversation()).toMatchObject({
      name: "Generated Conversation Name",
      nameOrigin: "auto",
    });
  });

  it("forwards a configured selection as one exact value without clamping", async () => {
    const backend = "codex" as const;
    const modelSelection = {
      modelId: "gpt-5.5",
      parameters: { reasoning: "xhigh", fast: "true" },
    };
    const harness = createHarness({
      config: configWithNaming({
        backend,
        modelSelection,
      }),
    });

    await generateAndApplyConversationName(generationInput(), harness.deps);

    expect(harness.runnerBackends).toEqual([backend]);
    expect(harness.requests[0]?.modelSelection).toEqual(modelSelection);
  });
});

describe("buildNamingPrompt", () => {
  it("states the naming contract and fences the basis content", () => {
    const prompt = buildNamingPrompt(
      "First user message",
      "Build a log viewer",
    );

    expect(prompt).toContain("2-6 words");
    expect(prompt).toContain("Title Case");
    expect(prompt).toContain("same language");
    expect(prompt).toContain("topic or goal");
    expect(prompt).toContain("First user message");
    expect(prompt).toContain("```text\nBuild a log viewer\n```");
  });
});
