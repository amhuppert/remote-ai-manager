export {
  getConversationBackendFactory,
  getTaskRunner,
  getBackendDescriptor,
  listBackends,
} from "./registry-core";

import { hasBackendDescriptor, registerBackend } from "./registry-core";
import { createClaudeBackendDescriptor } from "./claude/descriptor";
import { createCodexBackendDescriptor } from "./codex/descriptor";
import { claudeConversationBackendFactory } from "./claude/conversation-runtime";
import { createClaudeContinuityAdapter } from "./claude/continuity";
import { createClaudeRuntimeConfigAdapter } from "./claude/runtime-config/adapter";
import { claudeTaskRunner } from "./claude/task-runner";
import { codexConversationBackendFactory } from "./codex/conversation-runtime";
import { createCodexContinuityAdapter } from "./codex/continuity";
import { createCodexRuntimeConfigAdapter } from "./codex/runtime-config";
import { codexTaskRunner } from "./codex/task-runner";
import {
  claudeMcpCapabilities,
  codexMcpCapabilities,
} from "@/lib/mcp/backend-capabilities";
import { createClaudeFailureClassifier } from "./claude/failure-classifier";
import { createCodexFailureClassifier } from "./codex/failure-classifier";

/**
 * Idempotent production registration of the supported backends. Called on
 * module load so importing the registry yields a populated catalog; tests
 * that reset the registry re-populate it by calling this again (or by
 * registering their own descriptors explicitly).
 */
export function bootstrapBackends(): void {
  if (!hasBackendDescriptor("claude")) {
    registerBackend(
      createClaudeBackendDescriptor({
        conversationFactory: claudeConversationBackendFactory,
        continuity: createClaudeContinuityAdapter(),
        runtimeConfig: createClaudeRuntimeConfigAdapter(),
        taskRunner: claudeTaskRunner,
        mcp: claudeMcpCapabilities,
        failureClassifier: createClaudeFailureClassifier(),
      }),
    );
  }
  if (!hasBackendDescriptor("codex")) {
    registerBackend(
      createCodexBackendDescriptor({
        conversationFactory: codexConversationBackendFactory,
        continuity: createCodexContinuityAdapter(),
        runtimeConfig: createCodexRuntimeConfigAdapter(),
        taskRunner: codexTaskRunner,
        mcp: codexMcpCapabilities,
        failureClassifier: createCodexFailureClassifier(),
      }),
    );
  }
}

bootstrapBackends();
