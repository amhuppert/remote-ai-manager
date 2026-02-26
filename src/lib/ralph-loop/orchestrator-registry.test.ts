import { describe, it, expect, beforeEach } from "vitest";
import {
  register,
  get,
  remove,
  requestPause,
  requestAbort,
  _resetForTesting,
} from "./orchestrator-registry";

const PROJECT = "/home/user/my-project";
const SESSION = "feature-auth";

function makeEntry(overrides?: Partial<ReturnType<typeof get>>) {
  return {
    projectPath: PROJECT,
    sessionName: SESSION,
    abortController: new AbortController(),
    pauseRequested: false,
    ...overrides,
  };
}

describe("OrchestratorRegistry", () => {
  beforeEach(() => {
    _resetForTesting();
  });

  describe("register / get / remove", () => {
    it("returns undefined for unregistered workflows", () => {
      expect(get(PROJECT, SESSION)).toBeUndefined();
    });

    it("stores and retrieves a running workflow", () => {
      const entry = makeEntry();
      register(PROJECT, SESSION, entry);
      expect(get(PROJECT, SESSION)).toBe(entry);
    });

    it("uses composite key — different sessions are independent", () => {
      const entry1 = makeEntry();
      const entry2 = makeEntry({ sessionName: "other" });
      register(PROJECT, SESSION, entry1);
      register(PROJECT, "other", entry2);

      expect(get(PROJECT, SESSION)).toBe(entry1);
      expect(get(PROJECT, "other")).toBe(entry2);
    });

    it("removes a registered entry", () => {
      register(PROJECT, SESSION, makeEntry());
      remove(PROJECT, SESSION);
      expect(get(PROJECT, SESSION)).toBeUndefined();
    });

    it("remove is a no-op for unregistered entry", () => {
      expect(() => remove(PROJECT, SESSION)).not.toThrow();
    });

    it("overwrites existing entry on re-register", () => {
      const entry1 = makeEntry();
      const entry2 = makeEntry();
      register(PROJECT, SESSION, entry1);
      register(PROJECT, SESSION, entry2);
      expect(get(PROJECT, SESSION)).toBe(entry2);
    });
  });

  describe("requestPause", () => {
    it("sets pauseRequested flag on registered entry", () => {
      const entry = makeEntry();
      register(PROJECT, SESSION, entry);

      const result = requestPause(PROJECT, SESSION);
      expect(result).toBe(true);
      expect(entry.pauseRequested).toBe(true);
    });

    it("returns false for unregistered workflow", () => {
      expect(requestPause(PROJECT, SESSION)).toBe(false);
    });

    it("is idempotent — calling twice still returns true", () => {
      const entry = makeEntry();
      register(PROJECT, SESSION, entry);
      requestPause(PROJECT, SESSION);
      expect(requestPause(PROJECT, SESSION)).toBe(true);
      expect(entry.pauseRequested).toBe(true);
    });
  });

  describe("requestAbort", () => {
    it("calls abort on the entry AbortController", () => {
      const entry = makeEntry();
      register(PROJECT, SESSION, entry);

      expect(entry.abortController.signal.aborted).toBe(false);
      const result = requestAbort(PROJECT, SESSION);
      expect(result).toBe(true);
      expect(entry.abortController.signal.aborted).toBe(true);
    });

    it("returns false for unregistered workflow", () => {
      expect(requestAbort(PROJECT, SESSION)).toBe(false);
    });
  });

  describe("isolation between different projects", () => {
    it("same session name in different projects are separate", () => {
      const entry1 = makeEntry({ projectPath: "/project-a" });
      const entry2 = makeEntry({ projectPath: "/project-b" });
      register("/project-a", SESSION, entry1);
      register("/project-b", SESSION, entry2);

      expect(get("/project-a", SESSION)).toBe(entry1);
      expect(get("/project-b", SESSION)).toBe(entry2);

      requestPause("/project-a", SESSION);
      expect(entry1.pauseRequested).toBe(true);
      expect(entry2.pauseRequested).toBe(false);
    });
  });
});
