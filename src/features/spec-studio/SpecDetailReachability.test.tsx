// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import type { SpecDetailView } from "@/lib/specs/queries";

import { specControlsDetailFixture } from "./SpecControls.fixtures";
import SpecDetailPage, {
  detailStatePresentation,
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
        name: "Delivery approval pending — approve in Controls",
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

  it("routes a pending execution_start approval to controls", () => {
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
    ).toHaveAttribute("href", `${DETAIL_HREF}?view=controls`);
  });

  it("keeps static text when no approval is pending", () => {
    renderBanner(bannerDetail([]));

    expect(screen.getByText(/0 pending approvals/)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
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

  it("opens Controls and focuses the merge gate only after the detail resolves", async () => {
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
