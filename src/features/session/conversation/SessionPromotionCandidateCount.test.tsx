// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { sessionKeys } from "@/lib/sessions/query-keys";
import type { MemoryReviewQueueEntry } from "@/lib/memory/schemas";
import SessionPromotionCandidateCount from "./SessionPromotionCandidateCount";

/**
 * The completion cue for spec R11: when a session ends, its durable notes are
 * either promoted to the project or die with the session's scope, and this is
 * the only passive signal that the decision is owed. It reads the upstream
 * per-session candidate contract rather than deriving candidacy itself.
 */

const CREATED_AT = "2026-08-30T00:00:00.000Z";

let api: FetchFixture;
/** Flipped by a test to model the merge that ends the incarnation. */
let sessionFinished: boolean;
/** What the candidate queue answers right now, re-read on every request. */
let currentCandidates: MemoryReviewQueueEntry[];

beforeEach(() => {
  api = installFetchFixture();
  sessionFinished = true;
  currentCandidates = [];
  // The count reads the incarnation from the session itself, so both halves of
  // its identity — created-at and whether it is over — come from one source
  // that the Library badge reads too.
  api.reply("GET", "/api/projects/cc/sessions/s1", () => ({
    json: {
      sessionName: "s1",
      worktreePath: "/w",
      branchName: "csm/s1",
      createdAt: CREATED_AT,
      lastActivityAt: CREATED_AT,
      finished: sessionFinished,
    },
  }));
  api.reply(
    "GET",
    /^\/api\/memory\/review\?project=cc&session=s1&promotionCandidates=true/,
    () => ({ json: { entries: currentCandidates } }),
  );
});
afterEach(() => {
  api.restore();
  cleanup();
});

function candidate(id: string): MemoryReviewQueueEntry {
  return {
    note: {
      id,
      slug: `note-${id}`,
      scope: "session",
      projectPath: "/repos/cc",
      sessionName: "s1",
      sessionCreatedAt: CREATED_AT,
      kind: "lesson",
      hook: "a lesson worth keeping",
      body: "",
      statusNote: null,
      aliases: [],
      indexMode: "auto",
      lifecycle: "active",
      reviewAfter: null,
      expiresAt: null,
      supersedesId: null,
      supersededById: null,
      createdBy: "agent",
      authorConversationId: "conv-1",
      revision: 1,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    staleness: [],
    noteReviewDue: false,
    statusReviewDue: false,
    expired: false,
    promotionCandidate: true,
  };
}

function stubCandidates(entries: MemoryReviewQueueEntry[]) {
  currentCandidates = entries;
}

function render(queryClient = createTestQueryClient()) {
  return {
    queryClient,
    ...renderWithQuery(
      <SessionPromotionCandidateCount projectName="cc" sessionName="s1" />,
      queryClient,
    ),
  };
}

describe("SessionPromotionCandidateCount", () => {
  it("shows the count of this incarnation's promotion candidates", async () => {
    stubCandidates([candidate("mem-a"), candidate("mem-b")]);
    render();

    expect(
      await screen.findByText("2 memory notes await promotion"),
    ).toBeInTheDocument();
  });

  it("says nothing when the session leaves no promotion decision owed", async () => {
    stubCandidates([]);
    const { container } = render();

    await waitFor(() =>
      expect(
        api.requestsTo("GET", /^\/api\/memory\/review\?/),
      ).not.toHaveLength(0),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("asks for the exact incarnation, not the reusable session name", async () => {
    // A later session that takes the same name is a different incarnation and
    // owns none of these notes, so the created-at travels with the name.
    stubCandidates([candidate("mem-a")]);
    render();
    await screen.findByText("1 memory note awaits promotion");

    const request = api.requestsTo("GET", /^\/api\/memory\/review\?/)[0];
    expect(request?.searchParams.get("sessionName")).toBe("s1");
    expect(request?.searchParams.get("sessionCreatedAt")).toBe(CREATED_AT);
  });
});

describe("SessionPromotionCandidateCount — completion transition", () => {
  it("does not reuse the empty queue computed while the session was running", async () => {
    // Candidacy is DERIVED from the incarnation being over, and that transition
    // writes no note — so no memory-changed frame accompanies it. A cache keyed
    // only on which incarnation this is would serve the running session's empty
    // answer for the whole staleTime after the merge, which is exactly when the
    // decision is owed.
    sessionFinished = false;
    stubCandidates([]);
    const { queryClient } = render();

    await waitFor(() =>
      expect(
        api.requestsTo("GET", /^\/api\/memory\/review\?/),
      ).not.toHaveLength(0),
    );
    expect(screen.queryByText(/awaits promotion/u)).toBeNull();

    // The merge lands: the session becomes finished and its durable notes
    // become candidates. The app already refreshes the session detail on that
    // transition; nothing invalidates the memory queue.
    sessionFinished = true;
    stubCandidates([candidate("mem-a")]);
    await queryClient.invalidateQueries({
      queryKey: sessionKeys.detail("cc", "s1"),
    });

    expect(
      await screen.findByText("1 memory note awaits promotion"),
    ).toBeInTheDocument();
  });
});
