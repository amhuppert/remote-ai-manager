/**
 * Tailwind migration guardrail ESLint rules (Stage A, post-pilot — design task
 * 5.2, requirements 7.5 / 8.3 / 8.4). One plugin, four rules:
 *
 *   no-dynamic-class                 (8.3) dynamically-constructed class strings
 *   no-hardcoded-color               (8.3) hard-coded colors (hex/rgb/rgba/hsl)
 *   no-appearance-in-layout-classname(8.3) appearance utilities in layoutClassName
 *   no-unapproved-global-css         (8.4) new global CSS outside approved areas
 *
 * The three JS/TSX rules are scoped (in eslint.config.mjs) to MIGRATED,
 * utility-first surfaces — they would false-positive on legacy BEM/conditional
 * classNames, which Stage A intentionally leaves untouched. The CSS rule runs on
 * all stylesheets and only fires for files outside the approved foundation/vendor
 * areas. See docs/tailwind-conventions.md §1.1, §1.2, §2.
 *
 * The class string passed to className / layoutClassName / cn() is rarely an
 * inline literal in migrated code — the sanctioned authoring pattern is extracted
 * const strings and static class MAPS (ProjectCard's CARD_* consts; the
 * primitives' variantClass/sizeClass/statusAppearance/toneClass records). So all
 * three JS rules resolve the value expression through `resolveValueExprs`:
 * const identifiers, static-object member access (`map.key` and `map[dynamic]` →
 * all values), logical/ternary branches, arrays, and binary/template assembly.
 * A violation is reported at the resolved literal's own location.
 *
 * no-hardcoded-color flags ANY raw color literal — hex (#abc…) and the
 * rgb()/rgba()/hsl()/hsla() functions. Custom-alpha glows/shadows/borders with no
 * solid-color token are extracted to `--cc-*` custom properties (tokens.css) and
 * referenced via `var(--…)`; var()/gradient/keyword values carry no raw literal.
 */

/** Raw color literal: a #hex, or an rgb()/rgba()/hsl()/hsla() function call.
 *  The function-name boundary is a non-letter lookbehind (not `\b`) because
 *  Tailwind encodes spaces as `_` in arbitrary values (`shadow-[0_0_6px_rgba(…)]`),
 *  and `_` is a word char so `\b` would miss `_rgba(`. */
