import { vi } from "vitest";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
export function createMockBackendRuntime(
  overrides: Partial<ConversationBackendRuntime> = {},
): ConversationBackendRuntime {
  return {
    backend: "claude",
    status: "alive",
    modelSelection: { modelId: "opus", parameters: { effort: "high" } },
    sendTurn: vi.fn(),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}
