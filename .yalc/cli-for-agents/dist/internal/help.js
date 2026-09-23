import { cliConfiguration, cliRegistry, registryState } from "./registry.js";
import { commandData, flowSteps } from "./declarations.js";
import { makeInvocation, renderReference } from "./invocations.js";
import { bytes, milliseconds } from "../values.js";
import { assertFields, assertRecord, assertText, frozenJson } from "./validation.js";
import { exitTaxonomy, exitCodeForClass } from "./exit-codes.js";
import { kernelErrors } from "../results.js";
export function projectHelp(cli, path) {
    const state = registryState(cliRegistry(cli));
    const options = cliConfiguration(cli);
    const node = Object.hasOwn(state.nodes, path) ? state.nodes[path] : undefined;
    if (!node) {
        let parent = typeof path === "string" ? path.split(" ").slice(0, -1).join(" ") : "";
        while (parent && !Object.hasOwn(state.nodes, parent))
            parent = parent.split(" ").slice(0, -1).join(" ");
        throw new TypeError(`Unknown help path. Use ${[state.name, parent, "--help"].filter(Boolean).join(" ")}.`);
    }
    const model = node.model;
    const spec = model?.spec;
    const metadata = node.group ?? spec;
    const children = Object.values(state.nodes).filter(n => n.path && n.path.split(" ").slice(0, -1).join(" ") === path)
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(n => ({ path: n.path, summary: n.summary }));
    // Every CLI has a doctor leaf; its model owns the same globals/framework inputs
    // accepted by the parser at hubs. Do not duplicate that inventory here.
    const hubModel = Object.values(state.nodes).find(n => n.model)?.model;
    const artifactPolicy = options.output.artifacts;
    const flags = Object.values((model ?? hubModel)?.flags ?? {})
        .filter(entry => model || entry.global || entry.help.source === "framework" && entry.help.kind === "boolean")
        .map(entry => entry.help.name === "out" && !("resolve" in artifactPolicy)
        ? { ...entry.help, description: `${entry.help.description} Artifact directory: ${JSON.stringify(artifactPolicy.directory)}.` }
        : entry.help);
    const args = (spec?.args ?? []).map(arg => ({ name: arg.name, description: arg.description,
        required: arg.required !== false && arg.default === undefined, variadic: arg.variadic === true, value: arg.value, ...(arg.default !== undefined ? { default: arg.default } : {}) }));
    const usage = [state.name, path, ...args.map(arg => `${arg.required ? "<" : "["}${arg.name}${arg.variadic ? "..." : ""}${arg.required ? ">" : "]"}`),
        ...flags.filter(flag => flag.required).map(flag => {
            const inline = `--${flag.name}${flag.valuePlaceholder ? ` ${flag.valuePlaceholder}` : ""}`;
            return flag.fileAlternative ? `(${inline} | --${flag.fileAlternative.name} <path>)` : flag.credentialEnv ? `(${inline} | env ${flag.credentialEnv})` : inline;
        }),
        ...(model ? ["[options]", ...(spec?.passthrough ? ["[-- <tokens...>]"] : [])] : ["<command> [options]"])].filter(Boolean).join(" ");
    const examples = node.command ? commandData(node.command).examples.map(example => {
        const { why, ...input } = example;
        try {
            return Object.freeze({ invocation: makeInvocation(node.command, input, node.kind === "validation"), why });
        }
        catch (error) {
            if (!(error instanceof TypeError))
                throw error;
            // Declaration examples may contain credentials or non-runnable placeholders.
            // Never mint a runnable reference for those inputs or expose secret values.
            const template = { ...input };
            const flags = { ...template["flags"] };
            for (const [name, entry] of Object.entries(model.flags))
                if (entry.definition.secret && Object.hasOwn(flags, name))
                    flags[name] = `<${name}>`;
            if (template["flags"])
                template["flags"] = flags;
            return Object.freeze({ template: frozenJson(template), why });
        }
    }) : [];
    const flows = (options.flows ?? []).map(flow => ({ id: flow.id,
        steps: flowSteps(flow).map(step => ({ path: step.command.spec.path, description: step.description })) }))
        .filter(flow => node.command && flow.steps.some(step => step.path === path || node.kind === "validation" && step.path === spec?.path));
    const related = [...(metadata?.related ?? [])];
    const addEdge = (target, description) => {
        if (target !== path && !related.some(edge => edge.path === target))
            related.push({ path: target, description });
    };
    for (const flow of flows)
        for (const step of flow.steps)
            addEdge(step.path, step.description);
    if (spec?.effects === "write" && spec.payload)
        addEdge(node.kind === "validation" ? spec.path : spec.payload.validatePath, node.kind === "validation" ? "Apply this payload." : "Validate this payload before applying it.");
    // Preserve example invocation identities; freezing JSON would erase their token provenance.
    return Object.freeze({ ...frozenJson({ path, kind: node.kind, summary: node.summary, description: node.description,
            usage: [usage], children, related, flags, arguments: args, skills: metadata?.skills ?? [], sections: metadata?.sections ?? [],
            dynamicHelp: metadata?.dynamicHelp === true, flows,
            ...(spec ? { effects: node.kind === "validation" ? "read" : spec.effects,
                levels: Object.fromEntries(Object.entries(model.selectors).map(([name, selectors]) => [name, { selectors, output: spec.levels[name].output }])),
                ...(spec.payload ? { payload: spec.payload } : {}), ...(spec.output ? { output: spec.output } : {}) } : {}),
        }), examples: Object.freeze(examples) });
}
/** One text projection serves offline runtime help and generated references. */
export function renderHelp(cli, path) {
    const node = projectHelp(cli, path);
    const name = registryState(cliRegistry(cli)).name;
    const lines = [node.summary, node.description, "", ...node.usage.map(usage => `Usage: ${usage}`)];
    const section = (title, rows) => { if (rows.length)
        lines.push("", `${title}:`, ...rows); };
    if (node.effects)
        section("Effects", [node.effects]);
    section("Commands", node.children.map(child => `${name} ${child.path} — ${child.summary}`));
    section("Arguments", node.arguments.map(arg => `${arg.name}${arg.variadic ? "..." : ""} — ${arg.description} (${arg.required ? "required" : "optional"}; ${describeValue(arg.value)}${arg.default !== undefined ? `; default: ${JSON.stringify(arg.default)}` : ""})`));
    const sharedNames = new Set(path ? projectHelp(cli, "").flags.map(flag => flag.name) : []);
    if (path)
        lines.push("", `Global flags: ${name} --help`);
    section("Flags", node.flags.filter(flag => !sharedNames.has(flag.name)).map(flag => `--${flag.name}${flag.valuePlaceholder ? ` ${flag.valuePlaceholder}` : ""} — ${flag.description} [${flag.source}; ${describeValue(flag.value)}${flag.fileAlternative ? `; alternative: --${flag.fileAlternative.name}, max ${flag.fileAlternative.maxBytes} bytes, exclusive with --${flag.name}` : ""}${flag.credentialEnv ? `; credential fallback: env ${flag.credentialEnv}` : ""}${flag.required ? "; required" : ""}${flag.repeatable ? "; repeatable" : ""}${flag.default !== undefined ? `; default: ${JSON.stringify(flag.default)}` : ""}]`));
    section("Levels", Object.entries(node.levels ?? {}).map(([level, value]) => `${level}: ${value.selectors.map(s => `--${s}`).join(" ")} (${value.output})`));
    if (node.payload)
        section("Payload", [`Structured file or stdin (-), maximum ${node.payload.maxBytes} bytes.`]);
    if (node.output)
        section("Output", [node.output]);
    section("Examples", node.examples.map(example => `${example.invocation ? renderReference(example.invocation, name) : `Template (supply actual inputs): ${JSON.stringify(example.template)}`} — ${example.why}`));
    for (const entry of node.sections)
        section(entry.title, entry.kind === "list" ? entry.items.map(item => `- ${item}`) : entry.paragraphs);
    section("Related", node.related.map(edge => `${name} ${edge.path} --help — ${edge.description}`));
    section("Skills", node.skills.map(skill => `${skill.path} — ${skill.readWhen}`));
    section("Flows", node.flows.map(flow => `${flow.id}: ${flow.steps.map(step => `${step.path} (${step.description})`).join(" → ")}`));
    return `${lines.join("\n")}\n`;
}
/** Catalog inventory shared by offline exit-codes and reference output. */
export function exitCodeInventory(cli) {
    const errors = Object.fromEntries(Object.entries({ ...kernelErrors, ...cliConfiguration(cli).family.errors.definitions })
        .map(([code, entry]) => [code, { ...entry, exitCode: exitCodeForClass(entry.exitClass) }]));
    return frozenJson({ exits: exitTaxonomy, errors });
}
export function renderExitCodes(cli) {
    const inventory = exitCodeInventory(cli);
    return `${inventory.exits.map(entry => `${entry.code}: ${entry.exitClass} — ${entry.description}`).join("\n")}\n\n${Object.entries(inventory.errors).map(([code, entry]) => `${code}: exit ${entry.exitCode} (${entry.exitClass}) — ${entry.description}`).join("\n")}\n`;
}
export function renderCommandReference(cli) {
    const state = registryState(cliRegistry(cli));
    return `${Object.keys(state.nodes).sort().map(path => `## ${path || state.name}\n\n${renderHelp(cli, path)}`).join("\n")}\n## Exit codes\n\n${renderExitCodes(cli)}`;
}
/** Runtime-composition calls this only for resolve()'s offline branch. */
export async function renderOffline(cli, route, request) {
    const state = registryState(cliRegistry(cli));
    const value = route.route === "help" ? projectHelp(cli, route.path) : route.route === "version" ? { name: state.name, version: state.version } : exitCodeInventory(cli);
    let data = value;
    let stdout = route.json ? `${JSON.stringify(value)}\n` : route.route === "help" ? renderHelp(cli, route.path) : route.route === "version" ? `${state.name} ${state.version}\n` : renderExitCodes(cli);
    const context = cliConfiguration(cli).helpContext;
    if (route.route === "help" && context && projectHelp(cli, route.path).dynamicHelp && !request.signal.aborted) {
        const blocks = await helpBlocks(context, route.path, request);
        if (blocks.length) {
            data = { ...value, context: blocks };
            stdout = route.json ? `${JSON.stringify(data)}\n` : `${stdout}\nContext:\n${blocks.map(block => block.text).join("\n\n")}\n`;
        }
    }
    return { stdout, stderr: "", exitCode: 0, data: frozenJson(data) };
}
async function helpBlocks(context, path, request) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    let timer;
    let cancelWait = () => { };
    try {
        const duration = milliseconds(context.deadline ?? 500);
        const now = request.host?.now ?? (() => performance.now());
        const expires = now() + duration;
        const checkDeadline = () => {
            controller.signal.throwIfAborted();
            if (now() >= expires)
                throw new Error("Help deadline elapsed.");
        };
        const limit = bytes(context.maxBytes);
        const maxBlocks = context.maxBlocks ?? 3;
        if (![1, 2, 3].includes(maxBlocks))
            return [];
        if (request.signal.aborted)
            return [];
        const deadline = new Promise((_resolve, reject) => {
            const stop = () => reject(new Error("Help enrichment stopped."));
            controller.signal.addEventListener("abort", stop, { once: true });
            cancelWait = () => controller.signal.removeEventListener("abort", stop);
            if (request.host)
                void request.host.sleep(duration, controller.signal).then(stop, stop);
            else
                timer = setTimeout(stop, duration);
        });
        const enrich = async () => {
            const providers = await context.load();
            checkDeadline();
            if (!Array.isArray(providers) || providers.length > 3 || providers.some(provider => typeof provider !== "function"))
                throw new TypeError("Invalid help providers.");
            const supplied = await Promise.all(providers.map(provider => provider({ path, env: Object.freeze({ ...request.env }), signal: controller.signal })));
            checkDeadline();
            const blocks = [];
            for (const result of supplied) {
                if (!Array.isArray(result) || blocks.length + result.length > maxBlocks)
                    throw new TypeError("Invalid help block count.");
                for (const value of result) {
                    const block = frozenJson(value);
                    assertRecord(block);
                    assertFields(block, ["text"]);
                    assertText(block["text"]);
                    blocks.push({ text: block["text"] });
                }
            }
            const encoder = new TextEncoder();
            const text = `\nContext:\n${blocks.map(block => block.text).join("\n\n")}\n`;
            // Bound the entire added representation, including JSON escaping and labels.
            if (encoder.encode(JSON.stringify({ context: blocks })).length > limit || encoder.encode(text).length > limit)
                throw new RangeError("Help enrichment exceeds its byte cap.");
            checkDeadline();
            return frozenJson(blocks);
        };
        return await Promise.race([deadline, enrich()]);
    }
    catch {
        return [];
    }
    finally {
        controller.abort();
        if (timer !== undefined)
            clearTimeout(timer);
        cancelWait();
        request.signal.removeEventListener("abort", abort);
    }
}
function describeValue(value) {
    switch (value.kind) {
        case "enum": return `enum; choices: ${value.values.join(", ")}`;
        case "output-path": return "output destination";
        case "file": return `file or stdin (-), max ${value.maxBytes} bytes`;
        case "integer": return `integer${value.min !== undefined ? `; minimum ${value.min}` : ""}${value.max !== undefined ? `; maximum ${value.max}` : ""}`;
        case "string": return `string${value.minLength !== undefined ? `; minimum length ${value.minLength}` : ""}${value.maxLength !== undefined ? `; maximum length ${value.maxLength}` : ""}`;
        case "pattern": return `pattern ${value.pattern}: ${value.description}`;
        case "id": return `${value.domain} ID`;
        default: return value.kind;
    }
}
//# sourceMappingURL=help.js.map