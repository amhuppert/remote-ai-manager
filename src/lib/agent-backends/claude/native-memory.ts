import type { Settings } from "@anthropic-ai/claude-agent-sdk";

/** The flag tier overrides user/project settings on the unmanaged CC hosts. */
export const CLAUDE_NATIVE_MEMORY_SETTINGS: Readonly<
  Pick<Settings, "autoMemoryEnabled" | "autoDreamEnabled">
> = Object.freeze({ autoMemoryEnabled: false, autoDreamEnabled: false });

/** Cache both success and unreadable flags for the server process lifetime. */
export function createClaudeNativeMemoryCheck(read: () => unknown): () => void {
  let checked = false;
  let failure: Error | null = null;
  return () => {
    if (!checked) {
      checked = true;
      try {
        const flags = read();
        if (
          flags === null ||
          typeof flags !== "object" ||
          typeof Reflect.get(flags, "autoMemoryEnabled") !== "boolean" ||
          typeof Reflect.get(flags, "autoDreamEnabled") !== "boolean"
        ) {
          throw new Error(
            "expected boolean autoMemoryEnabled and autoDreamEnabled",
          );
        }
      } catch (error) {
        failure = new Error(
          `Refusing to launch Claude: native-memory launch flags are unreadable (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }
    if (failure !== null) throw failure;
  };
}

export const assertClaudeNativeMemoryNeutralized =
  createClaudeNativeMemoryCheck(() => CLAUDE_NATIVE_MEMORY_SETTINGS);
