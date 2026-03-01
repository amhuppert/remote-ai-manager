import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

// Import after creating files so we test the real implementation
let scanProjectFiles: typeof import("./file-scanner").scanProjectFiles;

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

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path).sort();

    expect(paths).toEqual(["index.ts", "src/app.ts"]);
  });

  it("returns empty array for empty directory", async () => {
    const result = await scanProjectFiles(tempDir);
    expect(result).toEqual([]);
  });

  // --- Directory exclusions ---

  it("excludes node_modules directory", async () => {
    await mkdir(path.join(tempDir, "node_modules", "some-pkg"), {
      recursive: true,
    });
    await writeFile(
      path.join(tempDir, "node_modules", "some-pkg", "index.js"),
      "",
    );
    await writeFile(path.join(tempDir, "package.json"), "");

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path);

    expect(paths).toEqual(["package.json"]);
  });

  it("excludes .git directory", async () => {
    await mkdir(path.join(tempDir, ".git", "objects"), { recursive: true });
    await writeFile(path.join(tempDir, ".git", "config"), "");
    await writeFile(path.join(tempDir, "README.md"), "");

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path);

    expect(paths).toEqual(["README.md"]);
  });

  it("excludes .next directory", async () => {
    await mkdir(path.join(tempDir, ".next", "cache"), { recursive: true });
    await writeFile(path.join(tempDir, ".next", "cache", "data.json"), "");
    await writeFile(path.join(tempDir, "next.config.ts"), "");

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path);

    expect(paths).toEqual(["next.config.ts"]);
  });

  it("excludes .vscode, .idea, .cursor directories", async () => {
    await mkdir(path.join(tempDir, ".vscode"), { recursive: true });
    await writeFile(path.join(tempDir, ".vscode", "settings.json"), "");
    await mkdir(path.join(tempDir, ".idea"), { recursive: true });
    await writeFile(path.join(tempDir, ".idea", "workspace.xml"), "");
    await mkdir(path.join(tempDir, ".cursor"), { recursive: true });
    await writeFile(path.join(tempDir, ".cursor", "rules.json"), "");
    await writeFile(path.join(tempDir, "src.ts"), "");

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path);

    expect(paths).toEqual(["src.ts"]);
  });

  it("excludes coverage and .nyc_output directories", async () => {
    await mkdir(path.join(tempDir, "coverage"), { recursive: true });
    await writeFile(path.join(tempDir, "coverage", "lcov.info"), "");
    await mkdir(path.join(tempDir, ".nyc_output"), { recursive: true });
    await writeFile(path.join(tempDir, ".nyc_output", "data.json"), "");
    await writeFile(path.join(tempDir, "test.ts"), "");

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path);

    expect(paths).toEqual(["test.ts"]);
  });

  it("excludes storybook-static directory", async () => {
    await mkdir(path.join(tempDir, "storybook-static"), { recursive: true });
    await writeFile(path.join(tempDir, "storybook-static", "index.html"), "");
    await writeFile(path.join(tempDir, "Button.stories.tsx"), "");

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path);

    expect(paths).toEqual(["Button.stories.tsx"]);
  });

  it("excludes build artifact directories (dist, build, .turbo, .nuxt, .output)", async () => {
    for (const dir of ["dist", "build", ".turbo", ".nuxt", ".output"]) {
      await mkdir(path.join(tempDir, dir), { recursive: true });
      await writeFile(path.join(tempDir, dir, "output.js"), "");
    }
    await writeFile(path.join(tempDir, "index.ts"), "");

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path);

    expect(paths).toEqual(["index.ts"]);
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

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path);

    expect(paths).toEqual(["app.ts"]);
  });

  // --- File exclusions ---

  it("excludes OS files (.DS_Store, Thumbs.db)", async () => {
    await writeFile(path.join(tempDir, ".DS_Store"), "");
    await writeFile(path.join(tempDir, "Thumbs.db"), "");
    await writeFile(path.join(tempDir, "app.ts"), "");

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path);

    expect(paths).toEqual(["app.ts"]);
  });

  it("excludes lock files", async () => {
    await writeFile(path.join(tempDir, "pnpm-lock.yaml"), "");
    await writeFile(path.join(tempDir, "yarn.lock"), "");
    await writeFile(path.join(tempDir, "package-lock.json"), "");
    await writeFile(path.join(tempDir, "bun.lockb"), "");
    await writeFile(path.join(tempDir, "package.json"), "");

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path);

    expect(paths).toEqual(["package.json"]);
  });

  it("excludes .eslintcache", async () => {
    await writeFile(path.join(tempDir, ".eslintcache"), "");
    await writeFile(path.join(tempDir, ".eslintrc.json"), "");

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path);

    expect(paths).toEqual([".eslintrc.json"]);
  });

  // --- Binary extension exclusions ---

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

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path);

    expect(paths).toEqual(["index.ts"]);
  });

  // --- Nested structure ---

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

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path).sort();

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

    const result = await scanProjectFiles(tempDir);
    const paths = result.map((f) => f.path);

    expect(paths).toEqual(["packages/ui/index.ts"]);
  });
});
