// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./NotificationsPanel.stories";

beforeAll(storybookAnnotations.beforeAll);
afterEach(cleanup);

const { ProjectConversations } = composeStories(stories);

interface StoryArgsWithClose {
  onClose?: () => void;
}

describe("NotificationsPanel stories", () => {
  it("ProjectConversations shows project rows with main context and focus navigation", async () => {
    await ProjectConversations.run();

    const projectRow = screen.getByRole("link", {
      name: /Project-level prompt needs review/i,
    });
    expect(projectRow).toHaveAttribute(
      "href",
      "/projects/api-server?focus=project-convo-wfi",
    );
    expect(screen.getByText("api-server / main")).toBeDefined();
    expect(screen.getByLabelText("agent: codex")).toBeDefined();

    projectRow.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(projectRow);

    const onClose = (ProjectConversations.args as StoryArgsWithClose).onClose;
    expect(onClose).toHaveBeenCalled();
  });
});
