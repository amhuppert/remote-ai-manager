"use client";

import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  searchParamsToTokens,
  tokensToSearchParams,
  type FilterCategory,
  type FilterToken,
  type FilterState,
} from "./filter-tokens";

export interface UseSessionFiltersResult {
  tokens: FilterToken[];
  draft: string;
  setDraft: (draft: string) => void;
  setTokens: (next: FilterToken[]) => void;
  addToken: (token: FilterToken) => void;
  removeToken: (cat: FilterCategory) => void;
  clear: () => void;
}

export function useSessionFilters(): UseSessionFiltersResult {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const tokens = useMemo<FilterToken[]>(
    () => searchParamsToTokens(searchParams).tokens,
    [searchParams],
  );

  const [draft, setDraft] = useState("");

  const pushUrl = useCallback(
    (next: FilterToken[]) => {
      const state: FilterState = { tokens: next, draft: "" };
      const params = tokensToSearchParams(state);
      const query = params.toString();
      const url = query.length > 0 ? `${pathname}?${query}` : pathname;
      router.replace(url, { scroll: false });
    },
    [pathname, router],
  );

  const setTokens = useCallback(
    (next: FilterToken[]) => {
      pushUrl(next);
    },
    [pushUrl],
  );

  const addToken = useCallback(
    (token: FilterToken) => {
      const filtered = tokens.filter((t) => t.cat !== token.cat);
      pushUrl([...filtered, token]);
    },
    [tokens, pushUrl],
  );

  const removeToken = useCallback(
    (cat: FilterCategory) => {
      pushUrl(tokens.filter((t) => t.cat !== cat));
    },
    [tokens, pushUrl],
  );

  const clear = useCallback(() => {
    pushUrl([]);
  }, [pushUrl]);

  return { tokens, draft, setDraft, setTokens, addToken, removeToken, clear };
}
