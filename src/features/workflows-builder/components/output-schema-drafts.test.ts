import { describe, expect, it } from "vitest";
import { createWorkflowDefinition } from "@/lib/workflow-graph/test-fixtures";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import {
  findOutputSchemaBlocks,
  resolveOutputSchemaText,
  serializeOutputSchemaText,
} from "./output-schema-drafts";

const VALID_SCHEMA = { type: "object", properties: {} };

function definitionWithSchema(
  schema: Record<string, unknown> | undefined,
): WorkflowSemanticDefinition {
  const definition = createWorkflowDefinition();
  const [first, ...rest] = definition.executionContexts;
  if (!first) throw new Error("fixture has no execution context");
  return {
    ...definition,
    executionContexts: [
      schema === undefined ? first : { ...first, outputSchema: schema },
      ...rest,
    ],
  };
}

function firstContextId(definition: WorkflowSemanticDefinition): string {
  const id = definition.executionContexts[0]?.id;
  if (id === undefined) throw new Error("fixture has no execution context");
  return id;
}

describe("serializeOutputSchemaText", () => {
  it("renders an absent schema as empty text", () => {
    expect(serializeOutputSchemaText(undefined)).toBe("");
  });

  it("pretty-prints a schema so the editor opens on readable text", () => {
    expect(serializeOutputSchemaText(VALID_SCHEMA)).toBe(
      JSON.stringify(VALID_SCHEMA, null, 2),
    );
  });
});

describe("resolveOutputSchemaText", () => {
  it("shows the persisted text when the author has typed nothing", () => {
    expect(resolveOutputSchemaText("{}", undefined)).toBe("{}");
  });

  it("keeps the author's own text rather than the serialization it committed", () => {
    // Typing compact JSON commits a pretty-printed document; reformatting the
    // textarea under the cursor is exactly what `committed` exists to prevent.
    expect(
      resolveOutputSchemaText('{\n  "type": "object"\n}', {
        text: '{"type":"object"}',
        committed: '{\n  "type": "object"\n}',
      }),
    ).toBe('{"type":"object"}');
  });

  it("keeps text no commit could accept", () => {
    expect(
      resolveOutputSchemaText("{}", { text: '{ "type": ', committed: "{}" }),
    ).toBe('{ "type": ');
  });

  it("drops the entry once the persisted value moved on its own", () => {
    // Reset, a draft reload, a workflow switch: the stored document changed
    // behind the editor, so the entry describes a draft that no longer exists.
    expect(
      resolveOutputSchemaText('{"type":"string"}', {
        text: "{{{",
        committed: "{}",
      }),
    ).toBe('{"type":"string"}');
  });
});

describe("findOutputSchemaBlocks", () => {
  it("finds nothing when no draft text is pending", () => {
    expect(
      findOutputSchemaBlocks(definitionWithSchema(VALID_SCHEMA), {}),
    ).toEqual([]);
  });

  it("finds nothing for a null definition", () => {
    expect(findOutputSchemaBlocks(null, {})).toEqual([]);
  });

  it("names the context whose text no commit could accept, with the editor's own copy", () => {
    const definition = definitionWithSchema(VALID_SCHEMA);
    const contextId = firstContextId(definition);
    const persisted = serializeOutputSchemaText(VALID_SCHEMA);

    const blocks = findOutputSchemaBlocks(definition, {
      [contextId]: { text: '{ "type": ', committed: persisted },
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.contextId).toBe(contextId);
    expect(blocks[0]?.message).toBeTruthy();
  });

  // Every refusal owes the author a row. Reporting only the first would leave
  // the second context blocking the save with nothing in the strip naming it.
  it("lists every context holding text no commit could accept, in draft order", () => {
    const definition = definitionWithSchema(VALID_SCHEMA);
    const first = firstContextId(definition);
    const second = definition.executionContexts[1];
    if (!second) throw new Error("fixture needs a second execution context");
    const persisted = serializeOutputSchemaText(VALID_SCHEMA);

    const blocks = findOutputSchemaBlocks(definition, {
      [second.id]: { text: "{{{", committed: "" },
      [first]: { text: '{ "type": ', committed: persisted },
    });

    expect(blocks.map((block) => block.contextId)).toEqual([first, second.id]);
    expect(blocks.every((block) => block.message.length > 0)).toBe(true);
  });

  // The whole point of keying by context: an author who navigates away from the
  // offending screen has not fixed anything, so the save stays refused.
  it("still finds text pending on a context that is not selected", () => {
    const definition = definitionWithSchema(VALID_SCHEMA);
    const other = definition.executionContexts[1];
    if (!other) throw new Error("fixture needs a second execution context");

    const blocks = findOutputSchemaBlocks(definition, {
      [other.id]: { text: "{{{", committed: "" },
    });

    expect(blocks.map((block) => block.contextId)).toEqual([other.id]);
  });

  it("ignores pending text for a context the draft no longer holds", () => {
    const definition = definitionWithSchema(VALID_SCHEMA);

    expect(
      findOutputSchemaBlocks(definition, {
        "deleted-context": { text: "{{{", committed: "" },
      }),
    ).toEqual([]);
  });

  it("ignores a stale entry whose committed serialization no longer matches", () => {
    const definition = definitionWithSchema(VALID_SCHEMA);
    const contextId = firstContextId(definition);

    expect(
      findOutputSchemaBlocks(definition, {
        [contextId]: { text: "{{{", committed: "not-what-is-stored" },
      }),
    ).toEqual([]);
  });

  it("accepts text that clears the editor back to no schema", () => {
    const definition = definitionWithSchema(undefined);
    const contextId = firstContextId(definition);

    expect(
      findOutputSchemaBlocks(definition, {
        [contextId]: { text: "   ", committed: "" },
      }),
    ).toEqual([]);
  });
});
