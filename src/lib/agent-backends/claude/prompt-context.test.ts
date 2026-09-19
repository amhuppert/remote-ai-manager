import { describe, expect, it } from "vitest";
import type {
  HookInput,
  UserPromptSubmitHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { createClaudePromptContext } from "./prompt-context";

function submission(
  prompt: string,
  promptId = "prompt-1",
): UserPromptSubmitHookInput {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: "session",
    transcript_path: "/transcript",
    cwd: "/project",
    prompt_id: promptId,
    prompt,
  };
}

async function invoke(
  delivery: ReturnType<typeof createClaudePromptContext>,
  input: HookInput,
) {
  return delivery.hooks[input.hook_event_name]?.[0]?.hooks[0]?.(
    input,
    undefined,
    { signal: new AbortController().signal },
  );
}

describe("Claude command context delivery", () => {
  it("delivers CC context through native expansion without changing skill arguments", async () => {
    const delivery = createClaudePromptContext();
    delivery.register(
      "/wait-what shorter",
      "<memory-index>remember</memory-index>",
    );

    expect(await invoke(delivery, submission("/wait-what shorter"))).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "<memory-index>remember</memory-index>",
      },
    });
  });

  it("keeps repeated queued commands paired with their own context", async () => {
    const delivery = createClaudePromptContext();
    delivery.register("/wait-what shorter", "first context");
    delivery.register("/wait-what shorter", "second context");
    await invoke(delivery, submission("/wait-what shorter", "first"));

    expect(
      await invoke(delivery, submission("/wait-what shorter", "second")),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "second context",
      },
    });
  });

  it("delivers context on ordinary submission if a command does not expand", async () => {
    const delivery = createClaudePromptContext();
    delivery.register("/unknown", "context");
    expect(
      await invoke(delivery, {
        ...submission("/unknown"),
        hook_event_name: "UserPromptSubmit",
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "context",
      },
    });
  });

  it("does not attach cancelled input context to a later identical command", async () => {
    const delivery = createClaudePromptContext();
    const cancel = delivery.register("/wait-what shorter", "cancelled context");
    delivery.register("/wait-what shorter", "next context");
    cancel();
    expect(
      await invoke(delivery, submission("/wait-what shorter")),
    ).toMatchObject({
      hookSpecificOutput: { additionalContext: "next context" },
    });
    delivery.clear();
    expect(
      await invoke(delivery, submission("/wait-what shorter", "next")),
    ).toEqual({});
  });
});
