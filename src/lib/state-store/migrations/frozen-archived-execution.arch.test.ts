// @vitest-inputs src/lib/state-store/migrations/frozen-archived-execution.ts
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("keeps the historical archive gate independent of live catalogs and schemas", async () => {
  const source = await readFile(
    new URL("./frozen-archived-execution.ts", import.meta.url),
    "utf8",
  );
  const specifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  expect(specifiers).toEqual(["zod", "@/lib/agent-profiles/hashing"]);
});
