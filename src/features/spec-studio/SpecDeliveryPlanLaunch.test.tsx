// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";

import { reviewView } from "./delivery-plan-review.fixtures";
import SpecDeliveryPlanLaunch from "./SpecDeliveryPlanLaunch";

// Radix focuses items / captures the pointer on open; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

const PROJECT = "command-center";
const SLUG = "native-sdd";
const SESSIONS_PATH = `/api/projects/${PROJECT}/sessions`;
const START_PATH = `/api/specs/${PROJECT}/${SLUG}/actions/start-execution`;

function session(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    sessionName: "delivery-run",
    worktreePath: "/tmp/delivery-run",
    branchName: "cc/delivery-run",
    targetBranch: "main",
    parentSessionName: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    lastActivityAt: "2026-08-14T00:00:00.000Z",
    archived: false,
    finished: false,
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    derivedStatus: "idle",
    promptCount: 0,
    derivedLastActivityAt: "2026-08-14T00:00:00.000Z",
    collabContribution: null,
    hasActiveGraphWorkflow: false,
    ...overrides,
  };
}

/** An attempt whose displayed candidate is signed off — nothing owed but launch. */
function signedOffReview(): DeliveryPlanReviewView {
  return reviewView({
    attempt: { status: "approved" },
    approval: {
      candidateId: "candidate-2",
      candidateHash: "sha256:candidate-2",
      snapshotId: "snapshot-2",
      approvedAt: "2026-08-14T01:00:00.000Z",
      approvedBy: { kind: "human" },
    },
    nextAct: {
      actor: "human",
      command: `cctl spec start ${SLUG}`,
      reason: "Start the signed one-off graph launch.",
    },
  });
}

function launchReceipt() {
  const review = signedOffReview();
  return {
    execution: {
      id: "execution-9",
      specId: "spec-native-sdd",
      revisionId: review.attempt.pinnedRevisionId,
      revisionNumber: 2,
      state: "running" as const,
      workflowSeedSource: null,
      workflowExecutionId: "wf-exec-9",
      scope: null,
      sessionName: "other-work",
      deliveredAt: null,
      abandonedReason: null,
      createdAt: "2026-08-14T02:00:00.000Z",
      updatedAt: "2026-08-14T02:00:00.000Z",
    },
    launch: review.document.launch,
    deliveryPlan: {
      attemptId: review.attempt.id,
      candidateId: "candidate-2",
      candidateHash: "sha256:candidate-2",
      workflowExecutionId: "wf-exec-9",
      resolvedDefinitionHash: "sha256:resolved-9",
    },
  };
}

describe("SpecDeliveryPlanLaunch", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
  });

  afterEach(() => api.restore());

  // The bug this pins: a signed-off plan was reachable only through
  // `cctl spec start`. Studio had no control that launched it (#7).
  it("launches the signed-off candidate into the session the human picked", async () => {
    api.json("GET", SESSIONS_PATH, {
      sessions: [
        session({ sessionName: "delivery-run" }),
        session({ sessionName: "other-work", branchName: "cc/other-work" }),
      ],
    });
    api.json("POST", START_PATH, launchReceipt());
    const user = userEvent.setup();

    renderWithQuery(
      <SpecDeliveryPlanLaunch
        projectName={PROJECT}
        review={signedOffReview()}
      />,
    );

    const panel = await screen.findByRole("region", { name: "Plan launch" });
    const start = within(panel).getByRole("button", {
      name: "Start execution",
    });

    // Nothing may launch before a session names where it runs: the server
    // refuses a null session, so the control must not offer the act yet.
    expect(start).toBeDisabled();

    await user.click(
      within(panel).getByRole("combobox", { name: "Session to launch in" }),
    );
    await user.click(await screen.findByRole("option", { name: /other-work/ }));
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);

    await waitFor(() =>
      expect(api.requestsTo("POST", START_PATH)).toHaveLength(1),
    );
    expect(api.requestsTo("POST", START_PATH)[0]?.jsonBody).toEqual({
      revisionId: "revision-2",
      sessionName: "other-work",
    });
    expect(await within(panel).findByText(/execution-9/)).toBeVisible();
  });

  // A session already running a graph has no free execution slot, so offering
  // it would only buy a server refusal after the irreversible-looking click.
  it("refuses to offer a session that already holds a graph execution", async () => {
    api.json("GET", SESSIONS_PATH, {
      sessions: [
        session({ sessionName: "busy-run", hasActiveGraphWorkflow: true }),
        session({ sessionName: "free-run" }),
      ],
    });
    const user = userEvent.setup();

    renderWithQuery(
      <SpecDeliveryPlanLaunch
        projectName={PROJECT}
        review={signedOffReview()}
      />,
    );

    const panel = await screen.findByRole("region", { name: "Plan launch" });
    await user.click(
      within(panel).getByRole("combobox", { name: "Session to launch in" }),
    );

    expect(
      await screen.findByRole("option", { name: /free-run/ }),
    ).toBeVisible();
    expect(screen.queryByRole("option", { name: /busy-run/ })).toBeNull();
  });

  // An empty picker with no explanation is the same dead end this ticket is
  // about: the human must learn there is nothing to launch into and why.
  it("says why it cannot offer a session when the sessions read fails", async () => {
    api.reply("GET", SESSIONS_PATH, {
      status: 500,
      json: { error: "sessions unavailable" },
    });

    renderWithQuery(
      <SpecDeliveryPlanLaunch
        projectName={PROJECT}
        review={signedOffReview()}
      />,
    );

    const panel = await screen.findByRole("region", { name: "Plan launch" });
    expect(
      await within(panel).findByText(/sessions could not be read/),
    ).toBeVisible();
    expect(
      within(panel).getByRole("button", { name: "Start execution" }),
    ).toBeDisabled();
  });

  // Sign-off is the gate; a candidate that has not passed it must not be
  // launchable from a surface that sits next to the sign-off control.
  it("offers nothing until the displayed candidate is signed off", async () => {
    api.json("GET", SESSIONS_PATH, { sessions: [session()] });

    renderWithQuery(
      <SpecDeliveryPlanLaunch
        projectName={PROJECT}
        review={reviewView({ attempt: { status: "proposed" }, approval: null })}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Plan launch" })).toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: "Start execution" }),
    ).toBeNull();
  });
});
