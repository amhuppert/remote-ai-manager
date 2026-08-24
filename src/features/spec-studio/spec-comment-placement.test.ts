import { describe, expect, it } from "vitest";

import type { SpecThreadAnchorState } from "@/components/document-viewer/annotation-contract";
import { assembleSpecCommentThreads } from "@/lib/specs/comment-threads";
import type {
  SpecRevisionElement,
  SpecRevisionSnapshot,
} from "@/lib/specs/schemas";
import type { SpecCommentView } from "@/lib/specs/view-schemas";

import { partitionSpecCommentThreads } from "./spec-comment-placement";

const ANCHOR = {
  sectionId: "overview",
  headingLabel: "Overview",
  line: 3,
  charStart: 0,
  charEnd: 16,
  quote: "durable feedback",
  prefix: "",
  suffix: "",
  docRevision: "revision-2",
};

function element(
  id: string,
  kind: "section" | "requirement",
  position: number,
): SpecRevisionElement {
  const payload =
    kind === "section"
      ? {
          kind,
          role: "intent_problem" as const,
          title: "Overview",
          body: "durable feedback",
        }
      : {
          kind: "requirement" as const,
          statement: "durable feedback",
          priority: "must" as const,
          risk: "low" as const,
        };
  return {
    element: {
      id,
      specId: "spec-1",
      kind,
      number: position + 1,
      parentElementId: null,
      createdAt: "2026-08-22T10:00:00.000Z",
    },
    version: {
      revisionId: "revision-2",
      elementId: id,
      position,
      payload,
      payloadHash: `hash-${id}`,
      elementVersion: 1,
      createdAt: "2026-08-22T10:00:00.000Z",
      updatedAt: "2026-08-22T10:00:00.000Z",
    },
  };
}

const SNAPSHOT = {
  revision: {
    id: "revision-2",
    specId: "spec-1",
    number: 2,
    state: "proposed",
    authoringStage: "requirements",
    basedOnRevisionId: "revision-1",
    contentHash: "hash-revision-2",
    citationContractVersion: 2,
    citationVersion: 1,
    citationHash: "0".repeat(64),
    proposedAt: "2026-08-22T10:00:00.000Z",
    approvedAt: null,
    externalDelivery: null,
    createdAt: "2026-08-22T10:00:00.000Z",
  },
  elements: [
    element("section-1", "section", 0),
    element("requirement-1", "requirement", 1),
  ],
  assumptionCitations: [],
} satisfies SpecRevisionSnapshot;

function row(
  threadId: string,
  elementId: string,
  overrides: Partial<SpecCommentView> = {},
): SpecCommentView {
  return {
    id: `comment-${threadId}`,
    threadId,
    parentCommentId: null,
    elementId,
    handle: elementId === "requirement-1" ? "R1" : null,
    revisionId: "revision-2",
    revisionNumber: 2,
    anchor: ANCHOR,
    quote: ANCHOR.quote,
    body: `Body for ${threadId}`,
    author: { kind: "human" },
    blocking: false,
    resolution: "open",
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

function threads(...rows: SpecCommentView[]) {
  return assembleSpecCommentThreads(rows);
}

function concreteAnchorState(state: SpecThreadAnchorState): string {
  return state.status;
}

describe("partitionSpecCommentThreads", () => {
  it("co-locates current section roots in Overview and defers structured roots to Review", () => {
    const partition = partitionSpecCommentThreads({
      surface: "overview",
      reviewHostAvailable: true,
      viewedSnapshot: SNAPSHOT,
      threads: threads(
        row("section", "section-1"),
        row("requirement", "requirement-1"),
      ),
    });

    expect(partition.coLocated.map(({ thread }) => thread.threadId)).toEqual([
      "section",
    ]);
    expect(partition.deferred.map(({ threadId }) => threadId)).toEqual([
      "requirement",
    ]);
    expect(partition.fallback).toEqual([]);
  });

  it("co-locates current section and structured roots with their Review cards", () => {
    const partition = partitionSpecCommentThreads({
      surface: "review",
      viewedSnapshot: SNAPSHOT,
      threads: threads(
        row("section", "section-1"),
        row("requirement", "requirement-1"),
      ),
    });

    expect(
      new Set(partition.coLocated.map(({ thread }) => thread.threadId)),
    ).toEqual(new Set(["section", "requirement"]));
    expect(partition.fallback).toEqual([]);
  });

  it("falls back current structured roots in Overview when Review has no live host", () => {
    const partition = partitionSpecCommentThreads({
      surface: "overview",
      reviewHostAvailable: false,
      viewedSnapshot: SNAPSHOT,
      threads: threads(row("requirement", "requirement-1")),
    });

    expect(partition.deferred).toEqual([]);
    expect(partition.fallback[0]).toMatchObject({
      thread: { threadId: "requirement" },
      element: { element: { id: "requirement-1" } },
      fallbackReason: "unsupported-host",
    });
  });

  it("falls back historical, removed, invalid-anchor, and invalid-thread roots exactly once", () => {
    const invalidShapeRows = [
      row("invalid-shape", "section-1", { id: "invalid-root-1" }),
      row("invalid-shape", "section-1", { id: "invalid-root-2" }),
    ];
    const partition = partitionSpecCommentThreads({
      surface: "overview",
      reviewHostAvailable: true,
      viewedSnapshot: SNAPSHOT,
      threads: threads(
        row("historical", "section-1", {
          revisionId: "revision-1",
          revisionNumber: 1,
        }),
        row("removed", "removed-element"),
        row("invalid-anchor", "section-1", { anchor: { opaque: true } }),
        ...invalidShapeRows,
      ),
    });

    expect(
      Object.fromEntries(
        partition.fallback.map(({ thread, fallbackReason }) => [
          thread.threadId,
          fallbackReason,
        ]),
      ),
    ).toEqual({
      historical: "historical-revision",
      removed: "removed-element",
      "invalid-anchor": "invalid-anchor",
      "invalid-shape": "invalid-thread",
    });
    expect(
      concreteAnchorState(
        partition.fallback.find(({ thread }) => thread.threadId === "removed")!
          .anchorState,
      ),
    ).toBe("orphaned");
    expect(
      new Set(partition.fallback.map(({ thread }) => thread.threadId)).size,
    ).toBe(partition.fallback.length);
  });

  it("uses concrete host anchor states and never returns a claimed thread in fallback", () => {
    const anchorStates = new Map<string, SpecThreadAnchorState>([
      ["section", { status: "reanchored", charStart: 4, charEnd: 20 }],
    ]);
    const partition = partitionSpecCommentThreads({
      surface: "overview",
      reviewHostAvailable: true,
      viewedSnapshot: SNAPSHOT,
      threads: threads(row("section", "section-1")),
      anchorStates,
    });

    expect(concreteAnchorState(partition.coLocated[0]!.anchorState)).toBe(
      "reanchored",
    );
    expect([...partition.claimedThreadIds]).toEqual(["section"]);
    expect(
      partition.fallback.some(({ thread }) =>
        partition.claimedThreadIds.has(thread.threadId),
      ),
    ).toBe(false);
  });
});
