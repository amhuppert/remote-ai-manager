import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConfigReader } from "./config";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createTempConfigDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "cc-config-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("createConfigReader", () => {
  it("merges partial workflowDefaults from disk with seeded defaults", async () => {
    const configDir = await createTempConfigDir();
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify({
        workflowDefaults: {
          scriptValidator: { enabled: true },
        },
      }),
      "utf-8",
    );

    const reader = createConfigReader(configDir);
    const config = await reader.readConfig();
    expect(config.workflowDefaults).toBeDefined();

    expect(config.workflowDefaults?.scriptValidator).toEqual({ enabled: true });
    expect(config.workflowDefaults?.implementer).toBeDefined();
    expect(config.workflowDefaults?.iterationPolicy).toBeDefined();
    expect(config.workflowDefaults?.circuitBreaker).toBeDefined();
    expect(config.workflowDefaults?.mutability).toBeDefined();
  });

  it("returns partial workflowDefaults from readRawConfig without rejecting them", async () => {
    const configDir = await createTempConfigDir();
    const rawConfig = {
      workflowDefaults: {
        scriptValidator: { enabled: true },
      },
    };
    await writeFile(
      path.join(configDir, "config.json"),
      JSON.stringify(rawConfig),
      "utf-8",
    );

    const reader = createConfigReader(configDir);

    await expect(reader.readRawConfig()).resolves.toEqual(rawConfig);
  });
});
