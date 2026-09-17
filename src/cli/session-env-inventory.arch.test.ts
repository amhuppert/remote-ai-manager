// @vitest-inputs src/cli/**/*.ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nativeHelpNodes } from "../../scripts/cc-cli-skill-reference";
import {
  CLI_SESSION_ENV_INVENTORY,
  PROJECT_SUPPORTED_CLI_COMMANDS,
  SESSION_ONLY_CLI_COMMANDS,
  classifyCliCommand,
} from "./session-env-inventory";

const CLI_ROOT = path.join(process.cwd(), "src", "cli");

/**
 * Files that read the session env as CLI INFRASTRUCTURE rather than as a
 * command: the shared identity resolvers and the diagnostic/help paths that
 * report identity without routing by it. They are not commands, so they carry no
 * project-supported/session-only classification — but they are enumerated so a
 * NEW infrastructure reader has to be looked at rather than silently skipped.
 */
const INFRASTRUCTURE_READERS: Readonly<Record<string, string>> = {
  "transport.ts":
    "Owns environment identity parsing; commands use the typed context resolver.",
  "framework/context.ts":
    "Resolves typed server/project/session/conversation contexts.",
  "session-env-inventory.ts": "Declares the scope contract.",
};

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "testing") {
      files.push(...(await walk(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * The command a CLI source file belongs to: `commands/<name>.ts` → `<name>`,
 * `commands/<group>/<file>.ts` → `<group>`. Anything outside `commands/` is
 * infrastructure.
 */
function commandOf(relativePath: string): string | null {
  if (relativePath === "framework/doctor.handler.ts") return "doctor";
  if (relativePath === "framework/notify.handler.ts") return "notify";
  const segments = relativePath.split(path.sep);
  if (segments[1] === "alignment") return "charter";
  if (segments[0] !== "commands" || segments[1] === undefined) return null;
  return segments[1].replace(/\.ts$/, "").replace(/\.help$/, "");
}

/**
 * Reading the session env is usually INDIRECT — a command calls a resolver that
 * demands it. Scanning for the literal variable alone would miss almost every
 * command and let the inventory look complete while it was not, so the markers
 * cover the resolvers that require an env session as well as the direct reads.
 * `resolveCcProjectConversation` is deliberately absent: it is the
 * session-agnostic resolver, and a command that moves onto it stops being a
 * session-env reader.
 */
const SESSION_ENV_MARKERS = [
  "CC_SESSION",
  "readSessionEnv",
  "resolveCcSession",
  "resolveCcConversation",
  "resolveCcLane",
  "resolveCcConversationTarget",
  "resolveRunningInstance",
] as const;

async function sessionEnvReaders(): Promise<{
  commands: Set<string>;
  infrastructure: Set<string>;
}> {
  const commands = new Set<string>();
  const infrastructure = new Set<string>();
  for (const file of await walk(CLI_ROOT)) {
    const source = await readFile(file, "utf8");
    if (!SESSION_ENV_MARKERS.some((marker) => source.includes(marker)))
      continue;
    const relative = path.relative(CLI_ROOT, file);
    const command = commandOf(relative);
    if (command === null) infrastructure.add(relative);
    else {
      commands.add(command);
      if (command === "charter") commands.add("decisions");
    }
  }
  return { commands, infrastructure };
}

describe("cctl session-env inventory (R2.4)", () => {
  it("classifies every command that reads the session environment", async () => {
    const { commands } = await sessionEnvReaders();

    const unclassified = [...commands]
      .filter((command) => CLI_SESSION_ENV_INVENTORY[command] === undefined)
      .sort();
    expect(
      unclassified,
      "these cctl commands read CC_SESSION but are not classified in session-env-inventory.ts — decide project-supported or session-only before the change lands (R2.4)",
    ).toEqual([]);
  });

  it("has no stale inventory entries for commands that no longer read the session environment", async () => {
    const { commands } = await sessionEnvReaders();

    // Keys may be leaf paths ("spec start"); the file scan only resolves groups,
    // so staleness is judged on the owning group.
    const stale = Object.keys(CLI_SESSION_ENV_INVENTORY)
      .filter((command) => !commands.has(command.split(" ")[0] ?? command))
      .sort();
    expect(
      stale,
      "these inventory entries no longer correspond to a session-env reader — delete them so the table keeps describing reality",
    ).toEqual([]);
  });

  it("keys every inventory entry to a real command path in the help registry", () => {
    const realPaths = new Set(nativeHelpNodes().map((entry) => entry.path));

    const unknown = Object.keys(CLI_SESSION_ENV_INVENTORY)
      .filter((command) => !realPaths.has(command))
      .sort();
    expect(
      unknown,
      "these inventory keys do not name a cctl command — a typo would silently classify nothing",
    ).toEqual([]);
  });

  it("sees `doctor` as a command reader, not as core infrastructure", async () => {
    // `doctor` reads the session env and PUBLISHES the resolved identity to
    // /api/agent/handshake, so it is a session-env-reading command under R2.4.
    // While it lived in `core.ts` the file-level scan attributed it to the
    // infrastructure entry for that file, so the inventory could omit it and this
    // test still passed — the ratchet cannot classify a command it cannot see.
    const { commands } = await sessionEnvReaders();

    expect(
      commands.has("doctor"),
      "doctor must be scanned as a command, or an unclassified session-env command can hide inside a file classified as infrastructure",
    ).toBe(true);
    expect(classifyCliCommand("doctor")?.support).toBe("project-supported");
  });

  it("resolves a leaf entry over its group so a session-only verb is not swallowed", () => {
    expect(classifyCliCommand("spec start")?.support).toBe("session-only");
    expect(classifyCliCommand("spec draft")?.support).toBe("project-supported");
    // A nested read carries no entry of its own — it does not differ from its
    // group — so its classification has to come from the group at any depth.
    expect(classifyCliCommand("spec section get")?.support).toBe(
      "project-supported",
    );
    expect(classifyCliCommand("nonexistent")).toBeNull();
  });

  it("enumerates every infrastructure session-env reader with its role", async () => {
    const { infrastructure } = await sessionEnvReaders();

    const undocumented = [...infrastructure]
      .filter((file) => INFRASTRUCTURE_READERS[file] === undefined)
      .sort();
    expect(
      undocumented,
      "these CLI infrastructure files read CC_SESSION without a documented role — a new ambient session read is exactly the misrouting hazard the scope contract closes",
    ).toEqual([]);

    const staleInfrastructure = Object.keys(INFRASTRUCTURE_READERS)
      .filter((file) => !infrastructure.has(file))
      .sort();
    expect(staleInfrastructure).toEqual([]);
  });

  it("partitions the inventory — every entry is exactly one of the two classifications", () => {
    const all = Object.keys(CLI_SESSION_ENV_INVENTORY).sort();
    expect(
      [...PROJECT_SUPPORTED_CLI_COMMANDS, ...SESSION_ONLY_CLI_COMMANDS].sort(),
    ).toEqual(all);
    expect(PROJECT_SUPPORTED_CLI_COMMANDS.length).toBeGreaterThan(0);
    expect(SESSION_ONLY_CLI_COMMANDS.length).toBeGreaterThan(0);
  });

  it("gives every classification a substantive reason", () => {
    for (const [command, entry] of Object.entries(CLI_SESSION_ENV_INVENTORY)) {
      expect(
        entry.reason.length,
        `${command} needs a real reason`,
      ).toBeGreaterThan(40);
    }
  });
});
