import { startVitest } from "vitest/node";

const [mode, projectSelection, ...modeArgs] = process.argv.slice(2);
const testWorkers = Number.parseInt(process.env.CC_TEST_WORKERS ?? "", 10);
const testHeapMb = Number.parseInt(process.env.CC_TEST_HEAP_MB ?? "", 10);
// 0 disables bail. Scoped runs keep the low threshold so a broken branch fails
// fast; the full-suite command raises it to report every failure at once.
const testBail = Number.parseInt(process.env.CC_TEST_BAIL ?? "3", 10);

if (!Number.isInteger(testWorkers) || testWorkers < 1) {
  throw new Error("CC_TEST_WORKERS must be a positive integer");
}
if (!Number.isInteger(testHeapMb) || testHeapMb < 1) {
  throw new Error("CC_TEST_HEAP_MB must be a positive integer");
}
if (!Number.isInteger(testBail) || testBail < 0) {
  throw new Error("CC_TEST_BAIL must be a non-negative integer");
}

const projectsBySelection = {
  both: ["unit-node", "unit-jsdom"],
  node: ["unit-node"],
  jsdom: ["unit-jsdom"],
};
const projects = projectsBySelection[projectSelection];
if (!projects) {
  throw new Error("expected project selection both, node, or jsdom");
}

let filters = [];
let changed;
if (mode === "paths" && modeArgs.length > 0) {
  filters = modeArgs;
} else if (mode === "changed" && modeArgs.length === 1) {
  changed = modeArgs[0];
} else if (mode !== "full" || modeArgs.length > 0) {
  throw new Error("expected full, changed <merge-base>, or paths <path...>");
}

await startVitest("test", filters, {
  run: true,
  color: false,
  reporters: ["dot"],
  bail: testBail,
  passWithNoTests: mode !== "full",
  ...(changed ? { changed } : {}),
  project: projects,
  pool: "forks",
  maxWorkers: testWorkers,
  minWorkers: 1,
  poolOptions: {
    forks: {
      maxForks: testWorkers,
      minForks: 1,
      execArgv: [`--max-old-space-size=${testHeapMb}`],
    },
  },
});
