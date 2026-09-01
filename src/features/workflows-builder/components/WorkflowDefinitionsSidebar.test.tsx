// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WorkflowDefinitionsSidebar from "./WorkflowDefinitionsSidebar";

const baseProps = {
  selectedId: null as string | null,
  onSelect: vi.fn(),
  onCreate: vi.fn(),
  isLoading: false,
};

const DEFINITIONS = [
  {
    id: "wf-1",
    name: "checkout-v2 release train",
    revision: 5,
    contextCount: 6,
  },
  {
    id: "wf-2",
    name: "Nightly seam ratchet",
    revision: 2,
    contextCount: 3,
  },
];

const MANAGED_DEFINITIONS = [
  {
    id: "wf-current",
    name: "Native SDD · checkout",
    revision: 4,
    contextCount: 3,
    updatedAt: "2026-08-31T12:00:00.000Z",
    management: {
      kind: "native_sdd_delivery" as const,
      specId: "spec-1",
      specSlug: "checkout",
      specName: "Checkout",
      attemptId: "attempt-2",
      pinnedRevisionId: "revision-8",
      pinnedRevisionNumber: 8,
      lifecycle: "draft" as const,
      editable: true,
      isCurrentDefinition: true,
      specHref: "/specs/demo/checkout",
      builderHref: "/projects/demo/workflows?definition=wf-current",
      executionHref: null,
    },
  },
  {
    id: "wf-launched",
    name: "Native SDD · checkout · launch",
    revision: 2,
    contextCount: 2,
    updatedAt: "2026-08-30T12:00:00.000Z",
    management: {
      kind: "native_sdd_delivery" as const,
      specId: "spec-1",
      specSlug: "checkout",
      specName: "Checkout",
      attemptId: "attempt-1",
      pinnedRevisionId: "revision-5",
      pinnedRevisionNumber: 5,
      lifecycle: "launched" as const,
      editable: false,
      isCurrentDefinition: false,
      specHref: "/specs/demo/checkout",
      builderHref: "/projects/demo/workflows?definition=wf-launched",
      executionHref: "/projects/demo/session/workflow?execution=execution-1",
    },
  },
  {
    id: "wf-past",
    name: "Native SDD · checkout · old",
    revision: 1,
    contextCount: 1,
    updatedAt: "2026-08-29T12:00:00.000Z",
    management: {
      kind: "native_sdd_delivery" as const,
      specId: "spec-1",
      specSlug: "checkout",
      specName: "Checkout",
      attemptId: "attempt-0",
      pinnedRevisionId: "revision-2",
      pinnedRevisionNumber: 2,
      lifecycle: "superseded" as const,
      editable: false,
      isCurrentDefinition: false,
      specHref: "/specs/demo/checkout",
      builderHref: "/projects/demo/workflows?definition=wf-past",
      executionHref: null,
    },
  },
];

