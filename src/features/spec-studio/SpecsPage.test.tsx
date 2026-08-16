// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore, type ReactNode } from "react";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import type { SpecApprovalRow } from "@/lib/specs/schemas";
import { registerSpecSseReactions } from "@/lib/specs/sse-reactions";

import SpecDetailPage from "./SpecDetailPage";
import {
  _blockAnnotatableTextForTesting,
  _rangeFromBlockOffsetsForTesting,
  _resetAnnotatorBoundaryForTesting,
  _setAnnotatorBoundaryForTesting,
} from "@/components/document-viewer/AnnotatedMarkdown";

const routerReplace = vi.fn();
const routerPush = vi.fn();
let pathname = "/specs";
let routeParams = { projectName: "command-center", slug: "native-sdd" };

/**
 * A soft-navigation fake: `next/link` clicks and `router.replace` rewrite the
 * jsdom URL and wake every `useSearchParams` reader, exactly as the App Router
 * does when a route stays mounted. Without the subscription a URL change is
 * invisible to React, so a same-page link would look broken in every test.
 */
const urlSubscribers = new Set<() => void>();
let urlVersion = 0;

function navigateInPlace(href: string): void {
  window.history.pushState({}, "", href);
  urlVersion += 1;
  for (const notify of [...urlSubscribers]) notify();
}

function subscribeToUrl(notify: () => void): () => void {
  urlSubscribers.add(notify);
  return () => {
    urlSubscribers.delete(notify);
  };
}

function readUrlVersion(): number {
  return urlVersion;
}

function useFakeSearchParams(): URLSearchParams {
  useSyncExternalStore(subscribeToUrl, readUrlVersion, readUrlVersion);
  return new URLSearchParams(window.location.search);
}

vi.mock("next/navigation", () => ({
  useParams: () => routeParams,
  usePathname: () => pathname,
  useRouter: () => ({
    push: routerPush,
    replace: (href: string) => {
      routerReplace(href);
      navigateInPlace(href);
    },
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => useFakeSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        navigateInPlace(href);
      }}
    >
      {children}
    </a>
  ),
}));

const NOW = "2026-07-18T12:00:00.000Z";

