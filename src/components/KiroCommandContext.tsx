"use client";

import { createContext, useContext } from "react";
import type { ClaudeModel } from "@/types";

export interface KiroCommandContextValue {
  projectName: string;
  sessionName: string;
  conversationId: string;
  sendPrompt: (
    text: string,
    currentMessageCount: number,
    modelId?: ClaudeModel,
  ) => Promise<void>;
  messageCount: number;
  isBusy: boolean;
  selectedModel: ClaudeModel | undefined;
}

const KiroCommandCtx = createContext<KiroCommandContextValue | null>(null);

export function KiroCommandProvider({
  children,
  ...value
}: KiroCommandContextValue & { children: React.ReactNode }) {
  return (
    <KiroCommandCtx.Provider value={value}>{children}</KiroCommandCtx.Provider>
  );
}

/** Returns null when used outside a KiroCommandProvider (graceful fallback). */
export function useKiroCommandContext(): KiroCommandContextValue | null {
  return useContext(KiroCommandCtx);
}
