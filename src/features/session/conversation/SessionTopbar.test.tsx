// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import SessionTopbar from "@/features/session/conversation/SessionTopbar";
import type { ComponentProps } from "react";

// Topbar pulls in next/link, next/navigation, and query/store hooks.
vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);
vi.mock(
  "next/navigation",
  async () => (await import("@/test/component-mocks")).nextNavigationMock,
);
vi.mock("@/stores/unified-panel.store", () => ({
  useUnifiedPanelOpen: () => false,
  useToggleUnifiedPanel: () => vi.fn(),
}));
vi.mock("@/lib/notifications/queries", () => ({
  useNotificationsQuery: () => ({ data: undefined }),
}));
vi.mock("@/stores/notification.store", () => ({
  useActiveJobs: () => [],
}));

type Props = ComponentProps<typeof SessionTopbar>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    projectName: "my-proj",
    sessionName: "sess-1",
    decodedProjectName: "my proj",
    statusDotClass: "status-dot-idle",
    displayStatus: "idle",
    tddEnabled: true,
    onTddChange: vi.fn(),
    tddDisabled: false,
    layout: "default",
    onLayoutChange: vi.fn(),
    dsOpen: false,
    dsServers: [],
    dsClose: vi.fn(),
    dsToggle: vi.fn(),
    dsStartServer: vi.fn(),
    dsStopServer: vi.fn(),
    dsStartAll: vi.fn(),
    dsStopAll: vi.fn(),
    commitDisabled: false,
    mergeDisabled: false,
    targetBranch: "main",
    onCommit: vi.fn(),
    onMerge: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

describe("SessionTopbar", () => {
  it("renders the breadcrumb, Commit, Merge, and Delete controls", () => {
    renderWithQuery(<SessionTopbar {...makeProps()} />);
    expect(screen.getByText("projects")).toBeInTheDocument();
    expect(screen.getByText("my proj")).toBeInTheDocument();
    expect(screen.getByText("sess-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete session" }),
    ).toBeInTheDocument();
  });

  it("disables the Commit button when commitDisabled=true", () => {
    renderWithQuery(<SessionTopbar {...makeProps({ commitDisabled: true })} />);
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
  });

  it("enables the Commit button when commitDisabled=false", () => {
    renderWithQuery(
      <SessionTopbar {...makeProps({ commitDisabled: false })} />,
    );
    expect(screen.getByRole("button", { name: "Commit" })).not.toBeDisabled();
  });

  it("disables the Merge button when mergeDisabled=true", () => {
    renderWithQuery(<SessionTopbar {...makeProps({ mergeDisabled: true })} />);
    expect(screen.getByRole("button", { name: "Merge" })).toBeDisabled();
  });

  it("enables the Merge button when mergeDisabled=false", () => {
    renderWithQuery(<SessionTopbar {...makeProps({ mergeDisabled: false })} />);
    expect(screen.getByRole("button", { name: "Merge" })).not.toBeDisabled();
  });

  it("invokes onCommit when Commit is clicked", () => {
    const onCommit = vi.fn();
    renderWithQuery(<SessionTopbar {...makeProps({ onCommit })} />);
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("invokes onMerge when Merge is clicked", () => {
    const onMerge = vi.fn();
    renderWithQuery(<SessionTopbar {...makeProps({ onMerge })} />);
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(onMerge).toHaveBeenCalledTimes(1);
  });

  it("invokes onDelete when the Delete button is clicked", () => {
    const onDelete = vi.fn();
    renderWithQuery(<SessionTopbar {...makeProps({ onDelete })} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("renders the displayStatus text", () => {
    renderWithQuery(
      <SessionTopbar {...makeProps({ displayStatus: "running" })} />,
    );
    expect(screen.getByText("running")).toBeInTheDocument();
  });
});
