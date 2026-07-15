// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import {
  useSidebarActiveListFilter,
  useSidebarGroupByPersistent,
  ACTIVE_LIST_FILTER_STORAGE_KEY,
  GROUP_BY_STORAGE_KEY,
} from "@/hooks/use-sidebar-persistent-filters";

describe("use-sidebar-persistent-filters", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  describe("useSidebarActiveListFilter", () => {
    it('defaults to "all" when sessionStorage is empty', () => {
      const { result } = renderHook(() => useSidebarActiveListFilter());
      const [value] = result.current;
      expect(value).toBe("all");
    });

    it("hydrates from sessionStorage on mount", () => {
      window.sessionStorage.setItem(
        ACTIVE_LIST_FILTER_STORAGE_KEY,
        JSON.stringify("needs"),
      );
      const { result } = renderHook(() => useSidebarActiveListFilter());
      const [value] = result.current;
      expect(value).toBe("needs");
    });

    it("persists value to sessionStorage when set is called", () => {
      const { result } = renderHook(() => useSidebarActiveListFilter());
      act(() => {
        const [, setValue] = result.current;
        setValue("running");
      });
      const [value] = result.current;
      expect(value).toBe("running");
      expect(
        window.sessionStorage.getItem(ACTIVE_LIST_FILTER_STORAGE_KEY),
      ).toBe(JSON.stringify("running"));
    });
  });

  describe("useSidebarGroupByPersistent", () => {
    it('defaults to "project" when sessionStorage is empty', () => {
      const { result } = renderHook(() => useSidebarGroupByPersistent());
      const [value] = result.current;
      expect(value).toBe("project");
    });

    it("hydrates from sessionStorage on mount", () => {
      window.sessionStorage.setItem(
        GROUP_BY_STORAGE_KEY,
        JSON.stringify("session"),
      );
      const { result } = renderHook(() => useSidebarGroupByPersistent());
      const [value] = result.current;
      expect(value).toBe("session");
    });

    it("persists value to sessionStorage when set is called", () => {
      const { result } = renderHook(() => useSidebarGroupByPersistent());
      act(() => {
        const [, setValue] = result.current;
        setValue("session");
      });
      const [value] = result.current;
      expect(value).toBe("session");
      expect(window.sessionStorage.getItem(GROUP_BY_STORAGE_KEY)).toBe(
        JSON.stringify("session"),
      );
    });
  });
});
