import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ensureDebugDir,
  getDebugLogPath,
  appendDebugLogEntry,
  clearDebugLog,
  getDebugLogStats,
  getManifestPath,
  readManifest,
  deleteManifest,
} from "./debug-log";
import type { DebugLogEntry, DebugInstrumentationManifest } from "@/types";

describe("debug-log", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-debug-log-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("ensureDebugDir", () => {
    it("creates .debug directory if it does not exist", () => {
      const debugDir = ensureDebugDir(tmpDir);
      expect(debugDir).toBe(path.join(tmpDir, ".debug"));
      expect(fs.existsSync(debugDir)).toBe(true);
    });

    it("is idempotent — does not error if .debug already exists", () => {
      ensureDebugDir(tmpDir);
      const debugDir = ensureDebugDir(tmpDir);
      expect(fs.existsSync(debugDir)).toBe(true);
    });
  });

  describe("getDebugLogPath", () => {
    it("returns the path to .debug/logs.jsonl", () => {
      const logPath = getDebugLogPath(tmpDir);
      expect(logPath).toBe(path.join(tmpDir, ".debug", "logs.jsonl"));
    });
  });

  describe("appendDebugLogEntry", () => {
    it("creates the file and writes a single NDJSON entry", () => {
      const logPath = getDebugLogPath(tmpDir);
      ensureDebugDir(tmpDir);

      const entry: DebugLogEntry = {
        timestamp: "2025-01-01T00:00:00Z",
        hypothesisId: "H1",
        location: "src/lib/auth.ts:42",
        message: "Token validation result",
        data: { isValid: true },
      };

      appendDebugLogEntry(logPath, entry);

      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual(entry);
    });

    it("appends multiple entries as separate NDJSON lines", () => {
      const logPath = getDebugLogPath(tmpDir);
      ensureDebugDir(tmpDir);

      const entry1: DebugLogEntry = {
        timestamp: "2025-01-01T00:00:00Z",
        hypothesisId: "H1",
        location: "src/lib/auth.ts:42",
        message: "First log",
        data: null,
      };
      const entry2: DebugLogEntry = {
        timestamp: "2025-01-01T00:00:01Z",
        hypothesisId: "H2",
        location: "src/lib/db.ts:10",
        message: "Second log",
        data: { count: 5 },
      };

      appendDebugLogEntry(logPath, entry1);
      appendDebugLogEntry(logPath, entry2);

      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toEqual(entry1);
      expect(JSON.parse(lines[1]!)).toEqual(entry2);
    });
  });

  describe("clearDebugLog", () => {
    it("truncates the log file to empty", () => {
      const logPath = getDebugLogPath(tmpDir);
      ensureDebugDir(tmpDir);

      appendDebugLogEntry(logPath, {
        timestamp: "2025-01-01T00:00:00Z",
        hypothesisId: "H1",
        location: null,
        message: "test",
        data: null,
      });

      clearDebugLog(logPath);

      const content = fs.readFileSync(logPath, "utf-8");
      expect(content).toBe("");
    });

    it("does not error if file does not exist", () => {
      const logPath = getDebugLogPath(tmpDir);
      expect(() => clearDebugLog(logPath)).not.toThrow();
    });
  });

  describe("getDebugLogStats", () => {
    it("returns zero count for empty or nonexistent file", () => {
      const logPath = getDebugLogPath(tmpDir);
      const stats = getDebugLogStats(logPath);
      expect(stats.entryCount).toBe(0);
      expect(stats.hypothesesSeen).toEqual([]);
    });

    it("returns correct count and unique hypotheses", () => {
      const logPath = getDebugLogPath(tmpDir);
      ensureDebugDir(tmpDir);

      appendDebugLogEntry(logPath, {
        timestamp: "2025-01-01T00:00:00Z",
        hypothesisId: "H1",
        location: null,
        message: "a",
        data: null,
      });
      appendDebugLogEntry(logPath, {
        timestamp: "2025-01-01T00:00:01Z",
        hypothesisId: "H2",
        location: null,
        message: "b",
        data: null,
      });
      appendDebugLogEntry(logPath, {
        timestamp: "2025-01-01T00:00:02Z",
        hypothesisId: "H1",
        location: null,
        message: "c",
        data: null,
      });
      appendDebugLogEntry(logPath, {
        timestamp: "2025-01-01T00:00:03Z",
        hypothesisId: null,
        location: null,
        message: "d",
        data: null,
      });

      const stats = getDebugLogStats(logPath);
      expect(stats.entryCount).toBe(4);
      expect(stats.hypothesesSeen).toEqual(["H1", "H2"]);
    });
  });

  describe("instrumentation manifest", () => {
    const sampleManifest: DebugInstrumentationManifest = {
      conversationId: "conv-123",
      createdAt: "2025-01-01T00:00:00Z",
      probes: [
        {
          id: "H1:token-check",
          file: "src/lib/auth.ts",
          description: "Logs token validation result",
        },
        {
          id: "H2:state-before",
          file: "src/app/api/route.ts",
          description: "Captures actor state before dispatch",
        },
      ],
    };

    describe("getManifestPath", () => {
      it("returns path to .debug/instrumentation.json", () => {
        expect(getManifestPath(tmpDir)).toBe(
          path.join(tmpDir, ".debug", "instrumentation.json"),
        );
      });
    });

    describe("readManifest", () => {
      it("returns null when file does not exist", () => {
        expect(readManifest(tmpDir)).toBeNull();
      });

      it("reads and validates a well-formed manifest", () => {
        ensureDebugDir(tmpDir);
        fs.writeFileSync(
          getManifestPath(tmpDir),
          JSON.stringify(sampleManifest),
          "utf-8",
        );

        const result = readManifest(tmpDir);
        expect(result).toEqual(sampleManifest);
      });

      it("throws on malformed JSON", () => {
        ensureDebugDir(tmpDir);
        fs.writeFileSync(getManifestPath(tmpDir), "not-json", "utf-8");

        expect(() => readManifest(tmpDir)).toThrow();
      });
    });

    describe("deleteManifest", () => {
      it("deletes the manifest file", () => {
        ensureDebugDir(tmpDir);
        const manifestPath = getManifestPath(tmpDir);
        fs.writeFileSync(manifestPath, JSON.stringify(sampleManifest), "utf-8");

        deleteManifest(tmpDir);

        expect(fs.existsSync(manifestPath)).toBe(false);
      });

      it("does not error when file does not exist", () => {
        expect(() => deleteManifest(tmpDir)).not.toThrow();
      });
    });
  });
});
