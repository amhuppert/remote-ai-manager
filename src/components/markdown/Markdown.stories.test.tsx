// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import { LONG_URL } from "./fixtures";
import * as stories from "./Markdown.stories";

beforeAll(storybookAnnotations.beforeAll);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const {
  CompactNarrow,
  DocumentWide,
  MarkdownViewportEmpty,
  MarkdownViewportLoading,
  MessagePanel,
  SourceMappedPanel,
} = composeStories(stories);

describe("canonical Markdown stories", () => {
  it("renders the shared document fixture with safe links, table access, and code copying", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await act(async () => {
      await DocumentWide.run();
      await import("./MermaidDiagram");
    });
    await screen.findByTitle("Click to expand", undefined, {
      timeout: 10_000,
    });

    expect(
      screen.getByRole("heading", { level: 1, name: "Canonical heading" }),
    ).toBeVisible();
    const external = screen.getByRole("link", { name: "external docs" });
    expect(external).toHaveAttribute("href", "https://example.com/docs");
    expect(external).toHaveAttribute("target", "_blank");
    expect(external).toHaveAttribute(
      "rel",
      expect.stringContaining("noopener"),
    );
    expect(screen.getByRole("link", { name: LONG_URL })).toHaveAttribute(
      "href",
      LONG_URL,
    );

    const blockedFile = screen.getByText("blocked file scheme").closest("a");
    expect(blockedFile).toHaveAttribute("href", "");
    expect(document.querySelector("[data-raw-html]")).toBeNull();
    expect(document.querySelector("script")).toBeNull();

    const tableRegion = screen.getByRole("region", {
      name: "Scrollable table",
    });
    tableRegion.focus();
    expect(tableRegion).toHaveFocus();
    expect(tableRegion).toHaveAttribute("tabindex", "0");
    expect(tableRegion.querySelector("table")).not.toBeNull();

    const copyButtons = await screen.findAllByRole("button", {
      name: "Copy code",
    });
    expect(copyButtons).toHaveLength(2);
    const copyButton = copyButtons[0]!;
    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        'const canonical: string = "markdown";',
      );
      expect(copyButton).toHaveAccessibleName("Code copied");
    });
  });

  it("renders stable source metadata inside the overlay composition", async () => {
    await SourceMappedPanel.run();

    await waitFor(
      () => {
        expect(
          document.querySelector(
            '[data-markdown-intent="document"][data-markdown-source-mapped="true"]',
          ),
        ).not.toBeNull();
      },
      { timeout: 10_000 },
    );
    const root = document.querySelector(
      '[data-markdown-intent="document"][data-markdown-source-mapped="true"]',
    );
    expect(root?.querySelector('[data-cc-line="1"]')).toHaveAttribute(
      "data-cc-heading",
      "Canonical heading",
    );
    await waitFor(
      () => {
        expect(
          document.querySelectorAll("[data-source-map-overlay] span").length,
        ).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
  });

  it("renders the same semantic fixture in message and compact hosts", async () => {
    await MessagePanel.run();
    expect(
      await screen.findByRole(
        "heading",
        {
          level: 2,
          name: "Semantic section",
        },
        { timeout: 10_000 },
      ),
    ).toBeVisible();
    cleanup();

    await CompactNarrow.run();
    expect(
      await screen.findByRole(
        "heading",
        {
          level: 2,
          name: "Semantic section",
        },
        { timeout: 10_000 },
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Scrollable table" }),
    ).toBeVisible();
  });

  it("shows the viewport loading and empty states", async () => {
    await MarkdownViewportLoading.run();
    expect(screen.getByRole("status")).toHaveTextContent("Loading...");
    cleanup();

    await MarkdownViewportEmpty.run();
    expect(screen.getByText("No Markdown content is available.")).toBeVisible();
  });
});
