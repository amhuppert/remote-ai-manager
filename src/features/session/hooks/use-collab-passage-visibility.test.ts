// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useRef } from "react";
import { useCollabPassageVisibility } from "./use-collab-passage-visibility";

describe("useCollabPassageVisibility", () => {
  it("returns false when no collab row element is provided", () => {
    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement | null>(null);
      return useCollabPassageVisibility(null, ref);
    });
    expect(result.current).toBe(false);
  });

  it("returns false initially when a row element exists (IntersectionObserver async)", () => {
    const el = document.createElement("div");
    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement | null>(null);
      return useCollabPassageVisibility(el, ref);
    });
    expect(result.current).toBe(false);
  });
});
