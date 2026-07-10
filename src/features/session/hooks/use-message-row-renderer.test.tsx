// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { isValidElement } from "react";
import { useMessageRowRenderer } from "./use-message-row-renderer";
import type { TranscriptMessage } from "@/lib/conversations/schemas";

describe("useMessageRowRenderer", () => {
  it("returns a callback that renders a JSX element for a given row", () => {
    const { result } = renderHook(() =>
      useMessageRowRenderer({
        activeConversation: undefined,
        selectedBackend: "claude",
        worktreePath: "/tmp/w",
        handleDebugPrompt: async () => {},
        handleFork: async () => {},
        isBusy: false,
        projectName: "p",
        sessionName: "s",
      }),
    );
    const msg: TranscriptMessage = {
      role: "user",
      content: [{ type: "text", text: "hi" }],
      timestamp: null,
    };
    const element = result.current({
      row: { kind: "message", messageIndex: 0, msg },
      isLast: true,
    });
    expect(isValidElement(element)).toBe(true);
  });
});
