import { describe, expect, it } from "vitest";
import { awaitJob, type JobPollResult, type JobWaitSpec } from "./job-wait";
import { EXIT_OK, EXIT_OPERATION_FAILED, type CliHost } from "./shared";

interface TestHost extends CliHost {
  sleeps: number[];
  listenerRemoved: boolean;
  /** Move the injected clock forward, as a poll that takes time would. */
  advance(ms: number): void;
}

/**
 * `now` is frozen until a test advances it, so only the intended poll interval
 * is charged against the budget: the wait's own accounting, not the machine's
 * clock, decides how many polls a budget buys.
 */
function testHost(
  options: { signalOnSleep?: "SIGINT" | "SIGTERM" } = {},
): TestHost {
  const sleeps: number[] = [];
  let currentNow = 1_000;
  let signalListener: ((signal: "SIGINT" | "SIGTERM") => void) | null = null;
  let signalSent = false;
  const host: TestHost = {
    sleeps,
    listenerRemoved: false,
    async fetch() {
      throw new Error("the job waiter must not fetch on its own");
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep(ms) {
      sleeps.push(ms);
      if (options.signalOnSleep && !signalSent) {
        signalSent = true;
        signalListener?.(options.signalOnSleep);
      }
    },
    now: () => currentNow,
    advance(ms) {
      currentNow += ms;
    },
    onSignal(listener) {
      signalListener = listener;
      return () => {
        host.listenerRemoved = true;
        signalListener = null;
      };
    },
    platform: "darwin",
    homedir: "/Users/test",
  };
  return host;
}

type DemoStatus = "running" | "done";

/** Polls the given script in order, repeating its last entry forever. */
function scriptedPoll(
  script: Array<JobPollResult<DemoStatus>>,
  seen: Array<JobPollResult<DemoStatus>>,
): () => Promise<JobPollResult<DemoStatus>> {
  return async () => {
    const next = script[Math.min(seen.length, script.length - 1)];
    if (next === undefined) throw new Error("empty poll script");
    seen.push(next);
    return next;
  };
}

const RUNNING: JobPollResult<DemoStatus> = { ok: true, status: "running" };
const DONE: JobPollResult<DemoStatus> = { ok: true, status: "done" };
const UNPARSEABLE: JobPollResult<DemoStatus> = {
  ok: false,
  parseError: "unexpected status response from the CC server",
};

function demoSpec(
  overrides: Partial<JobWaitSpec<DemoStatus>> &
    Pick<JobWaitSpec<DemoStatus>, "poll">,
): JobWaitSpec<DemoStatus> {
  return {
    classify: (status) =>
      status === "done"
        ? {
            terminal: true,
            result: { exitCode: EXIT_OK, stdout: "", stderr: "" },
          }
        : { terminal: false },
    timeoutMs: 3_000,
    pollIntervalMs: 1_000,
    json: false,
    onTimeout: (elapsedMs) => ({
      exitCode: EXIT_OPERATION_FAILED,
      message: `job-9 still running after ${Math.round(elapsedMs / 1000)}s — the job continues server-side`,
      hint: "recover the result with 'cctl demo status job-9'",
      json: false,
    }),
    ...overrides,
  };
}

describe("awaitJob budget", () => {
  it("spends the budget in poll intervals, then fails with the spec's continuation", async () => {
    const seen: Array<JobPollResult<DemoStatus>> = [];
    const host = testHost();

    const result = await awaitJob(
      host,
      demoSpec({ poll: scriptedPoll([RUNNING], seen) }),
    );

    expect(seen).toHaveLength(3);
    expect(host.sleeps).toEqual([1_000, 1_000, 1_000]);
    expect(result.exitCode).toBe(EXIT_OPERATION_FAILED);
    expect(result.stderr).toContain("still running after 3s");
    expect(result.stderr).toContain("cctl demo status job-9");
  });

  it("returns the classifier's terminal result without exhausting the budget", async () => {
    const seen: Array<JobPollResult<DemoStatus>> = [];
    const host = testHost();

    const result = await awaitJob(
      host,
      demoSpec({ poll: scriptedPoll([RUNNING, DONE], seen) }),
    );

    expect(result.exitCode).toBe(EXIT_OK);
    expect(seen).toHaveLength(2);
  });

  // Once a poll can block server-side, charging its duration AND a full
  // interval on top spends the budget at twice the intended rate.
  it("treats the interval as a floor on one iteration, not an addition to it", async () => {
    const seen: Array<JobPollResult<DemoStatus>> = [];
    const host = testHost();

    const result = await awaitJob(
      host,
      demoSpec({
        async poll() {
          host.advance(900);
          seen.push(RUNNING);
          return RUNNING;
        },
      }),
    );

    expect(seen).toHaveLength(3);
    expect(host.sleeps).toEqual([100, 100, 100]);
    expect(result.exitCode).toBe(EXIT_OPERATION_FAILED);
    expect(result.stderr).toContain("still running after 3s");
  });

  it("skips the sleep when the poll already spent the whole interval", async () => {
    const seen: Array<JobPollResult<DemoStatus>> = [];
    const host = testHost();

    const result = await awaitJob(
      host,
      demoSpec({
        async poll() {
          host.advance(1_000);
          seen.push(RUNNING);
          return RUNNING;
        },
      }),
    );

    expect(seen).toHaveLength(3);
    expect(host.sleeps).toEqual([]);
    expect(result.exitCode).toBe(EXIT_OPERATION_FAILED);
  });
});

describe("awaitJob budget disclosure", () => {
  // A long-poll asks the transport to wait; it must not be allowed to outlive
  // the budget the caller set, so each poll is told what is left of it.
  it("tells each poll how much budget remains", async () => {
    const offered: number[] = [];
    const host = testHost();

    await awaitJob(
      host,
      demoSpec({
        async poll(remainingBudgetMs) {
          offered.push(remainingBudgetMs);
          return RUNNING;
        },
      }),
    );

    expect(offered).toEqual([3_000, 2_000, 1_000]);
  });
});

describe("awaitJob parse failures", () => {
  it("fails loud at the third consecutive unparseable response", async () => {
    const seen: Array<JobPollResult<DemoStatus>> = [];
    const host = testHost();

    const result = await awaitJob(
      host,
      demoSpec({ poll: scriptedPoll([UNPARSEABLE], seen), timeoutMs: 600_000 }),
    );

    expect(seen).toHaveLength(3);
    expect(result.exitCode).toBe(EXIT_OPERATION_FAILED);
    expect(result.stderr).toContain(
      "unexpected status response from the CC server",
    );
    expect(result.stderr).not.toContain("still running");
  });

  it("honours a spec's own parse-failure threshold", async () => {
    const seen: Array<JobPollResult<DemoStatus>> = [];
    const host = testHost();

    const result = await awaitJob(
      host,
      demoSpec({
        poll: scriptedPoll([UNPARSEABLE], seen),
        timeoutMs: 600_000,
        maxConsecutiveParseFailures: 2,
      }),
    );

    expect(seen).toHaveLength(2);
    expect(result.exitCode).toBe(EXIT_OPERATION_FAILED);
  });

  it("tolerates isolated blips: a readable response resets the streak", async () => {
    const seen: Array<JobPollResult<DemoStatus>> = [];
    const host = testHost();

    const result = await awaitJob(
      host,
      demoSpec({
        poll: scriptedPoll(
          [UNPARSEABLE, UNPARSEABLE, RUNNING, UNPARSEABLE, UNPARSEABLE, DONE],
          seen,
        ),
        timeoutMs: 600_000,
      }),
    );

    expect(result.exitCode).toBe(EXIT_OK);
    expect(seen).toHaveLength(6);
  });
});

describe("awaitJob forensics", () => {
  it("appends the spec's pointers to a timeout failure in both modes", async () => {
    const seen: Array<JobPollResult<DemoStatus>> = [];
    const observed: Array<DemoStatus | null> = [];
    const host = testHost();

    const result = await awaitJob(
      host,
      demoSpec({
        poll: scriptedPoll([RUNNING], seen),
        json: true,
        onTimeout: () => ({
          exitCode: EXIT_OPERATION_FAILED,
          message: "job-9 timed out",
          json: true,
        }),
        forensics: (last) => {
          observed.push(last);
          return ["transcript: /tmp/job-9.jsonl", "logs: cctl dev list"];
        },
      }),
    );

    expect(observed).toEqual(["running"]);
    expect(result.stderr).toContain("transcript: /tmp/job-9.jsonl");
    const envelope: unknown = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({
      ok: false,
      error: "job-9 timed out",
      details: {
        forensics: ["transcript: /tmp/job-9.jsonl", "logs: cctl dev list"],
      },
    });
  });

  it("appends the spec's pointers to a parse-failure, with no status yet seen", async () => {
    const seen: Array<JobPollResult<DemoStatus>> = [];
    const observed: Array<DemoStatus | null> = [];
    const host = testHost();

    const result = await awaitJob(
      host,
      demoSpec({
        poll: scriptedPoll([UNPARSEABLE], seen),
        timeoutMs: 600_000,
        forensics: (last) => {
          observed.push(last);
          return ["logs: cctl dev list"];
        },
      }),
    );

    expect(observed).toEqual([null]);
    expect(result.stderr).toContain(
      "unexpected status response from the CC server",
    );
    expect(result.stderr).toContain("logs: cctl dev list");
  });
});

describe("awaitJob abort", () => {
  it("hands a received signal to onAbort and stops polling", async () => {
    const seen: Array<JobPollResult<DemoStatus>> = [];
    const signals: string[] = [];
    const host = testHost({ signalOnSleep: "SIGINT" });

    const result = await awaitJob(
      host,
      demoSpec({
        poll: scriptedPoll([RUNNING], seen),
        timeoutMs: 600_000,
        onAbort: async (signal) => {
          signals.push(signal);
          return {
            exitCode: EXIT_OPERATION_FAILED,
            stdout: "",
            stderr: `cancelled after ${signal}\n`,
          };
        },
      }),
    );

    expect(signals).toEqual(["SIGINT"]);
    expect(seen).toHaveLength(1);
    expect(result.stderr).toBe("cancelled after SIGINT\n");
    expect(host.listenerRemoved).toBe(true);
  });

  it("does not register a signal listener without an onAbort hook", async () => {
    const seen: Array<JobPollResult<DemoStatus>> = [];
    const host = testHost({ signalOnSleep: "SIGINT" });

    const result = await awaitJob(
      host,
      demoSpec({ poll: scriptedPoll([RUNNING, DONE], seen) }),
    );

    expect(result.exitCode).toBe(EXIT_OK);
    expect(host.listenerRemoved).toBe(false);
  });
});
