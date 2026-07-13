// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AlignmentPanelView from "@/features/session/conversation/AlignmentPanelView";
import type {
  AlignmentDecision,
  AlignmentState,
  AlignmentVersion,
} from "@/lib/session-alignment/schemas";

function makeVersion(
  overrides: Partial<AlignmentVersion> = {},
): AlignmentVersion {
  return {
    id: "ver-1",
    version: 1,
    content: "Mission: ship the alignment panel.",
    contentHash: "hash-1",
    status: "active",
    source: "align_initial",
    authorConversationId: "conv-1",
    autoActivate: false,
    linkedDecisionIds: [],
    createdAt: "2026-06-26T00:00:00.000Z",
    activatedAt: "2026-06-26T00:00:00.000Z",
    approver: "alex",
    ...overrides,
  };
}

function makeDecision(
  overrides: Partial<AlignmentDecision> = {},
): AlignmentDecision {
  return {
    id: "dec-1",
    statement: "Use SQLite as the source of truth.",
    rationale: null,
    originConversationId: "conv-1",
    originMessageId: "msg-1",
    producedVersion: 2,
    approver: "alex",
    approvedAt: "2026-06-26T01:00:00.000Z",
    createdAt: "2026-06-26T01:00:00.000Z",
    ...overrides,
  };
}

function makeState(overrides: Partial<AlignmentState> = {}): AlignmentState {
  return {
    active: null,
    draft: null,
    history: [],
    decisions: [],
    pendingProposals: [],
    preview: null,
    ...overrides,
  };
}

const noop = () => {};

describe("AlignmentPanelView rollback pending feedback", () => {
  function renderHistory(pendingRollbackVersion: number | null) {
    const v1 = makeVersion({ id: "v1", version: 1, status: "superseded" });
    const v2 = makeVersion({ id: "v2", version: 2, status: "superseded" });
    const v3 = makeVersion({ id: "v3", version: 3, status: "active" });
    render(
      <AlignmentPanelView
        state={makeState({ active: v3, history: [v3, v2, v1] })}
        isLoading={false}
        onSelectDiff={noop}
        onRollback={noop}
        pendingRollbackVersion={pendingRollbackVersion}
      />,
    );
  }

  it("shows Rolling back… on the version being rolled back and disables every rollback button", () => {
    renderHistory(1);
    const pending = screen.getByRole("button", { name: /rolling back…/i });
    expect(pending).toBeDisabled();
    expect(pending).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("button", { name: /roll back to v2/i }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: /roll back to v1/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps rollback buttons enabled when no rollback is pending", () => {
    renderHistory(null);
    expect(
      screen.getByRole("button", { name: /roll back to v1/i }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /roll back to v2/i }),
    ).toBeEnabled();
  });
});

