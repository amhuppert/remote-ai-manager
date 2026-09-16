import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

/**
 * Both agent SDKs spawn their own CLI and read policy files relative to their
 * package, and Turbopack's server bundle miscompiles the Claude SDK's
 * managed-settings loader (its final `return` becomes an unreachable marker),
 * which made the native-memory launch guard refuse every Claude launch on a
 * dev server. Keeping them external is a launch-time constraint, not a
 * bundling preference.
 */
describe("next.config serverExternalPackages", () => {
  it("keeps native agent runtimes and SDKs out of the Turbopack server bundle", () => {
    expect(nextConfig.serverExternalPackages).toEqual(
      expect.arrayContaining([
        "@anthropic-ai/claude-agent-sdk",
        "@openai/codex-sdk",
        "@openai/codex",
      ]),
    );
  });
});
