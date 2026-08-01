import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Session worktrees live inside the project root; without this exclude,
  // Turbopack's output tracing matches ~360k files under .worktrees/ via the
  // dynamic path.join/existsSync patterns in sessions/workflow-graph/logging.
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
  serverExternalPackages: ["@openai/codex-sdk"],
};

export default nextConfig;
