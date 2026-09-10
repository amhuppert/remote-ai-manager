// @vitest-inputs src/**/*.test.{ts,tsx,mjs} scripts/**/*.test.{ts,tsx,mjs}
// @vitest-inputs eslint-rules/**/*.test.{ts,tsx,mjs} CommandCenter.json
// @vitest-inputs scripts/validate/**
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { repoValidationConfigSchema } from "../src/lib/validation/schemas";
import vitestConfig from "../vitest.config";
import type { UserConfig } from "vitest/config";
import {
  CURSOR_ACCEPTANCE_BLOCKED_EXIT_CODE,
  formatCursorAcceptanceVerdict,
  resolveCursorAcceptanceGate,
} from "./validate/cursor-acceptance-gate.mjs";

/**
 * The credential gate on the authenticated Cursor acceptance suite (spec R14.2,
 * D19).
 *
 * The suite's whole value is that a green result means live evidence was
 * produced. An environment with no `CURSOR_API_KEY` can produce none, so the
 * only two honest outcomes are a real run or a refusal that no reader can
 * mistake for a pass — which is what these tests pin, at the decision function
 * and at the registered command a caller actually runs.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const WRAPPER = path.join(REPO_ROOT, "scripts/validate/cursor-acceptance.sh");

const SENTINEL_KEY = "key_live_acceptance_sentinel_9f2c41";

interface WrapperRun {
  status: number;
  output: string;
}

function readString(source: object, key: string): string {
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" ? value : "";
}

/** A non-zero exit arrives as a thrown error carrying the status and output. */
function describeExecFailure(error: unknown): WrapperRun {
  if (typeof error !== "object" || error === null) throw error;
  const status: unknown = Reflect.get(error, "status");
  return {
    status: typeof status === "number" ? status : -1,
    output: `${readString(error, "stdout")}${readString(error, "stderr")}`,
  };
}

/**
 * Runs the registered command with the credential removed, so it always takes
 * the blocked path regardless of the operator's environment.
 */
function runWrapperWithoutCredential(): WrapperRun {
  const env: NodeJS.ProcessEnv = { ...process.env, TARGET_BRANCH: "main" };
  delete env["CURSOR_API_KEY"];
  try {
    return {
      status: 0,
      output: execFileSync("bash", [WRAPPER], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env,
      }),
    };
  } catch (error) {
    return describeExecFailure(error);
  }
}

function readRegisteredValidation(): unknown {
  const config: unknown = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "CommandCenter.json"), "utf8"),
  );
  if (typeof config !== "object" || config === null) {
    throw new Error("CommandCenter.json does not parse to an object");
  }
  return Reflect.get(config, "validation");
}

describe("cursor acceptance credential gate", () => {
  it("blocks when CURSOR_API_KEY is absent", () => {
    expect(resolveCursorAcceptanceGate({})).toMatchObject({
      state: "blocked",
      reason: "credential_absent",
    });
  });

  it("blocks when CURSOR_API_KEY is present but empty", () => {
    expect(
      resolveCursorAcceptanceGate({ CURSOR_API_KEY: "   " }),
    ).toMatchObject({ state: "blocked", reason: "credential_absent" });
  });

  it("is ready when a credential is present", () => {
    expect(
      resolveCursorAcceptanceGate({ CURSOR_API_KEY: SENTINEL_KEY }),
    ).toEqual({ state: "ready" });
  });

  it("uses an exit code no reader can confuse with a pass or an ordinary failure", () => {
    expect(CURSOR_ACCEPTANCE_BLOCKED_EXIT_CODE).not.toBe(0);
    expect(CURSOR_ACCEPTANCE_BLOCKED_EXIT_CODE).not.toBe(1);
  });

  it("states the refusal, its cause, and that it is not a pass", () => {
    const verdict = formatCursorAcceptanceVerdict(
      resolveCursorAcceptanceGate({}),
    );
    expect(verdict).toContain("verdict=blocked");
    expect(verdict).toContain("CURSOR_API_KEY");
    expect(verdict.toLowerCase()).toContain("not a pass");
  });

  it("never echoes the credential in a ready verdict", () => {
    const verdict = formatCursorAcceptanceVerdict(
      resolveCursorAcceptanceGate({ CURSOR_API_KEY: SENTINEL_KEY }),
    );
    expect(verdict).not.toContain(SENTINEL_KEY);
    expect(verdict).toContain("verdict=ready");
  });
});

