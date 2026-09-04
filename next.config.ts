import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Each CC worktree has its own lockfile. Pinning the root prevents Next.js
  // from selecting the parent checkout when it discovers both lockfiles.
  turbopack: {
    root: process.cwd(),
  },
  // Session worktrees live inside the project root; without this exclude,
  // dynamic filesystem tracing walks the nested worktree tree.
  outputFileTracingExcludes: {
    "*": ["./.worktrees/**"],
  },
  experimental: {
    // Persist Turbopack's compile cache to disk so warm builds skip
    // recompiling unchanged modules (cache lives under .next/cache).
    turbopackFileSystemCacheForBuild: true,
    optimizePackageImports: [
      "@xyflow/react",
      "@tanstack/react-query",
      "@tanstack/react-table",
      "@tiptap/react",
      "@tiptap/starter-kit",
      "@tiptap/core",
      "@tiptap/extension-placeholder",
      "@tiptap/suggestion",
      "@react-hookz/web",
    ],
  },
  // Both agent SDKs must load from node_modules rather than through the
  // Turbopack server bundle. Turbopack's dead-code elimination drops the tail
  // of the Claude SDK's managed-settings loader (its final `return` compiles
  // to a `//TURBOPACK unreachable` marker), so `resolveSettings` resolves to
  // undefined inside the bundle and the native-memory launch guard refuses
  // every Claude launch.
  serverExternalPackages: [
    "@openai/codex-sdk",
    "@anthropic-ai/claude-agent-sdk",
  ],
};

export default nextConfig;
