import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReadTracer } from "./test-input-tracer";

let root: string;
let outside: string;

beforeAll(() => {
  const workdir = realpathSync(mkdtempSync(join(tmpdir(), "read-tracer-")));
  root = join(workdir, "repo");
  outside = join(workdir, "outside");
  for (const directory of [
    join(root, "src"),
    join(root, "scripts"),
    join(root, "node_modules", "pkg"),
    join(root, ".git"),
    outside,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "", "utf8");
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  writeFileSync(join(outside, "x.txt"), "outside\n", "utf8");
  const script = join(root, "scripts", "run.sh");
  writeFileSync(script, "#!/usr/bin/env bash\nexit 0\n", "utf8");
  chmodSync(script, 0o755);
});

afterAll(() => {
  if (root) rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("read tracer", () => {
  it("records file, directory, existence, and spawned-script reads under its root once each", async () => {
    const tracer = createReadTracer({ root });
    tracer.start();

    readFileSync(join(root, "src", "a.ts"), "utf8");
    readFileSync(join(root, "src", "a.ts"), "utf8");
    readdirSync(join(root, "src"));
    statSync(join(root, "src"));
    existsSync(join(root, "src", "missing.ts"));
    await readFile(join(root, "src", "a.ts"), "utf8");
    await readdir(root);
    readFileSync(join(root, "node_modules", "pkg", "index.js"), "utf8");
    readFileSync(join(root, ".git", "HEAD"), "utf8");
    readFileSync(join(outside, "x.txt"), "utf8");
    execFileSync("bash", [join(root, "scripts", "run.sh")], { stdio: "pipe" });

    const reads = tracer.stop();

    expect(reads).toEqual([
      { path: "", kind: "directory", via: "readdir" },
      { path: "scripts/run.sh", kind: "file", via: "spawn:bash" },
      { path: "src", kind: "directory", via: "readdirSync" },
      { path: "src/a.ts", kind: "file", via: "readFileSync" },
      { path: "src/missing.ts", kind: "file", via: "existsSync" },
    ]);
  });

  it("lets a content read outrank an earlier probe of the same file", () => {
    const tracer = createReadTracer({ root });
    tracer.start();
    statSync(join(root, "src", "a.ts"));
    existsSync(join(root, "src", "a.ts"));
    readFileSync(join(root, "src", "a.ts"), "utf8");
    statSync(join(root, "src", "a.ts"));

    expect(tracer.stop()).toEqual([
      { path: "src/a.ts", kind: "file", via: "readFileSync" },
    ]);
  });

  it("marks recursive listings and ignores write-only opens", () => {
    const tracer = createReadTracer({ root });
    tracer.start();
    readdirSync(root, { recursive: true });
    closeSync(openSync(join(root, "scratch.txt"), "w"));
    closeSync(openSync(join(root, "src", "a.ts"), "r"));

    expect(tracer.stop()).toEqual([
      { path: "", kind: "directory", via: "readdirSync", recursive: true },
      { path: "src/a.ts", kind: "file", via: "openSync" },
    ]);
    rmSync(join(root, "scratch.txt"), { force: true });
  });

  it("keeps promisified child_process results intact while tracing", async () => {
    const tracer = createReadTracer({ root });
    tracer.start();
    const result = await promisify(execFile)("bash", [
      join(root, "scripts", "run.sh"),
    ]);
    expect(result).toEqual({ stdout: "", stderr: "" });
    expect(tracer.stop()).toEqual([
      { path: "scripts/run.sh", kind: "file", via: "spawn:bash" },
    ]);
  });

  it("records nothing once stopped and starts each recording empty", () => {
    const tracer = createReadTracer({ root });
    tracer.start();
    readFileSync(join(root, "src", "a.ts"), "utf8");
    expect(tracer.stop()).toHaveLength(1);

    readFileSync(join(root, "src", "a.ts"), "utf8");
    tracer.start();
    expect(tracer.stop()).toEqual([]);
  });

  it("ignores node: specifiers probed through the filesystem API", () => {
    const tracer = createReadTracer({ root: process.cwd() });
    tracer.start();
    existsSync("node:internal/modules/cjs/loader");
    const reads = tracer.stop();

    expect(reads.filter((read) => read.path.includes("node:"))).toEqual([]);
  });

  it("keeps two tracers with different roots independent", () => {
    const repoTracer = createReadTracer({ root });
    const outsideTracer = createReadTracer({ root: outside });
    repoTracer.start();
    outsideTracer.start();

    readFileSync(join(root, "src", "a.ts"), "utf8");
    readFileSync(join(outside, "x.txt"), "utf8");

    expect(repoTracer.stop().map((read) => read.path)).toEqual(["src/a.ts"]);
    expect(outsideTracer.stop().map((read) => read.path)).toEqual(["x.txt"]);
  });
});
