// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { screen, cleanup } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import * as stories from "./ConversationSidebarFilters.stories";

beforeAll(storybookAnnotations.beforeAll);
afterEach(() => {
  cleanup();
  useSessionDetailStore.getState().resetStore();
});

const { GroupBySession, GroupByProject } = composeStories(stories);

describe("ConversationSidebarFilters stories", () => {
  it("GroupBySession activates the Session button", async () => {
    await GroupBySession.run();
    expect(screen.getByRole("radio", { name: "Session" }).className).toContain(
      "active",
    );
    expect(screen.queryByRole("radio", { name: "None" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Status" })).toBeNull();
  });

  it("GroupByProject activates the Project button", async () => {
    await GroupByProject.run();
    expect(screen.getByRole("radio", { name: "Project" }).className).toContain(
      "active",
    );
  });
});
