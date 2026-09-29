import { createVitest } from "vitest/node";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const sourcePaths = process.argv.slice(2);
const context = await createVitest("test", {
  ...(sourcePaths.length
    ? { related: sourcePaths.map((source) => path.resolve(source)) }
    : {}),
  project: ["unit-pure", "unit-node", "unit-jsdom", "unit-architecture"],
  watch: false,
  run: true,
  reporters: [],
});
try {
  const specifications = await context.getRelevantTestSpecifications();
  const selected = specifications
    .map((specification) => ({
      file: path.relative(process.cwd(), specification.moduleId),
      project: specification.project.name,
    }))
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.project.localeCompare(b.project),
    );
  const directory = path.join(process.cwd(), ".cc/temp/validation-impact");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, `${Date.now()}-${randomUUID()}.json`),
    JSON.stringify(
      {
        runId: process.env.CC_VALIDATION_RUN_ID ?? null,
        sourcePaths,
        selected,
        selection:
          "Vitest native related-file selection, without test execution",
        limitation:
          "The test wrapper additionally expands declared inputs and setup/configuration changes. Use deps:graph --tests --changed for declared-input estimates; this diagnostic measures only the native import-selection mechanism.",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await context.close();
}
