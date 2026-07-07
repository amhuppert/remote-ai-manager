// Generates src/lib/build-info/build-info.generated.ts (gitignored) with the
// current git SHA + build time. Runs from postinstall, `bun run dev`, and
// `bun run build` so the module always exists before tsc/vitest/next touch it.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { renderBuildInfoModule } from "../src/lib/build-info/stamp";

function resolveGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "nogit";
  }
}

function resolveGitMessage(): string {
  try {
    const message = execSync("git log -1 --pretty=%B", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return message.length > 0 ? message : "nogit";
  } catch {
    return "nogit";
  }
}

const outDir = path.join(__dirname, "..", "src", "lib", "build-info");
const outFile = path.join(outDir, "build-info.generated.ts");
const info = {
  sha: resolveGitSha(),
  buildTime: new Date().toISOString(),
  message: resolveGitMessage(),
};

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, renderBuildInfoModule(info), "utf-8");
console.log(`build-info: ${info.sha}-${info.buildTime} -> ${outFile}`);
