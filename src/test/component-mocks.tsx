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

/**
 * A QueryClient tuned for tests: retries disabled so an unmatched fetch surfaces
 * as an immediate query error rather than retry-storming, and background refetch
 * disabled so cache seeding stays deterministic. This is the injectable query
 * client half of the sanctioned client-test seam (plan D20): seed its cache
 * (`setQueryData`) or let it fetch through `@/test/fetch-fixture`, then pass it
 * to `renderWithQuery` — or share one instance across `hydrateRoot` and a render.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
}

/**
 * Render a React element wrapped in a QueryClientProvider. Pass a `queryClient`
 * to share one across renders or to pre-seed its cache; otherwise a fresh
 * test client is created per render.
 */
export function renderWithQuery(
  ui: React.ReactElement,
  queryClient: QueryClient = createTestQueryClient(),
) {
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
    cancelRecording: vi.fn(),
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
