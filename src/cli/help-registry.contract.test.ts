import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli, type CliHost } from "./core";
import {
  allHelpEntries,
  childEntriesOf,
  isGroup,
  renderHelpText,
  renderTopUsage,
} from "./help-registry";
import type { FlagSpec } from "./help-types";
import { pathKey } from "./help-types";

/**
 * A host that never reaches the network: the dispatch-agreement checks below
 * drive `runCli` only far enough to hit each group's `dispatchGroup` (which
 * throws when its handler map disagrees with the registry) and its usage-error
 * exit, never a real request.
 */
function offlineHost(): CliHost {
  return {
    fetch: async () => {
      throw new Error("no network in dispatch-agreement test");
    },
    readTextFile: async () => null,
    readFileBytes: async () => null,
    sleep: async () => {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

/**
 * The help-registry contract test (docs/design/cc-cli/04 §7.1) — the
 * drift-prevention backstop that replaces human vigilance over the
 * help/allowlist/skill sync (`.kiro/steering/cli.md`, "Single source of truth").
 * Every assertion here is the new "help is wrong" signal; each names the
 * offending entry and the invariant it broke so a failure is actionable without
 * reading this file.
 */

// Anchor on this test file's own location (src/cli/) rather than process.cwd(),
// so the on-disk skill-path check is correct regardless of the runner's cwd.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const ENTRIES = allHelpEntries();
const KEYS = new Set(ENTRIES.map((entry) => pathKey(entry.path)));

describe("help registry contract", () => {
  it("redirects retired evergreen plan authoring to the delivery-plan family", () => {
    for (const command of [
      "spec draft",
      "spec propose",
      "spec advance",
      "spec request-approval",
    ]) {
      const entry = ENTRIES.find(
        (candidate) => pathKey(candidate.path) === command,
      );
      expect(entry, `${command}: missing help entry`).toBeDefined();

      const guidance = `${entry?.description ?? ""} ${entry?.domainContext ?? ""}`;
      expect(guidance, `${command}: missing delivery-plan redirect`).toMatch(
        command === "spec request-approval"
          ? /spec plan sign-off/i
          : command === "spec propose"
            ? /spec plan propose/i
            : /spec plan (open|edit)/i,
      );
    }

    for (const command of ["spec", "spec plan"]) {
      const entry = ENTRIES.find(
        (candidate) => pathKey(candidate.path) === command,
      );
      expect(entry, `${command}: missing help entry`).toBeDefined();
      expect(entry?.usage).toContain(
        "cctl spec plan preview <slug> --stage draft|proposed",
      );
      expect(entry?.usage).not.toContain(
        "cctl spec plan preview <slug> [--scope <scope.json>]",
      );
    }
  });

  it("registers direct start inputs and keeps --file as a retired parser flag", () => {
    const entry = ENTRIES.find(
      (candidate) => pathKey(candidate.path) === "spec start",
    );
    expect(entry).toBeDefined();
    expect(entry?.usage).toEqual([
      "cctl spec start <slug> [--inputs .cc/temp/inputs.json] [--park]",
    ]);

    const inputsFlag = entry?.flags.find((flag) => flag.name === "inputs");
    expect(inputsFlag).toMatchObject({
      kind: "value",
      valuePlaceholder: "<inputs.json>",
    });
    expect(inputsFlag?.description).toMatch(/JSON object/i);

    const fileFlag = entry?.flags.find((flag) => flag.name === "file");
    expect(fileFlag?.description).toMatch(/retired/i);
    expect(fileFlag?.description).toContain(
      "Open an authored delivery attempt",
    );
  });

  it("keeps portable delivery help on the direct graph boundary", () => {
    const portableEntries = [
      "spec plan",
      "spec plan edit",
      "spec plan preview",
      "spec start",
    ].map((command) => {
      const entry = ENTRIES.find(
        (candidate) => pathKey(candidate.path) === command,
      );
      expect(entry, `${command}: missing help entry`).toBeDefined();
      return entry;
    });
    const text = portableEntries
      .map(
        (entry) =>
          `${entry?.summary} ${entry?.description} ${entry?.usage.join(" ")}`,
      )
      .join(" ");

    expect(text).toMatch(/ordinary graph launch/i);
    expect(text).toMatch(/candidate/i);
    expect(text).toContain("--inputs .cc/temp/inputs.json");
    expect(text).not.toMatch(
      /compiler|materializer|context pack|proofPlan|wiring/i,
    );

    // `spec task` retired with the task-completion path; the registry must
    // not describe a verb the CLI no longer dispatches.
    for (const command of ["spec task", "spec task complete"]) {
      expect(
        ENTRIES.find((candidate) => pathKey(candidate.path) === command),
      ).toBeUndefined();
    }
  });

  describe("every entry has non-empty summary/description/usage", () => {
    for (const entry of ENTRIES) {
      const key = pathKey(entry.path);
      it(`"${key}" has non-empty prose`, () => {
        expect(entry.summary.trim(), `${key}: empty summary`).not.toBe("");
        expect(entry.description.trim(), `${key}: empty description`).not.toBe(
          "",
        );
        expect(entry.usage.length, `${key}: no usage shapes`).toBeGreaterThan(
          0,
        );
        for (const shape of entry.usage) {
          expect(shape.trim(), `${key}: empty usage shape`).not.toBe("");
        }
      });
    }
  });

  describe("every leaf entry has >= 1 example", () => {
    for (const entry of ENTRIES) {
      if (isGroup(entry)) continue;
      const key = pathKey(entry.path);
      it(`leaf "${key}" teaches with an example`, () => {
        expect(
          entry.examples.length,
          `${key}: leaf node needs >= 1 example (doc 04 §7.1)`,
        ).toBeGreaterThan(0);
      });
    }
  });

  describe("every related.command resolves to a registry entry", () => {
    for (const entry of ENTRIES) {
      const key = pathKey(entry.path);
      for (const ref of entry.related) {
        it(`"${key}" -> related "${ref.command}" is not a dangling edge`, () => {
          expect(
            KEYS.has(ref.command),
            `${key}: related.command "${ref.command}" has no registry entry (dangling graph edge)`,
          ).toBe(true);
        });
      }
    }
  });

  describe("every skills[].path exists on disk", () => {
    for (const entry of ENTRIES) {
      const key = pathKey(entry.path);
      for (const skill of entry.skills ?? []) {
        it(`"${key}" -> skill "${skill.name}" path exists`, () => {
          const abs = path.resolve(REPO_ROOT, skill.path);
          expect(
            existsSync(abs),
            `${key}: skills path "${skill.path}" does not exist on disk (repo-relative)`,
          ).toBe(true);
        });
      }
    }
  });

  it("no single entry declares a flag name as both boolean and value", () => {
    // The parse-time boolean-flag set is COMMAND-SCOPED (parseArgv +
    // booleanFlagArgsForCommand, shared.ts / help-registry.ts): the authoritative
    // parse resolves the command path first, then uses THAT command's own boolean
    // flags. So a flag name may legitimately be `boolean` for one command and
    // `value` for another (e.g. `workflow get --config` boolean section selector
    // vs `workflow live get --config <ctx>` value, doc 06) — the cross-command
    // difference is intentional and sound because each command resolves to exactly
    // one entry (longest-prefix). What is NOT sound is a single entry declaring the
    // same flag name with two kinds, which would parse ambiguously for THAT
    // command; assert per-entry singularity.
    const conflicts: string[] = [];
    for (const entry of ENTRIES) {
      const kindsByFlag = new Map<string, Set<FlagSpec["kind"]>>();
      for (const flag of entry.flags) {
        const kinds = kindsByFlag.get(flag.name) ?? new Set();
        kinds.add(flag.kind);
        kindsByFlag.set(flag.name, kinds);
      }
      for (const [name, kinds] of kindsByFlag) {
        if (kinds.size > 1) {
          conflicts.push(
            `${pathKey(entry.path)}: --${name} declared as both boolean and value`,
          );
        }
      }
    }
    expect(conflicts, conflicts.join("; ")).toEqual([]);
  });

  it("resolves --config command-scoped: boolean for 'workflow get', value for 'workflow live get'", () => {
    // Pin the doc-06 collision the command-scoped parser exists to handle: the two
    // commands declare the same flag name with different kinds, and each command's
    // boolean set reflects its OWN declaration.
    const get = ENTRIES.find((e) => pathKey(e.path) === "workflow get");
    const liveGet = ENTRIES.find(
      (e) => pathKey(e.path) === "workflow live get",
    );
    expect(get?.flags.find((f) => f.name === "config")?.kind).toBe("boolean");
    expect(liveGet?.flags.find((f) => f.name === "config")?.kind).toBe("value");
  });

  it("declares --conversation on 'fixture prompt' (read with command-specific meaning)", () => {
    // fixture.ts:474 reads values["conversation"] as the explicit TARGET
    // fixture conversation id on the dev server — deliberately NOT the global
    // CC_CONVERSATION_ID fallback (which is the agent's own conversation on the
    // MANAGING server). Because the flag carries command-specific meaning here,
    // the "global flags are implied" convention does not cover it: the
    // registry-derived structured flag list must declare it, or the help/flag
    // source-of-truth is incomplete (2026-07-07 validation gap).
    const entry = ENTRIES.find((e) => pathKey(e.path) === "fixture prompt");
    expect(entry, "fixture prompt entry missing").toBeDefined();
    const conversation = entry?.flags.find((f) => f.name === "conversation");
    expect(
      conversation,
      "fixture prompt must declare the --conversation flag it reads (fixture.ts:474)",
    ).toBeDefined();
    expect(
      conversation?.kind,
      "fixture prompt --conversation takes a value",
    ).toBe("value");
  });

  describe("dispatch agrees with the registry (doc 04 §7.1 / decision D14)", () => {
    // The hand-maintained COVERAGE mirror is gone: `dispatchGroup` (src/cli/
    // dispatch.ts) derives each group's verbs from its registry children AND
    // throws when its handler map disagrees. Driving every registry group node
    // through `runCli` with an unknown verb exercises that construction — a
    // group whose handlers drift from the registry (a new verb wired into
    // dispatch without an entry, or an entry with no handler) throws here
    // instead of silently escaping. No network is touched: an unknown verb is a
    // local exit-2 usage failure before any request.
    const groupNodes = ENTRIES.filter((entry) => isGroup(entry));
    for (const group of groupNodes) {
      const key = pathKey(group.path);
      it(`group "${key}" dispatch matches its registry children`, async () => {
        const result = await runCli(
          [...group.path, "__unknown_verb__"],
          {},
          offlineHost(),
        );
        expect(
          result.exitCode,
          `dispatching "${key} __unknown_verb__" should be a clean exit-2 usage failure ` +
            "(a thrown error means the group's handler map disagrees with the registry)",
        ).toBe(2);
        expect(result.stderr).toContain(key);
      });
    }
  });

  describe("top usage and group indexes list their commands (doc 04 §7.1 rule 6)", () => {
    const topUsage = renderTopUsage();

    for (const entry of ENTRIES) {
      if (entry.path.length !== 1) continue;
      const key = pathKey(entry.path);
      it(`level-1 "${key}" appears in the generated top usage`, () => {
        expect(
          topUsage.includes(key),
          `top usage omits level-1 command "${key}"`,
        ).toBe(true);
      });
    }

    for (const entry of ENTRIES) {
      if (!isGroup(entry)) continue;
      const key = pathKey(entry.path);
      const rendered = renderHelpText(entry);
      for (const child of childEntriesOf(entry.path)) {
        const childKey = pathKey(child.path);
        it(`group "${key}" index lists child "${childKey}"`, () => {
          expect(
            rendered.includes(childKey),
            `group "${key}" index omits child "${childKey}"`,
          ).toBe(true);
        });
      }
    }
  });
});
