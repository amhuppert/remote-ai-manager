import { describe, it, expect, vi } from "vitest";
import type { ConversationBackendEvent } from "../conversation";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createClaudeMessageInterpreter,
  createClaudeExternalTurnInterpreter,
  mapErrorSubtype,
} from "./process-message";

function collect(): {
  events: ConversationBackendEvent[];
  onEvent: (event: ConversationBackendEvent) => void;
} {
  const events: ConversationBackendEvent[] = [];
  return { events, onEvent: (event) => events.push(event) };
}

describe("createClaudeMessageInterpreter", () => {
  it("emits backend_init with a claude ref on system init", async () => {
    const { events, onEvent } = collect();
    const interpreter = createClaudeMessageInterpreter({ onEvent });

    interpreter.handleMessage({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
    } as never);
    await interpreter.flush();

    expect(events[0]).toEqual({
      type: "backend_init",
      backendRef: { backend: "claude", ref: "sess-1" },
    });
    const envelope = events.find((e) => e.type === "transcript_entry");
    expect(envelope).toBeDefined();
  });

  it("does not emit backend_init when the init message has no session id", async () => {
    const { events, onEvent } = collect();
    const interpreter = createClaudeMessageInterpreter({ onEvent });

    interpreter.handleMessage({
      type: "system",
      subtype: "init",
      session_id: "",
    } as never);
    await interpreter.flush();

    expect(events.some((e) => e.type === "backend_init")).toBe(false);
    expect(events.some((e) => e.type === "transcript_entry")).toBe(true);
  });

  it("emits one content event per mapped assistant block", async () => {
    const { events, onEvent } = collect();
    const interpreter = createClaudeMessageInterpreter({ onEvent });

    interpreter.handleMessage({
      type: "assistant",
      uuid: "msg-think",
      message: {
        content: [
          {
            type: "thinking",
            thinking: "Two candidates: a regression, or a stale selector.",
            signature: "sig-abc",
          },
          { type: "redacted_thinking", data: "encrypted-blob" },
          { type: "text", text: "The component is correct." },
        ],
      },
    } as never);
    await interpreter.flush();

    const blocks = events
      .filter((e) => e.type === "content")
      .map((e) => (e as { type: "content"; block: unknown }).block);
    expect(blocks).toEqual([
      {
        type: "thinking",
        text: "Two candidates: a regression, or a stale selector.",
      },
      { type: "thinking", text: "", redacted: true },
      { type: "text", text: "The component is correct." },
    ]);
  });

  it("stamps monotonic seq + backend claude on every transcript envelope", async () => {
    const { events, onEvent } = collect();
    const interpreter = createClaudeMessageInterpreter({ onEvent });

    interpreter.handleMessage({
      type: "system",
      subtype: "init",
      session_id: "s",
    } as never);
    interpreter.handleMessage({
      type: "assistant",
      uuid: "u1",
      message: { content: [{ type: "text", text: "hi" }] },
    } as never);
    await interpreter.flush();

    const envelopes = events
      .filter((e) => e.type === "transcript_entry")
      .map(
        (e) =>
          (
            e as {
              type: "transcript_entry";
              entry: { seq: number; backend: string };
            }
          ).entry,
      );
    expect(envelopes.map((e) => e.seq)).toEqual([0, 1]);
    expect(envelopes.every((e) => e.backend === "claude")).toBe(true);
  });

  it("emits a fallback content block for a result with text when no content streamed", async () => {
    const { events, onEvent } = collect();
    const interpreter = createClaudeMessageInterpreter({ onEvent });

    interpreter.handleMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      total_cost_usd: 0.01,
      num_turns: 1,
      result: "Final answer",
    } as never);
    await interpreter.flush();

    expect(events.filter((e) => e.type === "content")).toEqual([
      { type: "content", block: { type: "text", text: "Final answer" } },
    ]);
  });

  it("suppresses the fallback block when assistant content was already emitted", async () => {
    const { events, onEvent } = collect();
    const interpreter = createClaudeMessageInterpreter({ onEvent });

    interpreter.handleMessage({
      type: "assistant",
      uuid: "u1",
      message: { content: [{ type: "text", text: "streamed" }] },
    } as never);
    interpreter.handleMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      total_cost_usd: 0.01,
      num_turns: 1,
      result: "streamed",
    } as never);
    await interpreter.flush();

    const contentEvents = events.filter((e) => e.type === "content");
    expect(contentEvents).toHaveLength(1);
  });

  it("emits an error event with the mapped message for result errors", async () => {
    const { events, onEvent } = collect();
    const interpreter = createClaudeMessageInterpreter({ onEvent });

    interpreter.handleMessage({
      type: "result",
      subtype: "error_during_execution",
      num_turns: 1,
      total_cost_usd: 0.01,
      errors: ["Something failed"],
    } as never);
    await interpreter.flush();

    expect(events.filter((e) => e.type === "error")).toEqual([
      { type: "error", message: "Something failed" },
    ]);
  });
});

