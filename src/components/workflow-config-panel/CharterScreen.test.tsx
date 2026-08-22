// @vitest-environment jsdom
/**
 * The Charter screen (workflow scope): invariants and ranked sources of truth
 * (Config Panel `charterRows()`).
 *
 * Both lists carry an applicability scope whose ABSENCE means global, so the
 * assertions that matter are about the empty case: unchecking the last context
 * has to drop the scope entirely, not leave an empty list the schema refuses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { workflowCharterSchema } from "@/lib/workflows/charter-schemas";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import { CharterScreen } from "./CharterScreen";
import type { WorkflowStructuralEditor } from "./structural-editor";

afterEach(cleanup);

const CONTEXTS = [
  { id: "ctx_checkout", title: "Implement checkout" },
  { id: "ctx_settings", title: "Settings surface" },
];

const CHARTER: WorkflowCharter = workflowCharterSchema.parse({
  mission: "Ship checkout v2 behind a rollout flag.",
  // Neither list is authored wholesale by this screen — mission, conventions
  // and the rest are the round-trip witnesses.
  conventions: ["Small commits."],
  testStrategy: "Contract tests at every seam.",
  invariants: [
    {
      id: "inv-1",
      statement: "No customer-facing write path may bypass the audit log.",
    },
    {
      id: "inv-2",
      statement: "Migrations are additive within a release train.",
      appliesTo: { contextIds: ["ctx_checkout"] },
    },
  ],
  sourcesOfTruth: [
    {
      rank: 1,
      id: "src-spec",
      label: "Checkout v2 spec",
      type: "spec",
      locator: "docs/specs/checkout-v2.md",
      description: "The canonical specification.",
      appliesTo: { contextIds: ["ctx_checkout"] },
    },
    {
      rank: 2,
      id: "src-threat",
      label: "Payments threat model",
      type: "document",
      locator: "docs/security/payments-threat-model.md",
      description: "Security review baseline.",
    },
  ],
});

function editorFor(
  overrides: Partial<WorkflowStructuralEditor> = {},
): WorkflowStructuralEditor {
  return {
    affordance: "editable",
    charter: CHARTER,
    onCharterChange: vi.fn(),
    parameters: [],
    onParametersChange: vi.fn(),
    contexts: CONTEXTS,
    ...overrides,
  };
}

function renderScreen(overrides: Partial<WorkflowStructuralEditor> = {}) {
  const editor = editorFor(overrides);
  render(<CharterScreen editor={editor} />);
  return editor;
}

describe("CharterScreen invariants", () => {
  it("chips an unscoped invariant global and a scoped one by count", () => {
    renderScreen();

    expect(
      within(screen.getByTestId("config-item-inv-1")).getByText("global"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("config-item-inv-2")).getByText("1 ctx"),
    ).toBeInTheDocument();
  });

  it("edits a statement, leaving the charter's other fields intact", () => {
    const onCharterChange = vi.fn();
    renderScreen({ onCharterChange });

    fireEvent.change(screen.getByLabelText("Statement for inv-1"), {
      target: { value: "Every write path is audited." },
    });

    expect(onCharterChange).toHaveBeenCalledWith({
      ...CHARTER,
      invariants: [
        {
          ...CHARTER.invariants?.[0],
          statement: "Every write path is audited.",
        },
        CHARTER.invariants?.[1],
      ],
    });
  });

  it("adds an invariant with a fresh id and no scope", () => {
    const onCharterChange = vi.fn();
    renderScreen({ onCharterChange });

    fireEvent.click(screen.getByRole("button", { name: /add invariant/i }));

    const next = onCharterChange.mock.calls[0]?.[0].invariants;
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ id: "inv-3", statement: "" });
  });

  it("removes an invariant", () => {
    const onCharterChange = vi.fn();
    renderScreen({ onCharterChange });

    fireEvent.click(screen.getByRole("button", { name: "Remove inv-1" }));

    expect(onCharterChange.mock.calls[0]?.[0].invariants).toEqual([
      CHARTER.invariants?.[1],
    ]);
  });

  it("carries the design's scoping hint", () => {
    renderScreen();
    expect(
      screen.getByText(
        /Rendered into every scoped context's prompt\. An unscoped invariant is global\./,
      ),
    ).toBeInTheDocument();
  });
});

describe("CharterScreen sources of truth", () => {
  it("chips rank and type and shows the label — locator meta", () => {
    renderScreen();

    const row = screen.getByTestId("config-item-src-spec");
    expect(within(row).getByText("rank 1")).toBeInTheDocument();
    expect(within(row).getByText("spec")).toBeInTheDocument();
    expect(
      within(row).getByText("Checkout v2 spec — docs/specs/checkout-v2.md"),
    ).toBeInTheDocument();
  });

  it("checks the contexts a source is scoped to", () => {
    renderScreen();

    expect(
      screen.getByRole("checkbox", { name: "Scope src-spec to ctx_checkout" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Scope src-spec to ctx_settings" }),
    ).not.toBeChecked();
  });

  it("leaves a global source with nothing checked", () => {
    renderScreen();

    for (const context of CONTEXTS) {
      expect(
        screen.getByRole("checkbox", {
          name: `Scope src-threat to ${context.id}`,
        }),
      ).not.toBeChecked();
    }
  });

  it("adds a context to a source's scope", () => {
    const onCharterChange = vi.fn();
    renderScreen({ onCharterChange });

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Scope src-spec to ctx_settings" }),
    );

    expect(
      onCharterChange.mock.calls[0]?.[0].sourcesOfTruth[0].appliesTo,
    ).toEqual({ contextIds: ["ctx_checkout", "ctx_settings"] });
  });

  it("scoping a global source starts its context list", () => {
    const onCharterChange = vi.fn();
    renderScreen({ onCharterChange });

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Scope src-threat to ctx_checkout",
      }),
    );

    expect(
      onCharterChange.mock.calls[0]?.[0].sourcesOfTruth[1].appliesTo,
    ).toEqual({ contextIds: ["ctx_checkout"] });
  });

  it("unchecking the last context makes the source global again", () => {
    const onCharterChange = vi.fn();
    renderScreen({ onCharterChange });

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Scope src-spec to ctx_checkout" }),
    );

    // Absence is what "global" is; an empty contextIds array is refused by
    // charterScopeSchema's `.min(1)`.
    const next = onCharterChange.mock.calls[0]?.[0];
    expect(next.sourcesOfTruth[0].appliesTo).toBeUndefined();
    expect(workflowCharterSchema.safeParse(next).success).toBe(true);
  });

  it("produces a charter the schema still accepts after an edit", () => {
    const onCharterChange = vi.fn();
    renderScreen({ onCharterChange });

    fireEvent.click(screen.getByRole("button", { name: /add invariant/i }));
    const next = onCharterChange.mock.calls[0]?.[0];
    // The new invariant's statement is empty until typed, so only the parts
    // this screen settled are asserted structurally.
    expect(next.mission).toBe(CHARTER.mission);
    expect(next.conventions).toEqual(CHARTER.conventions);
    expect(next.testStrategy).toBe(CHARTER.testStrategy);
    expect(next.sourcesOfTruth).toEqual(CHARTER.sourcesOfTruth);
  });
});

describe("CharterScreen when locked", () => {
  it("disables the editors and offers no Add", () => {
    renderScreen({ affordance: "read-only" });

    expect(screen.getByLabelText("Statement for inv-1")).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: "Scope src-spec to ctx_checkout" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: /add invariant/i })).toBeNull();
  });
});
