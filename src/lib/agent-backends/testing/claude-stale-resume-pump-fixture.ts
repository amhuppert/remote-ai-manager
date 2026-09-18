/**
 * Test-only fixture that runs the real Claude conversation runtime and
 * QuerySession pump against a provider port which rejects with stale-resume
 * evidence. QuerySession adds its local death tag while unwinding; the
 * adapter must still return the provider-specific clear verdict.
 */

import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "../schemas";
import type { ConversationBackendTurnResult } from "../conversation";
import { claudeConversationBackendFactory } from "../claude/conversation-runtime";
import {
  _setSdkQueryForTesting,
  type ClaudeSdkQueryPort,
} from "../claude/query-session";

export const STALE_CLAUDE_RESUME_REF: AgentSessionRef = {
  backend: "claude",
  ref: "session-gone",
};

const STALE_CLAUDE_MODEL_SELECTION = {
  modelId: "opus",
  parameters: { effort: "high" },
} satisfies BackendModelSelection;

function createRejectableProviderPort(): {
  query: ClaudeSdkQueryPort;
  rejectPump(error: Error): void;
} {
  let settleNext:
    | {
        resolve(value: IteratorResult<SDKMessage, void>): void;
        reject(error: Error): void;
      }
    | undefined;

  const iterator: AsyncIterator<SDKMessage, void> = {
    next: () =>
      new Promise<IteratorResult<SDKMessage, void>>((resolve, reject) => {
        settleNext = { resolve, reject };
      }),
    return: async () => ({ value: undefined, done: true }),
  };

  const query: ClaudeSdkQueryPort = {
    async awaitChildCollection() {},
    close() {
      settleNext?.resolve({ value: undefined, done: true });
      settleNext = undefined;
    },
    supportedCommands: async () => [],
    supportedAgents: async () => [],
    mcpServerStatus: async () => [],
    applyFlagSettings: async () => {},
    reloadPlugins: async () => undefined,
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return {
    query,
    rejectPump(error) {
      const pending = settleNext;
      settleNext = undefined;
      if (!pending) {
        throw new Error("Claude stale-resume fixture pump is not awaiting");
      }
      pending.reject(error);
    },
  };
}

export async function runStaleClaudePumpResumeTurn(identity: {
  conversationId: string;
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
}): Promise<ConversationBackendTurnResult> {
  const provider = createRejectableProviderPort();
  _setSdkQueryForTesting(() => provider.query);

  let runtime: Awaited<
    ReturnType<typeof claudeConversationBackendFactory.createRuntime>
  > | null = null;
  try {
    runtime = await claudeConversationBackendFactory.createRuntime({
      executionClass: "ordinary-conversation" as const,
      ...identity,
      conversationTarget: sessionConversationTarget(
        identity.projectName,
        identity.sessionName,
        identity.conversationId,
      ),
      persistedRef: STALE_CLAUDE_RESUME_REF,
      modelSelection: STALE_CLAUDE_MODEL_SELECTION,
      sessionInstructions: [],
      tooling: {},
    });
    const turn = runtime.sendTurn({
      promptText: "Continue where we left off",
      imageRefs: [],
      sessionInstructions: [],
      modelSelection: STALE_CLAUDE_MODEL_SELECTION,
      autonomous: false,
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    provider.rejectPump(
      new Error(`Session ${STALE_CLAUDE_RESUME_REF.ref} does not exist`),
    );
    return await turn;
  } finally {
    await runtime?.close();
    _setSdkQueryForTesting(null);
  }
}
