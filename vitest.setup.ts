/**
 * Shared Vitest setup for unit tests.
 *
 * Centralizes the logging mock so individual test files don't need to
 * duplicate vi.mock("./logging") / vi.mock("@/lib/logging") blocks.
 */
import { vi } from "vitest";

// vi.hoisted runs before vi.mock hoisting, so this factory is available.
const loggingFactory = vi.hoisted(() => {
  const stubLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return () => ({
    createLogger: () => stubLogger,
    withTracing: (handler: (...args: unknown[]) => unknown) => handler,
    runWithTrace: <T>(_ctx: unknown, fn: () => T) => fn(),
    getTraceContext: () => undefined,
  });
});

// Mock every import path variant that resolves to the logging module.
vi.mock("./logging", loggingFactory);
vi.mock("../logging", loggingFactory);
vi.mock("@/lib/logging", loggingFactory);
vi.mock("./logging/index", loggingFactory);
vi.mock("../logging/index", loggingFactory);
vi.mock("@/lib/logging/index", loggingFactory);
