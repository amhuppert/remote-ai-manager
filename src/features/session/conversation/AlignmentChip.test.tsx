// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  deriveAlignmentChipState,
  type AlignmentChipState,
} from "@/features/session/conversation/alignment-chip-state";
import AlignmentChip from "@/features/session/conversation/AlignmentChip";
import type {
  AlignmentState,
  AlignmentVersion,
} from "@/lib/session-alignment/schemas";

function makeVersion(
  overrides: Partial<AlignmentVersion> = {},
): AlignmentVersion {
  return {
    id: "ver-1",
    version: 2,
    content: "Mission: ship the thing.",
    contentHash: "hash",
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

describe("deriveAlignmentChipState", () => {
  it("returns none when neither active nor draft exists", () => {
    expect(deriveAlignmentChipState(makeState(), null)).toBe("none");
    expect(deriveAlignmentChipState(null, null)).toBe("none");
    expect(deriveAlignmentChipState(undefined, null)).toBe("none");
  });

  it("returns pending when a draft exists even with an active charter", () => {
    const draft = makeVersion({
      id: "draft-1",
      version: null,
      status: "draft",
    });
    expect(deriveAlignmentChipState(makeState({ draft }), null)).toBe(
      "pending",
    );

    const active = makeVersion({ version: 3 });
    expect(deriveAlignmentChipState(makeState({ active, draft }), 3)).toBe(
      "pending",
    );
  });

  it("returns active when active && seen >= version (or seen null)", () => {
    const active = makeVersion({ version: 2 });
    expect(deriveAlignmentChipState(makeState({ active }), null)).toBe(
      "active",
    );
    expect(deriveAlignmentChipState(makeState({ active }), 2)).toBe("active");
    expect(deriveAlignmentChipState(makeState({ active }), 5)).toBe("active");
  });

  it("returns stale when seen < active.version", () => {
    const active = makeVersion({ version: 4 });
    expect(deriveAlignmentChipState(makeState({ active }), 2)).toBe("stale");
    expect(deriveAlignmentChipState(makeState({ active }), 3)).toBe("stale");
  });
});

describe("AlignmentChip", () => {
  const states: AlignmentChipState[] = ["none", "active", "pending", "stale"];

  it.each(states)("renders the Alignment label in the %s state", (state) => {
    render(
      <AlignmentChip
        state={state}
        activeVersion={state === "none" ? null : 2}
      />,
    );
    expect(screen.getByText(/alignment/i)).toBeInTheDocument();
  });

  it("shows the active version in the active state", () => {
    render(<AlignmentChip state="active" activeVersion={3} />);
    expect(screen.getByText(/v3/)).toBeInTheDocument();
  });

  it("shows the active version and a stale indicator in the stale state", () => {
    render(<AlignmentChip state="stale" activeVersion={4} />);
    expect(screen.getByText(/v4/)).toBeInTheDocument();
    expect(screen.getByText(/stale/i)).toBeInTheDocument();
  });

  it("indicates an update is pending in the pending state", () => {
    render(<AlignmentChip state="pending" activeVersion={2} />);
    expect(screen.getByText(/pending/i)).toBeInTheDocument();
  });

  it("renders an interactive control in the none state that fires onActivate", async () => {
    const onActivate = vi.fn();
    render(
      <AlignmentChip
        state="none"
        activeVersion={null}
        onActivate={onActivate}
      />,
    );
    const control = screen.getByRole("button", { name: /alignment/i });
    await userEvent.click(control);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
