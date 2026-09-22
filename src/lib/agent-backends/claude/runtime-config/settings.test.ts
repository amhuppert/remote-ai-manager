import { describe, expect, it } from "vitest";
import { composeClaudeCapabilitySettings } from "./settings";
import { CLAUDE_NATIVE_MEMORY_SETTINGS } from "../native-memory";
import { translateClaudeRuntimeCapabilities } from "./translator";

describe("Claude shared settings composition", () => {
  it("retains host suppression when refreshed user capability settings enable the same plugin", () => {
    const { config } = translateClaudeRuntimeCapabilities({
      cascade: {
        backend: "claude",
        kinds: [
          {
            kind: "plugins",
            items: [
              {
                itemId: "command-center@host",
                enabled: true,
                originLayer: "global",
              },
            ],
          },
        ],
      },
      nativePluginRecords: [],
    });
    const settings = composeClaudeCapabilitySettings(config, {
      "command-center@host": false,
    });
    expect(settings.enabledPlugins).toEqual({ "command-center@host": false });
    expect(settings).toMatchObject(CLAUDE_NATIVE_MEMORY_SETTINGS);
  });
});
