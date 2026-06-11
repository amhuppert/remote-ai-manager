// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import {
  useSessionPageDisplay,
  type UseSessionPageDisplayArgs,
} from "./use-session-page-display";

function baseArgs(
  overrides: Partial<UseSessionPageDisplayArgs> = {},
): UseSessionPageDisplayArgs {
  return {
    projectName: "my-project",
    isFinished: false,
    pendingQuestions: null,
    sending: false,
    sessionStatus: "idle",
    ...overrides,
  };
}

describe("useSessionPageDisplay", () => {
  describe("decodedProjectName", () => {
    it("returns decoded URL-encoded project name", () => {
      const { result } = renderHook(() =>
        useSessionPageDisplay(baseArgs({ projectName: "my%20project%2Ffoo" })),
      );
      expect(result.current.decodedProjectName).toBe("my project/foo");
    });
  });

  describe("displayStatus priority", () => {
    it("returns 'merged' when isFinished, regardless of other flags", () => {
      const { result } = renderHook(() =>
        useSessionPageDisplay(
          baseArgs({
            isFinished: true,
            pendingQuestions: [{ id: "q" }],
            sending: true,
            sessionStatus: "running",
          }),
        ),
      );
      expect(result.current.displayStatus).toBe("merged");
    });

    it("returns 'waiting_for_input' when pendingQuestions truthy and not finished", () => {
      const { result } = renderHook(() =>
        useSessionPageDisplay(
          baseArgs({
            isFinished: false,
            pendingQuestions: [{ id: "q" }],
            sending: true,
            sessionStatus: "running",
          }),
        ),
      );
      expect(result.current.displayStatus).toBe("waiting_for_input");
    });

    it("returns 'running' when sending and no questions/not finished", () => {
      const { result } = renderHook(() =>
        useSessionPageDisplay(
          baseArgs({
            isFinished: false,
            pendingQuestions: null,
            sending: true,
            sessionStatus: "idle",
          }),
        ),
      );
      expect(result.current.displayStatus).toBe("running");
    });

    it("falls back to sessionStatus otherwise", () => {
      const { result } = renderHook(() =>
        useSessionPageDisplay(
          baseArgs({
            isFinished: false,
            pendingQuestions: null,
            sending: false,
            sessionStatus: "awaiting",
          }),
        ),
      );
      expect(result.current.displayStatus).toBe("awaiting");
    });
  });

  describe("statusDotClass", () => {
    it("is 'cyan' for running", () => {
      const { result } = renderHook(() =>
        useSessionPageDisplay(baseArgs({ sending: true })),
      );
      expect(result.current.statusDotClass).toBe("cyan");
    });

    it("is 'green' for merged", () => {
      const { result } = renderHook(() =>
        useSessionPageDisplay(baseArgs({ isFinished: true })),
      );
      expect(result.current.statusDotClass).toBe("green");
    });

    it("is 'amber' for waiting_for_input", () => {
      const { result } = renderHook(() =>
        useSessionPageDisplay(baseArgs({ pendingQuestions: [{ id: "q" }] })),
      );
      expect(result.current.statusDotClass).toBe("amber");
    });

    it("is empty string for any other status", () => {
      const { result } = renderHook(() =>
        useSessionPageDisplay(baseArgs({ sessionStatus: "idle" })),
      );
      expect(result.current.statusDotClass).toBe("");
    });
  });
});
