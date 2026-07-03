import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfigDirFrom } from "./config-dir";

const darwin = { platform: "darwin", homedir: "/Users/test" };
const linux = { platform: "linux", homedir: "/home/test" };

describe("resolveConfigDirFrom", () => {
  it("honors the CC_CONFIG_DIR override above everything else", () => {
    expect(
      resolveConfigDirFrom(
        { CC_CONFIG_DIR: "/tmp/custom", XDG_CONFIG_HOME: "/xdg" },
        linux,
      ),
    ).toBe("/tmp/custom");
  });

  it("resolves the macOS Application Support directory", () => {
    expect(resolveConfigDirFrom({}, darwin)).toBe(
      path.join("/Users/test", "Library", "Application Support", "cc"),
    );
  });

  it("uses XDG_CONFIG_HOME when set on non-darwin platforms", () => {
    expect(resolveConfigDirFrom({ XDG_CONFIG_HOME: "/xdg" }, linux)).toBe(
      path.join("/xdg", "cc"),
    );
  });

  it("falls back to ~/.config on non-darwin platforms without XDG", () => {
    expect(resolveConfigDirFrom({}, linux)).toBe(
      path.join("/home/test", ".config", "cc"),
    );
  });

  it("isolates dev state via the cc-dev directory when CC_ENV=dev", () => {
    expect(resolveConfigDirFrom({ CC_ENV: "dev" }, darwin)).toBe(
      path.join("/Users/test", "Library", "Application Support", "cc-dev"),
    );
  });
});