describe("createClaudeExternalTurnInterpreter", () => {
  it("arms the wake marker once per interpreter instance", async () => {
    const { events, onEvent } = collect();
    const interpreter = createClaudeExternalTurnInterpreter({ onEvent });

    const assistant = (uuid: string, text: string) =>
      ({
        type: "assistant",
        uuid,
        message: { content: [{ type: "text", text }] },
      }) as never;

    interpreter.handleMessage(assistant("u1", "one"));
    interpreter.handleMessage(assistant("u2", "two"));
    await interpreter.flush();

    const notices = events.filter(
      (e) =>
        e.type === "transcript_entry" &&
        (e.entry.raw as { role?: string }).role === "notice",
    );
    expect(notices).toHaveLength(1);
  });

  it("emits no marker for a notification-only turn", async () => {
    const { events, onEvent } = collect();
    const interpreter = createClaudeExternalTurnInterpreter({ onEvent });

    interpreter.handleMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "task-a",
      status: "completed",
      session_id: "s",
    } as never);
    await interpreter.flush();

    const notices = events.filter(
      (e) =>
        e.type === "transcript_entry" &&
        (e.entry.raw as { role?: string }).role === "notice",
    );
    expect(notices).toHaveLength(0);
  });

  it("tolerates a task_notification without a summary", async () => {
    const { events, onEvent } = collect();
    const interpreter = createClaudeExternalTurnInterpreter({ onEvent });

    interpreter.handleMessage({
      type: "system",
      subtype: "task_notification",
      task_id: "task-a",
      status: "completed",
      session_id: "s",
    } as never);
    interpreter.handleMessage({
      type: "assistant",
      uuid: "u1",
      message: { content: [{ type: "text", text: "woke" }] },
    } as never);
    await interpreter.flush();

    const notice = events.find(
      (e) =>
        e.type === "transcript_entry" &&
        (e.entry.raw as { role?: string }).role === "notice",
    );
    expect(notice).toBeDefined();
    const text = (notice as { entry: { raw: { content: [{ text: string }] } } })
      .entry.raw.content[0].text;
    expect(text).toBe(
      "Agent continued autonomously after background-task activity.",
    );
  });
});

