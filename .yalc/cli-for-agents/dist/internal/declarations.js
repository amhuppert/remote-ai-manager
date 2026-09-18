import { checkCaller, checkFlags, checkPath, inputModel } from "./input-model.js";
import { assertFields, assertIdentifier, assertRecord, assertText, frozenJson } from "./validation.js";
const commands = new WeakMap();
const flows = new WeakMap();
export function commandData(command) {
    const data = commands.get(command);
    if (!data)
        throw new TypeError("Unknown command token.");
    return data;
}
/** Family identity is checked before erasing its compile-time catalog keys. */
export function commandErrors(command) {
    const family = commandData(command).family;
    checkFamily(family);
    return family.errors;
}
export function checkFamily(family) {
    if (!("defineCommand" in family) || typeof family.defineCommand !== "function" || !("errors" in family))
        throw new TypeError("Unknown command family.");
}
export function checkGroup(group) {
    if (!("kind" in group) || group.kind !== "group")
        throw new TypeError("Unknown group token.");
}
export function flowSteps(flow) {
    const steps = flows.get(flow);
    if (!steps)
        throw new TypeError("Unknown flow token.");
    return steps;
}
export function checkMetadata(value) {
    checkPath(value.path);
    assertText(value.summary);
    assertText(value.description);
    if (value.dynamicHelp !== undefined && value.dynamicHelp !== true)
        throw new TypeError("Invalid dynamic help marker.");
    if (value.related !== undefined) {
        if (!Array.isArray(value.related))
            throw new TypeError("Invalid related edges.");
        for (const edge of value.related) {
            assertRecord(edge);
            assertFields(edge, ["path", "description"]);
            assertText(edge["path"]);
            checkPath(edge["path"]);
            assertText(edge["description"]);
        }
    }
    if (value.skills !== undefined) {
        if (!Array.isArray(value.skills))
            throw new TypeError("Invalid skill references.");
        for (const skill of value.skills) {
            assertRecord(skill);
            assertFields(skill, ["path", "readWhen"]);
            assertText(skill["path"]);
            assertText(skill["readWhen"]);
            if (skill["path"].includes("\\") || skill["path"].includes(":") || skill["path"].split("/").some(p => !p || p === "." || p === ".."))
                throw new TypeError("Invalid skill reference path.");
        }
    }
    if (value.sections !== undefined) {
        if (!Array.isArray(value.sections))
            throw new TypeError("Invalid help sections.");
        for (const section of value.sections) {
            assertRecord(section);
            assertText(section["title"]);
            if (section["kind"] !== "paragraphs" && section["kind"] !== "list")
                throw new TypeError("Invalid help section kind.");
            assertFields(section, ["kind", "title", section["kind"] === "list" ? "items" : "paragraphs"]);
            const contents = section["kind"] === "list" ? section["items"] : section["paragraphs"];
            if (!Array.isArray(contents) || !contents.length)
                throw new TypeError("Empty help section.");
            contents.forEach(assertText);
        }
    }
}
export function makeFamily(options) {
    // The catalog remains owned by defineErrors; this boundary retains its identity.
    if (!options.errors || !Object.isFrozen(options.errors) || typeof options.errors.error !== "function")
        throw new TypeError("Expected a checked error catalog.");
    const globalFlags = frozenJson(options.globalFlags);
    checkFlags(globalFlags);
    const defineCommand = (spec, binding) => {
        const snapshot = frozenJson(spec);
        assertRecord(snapshot);
        assertFields(snapshot, ["path", "summary", "description", "requires", "effects", "args", "flags"], ["related", "skills", "sections", "dynamicHelp", "passthrough", "output", "payload", "levels"]);
        checkMetadata(snapshot);
        if (snapshot.requires !== "none")
            checkPath(snapshot.requires);
        if (!["read", "write"].includes(snapshot.effects))
            throw new TypeError("Invalid command effects.");
        if (snapshot.output !== undefined && snapshot.output !== "binary")
            throw new TypeError("Invalid output kind.");
        if (snapshot.passthrough !== undefined && snapshot.passthrough !== true)
            throw new TypeError("Invalid passthrough marker.");
        if (typeof binding.handler !== "function")
            throw new TypeError("Expected lazy handler function.");
        const model = inputModel(snapshot, globalFlags);
        const examples = frozenJson(binding.examples);
        if (!Array.isArray(examples) || examples.length === 0)
            throw new TypeError("Commands require examples.");
        for (const example of examples) {
            assertRecord(example);
            assertText(example["why"]);
            const { why: _why, ...input } = example;
            checkCaller(model, input, false);
        }
        const command = Object.freeze({ spec: snapshot, globalFlags });
        commands.set(command, Object.freeze({ family, model, examples, handler: binding.handler }));
        return command;
    };
    const family = Object.freeze({ errors: options.errors, globalFlags, defineCommand });
    return family;
}
export function makeGroup(definition) {
    const snapshot = frozenJson(definition);
    assertRecord(snapshot);
    assertFields(snapshot, ["path", "summary", "description"], ["related", "skills", "sections", "dynamicHelp"]);
    checkMetadata(snapshot);
    return Object.freeze({ ...snapshot, kind: "group" });
}
export function makeFlow(definition) {
    assertIdentifier(definition.id);
    if (!Array.isArray(definition.steps) || !definition.steps.length)
        throw new TypeError("Flow requires steps.");
    const steps = Object.freeze(definition.steps.map(step => {
        commandData(step.command);
        assertText(step.description);
        return Object.freeze({ command: step.command, description: step.description });
    }));
    const flow = Object.freeze({ id: definition.id });
    flows.set(flow, steps);
    return flow;
}
//# sourceMappingURL=declarations.js.map