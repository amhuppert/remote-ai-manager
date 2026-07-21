import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_CONFIG,
  budgetConfigSchema,
  evaluateBudgets,
  extractRowSizeEvents,
  parseBudgetConfig,
} from "./budgets";
import type { ParsedServerLogRecord } from "./types";

describe("budget config parsing", () => {
  it("accepts a well-formed config and rejects a malformed one", () => {
    const config = parseBudgetConfig({
      routeClassP95Ms: 1000,
      writeQueueHoldMs: 500,
      stateReadMs: 100,
      rowSizeBytes: 262144,
    });
    expect(config.writeQueueHoldMs).toBe(500);

    expect(() => parseBudgetConfig({ routeClassP95Ms: "nope" })).toThrow();
  });

  it("ships a default matching the schema (write-queue hold = 500ms)", () => {
    expect(() => budgetConfigSchema.parse(DEFAULT_BUDGET_CONFIG)).not.toThrow();
    expect(DEFAULT_BUDGET_CONFIG.writeQueueHoldMs).toBe(500);
    expect(DEFAULT_BUDGET_CONFIG.rowSizeBytes).toBe(262144);
  });
});

describe("evaluateBudgets", () => {
  it("returns no violations when every observed value is under its ceiling", () => {
    const violations = evaluateBudgets({
      config: DEFAULT_BUDGET_CONFIG,
      routeP95s: [{ key: "GET /api/x", p95Ms: 400 }],
      writeQueueHolds: [{ label: "mutateSession", maxHoldMs: 120 }],
      stateReadP95s: [{ accessor: "getSession", p95Ms: 30 }],
      rowSizes: [{ subject: "conversations.machine_snapshot#c1", bytes: 1000 }],
    });
    expect(violations).toEqual([]);
  });

  it("flags each ceiling that is exceeded, naming the subject and both values", () => {
    const violations = evaluateBudgets({
      config: DEFAULT_BUDGET_CONFIG,
      routeP95s: [{ key: "POST /api/queue", p95Ms: 2500 }],
      writeQueueHolds: [{ label: "createSession", maxHoldMs: 14200 }],
      stateReadP95s: [{ accessor: "readAll", p95Ms: 450 }],
      rowSizes: [
        { subject: "conversations.machine_snapshot#c1", bytes: 3_000_000 },
      ],
    });

    const kinds = violations.map((v) => v.kind).sort();
    expect(kinds).toEqual([
      "route-p95",
      "row-size",
      "state-read",
      "write-queue-hold",
    ]);

    const routeViolation = violations.find((v) => v.kind === "route-p95")!;
    expect(routeViolation).toMatchObject({
      subject: "POST /api/queue",
      observed: 2500,
      ceiling: 1000,
      unit: "ms",
    });
    const rowViolation = violations.find((v) => v.kind === "row-size")!;
    expect(rowViolation).toMatchObject({
      observed: 3_000_000,
      ceiling: 262144,
      unit: "bytes",
    });
  });

  it("ignores null observations (an accessor with no timed samples)", () => {
    const violations = evaluateBudgets({
      config: DEFAULT_BUDGET_CONFIG,
      routeP95s: [{ key: "GET /api/x", p95Ms: null }],
      writeQueueHolds: [{ label: "l", maxHoldMs: null }],
      stateReadP95s: [{ accessor: "a", p95Ms: null }],
      rowSizes: [],
    });
    expect(violations).toEqual([]);
  });
});

describe("extractRowSizeEvents", () => {
  it("pulls table/column/id/bytes from state-store.row_size.exceeded records", () => {
    const records: ParsedServerLogRecord[] = [
      {
        lineNumber: 1,
        timestamp: "2026-05-21T12:00:00.000Z",
        timestampMs: 0,
        level: "warn",
        module: "state-store",
        message: "state-store.row_size.exceeded",
        raw: {
          table: "conversations",
          column: "machine_snapshot",
          id: "c1",
          bytes: 3_000_000,
        },
      },
      {
        lineNumber: 2,
        timestamp: "2026-05-21T12:00:00.000Z",
        timestampMs: 0,
        level: "info",
        module: "state-store",
        message: "state.read.timing",
        raw: { accessor: "getSession" },
      },
    ];
    const rowSizes = extractRowSizeEvents(records);
    expect(rowSizes).toEqual([
      { subject: "conversations.machine_snapshot#c1", bytes: 3_000_000 },
    ]);
  });
});