// The shipped config is a function (it loads the Storybook plugin only when
// that project is enabled), so it is resolved once the way Vite would.
let resolvedConfig: UserConfig;

beforeAll(async () => {
  resolvedConfig = await vitestConfig({ command: "serve", mode: "test" });
});

/**
 * Reads one project's `include` list out of the shipped Vitest config. Narrowed
 * at runtime rather than cast: the config is authored as a literal, and a cast
 * would keep asserting a shape a refactor had already changed.
 */
function includeFor(projectName: string): readonly string[] {
  const projects: unknown = resolvedConfig.test?.projects;
  if (!Array.isArray(projects)) {
    throw new Error("vitest.config.ts no longer declares test.projects");
  }
  for (const project of projects) {
    if (typeof project !== "object" || project === null) continue;
    const test: unknown = Reflect.get(project, "test");
    if (typeof test !== "object" || test === null) continue;
    if (Reflect.get(test, "name") !== projectName) continue;
    const include: unknown = Reflect.get(test, "include");
    if (!Array.isArray(include)) break;
    return include.filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  throw new Error(`vitest.config.ts declares no "${projectName}" project`);
}

describe("cursor acceptance test corpus", () => {
  it("collects the acceptance files into their own project", () => {
    const acceptance = includeFor("cursor-acceptance");
    expect(acceptance.length).toBeGreaterThan(0);
    expect(
      acceptance.every((file) => file.endsWith(".acceptance.test.ts")),
    ).toBe(true);
  });

  it("keeps acceptance files out of every unit project, which must not spend a credential", () => {
    for (const project of [
      "unit-pure",
      "unit-node",
      "unit-jsdom",
      "unit-architecture",
    ]) {
      expect(
        includeFor(project).filter((file) =>
          file.endsWith(".acceptance.test.ts"),
        ),
      ).toEqual([]);
    }
  });
});

describe("cursor acceptance registered command", () => {
  it("keeps the wrapper directly executable, registered or not", () => {
    // a1797d53 took the command out of CommandCenter.json (the checked-in
    // registry is pinned by repo-config.test.ts); the wrapper is invoked
    // directly until it is registered again. If it is, paths stay forbidden.
    const validation = repoValidationConfigSchema.parse(
      readRegisteredValidation(),
    );
    const command = validation.commands["cursor-acceptance"];
    if (command) {
      expect(command.pathArgs).toBe("forbid");
      expect(path.resolve(REPO_ROOT, command.command.full)).toBe(WRAPPER);
    }
    expect(() => accessSync(WRAPPER, constants.X_OK)).not.toThrow();
  });

  it("stays out of every merge gate, which cannot depend on a credential", () => {
    const validation = repoValidationConfigSchema.parse(
      readRegisteredValidation(),
    );
    expect(validation.preMerge).not.toContain("cursor-acceptance");
    expect(validation.laneMerge ?? []).not.toContain("cursor-acceptance");
  });

  it("refuses with the blocked verdict instead of passing when the credential is absent", () => {
    const run = runWrapperWithoutCredential();
    expect(run.status).toBe(CURSOR_ACCEPTANCE_BLOCKED_EXIT_CODE);
    expect(run.output).toContain("verdict=blocked");
    expect(run.output).toContain("CURSOR_API_KEY");
  });

  it("leaves the previous run's evidence alone when it refuses", () => {
    // A credentialed run clears the evidence tree so each set of records
    // describes one matrix. A BLOCKED run produced nothing, so it must not
    // replace what a real run left behind — which means the gate has to be
    // answered before the wrapper reaches that `rm -rf`.
    const evidenceRoot = path.join(REPO_ROOT, ".cc/temp/cursor-acceptance");
    const sentinel = path.join(evidenceRoot, "prior-run-sentinel.txt");
    mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
    writeFileSync(sentinel, "evidence from a credentialed run\n", {
      mode: 0o600,
    });

    try {
      expect(runWrapperWithoutCredential().status).toBe(
        CURSOR_ACCEPTANCE_BLOCKED_EXIT_CODE,
      );
      expect(
        existsSync(sentinel),
        "a blocked run destroyed the previous run's evidence",
      ).toBe(true);
    } finally {
      rmSync(sentinel, { force: true });
    }
  });
});