describe("WorkflowDefinitionsSidebar", () => {
  it("lists each definition with its revision and context count", () => {
    render(
      <WorkflowDefinitionsSidebar {...baseProps} definitions={DEFINITIONS} />,
    );

    expect(
      screen.getByRole("button", { name: /checkout-v2 release train/ }),
    ).toHaveTextContent("r5 · 6 contexts");
    expect(
      screen.getByRole("button", { name: /Nightly seam ratchet/ }),
    ).toHaveTextContent("r2 · 3 contexts");
  });

  it("counts a single context in the singular", () => {
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={[
          { id: "wf-9", name: "Solo", revision: 1, contextCount: 1 },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: /Solo/ })).toHaveTextContent(
      "r1 · 1 context",
    );
  });

  // The list endpoint returns a summary without the definition body, and this
  // surface may not change API responses — an unloaded row states its revision
  // rather than claiming zero contexts.
  it("omits the count for a definition whose draft has not been loaded", () => {
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={[{ id: "wf-9", name: "Unloaded", revision: 4 }]}
      />,
    );
    const row = screen.getByRole("button", { name: /Unloaded/ });
    expect(row).toHaveTextContent("r4");
    expect(row).not.toHaveTextContent("contexts");
  });

  it("marks the active definition with aria-current", () => {
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={DEFINITIONS}
        selectedId="wf-2"
      />,
    );

    expect(
      screen.getByRole("button", { name: /Nightly seam ratchet/ }),
    ).toHaveAttribute("aria-current", "true");
    expect(
      screen.getByRole("button", { name: /checkout-v2 release train/ }),
    ).not.toHaveAttribute("aria-current");
  });

  it("marks only the active row unsaved while its draft is dirty", () => {
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={DEFINITIONS}
        selectedId="wf-1"
        activeDraftDirty
      />,
    );

    const active = screen.getByRole("button", {
      name: /checkout-v2 release train/,
    });
    expect(active).toHaveTextContent("r5 · 6 contexts · unsaved");
    expect(
      active.querySelector('[data-testid="definition-unsaved-dot"]'),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /Nightly seam ratchet/ }),
    ).not.toHaveTextContent("unsaved");
  });

  it("omits the unsaved marker when the active draft is clean", () => {
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={DEFINITIONS}
        selectedId="wf-1"
      />,
    );
    expect(
      screen.getByRole("button", { name: /checkout-v2 release train/ }),
    ).not.toHaveTextContent("unsaved");
  });

  it("loads a definition when its row is chosen", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={DEFINITIONS}
        onSelect={onSelect}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /Nightly seam ratchet/ }),
    );
    expect(onSelect).toHaveBeenCalledWith("wf-2");
  });

  it("offers New workflow at the head of the list", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={DEFINITIONS}
        onCreate={onCreate}
      />,
    );

    await user.click(screen.getByRole("button", { name: "New workflow" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("groups managed definitions by spec and collapses older candidates", async () => {
    const user = userEvent.setup();
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={[DEFINITIONS[0]!, ...MANAGED_DEFINITIONS]}
      />,
    );

    expect(screen.getByText("Definitions")).toBeInTheDocument();
    expect(screen.getByText("Spec delivery")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Checkout" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Native SDD · checkout — Draft/ }),
    ).toHaveTextContent("Draft · spec r8 · r4 · 3 contexts");
    expect(
      screen.getByRole("button", {
        name: /Native SDD · checkout · launch — Launched/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Native SDD · checkout · old/ }),
    ).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Past candidates (1)" }),
    );
    expect(
      screen.getByRole("button", { name: /Native SDD · checkout · old/ }),
    ).toBeInTheDocument();
  });

  it("expands a past candidate selected by a builder deep link", () => {
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={MANAGED_DEFINITIONS}
        selectedId="wf-past"
      />,
    );

    expect(
      screen.getByRole("button", { name: /Native SDD · checkout · old/ }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("shows Creating… and disables the create button while creation is in flight", () => {
    render(
      <WorkflowDefinitionsSidebar {...baseProps} definitions={[]} isCreating />,
    );
    expect(screen.getByRole("button", { name: /creating…/i })).toBeDisabled();
  });

  it("collapses to a strip that still names every definition, and expands again", async () => {
    const user = userEvent.setup();
    render(
      <WorkflowDefinitionsSidebar
        {...baseProps}
        definitions={DEFINITIONS}
        selectedId="wf-1"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: /collapse definitions/i }),
    );

    const strip = screen.getByRole("navigation", { name: "Definitions" });
    expect(strip).toHaveClass("w-[48px]");
    // Every destination survives the collapse: create, each definition, and the
    // control that brings the full rail back.
    expect(
      screen.getByRole("button", { name: /new workflow/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /checkout-v2 release train/ }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /expand definitions/i }),
    );
    expect(
      screen.getByRole("button", { name: /Nightly seam ratchet/ }),
    ).toHaveTextContent("r2 · 3 contexts");
  });
});

describe("WorkflowDefinitionsSidebar — §12 collapse ladder", () => {
  /** A viewport `matchMedia` answers per query, so 900px is narrow but not mobile. */
  function installViewport(width: number): void {
    vi.spyOn(window, "matchMedia").mockImplementation((query: string) => {
      const limit = Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
      return {
        matches: width <= limit,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      } as unknown as MediaQueryList;
    });
  }

  it("keeps the rail expanded above 1100px", () => {
    installViewport(1280);
    render(
      <WorkflowDefinitionsSidebar {...baseProps} definitions={DEFINITIONS} />,
    );

    expect(
      screen.getByRole("button", { name: "Collapse definitions sidebar" }),
    ).toBeInTheDocument();
  });

  it("collapses the rail to a strip at 1100px and below", () => {
    installViewport(900);
    render(
      <WorkflowDefinitionsSidebar {...baseProps} definitions={DEFINITIONS} />,
    );

    // The strip keeps its own way back and every definition stays reachable —
    // the rail narrows, it does not drop what it holds.
    expect(
      screen.getByRole("button", { name: "Expand definitions sidebar" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /checkout-v2 release train/ }),
    ).toBeInTheDocument();
  });

  it("gives the whole panel to the rail at the mobile breakpoint", () => {
    installViewport(390);
    render(
      <WorkflowDefinitionsSidebar {...baseProps} definitions={DEFINITIONS} />,
    );

    // The bottom tab bar decides what is on screen there, so a second collapse
    // state would hide the panel the tab bar says is showing.
    expect(
      screen.queryByRole("button", { name: "Expand definitions sidebar" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /checkout-v2 release train/ }),
    ).toHaveTextContent("r5 · 6 contexts");
  });
});
