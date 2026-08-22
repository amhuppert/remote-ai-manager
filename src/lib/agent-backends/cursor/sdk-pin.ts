/**
 * The exact `@cursor/sdk` baseline this adapter is evidenced against (spec D3).
 * Every value here is a pin, not a floor: preflight fails closed rather than
 * accepting a different SDK build, platform package, or host combination,
 * because capability claims (cancellation teardown, MCP, image input) rest on
 * fixtures captured against this exact build. Nothing in the adapter updates
 * these values at runtime.
 */

export const CURSOR_SDK_PACKAGE = "@cursor/sdk";

/** Kept byte-identical to the exact `package.json` pin; asserted by contract test. */
export const CURSOR_SDK_PINNED_VERSION = "1.0.28";

/**
 * Node floor the SDK's own `engines` field declares. It applies to the worker
 * process only — the Command Center server keeps its lower project floor, so
 * preflight checks the version that will actually run the SDK.
 */
export const CURSOR_SDK_MIN_NODE_MAJOR = 22;
export const CURSOR_SDK_MIN_NODE_MINOR = 13;

/**
 * The single tested host combination. An untested platform/arch has no
 * captured evidence and no installed platform package, so preflight names the
 * mismatch instead of guessing a platform package id.
 */
export const CURSOR_SDK_TESTED_PLATFORM = "linux";
export const CURSOR_SDK_TESTED_ARCH = "x64";
export const CURSOR_SDK_PLATFORM_PACKAGE = "@cursor/sdk-linux-x64";

/** Normal Node entry points the SDK's `exports` map resolves for require/import. */
export const CURSOR_SDK_ENTRY_FILES = [
  "dist/esm/index.js",
  "dist/cjs/index.js",
] as const;

/**
 * The SDK entry lazily requires numbered webpack chunks from its own dist
 * directory; a partial extract that kept only the entry would fail at first
 * use rather than at load, so preflight counts them.
 */
export const CURSOR_SDK_LAZY_CHUNK_DIR = "dist/esm";
export const CURSOR_SDK_LAZY_CHUNK_PATTERN = /^\d+\.js$/;
export const CURSOR_SDK_MIN_LAZY_CHUNKS = 21;

/** Runtime dependencies the SDK declares and resolves at load time. */
export const CURSOR_SDK_DECLARED_DEPENDENCIES = [
  "@bufbuild/protobuf",
  "@connectrpc/connect",
  "@connectrpc/connect-node",
  "@connectrpc/connect-web",
  "@statsig/js-client",
  "zod",
] as const;

/**
 * Platform-package assets the SDK executes as separate processes (ripgrep,
 * the sandbox helper) or dlopens (tree-sitter bindings). They must be present
 * and carry the owner-execute bit; an extract that dropped the mode leaves the
 * SDK failing mid-turn.
 */
export const CURSOR_SDK_EXECUTABLE_ASSETS = [
  "bin/rg",
  "bin/cursorsandbox",
  "vendor/tree-sitter/binding.node",
  "vendor/tree-sitter-bash/binding.node",
] as const;
