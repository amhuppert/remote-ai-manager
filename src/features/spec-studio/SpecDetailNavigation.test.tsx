// @vitest-environment jsdom
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";

import {
  draftingSpecControlsDetailFixture,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";
import SpecDetailViews, { type DetailView } from "./SpecDetailViews";

function Harness(): React.JSX.Element {
  const [view, setView] = useState<DetailView>("overview");
  return (
    <QueryClientProvider client={new QueryClient()}>
      <SpecDetailViews
        detail={specControlsDetailFixture()}
        projectName="command-center"
        view={view}
        onViewChange={setView}
      >
        <div>Overview document</div>
      </SpecDetailViews>
    </QueryClientProvider>
  );
}

describe("SpecDetailViews navigation", () => {
  it("offers gate policy alongside the document destinations", () => {
    render(<Harness />);

    const navigation = screen.getByRole("navigation", { name: "Spec views" });
    expect(
      within(navigation)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual([
      "Overview",
      "Requirements",
      "Design",
      "Delivery",
      "Gate policy",
      "History",
    ]);
    expect(
      screen.queryByRole("navigation", { name: "Spec inspection" }),
    ).not.toBeInTheDocument();
  });

  it("keeps gate policy on its own screen", async () => {
    render(<Harness />);
    expect(
      screen.queryByRole("radiogroup", { name: "Gate policy preset" }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Gate policy" }));
    expect(
      screen.getByRole("radiogroup", { name: "Gate policy preset" }),
    ).toBeVisible();
    expect(screen.queryByText("Overview document")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Abandon spec" })).toBeNull();
  });

  it("selects each destination without introducing a second tab row", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const navigation = screen.getByRole("navigation", { name: "Spec views" });

    await user.click(
      within(navigation).getByRole("button", { name: "Design" }),
    );

    expect(
      within(navigation).getByRole("button", { name: "Design" }),
    ).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "Decisions" })).toBeVisible();
  });
});

function renderView(detail: SpecDetailView, view: DetailView): void {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SpecDetailViews
        detail={detail}
        projectName="command-center"
        view={view}
        onViewChange={() => undefined}
      >
        <div>Overview document</div>
      </SpecDetailViews>
    </QueryClientProvider>,
  );
}

describe("SpecDetailViews draft review host", () => {
  it.each([
    ["requirements", "requirements"],
    ["design", "design"],
  ] as const)(
    "reviews an open %s-stage draft in the %s view",
    (stage, view) => {
      renderView(draftingSpecControlsDetailFixture(stage), view);

      expect(screen.getByTestId("spec-review-mode")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", {
          name: `Review ${stage}-stage revision 2`,
        }),
      ).toBeVisible();
    },
  );

  it("keeps review out of the view that does not own the draft's stage", () => {
    renderView(draftingSpecControlsDetailFixture("design"), "requirements");

    expect(screen.queryByTestId("spec-review-mode")).toBeNull();
  });

  it("offers no review when no draft is open", () => {
    renderView(specControlsDetailFixture(), "requirements");

    expect(screen.queryByTestId("spec-review-mode")).toBeNull();
  });

  it("hides review on an abandoned spec", () => {
    const detail = draftingSpecControlsDetailFixture("requirements");
    renderView(
      {
        ...detail,
        spec: {
          ...detail.spec,
          abandonedAt: "2026-07-18T12:00:00.000Z",
          abandonedReason: "The product direction was withdrawn.",
        },
      },
      "requirements",
    );

    expect(screen.queryByTestId("spec-review-mode")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: /Review requirements-stage/ }),
    ).toBeNull();
  });
});
