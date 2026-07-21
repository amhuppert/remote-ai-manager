import { describe, expect, it } from "vitest";
import {
  ROW_COLUMN_SIZE_WARN_BYTES,
  checkRowColumnSize,
  checkRowColumnSizes,
  deriveRowColumnSizeFinding,
  deriveRowColumnSizeFindings,
} from "./row-size-telemetry";

interface WarnCall {
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

function fakeLogger() {
  const calls: WarnCall[] = [];
  return {
    calls,
    logger: {
      warn(message: string, fields?: Record<string, unknown>) {
        calls.push({ message, fields: fields ?? {} });
      },
    },
  };
}

/** Let the deferred emission's setImmediate callback run. */
function flushDeferredEmit(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const oversized = "x".repeat(ROW_COLUMN_SIZE_WARN_BYTES + 1);
const atThreshold = "x".repeat(ROW_COLUMN_SIZE_WARN_BYTES);

describe("deriveRowColumnSizeFinding (pure)", () => {
  it("documents the threshold as 256 KiB", () => {
    expect(ROW_COLUMN_SIZE_WARN_BYTES).toBe(262144);
  });

  it("returns null at or under the threshold", () => {
    expect(
      deriveRowColumnSizeFinding(
        "conversations",
        "pending_queue",
        "c1",
        atThreshold,
      ),
    ).toBeNull();
  });

  it("returns a finding when oversized", () => {
    expect(
      deriveRowColumnSizeFinding(
        "conversations",
        "pending_queue",
        "c1",
        oversized,
      ),
    ).toEqual({
      table: "conversations",
      column: "pending_queue",
      id: "c1",
      bytes: ROW_COLUMN_SIZE_WARN_BYTES + 1,
      thresholdBytes: ROW_COLUMN_SIZE_WARN_BYTES,
    });
  });

  it("measures UTF-8 byte length, not character length", () => {
    // Each `€` is 3 UTF-8 bytes; a string of (threshold/3 + 1) chars is under
    // the threshold in characters but over it in bytes.
    const chars = Math.floor(ROW_COLUMN_SIZE_WARN_BYTES / 3) + 1;
    const value = "€".repeat(chars);
    expect(value.length).toBeLessThan(ROW_COLUMN_SIZE_WARN_BYTES);
    const finding = deriveRowColumnSizeFinding(
      "sessions",
      "workflow_envelopes",
      "s1",
      value,
    );
    expect(finding?.bytes).toBe(Buffer.byteLength(value, "utf8"));
  });

  it("ignores non-string binds (number, null, undefined)", () => {
    for (const value of [123, null, undefined]) {
      expect(
        deriveRowColumnSizeFinding("conversations", "total_turns", "c1", value),
      ).toBeNull();
    }
  });
});

describe("deriveRowColumnSizeFindings (pure)", () => {
  it("flags only the oversized named columns present in the bind", () => {
    const findings = deriveRowColumnSizeFindings({
      table: "conversations",
      id: "c1",
      bind: {
        status: "running", // small
        pending_queue: oversized, // over
        mcp_runtime: atThreshold, // at threshold, not over
        // agent_capabilities_runtime intentionally absent
      },
      columns: ["pending_queue", "mcp_runtime", "agent_capabilities_runtime"],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ column: "pending_queue", id: "c1" });
  });
});

describe("emission is deferred out of the critical section", () => {
  it("checkRowColumnSize does NOT log synchronously, then logs after the tick", async () => {
    const { calls, logger } = fakeLogger();
    checkRowColumnSize({
      logger,
      table: "conversations",
      column: "pending_queue",
      id: "c1",
      value: oversized,
    });

    // The whole point: logger.warn (which does appendFileSync) must not run
    // inside the caller's synchronous stack — that stack is the held write-queue
    // section / SQLite transaction.
    expect(calls).toEqual([]);

    await flushDeferredEmit();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe("state-store.row_size.exceeded");
    expect(calls[0]?.fields).toEqual({
      table: "conversations",
      column: "pending_queue",
      id: "c1",
      bytes: ROW_COLUMN_SIZE_WARN_BYTES + 1,
      thresholdBytes: ROW_COLUMN_SIZE_WARN_BYTES,
    });
  });

  it("checkRowColumnSizes defers the warn for each oversized column", async () => {
    const { calls, logger } = fakeLogger();
    checkRowColumnSizes({
      logger,
      table: "conversations",
      id: "c1",
      bind: { pending_queue: oversized, mcp_runtime: atThreshold },
      columns: ["pending_queue", "mcp_runtime"],
    });

    expect(calls).toEqual([]);
    await flushDeferredEmit();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.fields).toMatchObject({ column: "pending_queue" });
  });

  it("schedules nothing when no column is oversized", async () => {
    const { calls, logger } = fakeLogger();
    checkRowColumnSizes({
      logger,
      table: "conversations",
      id: "c1",
      bind: { status: "running", mcp_runtime: atThreshold },
      columns: ["status", "mcp_runtime"],
    });
    await flushDeferredEmit();
    expect(calls).toEqual([]);
  });
});
