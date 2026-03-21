// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import LiveIterationStream from "./LiveIterationStream";
import type { WorkflowStreamFrame } from "@/lib/ralph-loop/workflow-stream-registry";

// Mock fetch to return a fake NDJSON stream
function createMockStream(frames: WorkflowStreamFrame[]) {
  const encoder = new TextEncoder();
  const ndjson = frames.map((f) => JSON.stringify(f)).join("\n") + "\n";
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(ndjson));
      controller.close();
    },
  });
  return new Response(readable, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("LiveIterationStream", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders a live indicator when active", () => {
    const { container } = render(
      <LiveIterationStream
        projectName="test-project"
        sessionName="test-session"
        iterationNumber={3}
        isRunning={true}
        currentIterationConversationId={null}
      />,
    );
    expect(container.querySelector(".live-indicator")).not.toBeNull();
    expect(container.textContent).toContain("Iteration 3");
  });

  it("renders text content blocks via MessageContent", async () => {
    const frames: WorkflowStreamFrame[] = [
      {
        type: "content",
        iterationNumber: 1,
        content: { type: "text", text: "Analyzing the codebase..." },
      },
      {
        type: "content",
        iterationNumber: 1,
        content: { type: "text", text: "Found 5 files to modify." },
      },
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      createMockStream(frames),
    );

    let container: HTMLElement;
    await act(async () => {
      const result = render(
        <LiveIterationStream
          projectName="test-project"
          sessionName="test-session"
          iterationNumber={1}
          isRunning={true}
          currentIterationConversationId={null}
        />,
      );
      container = result.container;
    });

    // Wait for stream processing
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Expand the collapsible output section
    const toggle = container!.querySelector(".live-output-toggle")!;
    fireEvent.click(toggle);

    // Content renders via MessageContent → MarkdownContent
    const messages = container!.querySelector(".live-stream-messages");
    expect(messages).not.toBeNull();
    expect(messages!.textContent).toContain("Analyzing the codebase...");
    expect(messages!.textContent).toContain("Found 5 files to modify.");
  });

  it("renders tool use blocks via MessageContent", async () => {
    const frames: WorkflowStreamFrame[] = [
      {
        type: "content",
        iterationNumber: 1,
        content: { type: "tool_use", name: "Edit" },
      },
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      createMockStream(frames),
    );

    let container: HTMLElement;
    await act(async () => {
      const result = render(
        <LiveIterationStream
          projectName="test-project"
          sessionName="test-session"
          iterationNumber={1}
          isRunning={true}
          currentIterationConversationId={null}
        />,
      );
      container = result.container;
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Expand the collapsible output section
    const toggle = container!.querySelector(".live-output-toggle")!;
    fireEvent.click(toggle);

    // Tool use renders via MessageContent's tool indicator
    const messages = container!.querySelector(".live-stream-messages");
    expect(messages).not.toBeNull();
    expect(messages!.textContent).toContain("Edit");
  });

  it("does not fetch when not running", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(
      <LiveIterationStream
        projectName="test-project"
        sessionName="test-session"
        iterationNumber={1}
        isRunning={false}
        currentIterationConversationId={null}
      />,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("shows done message when stream completes", async () => {
    const frames: WorkflowStreamFrame[] = [
      { type: "done", reason: "iteration_complete" },
    ];

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      createMockStream(frames),
    );

    let container: HTMLElement;
    await act(async () => {
      const result = render(
        <LiveIterationStream
          projectName="test-project"
          sessionName="test-session"
          iterationNumber={1}
          isRunning={true}
          currentIterationConversationId={null}
        />,
      );
      container = result.container;
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Expand to see the done message
    const toggle = container!.querySelector(".live-output-toggle")!;
    fireEvent.click(toggle);

    expect(container!.querySelector(".stream-done")).not.toBeNull();
  });
});