const COLOR_LITERAL =
  /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z])|(?<![a-zA-Z])(?:rgba?|hsla?)\(/;

/** Base utility prefixes permitted in layoutClassName (external geometry only). */
const LAYOUT_ALLOWED = [
  "m",
  "mt",
  "mr",
  "mb",
  "ml",
  "mx",
  "my",
  "ms",
  "me",
  "col",
  "col-start",
  "col-end",
  "col-span",
  "row",
  "row-start",
  "row-end",
  "row-span",
  "justify-self",
  "self",
  "place-self",
  "order",
  "w",
  "min-w",
  "max-w",
  "basis",
  "grow",
  "shrink",
];

/** Strip leading (bracket-free) variant prefixes and a negative sign → base token core. */
function stripVariants(token) {
  // remove `hover:` / `max-768:` / `sm:` style prefixes (no brackets)
  const noVariants = token.replace(/^(?:[a-zA-Z0-9_-]+:)+/, "");
  return noVariants.replace(/^-/, "");
}

/** True iff a layoutClassName token is an allowed external-geometry utility. */
function isLayoutUtility(token) {
  if (!token) return true; // empty segment
  const core = stripVariants(token);
  return LAYOUT_ALLOWED.some((p) => {
    if (core === p) return true;
    return core.startsWith(p + "-") || core.startsWith(p + "[");
  });
}

// ---------------------------------------------------------------------------
// Value resolution: follow const identifiers and static-map member access so the
// rules inspect the strings migrated code actually authors (constants + maps).
// ---------------------------------------------------------------------------

/** VariableDeclarator initializer expressions for an Identifier's binding. */
function varInits(idNode, sourceCode) {
  let scope = sourceCode.getScope(idNode);
  while (scope) {
    const variable = scope.variables.find((v) => v.name === idNode.name);
    if (variable) {
      return variable.defs
        .filter(
          (d) => d.node && d.node.type === "VariableDeclarator" && d.node.init,
        )
        .map((d) => d.node.init);
    }
    scope = scope.upper;
  }
  return [];
}

/** Candidate property-value expressions for a member access: the matching static
 *  key, or EVERY value when the key is computed-dynamic (any may be selected). */
function memberValues(node, sourceCode, seen) {
  let key = null;
  if (!node.computed && node.property.type === "Identifier") {
    key = node.property.name;
  } else if (node.property.type === "Literal") {
    key = String(node.property.value);
  }
  const out = [];
  for (const objExpr of resolveValueExprs(node.object, sourceCode, seen)) {
    if (objExpr.type !== "ObjectExpression") continue;
    for (const prop of objExpr.properties) {
      if (prop.type !== "Property") continue;
      const pkey =
        prop.key.type === "Identifier" && !prop.computed
          ? prop.key.name
          : prop.key.type === "Literal"
            ? String(prop.key.value)
            : null;
      if (key === null || pkey === key) out.push(prop.value);
    }
  }
  return out;
}

/** Resolve an expression to the terminal value expressions it can hold, following
 *  const identifiers, static-object member access, logical/ternary branches, and
 *  arrays. Terminals (Literal / TemplateLiteral / BinaryExpression /
 *  CallExpression / ObjectExpression / …) are returned for the caller to inspect. */
function resolveValueExprs(node, sourceCode, seen) {
  if (!node || seen.has(node)) return [];
  switch (node.type) {
    case "Identifier":
      seen.add(node);
      return varInits(node, sourceCode).flatMap((init) =>
        resolveValueExprs(init, sourceCode, seen),
      );
    case "MemberExpression":
      seen.add(node);
      return memberValues(node, sourceCode, seen).flatMap((val) =>
        resolveValueExprs(val, sourceCode, seen),
      );
    case "LogicalExpression":
      return [
        ...resolveValueExprs(node.left, sourceCode, seen),
        ...resolveValueExprs(node.right, sourceCode, seen),
      ];
    case "ConditionalExpression":
      return [
        ...resolveValueExprs(node.consequent, sourceCode, seen),
        ...resolveValueExprs(node.alternate, sourceCode, seen),
      ];
    case "ArrayExpression":
      return node.elements.flatMap((el) =>
        resolveValueExprs(el, sourceCode, seen),
      );
    default:
      return [node];
  }
}

/** All string segments (value + node) reachable from `node`, fully resolving
 *  identifiers/members and descending templates/binaries. For the string-content
 *  rules (color, appearance). */
function collectStrings(node, sourceCode, seen, out) {
  for (const term of resolveValueExprs(node, sourceCode, seen)) {
    if (term.type === "Literal" && typeof term.value === "string") {
      out.push({ value: term.value, node: term });
    } else if (term.type === "TemplateLiteral") {
      for (const q of term.quasis) out.push({ value: q.value.raw, node: q });
      for (const e of term.expressions)
        collectStrings(e, sourceCode, seen, out);
    } else if (term.type === "BinaryExpression") {
      collectStrings(term.left, sourceCode, seen, out);
      collectStrings(term.right, sourceCode, seen, out);
    }
    // CallExpression / ObjectExpression / unresolved → no string content
  }
}

/** A template literal "glues" an interpolation into a class token iff any
 *  expression sits adjacent (no surrounding whitespace) to non-empty quasi text —
 *  i.e. it builds a partial token like `bg-${x}-500`. A space-separated
 *  composition of complete strings (`${A} ${B}`) does NOT glue and is allowed. */
function templateGluesToken(node) {
  const q = node.quasis;
  for (let i = 0; i < node.expressions.length; i++) {
    const before = q[i].value.raw;
    const after = q[i + 1].value.raw;
    if (before.length > 0 && !/\s$/.test(before)) return true;
    if (after.length > 0 && !/^\s/.test(after)) return true;
  }
  return false;
}

/** A `+` expression is static iff every leaf is a string literal. */
function binaryIsStaticString(node) {
  if (node.type === "Literal") return typeof node.value === "string";
  if (node.type === "BinaryExpression" && node.operator === "+")
    return binaryIsStaticString(node.left) && binaryIsStaticString(node.right);
  return false;
}

function isDynamicClassExpr(node) {
  if (!node) return false;
  if (node.type === "TemplateLiteral")
    return node.expressions.length > 0 && templateGluesToken(node);
  if (node.type === "BinaryExpression" && node.operator === "+")
    return !binaryIsStaticString(node);
  return false;
}

const CLASS_ATTRS = new Set(["className", "layoutClassName"]);

/** The value expression of a className/layoutClassName JSX attribute (or null). */
function attrValueExpr(node) {
  if (!node.value) return null;
  if (node.value.type === "Literal") return node.value;
  if (node.value.type === "JSXExpressionContainer")
    return node.value.expression;
  return null;
}

const noDynamicClass = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow dynamically-constructed Tailwind class strings; compose complete static strings with cn() and select variants via static class maps.",
    },
    messages: {
      dynamic:
        "Dynamically-constructed Tailwind class string. The compiler and class-sort tooling cannot see interpolated tokens. Compose complete static strings with cn() and pick variants via a static class map keyed by a union (docs/tailwind-conventions.md §1.1).",
    },
    schema: [],
  },
  create(context) {
    const sc = context.sourceCode;
    function check(node) {
      if (!node) return;
      for (const term of resolveValueExprs(node, sc, new Set())) {
        if (isDynamicClassExpr(term)) {
          context.report({ node: term, messageId: "dynamic" });
        }
      }
    }
    return {
      JSXAttribute(node) {
        if (!node.name || !CLASS_ATTRS.has(node.name.name)) return;
        check(attrValueExpr(node));
      },
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "cn")
          return;
        for (const arg of node.arguments) check(arg);
      },
    };
  },
};

