import { describe, it, expect } from "vitest";
import {
  findActiveCollab,
  findCollabEnvelopeForConversation,
  latestFinalAnswerText,
  findCollabFinalDuplicateIndex,
  type CollabEnvelopeLike,
} from "./page-helpers";
import type { CollaborationArtifact } from "@/lib/workflows/collaboration/types";
import type { TranscriptMessage } from "@/lib/conversations/schemas";

describe("findActiveCollab", () => {
  const envelopes: CollabEnvelopeLike[] = [
    {
      status: "completed",
      featureSnapshot: { conversationId: "c1" },
    },
    {
      status: "running",
      featureSnapshot: { conversationId: "c2" },
    },
    {
      status: "paused",
      featureSnapshot: { conversationId: "c3" },
    },
  ];

  it("returns running envelope matching conversation", () => {
    expect(findActiveCollab(envelopes, "c2")?.status).toBe("running");
  });

  it("returns paused envelope matching conversation", () => {
    expect(findActiveCollab(envelopes, "c3")?.status).toBe("paused");
  });

  it("ignores completed/failed envelopes", () => {
    expect(findActiveCollab(envelopes, "c1")).toBeUndefined();
  });

  it("returns undefined when envelopes is undefined", () => {
    expect(findActiveCollab(undefined, "c2")).toBeUndefined();
  });
});

describe("findCollabEnvelopeForConversation", () => {
  it("prefers active over terminal envelopes", () => {
    const envelopes: CollabEnvelopeLike[] = [
      { status: "completed", featureSnapshot: { conversationId: "c1" } },
      { status: "running", featureSnapshot: { conversationId: "c1" } },
    ];
    expect(findCollabEnvelopeForConversation(envelopes, "c1")?.status).toBe(
      "running",
    );
  });

  it("returns latest terminal when no active envelope matches", () => {
    const envelopes: CollabEnvelopeLike[] = [
      { status: "completed", featureSnapshot: { conversationId: "c1" } },
      { status: "failed", featureSnapshot: { conversationId: "c1" } },
    ];
    expect(findCollabEnvelopeForConversation(envelopes, "c1")?.status).toBe(
      "failed",
    );
  });
});

describe("latestFinalAnswerText", () => {
  it("returns last final_answer text", () => {
    const artifacts: CollaborationArtifact[] = [
      { kind: "final_answer", answer: "first" } as CollaborationArtifact,
      { kind: "final_answer", answer: "second" } as CollaborationArtifact,
    ];
    expect(latestFinalAnswerText(artifacts)).toBe("second");
  });

  it("returns null when no final_answer", () => {
    expect(latestFinalAnswerText([])).toBeNull();
  });
});

describe("findCollabFinalDuplicateIndex", () => {
  it("returns null when finalAnswerText is null", () => {
    const messages: TranscriptMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "/collab hi" }],
      } as TranscriptMessage,
    ];
    expect(findCollabFinalDuplicateIndex(messages, null)).toBeNull();
  });

  it("returns null when finalAnswerText is empty/whitespace", () => {
    const messages: TranscriptMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "/collab hi" }],
      } as TranscriptMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
      } as TranscriptMessage,
    ];
    expect(findCollabFinalDuplicateIndex(messages, "   ")).toBeNull();
  });

  it("returns null when no /collab user message is found", () => {
    const messages: TranscriptMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
      } as TranscriptMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "answer text" }],
      } as TranscriptMessage,
    ];
    expect(findCollabFinalDuplicateIndex(messages, "answer text")).toBeNull();
  });

  it("returns null when no assistant message matches the final answer", () => {
    const messages: TranscriptMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "/collab brief" }],
      } as TranscriptMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "different reply" }],
      } as TranscriptMessage,
    ];
    expect(findCollabFinalDuplicateIndex(messages, "answer text")).toBeNull();
  });

  it("returns the index of the duplicate assistant message", () => {
    const messages: TranscriptMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "/collab my brief" }],
      } as TranscriptMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "answer text" }],
      } as TranscriptMessage,
    ];
    expect(findCollabFinalDuplicateIndex(messages, "answer text")).toBe(1);
  });

  it("only considers assistant messages AFTER the latest /collab user message", () => {
    const messages: TranscriptMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "answer text" }],
      } as TranscriptMessage,
      {
        role: "user",
        content: [{ type: "text", text: "/collab brief" }],
      } as TranscriptMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: "answer text" }],
      } as TranscriptMessage,
    ];
    expect(findCollabFinalDuplicateIndex(messages, "answer text")).toBe(2);
  });
});
