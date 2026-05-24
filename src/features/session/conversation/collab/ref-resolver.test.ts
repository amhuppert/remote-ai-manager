import { describe, expect, it } from "vitest";
import {
  canonicalReportPath,
  canonicalizeReviewRef,
  resolveRefToDocumentId,
} from "@/features/session/conversation/collab/ref-resolver";

interface RefDoc {
  id: string;
  filePath: string;
}

const docs: RefDoc[] = [
  {
    id: "doc-claude-r1",
    filePath: "memory-bank/collaboration/wf-1/round-1/claude/report.md",
  },
  {
    id: "doc-codex-r1",
    filePath: "memory-bank/collaboration/wf-1/round-1/codex/report.md",
  },
  {
    id: "doc-claude-r2",
    filePath: "memory-bank/collaboration/wf-1/round-2/claude/report.md",
  },
  {
    id: "doc-merged",
    filePath: "memory-bank/collaboration/wf-1/merged-design.md",
  },
];

describe("resolveRefToDocumentId", () => {
  it("strips line anchor before matching", () => {
    expect(
      resolveRefToDocumentId(
        "memory-bank/collaboration/wf-1/round-1/codex/report.md#L42",
        docs,
      ),
    ).toBe("doc-codex-r1");
  });

  it("matches absolute project-relative ref by exact filePath", () => {
    expect(
      resolveRefToDocumentId(
        "memory-bank/collaboration/wf-1/round-2/claude/report.md",
        docs,
      ),
    ).toBe("doc-claude-r2");
  });

  it("prefers an exact match over a lex-greater suffix candidate", () => {
    const docsWithEarlyRoundAndLaterSuffix: RefDoc[] = [
      {
        id: "doc-r1",
        filePath: "memory-bank/collaboration/wf-1/round-1/codex/report.md",
      },
      {
        id: "doc-r2-with-longer-path",
        filePath:
          "memory-bank/collaboration/wf-1/round-2/codex/report.md/round-1/codex/report.md",
      },
    ];
    expect(
      resolveRefToDocumentId(
        "memory-bank/collaboration/wf-1/round-1/codex/report.md",
        docsWithEarlyRoundAndLaterSuffix,
      ),
    ).toBe("doc-r1");
  });

  it("falls back to suffix match when no exact match exists", () => {
    expect(resolveRefToDocumentId("codex/report.md", docs)).toBe(
      "doc-codex-r1",
    );
  });

  it("suffix-match prefers the latest round when multiple documents end with the same suffix", () => {
    expect(resolveRefToDocumentId("claude/report.md", docs)).toBe(
      "doc-claude-r2",
    );
  });

  it("returns null when no document matches the ref path suffix", () => {
    expect(resolveRefToDocumentId("never/exists.md", docs)).toBeNull();
  });

  it("returns null for empty/blank ref strings", () => {
    expect(resolveRefToDocumentId("", docs)).toBeNull();
    expect(resolveRefToDocumentId("   ", docs)).toBeNull();
  });
});

describe("canonicalizeReviewRef", () => {
  it("expands a report-relative ref using the round context", () => {
    expect(
      canonicalizeReviewRef("codex/report.md#L42", {
        workflowId: "wf-1",
        roundNumber: 2,
      }),
    ).toBe("memory-bank/collaboration/wf-1/round-2/codex/report.md#L42");
  });

  it("keeps refs that already include claude|codex/round-N/ but adds the workflow prefix", () => {
    expect(
      canonicalizeReviewRef("claude/round-1/report.md", {
        workflowId: "wf-1",
        roundNumber: 3,
      }),
    ).toBe("memory-bank/collaboration/wf-1/claude/round-1/report.md");
  });

  it("returns refs that already start with memory-bank/ unchanged", () => {
    expect(
      canonicalizeReviewRef(
        "memory-bank/collaboration/wf-1/round-2/codex/report.md#L7",
        { workflowId: "wf-1", roundNumber: 4 },
      ),
    ).toBe("memory-bank/collaboration/wf-1/round-2/codex/report.md#L7");
  });

  it("preserves the line anchor", () => {
    expect(
      canonicalizeReviewRef("codex/report.md#L42", {
        workflowId: "wf-1",
        roundNumber: 2,
      }),
    ).toContain("#L42");
  });

  it("returns blank refs untouched", () => {
    expect(
      canonicalizeReviewRef("", { workflowId: "wf-1", roundNumber: 1 }),
    ).toBe("");
  });

  it("makes refs round-aware: round-1 and round-2 reviews resolve to different documents", () => {
    const round1Ref = canonicalizeReviewRef("codex/report.md", {
      workflowId: "wf-1",
      roundNumber: 1,
    });
    const round2Ref = canonicalizeReviewRef("codex/report.md", {
      workflowId: "wf-1",
      roundNumber: 2,
    });
    expect(resolveRefToDocumentId(round1Ref, docs)).toBe("doc-codex-r1");
    // round-2 codex doc isn't in the fixture; the resolver should return null
    // rather than incorrectly reporting the round-1 document.
    expect(resolveRefToDocumentId(round2Ref, docs)).toBeNull();
  });
});

describe("canonicalReportPath", () => {
  it("matches the canonical layout written by registerRoundArtifacts", () => {
    expect(canonicalReportPath("wf-1", 2, "codex")).toBe(
      "memory-bank/collaboration/wf-1/round-2/codex/report.md",
    );
  });
});
