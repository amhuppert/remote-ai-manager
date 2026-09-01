// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { SpecSummaryView } from "@/lib/specs/queries";

import SpecsInventory from "./SpecsInventory";

const UPDATED_AT = "2026-07-18T12:00:00.000Z";

function summary(
  slug: string,
  name: string,
  phase: SpecSummaryView["phase"],
  overrides: Partial<SpecSummaryView> = {},
): SpecSummaryView {
  return {
    spec: {
      id: `spec-${slug}`,
      projectPath: "/repos/command-center",
      slug,
      name,
      gatePolicy: { preset: "contract-bearing" },
      abandonedAt: null,
      abandonedReason: null,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
    },
    phase,
    currentRevision: null,
    counts: { requirements: 3, criteria: 5, decisions: 1, tasks: 4 },
    pendingApprovalCount: 0,
    approvalState: "complete",
    delivery: {
      allWaived: false,
      deliveredCount: 0,
      provenCount: 0,
      deliveredExternallyCriterionIds: [],
      totalInScope: 5,
    },
    imported: false,
    linkedWork: {
      tickets: 0,
      conversations: 0,
      sessions: 0,
      workflowExecutions: 0,
      mergeJobs: 0,
    },
    ...overrides,
  };
}

const inventory = [
  summary(
    "native-sdd",
    "Native spec-driven development",
    {
      primary: "executing",
      authoringFacet: "in_review",
      authoringStage: "design",
    },
    {
      pendingApprovalCount: 2,
      approvalState: "pending",
      delivery: {
        allWaived: false,
        deliveredCount: 7,
        provenCount: 7,
        deliveredExternallyCriterionIds: [],
        totalInScope: 12,
      },
      imported: false,
      linkedWork: {
        tickets: 2,
        conversations: 1,
        sessions: 0,
        workflowExecutions: 1,
        mergeJobs: 0,
      },
    },
  ),
  summary("prompt-audit", "Prompt audit trail", { primary: "approved" }),
  summary("session-handoff", "Session handoff", { primary: "draft" }),
];

/**
 * An import arrives already delivered and already disposed: its criteria were
 * delivered outside this system and its questions came answered. The row has to
 * say where that state came from without borrowing the vocabulary of the gates
 * it never passed — no pending-approval badge it did not earn, and no proof
 * tally it cannot back (R9.3).
 */
const importedDelivered = summary(
  "checkout-rewrite",
  "Checkout rewrite",
  { primary: "delivered" },
  {
    delivery: {
      allWaived: false,
      deliveredCount: 4,
      provenCount: 0,
      deliveredExternallyCriterionIds: [
        "criterion-1",
        "criterion-2",
        "criterion-3",
        "criterion-4",
      ],
      totalInScope: 4,
    },
    imported: true,
    linkedWork: {
      tickets: 0,
      conversations: 0,
      sessions: 0,
      workflowExecutions: 0,
      mergeJobs: 0,
    },
  },
);

const importedInventory = [...inventory, importedDelivered];

