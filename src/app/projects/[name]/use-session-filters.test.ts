// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSessionFilters } from "./use-session-filters";
import type { FilterToken } from "./filter-tokens";

const replaceMock = vi.fn();
let currentSearch = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  usePathname: () => "/projects/my-project",
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

function setSearch(query: string): void {
  currentSearch = query;
}

beforeEach(() => {
  replaceMock.mockReset();
  currentSearch = "";
});

describe("useSessionFilters", () => {
  it("starts with empty tokens + empty draft when URL has no params", () => {
    const { result } = renderHook(() => useSessionFilters());
    expect(result.current.tokens).toEqual([]);
    expect(result.current.draft).toBe("");
  });

  it("reads tokens from the URL", () => {
    setSearch("status=running&target=main");
    const { result } = renderHook(() => useSessionFilters());
    expect(result.current.tokens).toEqual(
      expect.arrayContaining([
        { cat: "status", key: "is", value: "running" },
        { cat: "target", key: "target", value: "main" },
      ]),
    );
    expect(result.current.tokens).toHaveLength(2);
  });

  it("addToken replaces an existing same-category token", () => {
    setSearch("status=running");
    const { result } = renderHook(() => useSessionFilters());

    act(() => {
      result.current.addToken({
        cat: "status",
        key: "is",
        value: "awaiting",
      });
    });

    expect(replaceMock).toHaveBeenCalledTimes(1);
    const call = replaceMock.mock.calls[0]![0] as string;
    expect(call).toMatch(/status=awaiting/);
    expect(call).not.toMatch(/status=running/);
  });

  it("addToken appends a new category", () => {
    setSearch("status=running");
    const { result } = renderHook(() => useSessionFilters());

    act(() => {
      result.current.addToken({
        cat: "target",
        key: "target",
        value: "develop",
      });
    });

    const call = replaceMock.mock.calls[0]![0] as string;
    expect(call).toMatch(/status=running/);
    expect(call).toMatch(/target=develop/);
  });

  it("removeToken drops the named category", () => {
    setSearch("status=running&target=main");
    const { result } = renderHook(() => useSessionFilters());

    act(() => {
      result.current.removeToken("status");
    });

    const call = replaceMock.mock.calls[0]![0] as string;
    expect(call).not.toMatch(/status=/);
    expect(call).toMatch(/target=main/);
  });

  it("clear removes all tokens", () => {
    setSearch("status=running&target=main&archived=include");
    const { result } = renderHook(() => useSessionFilters());

    act(() => {
      result.current.clear();
    });

    const call = replaceMock.mock.calls[0]![0] as string;
    expect(call).toBe("/projects/my-project");
  });

  it("setTokens overwrites the token list", () => {
    setSearch("status=running");
    const { result } = renderHook(() => useSessionFilters());

    const next: FilterToken[] = [
      { cat: "archived", key: "only", value: "only", exclusive: true },
    ];
    act(() => {
      result.current.setTokens(next);
    });

    const call = replaceMock.mock.calls[0]![0] as string;
    expect(call).not.toMatch(/status=/);
    expect(call).toMatch(/archived=only/);
  });

  it("setDraft updates the local draft without touching URL", () => {
    const { result } = renderHook(() => useSessionFilters());
    act(() => {
      result.current.setDraft("hello");
    });
    expect(result.current.draft).toBe("hello");
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("uses pathname as base when no params remain", () => {
    setSearch("status=running");
    const { result } = renderHook(() => useSessionFilters());
    act(() => {
      result.current.removeToken("status");
    });
    expect(replaceMock).toHaveBeenCalledWith(
      "/projects/my-project",
      expect.objectContaining({ scroll: false }),
    );
  });
});