function spec(slug: string, name: string) {
  return {
    id: `spec-${slug}`,
    projectPath: "/repos/command-center",
    slug,
    name,
    gatePolicy: { preset: "contract-bearing" },
    abandonedAt: null,
    abandonedReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const executingSpec = spec("native-sdd", "Native spec-driven development");

const detailRevision = {
  id: "revision-4",
  specId: executingSpec.id,
  number: 4,
  state: "proposed",
  authoringStage: "plan",
  basedOnRevisionId: "revision-3",
  contentHash: "revision-4-hash",
  proposedAt: NOW,
  approvedAt: null,
  createdAt: NOW,
} as const;

function detailPayload(
  sectionBody = "Lifecycle spine: draft, review, execution, delivery.",
  delivery = {
    allWaived: false,
    deliveredCount: 7,
    provenCount: 7,
    deliveredExternallyCriterionIds: [] as string[],
    totalInScope: 12,
  },
) {
  return {
    spec: executingSpec,
    aliases: [],
    revisions: [detailRevision],
    baseRevision: null,
    currentRevision: {
      revision: detailRevision,
      elements: [
        {
          element: {
            id: "section-intent",
            specId: executingSpec.id,
            kind: "section",
            number: null,
            parentElementId: null,
            createdAt: NOW,
          },
          version: {
            revisionId: detailRevision.id,
            elementId: "section-intent",
            position: 0,
            payload: {
              kind: "section",
              role: "intent_problem",
              title: "Intent",
              body: sectionBody,
            },
            payloadHash: `hash-${sectionBody}`,
            elementVersion: 2,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
        {
          element: {
            id: "requirement-1",
            specId: executingSpec.id,
            kind: "requirement",
            number: 1,
            parentElementId: null,
            createdAt: NOW,
          },
          version: {
            revisionId: detailRevision.id,
            elementId: "requirement-1",
            position: 1,
            payload: {
              kind: "requirement",
              statement: "Every spec has a stable address.",
              priority: "must",
              risk: "high",
            },
            payloadHash: "requirement-1-hash",
            elementVersion: 2,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
        {
          element: {
            id: "criterion-1",
            specId: executingSpec.id,
            kind: "criterion",
            number: 1,
            parentElementId: "requirement-1",
            createdAt: NOW,
          },
          version: {
            revisionId: detailRevision.id,
            elementId: "criterion-1",
            position: 2,
            payload: {
              kind: "criterion",
              text: "Old links resolve through aliases.",
              validationStrategy: { kinds: ["test_run"] },
            },
            payloadHash: "criterion-1-hash",
            elementVersion: 2,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
        {
          element: {
            id: "decision-1",
            specId: executingSpec.id,
            kind: "decision",
            number: 1,
            parentElementId: null,
            createdAt: NOW,
          },
          version: {
            revisionId: detailRevision.id,
            elementId: "decision-1",
            position: 3,
            payload: {
              kind: "decision",
              title: "Alias-aware resolution",
              chosenApproach: "Resolve through the spec repository.",
              rejectedAlternatives: [],
              reason: "References remain stable.",
              tracedRequirementElementIds: ["requirement-1"],
            },
            payloadHash: "decision-1-hash",
            elementVersion: 2,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
        {
          element: {
            id: "task-1",
            specId: executingSpec.id,
            kind: "task",
            number: 1,
            parentElementId: null,
            createdAt: NOW,
          },
          version: {
            revisionId: detailRevision.id,
            elementId: "task-1",
            position: 4,
            payload: {
              kind: "task",
              title: "Build Spec Studio",
              instructions: "Render the approved spec.",
              tracedRequirementElementIds: ["requirement-1"],
              tracedDecisionElementIds: ["decision-1"],
              coveredCriterionElementIds: ["criterion-1"],
              dependsOnTaskElementIds: [],
            },
            payloadHash: "task-1-hash",
            elementVersion: 2,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      ],
    },
    currentApprovedRevision: null,
    executionRevisionSnapshots: [],
    approvals: [
      {
        id: "approval-requirement-1",
        spec_id: executingSpec.id,
        subject_kind: "requirement",
        element_id: "requirement-1",
        revision_id: detailRevision.id,
        approver: "alex",
        granted_at: NOW,
        validity: "valid",
      },
    ],
    comments: [
      {
        id: "comment-1",
        threadId: "thread-1",
        parentCommentId: null,
        elementId: "section-intent",
        handle: null,
        revisionId: detailRevision.id,
        revisionNumber: detailRevision.number,
        anchor: {
          sectionId: "intent",
          headingLabel: "Intent",
          line: 1,
          charStart: 0,
          charEnd: 9,
          quote: "Lifecycle",
          prefix: "",
          suffix: " spine",
          docRevision: "revision-4-hash",
        },
        quote: "Lifecycle",
        body: "Clarify the delivery outcome.",
        author: { kind: "human" },
        blocking: false,
        resolution: "open",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    executions: [],
    criterionDispositions: [],
    waivers: [],
    linkedTickets: [
      {
        projectName: "command-center",
        number: 12,
        title: "Ship reverse ticket links",
      },
    ],
    elementStatuses: {
      requirements: [
        {
          elementId: "requirement-1",
          status: {
            approval: "valid" as const,
            coverage: "covered" as const,
            proof: "pending" as const,
          },
        },
      ],
      tasks: [
        {
          elementId: "task-1",
          status: { status: "pending" as const },
        },
      ],
    },
    status: {
      specId: executingSpec.id,
      slug: "native-sdd",
      phase: {
        primary: "executing",
        authoringFacet: "in_review",
        authoringStage: "plan",
      },
      gates: [
        {
          gate: "requirements",
          dial: "gate",
          state: "admitted",
          applicability: {
            reason: "changed_since_governance_base",
            governanceBaseRevisionId: "revision-3",
          },
        },
        {
          gate: "design",
          dial: "gate",
          state: "pending",
          applicability: {
            reason: "changed_since_governance_base",
            governanceBaseRevisionId: "revision-3",
          },
        },
        {
          gate: "plan",
          dial: "gate",
          state: "pending",
          applicability: {
            reason: "current_stage",
            governanceBaseRevisionId: "revision-3",
          },
        },
      ],
      applicableGates: ["requirements", "design", "plan"],
      pendingApprovals: [
        { gate: "design", subject: "D1", elementId: "decision-1" },
        { gate: "plan", subject: "plan", elementId: null },
      ],
      openQuestions: [],
      coverage: { coveredCriteria: 1, totalCriteria: 1, percentage: 100 },
      delivery,
      imported: false,
    },
    importRecord: null,
  };
}

function reviewDetailPayload() {
  const payload = detailPayload();
  const baseRevision = {
    ...detailRevision,
    id: "revision-3",
    number: 3,
    state: "approved" as const,
    basedOnRevisionId: "revision-2",
    contentHash: "revision-3-hash",
    approvedAt: NOW,
  };
  const baseElements = payload.currentRevision.elements.map((entry) => ({
    ...entry,
    version: {
      ...entry.version,
      revisionId: baseRevision.id,
      ...(entry.element.id === "section-intent"
        ? {
            payload: {
              kind: "section" as const,
              role: "intent_problem" as const,
              title: "Intent",
              body: "Lifecycle spine before review semantics were explicit.",
            },
            payloadHash: "section-intent-base-hash",
            elementVersion: 1,
          }
        : entry.element.id === "requirement-1"
          ? {
              payload: {
                kind: "requirement" as const,
                statement: "Every spec used a session-bound address.",
                priority: "must" as const,
                risk: "high" as const,
              },
              payloadHash: "requirement-1-base-hash",
              elementVersion: 1,
            }
          : {}),
    },
  }));
  const retiredSection = {
    element: {
      id: "section-retired",
      specId: executingSpec.id,
      kind: "section" as const,
      number: null,
      parentElementId: null,
      createdAt: NOW,
    },
    version: {
      revisionId: baseRevision.id,
      elementId: "section-retired",
      position: 5,
      payload: {
        kind: "section" as const,
        role: "context" as const,
        title: "Retired context",
        body: "Retired wording that no longer belongs in the spec.",
      },
      payloadHash: "section-retired-hash",
      elementVersion: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };

  const baseSnapshot = {
    revision: baseRevision,
    elements: [...baseElements, retiredSection],
  };

  return {
    ...payload,
    revisions: [baseRevision, detailRevision],
    // What the detail route emits for a revision under review: the proposal,
    // the verdict that nothing has forked past it, and the snapshots its diff
    // is read from.
    liveProposals: [
      {
        revision: detailRevision,
        supersededBy: null,
        snapshot: payload.currentRevision,
        baseSnapshot,
        notes: null,
      },
    ],
    approvals: payload.approvals.map((approval) => ({
      ...approval,
      revision_id: baseRevision.id,
      validity: "stale" as const,
    })),
    // What the server projects for this revision: the requirement changed and
    // owes its approval, the decision did not change so its gate is not
    // consulted, and the plan stage is the revision's own.
    status: {
      ...payload.status,
      applicableGates: ["requirements", "plan"],
      pendingApprovals: [
        { gate: "requirements", subject: "R1", elementId: "requirement-1" },
        { gate: "plan", subject: "plan", elementId: null },
      ],
    },
    baseRevision: baseSnapshot,
    currentApprovedRevision: baseSnapshot,
    comments: [
      ...payload.comments,
      {
        id: "comment-orphaned",
        threadId: "thread-orphaned",
        parentCommentId: null,
        elementId: "section-retired",
        handle: null,
        revisionId: baseRevision.id,
        revisionNumber: baseRevision.number,
        anchor: {
          sectionId: "retired-context",
          headingLabel: "Retired context",
          line: 1,
          charStart: 0,
          charEnd: 15,
          quote: "Retired wording",
          prefix: "",
          suffix: " that no longer",
          docRevision: "revision-3-hash",
        },
        quote: "Retired wording",
        body: "Preserve why this context was removed.",
        author: { kind: "human" },
        blocking: false,
        resolution: "open" as const,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  };
}

function initialReviewDetailPayload() {
  const payload = detailPayload();
  const initialRevision = {
    ...detailRevision,
    number: 1,
    basedOnRevisionId: null,
  };
  const snapshot = {
    revision: initialRevision,
    elements: payload.currentRevision.elements.map((entry) => ({
      ...entry,
      version: { ...entry.version, revisionId: initialRevision.id },
    })),
  };
  return {
    ...payload,
    revisions: [initialRevision],
    // The first proposal has no base: the projection carries a null
    // baseSnapshot, and the review reads every element as added.
    liveProposals: [
      {
        revision: initialRevision,
        supersededBy: null,
        snapshot,
        baseSnapshot: null,
        notes: null,
      },
    ],
    baseRevision: null,
    currentRevision: snapshot,
  };
}

let api: FetchFixture;

function PassthroughAnnotator({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return <div data-test-annotator="passthrough">{children}</div>;
}

function stubSelectionOverText(container: HTMLElement, quote: string): void {
  const block = Array.from(
    container.querySelectorAll<HTMLElement>("[data-cc-line]"),
  ).find((candidate) =>
    _blockAnnotatableTextForTesting(candidate).includes(quote),
  );
  if (block === undefined) throw new Error(`Could not find text: ${quote}`);
  const start = _blockAnnotatableTextForTesting(block).indexOf(quote);
  const range = _rangeFromBlockOffsetsForTesting(
    block,
    start,
    start + quote.length,
  );
  if (range === null) throw new Error(`Could not select text: ${quote}`);
  range.getBoundingClientRect = () =>
    ({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
    }) as DOMRect;
  vi.spyOn(window, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges: vi.fn(),
  } as unknown as Selection);
}

describe("Spec Studio detail routes", () => {
  beforeEach(() => {
    _setAnnotatorBoundaryForTesting(PassthroughAnnotator);
    api = installFetchFixture();
    pathname = "/specs";
    routeParams = { projectName: "command-center", slug: "native-sdd" };
    window.history.replaceState({}, "", "/specs?project=command-center");
    routerReplace.mockReset();
    routerPush.mockReset();
    api.json("GET", "/api/conversations/active", {
      conversations: [],
      graphWorkflowExecutions: [],
      activeCollaborationExecutions: [],
    });
    api.json("GET", "/api/projects", [
      {
        name: "command-center",
        path: "/repos/command-center",
        activeSessions: 1,
        hasRunningSession: true,
      },
      {
        name: "aerotrainer",
        path: "/repos/aerotrainer",
        activeSessions: 0,
        hasRunningSession: false,
      },
    ]);
    api.json("GET", "/api/projects/preferences", {
      archived: [],
      pinned: [],
    });
  });

  afterEach(() => {
    api.restore();
    _resetAnnotatorBoundaryForTesting();
    vi.restoreAllMocks();
  });

  it("resolves an old slug to the renamed spec on the detail route", async () => {
    pathname = "/specs/command-center/old-native-sdd";
    routeParams = {
      projectName: "command-center",
      slug: "old-native-sdd",
    };
    api.json("GET", "/api/specs/command-center/old-native-sdd", {
      spec: executingSpec,
      aliases: [
        {
          projectPath: "/repos/command-center",
          slug: "old-native-sdd",
          specId: executingSpec.id,
          createdAt: NOW,
        },
      ],
      revisions: [],
      baseRevision: null,
      currentRevision: null,
      currentApprovedRevision: null,
      executionRevisionSnapshots: [],
      approvals: [],
      comments: [],
      executions: [],
      criterionDispositions: [],
      waivers: [],
      linkedTickets: [],
      elementStatuses: { requirements: [], tasks: [] },
      status: {
        specId: executingSpec.id,
        slug: "native-sdd",
        phase: { primary: "executing", authoringFacet: "in_review" },
        gates: [],
        pendingApprovals: [],
        openQuestions: [],
        coverage: { coveredCriteria: 0, totalCriteria: 0, percentage: 0 },
        delivery: {
          allWaived: false,
          deliveredCount: 0,
          provenCount: 0,
          deliveredExternallyCriterionIds: [],
          totalInScope: 0,
        },
        imported: false,
      },
      importRecord: null,
    });

    renderWithQuery(<SpecDetailPage />);

    expect(
      await screen.findByRole("heading", {
        name: "Native spec-driven development",
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("native-sdd")).toHaveLength(2);
    expect(
      screen.getByText("Opened from alias old-native-sdd"),
    ).toBeInTheDocument();
  });

  it("opens execution-start attention links on the Execution view", async () => {
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?el=execution_start",
    );
    api.json("GET", "/api/specs/command-center/native-sdd", detailPayload());
    api.json("POST", "/api/specs/command-center/native-sdd/actions/verify", {
      ok: true,
      checkedRevisionIds: [detailRevision.id],
      mismatches: [],
      consistencyFindings: [],
    });

    renderWithQuery(<SpecDetailPage />);

    expect(
      await screen.findByRole("region", { name: "Execution and merge" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Execution" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("persists a prose selection as a spec review comment", async () => {
    pathname = "/specs/command-center/native-sdd";
    const payload = detailPayload();
    api.json("GET", "/api/specs/command-center/native-sdd", payload);
    // The comment write path still answers with the raw persisted row, so the
    // POST fixture keeps the snake_case row shape even though the GET detail
    // view now serves camelCase comment views.
    api.json("POST", "/api/specs/command-center/native-sdd/actions/comment", {
      id: "comment-selection",
      spec_id: executingSpec.id,
      thread_id: "thread-selection",
      parent_comment_id: null,
      element_id: "section-intent",
      anchor_json: JSON.stringify({
        sectionId: "intent",
        headingLabel: "Intent",
        line: 1,
        charStart: 0,
        charEnd: 9,
        quote: "Lifecycle",
        prefix: "",
        suffix: " spine",
        docRevision: "revision-4-hash",
      }),
      revision_id: detailRevision.id,
      body: "Keep the lifecycle sequence explicit.",
      author_json: JSON.stringify({ kind: "human" }),
      blocking: 0,
      resolution: "open",
      created_at: NOW,
      updated_at: NOW,
    });
    const user = userEvent.setup();
    const { container } = renderWithQuery(<SpecDetailPage />);
    const quote = "draft, review";

    await screen.findByText(
      "Lifecycle spine: draft, review, execution, delivery.",
    );
    await waitFor(() =>
      expect(
        Array.from(
          container.querySelectorAll<HTMLElement>("[data-cc-line]"),
        ).some((candidate) =>
          _blockAnnotatableTextForTesting(candidate).includes(quote),
        ),
      ).toBe(true),
    );
    stubSelectionOverText(container, quote);
    fireEvent.pointerUp(document);
    await user.click(screen.getByRole("button", { name: "Comment" }));
    await user.type(
      screen.getByRole("textbox", { name: "Comment note" }),
      "Keep the lifecycle sequence explicit.",
    );
    await user.click(screen.getByRole("button", { name: "Add comment" }));

    await waitFor(() =>
      expect(
        api.requestsTo(
          "POST",
          "/api/specs/command-center/native-sdd/actions/comment",
        )[0]?.jsonBody,
      ).toMatchObject({
        revisionId: detailRevision.id,
        elementId: "section-intent",
        body: "Keep the lifecycle sequence explicit.",
        anchor: { quote },
      }),
    );
  });

  it("updates an open detail view when an agent draft SSE event arrives", async () => {
    pathname = "/specs/command-center/native-sdd";
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd",
      detailPayload("Original draft text."),
    );
    const queryClient = createTestQueryClient();
    const events = new FakeEventSource("/api/events");
    registerSpecSseReactions(events as unknown as EventSource, { queryClient });
    renderWithQuery(<SpecDetailPage />, queryClient);

    expect(await screen.findByText("Original draft text.")).toBeInTheDocument();
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd",
      detailPayload("Agent draft update without refresh."),
    );

    act(() => {
      events.emit("spec-changed", {
        type: "spec-changed",
        projectPath: "/repos/command-center",
        specId: executingSpec.id,
        specSlug: executingSpec.slug,
        occurredAt: NOW,
        kind: "draft-written",
        revisionId: detailRevision.id,
        elementIds: ["section-intent"],
      });
    });

    expect(
      await screen.findByText("Agent draft update without refresh."),
    ).toBeInTheDocument();
  });

  it("scrolls an element deep link into view", async () => {
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?el=R1",
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    api.json("GET", "/api/specs/command-center/native-sdd", detailPayload());

    renderWithQuery(<SpecDetailPage />);

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(document.getElementById("R1")).toHaveAttribute(
      "data-spec-element",
      "R1",
    );
  });

  it("reviews the first proposal as additions against an empty baseline", async () => {
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?view=review",
    );
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd",
      initialReviewDetailPayload(),
    );

    renderWithQuery(<SpecDetailPage />);

    expect(
      await screen.findByRole("heading", {
        name: "Review plan-stage revision 1",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/initial proposal/i)).toBeInTheDocument();
    const requirement = screen.getByTestId("review-change-requirement-1");
    expect(within(requirement).getAllByText("Added")).not.toHaveLength(0);
    // The fixture carries a valid approval for this requirement, so the card
    // offers withdrawal instead of a second approve.
    expect(
      within(requirement).getByRole("button", { name: "Unapprove item" }),
    ).toBeEnabled();
    // Outstanding subject approvals were this revision's only blocker, and the
    // combined act writes them with the sign-off, so it is reachable.
    expect(
      screen.getByRole("button", { name: /sign off revision 1$/i }),
    ).toBeEnabled();
  });

  it("deep-links section and removed changes to targets inside review mode", async () => {
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?view=review&change=section-retired",
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd",
      reviewDetailPayload(),
    );

    renderWithQuery(<SpecDetailPage />);

    const changedSection = await screen.findByTestId(
      "review-change-section-intent",
    );
    expect(
      within(changedSection).getByRole("link", { name: "section-intent" }),
    ).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?view=review&change=section-intent",
    );
    const removedSection = screen.getByTestId("review-change-section-retired");
    expect(
      within(removedSection).getByRole("link", { name: "section-retired" }),
    ).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?view=review&change=section-retired",
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(removedSection).toHaveAttribute(
      "id",
      "review-change-section-retired",
    );
  });

  it("request changes ends review and opens the follow-up draft", async () => {
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?view=review",
    );
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd",
      reviewDetailPayload(),
    );
    api.json(
      "POST",
      "/api/specs/command-center/native-sdd/actions/request-changes",
      {
        withdrawn: { ...detailRevision, state: "withdrawn" },
        draft: {
          ...detailRevision,
          id: "revision-5",
          number: 5,
          state: "draft",
          basedOnRevisionId: detailRevision.id,
          proposedAt: null,
        },
      },
    );
    const user = userEvent.setup();
    renderWithQuery(<SpecDetailPage />);

    await user.click(
      await screen.findByRole("button", { name: "Request changes" }),
    );
    await user.click(
      screen.getByRole("button", { name: "End review — open draft" }),
    );

    expect(
      await screen.findByText("Draft revision 5 opened"),
    ).toBeInTheDocument();
    expect(
      api.requestsTo(
        "POST",
        "/api/specs/command-center/native-sdd/actions/request-changes",
      )[0]?.jsonBody,
    ).toEqual({ revisionId: detailRevision.id });
  });

  it("presents a thread whose original element was removed as orphaned", async () => {
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?view=review",
    );
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd",
      reviewDetailPayload(),
    );

    renderWithQuery(<SpecDetailPage />);

    const thread = await screen.findByTestId("review-thread-thread-orphaned");
    expect(within(thread).getByText("Orphaned")).toBeInTheDocument();
    expect(within(thread).getByText("Original revision 3")).toBeInTheDocument();
    expect(within(thread).getByText(/Retired wording/)).toBeInTheDocument();
    expect(
      within(thread).getByText("Preserve why this context was removed."),
    ).toBeInTheDocument();
  });

  it("wires comment, item approval, and revision sign-off to their review actions", async () => {
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?view=review",
    );
    const approvals: SpecApprovalRow[] = [
      {
        id: "approval-decision-1",
        spec_id: executingSpec.id,
        subject_kind: "decision",
        element_id: "decision-1",
        revision_id: detailRevision.id,
        approver: "alex",
        granted_at: NOW,
        validity: "valid",
      },
      {
        id: "approval-plan",
        spec_id: executingSpec.id,
        subject_kind: "plan",
        element_id: null,
        revision_id: detailRevision.id,
        approver: "alex",
        granted_at: NOW,
        validity: "valid",
      },
    ];
    const base = reviewDetailPayload();
    const reviewPayload = {
      ...base,
      approvals,
      // Plan and design already hold their approvals, so the requirement is
      // the one subject the server still owes.
      status: {
        ...base.status,
        pendingApprovals: [
          {
            gate: "requirements" as const,
            subject: "R1",
            elementId: "requirement-1",
          },
        ],
      },
    };
    const requirementApproval: SpecApprovalRow = {
      id: "approval-requirement-1-current",
      spec_id: executingSpec.id,
      subject_kind: "requirement",
      element_id: "requirement-1",
      revision_id: detailRevision.id,
      approver: "alex",
      granted_at: NOW,
      validity: "valid",
    };
    api.json("GET", "/api/specs/command-center/native-sdd", reviewPayload);
    // Raw persisted row, matching what the comment write path returns; the
    // view-shaped entries in reviewPayload.comments are GET-only.
    api.json("POST", "/api/specs/command-center/native-sdd/actions/comment", {
      id: "comment-review-1",
      spec_id: executingSpec.id,
      thread_id: "thread-review-1",
      parent_comment_id: null,
      element_id: "requirement-1",
      anchor_json: JSON.stringify({
        sectionId: "R1",
        headingLabel: "R1",
        line: 1,
        charStart: 0,
        charEnd: 10,
        quote: "Spec Studio",
        prefix: "",
        suffix: " keeps identity.",
        docRevision: "revision-4-hash",
      }),
      revision_id: detailRevision.id,
      body: "Keep the identity promise explicit.",
      author_json: JSON.stringify({ kind: "human" }),
      blocking: 0,
      resolution: "open",
      created_at: NOW,
      updated_at: NOW,
    });
    api.json(
      "POST",
      "/api/specs/command-center/native-sdd/actions/approve-item",
      requirementApproval,
    );
    api.json(
      "POST",
      "/api/specs/command-center/native-sdd/actions/approve-remaining-and-sign-off",
      {
        revision: { ...detailRevision, state: "approved", approvedAt: NOW },
        approval: {
          ...reviewPayload.approvals[0],
          id: "approval-revision-4",
          subject_kind: "revision",
          element_id: null,
        },
        subjectApprovals: [requirementApproval],
      },
    );
    const user = userEvent.setup();
    renderWithQuery(<SpecDetailPage />);

    const change = await screen.findByTestId("review-change-requirement-1");
    await user.click(within(change).getByRole("button", { name: "Comment" }));
    await user.type(
      within(change).getByRole("textbox", { name: "Comment on R1" }),
      "Keep the identity promise explicit.",
    );
    await user.click(
      within(change).getByRole("button", { name: "Record comment" }),
    );
    await waitFor(() =>
      expect(
        api.requestsTo(
          "POST",
          "/api/specs/command-center/native-sdd/actions/comment",
        ),
      ).toHaveLength(1),
    );

    // The refetched projection is what tells the surface the subject is no
    // longer outstanding; the approval row alone never says that.
    reviewPayload.approvals.push(requirementApproval);
    reviewPayload.status.pendingApprovals =
      reviewPayload.status.pendingApprovals.filter(
        (pending) => pending.elementId !== "requirement-1",
      );
    await user.click(
      within(change).getByRole("button", { name: "Approve item" }),
    );
    await waitFor(() =>
      expect(
        api.requestsTo(
          "POST",
          "/api/specs/command-center/native-sdd/actions/approve-item",
        )[0]?.jsonBody,
      ).toEqual({
        revisionId: detailRevision.id,
        subjectKind: "requirement",
        elementId: "requirement-1",
      }),
    );

    await user.click(
      await screen.findByRole("button", { name: "Sign off revision 4" }),
    );
    await user.click(
      screen.getByRole("checkbox", {
        name: /I reviewed the semantic change list/i,
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Sign off — freeze revision 4" }),
    );
    await waitFor(() =>
      expect(
        api.requestsTo(
          "POST",
          "/api/specs/command-center/native-sdd/actions/approve-remaining-and-sign-off",
        )[0]?.jsonBody,
      ).toEqual({ revisionId: detailRevision.id }),
    );
  });
});