describe("AlignmentPanelView", () => {
  it("renders an empty state when there is no alignment", () => {
    render(
      <AlignmentPanelView
        state={makeState()}
        isLoading={false}
        onSelectDiff={noop}
        onRollback={noop}
      />,
    );
    expect(screen.getByText(/no alignment/i)).toBeInTheDocument();
  });

  it("renders an empty state when state is null", () => {
    render(
      <AlignmentPanelView
        state={null}
        isLoading={false}
        onSelectDiff={noop}
        onRollback={noop}
      />,
    );
    expect(screen.getByText(/no alignment/i)).toBeInTheDocument();
  });

  it("renders the active charter content and last-updated metadata", async () => {
    const active = makeVersion({
      version: 3,
      content: "Mission: ship the alignment panel verbatim.",
      activatedAt: "2026-06-26T00:00:00.000Z",
      approver: "alex",
    });
    const { container } = render(
      <AlignmentPanelView
        state={makeState({ active, history: [active] })}
        isLoading={false}
        onSelectDiff={noop}
        onRollback={noop}
      />,
    );
    // The charter is a long-form document surface: it renders through the
    // canonical MarkdownViewport + document adapter, not a bespoke renderer.
    await waitFor(() => {
      expect(
        container.querySelector('[data-markdown-intent="document"]'),
      ).not.toBeNull();
    });
    expect(container.querySelector("[data-markdown-viewport]")).not.toBeNull();
    expect(
      screen.getByText(/Mission: ship the alignment panel verbatim\./),
    ).toBeInTheDocument();
    // last-updated metadata: version + approver surfaced in the panel.
    expect(screen.getAllByText(/v3/).length).toBeGreaterThan(0);
    expect(screen.getByText(/by alex/)).toBeInTheDocument();
  });

  it("omits the draft section when no draft exists", () => {
    const active = makeVersion({ version: 1 });
    render(
      <AlignmentPanelView
        state={makeState({ active, history: [active] })}
        isLoading={false}
        onSelectDiff={noop}
        onRollback={noop}
      />,
    );
    expect(screen.queryByTestId("alignment-draft")).not.toBeInTheDocument();
  });

  it("shows the draft section with its content only when a draft exists", async () => {
    const active = makeVersion({ version: 1 });
    const draft = makeVersion({
      id: "draft-1",
      version: null,
      status: "draft",
      content: "Draft mission awaiting approval.",
    });
    render(
      <AlignmentPanelView
        state={makeState({ active, draft, history: [active] })}
        isLoading={false}
        onSelectDiff={noop}
        onRollback={noop}
      />,
    );
    const draftSection = screen.getByTestId("alignment-draft");
    await waitFor(() => {
      expect(
        within(draftSection).getByText(/Draft mission awaiting approval\./),
      ).toBeInTheDocument();
    });
  });

  it("lists version history newest-first", () => {
    const v1 = makeVersion({
      id: "v1",
      version: 1,
      status: "superseded",
      content: "v1 content",
    });
    const v2 = makeVersion({
      id: "v2",
      version: 2,
      status: "superseded",
      content: "v2 content",
    });
    const v3 = makeVersion({
      id: "v3",
      version: 3,
      status: "active",
      content: "v3 content",
    });
    render(
      <AlignmentPanelView
        state={makeState({ active: v3, history: [v3, v2, v1] })}
        isLoading={false}
        onSelectDiff={noop}
        onRollback={noop}
      />,
    );
    const rows = screen.getAllByTestId("alignment-history-row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("v3")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("v1")).toBeInTheDocument();
  });

  it("fires onRollback with the prior version number from a history rollback control", async () => {
    const onRollback = vi.fn();
    const v1 = makeVersion({ id: "v1", version: 1, status: "superseded" });
    const v2 = makeVersion({ id: "v2", version: 2, status: "active" });
    render(
      <AlignmentPanelView
        state={makeState({ active: v2, history: [v2, v1] })}
        isLoading={false}
        onSelectDiff={noop}
        onRollback={onRollback}
      />,
    );
    const rollback = screen.getByRole("button", { name: /roll back to v1/i });
    await userEvent.click(rollback);
    expect(onRollback).toHaveBeenCalledWith(1);
  });

  it("fires onSelectDiff with the chosen from/to versions", async () => {
    const onSelectDiff = vi.fn();
    const v1 = makeVersion({ id: "v1", version: 1, status: "superseded" });
    const v2 = makeVersion({ id: "v2", version: 2, status: "active" });
    render(
      <AlignmentPanelView
        state={makeState({ active: v2, history: [v2, v1] })}
        isLoading={false}
        onSelectDiff={onSelectDiff}
        onRollback={noop}
      />,
    );
    const fromSelect = screen.getByLabelText(/diff from/i);
    const toSelect = screen.getByLabelText(/diff to/i);
    await userEvent.selectOptions(fromSelect, "1");
    await userEvent.selectOptions(toSelect, "2");
    await userEvent.click(screen.getByRole("button", { name: /compare/i }));
    expect(onSelectDiff).toHaveBeenCalledWith(1, 2);
  });

  it("renders the returned diff content when a diff is supplied", () => {
    const v1 = makeVersion({ id: "v1", version: 1, status: "superseded" });
    const v2 = makeVersion({ id: "v2", version: 2, status: "active" });
    render(
      <AlignmentPanelView
        state={makeState({ active: v2, history: [v2, v1] })}
        isLoading={false}
        diff={{
          from: 1,
          to: 2,
          fromContent: "OLD CHARTER TEXT",
          toContent: "NEW CHARTER TEXT",
        }}
        onSelectDiff={noop}
        onRollback={noop}
      />,
    );
    expect(screen.getByText(/OLD CHARTER TEXT/)).toBeInTheDocument();
    expect(screen.getByText(/NEW CHARTER TEXT/)).toBeInTheDocument();
  });

  it("renders decisions in the order provided by the state (newest-first per the API)", () => {
    const older = makeDecision({
      id: "dec-old",
      statement: "Older decision.",
      approvedAt: "2026-06-26T00:00:00.000Z",
    });
    const newer = makeDecision({
      id: "dec-new",
      statement: "Newer decision.",
      approvedAt: "2026-06-26T02:00:00.000Z",
    });
    render(
      <AlignmentPanelView
        state={makeState({ decisions: [newer, older] })}
        isLoading={false}
        onSelectDiff={noop}
        onRollback={noop}
      />,
    );
    const rows = screen.getAllByTestId("alignment-decision-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(/Newer decision\./)).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/Older decision\./)).toBeInTheDocument();
  });

  it("fires onNavigateToMessage from a decision-log message link", async () => {
    const onNavigateToMessage = vi.fn();
    const decision = makeDecision({
      originConversationId: "conv-7",
      originMessageId: "msg-42",
    });
    render(
      <AlignmentPanelView
        state={makeState({ decisions: [decision] })}
        isLoading={false}
        onSelectDiff={noop}
        onRollback={noop}
        onNavigateToMessage={onNavigateToMessage}
      />,
    );
    const link = screen.getByRole("button", { name: /view message/i });
    await userEvent.click(link);
    expect(onNavigateToMessage).toHaveBeenCalledWith("conv-7", "msg-42");
  });

  it("exposes a produced-version indicator that selects the version in the diff", async () => {
    const onSelectDiff = vi.fn();
    const v1 = makeVersion({ id: "v1", version: 1, status: "superseded" });
    const v2 = makeVersion({ id: "v2", version: 2, status: "active" });
    const decision = makeDecision({ producedVersion: 2 });
    render(
      <AlignmentPanelView
        state={makeState({
          active: v2,
          history: [v2, v1],
          decisions: [decision],
        })}
        isLoading={false}
        onSelectDiff={onSelectDiff}
        onRollback={noop}
      />,
    );
    const row = screen.getByTestId("alignment-decision-row");
    const producedLink = within(row).getByRole("button", { name: /v2/ });
    await userEvent.click(producedLink);
    // Selecting the produced version diffs it against its predecessor (1 → 2).
    expect(onSelectDiff).toHaveBeenCalledWith(1, 2);
  });

  it("renders a decision row with a null produced version gracefully", () => {
    const decision = makeDecision({ producedVersion: null });
    render(
      <AlignmentPanelView
        state={makeState({ decisions: [decision] })}
        isLoading={false}
        onSelectDiff={noop}
        onRollback={noop}
      />,
    );
    const row = screen.getByTestId("alignment-decision-row");
    expect(
      within(row).getByText(/Use SQLite as the source of truth\./),
    ).toBeInTheDocument();
    // No produced-version link when not yet activated.
    expect(
      within(row).queryByRole("button", { name: /^v\d+$/ }),
    ).not.toBeInTheDocument();
  });

  it("renders the live preview verbatim, labeled as what agents receive", () => {
    const active = makeVersion({ version: 1 });
    const preview =
      "<session-charter>\nThis governs the session.\nMission: x\n</session-charter>";
    render(
      <AlignmentPanelView
        state={makeState({ active, history: [active], preview })}
        isLoading={false}
        onSelectDiff={noop}
        onRollback={noop}
      />,
    );
    const previewRegion = screen.getByTestId("alignment-preview");
    expect(previewRegion).toHaveTextContent("This governs the session.");
    expect(screen.getByText(/what agents receive/i)).toBeInTheDocument();
  });
});