describe("SpecsInventory", () => {
  it("renders the desktop inventory as the prototype's dense flat table", () => {
    render(<SpecsInventory specs={inventory} projectName="command-center" />);

    const table = screen.getByRole("table", { name: "Specs" });
    const tableSurface = table.parentElement;
    expect(tableSurface).not.toBeNull();
    expect(tableSurface).not.toHaveClass("rounded-lg");
    expect(tableSurface).not.toHaveClass("border");
    expect(tableSurface).not.toHaveClass("bg-bg-surface");

    const [headingRow] = within(table).getAllByRole("row");
    expect(headingRow).toHaveClass("py-[6px]");

    const row = screen.getByTestId("spec-row-native-sdd");
    expect(row).toHaveClass("py-[9px]");
    expect(row.firstElementChild).not.toHaveClass("min-h-[58px]");
    expect(row.firstElementChild).not.toHaveClass("absolute");
    expect(row.firstElementChild).toHaveClass("self-stretch");
    const phaseAccent = row.firstElementChild?.firstElementChild;
    expect(phaseAccent).toHaveClass("absolute", "top-[-9px]", "bottom-[-10px]");
    for (const cell of within(row).getAllByRole("cell")) {
      expect(cell).not.toHaveClass("py-md");
    }

    expect(
      within(screen.getByTestId("spec-row-prompt-audit")).getAllByText(
        "Complete",
      ),
    ).toHaveLength(1);
  });

  it("presents the prototype inventory columns and phase counts as accessible controls", () => {
    render(<SpecsInventory specs={inventory} projectName="command-center" />);

    const table = screen.getByRole("table", { name: "Specs" });
    for (const heading of [
      "Spec",
      "Name",
      "Phase",
      "Approvals",
      "Execution",
      "Tickets",
      "Updated",
      "Actions",
    ]) {
      expect(
        within(table).getByRole("columnheader", { name: heading }),
      ).toBeInTheDocument();
    }

    expect(screen.getByRole("button", { name: "All 3" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Executing 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Approved 1" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draft 1" })).toBeInTheDocument();

    const row = screen.getByTestId("spec-row-native-sdd");
    expect(within(row).getByText("In review")).toBeInTheDocument();
    expect(within(row).getByText("design stage")).toBeInTheDocument();
    expect(within(row).getByText("2 pending")).toBeInTheDocument();
    expect(within(row).getByText("7/12 delivered")).toBeInTheDocument();
    expect(within(row).getByText("2 tickets")).toBeInTheDocument();
    expect(within(row).getByText("1 conversation")).toBeInTheDocument();
  });

  it("renders unselected phase filters transparently instead of on the UA button fill", () => {
    render(<SpecsInventory specs={inventory} projectName="command-center" />);

    const filters = within(
      screen.getByRole("group", { name: "Filter specs by phase" }),
    ).getAllByRole("button");
    const unselected = filters.filter(
      (chip) => chip.getAttribute("aria-pressed") === "false",
    );

    expect(unselected).toHaveLength(filters.length - 1);
    for (const chip of unselected) {
      expect(chip).toHaveClass("bg-transparent");
    }
  });

  it("filters rows by primary phase without changing the inventory route", async () => {
    const user = userEvent.setup();
    render(<SpecsInventory specs={inventory} projectName="command-center" />);

    await user.click(screen.getByRole("button", { name: "Draft 1" }));

    expect(screen.getByRole("button", { name: "Draft 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("spec-row-session-handoff")).toBeInTheDocument();
    expect(screen.queryByTestId("spec-row-native-sdd")).not.toBeInTheDocument();
  });

  it("marks an imported row with an Imported chip and leaves every other row unmarked", () => {
    render(
      <SpecsInventory specs={importedInventory} projectName="command-center" />,
    );

    const imported = within(
      screen.getByTestId("spec-row-checkout-rewrite"),
    ).getByText("Imported");
    // Provenance, not attention: amber is reserved for awaiting the user, and
    // this row is waiting on nobody.
    expect(imported).toHaveAttribute("data-tone", "neutral");

    for (const slug of ["native-sdd", "prompt-audit", "session-handoff"]) {
      expect(
        within(screen.getByTestId(`spec-row-${slug}`)).queryByText("Imported"),
      ).not.toBeInTheDocument();
    }
  });

  it("counts externally-delivered criteria in the imported row's delivered tally without a pending-approval badge", () => {
    render(
      <SpecsInventory specs={importedInventory} projectName="command-center" />,
    );

    const row = screen.getByTestId("spec-row-checkout-rewrite");
    expect(within(row).getByText("4/4 delivered")).toBeInTheDocument();
    expect(within(row).queryByText(/pending/)).not.toBeInTheDocument();
    expect(within(row).getByText("Complete")).toBeInTheDocument();
  });

  it("lists an imported delivered spec under the delivered phase filter", async () => {
    const user = userEvent.setup();
    render(
      <SpecsInventory specs={importedInventory} projectName="command-center" />,
    );

    await user.click(screen.getByRole("button", { name: "Delivered 1" }));

    expect(screen.getByTestId("spec-row-checkout-rewrite")).toBeInTheDocument();
    expect(screen.queryByTestId("spec-row-native-sdd")).not.toBeInTheDocument();
  });

  it("links each row to its stable spec route and opens row actions from the keyboard", async () => {
    const user = userEvent.setup();
    render(<SpecsInventory specs={inventory} projectName="command-center" />);

    const row = screen.getByTestId("spec-row-native-sdd");
    expect(
      within(row).getByRole("link", { name: "native-sdd" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd");

    const trigger = within(row).getByRole("button", {
      name: "Actions for native-sdd",
    });
    trigger.focus();
    await user.keyboard("{Enter}");

    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: "Open spec" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd");
    expect(
      within(menu).getByRole("menuitem", { name: "Copy spec reference" }),
    ).toBeInTheDocument();
    expect(
      within(menu).queryByRole("menuitem", { name: "Gate policy" }),
    ).not.toBeInTheDocument();
  });
});
