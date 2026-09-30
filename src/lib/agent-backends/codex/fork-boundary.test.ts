import { describe, expect, it } from "vitest";
import { selectCodexForkTurn } from "./fork-boundary";

const SOURCE = "thread-source";
const CHILD = "thread-child";

function user(text: string) {
  return {
    timestamp: "t",
    type: "user",
    role: "user",
    content: [{ type: "text", text }],
  };
}

function assistant(text: string) {
  return {
    timestamp: "t",
    type: "assistant",
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function notice(text: string) {
  return {
    timestamp: "t",
    type: "notice",
    role: "notice",
    content: [{ type: "text", text }],
  };
}

/** A recorded app-server frame, exactly as the runtime archives it. */
function frame(message: unknown) {
  return {
    timestamp: "t",
    type: "codex_app_server",
    raw: { record: JSON.stringify(message) },
  };
}

function turnCompleted(
  threadId: string,
  turnId: string,
  status: "completed" | "interrupted" | "failed" = "completed",
) {
  return frame({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status, items: [] } },
  });
}

function agentMessageCompleted(
  threadId: string,
  turnId: string,
  phase: string | null,
) {
  return frame({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      completedAtMs: 0,
      item: { id: `item-${turnId}`, type: "agentMessage", text: "x", phase },
    },
  });
}

describe("selectCodexForkTurn", () => {
  it("cuts at the source turn that completed after the snapshot's last message", async () => {
    const cut = await selectCodexForkTurn(
      [
        user("u0"),
        agentMessageCompleted(SOURCE, "turn-1", "final_answer"),
        assistant("a1"),
        turnCompleted(SOURCE, "turn-1"),
      ],
      SOURCE,
    );
    expect(cut).toBe("turn-1");
  });

  it("has no cut while the last message's turn has not completed in the snapshot", async () => {
    const cut = await selectCodexForkTurn(
      [
        user("u0"),
        assistant("a1"),
        turnCompleted(SOURCE, "turn-1"),
        user("u2"),
        assistant("a3 still streaming"),
      ],
      SOURCE,
    );
    expect(cut).toBeNull();
  });

  it("has no cut before an accepted steer whose turn completes after it", async () => {
    // The copy for a fork at the steered message stops before the steer; the
    // steered turn's completion lies beyond the snapshot.
    const cut = await selectCodexForkTurn(
      [user("u0"), assistant("working on it")],
      SOURCE,
    );
    expect(cut).toBeNull();
  });

  it("cuts through an interrupted turn that absorbed a steer, once both are in the snapshot", async () => {
    const cut = await selectCodexForkTurn(
      [
        user("u0"),
        assistant("working on it"),
        user("steer: use the other file"),
        turnCompleted(SOURCE, "turn-1", "interrupted"),
      ],
      SOURCE,
    );
    expect(cut).toBe("turn-1");
  });

  it("ignores sub-agent completions interleaved after the source turn completed", async () => {
    const cut = await selectCodexForkTurn(
      [
        user("u0"),
        assistant("a1"),
        turnCompleted(SOURCE, "turn-1"),
        turnCompleted(CHILD, "child-turn-9"),
      ],
      SOURCE,
    );
    expect(cut).toBe("turn-1");
  });

  it("has no cut when only another thread's turn completed", async () => {
    // Covers sub-agent threads, a thread replaced by stale-ref recovery, and
    // copied history that belongs to an ancestor thread.
    const cut = await selectCodexForkTurn(
      [user("u0"), assistant("a1"), turnCompleted(CHILD, "child-turn-9")],
      SOURCE,
    );
    expect(cut).toBeNull();
  });

  it("has no cut when provider-bearing lines follow the completion", async () => {
    const trailingAssistant = await selectCodexForkTurn(
      [
        user("u0"),
        assistant("a1"),
        turnCompleted(SOURCE, "turn-1"),
        assistant("checkpoint capture output"),
      ],
      SOURCE,
    );
    const trailingUser = await selectCodexForkTurn(
      [
        user("u0"),
        assistant("a1"),
        turnCompleted(SOURCE, "turn-1"),
        user("prompt whose dispatch failed"),
      ],
      SOURCE,
    );
    expect(trailingAssistant).toBeNull();
    expect(trailingUser).toBeNull();
  });

  it("keeps the cut across CC notices after the completion", async () => {
    const cut = await selectCodexForkTurn(
      [
        user("u0"),
        assistant("a1"),
        turnCompleted(SOURCE, "turn-1"),
        notice("Turn stopped"),
      ],
      SOURCE,
    );
    expect(cut).toBe("turn-1");
  });

  it("takes the latest of several source turns completing with no message between them", async () => {
    const cut = await selectCodexForkTurn(
      [
        user("u0"),
        assistant("a1"),
        turnCompleted(SOURCE, "turn-1"),
        turnCompleted(SOURCE, "turn-2"),
      ],
      SOURCE,
    );
    expect(cut).toBe("turn-2");
  });

  it("has no cut when the candidate turn recorded a phase-less agent message, and never falls back to an older turn", async () => {
    // A phase-less message is projected only after its turn's completion
    // frame is archived, so the snapshot may hold the completion without it.
    const cut = await selectCodexForkTurn(
      [
        user("u0"),
        assistant("a1"),
        turnCompleted(SOURCE, "turn-1"),
        agentMessageCompleted(SOURCE, "turn-2", null),
        turnCompleted(SOURCE, "turn-2"),
      ],
      SOURCE,
    );
    expect(cut).toBeNull();
  });

  it("does not let a phase-less message in an earlier turn block a later cut", async () => {
    const cut = await selectCodexForkTurn(
      [
        user("u0"),
        agentMessageCompleted(SOURCE, "turn-1", null),
        assistant("a1"),
        turnCompleted(SOURCE, "turn-1"),
        user("u2"),
        agentMessageCompleted(SOURCE, "turn-2", "commentary"),
        agentMessageCompleted(SOURCE, "turn-2", "final_answer"),
        assistant("a3"),
        turnCompleted(SOURCE, "turn-2"),
      ],
      SOURCE,
    );
    expect(cut).toBe("turn-2");
  });

  it("ignores malformed and unrelated records", async () => {
    const cut = await selectCodexForkTurn(
      [
        user("u0"),
        assistant("a1"),
        turnCompleted(SOURCE, "turn-1"),
        { type: "codex_app_server", raw: { record: "{not json" } },
        frame({ method: "thread/tokenUsage/updated", params: {} }),
        frame({ id: 7, result: { turn: { id: "turn-2" } } }),
        { type: "result", raw: { backend: "codex" } },
        "not an object",
        null,
      ],
      SOURCE,
    );
    expect(cut).toBe("turn-1");
  });

  it("reads records from an async stream", async () => {
    async function* stream() {
      yield user("u0");
      yield assistant("a1");
      yield turnCompleted(SOURCE, "turn-1");
    }
    await expect(selectCodexForkTurn(stream(), SOURCE)).resolves.toBe("turn-1");
  });
});
