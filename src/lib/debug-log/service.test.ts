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
  getDebugManifestPath,
  readManifest,
  deleteManifest,
  verifyCleanupAgainstManifest,
  type CleanupReport,
} from "./service";
import type {
  DebugLogEntry,
  DebugInstrumentationManifest,
} from "@/lib/debug-log/schemas";
const CONV_ID = "conv-abc";

describe("debug-log", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-debug-log-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("ensureDebugDir", () => {
    it("creates .debug/<conversationId>/ directory if it does not exist", () => {
      const debugDir = ensureDebugDir(tmpDir, CONV_ID);
      expect(debugDir).toBe(path.join(tmpDir, ".debug", CONV_ID));
      expect(fs.existsSync(debugDir)).toBe(true);
    });

    it("is idempotent — does not error if directory already exists", () => {
      ensureDebugDir(tmpDir, CONV_ID);
      const debugDir = ensureDebugDir(tmpDir, CONV_ID);
      expect(fs.existsSync(debugDir)).toBe(true);
    });

    it("creates separate directories per conversation", () => {
      const a = ensureDebugDir(tmpDir, "conv-a");
      const b = ensureDebugDir(tmpDir, "conv-b");
      expect(a).not.toBe(b);
      expect(fs.existsSync(a)).toBe(true);
      expect(fs.existsSync(b)).toBe(true);
    });
  });

  describe("getDebugLogPath", () => {
    it("returns the path to .debug/<conversationId>/logs.jsonl", () => {
      const logPath = getDebugLogPath(tmpDir, CONV_ID);
      expect(logPath).toBe(path.join(tmpDir, ".debug", CONV_ID, "logs.jsonl"));
    });
  });

  describe("getDebugManifestPath", () => {
    it("returns the path to .debug/<conversationId>/instrumentation.json", () => {
      expect(getDebugManifestPath(tmpDir, CONV_ID)).toBe(
        path.join(tmpDir, ".debug", CONV_ID, "instrumentation.json"),
      );
    });
  });

  describe("appendDebugLogEntry", () => {
    it("creates the file and writes a single NDJSON entry", () => {
      ensureDebugDir(tmpDir, CONV_ID);
      const logPath = getDebugLogPath(tmpDir, CONV_ID);

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
      ensureDebugDir(tmpDir, CONV_ID);
      const logPath = getDebugLogPath(tmpDir, CONV_ID);

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
      ensureDebugDir(tmpDir, CONV_ID);
      const logPath = getDebugLogPath(tmpDir, CONV_ID);

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
      const logPath = getDebugLogPath(tmpDir, CONV_ID);
      expect(() => clearDebugLog(logPath)).not.toThrow();
    });
  });

  describe("getDebugLogStats", () => {
    it("returns zero count for empty or nonexistent file", () => {
      const logPath = getDebugLogPath(tmpDir, CONV_ID);
      const stats = getDebugLogStats(logPath);
      expect(stats.entryCount).toBe(0);
      expect(stats.hypothesesSeen).toEqual([]);
    });

    it("returns correct count and unique hypotheses", () => {
      ensureDebugDir(tmpDir, CONV_ID);
      const logPath = getDebugLogPath(tmpDir, CONV_ID);

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
      conversationId: CONV_ID,
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

    describe("readManifest", () => {
      it("returns null when file does not exist", () => {
        expect(readManifest(tmpDir, CONV_ID)).toBeNull();
      });

      it("reads and validates a well-formed manifest", () => {
        ensureDebugDir(tmpDir, CONV_ID);
        fs.writeFileSync(
          getDebugManifestPath(tmpDir, CONV_ID),
          JSON.stringify(sampleManifest),
          "utf-8",
        );

        const result = readManifest(tmpDir, CONV_ID);
        expect(result).toEqual(sampleManifest);
      });

      it("throws on malformed JSON", () => {
        ensureDebugDir(tmpDir, CONV_ID);
        fs.writeFileSync(
          getDebugManifestPath(tmpDir, CONV_ID),
          "not-json",
          "utf-8",
        );

        expect(() => readManifest(tmpDir, CONV_ID)).toThrow();
      });
    });

    describe("deleteManifest", () => {
      it("deletes the manifest file", () => {
        ensureDebugDir(tmpDir, CONV_ID);
        const manifestPath = getDebugManifestPath(tmpDir, CONV_ID);
        fs.writeFileSync(manifestPath, JSON.stringify(sampleManifest), "utf-8");

        deleteManifest(tmpDir, CONV_ID);

        expect(fs.existsSync(manifestPath)).toBe(false);
      });

      it("does not error when file does not exist", () => {
        expect(() => deleteManifest(tmpDir, CONV_ID)).not.toThrow();
      });
    });
  });

  describe("verifyCleanupAgainstManifest", () => {
    const writeManifest = (manifest: DebugInstrumentationManifest) => {
      ensureDebugDir(tmpDir, CONV_ID);
      fs.writeFileSync(
        getDebugManifestPath(tmpDir, CONV_ID),
        JSON.stringify(manifest),
        "utf-8",
      );
    };

    const baseManifest: DebugInstrumentationManifest = {
      conversationId: CONV_ID,
      createdAt: "2025-01-01T00:00:00Z",
      probes: [
        {
          id: "H1:token",
          file: "src/lib/auth.ts",
          description: "token check",
        },
        {
          id: "H2:state",
          file: "src/app/api/route.ts",
          description: "state",
        },
      ],
    };

    const passingReport: CleanupReport = {
      removedInstrumentation: true,
      filesModified: ["src/lib/auth.ts", "src/app/api/route.ts"],
      grepVerificationPassed: true,
      acknowledgesManifestDeletionContract: true,
      notes: "ok",
    };

    it("returns ok=true when every condition holds and filesModified covers manifest probes", () => {
      writeManifest(baseManifest);
      const result = verifyCleanupAgainstManifest(
        tmpDir,
        CONV_ID,
        passingReport,
      );
      expect(result.ok).toBe(true);
      expect(result.failedConditions).toEqual([]);
      expect(result.missingFiles).toEqual([]);
      expect(result.remediationPrompt).toBeNull();
    });

    it("does not delete the manifest itself (caller is responsible)", () => {
      writeManifest(baseManifest);
      verifyCleanupAgainstManifest(tmpDir, CONV_ID, passingReport);
      expect(fs.existsSync(getDebugManifestPath(tmpDir, CONV_ID))).toBe(true);
    });

    it("fails when filesModified does not cover every probe file", () => {
      writeManifest(baseManifest);
      const result = verifyCleanupAgainstManifest(tmpDir, CONV_ID, {
        ...passingReport,
        filesModified: ["src/lib/auth.ts"],
      });
      expect(result.ok).toBe(false);
      expect(result.missingFiles).toEqual(["src/app/api/route.ts"]);
      expect(result.remediationPrompt).toContain("src/app/api/route.ts");
    });

    it("fails when removedInstrumentation is false", () => {
      writeManifest(baseManifest);
      const result = verifyCleanupAgainstManifest(tmpDir, CONV_ID, {
        ...passingReport,
        removedInstrumentation: false,
      });
      expect(result.ok).toBe(false);
      expect(result.failedConditions).toContain(
        "removedInstrumentation must be true",
      );
    });

    it("fails when grepVerificationPassed is false", () => {
      writeManifest(baseManifest);
      const result = verifyCleanupAgainstManifest(tmpDir, CONV_ID, {
        ...passingReport,
        grepVerificationPassed: false,
      });
      expect(result.ok).toBe(false);
      expect(result.failedConditions).toContain(
        "grepVerificationPassed must be true",
      );
    });

    it("fails when acknowledgesManifestDeletionContract is false", () => {
      writeManifest(baseManifest);
      const result = verifyCleanupAgainstManifest(tmpDir, CONV_ID, {
        ...passingReport,
        acknowledgesManifestDeletionContract: false,
      });
      expect(result.ok).toBe(false);
      expect(result.failedConditions).toContain(
        "acknowledgesManifestDeletionContract must be true",
      );
    });

    it("fails when the manifest file is missing", () => {
      const result = verifyCleanupAgainstManifest(
        tmpDir,
        CONV_ID,
        passingReport,
      );
      expect(result.ok).toBe(false);
      expect(result.failedConditions.join(" ")).toContain(
        "instrumentation manifest is missing",
      );
    });

    it("fails when the manifest is malformed", () => {
      ensureDebugDir(tmpDir, CONV_ID);
      fs.writeFileSync(
        getDebugManifestPath(tmpDir, CONV_ID),
        "not-json",
        "utf-8",
      );
      const result = verifyCleanupAgainstManifest(
        tmpDir,
        CONV_ID,
        passingReport,
      );
      expect(result.ok).toBe(false);
      expect(result.failedConditions.join(" ")).toContain("malformed");
    });
  });
});
