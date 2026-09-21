import { executeAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import { z } from "zod";
import { getTaskRunner } from "@/lib/agent-backends/registry";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import { readConfig } from "@/lib/config/loader";
import {
  resolveConversationNamingConfig,
  type GlobalConfig,
} from "@/lib/config/schemas";
import {
  publishEvent,
  publishEventBestEffort,
  type PublishFn,
} from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import { mutateConversation } from "@/lib/state-store";
import type { ConversationState } from "./schemas";
import { conversationRenamedEventSchema } from "./schemas";
import { conversationEventScopeFields } from "./project-conversation-scope";

export const NAME_MAX_LENGTH = 200;
export const FIRST_MESSAGE_BUDGET_CHARS = 4_000;
export const DEFAULT_NAMING_TIMEOUT_MS = 60_000;

const conversationNameOutputSchema = z
  .object({
    name: z.string(),
  })
  .strict();

export const CONVERSATION_NAME_OUTPUT_SCHEMA: Record<string, unknown> =
  z.toJSONSchema(conversationNameOutputSchema);

const conversationNamingTriggerSchema = z.enum(["auto", "explicit"]);

const generateConversationNameInputSchema = z.object({
  projectPath: z.string(),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  content: z.string(),
  trigger: conversationNamingTriggerSchema,
});

export type GenerateConversationNameInput = z.infer<
  typeof generateConversationNameInputSchema
>;

export interface ConversationNamingDeps {
  getTaskRunner(backend: Parameters<typeof getTaskRunner>[0]): AgentTaskRunner;
  readConfig(): Promise<GlobalConfig>;
  mutateConversation<T = void>(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => T | Promise<T>,
  ): Promise<T>;
  publish(event: Parameters<PublishFn>[0]): ReturnType<PublishFn>;
}

const logger = createLogger("conversation-naming");
const inFlightByConversationId = new Map<string, Promise<string | null>>();

function productionDeps(): ConversationNamingDeps {
  return {
    getTaskRunner(backend) {
      return getTaskRunner(backend);
    },
    readConfig() {
      return readConfig();
    },
    mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      label,
      mutate,
    ) {
      return mutateConversation(
        projectPath,
        sessionName,
        conversationId,
        label,
        mutate,
      );
    },
    publish(event) {
      return publishEvent(event);
    },
  };
}

export function buildNamingPrompt(basisLabel: string, content: string): string {
  return [
    "Generate a concise conversation name from the provided content.",
    "Requirements:",
    "- Use 2-6 words in Title Case.",
    "- Use the same language as the content.",
    "- Describe the topic or goal, not the participants.",
    "- Do not use quotes or trailing punctuation.",
    "- Return only the structured name field.",
    "",
    `${basisLabel}:`,
    "```text",
    content,
    "```",
  ].join("\n");
}

export function sanitizeGeneratedName(raw: string): string | null {
  let value = raw.trim().replace(/\s+/g, " ");
  const wrappingPairs = new Set(['"', "'", "`"]);

  while (
    value.length >= 2 &&
    value[0] === value.at(-1) &&
    wrappingPairs.has(value[0] ?? "")
  ) {
    value = value.slice(1, -1).trim();
  }

  value = value.replace(/[.:]+$/u, "").trim();
  if (value.length > NAME_MAX_LENGTH) {
    value = value.slice(0, NAME_MAX_LENGTH).trim();
  }

  return value.length > 0 ? value : null;
}

function errorType(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}

