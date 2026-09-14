import { describe, expect, it } from "vitest";
import type {
  AgentTaskRequest,
  AgentTaskResult,
  AgentTaskRunner,
} from "@/lib/agent-backends/task";
import {
  TICKET_ENRICHMENT_DIAGNOSTICS_MAX_BYTES,
  TICKET_ENRICHMENT_MAX_MARKDOWN_BYTES,
  TICKET_ENRICHMENT_OUTPUT_SCHEMA,
  TICKET_ENRICHMENT_PROMPT_MAX_BYTES,
  TICKET_ENRICHMENT_TIMEOUT_MS,
  createTicketEnrichmentService,
  ticketEnrichmentAttachmentId,
  type AppendTriageNoteInput,
  type TicketEnrichmentInput,
  type TicketEnrichmentServiceDeps,
} from "./enrichment";

function taskResult(overrides: Partial<AgentTaskResult> = {}): AgentTaskResult {
  return {
    backendRef: null,
    text: null,
    structuredOutput: { markdown: "## Triage\n\nInspect the request path." },
    usage: null,
    error: null,
    timedOut: false,
    failure: null,
    continuationDisposition: "retain",
    ...overrides,
  };
}

const input: TicketEnrichmentInput = {
  projectName: "command-center",
  projectPath: "/projects/command-center",
  ticketId: "ticket-1",
  number: 42,
  title: "Create dialog fails",
  description: "Submitting the quick-ticket dialog returns an error.",
  diagnosticsMarkdown: "# Diagnostic report\n\nRoute: `/tickets`",
  conversationContext: {
    sourceProjectName: "source-project",
    sessionName: "bug-session",
    conversationId: "conversation-1",
    title: "Observed failure",
  },
  backend: "codex",
  modelSelection: {
    modelId: "gpt-5.4",
    parameters: { fast: "false", reasoning: "high" },
  },
};

interface HarnessOptions {
  backend?: AgentTaskRunner["backend"];
  resolveRunnerError?: unknown;
  run?: (request: AgentTaskRequest) => Promise<AgentTaskResult>;
  append?: (input: AppendTriageNoteInput) => Promise<void>;
}

function createHarness(options: HarnessOptions = {}) {
  const requests: AgentTaskRequest[] = [];
  const resolvedBackends: string[] = [];
  const appendInputs: AppendTriageNoteInput[] = [];
  const runner: AgentTaskRunner = {
    backend: options.backend ?? "codex",
    async run(request) {
      requests.push(request);
      return options.run?.(request) ?? taskResult();
    },
  };
  const deps: TicketEnrichmentServiceDeps = {
    getTaskRunner(backend) {
      resolvedBackends.push(backend);
      if (options.resolveRunnerError !== undefined) {
        throw options.resolveRunnerError;
      }
      return runner;
    },
    async appendTriageNote(noteInput) {
      appendInputs.push(noteInput);
      await options.append?.(noteInput);
    },
  };
  return {
    service: createTicketEnrichmentService(deps),
    requests,
    resolvedBackends,
    appendInputs,
  };
}

