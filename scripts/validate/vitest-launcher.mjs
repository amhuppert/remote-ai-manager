import os from "node:os";
import { startVitest } from "vitest/node";
import { resolveWorkerBudget } from "./worker-budget.mjs";

const [scope, projectSelection, ...scopeArgs] = process.argv.slice(2);
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

// The requested worker count is a ceiling request, not an instruction. Running
// more forks than the machine's budget allows contends with the vitest main
// process, which has its own deadline to meet: a worker whose `onTaskUpdate`
// RPC goes unanswered for 60s fails the run on an unhandled timeout with every
// test passing. Resolved through the same owner the vitest config uses, so the
// two cannot disagree about what this machine can hold.
const workers = resolveWorkerBudget({
  requestedWorkers: testWorkers,
  workerHeapMb: testHeapMb,
  totalMemoryBytes: os.totalmem(),
  availableParallelism: os.availableParallelism(),
});

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
  bail: testBail,
  passWithNoTests: scope !== "full",
  ...(changed ? { changed } : {}),
  project: projects,
  pool: "forks",
  maxWorkers: workers,
  minWorkers: 1,
  poolOptions: {
    forks: {
      maxForks: workers,
      minForks: 1,
      execArgv: [`--max-old-space-size=${testHeapMb}`],
    },
  },
});
