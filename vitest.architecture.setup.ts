/**
 * Architecture and toolchain tests read repository files by path, outside the
 * import graph Vitest consults for changed-file selection. Each such test
 * declares those inputs with `// @vitest-inputs <glob>...` so the `test`
 * wrapper can select it when they change. This setup records every repository
 * read while the file runs and fails the file when a read falls outside its
 * declarations, so the declarations that drive selection cannot drift from
 * what the test actually reads.
 *
 * Tracing starts at import time, before the test module is evaluated, because
 * many contracts read their inputs at module scope.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll } from "vitest";
import {
  describeUndeclaredReads,
  findUndeclaredReads,
  parseDeclaredInputs,
} from "./scripts/test-inputs";
import { createReadTracer } from "./scripts/test-input-tracer";

const repoRoot = process.cwd();
const tracer = createReadTracer({ root: repoRoot });
tracer.start();

afterAll((suite) => {
  const reads = tracer.stop();
  const testPath = "filepath" in suite ? suite.filepath : suite.file.filepath;
  const testFile = path.relative(repoRoot, testPath).split(path.sep).join("/");
  const declared = parseDeclaredInputs(readFileSync(testPath, "utf8"));

  // Diagnostic dump of everything the file read, declared or not, for
  // authoring declarations: CC_TEST_INPUTS_REPORT_DIR=<dir>.
  const reportDir = process.env["CC_TEST_INPUTS_REPORT_DIR"];
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      path.join(reportDir, `${testFile.replaceAll("/", "__")}.json`),
      JSON.stringify({ testFile, declared, reads }, null, 2),
    );
  }

  const undeclared = findUndeclaredReads(reads, declared);
  if (undeclared.length > 0) {
    throw new Error(describeUndeclaredReads(testFile, undeclared, declared));
  }
});
