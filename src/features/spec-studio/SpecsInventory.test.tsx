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
    imported: false,
    linkedWork: {
      tickets: 0,
      conversations: 0,
      sessions: 0,
    },
    ...overrides,
  };
}

const inventory = [
  summary(
    "native-sdd",
    "Native spec-driven development",
    {
      primary: "draft",
      authoringStage: "design",
    },
    {
      pendingApprovalCount: 2,
      approvalState: "pending",
      imported: false,
      linkedWork: {
        tickets: 2,
        conversations: 1,
        sessions: 0,
      },
    },
  ),
  summary("prompt-audit", "Prompt audit trail", { primary: "approved" }),
  summary("session-handoff", "Session handoff", { primary: "draft" }),
];

/** Imported content keeps its provenance beside the authoring approval state. */
const importedSpec = summary(
  "checkout-rewrite",
  "Checkout rewrite",
  { primary: "approved" },
  {
    imported: true,
    linkedWork: {
      tickets: 0,
      conversations: 0,
      sessions: 0,
    },
  },
);

const importedInventory = [...inventory, importedSpec];

describe("SpecsInventory", () => {
  it("presents the prototype inventory columns and phase counts as accessible controls", () => {
    render(<SpecsInventory specs={inventory} projectName="command-center" />);

    const table = screen.getByRole("table", { name: "Specs" });
    for (const heading of [
      "Spec",
      "Name",
      "Phase",
      "Approvals",
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
      screen.getByRole("button", { name: "Approved 1" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Draft 2" })).toBeInTheDocument();

    const row = screen.getByTestId("spec-row-native-sdd");
    expect(within(row).getByText("Draft")).toBeInTheDocument();
    expect(within(row).getByText("design stage")).toBeInTheDocument();
    expect(within(row).getByText("2 pending")).toBeInTheDocument();
    expect(within(row).getByText("2 tickets")).toBeInTheDocument();
    expect(within(row).getByText("1 conversation")).toBeInTheDocument();
  });

  it("filters rows by primary phase without changing the inventory route", async () => {
    const user = userEvent.setup();
    render(<SpecsInventory specs={inventory} projectName="command-center" />);

    await user.click(screen.getByRole("button", { name: "Draft 2" }));

    expect(screen.getByRole("button", { name: "Draft 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("spec-row-session-handoff")).toBeInTheDocument();
    expect(
      screen.queryByTestId("spec-row-prompt-audit"),
    ).not.toBeInTheDocument();
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

  it("lists an imported spec under the approved phase filter", async () => {
    const user = userEvent.setup();
    render(
      <SpecsInventory specs={importedInventory} projectName="command-center" />,
    );

    await user.click(screen.getByRole("button", { name: "Approved 2" }));

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
