/**
 * The exact `@cursor/sdk` baseline this adapter runs against (spec D3).
 * Every value here is a pin, not a floor: preflight fails closed rather than
 * accepting a different SDK build or platform package. Nothing in the adapter
 * updates these values at runtime.
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

/** The SDK names native packages directly from Node's platform and architecture. */
export function cursorSdkPlatformPackageForHost(host: string): string {
  return `@cursor/sdk-${host}`;
}

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
const CURSOR_SDK_UNIX_EXECUTABLE_ASSETS = [
  "bin/rg",
  "bin/cursorsandbox",
  "vendor/tree-sitter/binding.node",
  "vendor/tree-sitter-bash/binding.node",
] as const;

const CURSOR_SDK_WINDOWS_EXECUTABLE_ASSETS = [
  "bin/rg.exe",
  "bin/cursorsandbox.exe",
  "vendor/tree-sitter/binding.node",
  "vendor/tree-sitter-bash/binding.node",
] as const;

export function cursorSdkExecutableAssetsForHost(
  host: string,
): readonly string[] {
  return host.startsWith("win32-")
    ? CURSOR_SDK_WINDOWS_EXECUTABLE_ASSETS
    : CURSOR_SDK_UNIX_EXECUTABLE_ASSETS;
}
