import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
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
