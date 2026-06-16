import { describe, it, expect } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("joins plain string arguments with single spaces", () => {
    expect(cn("a", "b", "c")).toBe("a b c");
  });

  describe("conditional composition", () => {
    it("keeps classes whose condition is truthy", () => {
      const isActive = true;
      const isMuted = true;
      expect(cn("base", isActive && "bg-cyan", isMuted && "opacity-60")).toBe(
        "base bg-cyan opacity-60",
      );
    });

    it("drops classes whose condition is falsey", () => {
      const isActive = false;
      const isMuted = false;
      expect(cn("base", isActive && "bg-cyan", isMuted && "opacity-60")).toBe(
        "base",
      );
    });

    it("mixes truthy and falsey conditionals in order", () => {
      expect(cn("base", true && "kept", false && "dropped", "tail")).toBe(
        "base kept tail",
      );
    });
  });

  describe("array composition", () => {
    it("flattens a flat array of classes", () => {
      expect(cn(["a", "b"])).toBe("a b");
    });

    it("flattens nested arrays", () => {
      expect(cn(["a", ["b", ["c"]]], "d")).toBe("a b c d");
    });

    it("drops falsey entries inside arrays", () => {
      expect(cn(["a", null, undefined, false, "b"])).toBe("a b");
    });
  });

  describe("falsey composition", () => {
    it("returns an empty string when every input is falsey", () => {
      expect(cn(null, undefined, false, "", 0)).toBe("");
    });

    it("ignores interleaved falsey values among real classes", () => {
      expect(cn(null, "a", undefined, false, "b", "")).toBe("a b");
    });
  });
});
