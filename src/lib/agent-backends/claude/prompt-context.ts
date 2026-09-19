import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";

/**
 * Native slash expansion requires the user text alone. UserPromptSubmit runs
 * after expansion but identifies the original prompt, so it can deliver CC's
 * context without turning that context into skill arguments. Match pending
 * inputs in submission order: the SDK generates its own prompt_id rather than
 * preserving the submitted message UUID.
 */
export function createClaudePromptContext() {
  const pending: { prompt: string; context: string | undefined }[] = [];
  const submit: HookCallback = async (input) => {
    if (input.hook_event_name !== "UserPromptSubmit" || input.agent_id)
      return {};
    const index = pending.findIndex(
      (entry) => entry.prompt === input.prompt.trim(),
    );
    if (index < 0) return {};
    const [entry] = pending.splice(index, 1);
    if (!entry?.context) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: entry.context,
      },
    };
  };
  const hooks: NonNullable<Options["hooks"]> = {
    UserPromptSubmit: [{ hooks: [submit] }],
  };
  return {
    hooks,
    register(prompt: string, context: string | undefined): () => void {
      const entry = { prompt: prompt.trim(), context };
      pending.push(entry);
      return () => {
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
      };
    },
    clear() {
      pending.length = 0;
    },
  };
}