async function runGeneration(
  input: GenerateConversationNameInput,
  deps: ConversationNamingDeps,
): Promise<string | null> {
  const config = resolveConversationNamingConfig(await deps.readConfig());
  if (input.trigger === "auto" && !config.enabled) return null;

  const modelSelection = config.modelSelection;
  const scopeFields = conversationEventScopeFields(
    input.projectName,
    input.sessionName,
    input.conversationId,
  );
  let stage = "execution";
  let failureKind: string | null = null;

  logger.info("conversation_naming.generation_started", {
    ...scopeFields,
    trigger: input.trigger,
    backend: config.backend,
    modelSelection,
  });

  try {
    const result = await executeAgentCall(
      {
        kind: "task_run",
        backend: config.backend,
        executionClass: "nongoverned-task",
        prompt: buildNamingPrompt("Conversation naming basis", input.content),
        modelSelection,
        outputSchema: CONVERSATION_NAME_OUTPUT_SCHEMA,
        timeoutMs: config.timeoutMs ?? DEFAULT_NAMING_TIMEOUT_MS,
        executionProfile: "isolated-one-shot",
        structuredOutputTurns: "single",
      },
      {
        taskExecution: {
          workingDirectory: input.projectPath,
          autonomous: true,
        },
        getTaskRunner: (backend) => deps.getTaskRunner(backend),
      },
    );

    if (result.outcome.kind !== "completed") {
      failureKind =
        result.outcome.kind === "failed"
          ? result.outcome.error.failureKind
          : "paused";
      throw new Error(
        result.outcome.kind === "failed"
          ? result.outcome.error.message
          : "Conversation name generation paused unexpectedly",
      );
    }

    stage = "output";
    const structured = conversationNameOutputSchema.safeParse(
      result.outcome.structuredOutput,
    );
    if (!structured.success) {
      failureKind = "schema_validation";
      throw new Error(
        "Conversation name generation returned an invalid name envelope",
      );
    }
    const name = sanitizeGeneratedName(structured.data.name);
    if (name === null) {
      failureKind = "empty_output";
      throw new Error("Conversation name generation returned an empty name");
    }

    stage = "apply";
    const applyResult = await deps.mutateConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
      "applyGeneratedConversationName",
      (conversation) => {
        if (input.trigger === "auto" && conversation.nameOrigin !== "default") {
          return {
            applied: false as const,
            nameOrigin: conversation.nameOrigin,
          };
        }
        conversation.name = name;
        conversation.nameOrigin = "auto";
        return { applied: true as const };
      },
    );

    if (!applyResult.applied) {
      logger.info("conversation_naming.apply_skipped_origin", {
        ...scopeFields,
        trigger: input.trigger,
        nameOrigin: applyResult.nameOrigin,
      });
      logger.info("conversation_naming.generation_completed", {
        ...scopeFields,
        trigger: input.trigger,
        backend: config.backend,
        modelSelection,
        applied: false,
      });
      return null;
    }

    stage = "publish";
    publishEventBestEffort({
      logger,
      failureEvent: "conversation_naming.generation_failed",
      context: {
        ...scopeFields,
        trigger: input.trigger,
        stage,
        failureKind: "publication",
      },
      publish: deps.publish,
      build: () =>
        conversationRenamedEventSchema.parse({
          type: "conversation-renamed",
          ...scopeFields,
          name,
        }),
    });

    logger.info("conversation_naming.generation_completed", {
      ...scopeFields,
      trigger: input.trigger,
      backend: config.backend,
      modelSelection,
      applied: true,
    });
    return name;
  } catch (error) {
    logger.warn("conversation_naming.generation_failed", {
      ...scopeFields,
      trigger: input.trigger,
      backend: config.backend,
      modelSelection,
      stage,
      failureKind: failureKind ?? "thrown",
      errorType: errorType(error),
    });
    throw error;
  }
}

export function generateAndApplyConversationName(
  rawInput: GenerateConversationNameInput,
  deps: ConversationNamingDeps = productionDeps(),
): Promise<string | null> {
  const input = generateConversationNameInputSchema.parse(rawInput);
  const existing = inFlightByConversationId.get(input.conversationId);
  if (existing !== undefined) return existing;

  const promise = runGeneration(input, deps).finally(() => {
    if (inFlightByConversationId.get(input.conversationId) === promise) {
      inFlightByConversationId.delete(input.conversationId);
    }
  });
  inFlightByConversationId.set(input.conversationId, promise);
  return promise;
}
