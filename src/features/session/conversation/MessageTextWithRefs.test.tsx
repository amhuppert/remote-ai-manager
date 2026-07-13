// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type {
  ConversationRefAttrs,
  MessageRefAttrs,
} from "@/lib/conversations/schemas";
import type { TicketRefAttrs } from "@/lib/tickets/schemas";
import MessageTextWithRefs, {
  createMessageTextWithRefs,
} from "./MessageTextWithRefs";

function MarkdownStub({ content }: { content: string }): React.JSX.Element {
  return <span data-testid="md">{content}</span>;
}

function ChipStub({
  attrs,
}: {
  attrs: ConversationRefAttrs;
}): React.JSX.Element {
  return (
    <span data-testid="chip" data-conv-id={attrs["conversation-id"]}>
      {attrs["conversation-name"] || attrs["conversation-id"]}
    </span>
  );
}

function MsgChipStub({ attrs }: { attrs: MessageRefAttrs }): React.JSX.Element {
  return (
    <span
      data-testid="msg-chip"
      data-conv-id={attrs["conversation-id"]}
      data-msg-index={attrs["message-index"]}
    />
  );
}

function TicketChipStub({
  attrs,
}: {
  attrs: TicketRefAttrs;
}): React.JSX.Element {
  return (
    <span
      data-testid="ticket-chip"
      data-identifier={attrs.identifier}
      data-ticket-title={attrs.title}
    />
  );
}

const Component = createMessageTextWithRefs({
  MessageMarkdown: MarkdownStub,
  ConversationLinkChip: ChipStub,
  MessageRefChip: MsgChipStub,
  TicketRefChip: TicketChipStub,
});

const REF_ATTRS_BASE = {
  "project-name": "my-app",
  "project-path": "/repos/my-app",
  "session-name": "main",
  "worktree-path": "/repos/my-app/.worktrees/main",
  "conversation-id": "conv-1",
  "conversation-name": "Refactor",
  backend: "claude",
  "backend-ref": "sess-abc",
  "transcript-path": "/t/transcript.jsonl",
  "debug-log-path": "",
  status: "new",
  "last-activity-at": "2024-01-01T00:00:00Z",
};

function makeRef(overrides: Record<string, string> = {}): string {
  const merged = { ...REF_ATTRS_BASE, ...overrides };
  const parts: string[] = ["<conversation-ref"];
  for (const [k, v] of Object.entries(merged)) {
    parts.push(`${k}="${v}"`);
  }
  return `${parts.join(" ")} />`;
}

