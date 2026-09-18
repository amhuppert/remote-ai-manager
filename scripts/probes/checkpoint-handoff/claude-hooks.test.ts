import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  assessClaudeHookWindow,
  installClaudeHookFixture,
  observeClaudeHookWindow,
  type ClaudeHookSnapshot,
} from "./claude-hooks";

const empty = (): ClaudeHookSnapshot => ({
  records: [],
  lineHashes: [],
  logSha256: "empty",
  pendingActionAbsent: true,
  ordinaryToolPositive: false,
});

describe("Claude native hook evidence", () => {
  it("waits for an asynchronous ordinary SessionEnd instead of failing on the first empty snapshot", async () => {
    let now = 0;
    const clock = {
      now: () => now,
      async sleep(ms: number) {
        now += ms;
      },
    };
    const fixture = {
      snapshot: (): ClaudeHookSnapshot =>
        now < 600
          ? empty()
          : {
              ...empty(),
              records: [
                { event: "SessionEnd", at: "later", sessionSha256: "source" },
              ],
              lineHashes: ["later"],
            },
    };
    expect(
      await observeClaudeHookWindow(
        fixture,
        empty(),
        "ordinary-close",
        "source",
        { windowMs: 1000, clock },
      ),
    ).toMatchObject({ passed: true, elapsedMs: 600 });
  });
  it("observes the full suppression window and catches late source hooks", async () => {
    let now = 0;
    const clock = {
      now: () => now,
      async sleep(ms: number) {
        now += ms;
      },
    };
    const fixture = {
      snapshot: (): ClaudeHookSnapshot =>
        now < 600
          ? empty()
          : {
              ...empty(),
              records: [
                { event: "SessionEnd", at: "later", sessionSha256: "source" },
              ],
              lineHashes: ["later"],
            },
    };
    expect(
      await observeClaudeHookWindow(
        fixture,
        empty(),
        "capture-suppression",
        "source",
        { windowMs: 1000, clock },
      ),
    ).toMatchObject({ passed: false, elapsedMs: 1000 });
    now = 0;
    expect(
      await observeClaudeHookWindow(
        { snapshot: empty },
        empty(),
        "capture-suppression",
        "source",
        { windowMs: 1000, clock },
      ),
    ).toMatchObject({ passed: true, elapsedMs: 1000 });
  });
  it("emits private correlated hook evidence through the installed command with quoted paths", () => {
    const tempRoot = path.resolve(".cc/temp");
    mkdirSync(tempRoot, { recursive: true });
    const root = mkdtempSync(path.join(tempRoot, "hook-fixture-test-"));
    try {
      const fixture = installClaudeHookFixture({
        root,
        projectPath: path.join(root, "project's path"),
        runId: "test",
      });
      const config = z
        .object({
          hooks: z.record(
            z.string(),
            z.array(
              z.object({ hooks: z.array(z.object({ command: z.string() })) }),
            ),
          ),
        })
        .parse(JSON.parse(readFileSync(fixture.settingsPath, "utf8")));
      const command = config.hooks.SessionStart?.[0]?.hooks[0]?.command;
      if (!command) throw new Error("missing installed SessionStart command");
      execFileSync("/bin/sh", ["-c", command], {
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "protected-session",
          prompt: "DO-NOT-STORE-PROMPT",
        }),
      });
      expect(fixture.snapshot()).toMatchObject({
        pendingActionAbsent: true,
        ordinaryToolPositive: false,
        records: [
          {
            event: "SessionStart",
            sessionSha256: createHash("sha256")
              .update("protected-session")
              .digest("hex"),
          },
        ],
      });
      const log = readFileSync(fixture.hookLogPath, "utf8");
      expect(log).not.toContain("protected-session");
      expect(log).not.toContain("DO-NOT-STORE-PROMPT");
      expect(statSync(fixture.hookLogPath).mode & 0o777).toBe(0o600);
      expect(() =>
        execFileSync("/bin/sh", ["-c", command], {
          input: JSON.stringify({ hook_event_name: "Stop" }),
        }),
      ).toThrow();
      expect(fixture.snapshot().records).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("requires all actual ordinary positive hooks and a callable tool write", () => {
    expect(
      assessClaudeHookWindow(empty(), empty(), "ordinary-positive"),
    ).toMatchObject({
      passed: false,
      failures: expect.arrayContaining([
        "ordinary tool positive-control file was not written",
        "SessionStart positive control was not observed",
        "UserPromptSubmit positive control was not observed",
        "Stop positive control was not observed",
      ]),
    });
  });
  it("rejects capture hooks, pending action effects, and replacement of prior evidence", () => {
    const before = { ...empty(), lineHashes: ["before"] };
    const after: ClaudeHookSnapshot = {
      ...empty(),
      pendingActionAbsent: false,
      lineHashes: ["replaced", "new"],
      records: [
        { event: "SessionEnd", at: "now", sessionSha256: "source" },
        { event: "Stop", at: "now", sessionSha256: "source" },
      ],
    };
    expect(
      assessClaudeHookWindow(before, after, "capture-suppression"),
    ).toMatchObject({
      passed: false,
      failures: expect.arrayContaining([
        "hook log prefix changed",
        "pending ordinary action was executed",
        "capture window executed 1 planted hook(s)",
      ]),
    });
  });
  it("requires ordinary-close positive evidence correlated to its provider", () => {
    const after: ClaudeHookSnapshot = {
      ...empty(),
      records: [{ event: "SessionEnd", at: "now", sessionSha256: "different" }],
      lineHashes: ["line"],
    };
    expect(
      assessClaudeHookWindow(empty(), after, "ordinary-close", "source").passed,
    ).toBe(false);
    expect(
      assessClaudeHookWindow(empty(), after, "ordinary-close", "different")
        .passed,
    ).toBe(true);
  });
  it("excludes independently correlated generation hooks from a source capture suppression window", () => {
    const after: ClaudeHookSnapshot = {
      ...empty(),
      records: [{ event: "Stop", at: "now", sessionSha256: "generation" }],
      lineHashes: ["generation"],
    };
    expect(
      assessClaudeHookWindow(empty(), after, "capture-suppression", "source")
        .passed,
    ).toBe(true);
    expect(
      assessClaudeHookWindow(empty(), after, "capture-suppression").passed,
    ).toBe(false);
    expect(
      assessClaudeHookWindow(
        empty(),
        {
          ...after,
          records: [{ event: "Stop", at: "now", sessionSha256: "source" }],
        },
        "capture-suppression",
        "source",
      ).passed,
    ).toBe(false);
  });
});
