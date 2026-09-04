/**
 * Codex's half of the native-memory neutralization declared by
 * `codexNativeMemory` in `./descriptor.ts`.
 *
 * Codex keeps its own memory store and, left alone, decides what to do with it
 * from `~/.codex/config.toml` — a file Command Center does not own and a user
 * can change under a running server. Pinning the three switches in the config
 * overrides CC passes per launch is what makes the answer CC's rather than the
 * machine's.
 *
 * All three matter and none is redundant:
 *  - `use_memories` stops the store from being read into the turn;
 *  - `generate_memories` stops the turn from writing back to it;
 *  - `dedicated_tools` removes the memory tools, so a turn cannot write to a
 *    store Command Center never reads back by calling them directly.
 *
 * Shared by every profile that launches Codex — ordinary conversations, task
 * runs, the isolated one-shot, and the restricted lane's hermetic envelope —
 * so the neutralization is one decision rather than four copies that can drift.
 */

import type { CodexOptions } from "@openai/codex-sdk";

type CodexConfig = NonNullable<CodexOptions["config"]>;

export const CODEX_NATIVE_MEMORY_CONFIG: Readonly<
  Pick<CodexConfig, "memories">
> = {
  memories: {
    dedicated_tools: false,
    generate_memories: false,
    use_memories: false,
  },
};
