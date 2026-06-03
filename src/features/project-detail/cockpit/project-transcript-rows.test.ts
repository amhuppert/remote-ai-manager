import { describe, it, expect } from "vitest";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import {
  buildProjectTranscriptRows,
  projectRowKey,
} from "./project-transcript-rows";
import type { SpawnCardRowData } from "./spawn-card-slot";

function msg(role: "user" | "assistant", text: string): TranscriptMessage {
  return { role, content: [{ type: "text", text }], timestamp: null };
}

const m0 = msg("user", "zero");
const m1 = msg("assistant", "one");
const m2 = msg("user", "two");

describe("buildProjectTranscriptRows", () => {
  it("returns messages only when there are no spawn cards", () => {
    const rows = buildProjectTranscriptRows([m0, m1, m2], []);
    expect(rows).toEqual([
      { kind: "message", messageIndex: 0, msg: m0 },
      { kind: "message", messageIndex: 1, msg: m1 },
      { kind: "message", messageIndex: 2, msg: m2 },
    ]);
  });

  it("interleaves a spawn card immediately after its anchor message", () => {
    const card: SpawnCardRowData = {
      kind: "spawn-card",
      proposalId: "p1",
      anchorMessageIndex: 1,
    };
    const rows = buildProjectTranscriptRows([m0, m1, m2], [card]);
    expect(rows.map((r) => r.kind)).toEqual([
      "message",
      "message",
      "spawn-card",
      "message",
    ]);
    expect(rows[2]).toBe(card);
  });

  it("preserves message order with cards interleaved", () => {
    const card: SpawnCardRowData = {
      kind: "spawn-card",
      proposalId: "p1",
      anchorMessageIndex: 0,
    };
    const rows = buildProjectTranscriptRows([m0, m1, m2], [card]);
    const messageIndexes = rows
      .filter((r) => r.kind === "message")
      .map((r) => (r.kind === "message" ? r.messageIndex : -1));
    expect(messageIndexes).toEqual([0, 1, 2]);
  });

  it("appends cards anchored at or beyond the last message", () => {
    const card: SpawnCardRowData = {
      kind: "spawn-card",
      proposalId: "pEnd",
      anchorMessageIndex: 99,
    };
    const rows = buildProjectTranscriptRows([m0, m1], [card]);
    expect(rows[rows.length - 1]).toBe(card);
  });

  it("keeps supplied order for multiple cards at the same anchor", () => {
    const a: SpawnCardRowData = {
      kind: "spawn-card",
      proposalId: "a",
      anchorMessageIndex: 0,
    };
    const b: SpawnCardRowData = {
      kind: "spawn-card",
      proposalId: "b",
      anchorMessageIndex: 0,
    };
    const rows = buildProjectTranscriptRows([m0], [a, b]);
    expect(rows).toEqual([{ kind: "message", messageIndex: 0, msg: m0 }, a, b]);
  });

  it("handles spawn cards with no messages by rendering the cards", () => {
    const card: SpawnCardRowData = {
      kind: "spawn-card",
      proposalId: "p1",
      anchorMessageIndex: 0,
    };
    const rows = buildProjectTranscriptRows([], [card]);
    expect(rows).toEqual([card]);
  });
});

describe("projectRowKey", () => {
  it("produces a stable key for a spawn card from its proposalId", () => {
    const card: SpawnCardRowData = {
      kind: "spawn-card",
      proposalId: "p-42",
      anchorMessageIndex: 3,
    };
    expect(projectRowKey(card)).toBe("spawn:p-42");
  });

  it("produces a stable key for a message across calls", () => {
    const row = { kind: "message" as const, messageIndex: 2, msg: m2 };
    const k1 = projectRowKey(row);
    const k2 = projectRowKey(row);
    expect(k1).toBe(k2);
    expect(k1).toContain("2:user");
  });

  it("distinguishes messages at different indexes", () => {
    const r0 = { kind: "message" as const, messageIndex: 0, msg: m0 };
    const r1 = { kind: "message" as const, messageIndex: 1, msg: m1 };
    expect(projectRowKey(r0)).not.toBe(projectRowKey(r1));
  });
});
