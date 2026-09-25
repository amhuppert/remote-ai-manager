// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import type { NativeSddWorkflowManagementDetail } from "@/lib/workflow-graph/managed-definition";

import ManagedDeliveryLaunchControl from "./ManagedDeliveryLaunchControl";

const routerPush = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

const management: NativeSddWorkflowManagementDetail = {
  kind: "native_sdd_delivery",
  specId: "spec-1",
  specSlug: "checkout",
  specName: "Checkout",
  attemptId: "attempt-2",
  pinnedRevisionId: "revision-8",
  pinnedRevisionNumber: 8,
  lifecycle: "approved",
  editable: false,
  isCurrentDefinition: true,
  specHref: "/specs/demo/checkout",
  builderHref: "/projects/demo/workflows?definition=wf-1",
  executionHref: null,
  bindingRevision: 4,
  deltaBasisExecutionId: null,
  binding: { dispositions: [] },
  dispositionCounts: {},
  unresolvedItems: [],
  criterionRows: [],
  claims: [],
  comments: [],
  nextAct: null,
  currentCandidate: null,
  currentCandidateHash: null,
  currentApproval: null,
  approvedBaseline: null,
  changes: {
    workflowSettings: false,
    contexts: false,
    tasks: false,
    edges: false,
    layout: false,
    dispositions: false,
    claims: false,
  },
  capabilities: {
    canSignOff: false,
    canReopen: true,
    canAbandon: true,
    canLaunch: true,
    refusals: {},
  },
};

describe("ManagedDeliveryLaunchControl", () => {
  let api: FetchFixture;

  beforeEach(() => {
    routerPush.mockReset();
    api = installFetchFixture();
    api.json("GET", "/api/projects/demo/sessions", {
      sessions: [
        {
          sessionName: "delivery-session",
          worktreePath: "/tmp/delivery-session",
          branchName: "feature/delivery-session",
          targetBranch: "main",
          parentSessionName: null,
          createdAt: "2026-08-31T10:00:00.000Z",
          lastActivityAt: "2026-08-31T10:00:00.000Z",
          archived: false,
          finished: false,
          source: "cc",
          creationMode: "normal",
          tddEnabled: true,
          derivedStatus: "idle",
          promptCount: 0,
          derivedLastActivityAt: "2026-08-31T10:00:00.000Z",
          collabContribution: null,
          hasActiveGraphWorkflow: false,
          spawnedFrom: null,
        },
      ],
    });
    api.json("POST", "/api/specs/demo/checkout/actions/start-execution", {
      execution: {
        id: "execution-9",
        specId: "spec-1",
        revisionId: "revision-8",
        revisionNumber: 8,
        state: "definition_review",
        workflowSeedSource: {
          kind: "spec_delivery",
          specSlug: "checkout",
          candidateId: "wf-1",
        },
        workflowExecutionId: null,
        scope: {
          selectedTaskIds: [],
          selectedCriterionIds: [],
          exclusionDispositions: [],
        },
        sessionName: "delivery-session",
        deliveredAt: null,
        abandonedReason: null,
        createdAt: "2026-08-31T10:01:00.000Z",
        updatedAt: "2026-08-31T10:01:00.000Z",
      },
      workflowDefinition: { id: "wf-1", revision: 3 },
      deliveryPlan: {
        attemptId: "attempt-2",
        candidateId: "wf-1",
        candidateHash: "sha256:candidate",
        workflowExecutionId: "graph-execution-9",
        resolvedDefinitionHash: "sha256:definition",
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    api.restore();
  });

  it("launches the approved definition in an existing session and opens its execution", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const user = userEvent.setup();
    renderWithQuery(
      <ManagedDeliveryLaunchControl
        projectName="demo"
        management={management}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Launch" }));
    const sessionSelect = await screen.findByRole("combobox", {
      name: "Session to launch in",
    });
    await user.click(sessionSelect);
    await user.click(
      await screen.findByRole("option", { name: /delivery-session/i }),
    );
    await user.click(screen.getByRole("button", { name: "Start execution" }));

    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith(
        "/projects/demo/delivery-session/workflow?execution=graph-execution-9",
      ),
    );
    expect(
      api.requestsTo("POST", /actions\/start-execution/)[0]?.jsonBody,
    ).toEqual({
      revisionId: "revision-8",
      sessionName: "delivery-session",
    });
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("uncontrolled to controlled"),
    );
  });
});
