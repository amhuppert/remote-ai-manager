import { describe, expect, it } from "vitest";
import { compactionEnvelopeSchema } from "./schemas";
import {
  compactionEnvelopeToMarkdown,
  type CompactionRenderMeta,
} from "./render-markdown";

const envelope = compactionEnvelopeSchema.parse({
  schemaVersion: 1,
  kind: "conversation_compaction",
  source: {
    projectName: "command-center",
    sessionName: "Workflow review",
    conversationId: "conv-1",
    coveredStartSeq: 0,
    coveredEndSeq: 788,
    messageCount: 4,
    sourceHash: "abc",
  },
  agentBrief: "Full audit of execution 7b35d37a.",
  currentState: {
    status: "complete",
    latestUserGoal: "Identify open audit items.",
    nextBestActions: ["Fix background tasks", "Fix env injection"],
  },
  decisions: [
    {
      statement: "Cost double-count is real.",
      rationale: "Verified arithmetically.",
      status: "accepted",
      sourceRefs: [
        { messageIndex: 1, messageId: null, seqStart: 609, seqEnd: 621 },
        { messageIndex: 3, messageId: null, seqStart: 788, seqEnd: 788 },
      ],
    },
    {
      statement: "Ship without backfill.",
      status: "superseded",
      sourceRefs: [
        { messageIndex: 3, messageId: null, seqStart: 788, seqEnd: 788 },
      ],
    },
  ],
  files: [
    {
      path: "docs/reports/audit.md",
      role: "created",
      details: "Full audit report.",
      sourceRefs: [
        { messageIndex: 1, messageId: null, seqStart: 737, seqEnd: 740 },
      ],
    },
  ],
  commands: [
    {
      command: "bun run workflow:audit",
      outcome: "succeeded",
      summary: "Extractor produced structured audit data.",
      sourceRefs: [
        { messageIndex: 1, messageId: null, seqStart: 14, seqEnd: 15 },
      ],
    },
  ],
  openQuestions: [],
  blockers: [
    {
      text: "Turn-end kills background tasks.",
      sourceRefs: [
        { messageIndex: 3, messageId: null, seqStart: 788, seqEnd: 788 },
      ],
    },
  ],
  omissions: { reasoningOmitted: true, largeToolOutputsElided: 18 },
  extras: { wallClockH: "9h10m" },
});

const freshMeta: CompactionRenderMeta = {
  stale: false,
  staleBehindMessages: 0,
  outdated: false,
  updatedAt: "2026-07-06T03:52:36.964Z",
};

describe("compactionEnvelopeToMarkdown", () => {
  it("renders the header with identity, freshness, and coverage", () => {
    const md = compactionEnvelopeToMarkdown(envelope, freshMeta);
    expect(md).toContain(
      "# Compaction — command-center / Workflow review / conv-1",
    );
    expect(md).toContain("fresh");
    expect(md).toContain("covered seq 0..788");
    expect(md).toContain("4 messages");
    expect(md).toContain("updated 2026-07-06T03:52:36.964Z");
  });

  it("reports staleness in the header", () => {
    const md = compactionEnvelopeToMarkdown(envelope, {
      ...freshMeta,
      stale: true,
      staleBehindMessages: 2,
    });
    expect(md).toContain("stale (behind 2 messages)");
  });

  it("renders brief, current state, and numbered next actions", () => {
    const md = compactionEnvelopeToMarkdown(envelope, freshMeta);
    expect(md).toContain("## Agent brief\nFull audit of execution 7b35d37a.");
    expect(md).toContain("## Current state — complete");
    expect(md).toContain("Goal: Identify open audit items.");
    expect(md).toContain("1. Fix background tasks");
    expect(md).toContain("2. Fix env injection");
  });

  it("renders decisions with seq-anchored refs and non-accepted statuses", () => {
    const md = compactionEnvelopeToMarkdown(envelope, freshMeta);
    expect(md).toContain("Cost double-count is real.");
    expect(md).toContain("Verified arithmetically.");
    expect(md).toContain("#1 s609–621");
    expect(md).toContain("#3 s788");
    expect(md).toContain("(superseded)");
    expect(md).not.toContain("(accepted)");
  });

  it("renders files, commands, and blockers; omits empty sections", () => {
    const md = compactionEnvelopeToMarkdown(envelope, freshMeta);
    expect(md).toContain(
      "created `docs/reports/audit.md` — Full audit report.",
    );
    expect(md).toContain("`bun run workflow:audit` — succeeded");
    expect(md).toContain("## Blockers");
    expect(md).toContain("Turn-end kills background tasks.");
    expect(md).not.toContain("## Open questions");
  });

  it("renders omissions and extras, omitting extras when empty", () => {
    const md = compactionEnvelopeToMarkdown(envelope, freshMeta);
    expect(md).toContain("large tool outputs elided: 18");
    expect(md).toContain("## Extras");
    expect(md).toContain("wallClockH");

    const bare = compactionEnvelopeToMarkdown(
      { ...envelope, extras: {} },
      freshMeta,
    );
    expect(bare).not.toContain("## Extras");
  });
});
