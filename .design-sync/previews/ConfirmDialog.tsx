import * as React from "react";
import * as S from "@ds-stories/src/components/ConfirmDialog.stories";

// Owned preview. ConfirmDialog renders a `position:fixed` centered modal (overlay +
// card). The single-mode card's containment box has ~0 height, so the fixed modal
// resolves against the viewport and clips at the top (title cut off). Wrapping each
// story in a sized, transformed container makes that container the modal's
// containing block (transform creates one for position:fixed), so the modal lands
// fully visible. The Closed story (open:false) renders nothing — the wrapper is an
// empty sized box, matching the storybook's empty canvas.

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
      { style: { position: "relative", transform: "translateZ(0)", width: "100%", minHeight: 360 } },
      fn(),
    );
}

export const Default = wrap(compose(S, "Default"));
export const Danger = wrap(compose(S, "Danger"));
export const CustomLabels = wrap(compose(S, "CustomLabels"));
export const Closed = wrap(compose(S, "Closed"));