const noHardcodedColor = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hard-coded color literals (hex / rgb() / rgba() / hsl()) in Tailwind class strings; reference a design token via a utility or var(--…).",
    },
    messages: {
      color:
        "Hard-coded color '{{color}}' in a Tailwind class. Reference a design token instead — a token utility (e.g. text-text-*, bg-bg-*, border-border-*) for solid colors, or var(--…) inside a composite shadow/filter/gradient utility (extract custom-alpha values to a --cc-* token in tokens.css). See docs/tailwind-conventions.md.",
    },
    schema: [],
  },
  create(context) {
    const sc = context.sourceCode;
    function check(node) {
      if (!node) return;
      const strings = [];
      collectStrings(node, sc, new Set(), strings);
      for (const { value, node: strNode } of strings) {
        const m = COLOR_LITERAL.exec(value);
        if (m)
          context.report({
            node: strNode,
            messageId: "color",
            data: { color: m[0].replace(/\($/, "()") },
          });
      }
    }
    return {
      JSXAttribute(node) {
        if (!node.name || !CLASS_ATTRS.has(node.name.name)) return;
        check(attrValueExpr(node));
      },
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== "cn")
          return;
        for (const arg of node.arguments) check(arg);
      },
    };
  },
};

const noAppearanceInLayoutClassName = {
  meta: {
    type: "problem",
    docs: {
      description:
        "layoutClassName accepts external-geometry utilities only; the primitive owns appearance.",
    },
    messages: {
      appearance:
        "layoutClassName accepts external-geometry utilities only (margin, grid/flex placement, order, self-align, width/basis). '{{cls}}' is not on the layout allowlist — the primitive owns appearance (docs/tailwind-conventions.md §2).",
    },
    schema: [],
  },
  create(context) {
    const sc = context.sourceCode;
    return {
      JSXAttribute(node) {
        if (!node.name || node.name.name !== "layoutClassName") return;
        const strings = [];
        collectStrings(attrValueExpr(node), sc, new Set(), strings);
        for (const { value, node: strNode } of strings) {
          for (const token of value.split(/\s+/)) {
            if (token && !isLayoutUtility(token)) {
              context.report({
                node: strNode,
                messageId: "appearance",
                data: { cls: token },
              });
            }
          }
        }
      },
    };
  },
};

const noUnapprovedGlobalCss = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow new global CSS rules outside approved foundation/vendor areas; author UI with Tailwind utilities.",
    },
    messages: {
      unapproved:
        "New global CSS in '{{file}}' is outside the approved foundation/vendor areas (feature `styles/` dirs are migration DEBT, not an approved boundary). Author migrated UI with Tailwind utilities/primitives instead of new stylesheets. Genuine new foundation/vendor CSS → add its area to `approvedAreas` in eslint.config.mjs (docs/tailwind-conventions.md §5/§7).",
    },
    schema: [
      {
        type: "object",
        properties: {
          // Foundation/vendor directories where authored global CSS is allowed.
          approvedAreas: { type: "array", items: { type: "string" } },
          // Pre-existing legacy feature stylesheets, grandfathered as debt. The
          // ratchet drives their counts down; no NEW global CSS may be added.
          grandfathered: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const approvedAreas = context.options[0]?.approvedAreas ?? [];
    const grandfathered = context.options[0]?.grandfathered ?? [];
    const file = (context.filename ?? "").split("\\").join("/");
    if (
      approvedAreas.some((frag) => file.includes(frag)) ||
      grandfathered.some((frag) => file.includes(frag))
    ) {
      return {};
    }
    let reported = false;
    function report(node) {
      if (reported) return;
      reported = true;
      context.report({
        node,
        messageId: "unapproved",
        data: { file: file.replace(/^.*\/src\//, "src/") },
      });
    }
    // css-tree (via @eslint/css) emits `Rule` for style rules.
    return { Rule: report };
  },
};

const plugin = {
  meta: { name: "tailwind-guardrails", version: "1.0.0" },
  rules: {
    "no-dynamic-class": noDynamicClass,
    "no-hardcoded-color": noHardcodedColor,
    "no-appearance-in-layout-classname": noAppearanceInLayoutClassName,
    "no-unapproved-global-css": noUnapprovedGlobalCss,
  },
};

export default plugin;
