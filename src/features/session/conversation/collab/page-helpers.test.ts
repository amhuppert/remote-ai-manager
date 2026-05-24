import { describe, it, expect } from "vitest";
import {
  findActiveCollab,
  findCollabEnvelopeForConversation,
  latestFinalAnswerText,
  dedupeCollabFinalTranscriptMessage,
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

describe("dedupeCollabFinalTranscriptMessage", () => {
  it("returns messages unchanged when finalAnswerText is null", () => {
    const messages: TranscriptMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "/collab hi" }],
      } as TranscriptMessage,
    ];
    expect(dedupeCollabFinalTranscriptMessage(messages, null)).toBe(messages);
  });

  it("strips duplicate assistant message matching final answer", () => {
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
    const result = dedupeCollabFinalTranscriptMessage(messages, "answer text");
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("user");
  });
});
