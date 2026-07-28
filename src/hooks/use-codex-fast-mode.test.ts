// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCodexFastMode } from "./use-codex-fast-mode";

describe("useCodexFastMode", () => {
  it("seeds a new conversation from the global Codex default", () => {
    const { result } = renderHook(() =>
      useCodexFastMode({
        conversationId: "c1",
        promptCount: 0,
        defaultValue: true,
      }),
    );

    expect(result.current.codexFastMode).toBe(true);
  });

  it("uses the conversation's last selection instead of the global default", () => {
    const { result } = renderHook(() =>
      useCodexFastMode({
        conversationId: "c1",
        promptCount: 3,
        defaultValue: true,
        lastUsedValue: false,
      }),
    );

    expect(result.current.codexFastMode).toBe(false);
  });

  it("lets the conversation flip between Standard and Fast", () => {
    const { result } = renderHook(() =>
      useCodexFastMode({
        conversationId: "c1",
        promptCount: 0,
        defaultValue: false,
      }),
    );

    act(() => result.current.setCodexFastMode(true));
    expect(result.current.codexFastMode).toBe(true);
  });

  it("does not apply a changed global default to the current conversation", () => {
    const { result, rerender } = renderHook(
      ({ defaultValue }) =>
        useCodexFastMode({
          conversationId: "c1",
          promptCount: 0,
          defaultValue,
        }),
      { initialProps: { defaultValue: false } },
    );

    rerender({ defaultValue: true });
    expect(result.current.codexFastMode).toBe(false);
  });

  it("reinitializes when the active conversation changes", () => {
    const { result, rerender } = renderHook(
      ({
        conversationId,
        lastUsedValue,
      }: {
        conversationId: string;
        lastUsedValue?: boolean;
      }) =>
        useCodexFastMode({
          conversationId,
          promptCount: lastUsedValue === undefined ? 0 : 1,
          defaultValue: true,
          lastUsedValue,
        }),
      {
        initialProps: {
          conversationId: "c1",
          lastUsedValue: false as boolean | undefined,
        },
      },
    );

    rerender({ conversationId: "c2", lastUsedValue: undefined });
    expect(result.current.codexFastMode).toBe(true);
  });

  it("preserves the selected speed when a provisional conversation receives its id", () => {
    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string | null }) =>
        useCodexFastMode({
          conversationId,
          promptCount: 0,
          defaultValue: false,
        }),
      { initialProps: { conversationId: null as string | null } },
    );

    act(() => result.current.setCodexFastMode(true));
    rerender({ conversationId: "created-conversation" });

    expect(result.current.codexFastMode).toBe(true);
  });
});
