// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useSessionPageLocalState } from "./use-session-page-local-state";

describe("useSessionPageLocalState", () => {
  it("returns the expected shape with sensible defaults", () => {
    const { result } = renderHook(() => useSessionPageLocalState());

    expect(result.current.promptText).toBe("");
    expect(result.current.promptTextRef.current).toBe("");
    expect(result.current.inlineMarkerIds).toEqual([]);
    expect(result.current.collabPinnedTopTarget).toBeNull();
    expect(result.current.collabRowEl).toBeNull();

    expect(result.current.editorRef).toMatchObject({ current: null });
    expect(result.current.fireAndForgetRef).toMatchObject({ current: false });
    expect(result.current.fileInputRef).toMatchObject({ current: null });
    expect(result.current.panelBodyRef).toMatchObject({ current: null });
    expect(result.current.virtuosoRef).toMatchObject({ current: null });

    expect(typeof result.current.setPromptText).toBe("function");
    expect(typeof result.current.setInlineMarkerIds).toBe("function");
    expect(typeof result.current.setCollabPinnedTopTarget).toBe("function");
    expect(typeof result.current.setCollabRowEl).toBe("function");
  });

  it("uses initialPromptText for both state and ref", () => {
    const { result } = renderHook(() => useSessionPageLocalState("hello"));
    expect(result.current.promptText).toBe("hello");
    expect(result.current.promptTextRef.current).toBe("hello");
  });

  it("setPromptText updates both promptText state and promptTextRef.current", () => {
    const { result } = renderHook(() => useSessionPageLocalState());

    act(() => {
      result.current.setPromptText("foo");
    });

    expect(result.current.promptText).toBe("foo");
    expect(result.current.promptTextRef.current).toBe("foo");
  });

  it("setInlineMarkerIds replaces the state value", () => {
    const { result } = renderHook(() => useSessionPageLocalState());

    act(() => {
      result.current.setInlineMarkerIds(["m1", "m2"]);
    });
    expect(result.current.inlineMarkerIds).toEqual(["m1", "m2"]);

    act(() => {
      result.current.setInlineMarkerIds([]);
    });
    expect(result.current.inlineMarkerIds).toEqual([]);
  });

  it("setCollabPinnedTopTarget updates the value", () => {
    const { result } = renderHook(() => useSessionPageLocalState());
    const el = document.createElement("div");

    act(() => {
      result.current.setCollabPinnedTopTarget(el);
    });
    expect(result.current.collabPinnedTopTarget).toBe(el);

    act(() => {
      result.current.setCollabPinnedTopTarget(null);
    });
    expect(result.current.collabPinnedTopTarget).toBeNull();
  });

  it("setCollabRowEl updates the value", () => {
    const { result } = renderHook(() => useSessionPageLocalState());
    const el = document.createElement("div");

    act(() => {
      result.current.setCollabRowEl(el);
    });
    expect(result.current.collabRowEl).toBe(el);

    act(() => {
      result.current.setCollabRowEl(null);
    });
    expect(result.current.collabRowEl).toBeNull();
  });
});
