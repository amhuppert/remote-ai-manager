// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import type { SpecDetailView } from "@/lib/specs/queries";

import { previewView, reviewView } from "./delivery-plan-review.fixtures";
import {
  specControlsDetailFixture,
  strandedProposalDetailFixture,
} from "./SpecControls.fixtures";
import SpecDetailPage, {
  detailStatePresentation,
  SpecDetailContent,
  SpecRevisionBanner,
} from "./SpecDetailPage";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectName: "command-center", slug: "native-sdd" }),
  usePathname: () => "/specs/command-center/native-sdd",
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const DETAIL_HREF = "/specs/command-center/native-sdd";

function bannerDetail(
  pendingApprovals: SpecDetailView["status"]["pendingApprovals"],
): SpecDetailView {
  const detail = specControlsDetailFixture("running");
  return { ...detail, status: { ...detail.status, pendingApprovals } };
}

function renderBanner(detail: SpecDetailView): void {
  render(
    <SpecRevisionBanner
      detail={detail}
      presentation={detailStatePresentation(
        detail.status.phase.primary,
        detail.status.pendingApprovals,
      )}
      detailHref={DETAIL_HREF}
    />,
  );
}

describe("SpecRevisionBanner approvals summary", () => {
  it("names a pending delivery approval and links it to the approval control", () => {
    renderBanner(
      bannerDetail([
        { gate: "delivery", subject: "delivery", elementId: null },
      ]),
    );

    expect(
      screen.getByRole("link", {
        name: "Delivery approval pending — open Execution",
      }),
    ).toHaveAttribute("href", `${DETAIL_HREF}?el=delivery`);
  });

  it("routes pending authoring-gate approvals to review", () => {
    renderBanner(
      bannerDetail([
        { gate: "design", subject: "D1", elementId: "decision-1" },
      ]),
    );

    expect(
      screen.getByRole("link", { name: "1 pending approval — review" }),
    ).toHaveAttribute("href", `${DETAIL_HREF}?view=review`);
  });

  it("routes a pending execution_start approval to Execution", () => {
    renderBanner(
      bannerDetail([
        {
          gate: "execution_start",
          subject: "execution_start",
          elementId: null,
        },
        { gate: "plan", subject: "plan", elementId: null },
      ]),
    );

    expect(
      screen.getByRole("link", { name: "2 pending approvals — review" }),
    ).toHaveAttribute("href", `${DETAIL_HREF}?view=execution`);
  });

  it("keeps static text when no approval is pending", () => {
    renderBanner(bannerDetail([]));

    expect(screen.getByText(/0 pending approvals/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("stranded proposal reachability", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
    api.json("GET", "/api/specs/command-center/native-sdd/lint", {
      revisionId: "revision-1",
      findings: [],
    });
    api.reply("GET", "/api/specs/command-center/native-sdd/plan/review", {
      status: 404,
      json: {
        error:
          "This spec has no delivery plan attempt. Open one with cctl spec plan open native-sdd.",
      },
    });
  });

  afterEach(() => api.restore());

  it("routes an approved legacy head without an attempt to Delivery plan", async () => {
    renderWithQuery(
      <SpecDetailContent
        detail={specControlsDetailFixture()}
        projectName="command-center"
        requestedSlug="native-sdd"
        view="overview"
        onViewChange={() => {}}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Open delivery plan" }),
    ).toHaveAttribute("href", `${DETAIL_HREF}?view=plan`);
  });

  it("routes the Overview primary action to the surface that can act on it", () => {
    renderWithQuery(
      <SpecDetailContent
        detail={strandedProposalDetailFixture()}
        projectName="command-center"
        requestedSlug="native-sdd"
        view="overview"
        onViewChange={() => {}}
      />,
    );

    // The approved head's lifecycle CTA addresses delivery planning, which
    // leaves stranded revision 2 without a reachable act unless it takes
    // precedence here (#50).
    const action = screen.getByRole("link", {
      name: /Dismiss stranded revision 2/i,
    });
    expect(action).toHaveAttribute(
      "href",
      `${DETAIL_HREF}?view=review&revision=revision-2`,
    );
  });
});

describe("ready-to-execute reachability", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
    api.json("GET", "/api/specs/command-center/native-sdd/lint", {
      revisionId: "revision-1",
      findings: [],
    });
    api.json("GET", "/api/specs/command-center/native-sdd/plan/review", {
      ...reviewView({
        attempt: { status: "approved" },
        approval: {
          candidateId: "candidate-2",
          candidateHash: "sha256:candidate-2",
          snapshotId: "snapshot-2",
          approvedAt: "2026-08-14T01:00:00.000Z",
          approvedBy: { kind: "human" },
        },
      }),
    });
  });

  afterEach(() => api.restore());

  // The reported bug: the CTA pointed at `?view=plan`, so a human reading the
  // plan clicked "Start execution" and the link resolved to the page they were
  // already on. It must address the control that can actually launch (#7).
  it("addresses the launch control rather than the surface already on screen", async () => {
    renderWithQuery(
      <SpecDetailContent
        detail={specControlsDetailFixture()}
        projectName="command-center"
        requestedSlug="native-sdd"
        view="plan"
        onViewChange={() => {}}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Start execution" }),
    ).toHaveAttribute("href", `${DETAIL_HREF}?el=launch`);
  });
});

