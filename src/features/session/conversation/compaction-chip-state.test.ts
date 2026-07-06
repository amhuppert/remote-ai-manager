import { describe, it, expect } from "vitest";
import {
  deriveCompactionChipState,
  compactionChipLabel,
  type CompactionChipState,
} from "./compaction-chip-state";
import { buildArtifactListItem } from "@/components/context-artifacts/fixtures";
import type { ContextArtifactListItem } from "@/lib/context-artifacts/queries";

function conversationRow(
  overrides: Partial<ContextArtifactListItem> = {},
): ContextArtifactListItem {
  return buildArtifactListItem({
    kind: "conversation_compaction",
    messageIndex: null,
    messageId: null,
    ...overrides,
  });
}

describe("deriveCompactionChipState", () => {
  const cases: Array<{
    name: string;
    rows: ContextArtifactListItem[] | undefined;
    expected: CompactionChipState;
  }> = [
    {
      name: "undefined rows → none",
      rows: undefined,
      expected: { kind: "none" },
    },
    { name: "empty list → none", rows: [], expected: { kind: "none" } },
    {
      name: "only message artifacts → none",
      rows: [buildArtifactListItem()],
      expected: { kind: "none" },
    },
    {
      name: "pending row → pending",
      rows: [conversationRow({ status: "pending" })],
      expected: { kind: "pending" },
    },
    {
      name: "failed row → failed",
      rows: [conversationRow({ status: "failed", error: "boom" })],
      expected: { kind: "failed" },
    },
    {
      name: "complete + outdated → outdated (outranks stale)",
      rows: [
        conversationRow({
          outdated: true,
          stale: true,
          staleBehindMessages: 4,
        }),
      ],
      expected: { kind: "outdated" },
    },
    {
      name: "complete + stale → stale with behind count",
      rows: [conversationRow({ stale: true, staleBehindMessages: 7 })],
      expected: { kind: "stale", behind: 7 },
    },
    {
      name: "complete, current → fresh",
      rows: [conversationRow()],
      expected: { kind: "fresh" },
    },
    {
      name: "conversation row found among message rows",
      rows: [
        buildArtifactListItem(),
        conversationRow({ stale: true, staleBehindMessages: 2 }),
      ],
      expected: { kind: "stale", behind: 2 },
    },
  ];

  it.each(cases)("$name", ({ rows, expected }) => {
    expect(deriveCompactionChipState(rows)).toEqual(expected);
  });
});

describe("compactionChipLabel", () => {
  const cases: Array<{ state: CompactionChipState; label: string }> = [
    { state: { kind: "none" }, label: "No compact" },
    { state: { kind: "pending" }, label: "Compacting…" },
    { state: { kind: "fresh" }, label: "Fresh" },
    { state: { kind: "stale", behind: 3 }, label: "Stale (behind 3)" },
    { state: { kind: "outdated" }, label: "Outdated" },
    { state: { kind: "failed" }, label: "Failed" },
  ];

  it.each(cases)("$state.kind → $label", ({ state, label }) => {
    expect(compactionChipLabel(state)).toBe(label);
  });
});
