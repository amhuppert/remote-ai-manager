import * as React from "react";
import * as S from "@ds-stories/src/components/MergeToast.stories";

// Owned preview. MergeToast renders `position:fixed bottom-lg left-1/2` (a
// bottom-center toast) with a slide-in animation. The single-mode card's
// containment box (`.ds-single{transform:translateZ(0)}`) has ~0 height, so the
// toast's `bottom` resolves above it and clips at the top. Wrapping each story in
// a sized, transformed container makes that container the toast's containing block
// (transform creates one for position:fixed), so the toast lands visibly. The
// toast still renders with its real fixed/animated behavior — only its viewport
// is given height.

function compose(S: any, key: string) {
  const meta: any = S.default ?? {};
  const st: any = S[key];
  const args: any = { ...(meta.args ?? {}), ...(st && st.args ? st.args : {}) };
  const at: any = { ...(meta.argTypes ?? {}), ...(st && st.argTypes ? st.argTypes : {}) };
  for (const k of Object.keys(args)) {
    const m = at[k] && at[k].mapping;
    if (m && typeof m === "object" && args[k] in m) args[k] = m[args[k]];
  }
  const title: string = typeof meta.title === "string" ? meta.title : "";
  const ctx: any = {
    args, name: key, title, kind: title, id: "", componentId: "",
    globals: {}, viewMode: "story",
    parameters: (st && st.parameters) ?? meta.parameters ?? {},
  };
  let render: (() => any) | null = null;
  if (st && typeof st.render === "function") render = () => st.render(args, ctx);
  else if (typeof st === "function") render = () => st(args, ctx);
  else if (typeof meta.render === "function") render = () => meta.render(args, ctx);
  else {
    const C = (st && st.component) || meta.component;
    if (C) render = () => React.createElement(C, args);
  }
  if (!render) return () => null;
  const decorators: any[] = ([] as any[]).concat((st && st.decorators) ?? []).concat(meta.decorators ?? []);
  return decorators.reduce((inner: any, dec: any) => () => {
    const out = dec(inner, ctx);
    return out === undefined ? inner() : out;
  }, render);
}

function wrap(fn: () => any) {
  return () =>
    React.createElement(
      "div",
      { style: { position: "relative", transform: "translateZ(0)", width: "100%", minHeight: 140 } },
      fn(),
    );
}

export const Success = wrap(compose(S, "Success"));
export const Conflicts = wrap(compose(S, "Conflicts"));
export const SingleConflict = wrap(compose(S, "SingleConflict"));
export const Error = wrap(compose(S, "Error"));
export const LongBranchName = wrap(compose(S, "LongBranchName"));
export const ChildSessionSuccess = wrap(compose(S, "ChildSessionSuccess"));
export const ChildSessionConflicts = wrap(compose(S, "ChildSessionConflicts"));
export const ReadyToLand = wrap(compose(S, "ReadyToLand"));
