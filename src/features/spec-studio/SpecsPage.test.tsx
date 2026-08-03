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
import { QueryClientProvider } from "@tanstack/react-query";

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
import SpecsPage from "./SpecsPage";

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
const approvedSpec = spec("prompt-audit", "Prompt audit trail");

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
  delivery = { allWaived: false, provenCount: 7, totalInScope: 12 },
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
        spec_id: executingSpec.id,
        thread_id: "thread-1",
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
        body: "Clarify the delivery outcome.",
        author_json: JSON.stringify({ kind: "human" }),
        blocking: 0,
        resolution: "open",
        created_at: NOW,
        updated_at: NOW,
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
          status: { status: "pending" as const, claimEvidenceIds: [] },
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
    },
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

  return {
    ...payload,
    revisions: [baseRevision, detailRevision],
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
    baseRevision: {
      revision: baseRevision,
      elements: [...baseElements, retiredSection],
    },
    currentApprovedRevision: {
      revision: baseRevision,
      elements: [...baseElements, retiredSection],
    },
    comments: [
      ...payload.comments,
      {
        id: "comment-orphaned",
        spec_id: executingSpec.id,
        thread_id: "thread-orphaned",
        parent_comment_id: null,
        element_id: "section-retired",
        anchor_json: JSON.stringify({
          sectionId: "retired-context",
          headingLabel: "Retired context",
          line: 1,
          charStart: 0,
          charEnd: 15,
          quote: "Retired wording",
          prefix: "",
          suffix: " that no longer",
          docRevision: "revision-3-hash",
        }),
        revision_id: baseRevision.id,
        body: "Preserve why this context was removed.",
        author_json: JSON.stringify({ kind: "human" }),
        blocking: 0,
        resolution: "open" as const,
        created_at: NOW,
        updated_at: NOW,
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
  return {
    ...payload,
    revisions: [initialRevision],
    baseRevision: null,
    currentRevision: {
      revision: initialRevision,
      elements: payload.currentRevision.elements.map((entry) => ({
        ...entry,
        version: { ...entry.version, revisionId: initialRevision.id },
      })),
    },
  };
}

function questionsDetailPayload() {
  const payload = detailPayload();
  return {
    ...payload,
    questions: [1, 2].map((number) => ({
      id: `question-${number}`,
      number,
      handle: `Q${number}`,
      elementId: null,
      text: `Open question ${number}`,
      status: "open" as const,
      answer: null,
      answeredAt: null,
      provenance: { kind: "agent" as const, conversationId: "conversation-1" },
      createdAt: NOW,
      updatedAt: NOW,
    })),
  };
}

function historySubjectLink(label: string): HTMLElement {
  const row = screen.getByRole("heading", { name: label }).closest("article");
  if (row === null) throw new Error(`No history row for ${label}`);
  return within(row).getByRole("link", { name: "Open subject →" });
}

const inventory = {
  specs: [
    {
      spec: executingSpec,
      phase: { primary: "executing", authoringFacet: "in_review" },
      currentRevision: null,
      counts: { requirements: 11, criteria: 21, decisions: 4, tasks: 13 },
      pendingApprovalCount: 2,
      approvalState: "pending",
      delivery: { allWaived: false, provenCount: 7, totalInScope: 12 },
      linkedWork: {
        tickets: 2,
        conversations: 1,
        sessions: 0,
        workflowExecutions: 1,
        mergeJobs: 0,
      },
    },
    {
      spec: approvedSpec,
      phase: { primary: "approved" },
      currentRevision: null,
      counts: { requirements: 3, criteria: 5, decisions: 1, tasks: 4 },
      pendingApprovalCount: 0,
      approvalState: "complete",
      delivery: { allWaived: false, provenCount: 0, totalInScope: 5 },
      linkedWork: {
        tickets: 0,
        conversations: 1,
        sessions: 0,
        workflowExecutions: 0,
        mergeJobs: 0,
      },
    },
  ],
};

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

describe("Spec Studio routes and inventory", () => {
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
    api.json("GET", "/api/specs/command-center", inventory);
  });

  afterEach(() => {
    api.restore();
    _resetAnnotatorBoundaryForTesting();
    vi.restoreAllMocks();
  });

  it("renders seeded specs with composite phase, approval, linked-work, and delivery roll-ups", async () => {
    renderWithQuery(<SpecsPage />);

    const row = await screen.findByTestId("spec-row-native-sdd");
    expect(within(row).getByText("Executing")).toBeInTheDocument();
    expect(within(row).getByText("In review")).toBeInTheDocument();
    expect(within(row).getByText("2 pending")).toBeInTheDocument();
    expect(within(row).getByText("7/12 delivered")).toBeInTheDocument();
    expect(within(row).getByText("2 tickets")).toBeInTheDocument();
    expect(within(row).getByText("1 conversation")).toBeInTheDocument();
    expect(within(row).queryByText(/partial/i)).not.toBeInTheDocument();

    const approvedRow = screen.getByTestId("spec-row-prompt-audit");
    expect(within(approvedRow).getByText("Approved")).toBeInTheDocument();
    expect(
      within(approvedRow).queryByText(/delivered/),
    ).not.toBeInTheDocument();
  });

  it("matches the prototype list header and project breadcrumb composition", async () => {
    renderWithQuery(<SpecsPage />);

    await screen.findByTestId("spec-row-native-sdd");

    const breadcrumb = screen.getByRole("navigation");
    expect(within(breadcrumb).getByText("projects")).toBeVisible();
    expect(
      within(breadcrumb).getByRole("button", { name: /command-center/i }),
    ).toHaveAttribute("title", "Switch project");
    expect(within(breadcrumb).getByText("specs")).toBeVisible();
    expect(screen.getByText("start one:")).toBeVisible();
    expect(screen.getByText("/spec")).toBeVisible();
    expect(screen.getByText("in any conversation")).toBeVisible();
    const summary = screen.getByRole("status", {
      name: "Spec inventory summary",
    });
    expect(within(summary).getAllByText("·")).toHaveLength(2);
    expect(within(summary).getByText("2 specs")).toBeVisible();
    expect(
      within(summary)
        .getByText("2 approvals pending")
        .closest("[data-tone='neutral']"),
    ).toHaveClass("border-border-subtle", "text-text-tertiary");
    expect(
      within(summary).getByText("1 executing").closest("[data-tone='neutral']"),
    ).toHaveClass("border-border-subtle", "text-text-tertiary");
    expect(
      screen.queryByRole("combobox", { name: "Project" }),
    ).not.toBeInTheDocument();
  });

  it("filters the inventory by project", async () => {
    const user = userEvent.setup();
    renderWithQuery(<SpecsPage />);

    await screen.findByText("Native spec-driven development");
    await user.click(screen.getByTitle("Switch project"));
    await screen.findByRole("combobox", { name: /search projects/i });
    await user.click(screen.getByRole("option", { name: "aerotrainer" }));

    expect(routerPush).toHaveBeenCalledWith("/specs?project=aerotrainer");
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
        delivery: { allWaived: false, provenCount: 0, totalInScope: 0 },
      },
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

  it("renders annotated prose beside a structured rail with the full phase facets", async () => {
    pathname = "/specs/command-center/native-sdd";
    api.json("GET", "/api/specs/command-center/native-sdd", detailPayload());

    renderWithQuery(<SpecDetailPage />);

    expect(
      await screen.findByText(
        "Lifecycle spine: draft, review, execution, delivery.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Clarify the delivery outcome."),
    ).toBeInTheDocument();

    const header = screen.getByTestId("spec-phase-facets");
    expect(within(header).getByText("Executing")).toBeInTheDocument();
    expect(within(header).getByText("In review")).toBeInTheDocument();
    expect(within(header).getByText("plan stage")).toBeInTheDocument();
    expect(within(header).getByText("7/12 delivered")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Export" })).toHaveAttribute(
      "href",
      "/api/specs/command-center/native-sdd/export",
    );
    expect(screen.getByRole("link", { name: "Verify" })).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?view=integrity",
    );
    expect(screen.getByRole("link", { name: "Gate policy" })).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?view=gate#gate-policy",
    );
    const linkedTickets = screen.getByRole("region", {
      name: "Linked tickets",
    });
    expect(
      within(linkedTickets).getByRole("link", {
        name: "command-center#12 · Ship reverse ticket links",
      }),
    ).toHaveAttribute("href", "/tickets/command-center/12");
    expect(
      within(linkedTickets).getByRole("button", {
        name: "Copy ticket reference",
      }),
    ).toBeInTheDocument();

    const rail = screen.getByRole("complementary", {
      name: "Spec structure",
    });
    expect(within(rail).getByText("R1")).toBeInTheDocument();
    expect(within(rail).getByText("D1")).toBeInTheDocument();
    expect(within(rail).getByText("T1")).toBeInTheDocument();
    await userEvent.click(
      within(rail).getByRole("button", { name: "Expand R1" }),
    );
    expect(
      within(rail).getByText("Old links resolve through aliases."),
    ).toBeInTheDocument();
    expect(
      within(rail).getByRole("img", { name: "Approved" }),
    ).toBeInTheDocument();
    expect(
      within(rail).getAllByRole("img", { name: "Pending" }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "Copy reference" }).length,
    ).toBeGreaterThan(3);
    expect(
      screen.queryByRole("button", { name: /edit|save content/i }),
    ).not.toBeInTheDocument();
  });

  it("renders structured elements when a revision has no prose sections", async () => {
    pathname = "/specs/command-center/native-sdd";
    const payload = detailPayload();
    payload.currentRevision.elements = payload.currentRevision.elements.filter(
      (entry) => entry.version.payload.kind !== "section",
    );
    api.json("GET", "/api/specs/command-center/native-sdd", payload);

    renderWithQuery(<SpecDetailPage />);

    const rail = await screen.findByRole("complementary", {
      name: "Spec structure",
    });
    expect(within(rail).getByText("R1")).toBeInTheDocument();
    await userEvent.click(
      within(rail).getByRole("button", { name: "Expand R1" }),
    );
    expect(
      within(rail).getByText("Old links resolve through aliases."),
    ).toBeInTheDocument();
    expect(within(rail).getByText("T1")).toBeInTheDocument();
    expect(screen.getByText(/No prose sections authored/)).toBeInTheDocument();
    expect(
      screen.queryByText(
        "This spec does not have a current revision to display.",
      ),
    ).toBeNull();
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

  it("opens the Gate policy view when its link navigates in place", async () => {
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState({}, "", "/specs/command-center/native-sdd");
    api.json("GET", "/api/specs/command-center/native-sdd", detailPayload());
    api.json("POST", "/api/specs/command-center/native-sdd/actions/verify", {
      ok: true,
      checkedRevisionIds: [detailRevision.id],
      mismatches: [],
    });

    const queryClient = createTestQueryClient();
    const detailView = renderWithQuery(<SpecDetailPage />, queryClient);

    expect(
      await screen.findByRole("link", { name: "Gate policy" }),
    ).toBeInTheDocument();

    // A next/link click to ?view=gate#gate-policy keeps the page mounted:
    // only the URL (and therefore useSearchParams) changes.
    act(() => {
      window.history.pushState(
        {},
        "",
        "/specs/command-center/native-sdd?view=gate#gate-policy",
      );
    });
    detailView.rerender(
      <QueryClientProvider client={queryClient}>
        <SpecDetailPage />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Gate policy" }),
    ).toBeInTheDocument();
  });

  it("lands the header Verify action on integrity rather than the gate policy surface", async () => {
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState({}, "", "/specs/command-center/native-sdd");
    api.json("GET", "/api/specs/command-center/native-sdd", detailPayload());
    api.json("POST", "/api/specs/command-center/native-sdd/actions/verify", {
      ok: true,
      checkedRevisionIds: [detailRevision.id],
      mismatches: [],
    });

    const queryClient = createTestQueryClient();
    const detailView = renderWithQuery(<SpecDetailPage />, queryClient);

    const verify = await screen.findByRole("link", { name: "Verify" });
    expect(verify).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?view=integrity",
    );

    act(() => {
      window.history.pushState(
        {},
        "",
        "/specs/command-center/native-sdd?view=integrity",
      );
    });
    detailView.rerender(
      <QueryClientProvider client={queryClient}>
        <SpecDetailPage />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Spec integrity" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Integrity intact")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Gate policy" })).toBeNull();
  });

  it("keeps the review surface reachable while an execution runs against a proposed revision", async () => {
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState({}, "", "/specs/command-center/native-sdd");
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd",
      reviewDetailPayload(),
    );

    const queryClient = createTestQueryClient();
    const detailView = renderWithQuery(<SpecDetailPage />, queryClient);

    expect(
      await screen.findByRole("link", { name: "Review revision" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?view=review");

    act(() => {
      window.history.pushState(
        {},
        "",
        "/specs/command-center/native-sdd?view=review",
      );
    });
    detailView.rerender(
      <QueryClientProvider client={queryClient}>
        <SpecDetailPage />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Review plan-stage revision 4",
      }),
    ).toBeInTheDocument();
  });

  it("opens a history requirement subject in the full reader", async () => {
    const user = userEvent.setup();
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState({}, "", "/specs/command-center/native-sdd");
    api.json("GET", "/api/specs/command-center/native-sdd", detailPayload());

    renderWithQuery(<SpecDetailPage />);

    await user.click(await screen.findByRole("button", { name: "History" }));
    await user.click(historySubjectLink("R1 approved"));

    expect(
      await screen.findByRole("heading", { name: "Requirements" }),
    ).toBeVisible();
  });

  it("opens an inspected trace node in the full Requirements reader", async () => {
    const user = userEvent.setup();
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?view=traceability",
    );
    api.json("GET", "/api/specs/command-center/native-sdd", detailPayload());
    api.json("GET", "/api/specs/command-center/native-sdd/lint", {
      revisionId: detailRevision.id,
      findings: [],
    });

    renderWithQuery(<SpecDetailPage />);

    await user.click(
      await screen.findByRole("button", { name: "Select requirement R1" }),
    );
    await user.click(screen.getByRole("link", { name: "Open R1" }));

    expect(
      await screen.findByRole("heading", { name: "Requirements" }),
    ).toBeVisible();
  });

  it("opens a history subject after an earlier deep link already selected that surface", async () => {
    const user = userEvent.setup();
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?el=Q1",
    );
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd",
      questionsDetailPayload(),
    );

    renderWithQuery(<SpecDetailPage />);

    expect(
      await screen.findByRole("heading", {
        name: "Questions & assumptions",
      }),
    ).toBeVisible();

    await user.click(await screen.findByRole("button", { name: "History" }));
    await user.click(historySubjectLink("Q2 opened"));

    expect(
      await screen.findByRole("heading", {
        name: "Questions & assumptions",
      }),
    ).toBeVisible();
    expect(screen.getByText("Open question 2")).toBeVisible();
  });

  it("renders criterion evidence and live lint from their direct detail routes", async () => {
    pathname = "/specs/command-center/native-sdd";
    const payload = reviewDetailPayload();
    api.json("GET", "/api/specs/command-center/native-sdd", payload);
    api.json("GET", "/api/specs/command-center/native-sdd/elements/R1.1", {
      specId: executingSpec.id,
      slug: executingSpec.slug,
      revision: payload.currentApprovedRevision.revision,
      handle: "R1.1",
      element: payload.currentApprovedRevision.elements[2],
      approvals: [],
      evidenceState: [
        {
          criterionElementId: "criterion-1",
          handle: "R1.1",
          evidence: [],
          verdicts: [],
          waiver: null,
        },
      ],
      referenceState: null,
    });
    api.json("GET", "/api/specs/command-center/native-sdd/lint", {
      revisionId: detailRevision.id,
      findings: [
        {
          ruleId: "9.3.uncovered-criterion",
          severity: "blocks_propose",
          elementHandle: "R1.1",
          message: "R1.1 has no covering task.",
        },
      ],
    });
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?view=evidence&el=R1.1",
    );

    const evidenceView = renderWithQuery(<SpecDetailPage />);

    expect(
      await screen.findByRole("heading", {
        name: "Evidence by acceptance criterion",
      }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Nothing proves this criterion yet."),
    ).toBeInTheDocument();
    expect(screen.getByText("Approved revision 3")).toBeInTheDocument();
    expect(
      api.requestsTo(
        "GET",
        /\/api\/specs\/command-center\/native-sdd\/elements\/R1\.1\?revisionId=revision-3/,
      ),
    ).toHaveLength(1);

    evidenceView.unmount();
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?view=lint",
    );

    renderWithQuery(<SpecDetailPage />);

    expect(
      await screen.findByRole("region", { name: "Deterministic lint" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("R1.1 has no covering task."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Spec views" }),
    ).toBeVisible();
  });

  it("verifies immutable revision hashes on the dedicated Integrity surface", async () => {
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?view=integrity",
    );
    api.json("GET", "/api/specs/command-center/native-sdd", detailPayload());
    api.json("POST", "/api/specs/command-center/native-sdd/actions/verify", {
      ok: false,
      checkedRevisionIds: [detailRevision.id],
      mismatches: [
        {
          revisionId: detailRevision.id,
          expectedContentHash: "expected-hash",
          actualContentHash: "actual-hash",
          mismatchedElementIds: ["requirement-1"],
        },
      ],
    });
    renderWithQuery(<SpecDetailPage />);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Integrity mismatch");
    expect(banner).toHaveTextContent("requirement-1");
    expect(
      api.requestsTo(
        "POST",
        "/api/specs/command-center/native-sdd/actions/verify",
      ),
    ).toHaveLength(1);
  });

  it("persists a prose selection as a spec review comment", async () => {
    pathname = "/specs/command-center/native-sdd";
    const payload = detailPayload();
    api.json("GET", "/api/specs/command-center/native-sdd", payload);
    api.json("POST", "/api/specs/command-center/native-sdd/actions/comment", {
      ...payload.comments[0],
      id: "comment-selection",
      body: "Keep the lifecycle sequence explicit.",
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

  it("renders durable approval, requirement proof, and task-owned work status", async () => {
    pathname = "/specs/command-center/native-sdd";
    const payload = detailPayload();
    payload.approvals = [
      { ...payload.approvals[0], revision_id: "revision-3" },
      {
        ...payload.approvals[0],
        id: "approval-decision-1",
        subject_kind: "decision",
        element_id: "decision-1",
        revision_id: "revision-3",
        validity: "stale",
      },
    ] as unknown as typeof payload.approvals;
    (
      payload.elementStatuses.requirements[0]!.status as {
        proof: string;
      }
    ).proof = "proven";
    api.json("GET", "/api/specs/command-center/native-sdd", payload);

    renderWithQuery(<SpecDetailPage />);

    const requirement = await screen.findByText("R1");
    const requirementRow = requirement.closest<HTMLElement>(
      "[data-spec-element]",
    )!;
    await userEvent.click(
      within(requirementRow).getByRole("button", { name: "Expand R1" }),
    );
    expect(
      within(requirementRow).getByText("Old links resolve through aliases."),
    ).toBeInTheDocument();
    expect(
      within(requirementRow).getByText("Proven; Approved"),
    ).toBeInTheDocument();
    expect(
      within(requirementRow).getByRole("img", { name: "Approved" }),
    ).toBeInTheDocument();
    const decisionRow = screen
      .getByText("D1")
      .closest<HTMLElement>("[data-spec-element]")!;
    expect(
      within(decisionRow).getByRole("img", { name: "Approval stale" }),
    ).toBeInTheDocument();
    const taskRow = screen
      .getByText("T1")
      .closest<HTMLElement>("[data-spec-element]")!;
    expect(within(taskRow).getByText("Pending")).toBeInTheDocument();
    expect(
      within(taskRow).getByRole("img", { name: "Pending" }),
    ).toBeInTheDocument();
    expect(within(taskRow).queryByText("Execution active")).toBeNull();
  });

  it("projects bulk per-element approval rows into the structured rail", async () => {
    pathname = "/specs/command-center/native-sdd";
    const payload = detailPayload();
    payload.approvals = [
      payload.approvals[0],
      {
        ...payload.approvals[0],
        id: "approval-decision-1",
        subject_kind: "decision",
        element_id: "decision-1",
      },
      {
        ...payload.approvals[0],
        id: "approval-plan",
        subject_kind: "plan",
        element_id: null,
      },
    ] as unknown as typeof payload.approvals;
    api.json("GET", "/api/specs/command-center/native-sdd", payload);

    renderWithQuery(<SpecDetailPage />);

    const decisionRow = (await screen.findByText("D1")).closest<HTMLElement>(
      "[data-spec-element]",
    )!;
    expect(
      within(decisionRow).getByRole("img", { name: "Approved" }),
    ).toBeInTheDocument();
    const taskRow = screen
      .getByText("T1")
      .closest<HTMLElement>("[data-spec-element]")!;
    expect(
      within(taskRow).getByRole("img", { name: "Plan approved" }),
    ).toBeInTheDocument();
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

  it("calls out an all-waived delivery standing explicitly", async () => {
    pathname = "/specs/command-center/native-sdd";
    api.json(
      "GET",
      "/api/specs/command-center/native-sdd",
      detailPayload("Waived delivery.", {
        allWaived: true,
        provenCount: 0,
        totalInScope: 2,
      }),
    );

    renderWithQuery(<SpecDetailPage />);

    expect(await screen.findByText("All delivery waived")).toBeInTheDocument();
  });

  it("renders formatted semantic review values with re-approval and raw diff secondary", async () => {
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
    const user = userEvent.setup();

    renderWithQuery(<SpecDetailPage />);

    expect(
      await screen.findByRole("heading", {
        name: "Review plan-stage revision 4",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/proposed 2026-07-18 · over revision 3/i),
    ).toBeInTheDocument();
    const semanticChanges = screen.getByRole("region", {
      name: "Semantic changes",
    });
    expect(
      within(semanticChanges).getByText("3 changes across 2 kinds"),
    ).toBeInTheDocument();
    expect(
      within(semanticChanges).getByText(
        "Approvals on unchanged elements carry forward quietly.",
      ),
    ).toBeInTheDocument();
    const change = screen.getByTestId("review-change-requirement-1");
    expect(
      await within(change).findByText(
        "Every spec used a session-bound address.",
        { selector: "p" },
      ),
    ).toBeInTheDocument();
    expect(
      await within(change).findByText("Every spec has a stable address.", {
        selector: "p",
      }),
    ).toBeInTheDocument();
    expect(within(change).getByText("Approval stale")).toBeInTheDocument();
    expect(within(change).getByRole("link", { name: "R1" })).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?el=R1",
    );
    expect(
      screen.getByRole("button", { name: "Request changes" }),
    ).toBeInTheDocument();
    expect(
      within(change).getByRole("button", { name: "Comment" }),
    ).toBeInTheDocument();
    expect(
      within(change).getByRole("button", { name: "Approve item" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign off revision 4" }),
    ).toBeDisabled();

    await user.click(screen.getByRole("tab", { name: "Raw diff" }));
    expect(screen.getByText(/secondary view/i)).toBeInTheDocument();
    expect(screen.getByText(/revision-3/)).toBeInTheDocument();
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
    expect(
      screen.getByRole("button", { name: "Sign off revision 1" }),
    ).toBeDisabled();
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
    api.json(
      "POST",
      "/api/specs/command-center/native-sdd/actions/comment",
      reviewPayload.comments[0],
    );
    api.json(
      "POST",
      "/api/specs/command-center/native-sdd/actions/approve-item",
      requirementApproval,
    );
    api.json("POST", "/api/specs/command-center/native-sdd/actions/sign-off", {
      revision: { ...detailRevision, state: "approved", approvedAt: NOW },
      approval: {
        ...reviewPayload.approvals[0],
        id: "approval-revision-4",
        subject_kind: "revision",
        element_id: null,
      },
    });
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
          "/api/specs/command-center/native-sdd/actions/sign-off",
        )[0]?.jsonBody,
      ).toEqual({ revisionId: detailRevision.id }),
    );
  });

  it("bulk-approves every remaining review subject through per-element records", async () => {
    pathname = "/specs/command-center/native-sdd";
    window.history.replaceState(
      {},
      "",
      "/specs/command-center/native-sdd?view=review",
    );
    const reviewPayload = reviewDetailPayload();
    api.json("GET", "/api/specs/command-center/native-sdd", reviewPayload);
    api.json(
      "POST",
      "/api/specs/command-center/native-sdd/actions/bulk-approve",
      [
        reviewPayload.approvals[0],
        {
          ...reviewPayload.approvals[0],
          id: "approval-decision-1",
          subject_kind: "decision",
          element_id: "decision-1",
        },
        {
          ...reviewPayload.approvals[0],
          id: "approval-plan",
          subject_kind: "plan",
          element_id: null,
        },
      ],
    );
    const user = userEvent.setup();
    renderWithQuery(<SpecDetailPage />);

    await user.click(
      await screen.findByRole("button", {
        name: /Approve all remaining \(\d+\)/,
      }),
    );
    await waitFor(() =>
      expect(
        api.requestsTo(
          "POST",
          "/api/specs/command-center/native-sdd/actions/bulk-approve",
        )[0]?.jsonBody,
      ).toEqual({
        revisionId: detailRevision.id,
        subjects: [
          { subjectKind: "requirement", elementId: "requirement-1" },
          { subjectKind: "plan", elementId: null },
        ],
      }),
    );
  });
});
