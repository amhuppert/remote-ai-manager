// @vitest-environment jsdom
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { specControlsDetailFixture } from "./SpecControls.fixtures";
import SpecDetailViews, { type DetailView } from "./SpecDetailViews";

/**
 * Stands in for the address bar that owns the active surface in production, so
 * these tests exercise tab and back-control selection without a router.
 */
function AddressBarHarness({
  initialView,
}: {
  initialView: DetailView;
}): React.JSX.Element {
  const [view, setView] = useState(initialView);
  return (
    <SpecDetailViews
      detail={specControlsDetailFixture()}
      projectName="command-center"
      view={view}
      onViewChange={setView}
    >
      <div>Overview document</div>
    </SpecDetailViews>
  );
}

function renderDetailViews(initialView: DetailView = "overview"): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AddressBarHarness initialView={initialView} />
    </QueryClientProvider>,
  );
}

function appearsBefore(first: Element, second: Element): boolean {
  return Boolean(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
}

describe("SpecDetailViews", () => {
  it("uses only the prototype's three primary views on the overview surface", async () => {
    const user = userEvent.setup();
    renderDetailViews();

    const tablist = screen.getByRole("tablist");
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Traceability",
      "History",
    ]);
    expect(tablist).toContainElement(
      screen.getByRole("tab", { name: "Overview" }),
    );
    expect(screen.getByText("Overview document")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Controls" })).toBeNull();
    expect(screen.queryByLabelText("Spec decision surfaces")).toBeNull();
    expect(screen.queryByText("Decision surfaces")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open evidence" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open gate policy" }),
    ).toBeNull();

    await user.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByRole("heading", { name: "History" })).toBeVisible();
  });

  it("gives the primary view navigation an accessible name", () => {
    renderDetailViews();

    expect(screen.getByRole("tablist")).toHaveAccessibleName("Spec views");
  });

  it("identifies the primary view navigation as the prototype's underline strip", () => {
    renderDetailViews();

    expect(screen.getByRole("tablist")).toHaveAttribute(
      "data-appearance",
      "underline",
    );
  });

  it.each([
    [
      "evidence",
      "Evidence by acceptance criterion",
      "Proof is evaluated against each criterion's approved validation strategy.",
    ],
    ["traceability", "Traceability", "Requirement → criteria → tasks"],
    [
      "history",
      "History",
      "Human decisions are recorded separately from policy admissions and execution lifecycle events.",
    ],
  ] as const)(
    "orders the %s subscreen header before the shared underline navigation",
    (initialView, title, subtitle) => {
      renderDetailViews(initialView);

      const back = screen.getByRole("button", {
        name: "Back to native-sdd",
      });
      const heading = screen.getByRole("heading", { name: title });
      const description = screen.getByText(subtitle);
      const navigation = screen.getByRole("tablist", { name: "Spec views" });

      expect(screen.getAllByRole("heading", { name: title })).toHaveLength(1);
      expect(appearsBefore(back, heading)).toBe(true);
      expect(appearsBefore(heading, description)).toBe(true);
      expect(appearsBefore(description, navigation)).toBe(true);
    },
  );

  it("uses the evidence panel title as the single subscreen title", () => {
    renderDetailViews("evidence");

    expect(
      screen.queryByRole("heading", { name: "Evidence" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("heading", {
        name: "Evidence by acceptance criterion",
      }),
    ).toHaveLength(1);
  });

  it("returns from a subscreen through the slug-labeled back control", async () => {
    const user = userEvent.setup();
    renderDetailViews("history");

    await user.click(
      screen.getByRole("button", { name: "Back to native-sdd" }),
    );

    expect(screen.getByText("Overview document")).toBeVisible();
  });

  it("deep-links an inspected trace node to its element", async () => {
    const user = userEvent.setup();
    renderDetailViews("traceability");

    await user.click(
      screen.getByRole("button", { name: "Select requirement R1" }),
    );

    expect(screen.getByRole("link", { name: "Open R1" })).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?el=R1",
    );
  });

  it("lets the controls workflow own its heading without a generic wrapper", () => {
    renderDetailViews("controls");

    expect(
      screen.queryByRole("heading", { name: "Gate policy and execution" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Gate policy" })).toBeVisible();
  });
});