describe("MessageTextWithRefs", () => {
  it("renders plain text through MessageMarkdown when no refs are present", () => {
    const { container, getAllByTestId } = render(
      <Component text="just some plain text" />,
    );
    const mds = getAllByTestId("md");
    expect(mds).toHaveLength(1);
    expect(mds[0]?.textContent).toBe("just some plain text");
    expect(container.querySelector('[data-testid="chip"]')).toBeNull();
  });

  it("splits text with one ref into text + chip + text", () => {
    const ref = makeRef({ "conversation-id": "conv-1" });
    const text = `before ${ref} after`;
    const { getAllByTestId } = render(<Component text={text} />);

    const mds = getAllByTestId("md");
    const chips = getAllByTestId("chip");

    expect(mds).toHaveLength(2);
    expect(mds[0]?.textContent).toBe("before ");
    expect(mds[1]?.textContent).toBe(" after");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.getAttribute("data-conv-id")).toBe("conv-1");
  });

  it("renders multiple refs interleaved with text", () => {
    const r1 = makeRef({
      "conversation-id": "c1",
      "conversation-name": "First",
    });
    const r2 = makeRef({
      "conversation-id": "c2",
      "conversation-name": "Second",
    });
    const text = `start ${r1} middle ${r2} end`;
    const { getAllByTestId } = render(<Component text={text} />);

    const chips = getAllByTestId("chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]?.getAttribute("data-conv-id")).toBe("c1");
    expect(chips[1]?.getAttribute("data-conv-id")).toBe("c2");

    const mds = getAllByTestId("md");
    expect(mds.map((n) => n.textContent)).toEqual([
      "start ",
      " middle ",
      " end",
    ]);
  });

  it("preserves refs inside fenced code blocks as plain text", () => {
    const ref = makeRef({ "conversation-id": "inside" });
    const text = `text before\n\n\`\`\`\n${ref}\n\`\`\`\n\ntext after`;
    const { container, getAllByTestId } = render(<Component text={text} />);

    expect(container.querySelector('[data-testid="chip"]')).toBeNull();

    const mds = getAllByTestId("md");
    const joined = mds.map((n) => n.textContent).join("");
    expect(joined).toContain(ref);
    expect(joined).toContain("text before");
    expect(joined).toContain("text after");
  });

  it("renders a message-ref as a chip between text segments", () => {
    const msgRef =
      '<message-ref project-name="my-app" session-name="main" ' +
      'conversation-id="conv-9" conversation-name="Refactor" ' +
      'message-index="4" role="assistant" compacted="false" ' +
      'read-command="cctl conversation read conv-9 --message 4" />';
    const { getAllByTestId } = render(
      <Component text={`see ${msgRef} here`} />,
    );

    const chips = getAllByTestId("msg-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.getAttribute("data-conv-id")).toBe("conv-9");
    expect(chips[0]?.getAttribute("data-msg-index")).toBe("4");
    expect(getAllByTestId("md").map((n) => n.textContent)).toEqual([
      "see ",
      " here",
    ]);
  });

  it("interleaves conversation-refs and message-refs in document order", () => {
    const convRef = makeRef({ "conversation-id": "c1" });
    const msgRef =
      '<message-ref project-name="my-app" conversation-id="c2" ' +
      'message-index="7" role="user" compacted="false" />';
    const { getAllByTestId, container } = render(
      <Component text={`a ${msgRef} b ${convRef} c`} />,
    );

    expect(getAllByTestId("msg-chip")).toHaveLength(1);
    expect(getAllByTestId("chip")).toHaveLength(1);
    const order = Array.from(container.querySelectorAll("[data-testid]")).map(
      (node) => node.getAttribute("data-testid"),
    );
    expect(order).toEqual(["md", "msg-chip", "md", "chip", "md"]);
  });

  it("renders an unparseable message-ref tag as plain text", () => {
    const badRef = '<message-ref role="assistant" compacted="false" />';
    const { container, getAllByTestId } = render(
      <Component text={`x ${badRef} y`} />,
    );
    expect(container.querySelector('[data-testid="msg-chip"]')).toBeNull();
    const joined = getAllByTestId("md")
      .map((n) => n.textContent)
      .join("");
    expect(joined).toContain(badRef);
  });

  it("renders a ticket-ref as a chip between text segments", () => {
    const ticketRef =
      '<ticket-ref project-name="command-center" ticket-number="12" ' +
      'identifier="command-center#12" title="Add durable ticket context" ' +
      'read-command="cctl ticket get command-center#12" />';
    const { getAllByTestId } = render(
      <Component text={`see ${ticketRef} here`} />,
    );

    const chips = getAllByTestId("ticket-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.getAttribute("data-identifier")).toBe("command-center#12");
    expect(chips[0]?.getAttribute("data-ticket-title")).toBe(
      "Add durable ticket context",
    );
    expect(getAllByTestId("md").map((n) => n.textContent)).toEqual([
      "see ",
      " here",
    ]);
  });

  it("renders an unparseable ticket-ref tag as plain text", () => {
    const badRef = '<ticket-ref project-name="command-center" />';
    const { container, getAllByTestId } = render(
      <Component text={`x ${badRef} y`} />,
    );
    expect(container.querySelector('[data-testid="ticket-chip"]')).toBeNull();
    const joined = getAllByTestId("md")
      .map((n) => n.textContent)
      .join("");
    expect(joined).toContain(badRef);
  });

  it("renders an unparseable conversation-ref tag as plain text", () => {
    // Missing several required attrs — schema parse will fail.
    const badRef = '<conversation-ref project-name="x" conversation-id="y" />';
    const text = `hello ${badRef} world`;
    const { container, getAllByTestId } = render(<Component text={text} />);

    expect(container.querySelector('[data-testid="chip"]')).toBeNull();
    const joined = getAllByTestId("md")
      .map((n) => n.textContent)
      .join("");
    expect(joined).toContain(badRef);
    expect(joined).toContain("hello");
    expect(joined).toContain("world");
  });
});

// The production-wired default renders ordinary text segments through the
// canonical message adapter (`[data-markdown-intent="message"]`), not a
// caller-local Markdown loader.
describe("MessageTextWithRefs — canonical message adapter", () => {
  function markdownRoots(container: HTMLElement): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-markdown-intent="message"]',
      ),
    );
  }

  it("renders plain text through the canonical message adapter", async () => {
    const { container } = render(
      <MessageTextWithRefs text="Ship **the migration** now." />,
    );

    await waitFor(() => {
      expect(markdownRoots(container)).toHaveLength(1);
    });
    const strong = await screen.findByText("the migration");
    expect(strong.tagName).toBe("STRONG");
    expect(strong.closest('[data-markdown-intent="message"]')).not.toBeNull();
  });

  it("segments a conversation-ref into canonical text around an interactive chip in order", async () => {
    const ref = makeRef({
      "conversation-id": "conv-1",
      "conversation-name": "Refactor",
    });
    const { container } = render(
      <MessageTextWithRefs text={`before ${ref} after`} />,
    );

    // The chip stays an interactive link even though the surrounding prose is
    // now canonical Markdown.
    const chip = await screen.findByRole("link", { name: /Refactor/ });
    expect(chip).toHaveAttribute("href");

    await waitFor(() => {
      expect(markdownRoots(container)).toHaveLength(2);
    });
    const [beforeRoot, afterRoot] = markdownRoots(container);
    expect(beforeRoot?.textContent).toContain("before");
    expect(afterRoot?.textContent).toContain("after");

    // Document order: canonical text, then chip, then canonical text.
    expect(
      beforeRoot!.compareDocumentPosition(chip) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      chip.compareDocumentPosition(afterRoot!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });
});
