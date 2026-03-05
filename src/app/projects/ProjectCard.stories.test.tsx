// @vitest-environment jsdom
import { describe, it, expect, beforeAll } from "vitest";
import { screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./ProjectCard.stories";

beforeAll(storybookAnnotations.beforeAll);

const { Idle, WithSessions, Active, Pinned, Archived, MenuOpen } =
  composeStories(stories);

describe("ProjectCard stories", () => {
  it("Idle renders with idle badge", async () => {
    await Idle.run();
    expect(screen.getByText("my-app")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
  });

  it("WithSessions renders session count badge", async () => {
    await WithSessions.run();
    expect(screen.getByText("2 sessions")).toBeInTheDocument();
  });

  it("Active renders with running badge", async () => {
    await Active.run();
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("Pinned renders with filled star", async () => {
    await Pinned.run();
    expect(screen.getByText("\u2605")).toBeInTheDocument();
  });

  it("Archived renders with archived badge and dimmed styling", async () => {
    await Archived.run();
    expect(screen.getByText("archived")).toBeInTheDocument();
    // The card link should carry the archived CSS class for visual dimming
    const cardLink = screen.getByRole("link", { name: /my-app/ });
    expect(cardLink.className).toContain("archived");
  });

  it("MenuOpen renders dropdown items", async () => {
    await MenuOpen.run();
    expect(screen.getByText("Pin Project")).toBeInTheDocument();
    expect(screen.getByText("Archive Project")).toBeInTheDocument();
  });
});
