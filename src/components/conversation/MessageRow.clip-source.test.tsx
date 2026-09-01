// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import MessageRow from "./MessageRow";

afterEach(cleanup);

const target: ContextArtifactTarget = {
  scope: "session",
  projectName: "p1",
  sessionName: "s1",
  conversationId: "c1",
};

const assistantMsg: TranscriptMessage = {
  role: "assistant",
  content: [{ type: "text", text: "the answer" }],
  timestamp: "2026-08-31T10:00:00.000Z",
  modelSelection: { modelId: "opus", parameters: {} },
};

function renderRow(
  props: Partial<React.ComponentProps<typeof MessageRow>> = {},
): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const { container } = render(
    <QueryClientProvider client={client}>
      <MessageRow
        msg={assistantMsg}
        messageIndex={4}
        isLast={false}
        selectedBackend="claude"
        worktreePath={undefined}
        compactionTarget={target}
        conversationName="Refactor parser"
        lastMessageExtras={null}
        {...props}
      />
    </QueryClientProvider>,
  );
  return container;
}

function contentEl(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".message-content");
  if (!el) throw new Error("message content element not rendered");
  return el;
}

describe("MessageRow clip-source contract", () => {
  it("stamps the clip-source attributes exactly where copy-reference is offered", () => {
    const container = renderRow();
    const content = contentEl(container);
    expect(content.dataset["clipIndex"]).toBe("4");
    expect(content.dataset["clipRole"]).toBe("assistant");
    expect(content.dataset["clipTimestamp"]).toBe("2026-08-31T10:00:00.000Z");
    expect(content.dataset["clipModel"]).toBe("opus");
  });

  it("omits timestamp and model attributes when the message carries none", () => {
    const container = renderRow({
      msg: {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: null,
      },
    });
    const content = contentEl(container);
    expect(content.dataset["clipIndex"]).toBe("4");
    expect(content.dataset["clipRole"]).toBe("user");
    expect(content.dataset["clipTimestamp"]).toBeUndefined();
    expect(content.dataset["clipModel"]).toBeUndefined();
  });

  it("stamps nothing on queued rows — their display index is provisional", () => {
    const container = renderRow({ queuedMetadata: null });
    expect(contentEl(container).dataset["clipIndex"]).toBeUndefined();
  });

  it("stamps nothing on provisional in-flight rows and offers no reference actions", () => {
    const container = renderRow({ provisional: true });
    expect(contentEl(container).dataset["clipIndex"]).toBeUndefined();
    expect(
      container.querySelector('[aria-label="Copy message reference"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Clip message to notepad"]'),
    ).toBeNull();
  });

  it("offers both reference actions on a durable transcript row (the gate's positive side)", () => {
    const container = renderRow();
    expect(
      container.querySelector('[aria-label="Copy message reference"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Clip message to notepad"]'),
    ).not.toBeNull();
  });

  it("stamps nothing without a conversation identity (no compactionTarget)", () => {
    const container = renderRow({ compactionTarget: undefined });
    expect(contentEl(container).dataset["clipIndex"]).toBeUndefined();
  });

  it("stamps nothing on notice rows, which offer no reference actions", () => {
    const container = renderRow({
      msg: {
        role: "notice",
        content: [{ type: "text", text: "system notice" }],
        timestamp: null,
      },
    });
    expect(contentEl(container).dataset["clipIndex"]).toBeUndefined();
  });
});
