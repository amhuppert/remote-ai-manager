import {
  runner,
  type HandlerInput,
  type ReadHandler,
  type JsonValue,
} from "cli-for-agents";
import { z } from "zod";
import {
  specDetailViewSchema,
  specStatusViewSchema,
} from "@/lib/specs/view-schemas";
import { ccErrors, type ccGlobalFlags } from "../../framework/family";
import type { CcErrorCode } from "../../framework/context";
import type { specSchemaSpec } from "./native-definitions";
import {
  authoringSchemaDocuments,
  type SchemaDocument,
} from "./schema-documents";

function readReference(): SchemaDocument {
  return {
    id: "read-envelopes",
    title: "Spec read data and revision roles",
    usedBy: ["cctl spec show <slug> --full", "cctl spec status <slug> --full"],
    jsonSchema: z.toJSONSchema(
      z.object({ detail: specDetailViewSchema, status: specStatusViewSchema }),
      { unrepresentable: "any" },
    ),
    enums: [],
    example: {
      dataLocation: "payload.data",
      artifactLocation: "payload.artifact.path",
      planLocation: "payload.data.plan",
      artifactContents: {
        response:
          "Parse the saved envelope, then select payload.data.plan for a plan result.",
        data: "Parse the saved domain data, then select plan for a plan result.",
        binary: "Read the document bytes; no JSON envelope is implied.",
      },
      revisionRoles: {
        baseRevision:
          "The immediate parent named by currentRevision.revision.basedOnRevisionId",
        currentRevision:
          "The latest revision and lineage head regardless of state",
        currentApprovedRevision:
          "The latest approved revision; it need not be an ancestor of the current lineage head",
      },
    },
    notes: [
      "The library owns the response envelope: ok and effect state the outcome; payload carries inline data or an artifact manifest; errors, reminders, instruction, hint, and recovery have their own protocol fields.",
      "Inspect payload.artifact.contains before reading a file. Automatic JSON spill saves the response envelope (response); --json --out saves domain data (data) when the original payload was inline; binary exports save document bytes (binary).",
      "Plan get/status reads and open/propose/reopen receipts keep the plan at payload.data.plan. Mutation-only previousHealth, invalidatedApproval, and executionStartAdmission are siblings of plan.",
      "--json changes serialization only. Disclosure levels select the same data in text and JSON. A bounded collection reports returned and total counts and a typed reveal invocation.",
      "spec show defaults to an outline; --summary returns counts, --rendered writes canonical Markdown, and --full writes the complete detail JSON. Artifact hashes cover the exact bytes on disk.",
      "spec status defaults to bounded collections; --full returns every row. Lint data is under lint; addressed reads are under element or section. Sections use their stable id and have no element handle.",
    ],
  };
}

const schemaRun = runner<
  HandlerInput<
    typeof specSchemaSpec,
    never,
    typeof ccErrors.definitions,
    typeof ccGlobalFlags
  >,
  JsonValue,
  CcErrorCode
>({
  async run({
    ctx,
  }: HandlerInput<
    typeof specSchemaSpec,
    never,
    typeof ccErrors.definitions,
    typeof ccGlobalFlags
  >) {
    const documents = authoringSchemaDocuments();
    if (ctx.args.document === undefined)
      return {
        ok: true,
        data: z.json().parse({
          documents: [
            ...documents,
            {
              id: "read-envelopes",
              title: "Spec read data and revision roles",
              usedBy: ["cctl spec show <slug> --full"],
            },
          ].map(({ id, title, usedBy }) => ({ id, title, usedBy })),
        }),
      } as const;
    const selected =
      ctx.args.document === "read-envelopes"
        ? readReference()
        : documents.find((document) => document.id === ctx.args.document);
    if (!selected)
      return {
        ok: false,
        error: ccErrors.error("CC_USAGE", {
          message: `Unknown spec document ${JSON.stringify(ctx.args.document)}. Run cctl spec schema for the document index.`,
        }),
      } as const;
    return {
      ok: true,
      data: z
        .json()
        .parse(JSON.parse(JSON.stringify({ documents: [selected] }))),
    } as const;
  },
});
export const schemaHandler: ReadHandler<
  typeof specSchemaSpec,
  never,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
> = { run: schemaRun, levels: { full: schemaRun } };