describe("event handler ordering and flush", () => {
  it("serializes async handlers so queued-user acceptance settles before the assistant frame handler runs", async () => {
    const handled: string[] = [];
    let releaseAcceptance!: () => void;
    const acceptanceGate = new Promise<void>((r) => {
      releaseAcceptance = r;
    });
    const interpreter = createClaudeMessageInterpreter({
      onEvent: async (event) => {
        if (event.type === "input_accepted") {
          await acceptanceGate;
        }
        handled.push(event.type);
      },
    });

    interpreter.emitEvent({ type: "input_accepted" });
    interpreter.handleMessage({
      type: "assistant",
      uuid: "u1",
      message: { content: [{ type: "text", text: "hi" }] },
    } as never);

    await new Promise((r) => setTimeout(r, 0));
    expect(handled).toEqual([]);

    releaseAcceptance();
    await interpreter.flush();

    expect(handled[0]).toBe("input_accepted");
    expect(handled).toContain("content");
    expect(handled).toContain("transcript_entry");
    expect(handled.indexOf("input_accepted")).toBeLessThan(
      handled.indexOf("transcript_entry"),
    );
  });

  it("flush resolves only after every emitted event's handler settles", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let frameHandled = false;
    const interpreter = createClaudeMessageInterpreter({
      onEvent: async (event) => {
        if (event.type === "transcript_entry") {
          await gate;
          frameHandled = true;
        }
      },
    });

    interpreter.handleMessage({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      total_cost_usd: 0.01,
      num_turns: 1,
      result: "done",
    } as never);

    let flushed = false;
    const flushPromise = interpreter.flush().then(() => {
      flushed = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(flushed).toBe(false);

    release();
    await flushPromise;
    expect(frameHandled).toBe(true);
  });

  it("keeps delivering later events after a handler rejection", async () => {
    const handled: string[] = [];
    const interpreter = createClaudeMessageInterpreter({
      onEvent: async (event) => {
        if (event.type === "input_accepted") {
          throw new Error("append failed");
        }
        handled.push(event.type);
      },
    });

    interpreter.emitEvent({ type: "input_accepted" });
    interpreter.emitEvent({ type: "external_turn_started" });
    await interpreter.flush();

    expect(handled).toEqual(["external_turn_started"]);
  });

  it("routes external-interpreter frames and a trailing completed event through one ordered chain", async () => {
    const handled: string[] = [];
    let releaseFrames!: () => void;
    const frameGate = new Promise<void>((r) => {
      releaseFrames = r;
    });
    const interpreter = createClaudeExternalTurnInterpreter({
      onEvent: async (event) => {
        if (event.type === "transcript_entry") {
          await frameGate;
        }
        handled.push(event.type);
      },
    });

    interpreter.handleMessage({
      type: "assistant",
      uuid: "u1",
      message: { content: [{ type: "text", text: "woke" }] },
    } as never);
    interpreter.emitEvent({
      type: "external_turn_completed",
      result: {
        backendRef: { backend: "claude", ref: "sess-1" },
        costUsd: 0,
        durationMs: 0,
        numTurns: 1,
        contextTokens: null,
        contextWindowMax: null,
        contentBlocks: [],
        aborted: false,
        compacted: false,
        failure: null,
        continuationDisposition: "retain",
      },
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(handled).not.toContain("external_turn_completed");

    releaseFrames();
    await interpreter.flush();
    expect(handled[handled.length - 1]).toBe("external_turn_completed");
  });
});

describe("mapErrorSubtype", () => {
  it("maps error_max_turns", () => {
    expect(
      mapErrorSubtype({ subtype: "error_max_turns", num_turns: 50 } as never),
    ).toBe("Agent reached maximum turns (50)");
  });

  it("maps error_max_budget_usd", () => {
    expect(
      mapErrorSubtype({
        subtype: "error_max_budget_usd",
        total_cost_usd: 1.5,
      } as never),
    ).toBe("Agent exceeded budget limit ($1.50)");
  });

  it("maps error_max_structured_output_retries", () => {
    expect(
      mapErrorSubtype({
        subtype: "error_max_structured_output_retries",
      } as never),
    ).toBe("Agent exceeded structured output retry limit");
  });

  it("joins error_during_execution errors", () => {
    expect(
      mapErrorSubtype({
        subtype: "error_during_execution",
        errors: ["a", "b"],
      } as never),
    ).toBe("a; b");
  });

  it("falls back for error_during_execution with no errors", () => {
    expect(
      mapErrorSubtype({
        subtype: "error_during_execution",
        errors: [],
      } as never),
    ).toBe("Error during execution");
  });

  it("falls back for unknown subtypes", () => {
    expect(mapErrorSubtype({ subtype: "mystery" } as never)).toBe(
      "Unknown error",
    );
  });
});
