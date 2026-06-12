/**
 * Shared mock implementations and utilities for component tests.
 *
 * Usage in test files:
 *   import { renderWithQuery } from "@/test/component-mocks";
 *   vi.mock("next/link", async () => (await import("@/test/component-mocks")).nextLinkMock);
 */

import React from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Render utilities
// ---------------------------------------------------------------------------

/** Render a React element wrapped in a fresh QueryClientProvider (retry disabled). */
export function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Mock modules — use with vi.mock("module", async () => ...)
// ---------------------------------------------------------------------------

/** next/link — renders as a plain <a> tag, forwarding anchor attributes. */
export const nextLinkMock = {
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
};

/** next/navigation — stub router, pathname, searchParams. */
export const nextNavigationMock = {
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
};

/** @/hooks/useVoiceRecorder — disabled voice recorder. */
export const voiceRecorderMock = {
  useVoiceRecorder: vi.fn(() => ({
    isRecording: false,
    isProcessing: false,
    elapsedTime: 0,
    isAvailable: false,
    toggleRecording: vi.fn(),
    stopRecording: vi.fn(),
  })),
};

/** @/components/VoiceRecordButton — renders nothing. */
export const voiceRecordButtonMock = {
  VoiceRecordButton: () => null,
};

/** @/hooks/useAppHotkey — no-op hotkey hook. */
export const appHotkeyMock = {
  useAppHotkey: vi.fn(),
};
