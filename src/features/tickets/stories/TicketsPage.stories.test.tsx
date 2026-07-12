// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./TicketsPage.stories";

// Portable stories run outside the Next runtime, so the framework's
// `parameters.nextjs.navigation` mock is absent; this mock feeds each story's
// own declared navigation query back through useSearchParams.
const navState = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/tickets",
  useSearchParams: () => new URLSearchParams(navState.search),
}));

beforeAll(storybookAnnotations.beforeAll);
afterEach(() => {
  cleanup();
  navState.search = "";
});

const composed = composeStories(stories);
const {
  Default,
  SortedByCreated,
  FilteredByStatus,
  PreFilteredProjectEntry,
  FilteredNoMatches,
  ZeroState,
  BoardView,
} = composed;

type ComposedStory = (typeof composed)[keyof typeof composed];

async function runStory(story: ComposedStory): Promise<void> {
  const navigation = (
    story.parameters as {
      nextjs?: { navigation?: { query?: Record<string, string> } };
    }
  ).nextjs?.navigation;
  navState.search = new URLSearchParams(navigation?.query ?? {}).toString();
  await story.run();
}

function rowTitles(): string[] {
  return [...document.querySelectorAll("[data-ticket-title]")].map(
    (row) => row.getAttribute("data-ticket-title") ?? "",
  );
}

describe("TicketsPage stories", () => {
  it("Default lists every ticket, newest update first", async () => {
    await runStory(Default);
    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    expect(rowTitles()[0]).toBe(
      "Virtualize the attachment index for large dossiers",
    );
    expect(rowTitles()).toHaveLength(6);
  });

  it("Default mounts the create dialog behind the New-ticket trigger", async () => {
    await runStory(Default);
    const trigger = await screen.findByRole("button", { name: "New ticket" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("New ticket");
  });

  it("PreFilteredProjectEntry pre-fills the create dialog's project", async () => {
    await runStory(PreFilteredProjectEntry);
    fireEvent.click(await screen.findByRole("button", { name: "New ticket" }));
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Project" }),
      ).toHaveTextContent("aerotrainer"),
    );
  });

  it("SortedByCreated orders by creation time", async () => {
    await runStory(SortedByCreated);
    await waitFor(() =>
      expect(screen.getByText("aerotrainer#5")).toBeInTheDocument(),
    );
    expect(rowTitles()[0]).toBe("Interval builder: draggable segment handles");
  });

  it("FilteredByStatus narrows the list and reports n of m shown", async () => {
    await runStory(FilteredByStatus);
    await waitFor(() =>
      expect(screen.getByText("2 of 6 shown")).toBeInTheDocument(),
    );
    expect(rowTitles()).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Clear filters" }),
    ).toBeInTheDocument();
  });

  it("PreFilteredProjectEntry shows only the entry project's tickets", async () => {
    await runStory(PreFilteredProjectEntry);
    await waitFor(() =>
      expect(screen.getByText("aerotrainer#5")).toBeInTheDocument(),
    );
    expect(rowTitles()).toHaveLength(2);
    expect(screen.queryByText("command-center#12")).not.toBeInTheDocument();
  });

  it("FilteredNoMatches shows the no-results empty state", async () => {
    await runStory(FilteredNoMatches);
    await waitFor(() =>
      expect(
        screen.getByText("No tickets match these filters"),
      ).toBeInTheDocument(),
    );
  });

  it("ZeroState shows the no-tickets-yet empty state", async () => {
    await runStory(ZeroState);
    await waitFor(() =>
      expect(screen.getByText("No tickets yet")).toBeInTheDocument(),
    );
  });

  it("BoardView renders the Kanban board instead of rows", async () => {
    await runStory(BoardView);
    await waitFor(() =>
      expect(
        screen.getByRole("group", { name: "Not Started column" }),
      ).toBeInTheDocument(),
    );
    expect(rowTitles()).toHaveLength(0);
  });
});
