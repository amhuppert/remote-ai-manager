// @vitest-environment jsdom
import type {
  ComponentPropsWithoutRef,
  ComponentPropsWithRef,
  ComponentType,
} from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import * as MarkdownApi from "./Markdown";
import {
  CompactMarkdown,
  DocumentMarkdown,
  MessageMarkdown,
  SourceMappedDocumentMarkdown,
  type MarkdownProps,
} from "./Markdown";
import {
  CANONICAL_MARKDOWN_FIXTURES,
  CANONICAL_MARKDOWN_SHOWCASE,
  LONG_UNBROKEN_TOKEN,
} from "./fixtures";

interface AdapterCase {
  Component: ComponentType<MarkdownProps>;
  intent: "document" | "message" | "compact";
}

const ADAPTERS: readonly AdapterCase[] = [
  { Component: DocumentMarkdown, intent: "document" },
  { Component: MessageMarkdown, intent: "message" },
  { Component: CompactMarkdown, intent: "compact" },
];

function markdownRoot(container: HTMLElement, intent: AdapterCase["intent"]) {
  return container.querySelector<HTMLElement>(
    `[data-markdown-intent="${intent}"]`,
  );
}

async function renderAdapter({ Component, intent }: AdapterCase) {
  const result = render(<Component content={CANONICAL_MARKDOWN_SHOWCASE} />);

  await waitFor(
    () => {
      expect(markdownRoot(result.container, intent)).not.toBeNull();
    },
    { timeout: 10_000 },
  );

  return {
    ...result,
    root: markdownRoot(result.container, intent)!,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("canonical Markdown public API", () => {
  it("exports only the four fixed adapters", () => {
    expect(Object.keys(MarkdownApi).sort()).toEqual([
      "CompactMarkdown",
      "DocumentMarkdown",
      "MessageMarkdown",
      "SourceMappedDocumentMarkdown",
    ]);
  });

  it("gives every adapter the content-only public contract", () => {
    expectTypeOf<keyof MarkdownProps>().toEqualTypeOf<"content">();
    expectTypeOf<MarkdownProps["content"]>().toEqualTypeOf<string>();
    expectTypeOf<
      ComponentPropsWithoutRef<typeof DocumentMarkdown>
    >().toEqualTypeOf<MarkdownProps>();
    expectTypeOf<
      ComponentPropsWithoutRef<typeof MessageMarkdown>
    >().toEqualTypeOf<MarkdownProps>();
    expectTypeOf<
      ComponentPropsWithoutRef<typeof CompactMarkdown>
    >().toEqualTypeOf<MarkdownProps>();
    type SourceMappedProps = ComponentPropsWithRef<
      typeof SourceMappedDocumentMarkdown
    >;
    expectTypeOf<SourceMappedProps["content"]>().toEqualTypeOf<string>();
    expectTypeOf<SourceMappedProps["ref"]>().not.toBeNever();
    expectTypeOf<
      Exclude<keyof SourceMappedProps, "content" | "ref" | "key">
    >().toBeNever();
  });
});

describe.each(ADAPTERS)("$intent Markdown semantics", (adapter) => {
  it(`renders the shared ${CANONICAL_MARKDOWN_FIXTURES.length}-fixture matrix`, async () => {
    const { root } = await renderAdapter(adapter);

    expect(
      screen.getByRole("heading", { level: 1, name: "Canonical heading" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Semantic section" }),
    ).toBeInTheDocument();
    expect(screen.getByText("strong emphasis").tagName).toBe("STRONG");
    expect(screen.getByText("gentle emphasis").tagName).toBe("EM");
    expect(screen.getByText("retired text").tagName).toBe("DEL");

    expect(root.querySelector("ul ul")).not.toBeNull();
    const tasks = screen.getAllByRole("checkbox");
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toBeChecked();
    expect(tasks[0]).toBeDisabled();
    expect(tasks[1]).not.toBeChecked();
    expect(tasks[1]).toBeDisabled();
    // Task-list checkboxes are name-less form controls without an accessible
    // name (axe `label`, critical). The canonical renderer gives each a
    // state-reflecting name so assistive tech announces completion status.
    for (const task of tasks) {
      expect(task).toHaveAccessibleName();
    }
    expect(tasks[0]).toHaveAccessibleName(/complete/i);
    expect(tasks[1]).toHaveAccessibleName(/incomplete/i);
    expect(root.querySelector("ol")).not.toBeNull();

    expect(root.querySelector("blockquote")?.textContent).toContain(
      "A quoted constraint.",
    );
    expect(root.querySelector("hr")).not.toBeNull();

    const internal = screen.getByRole("link", { name: "internal route" });
    const external = screen.getByRole("link", { name: "external docs" });
    const relativeFile = screen.getByRole("link", { name: "relative file" });
    const blockedFile = screen.getByText("blocked file scheme").closest("a");
    const autolink = screen.getByRole("link", {
      name: "https://autolink.example/path",
    });

    expect(internal).toHaveAttribute("href", "/tickets/2");
    expect(external).toHaveAttribute("href", "https://example.com/docs");
    expect(relativeFile).toHaveAttribute("href", "./docs/guide.md");
    expect(blockedFile).not.toBeNull();
    expect(blockedFile).toHaveAttribute("href", "");
    expect(autolink).toHaveAttribute("href", "https://autolink.example/path");
    for (const link of [
      internal,
      external,
      relativeFile,
      blockedFile!,
      autolink,
    ]) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
      expect(link).toHaveAttribute(
        "rel",
        expect.stringContaining("noreferrer"),
      );
    }

    const tableRegion = screen.getByRole("region", {
      name: "Scrollable table",
    });
    expect(tableRegion).toHaveAttribute("tabindex", "0");
    expect(tableRegion).toHaveClass("overflow-x-auto");
    expect(tableRegion.querySelector("table")).not.toBeNull();
    expect(screen.getByRole("columnheader", { name: "Surface" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "Workflow event" })).toBeVisible();

    expect(root.querySelector("[data-raw-html]")).toBeNull();
    expect(root.querySelector("script")).toBeNull();
    expect(root.textContent).toContain("<button data-raw-html");

    const inlineCode = screen.getByText("const inline = true");
    expect(inlineCode.tagName).toBe("CODE");
    expect(inlineCode.closest("[data-markdown-code-block]")).toBeNull();

    const knownFence = root.querySelector(
      '[data-markdown-code-block][data-code-language="typescript"]',
    );
    expect(knownFence).not.toBeNull();
    await waitFor(
      () => {
        expect(knownFence?.querySelector("span.token")).not.toBeNull();
      },
      { timeout: 30_000 },
    );

    const unknownFence = root.querySelector(
      '[data-markdown-code-block][data-code-language="unknown-language"]',
    );
    expect(unknownFence).not.toBeNull();
    expect(unknownFence?.textContent).toContain("plain fallback()");
    expect(unknownFence?.querySelector("span.token")).toBeNull();

    expect(root.querySelector("[data-markdown-mermaid]")).not.toBeNull();
    expect(root.textContent).toContain(LONG_UNBROKEN_TOKEN);
    expect(root).toHaveClass("max-w-full");
    expect(root.className).toContain("[overflow-wrap:anywhere]");
    expect(
      screen.getByRole("img", { name: "Architecture diagram" }),
    ).toHaveClass("max-w-full");
  });

  it("renders empty input as an empty Markdown root", async () => {
    const { Component, intent } = adapter;
    const { container } = render(<Component content="" />);

    await waitFor(() => {
      expect(markdownRoot(container, intent)).not.toBeNull();
    });

    expect(markdownRoot(container, intent)).toBeEmptyDOMElement();
  });
});

describe("canonical fenced code interaction", () => {
  it("copies fenced code and never adds a control to inline code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <DocumentMarkdown
        content={[
          "Inline `no copy here`.",
          "",
          "```typescript",
          "const copied = true;",
          "```",
        ].join("\n")}
      />,
    );

    expect(
      (await screen.findByText("no copy here")).closest("button"),
    ).toBeNull();
    const button = await screen.findByRole("button", { name: "Copy code" });
    fireEvent.click(button);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("const copied = true;");
      expect(button).toHaveAccessibleName("Code copied");
    });
  });
});

describe.each([
  { Component: MessageMarkdown, intent: "message" as const },
  { Component: CompactMarkdown, intent: "compact" as const },
])("deferred $intent Markdown", ({ Component, intent }) => {
  it("never duplicates its fallback content", async () => {
    const marker = `single deferred ${intent} output`;
    const { container } = render(<Component content={marker} />);

    expect(screen.getAllByText(marker)).toHaveLength(1);
    expect(container.querySelector("[data-markdown-fallback]")).not.toBeNull();

    await waitFor(() => {
      expect(
        markdownRoot(container, intent)?.querySelector("p"),
      ).not.toBeNull();
    });

    expect(screen.getAllByText(marker)).toHaveLength(1);
    expect(container.querySelector("[data-markdown-fallback]")).toBeNull();
  });
});
