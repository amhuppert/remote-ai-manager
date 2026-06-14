// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import PaneMessage from "./PaneMessage";

function textMessage(
  role: TranscriptMessage["role"],
  text: string,
): TranscriptMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: null,
  };
}

function toolMessage(): TranscriptMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "running a command" },
      {
        type: "tool_use",
        id: "t1",
        name: "Bash",
        input: { command: "ls -la" },
      },
    ],
    timestamp: null,
  };
}

describe("PaneMessage", () => {
  it("renders a plain text message with role and text, no tool line", () => {
    render(
      <PaneMessage
        message={textMessage("user", "hello there")}
        compact={false}
      />,
    );

    expect(screen.getByText("you")).toBeInTheDocument();
    expect(screen.getByText("hello there")).toBeInTheDocument();
    expect(document.querySelector(".pane-message__tool")).toBeNull();
  });

  it("maps assistant role to cc", () => {
    render(
      <PaneMessage
        message={textMessage("assistant", "on it")}
        compact={false}
      />,
    );

    expect(screen.getByText("cc")).toBeInTheDocument();
    expect(screen.getByText("on it")).toBeInTheDocument();
  });

  it("renders a collapsed tool line with name and detail when a tool_use block is present", () => {
    render(<PaneMessage message={toolMessage()} compact={false} />);

    expect(screen.getByText("cc")).toBeInTheDocument();
    expect(screen.getByText("running a command")).toBeInTheDocument();
    const toolLine = document.querySelector(".pane-message__tool");
    expect(toolLine).not.toBeNull();
    expect(toolLine?.textContent).toContain("Bash");
    expect(toolLine?.textContent).toContain("ls -la");
  });

  it("toggles the data-compact attribute", () => {
    const { rerender } = render(
      <PaneMessage message={textMessage("user", "x")} compact={false} />,
    );
    expect(
      document.querySelector('.pane-message[data-compact="true"]'),
    ).toBeNull();

    rerender(<PaneMessage message={textMessage("user", "x")} compact={true} />);
    expect(
      document.querySelector('.pane-message[data-compact="true"]'),
    ).not.toBeNull();
  });
});
