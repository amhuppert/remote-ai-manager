// @vitest-environment jsdom
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { specControlsDetailFixture } from "./SpecControls.fixtures";
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
  it("offers exactly five destinations in one navigation row", () => {
    render(<Harness />);

    const navigation = screen.getByRole("navigation", { name: "Spec views" });
    expect(
      within(navigation)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Overview", "Requirements", "Design", "Delivery", "History"]);
    expect(
      screen.queryByRole("navigation", { name: "Spec inspection" }),
    ).not.toBeInTheDocument();
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
