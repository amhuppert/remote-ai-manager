import { describe, expect, it } from "vitest";

import {
  decodeSharedConversationColumns,
  type SharedConversationRawColumns,
} from "./conversation-row-codec";

function rawColumns(
  pendingQueue: ReadonlyArray<Record<string, unknown>>,
): SharedConversationRawColumns {
  return {
    name: null,
    name_origin: "default",
    transcript_path: null,
    status: "new",
    prompt_count: 0,
    created_at: "2026-08-25T00:00:00.000Z",
    last_activity_at: "2026-08-25T00:00:00.000Z",
    source: "cc",
    summary: null,
    archived: 0,
    total_cost_usd: null,
    total_duration_ms: null,
    total_turns: null,
    pending_question_id: null,
    pending_questions: null,
    pending_prompt_text: null,
    forked_from: null,
    role: null,
    context_tokens: null,
    context_window_max: null,
    debug_mode: null,
    agent_backend: "claude",
    backend_ref: null,
    mcp_overrides: null,
    mcp_runtime: null,
    agent_capability_overrides: null,
    agent_capabilities_runtime: null,
    unread: 0,
    pending_queue: JSON.stringify(pendingQueue),
    last_seen_alignment_version: null,
    pending_agent_notices: null,
    profile_snapshot: null,
    profile_locked_at: null,
    conversation_owner: null,
    turn_generation: 0,
  };
}

describe("decodeSharedConversationColumns pending queue", () => {
  it("rejects a post-migration row that mixes atomic and retired selections", () => {
    const row = {
      id: "q-1",
      content: [{ type: "text", text: "follow-up" }],
      status: "pending",
      enqueuedAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      deliveryStartedAt: null,
      deliveredAt: null,
      cancelledAt: null,
      failedAt: null,
      deliveryAttemptId: null,
      attemptCount: 0,
      error: null,
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      model: "opus",
    };

    expect(() =>
      decodeSharedConversationColumns("conversation-1", rawColumns([row])),
    ).toThrow();
  });
});
