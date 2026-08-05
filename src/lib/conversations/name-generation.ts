import { z } from "zod";
import {
  getDefaultModelForBackend,
  getEffortLevelsForBackend,
  isModelCompatibleWithBackend,
} from "@/lib/agent-backends/catalog";
import { getTaskRunner } from "@/lib/agent-backends/registry";
import { validateStructuredOutput } from "@/lib/agent-backends/structured-output";
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

function firstNonEmptyLine(text: string | null): string | null {
  if (text === null) return null;
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) return line;
  }
  return null;
}

function resolveReasoningEffort(
  backend: Parameters<typeof getTaskRunner>[0],
  modelId: string,
  configuredEffort: ReturnType<
    typeof resolveConversationNamingConfig
  >["effort"],
): string | undefined {
  const supported = getEffortLevelsForBackend(backend, modelId);
  if (supported.length === 0) return undefined;
  if (supported.includes(configuredEffort)) return configuredEffort;
  return supported.at(-1);
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

  const modelId = isModelCompatibleWithBackend(config.backend, config.model)
    ? config.model
    : getDefaultModelForBackend(config.backend);
  const reasoningEffort = resolveReasoningEffort(
    config.backend,
    modelId,
    config.effort,
  );
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
    modelId,
  });

  try {
    const runner = deps.getTaskRunner(config.backend);
    const result = await runner.run({
      workingDirectory: input.projectPath,
      prompt: buildNamingPrompt("Conversation naming basis", input.content),
      modelId,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
      outputSchema: CONVERSATION_NAME_OUTPUT_SCHEMA,
      timeoutMs: config.timeoutMs ?? DEFAULT_NAMING_TIMEOUT_MS,
      executionProfile: "isolated-one-shot",
      autonomous: true,
    });

    if (result.timedOut || result.error !== null || result.failure !== null) {
      failureKind = result.timedOut
        ? "timeout"
        : (result.failure?.kind ?? "backend_error");
      throw new Error(
        result.error ??
          result.failure?.message ??
          "Conversation name generation failed",
      );
    }

    stage = "output";
    const structured = validateStructuredOutput(conversationNameOutputSchema, {
      ...(result.structuredOutput !== undefined
        ? { native: result.structuredOutput }
        : {}),
      text: result.text,
    });
    const rawName = structured.ok
      ? structured.value.name
      : firstNonEmptyLine(result.text);
    const name = rawName === null ? null : sanitizeGeneratedName(rawName);
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
        modelId,
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
      modelId,
      applied: true,
    });
    return name;
  } catch (error) {
    logger.warn("conversation_naming.generation_failed", {
      ...scopeFields,
      trigger: input.trigger,
      backend: config.backend,
      modelId,
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
