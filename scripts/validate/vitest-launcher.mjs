import { startVitest } from "vitest/node";

const [scope, projectSelection, ...scopeArgs] = process.argv.slice(2);
const testWorkers = Number.parseInt(process.env.CC_TEST_WORKERS ?? "", 10);
const testHeapMb = Number.parseInt(process.env.CC_TEST_HEAP_MB ?? "", 10);

if (!Number.isInteger(testWorkers) || testWorkers < 1) {
  throw new Error("CC_TEST_WORKERS must be a positive integer");
}
if (!Number.isInteger(testHeapMb) || testHeapMb < 1) {
  throw new Error("CC_TEST_HEAP_MB must be a positive integer");
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
if (scope === "paths" && scopeArgs.length > 0) {
  filters = scopeArgs;
} else if (scope === "changed" && scopeArgs.length === 1) {
  changed = scopeArgs[0];
} else if (scope !== "full" || scopeArgs.length > 0) {
  throw new Error("expected full, changed <merge-base>, or paths <path...>");
}

await startVitest("test", filters, {
  run: true,
  color: false,
  reporters: ["dot"],
  bail: 3,
  passWithNoTests: scope !== "full",
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
