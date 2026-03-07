// @vitest-environment jsdom
import assert from "node:assert";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, act } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import RoadmapItemsPanel from "./RoadmapItemsPanel";

// Capture router.push calls
const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock roadmap items query
const mockItems = [
  {
    id: "item-1",
    title: "Add dark mode",
    type: "feature" as const,
    description: "Support dark theme across the app",
    status: "incomplete" as const,
    archived: false,
    createdAt: "2025-01-01T00:00:00Z",
  },
];

vi.mock("@/lib/queries", () => ({
  useRoadmapItemsQuery: () => ({ data: mockItems }),
}));

// Mock store hooks
vi.mock("@/stores/roadmap-items.store", () => ({
  useShowArchivedRoadmapItems: () => false,
  useToggleArchivedRoadmapItems: () => vi.fn(),
}));

// Mock mutations
const focusMutateMock = vi.fn();

vi.mock("@/lib/mutations", () => ({
  useCreateRoadmapItemMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateRoadmapItemMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteRoadmapItemMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useStartRoadmapFocusMutation: () => ({
    mutate: focusMutateMock,
    isPending: false,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RoadmapItemsPanel", () => {
  describe("focus session launch", () => {
    it("navigates to conversation URL with autoFocus=true after starting focus session", () => {
      renderWithQuery(<RoadmapItemsPanel projectName="my-project" />);

      // Click the focus button (▶) — uses data-tooltip, not aria-label
      const focusButton = screen.getByText("▶");
      fireEvent.click(focusButton);

      // The mutation should have been called with the item ID
      expect(focusMutateMock).toHaveBeenCalledWith(
        "item-1",
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );

      // Simulate successful mutation response
      const call = focusMutateMock.mock.calls[0];
      assert(call);
      const onSuccess = call[1].onSuccess;
      act(() => {
        onSuccess({
          session: {
            sessionName: "add-dark-mode",
            conversations: [{ id: "conv-123" }],
          },
        });
      });

      // Should navigate to the conversation URL with autoFocus=true
      expect(pushMock).toHaveBeenCalledWith(
        "/projects/my-project/add-dark-mode/conv-123?autoFocus=true",
      );
    });

    it("falls back to session-only URL when no conversations exist", () => {
      renderWithQuery(<RoadmapItemsPanel projectName="my-project" />);

      fireEvent.click(screen.getByText("▶"));

      const call2 = focusMutateMock.mock.calls[0];
      assert(call2);
      const onSuccess = call2[1].onSuccess;
      act(() => {
        onSuccess({
          session: {
            sessionName: "add-dark-mode",
            conversations: [],
          },
        });
      });

      expect(pushMock).toHaveBeenCalledWith(
        "/projects/my-project/add-dark-mode",
      );
    });
  });
});
