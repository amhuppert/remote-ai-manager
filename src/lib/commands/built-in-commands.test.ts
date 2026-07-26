import { describe, it, expect } from "vitest";
import {
  BUILT_IN_COMMANDS,
  filterCommandsForScope,
} from "./built-in-commands";
import type { CommandItem } from "./schemas";

const SESSION = { scope: "session", sessionName: "sess" } as const;
const PROJECT = { scope: "project" } as const;

function discovered(name: string): CommandItem {
  return {
    name,
    description: `A command file named ${name.slice(1)}`,
    type: "command",
    source: "project",
  };
}

function names(args: {
  scope: typeof SESSION | typeof PROJECT;
  items?: readonly CommandItem[];
  isWorkflowManagedConversation?: boolean;
}): string[] {
  return filterCommandsForScope(args.items ?? BUILT_IN_COMMANDS, {
    scope: args.scope,
    isWorkflowManagedConversation:
      args.isWorkflowManagedConversation ?? false,
  }).map((item) => item.name);
}

describe("filterCommandsForScope", () => {
  it("offers every built-in in a session conversation", () => {
    expect(names({ scope: SESSION })).toEqual([
      "/spec",
      "/collab",
      "/commit",
      "/merge",
      "/rebase",
      "/align",
      "/ticket",
    ]);
  });

  it("offers the project-scope built-ins, including /ticket", () => {
    expect(names({ scope: PROJECT })).toEqual(["/spec", "/ticket"]);
  });

  it("withholds session git and alignment commands at project scope", () => {
    const offered = names({ scope: PROJECT });
    for (const sessionOnly of [
      "/commit",
      "/merge",
      "/rebase",
      "/align",
      "/collab",
    ]) {
      expect(offered).not.toContain(sessionOnly);
    }
  });

  // Project-root discovery can return a command file that reuses a name CC
  // intercepts; arriving from discovery does not make it executable.
  it("withholds a discovered command that reuses a session-only name", () => {
    expect(
      names({
        scope: PROJECT,
        items: [
          discovered("/commit"),
          discovered("/align"),
          discovered("/collab"),
          discovered("/deploy"),
        ],
      }),
    ).toEqual(["/deploy"]);
  });

  it("keeps a discovered reserved name in a session conversation", () => {
    expect(
      names({ scope: SESSION, items: [discovered("/commit")] }),
    ).toEqual(["/commit"]);
  });

  it("withholds /ticket in a workflow-managed lane conversation", () => {
    expect(
      names({ scope: SESSION, isWorkflowManagedConversation: true }),
    ).not.toContain("/ticket");
  });

  it("withholds a discovered /ticket in a lane conversation too", () => {
    expect(
      names({
        scope: SESSION,
        items: [discovered("/ticket")],
        isWorkflowManagedConversation: true,
      }),
    ).toEqual([]);
  });

  it("keeps the argument hint that primes the composer for /ticket", () => {
    const ticket = filterCommandsForScope(BUILT_IN_COMMANDS, {
      scope: PROJECT,
      isWorkflowManagedConversation: false,
    }).find((item) => item.name === "/ticket");
    expect(ticket?.argumentHint).toBe("[hint text]");
  });
});
