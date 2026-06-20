// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import type { ActiveConversation } from "@/lib/active-conversations/schemas";
import { storybookAnnotations } from "@/test/storybook-setup";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import * as stories from "./ConversationSidebar.stories";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

interface StoryWithActiveArgs {
  args?: {
    active?: {
      conversations?: ActiveConversation[];
    };
  };
}

function storyConversations(story: unknown): ActiveConversation[] {
  return (story as StoryWithActiveArgs).args?.active?.conversations ?? [];
}

beforeAll(storybookAnnotations.beforeAll);
afterEach(() => {
  cleanup();
  useSessionDetailStore.getState().resetStore();
});

const { GroupBySession, MixedStatuses, ProjectRowsOnly } =
  composeStories(stories);

describe("ConversationSidebar stories", () => {
  it("ProjectRowsOnly renders project rows with project/main context and no session-only labels", async () => {
    await ProjectRowsOnly.run();

    expect(screen.getByText("remote-ai-manager / main")).toBeDefined();
    expect(
      screen.getByText("Checking root-level active conversation routing."),
    ).toBeDefined();
    const creativeProjectRow = screen.getByLabelText(
      "Summarize project outcome — awaiting",
    );
    expect(creativeProjectRow.textContent?.replace(/\s+/g, "")).toContain(
      "creative-ai/main",
    );
    expect(screen.queryByText("conversation-ui-overhaul")).toBeNull();
  });

  it("MixedStatuses includes session and project rows across the PLC states", () => {
    const conversations = storyConversations(stories.MixedStatuses);

    expect(conversations.some((row) => row.scope === "session")).toBe(true);
    expect(
      conversations.some(
        (row) => row.scope === "project" && row.status === "running",
      ),
    ).toBe(true);
    expect(
      conversations.some(
        (row) => row.scope === "project" && row.status === "waiting_for_input",
      ),
    ).toBe(true);
    expect(
      conversations.some(
        (row) =>
          row.scope === "project" &&
          row.status === "awaiting" &&
          row.unread === true,
      ),
    ).toBe(true);
  });

  it("ArchivedAfterAction shows an optimistically archived project row", () => {
    const conversations = storyConversations(
      (stories as Record<string, unknown>).ArchivedAfterAction,
    );

    expect(
      conversations.some(
        (row) => row.scope === "project" && row.id === "project-archived",
      ),
    ).toBe(true);
    expect(
      conversations.some(
        (row) =>
          row.scope === "project" &&
          row.id === "project-archived" &&
          "archived" in row &&
          row.archived === true,
      ),
    ).toBe(true);
  });

  it("MixedStatuses renders project row menus without session-only actions", async () => {
    await MixedStatuses.run();

    fireEvent.contextMenu(
      screen.getByLabelText("Review project-level transcript flow — running"),
      {
        clientX: 20,
        clientY: 24,
      },
    );

    expect(
      screen.getByRole("menuitem", { name: /Open conversation/i }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: /Open project page/i }),
    ).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Rename/i })).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: /Archive conversation/i }),
    ).toBeDefined();
    expect(
      screen.queryByRole("menuitem", { name: /Filter sidebar/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /Copy branch name/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /Copy context/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /Archive session/i }),
    ).toBeNull();
  });

  it("MixedStatuses preserves session row grouping and session-only context menu actions", async () => {
    await GroupBySession.run();

    const sessionSection = Array.from(
      document.querySelectorAll('[data-section-kind="session"]'),
    ).find((section) =>
      section.firstElementChild?.textContent
        ?.replace(/\s+/g, "")
        .includes("remote-ai-manager/conversation-ui-overhaul"),
    );
    expect(sessionSection).toBeDefined();

    fireEvent.contextMenu(
      screen.getByLabelText("Implement sidebar pipeline — running"),
      {
        clientX: 20,
        clientY: 24,
      },
    );

    expect(
      screen.getByRole("menuitem", {
        name: /Filter sidebar to session: conversation-ui-overhaul/i,
      }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: /Copy branch name/i }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: /Copy context/i }),
    ).toBeDefined();
    expect(screen.getByRole("menuitem", { name: /Rename/i })).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: /Archive conversation/i }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: /Archive session/i }),
    ).toBeDefined();
  });
});
