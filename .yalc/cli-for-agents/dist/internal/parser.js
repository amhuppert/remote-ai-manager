import { checkCaller, checkName, invalidInput, scalar } from "./input-model.js";
function tokenValue(definition, token, label, path) {
    try {
        if (definition.kind === "integer") {
            if (typeof token !== "string" || !/^[+-]?[0-9]+$/.test(token))
                throw new TypeError("Expected an integer token.");
            return scalar(definition, Number(token));
        }
        if (definition.kind === "boolean") {
            if (token === true || token === "true")
                return true;
            if (token === false || token === "false")
                return false;
            throw new TypeError("Expected a boolean token.");
        }
        return scalar(definition, token);
    }
    catch (error) {
        if (!(error instanceof TypeError))
            throw error;
        throw invalidInput(definition, label, path);
    }
}
/** Globals may surround route tokens; command-specific flags follow the leaf.
 * Retain format before reporting any refusal. Keep scanning after lexical errors
 * so option ordering cannot change error representation; never scan past --. */
export function parseTokens(nodes, argv, retainFormat = () => { }) {
    if (!Array.isArray(argv) || argv.some(token => typeof token !== "string" || token.includes("\0")))
        throw new TypeError("Expected argv string tokens.");
    const sharedFlags = Object.create(null);
    const familyFlags = Object.values(nodes).find(candidate => candidate.model)?.model?.flags ?? {};
    for (const [name, entry] of Object.entries(familyFlags)) {
        if (entry.global || entry.help.source === "framework" && entry.help.kind === "boolean")
            sharedFlags[name] = entry;
    }
    let node = nodes[""];
    let options = true;
    let namedOffline;
    const positionals = [];
    const rawFlags = Object.create(null);
    let passthrough;
    let scanError;
    const rememberError = (error) => {
        if (!(error instanceof TypeError))
            throw error;
        scanError ??= error;
    };
    for (let index = 0; index < argv.length; index++) {
        try {
            const token = argv[index];
            if (options && token === "--") {
                if (node.model?.spec.passthrough) {
                    passthrough = argv.slice(index + 1);
                    break;
                }
                options = false;
                continue;
            }
            if (options && token.startsWith("--")) {
                const equals = token.indexOf("=");
                const name = token.slice(2, equals < 0 ? undefined : equals);
                const entry = (node.model?.flags ?? sharedFlags)[name];
                if (!entry) {
                    const help = [nodes[""]?.summary, node.path, "--help"].filter(Boolean).join(" ");
                    throw new TypeError(`Flag --${name} is not accepted here.${node.model ? "" : " Put command-specific flags after the complete command path."} Use ${help}.`);
                }
                const values = rawFlags[name] ??= [];
                if (equals >= 0)
                    values.push(token.slice(equals + 1));
                else if (entry.help.kind === "boolean")
                    values.push(true);
                else {
                    const next = argv[index + 1];
                    if (next === undefined || next.startsWith("--") || next.startsWith("-") && next !== "-" && !/^-[0-9]+$/.test(next))
                        throw new TypeError("Missing flag value; use equals for a leading dash.");
                    index++;
                    values.push(next);
                }
                continue;
            }
            if (options && token.startsWith("-") && token !== "-" && !/^-[0-9]+$/.test(token))
                throw new TypeError("Unknown option token.");
            if (namedOffline)
                throw new TypeError("Unexpected token after offline route.");
            if (node.kind === "command" || node.kind === "validation")
                positionals.push(token);
            else if (!node.path && (token === "version" || token === "exit-codes"))
                namedOffline = token;
            else {
                checkName(token);
                const path = node.path ? `${node.path} ${token}` : token;
                const child = nodes[path];
                if (!child) {
                    const children = Object.values(nodes).filter(candidate => candidate.path && candidate.path.split(" ").slice(0, -1).join(" ") === node.path).map(candidate => candidate.path).sort();
                    throw new TypeError(`Unknown command path. Use ${[nodes[""].summary, node.path, "--help"].filter(Boolean).join(" ")}. Commands: ${children.join(", ")}.`);
                }
                node = child;
            }
        }
        catch (error) {
            rememberError(error);
        }
    }
    const bool = (name) => Object.hasOwn(rawFlags, name) ? tokenValue({ kind: "boolean" }, rawFlags[name][0], `flag --${name}`, ["flags", name]) === true : false;
    let json = false;
    try {
        json = bool("json");
    }
    catch (error) {
        rememberError(error);
    }
    retainFormat(json);
    if (scanError)
        throw scanError;
    for (const name of Object.keys(rawFlags)) {
        const entry = (node.model?.flags ?? sharedFlags)[name];
        if (!entry)
            throw new TypeError("Flag is not accepted by this route.");
        const definition = entry.definition;
        if (rawFlags[name].length > 1 && !definition.repeatable)
            throw new TypeError("Duplicate flag.");
    }
    const help = bool("help");
    const version = bool("version");
    if (help && (version || namedOffline) || version && namedOffline && namedOffline !== "version")
        throw new TypeError("Conflicting offline routes.");
    if (help || version || namedOffline || !node.path && argv.length === 0)
        return { kind: "offline", route: help ? "help" : namedOffline ?? (version ? "version" : "help"), path: node.path, json };
    if (!node.model)
        throw new TypeError("A group requires a command or --help.");
    const callerFlags = Object.create(null);
    const extra = {};
    const model = node.model;
    const selected = new Set();
    for (const [name, tokens] of Object.entries(rawFlags)) {
        if (["help", "json", "version"].includes(name))
            continue;
        const entry = model.flags[name];
        const values = tokens.map(token => tokenValue(entry.definition.value, token, `flag --${name}`, [entry.global ? "globals" : "flags", name]));
        if (entry.help.source === "selector") {
            if (values[0] !== true)
                throw new TypeError("Detail selectors must be selected, not negated.");
            selected.add(name);
        }
        else if (name === "file" || name === "out")
            extra[name] = values[0];
        else
            callerFlags[name] = entry.definition.repeatable ? values : values[0];
    }
    if (selected.size) {
        const matches = Object.entries(model.selectors).filter(([, set]) => set.every(name => selected.has(name)));
        const mostSpecific = matches.filter(([, set]) => !matches.some(([, other]) => other.length > set.length && set.every(name => other.includes(name))));
        if (mostSpecific.length !== 1 || mostSpecific[0][1].length !== selected.size)
            throw new TypeError("Ambiguous or incomplete detail selector set.");
        extra.level = mostSpecific[0][0];
    }
    const args = Object.create(null);
    let offset = 0;
    for (const arg of model.spec.args) {
        if (arg.variadic) {
            args[arg.name] = positionals.slice(offset).map(value => tokenValue(arg.value, value, `argument <${arg.name}>`, ["args", arg.name]));
            offset = positionals.length;
        }
        else if (offset < positionals.length)
            args[arg.name] = tokenValue(arg.value, positionals[offset++], `argument <${arg.name}>`, ["args", arg.name]);
    }
    if (offset < positionals.length)
        throw new TypeError("Unexpected positional argument.");
    if (passthrough !== undefined)
        extra.passthrough = passthrough;
    return { kind: "leaf", node, input: checkCaller(model, { args, flags: callerFlags, ...extra }, false), json };
}
//# sourceMappingURL=parser.js.map