// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFERENCE_REGISTRY } from "@/lib/prompt-editor";
import { buildNotepadRefXml } from "@/lib/notepads/references";
import { buildTicketRefXml } from "@/lib/tickets/references";
import { NotepadPreview } from "./NotepadPreview";
import { REFERENCE_XML_FIXTURES } from "./reference-xml-fixtures";

beforeEach(() => {
  // Chip labels resolve through React Query; a stubbed 404 keeps the tests
  // offline and exercises the captured-name fallback path.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function renderPreview(content: string, notepadId = "np-preview") {
  return render(<NotepadPreview notepadId={notepadId} content={content} />, {
    wrapper: createWrapper(),
  });
}

const NOTEPAD_XML = buildNotepadRefXml({
  notepadId: "np-7f3a",
  name: "Release checklist",
  scope: "project",
  projectName: "command-center",
});

const TICKET_XML = buildTicketRefXml({
  projectName: "command-center",
  ticketNumber: 12,
  title: "Add durable ticket context",
});

describe("NotepadPreview markdown structure", () => {
  it("renders headings, lists, task lists, and code blocks", async () => {
    const content = [
      "# Title",
      "",
      "- alpha",
      "- beta",
      "",
      "1. [ ] todo item",
      "2. [x] done item",
      "",
      "```",
      "const x = 1;",
      "```",
    ].join("\n");
    const { container, findByRole, getAllByRole } = renderPreview(content);

    await findByRole("heading", { level: 1, name: "Title" });
    expect(getAllByRole("listitem")).toHaveLength(4);
    const checkboxes = getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).not.toBeChecked();
    expect(checkboxes[1]).toBeChecked();
    expect(container.querySelector("pre code")?.textContent).toContain(
      "const x = 1;",
    );
  });

  it("re-renders the structure as the content changes, debounced", async () => {
    const { rerender, findByRole, queryByRole } = renderPreview("# First");
    await findByRole("heading", { level: 1, name: "First" });

    rerender(<NotepadPreview notepadId="np-preview" content="# Second" />);

    // The debounce window holds the previous render for a beat.
    expect(queryByRole("heading", { level: 1, name: "Second" })).toBeNull();
    await findByRole("heading", { level: 1, name: "Second" });
    expect(queryByRole("heading", { level: 1, name: "First" })).toBeNull();
  });
});

describe("NotepadPreview reference chips", () => {
  for (const entry of REFERENCE_REGISTRY) {
    it(`renders ${entry.type} reference XML as its chip`, async () => {
      const { findByTestId } = renderPreview(
        `before ${REFERENCE_XML_FIXTURES[entry.type]} after`,
      );

      const chip = await findByTestId("notepad-preview-chip");
      expect(chip.getAttribute("data-ref-kind")).toBe(entry.xmlTag);
    });
  }

  it("renders a chip inside a list item with the list structure intact", async () => {
    const content = [`- review ${NOTEPAD_XML} today`, "- ship it"].join("\n");
    const { findByRole, getAllByRole } = renderPreview(content);

    await findByRole("list");
    const items = getAllByRole("listitem");
    expect(items).toHaveLength(2);
    const first = items[0];
    if (!first) throw new Error("missing first list item");
    within(first).getByTestId("notepad-preview-chip");
    expect(first.textContent).toContain("review");
    expect(first.textContent).toContain("today");
    expect(first.textContent).toContain("Release checklist");
  });

  it("renders a chip inside a heading with the heading structure intact", async () => {
    const { findByRole } = renderPreview(`## Plan ${NOTEPAD_XML}`);

    const heading = await findByRole("heading", { level: 2 });
    within(heading).getByTestId("notepad-preview-chip");
    expect(heading.textContent).toContain("Plan");
  });

  it("renders a reference alone between blank lines as a chip in a paragraph", async () => {
    const { findByTestId, getByText } = renderPreview(
      `before\n\n${NOTEPAD_XML}\n\nafter`,
    );

    const chip = await findByTestId("notepad-preview-chip");
    expect(chip.closest("p")).not.toBeNull();
    getByText("before");
    getByText("after");
  });

  it("keeps reference XML literal inside code fences and inline code", async () => {
    const content = [
      `inline \`${TICKET_XML}\` code`,
      "",
      "```xml",
      TICKET_XML,
      "```",
    ].join("\n");
    const { container, findByText, queryByTestId } = renderPreview(content);

    await findByText("inline", { exact: false });
    expect(queryByTestId("notepad-preview-chip")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain(
      "<ticket-ref",
    );
  });
});

describe("NotepadPreview images", () => {
  it("resolves image tokens to the notepad image route", async () => {
    const content = "shot:\n\n[Image: img-42]\n\n- see [Image: img-7]";
    const { findAllByTestId } = renderPreview(content, "np-9");

    const images = await findAllByTestId("notepad-preview-image");
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("src")).toBe(
      "/api/notepads/np-9/images/img-42",
    );
    const second = images[1];
    if (!second) throw new Error("missing list-item image");
    expect(second.getAttribute("src")).toBe("/api/notepads/np-9/images/img-7");
    expect(second.closest("li")).not.toBeNull();
  });

  it("shows a placeholder for an image whose data is gone", async () => {
    const { findByTestId, queryByTestId } = renderPreview("[Image: img-dead]");

    const image = await findByTestId("notepad-preview-image");
    fireEvent.error(image);

    await waitFor(() => {
      const placeholder = queryByTestId("notepad-image-placeholder");
      expect(placeholder).not.toBeNull();
      expect(placeholder?.getAttribute("data-notepad-image-id")).toBe(
        "img-dead",
      );
      expect(placeholder?.textContent).toContain("image unavailable");
    });
    expect(queryByTestId("notepad-preview-image")).toBeNull();
  });
});
