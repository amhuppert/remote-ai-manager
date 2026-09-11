import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startVitest } from "vitest/node";
import {
  COORDINATOR_FOOTPRINT_MB,
  WORKER_FOOTPRINT_MB,
  resolveScopedWorkerRequest,
  resolveWorkerBudget,
} from "./worker-budget.mjs";

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
  both: ["unit-pure", "unit-node", "unit-jsdom", "unit-architecture"],
  node: ["unit-pure", "unit-node", "unit-architecture"],
  jsdom: ["unit-jsdom"],
  runtime: ["unit-pure", "unit-node", "unit-jsdom"],
  integration: ["unit-node", "unit-jsdom", "unit-architecture"],
  "node-setup": ["unit-node", "unit-architecture"],
  "pure-dom": ["unit-pure", "unit-jsdom"],
  "pure-node": ["unit-pure", "unit-node"],
  pure: ["unit-pure"],
  architecture: ["unit-architecture"],
};
const projects = projectsBySelection[projectSelection];
if (!projects) {
  throw new Error(
    `unknown project selection ${projectSelection}; expected ${Object.keys(projectsBySelection).join(", ")}`,
  );
}

let filters = [];
let changed;
let related;
if (mode === "paths" && modeArgs.length > 0) {
  filters = modeArgs;
  // Read by vitest.config.ts to narrow each project's include list to these
  // filters before the glob; see scripts/test-path-filters.ts.
  process.env.CC_TEST_PATH_FILTERS = JSON.stringify(filters);
} else if (mode === "changed" && modeArgs.length === 1) {
  changed = modeArgs[0];
} else if (mode === "related" && modeArgs.length === 1) {
  // One repository-relative path per line: the files whose change should run
  // every test that imports them, plus test files to run outright.
  related = readFileSync(modeArgs[0], "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((file) => path.resolve(process.cwd(), file));
} else if (mode !== "full" || modeArgs.length > 0) {
  throw new Error(
    "expected full, changed <merge-base>, related <path-list-file>, or paths <path...>",
  );
}

// The requested worker count is a ceiling request, not an instruction. Two
// separate limits apply, both owned by `worker-budget.mjs`.
//
// The scope limit keeps the registered `paths` price honest: that scope is
// charged per forwarded token, and a token is a substring filter that may match
// far more files than it names, so the fork pool is capped at the token count.
//
// The machine limit then bounds whatever survives: running more forks than the
// budget allows contends with the vitest main process, which has its own
// deadline to meet — a worker whose `onTaskUpdate` RPC goes unanswered for 60s
// fails the run on an unhandled timeout with every test passing. Resolved
// through the same owner the vitest config uses, so the two cannot disagree
// about what this machine can hold.
const workers = resolveWorkerBudget({
  requestedWorkers: resolveScopedWorkerRequest({
    mode,
    pathTokenCount: filters.length,
    configuredWorkers: testWorkers,
  }),
  coordinatorFootprintMb: COORDINATOR_FOOTPRINT_MB,
  workerFootprintMb: WORKER_FOOTPRINT_MB,
  totalMemoryBytes: os.totalmem(),
  availableParallelism: os.availableParallelism(),
});

await startVitest("test", filters, {
  run: true,
  color: false,
  reporters: ["dot"],
  bail: testBail,
  passWithNoTests: mode !== "full",
  ...(changed ? { changed } : {}),
  ...(related ? { related } : {}),
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
