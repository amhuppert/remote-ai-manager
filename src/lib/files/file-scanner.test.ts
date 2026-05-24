import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

let scanProjectFiles: typeof import("./file-scanner").scanProjectFiles;

const DEFAULT_PATTERNS: string[] = [
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".nuxt",
  ".output",
  ".cache",
  ".vscode",
  ".idea",
  ".cursor",
  "coverage",
  ".nyc_output",
  "storybook-static",
  ".worktrees",
  "dist",
  "build",
  ".svelte-kit",
  ".parcel-cache",
  "**/.DS_Store",
  "**/Thumbs.db",
  ".eslintcache",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.ico",
  "**/*.svg",
  "**/*.webp",
  "**/*.mp4",
  "**/*.mp3",
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
  "**/*.eot",
  "**/*.zip",
  "**/*.tar",
  "**/*.gz",
  "**/*.pdf",
  "**/*.exe",
  "**/*.dll",
  "**/*.so",
  "**/*.dylib",
];

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("./file-scanner");
  scanProjectFiles = mod.scanProjectFiles;
});

describe("scanProjectFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "file-scanner-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns files with paths relative to project root", async () => {
    await writeFile(path.join(tempDir, "index.ts"), "");
    await mkdir(path.join(tempDir, "src"));
    await writeFile(path.join(tempDir, "src", "app.ts"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });
    const paths = result.items.map((f) => f.path).sort();

    expect(paths).toEqual(["index.ts", "src/app.ts"]);
    expect(result.truncated).toBe(false);
    expect(result.scannedCount).toBe(2);
  });

  it("returns empty result for empty directory", async () => {
    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.scannedCount).toBe(0);
  });

  it("excludes node_modules directory", async () => {
    await mkdir(path.join(tempDir, "node_modules", "some-pkg"), {
      recursive: true,
    });
    await writeFile(
      path.join(tempDir, "node_modules", "some-pkg", "index.js"),
      "",
    );
    await writeFile(path.join(tempDir, "package.json"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });

    expect(result.items.map((f) => f.path)).toEqual(["package.json"]);
  });

  it("excludes .git directory", async () => {
    await mkdir(path.join(tempDir, ".git", "objects"), { recursive: true });
    await writeFile(path.join(tempDir, ".git", "config"), "");
    await writeFile(path.join(tempDir, "README.md"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });

    expect(result.items.map((f) => f.path)).toEqual(["README.md"]);
  });

  it("excludes .next directory", async () => {
    await mkdir(path.join(tempDir, ".next", "cache"), { recursive: true });
    await writeFile(path.join(tempDir, ".next", "cache", "data.json"), "");
    await writeFile(path.join(tempDir, "next.config.ts"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });

    expect(result.items.map((f) => f.path)).toEqual(["next.config.ts"]);
  });

  it("excludes .vscode, .idea, .cursor directories", async () => {
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true });
    await writeFile(path.join(tempDir, ".vscode", "settings.json"), "");
    await mkdir(path.join(tempDir, ".idea"), { recursive: true });
    await writeFile(path.join(tempDir, ".idea", "workspace.xml"), "");
    await mkdir(path.join(tempDir, ".cursor"), { recursive: true });
    await writeFile(path.join(tempDir, ".cursor", "rules.json"), "");
    await writeFile(path.join(tempDir, "src.ts"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });

    expect(result.items.map((f) => f.path)).toEqual(["src.ts"]);
  });

  it("excludes coverage and .nyc_output directories", async () => {
    await mkdir(path.join(tempDir, "coverage"), { recursive: true });
    await writeFile(path.join(tempDir, "coverage", "lcov.info"), "");
    await mkdir(path.join(tempDir, ".nyc_output"), { recursive: true });
    await writeFile(path.join(tempDir, ".nyc_output", "data.json"), "");
    await writeFile(path.join(tempDir, "test.ts"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });

    expect(result.items.map((f) => f.path)).toEqual(["test.ts"]);
  });

  it("excludes storybook-static directory", async () => {
    await mkdir(path.join(tempDir, "storybook-static"), { recursive: true });
    await writeFile(path.join(tempDir, "storybook-static", "index.html"), "");
    await writeFile(path.join(tempDir, "Button.stories.tsx"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });

    expect(result.items.map((f) => f.path)).toEqual(["Button.stories.tsx"]);
  });

  it("excludes build artifact directories (dist, build, .turbo, .nuxt, .output)", async () => {
    for (const dir of ["dist", "build", ".turbo", ".nuxt", ".output"]) {
      await mkdir(path.join(tempDir, dir), { recursive: true });
      await writeFile(path.join(tempDir, dir, "output.js"), "");
    }
    await writeFile(path.join(tempDir, "index.ts"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });

    expect(result.items.map((f) => f.path)).toEqual(["index.ts"]);
  });

  it("excludes .worktrees and .cache directories", async () => {
    await mkdir(path.join(tempDir, ".worktrees", "session-1"), {
      recursive: true,
    });
    await writeFile(
      path.join(tempDir, ".worktrees", "session-1", "file.ts"),
      "",
    );
    await mkdir(path.join(tempDir, ".cache"), { recursive: true });
    await writeFile(path.join(tempDir, ".cache", "data.bin"), "");
    await writeFile(path.join(tempDir, "app.ts"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });

    expect(result.items.map((f) => f.path)).toEqual(["app.ts"]);
  });

  it("excludes OS files (.DS_Store, Thumbs.db)", async () => {
    await writeFile(path.join(tempDir, ".DS_Store"), "");
    await writeFile(path.join(tempDir, "Thumbs.db"), "");
    await writeFile(path.join(tempDir, "app.ts"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });

    expect(result.items.map((f) => f.path)).toEqual(["app.ts"]);
  });

  it("excludes lock files", async () => {
    await writeFile(path.join(tempDir, "pnpm-lock.yaml"), "");
    await writeFile(path.join(tempDir, "yarn.lock"), "");
    await writeFile(path.join(tempDir, "package-lock.json"), "");
    await writeFile(path.join(tempDir, "bun.lockb"), "");
    await writeFile(path.join(tempDir, "package.json"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });

    expect(result.items.map((f) => f.path)).toEqual(["package.json"]);
  });

  it("excludes .eslintcache", async () => {
    await writeFile(path.join(tempDir, ".eslintcache"), "");
    await writeFile(path.join(tempDir, ".eslintrc.json"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });

    expect(result.items.map((f) => f.path)).toEqual([".eslintrc.json"]);
  });

  it("excludes binary/media files by extension", async () => {
    for (const ext of [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".ico",
      ".svg",
      ".webp",
      ".mp4",
      ".mp3",
      ".woff",
      ".woff2",
      ".ttf",
      ".eot",
      ".zip",
      ".tar",
      ".gz",
      ".pdf",
      ".exe",
      ".dll",
      ".so",
      ".dylib",
    ]) {
      await writeFile(path.join(tempDir, `file${ext}`), "");
    }
    await writeFile(path.join(tempDir, "index.ts"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });

    expect(result.items.map((f) => f.path)).toEqual(["index.ts"]);
  });

  it("scans nested directories recursively", async () => {
    await mkdir(path.join(tempDir, "src", "components", "ui"), {
      recursive: true,
    });
    await writeFile(path.join(tempDir, "src", "index.ts"), "");
    await writeFile(path.join(tempDir, "src", "components", "Button.tsx"), "");
    await writeFile(
      path.join(tempDir, "src", "components", "ui", "Input.tsx"),
      "",
    );

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });
    const paths = result.items.map((f) => f.path).sort();

    expect(paths).toEqual([
      "src/components/Button.tsx",
      "src/components/ui/Input.tsx",
      "src/index.ts",
    ]);
  });

  it("excludes nested node_modules (e.g., inside a monorepo package)", async () => {
    await mkdir(path.join(tempDir, "packages", "ui", "node_modules", "react"), {
      recursive: true,
    });
    await writeFile(
      path.join(tempDir, "packages", "ui", "node_modules", "react", "index.js"),
      "",
    );
    await writeFile(path.join(tempDir, "packages", "ui", "index.ts"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: DEFAULT_PATTERNS,
    });

    expect(result.items.map((f) => f.path)).toEqual(["packages/ui/index.ts"]);
  });

  // --- New: configured ignore patterns ---

  it("includes files when ignorePatterns is empty", async () => {
    await mkdir(path.join(tempDir, "node_modules"));
    await writeFile(path.join(tempDir, "node_modules", "foo.js"), "");
    await writeFile(path.join(tempDir, "index.ts"), "");

    const result = await scanProjectFiles(tempDir, { ignorePatterns: [] });
    const paths = result.items.map((f) => f.path).sort();

    expect(paths).toEqual(["index.ts", "node_modules/foo.js"]);
  });

  it("respects custom glob ignorePatterns (apps/*/generated/**)", async () => {
    await mkdir(path.join(tempDir, "apps", "web", "generated"), {
      recursive: true,
    });
    await writeFile(
      path.join(tempDir, "apps", "web", "generated", "code.ts"),
      "",
    );
    await writeFile(path.join(tempDir, "apps", "web", "index.ts"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: ["apps/*/generated"],
    });

    expect(result.items.map((f) => f.path)).toEqual(["apps/web/index.ts"]);
  });

  it("respects extension-style glob patterns (**/*.snap)", async () => {
    await mkdir(path.join(tempDir, "src", "__snapshots__"), {
      recursive: true,
    });
    await writeFile(
      path.join(tempDir, "src", "__snapshots__", "foo.test.ts.snap"),
      "",
    );
    await writeFile(path.join(tempDir, "src", "foo.test.ts"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: ["**/*.snap"],
    });
    const paths = result.items.map((f) => f.path).sort();

    expect(paths).toEqual(["src/foo.test.ts"]);
  });

  it("includes git-ignored-style files when not in ignorePatterns", async () => {
    // A file commonly listed in .gitignore but not in our patterns must still appear
    await writeFile(path.join(tempDir, ".env.local"), "");
    await writeFile(path.join(tempDir, "app.ts"), "");

    const result = await scanProjectFiles(tempDir, { ignorePatterns: [] });
    const paths = result.items.map((f) => f.path).sort();

    expect(paths).toEqual([".env.local", "app.ts"]);
  });

  // --- New: resilient walk ---

  it("does not throw when a subdirectory is unreadable; skips it and continues", async () => {
    await mkdir(path.join(tempDir, "readable"));
    await writeFile(path.join(tempDir, "readable", "ok.ts"), "");
    await mkdir(path.join(tempDir, "locked"));
    await writeFile(path.join(tempDir, "locked", "secret.ts"), "");

    // Strip read+execute permissions so readdir on this dir fails (EACCES)
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await chmod(path.join(tempDir, "locked"), 0o000);
      try {
        const result = await scanProjectFiles(tempDir, {
          ignorePatterns: [],
        });
        const paths = result.items.map((f) => f.path);

        expect(paths).toContain("readable/ok.ts");
        expect(paths).not.toContain("locked/secret.ts");
      } finally {
        await chmod(path.join(tempDir, "locked"), 0o755);
      }
    }
  });

  // --- New: symlink skip ---

  it("does not follow symlinked directories", async () => {
    await mkdir(path.join(tempDir, "real"));
    await writeFile(path.join(tempDir, "real", "inside.ts"), "");
    await symlink(
      path.join(tempDir, "real"),
      path.join(tempDir, "link"),
      "dir",
    );

    const result = await scanProjectFiles(tempDir, { ignorePatterns: [] });
    const paths = result.items.map((f) => f.path).sort();

    // The real directory's contents are included; the symlinked alias is NOT recursed
    expect(paths).toContain("real/inside.ts");
    expect(paths).not.toContain("link/inside.ts");
  });

  // --- New: truncation cap ---

  it("sets truncated=true and stops at maxResults", async () => {
    for (let i = 0; i < 10; i++) {
      await writeFile(path.join(tempDir, `file-${i}.ts`), "");
    }

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: [],
      maxResults: 3,
    });

    expect(result.items.length).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("returns truncated=false when items fit under maxResults", async () => {
    await writeFile(path.join(tempDir, "a.ts"), "");
    await writeFile(path.join(tempDir, "b.ts"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: [],
      maxResults: 50,
    });

    expect(result.items.length).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("scannedCount counts files inspected, not just files returned", async () => {
    await writeFile(path.join(tempDir, "a.ts"), "");
    await writeFile(path.join(tempDir, "b.png"), "");
    await writeFile(path.join(tempDir, "c.ts"), "");

    const result = await scanProjectFiles(tempDir, {
      ignorePatterns: ["**/*.png"],
    });

    expect(result.items.length).toBe(2);
    expect(result.scannedCount).toBe(3);
  });
});
