import { z } from "zod";
import { escapeXmlAttr } from "@/lib/shared/xml";
import { quoteAgentCommandArgument } from "@/lib/tickets/command-arguments";
import { graphWorkflowStatusSchema } from "./definition-schemas";

export const executionReferenceItemSchema = z.object({
  projectName: z.string(),
  sessionName: z.string(),
  executionId: z.string(),
  title: z.string(),
  status: graphWorkflowStatusSchema,
  startedAt: z.string(),
});
export type ExecutionReferenceItem = z.infer<
  typeof executionReferenceItemSchema
>;
export const executionReferenceInventorySchema = z.object({
  items: z.array(executionReferenceItemSchema),
});

export const executionRefAttrsSchema = z.object({
  "project-name": z.string().min(1),
  "session-name": z.string().min(1),
  "execution-id": z.string().min(1),
  title: z.string(),
  "read-command": z.string().optional(),
});
export type ExecutionRefAttrs = z.infer<typeof executionRefAttrsSchema>;

export function buildExecutionReadCommand(
  projectName: string,
  sessionName: string,
  executionId: string,
): string {
  return `cctl workflow status ${quoteAgentCommandArgument(executionId)} --project ${quoteAgentCommandArgument(projectName)} --session ${quoteAgentCommandArgument(sessionName)}`;
}

export function buildExecutionRefXml(input: {
  projectName: string;
  sessionName: string;
  executionId: string;
  title: string;
}): string {
  const attrs = {
    "project-name": input.projectName,
    "session-name": input.sessionName,
    "execution-id": input.executionId,
    title: input.title,
    "read-command": buildExecutionReadCommand(
      input.projectName,
      input.sessionName,
      input.executionId,
    ),
  };
  return `<execution-ref ${Object.entries(attrs)
    .map(([key, value]) => `${key}="${escapeXmlAttr(value)}"`)
    .join(" ")} />`;
}
