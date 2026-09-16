// @vitest-inputs package.json
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CODEX_APP_SERVER_VERSION } from "./app-server-protocol";

describe("Codex paired transport versions", () => {
  it("pins the conversation runtime and patched task SDK to the audited protocol", () => {
    const manifest = z
      .object({
        dependencies: z.record(z.string(), z.string()),
        patchedDependencies: z.record(z.string(), z.string()),
      })
      .parse(JSON.parse(readFileSync("package.json", "utf8")));
    expect(manifest.dependencies["@openai/codex"]).toBe(
      CODEX_APP_SERVER_VERSION,
    );
    expect(manifest.dependencies["@openai/codex-sdk"]).toBe(
      CODEX_APP_SERVER_VERSION,
    );
    expect(
      manifest.patchedDependencies[
        `@openai/codex-sdk@${CODEX_APP_SERVER_VERSION}`
      ],
    ).toBe(`patches/@openai%2Fcodex-sdk@${CODEX_APP_SERVER_VERSION}.patch`);
  });
});