describe("launch deep-link cold load", () => {
  let api: FetchFixture;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    api = installFetchFixture();
    scrollIntoView.mockClear();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    window.history.replaceState({}, "", `${DETAIL_HREF}?el=launch`);
  });

  afterEach(() => {
    api.restore();
    window.history.replaceState({}, "", "/");
  });

  // The launch control sits behind the plan-preview read, so it mounts a
  // whole query AFTER `detail` resolves. A contract that retried only on the
  // detail would land on nothing exactly when a human followed the CTA.
  it("focuses the launch control once the preview it waits on resolves", async () => {
    let releasePreview!: () => void;
    const previewGate = new Promise<void>((resolve) => {
      releasePreview = resolve;
    });
    api.json(
      "GET",
      DETAIL_HREF.replace("/specs", "/api/specs"),
      specControlsDetailFixture(),
    );
    api.json("GET", "/api/specs/command-center/native-sdd/lint", {
      revisionId: "revision-1",
      findings: [],
    });
    api.json("GET", "/api/specs/command-center/native-sdd/plan/review", {
      ...reviewView({
        attempt: { status: "approved" },
        approval: {
          candidateId: "candidate-2",
          candidateHash: "sha256:candidate-2",
          snapshotId: "snapshot-2",
          approvedAt: "2026-08-14T01:00:00.000Z",
          approvedBy: { kind: "human" },
        },
      }),
    });
    api.json("GET", "/api/projects/command-center/sessions", { sessions: [] });
    api.reply(
      "GET",
      "/api/specs/command-center/native-sdd/plan-preview",
      async () => {
        await previewGate;
        return { json: previewView() };
      },
    );

    renderWithQuery(<SpecDetailPage />);

    await screen.findByText("Reading the launch preview…");
    expect(scrollIntoView).not.toHaveBeenCalled();

    releasePreview();

    const launch = await screen.findByRole("region", { name: "Plan launch" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(document.activeElement).toBe(launch);
  });
});

describe("delivery deep-link cold load", () => {
  let api: FetchFixture;
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    api = installFetchFixture();
    scrollIntoView.mockClear();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    window.history.replaceState({}, "", `${DETAIL_HREF}?el=delivery`);
  });

  afterEach(() => {
    api.restore();
    window.history.replaceState({}, "", "/");
  });

  it("opens Execution and focuses the merge gate only after the detail resolves", async () => {
    let releaseDetail!: () => void;
    const detailGate = new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
    api.reply("GET", DETAIL_HREF.replace("/specs", "/api/specs"), async () => {
      await detailGate;
      return { json: specControlsDetailFixture("running") };
    });
    api.json(`GET`, `/api/specs/command-center/native-sdd/lint`, {
      revisionId: "revision-1",
      findings: [],
    });
    api.json(`POST`, `/api/specs/command-center/native-sdd/actions/verify`, {
      ok: true,
      checkedRevisionIds: [],
      mismatches: [],
      consistencyFindings: [],
    });

    renderWithQuery(<SpecDetailPage />);

    // The hash-style single-shot resolution dies here: while the page loads
    // there is no target. The ?el= contract retries after `detail` resolves.
    expect(screen.getByText("Loading spec…")).toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();

    releaseDetail();

    const mergeGate = await screen.findByRole("region", {
      name: "Merge gate for execution-1",
    });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(document.activeElement).toBe(mergeGate);
  });
});
