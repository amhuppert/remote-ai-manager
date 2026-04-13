import { createLogger } from "@/lib/logging";
import type { AgentBackendId } from "./types";
import type { ConversationBackendFactory } from "./conversation";
import type { AgentTaskRunner } from "./task";

const logger = createLogger("agent-backends:registry");

const conversationFactories = new Map<
  AgentBackendId,
  ConversationBackendFactory
>();
const taskRunners = new Map<AgentBackendId, AgentTaskRunner>();

export function registerConversationBackendFactory(
  factory: ConversationBackendFactory,
): void {
  logger.info("Registering conversation backend factory", {
    backend: factory.backend,
  });
  conversationFactories.set(factory.backend, factory);
}

export function registerTaskRunner(runner: AgentTaskRunner): void {
  logger.info("Registering task runner", { backend: runner.backend });
  taskRunners.set(runner.backend, runner);
}

export function getConversationBackendFactory(
  backend: AgentBackendId,
): ConversationBackendFactory {
  const factory = conversationFactories.get(backend);
  if (!factory) {
    throw new Error(
      `No conversation backend factory registered for backend: ${backend}`,
    );
  }
  logger.debug("Retrieved conversation backend factory", { backend });
  return factory;
}

export function getTaskRunner(backend: AgentBackendId): AgentTaskRunner {
  const runner = taskRunners.get(backend);
  if (!runner) {
    throw new Error(`No task runner registered for backend: ${backend}`);
  }
  logger.debug("Retrieved task runner", { backend });
  return runner;
}

export function resolveConversationBackend(
  configDefault: AgentBackendId,
  requested?: AgentBackendId,
): AgentBackendId {
  const resolved = requested ?? configDefault;
  logger.debug("Resolved conversation backend", {
    configDefault,
    requested,
    resolved,
  });
  return resolved;
}