describe("createTicketEnrichmentService", () => {
  it("appends Cursor triage from fenced JSON without native structured output", async () => {
    const markdown =
      "## Triage\n\nReproduce the failed request with its trace ID.";
    const harness = createHarness({
      backend: "cursor",
      run: async () =>
        taskResult({
          structuredOutput: undefined,
          text: "```json\n" + JSON.stringify({ markdown }) + "\n```",
        }),
    });
    const result = await harness.service.enrich({
      ...input,
      backend: "cursor",
      modelSelection: {
        modelId: "composer-2.5",
        parameters: { fast: "false" },
      },
    });
    expect(result).toEqual({
      status: "appended",
      attachmentId: ticketEnrichmentAttachmentId(input.ticketId),
    });
    expect(harness.resolvedBackends).toEqual(["cursor"]);
    expect(harness.appendInputs[0]).toMatchObject({
      ticketId: input.ticketId,
      markdown,
    });
  });

  it("forwards the selected backend profile without changing the fixed enrichment timeout", async () => {
    const harness = createHarness();
    const configuredInput = {
      ...input,
      modelSelection: {
        modelId: "gpt-5.6-terra",
        parameters: { fast: "false", reasoning: "xhigh" },
      },
    };

    await harness.service.enrich(configuredInput);

    expect(harness.requests[0]).toMatchObject({
      modelSelection: configuredInput.modelSelection,
      timeoutMs: TICKET_ENRICHMENT_TIMEOUT_MS,
    });
  });

  it("runs the configured backend once with the isolated one-shot policy and appends server-owned triage", async () => {
    const harness = createHarness();

    const result = await harness.service.enrich(input);

    const attachmentId = ticketEnrichmentAttachmentId(input.ticketId);
    expect(result).toEqual({ status: "appended", attachmentId });
    expect(harness.resolvedBackends).toEqual(["codex"]);
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({
      workingDirectory: input.projectPath,
      executionProfile: "isolated-one-shot",
      tooling: { portableMcp: { servers: [] } },
      outputSchema: TICKET_ENRICHMENT_OUTPUT_SCHEMA,
      timeoutMs: TICKET_ENRICHMENT_TIMEOUT_MS,
      autonomous: true,
    });
    expect(harness.requests[0]?.prompt).toContain(input.title);
    expect(harness.requests[0]?.prompt).toContain(`"number": ${input.number}`);
    expect(harness.requests[0]?.prompt).toContain(
      JSON.stringify(input.diagnosticsMarkdown),
    );
    expect(harness.requests[0]?.prompt).toContain("source-project");
    expect(harness.appendInputs).toEqual([
      {
        attachmentId,
        ticketId: input.ticketId,
        number: input.number,
        projectName: input.projectName,
        projectPath: input.projectPath,
        description: "Agent triage",
        markdown: "## Triage\n\nInspect the request path.",
      },
    ]);
  });

  it("uses neutral structured-output fall-through before appending", async () => {
    const harness = createHarness({
      run: async () =>
        taskResult({
          structuredOutput: { markdown: 42 },
          text: '```json\n{"markdown":"## Corrected triage"}\n```',
        }),
    });

    await expect(harness.service.enrich(input)).resolves.toMatchObject({
      status: "appended",
    });
    expect(harness.appendInputs[0]?.markdown).toBe("## Corrected triage");
  });

  it("rejects output with fields outside the strict markdown envelope", async () => {
    const harness = createHarness({
      run: async () =>
        taskResult({
          structuredOutput: {
            markdown: "## Triage",
            commands: ["cctl ticket update"],
          },
        }),
    });

    await expect(harness.service.enrich(input)).resolves.toEqual({
      status: "failed",
      stage: "structured_output",
    });
    expect(harness.appendInputs).toEqual([]);
  });

  it("enforces the 2 KB cap in UTF-8 bytes", async () => {
    const atLimit = createHarness({
      run: async () =>
        taskResult({ structuredOutput: { markdown: "é".repeat(1024) } }),
    });
    const overLimit = createHarness({
      run: async () =>
        taskResult({ structuredOutput: { markdown: "é".repeat(1025) } }),
    });

    await expect(atLimit.service.enrich(input)).resolves.toMatchObject({
      status: "appended",
    });
    expect(
      Buffer.byteLength(atLimit.appendInputs[0]?.markdown ?? "", "utf8"),
    ).toBe(TICKET_ENRICHMENT_MAX_MARKDOWN_BYTES);
    await expect(overLimit.service.enrich(input)).resolves.toEqual({
      status: "failed",
      stage: "output_size",
    });
    expect(overLimit.appendInputs).toEqual([]);
  });

  it("bounds inline diagnostic facts and the complete prompt", async () => {
    const harness = createHarness();
    const diagnosticTail = "must-not-reach-the-agent";

    await harness.service.enrich({
      ...input,
      diagnosticsMarkdown:
        '\\\n"'.repeat(TICKET_ENRICHMENT_DIAGNOSTICS_MAX_BYTES) +
        diagnosticTail,
    });

    const prompt = harness.requests[0]?.prompt ?? "";
    expect(prompt).not.toContain(diagnosticTail);
    expect(prompt).toContain("[truncated]");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(
      TICKET_ENRICHMENT_PROMPT_MAX_BYTES,
    );
  });

  it.each([
    {
      name: "runner resolution throws",
      options: { resolveRunnerError: new Error("resolver secret") },
      stage: "execution" as const,
    },
    {
      name: "runner execution throws",
      options: {
        run: async () => {
          throw new Error("provider secret");
        },
      },
      stage: "execution" as const,
    },
    {
      name: "runner reports an error",
      options: {
        run: async () => taskResult({ error: "provider output secret" }),
      },
      stage: "execution" as const,
    },
    {
      name: "runner times out",
      options: {
        run: async () => taskResult({ timedOut: true }),
      },
      stage: "execution" as const,
    },
    {
      name: "idempotent append throws",
      options: {
        append: async () => {
          throw new Error("database secret");
        },
      },
      stage: "append" as const,
    },
  ])("never throws when $name", async ({ options, stage }) => {
    const harness = createHarness(options);

    await expect(harness.service.enrich(input)).resolves.toEqual({
      status: "failed",
      stage,
    });
  });

  it("derives a stable ticket-specific attachment id", () => {
    expect(ticketEnrichmentAttachmentId("ticket-1")).toBe(
      ticketEnrichmentAttachmentId("ticket-1"),
    );
    expect(ticketEnrichmentAttachmentId("ticket-1")).not.toBe(
      ticketEnrichmentAttachmentId("ticket-2"),
    );
  });

  it("exports a strict backend schema with no prompt-only byte keyword", () => {
    expect(TICKET_ENRICHMENT_OUTPUT_SCHEMA).toEqual({
      type: "object",
      properties: { markdown: { type: "string", minLength: 1 } },
      required: ["markdown"],
      additionalProperties: false,
    });
  });
});
