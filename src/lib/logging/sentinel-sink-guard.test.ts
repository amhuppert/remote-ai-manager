/**
 * The log SINK's last line of defence for `project-conversation-parity` R1.3.
 *
 * Structured-log fields are a public identity surface, and `sessionName` is a
 * public one. The project sentinel is a state-store/runtime key, so it must
 * never occupy that field — but the surface that can hand it here is the whole
 * project-reachable call graph plus the request trace context, which is why six
 * successive rounds of per-call-site fixes kept finding another sink. The sink
 * itself therefore substitutes the discriminated scope, making the guarantee
 * unconditional rather than a property of each individual call site.
 *
 * This is the logging analogue of the throw in `conversationTargetApiBase`: the
 * builder that would emit the sentinel refuses to. The logger never throws by
 * contract, so it substitutes instead.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { runWithTrace } from "./context";
import { createLogger, _resetLoggerForTesting } from "./logger";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";

const tmpDir = path.join(os.tmpdir(), "cc-logger-sentinel-test");
const testLogFile = path.join(tmpDir, "sentinel.log");

function readLogLines(): Record<string, unknown>[] {
  const content = readFileSync(testLogFile, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The single entry a case emitted — an empty file is a test bug, not a pass. */
function onlyLogLine(): Record<string, unknown> {
  const lines = readLogLines();
  expect(lines).toHaveLength(1);
  const [entry] = lines;
  if (entry === undefined) throw new Error("no log line was written");
  return entry;
}

function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory()
      ? listFilesRecursive(full)
      : [full];
  });
}

function cleanup(): void {
  try {
    if (existsSync(testLogFile)) unlinkSync(testLogFile);
  } catch {
    // ignore
  }
}

describe("log sink refuses the project sentinel as a session identity", () => {
  beforeEach(() => {
    cleanup();
    _resetLoggerForTesting();
    delete process.env["CC_LOG_SILENT"];
    process.env["CC_LOG_FILE"] = testLogFile;
    process.env["CC_LOG_LEVEL"] = "debug";
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    cleanup();
    _resetLoggerForTesting();
    process.env["CC_LOG_SILENT"] = "1";
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_LEVEL"];
  });

  it("substitutes scope:project for a sentinel-valued sessionName field", () => {
    const logger = createLogger("test-module");
    logger.info("some.event", {
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      conversationId: "conv-1",
    });

    const entry = onlyLogLine();
    expect(entry).not.toHaveProperty("sessionName");
    expect(entry["scope"]).toBe("project");
    // The rest of the identity survives — the fix removes the sentinel, not
    // the diagnostic.
    expect(entry["conversationId"]).toBe("conv-1");
    expect(entry["message"]).toBe("some.event");
  });

  it("substitutes scope:project when the sentinel arrives via the trace context", () => {
    // The trace context injects `sessionName` into EVERY entry emitted inside a
    // request, so a project request would stamp the sentinel on log lines whose
    // own call sites never mention a session.
    const logger = createLogger("test-module");
    runWithTrace(
      {
        traceId: "t-1",
        projectName: "demo",
        sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationId: "conv-1",
      },
      () => {
        logger.info("unrelated.event", { detail: 7 });
      },
    );

    const entry = onlyLogLine();
    expect(entry).not.toHaveProperty("sessionName");
    expect(entry["scope"]).toBe("project");
    expect(entry["projectName"]).toBe("demo");
    expect(entry["detail"]).toBe(7);
  });

  it("leaves a real session name untouched", () => {
    const logger = createLogger("test-module");
    logger.info("some.event", { sessionName: "feat", conversationId: "c1" });

    const entry = onlyLogLine();
    expect(entry["sessionName"]).toBe("feat");
    expect(entry).not.toHaveProperty("scope");
  });

  it("does not overwrite a scope a caller already reported", () => {
    const logger = createLogger("test-module");
    logger.info("some.event", { scope: "project", conversationId: "c1" });

    const entry = onlyLogLine();
    expect(entry["scope"]).toBe("project");
    expect(entry).not.toHaveProperty("sessionName");
  });
});

/**
 * The log FILE PATH is a diagnostic identity too, and it is resolved from the
 * raw trace context rather than from the sanitized entry — so the field guard
 * above cannot reach it. With scoped routing on (the production default;
 * `CC_LOG_FILE` disables it), a project request used to land in
 * `logs/sessions/<project>____project__/…`.
 */
describe("scoped log destinations for a project conversation", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "cc-logger-sentinel-scope-"));
    _resetLoggerForTesting();
    delete process.env["CC_LOG_SILENT"];
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_SCOPED"];
    process.env["CC_CONFIG_DIR"] = tmpRoot;
    process.env["CC_LOG_LEVEL"] = "debug";
  });

  afterEach(() => {
    _resetLoggerForTesting();
    process.env["CC_LOG_SILENT"] = "1";
    delete process.env["CC_LOG_LEVEL"];
    delete process.env["CC_CONFIG_DIR"];
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function logInProjectRequest(): void {
    const logger = createLogger("test-module");
    runWithTrace(
      {
        traceId: "t-1",
        projectName: "demo",
        sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationId: "conv-1",
      },
      () => {
        logger.info("project.turn_event", { detail: 7 });
      },
    );
  }

  it("never puts the sentinel in a log file path", () => {
    logInProjectRequest();

    const written = listFilesRecursive(path.join(tmpRoot, "logs"));
    expect(written.length).toBeGreaterThan(0);
    for (const file of written) {
      expect(file).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
    }
  });

  it("routes a project conversation to its own project-scoped destination", () => {
    logInProjectRequest();

    const conversationLog = path.join(
      tmpRoot,
      "logs",
      "projects",
      "demo",
      "conversations",
      "conv-1.log",
    );
    expect(existsSync(conversationLog)).toBe(true);
    const [entry] = readFileSync(conversationLog, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entry?.["message"]).toBe("project.turn_event");
    expect(entry?.["scope"]).toBe("project");
  });

  it("still routes a real session to its session-scoped destination", () => {
    const logger = createLogger("test-module");
    runWithTrace(
      {
        traceId: "t-2",
        projectName: "demo",
        sessionName: "feature-x",
        conversationId: "conv-2",
      },
      () => {
        logger.info("session.turn_event", {});
      },
    );

    expect(
      existsSync(
        path.join(
          tmpRoot,
          "logs",
          "sessions",
          "demo__feature-x",
          "conversations",
          "conv-2.log",
        ),
      ),
    ).toBe(true);
  });
});
