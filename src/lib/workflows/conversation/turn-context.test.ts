import { buildDebugPromptContext } from "@/lib/workflows/debug/prompt-policy";
import { describe, it, expect } from "vitest";
import { assembleTurnPrompt } from "./turn-context";
describe("assembleTurnPrompt", () => {
  it("prepends the active ticket block ahead of everything else", () => {
    const block = "<active-ticket>\nidentifier: repo#3\n</active-ticket>";
    const result = assembleTurnPrompt({
      userText: "hello",
      debugContext: buildDebugPromptContext({
        debugMode: null,
        debugLogUrl: "http://debug",
        debugManifestPath: ".debug/conv/instrumentation.json",
      }),
      activeTicketBlock: block,
      workflowResultsBlock: null,
      notepadChangeNoticeBlock: null,
      memoryIndexBlock: null,
    });
    expect(result).toBe(`${block}\n\nhello`);
  });

  it("places the ticket block before debug instructions", () => {
    const block = "<active-ticket>\nidentifier: repo#3\n</active-ticket>";
    const debugMode = {
      active: true,
      recording: true,
      logFilePath: "/tmp/debug.jsonl",
      enteredAt: "2024-01-01T00:00:00Z",
      debugSessionId: "debug-session-1",
      hypotheses: [] as never[],
      reproductionSteps: [] as string[],
      instructionsDelivered: false,
      phase: "hypothesizing" as const,
      fixSummary: null,
      verificationSteps: [] as string[],
      lastTurnFailed: false,
    };
    const result = assembleTurnPrompt({
      userText: "help debug",
      debugContext: buildDebugPromptContext({
        debugMode: debugMode,
        debugLogUrl: "http://debug-url",
        debugManifestPath: ".debug/conv/instrumentation.json",
      }),
      activeTicketBlock: block,
      workflowResultsBlock: null,
      notepadChangeNoticeBlock: null,
      memoryIndexBlock: null,
    });
    expect(typeof result).toBe("string");
    expect((result as string).startsWith(block)).toBe(true);
    expect(result as string).toContain("<debug-mode>");
    expect(result as string).toContain("help debug");
  });

  it("prepends debug instructions on first debug turn", () => {
    const debugMode = {
      active: true,
      debugSessionId: "debug-session-prompt",
      recording: false,
      logFilePath: "/tmp/debug.jsonl",
      enteredAt: "2024-01-01T00:00:00Z",
      hypotheses: [] as never[],
      reproductionSteps: [] as string[],
      instructionsDelivered: false,
      phase: "hypothesizing" as const,
      fixSummary: null,
      verificationSteps: [] as string[],
      lastTurnFailed: false,
    };
    const result = assembleTurnPrompt({
      userText: "help debug",
      debugContext: buildDebugPromptContext({
        debugMode: debugMode,
        debugLogUrl: "http://debug-url",
        debugManifestPath: ".debug/conv/instrumentation.json",
      }),
      activeTicketBlock: null,
      workflowResultsBlock: null,
      notepadChangeNoticeBlock: null,
      memoryIndexBlock: null,
    });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("<debug-mode>");
    expect(result as string).toContain("help debug");
    expect(result as string).toContain("http://debug-url");
    expect(result as string).toContain("/tmp/debug.jsonl");
  });

  it("prepends phase context when instructions already delivered", () => {
    const debugMode = {
      active: true,
      debugSessionId: "debug-session-phase",
      recording: false,
      logFilePath: "/tmp/debug.jsonl",
      enteredAt: "2024-01-01T00:00:00Z",
      hypotheses: [] as never[],
      reproductionSteps: [] as string[],
      instructionsDelivered: true,
      phase: "hypothesizing" as const,
      fixSummary: null,
      verificationSteps: [] as string[],
      lastTurnFailed: false,
    };
    const result = assembleTurnPrompt({
      userText: "help debug",
      debugContext: buildDebugPromptContext({
        debugMode: debugMode,
        debugLogUrl: "http://debug-url",
        debugManifestPath: ".debug/conv/instrumentation.json",
      }),
      activeTicketBlock: null,
      workflowResultsBlock: null,
      notepadChangeNoticeBlock: null,
      memoryIndexBlock: null,
    });
    expect(typeof result).toBe("string");
    expect(result as string).toContain("<debug-phase>");
    expect(result as string).toContain("HYPOTHESIZING");
    expect(result as string).toContain("help debug");
    expect(result as string).not.toContain("<debug-mode>");
  });

  it("does not prepend when debugMode is null", () => {
    const result = assembleTurnPrompt({
      userText: "hello",
      debugContext: buildDebugPromptContext({
        debugMode: null,
        debugLogUrl: "http://debug",
        debugManifestPath: ".debug/conv/instrumentation.json",
      }),
      activeTicketBlock: null,
      workflowResultsBlock: null,
      notepadChangeNoticeBlock: null,
      memoryIndexBlock: null,
    });
    expect(result).toBe("hello");
  });
});

it("orders every transient contribution ahead of expanded user text", () => {
  expect(
    assembleTurnPrompt({
      notepadChangeNoticeBlock: "notepads",
      workflowResultsBlock: "workflow",
      activeTicketBlock: "ticket",
      memoryIndexBlock: "memory",
      debugContext: "debug",
      userText: "original [Image #1]",
    }),
  ).toBe(
    "notepads\n\nworkflow\n\nticket\n\nmemory\n\ndebug\n\noriginal [Image #1]",
  );
});
