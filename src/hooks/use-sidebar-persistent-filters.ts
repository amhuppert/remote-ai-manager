"use client";

import { useCallback } from "react";
import { useSessionStorageValue } from "@react-hookz/web";
import type {
  SidebarListFilter,
  SidebarGroupBy,
} from "@/components/session/sidebar/ConversationSidebar.helpers";

export const ACTIVE_LIST_FILTER_STORAGE_KEY =
  "cc-conversation-sidebar-active-list-filter";
export const GROUP_BY_STORAGE_KEY = "cc-conversation-sidebar-group-by";

const ACTIVE_LIST_FILTER_DEFAULT: SidebarListFilter = "all";
const GROUP_BY_DEFAULT: SidebarGroupBy = "project";

export function useSidebarActiveListFilter(): [
  SidebarListFilter,
  (value: SidebarListFilter) => void,
] {
  const { value, set } = useSessionStorageValue<SidebarListFilter>(
    ACTIVE_LIST_FILTER_STORAGE_KEY,
    {
      defaultValue: ACTIVE_LIST_FILTER_DEFAULT,
      initializeWithValue: false,
    },
  );
  const setValue = useCallback((next: SidebarListFilter) => set(next), [set]);
  return [value ?? ACTIVE_LIST_FILTER_DEFAULT, setValue];
}

export function useSidebarGroupByPersistent(): [
  SidebarGroupBy,
  (value: SidebarGroupBy) => void,
] {
  const { value, set } = useSessionStorageValue<SidebarGroupBy>(
    GROUP_BY_STORAGE_KEY,
    {
      defaultValue: GROUP_BY_DEFAULT,
      initializeWithValue: false,
    },
  );
  const setValue = useCallback((next: SidebarGroupBy) => set(next), [set]);
  return [value ?? GROUP_BY_DEFAULT, setValue];
}
