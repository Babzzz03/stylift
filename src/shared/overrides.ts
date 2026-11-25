import { BREAKPOINTS, type StyleOverrides } from "./types";

function declList(props: Record<string, string>, bang: string): string[] {
  const decls: string[] = [];
  for (const [prop, value] of Object.entries(props || {})) {
    if (value == null || value === "") continue;
    decls.push(`  ${prop}: ${value}${bang};`);
  }
  return decls;
}

// Pure: turn the override model into a CSS stylesheet (base + :hover/:focus states
// + responsive @media). Shared by the panel (live apply + export) and the
// background worker (re-apply on reload).
export function overridesToCss(overrides: StyleOverrides, important = true): string {
  const bang = important ? " !important" : "";
  const blocks: string[] = [];
  const media: Record<string, string[]> = {};
  for (const [selector, edit] of Object.entries(overrides)) {
    if (!edit) continue;
    const decls = declList(edit.props || {}, bang);
    if (edit.css && edit.css.trim()) decls.push("  " + edit.css.trim());
    if (decls.length) blocks.push(`${selector} {\n${decls.join("\n")}\n}`);

    for (const [stateName, props] of Object.entries(edit.states || {})) {
      const sd = declList(props, bang);
      if (sd.length) blocks.push(`${selector}:${stateName} {\n${sd.join("\n")}\n}`);
    }
    for (const [bp, props] of Object.entries(edit.responsive || {})) {
      const rd = declList(props, bang);
      if (!rd.length) continue;
      (media[bp] = media[bp] || []).push(`${selector} {\n${rd.join("\n")}\n}`);
    }
  }
  for (const [bp, rules] of Object.entries(media)) {
    const max = BREAKPOINTS[bp];
    if (!max || !rules.length) continue;
    blocks.push(`@media (max-width: ${max}px) {\n${rules.join("\n\n")}\n}`);
  }
  return blocks.join("\n\n");
}

export function countEdits(overrides: StyleOverrides): number {
  let n = 0;
  for (const edit of Object.values(overrides)) {
    if (!edit) continue;
    n += Object.values(edit.props || {}).filter((v) => v !== "" && v != null).length;
    for (const s of Object.values(edit.states || {})) n += Object.keys(s).length;
    for (const r of Object.values(edit.responsive || {})) n += Object.keys(r).length;
    if (edit.css && edit.css.trim()) n += 1;
    if (typeof edit.text === "string") n += 1;
    if (typeof edit.html === "string") n += 1;
    if (edit.attrs) n += Object.keys(edit.attrs).length;
  }
  return n;
}

// Selector -> [name, value] attribute edits (src, href, alt, poster, …).
export function attrTriples(overrides: StyleOverrides): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const [selector, edit] of Object.entries(overrides)) {
    if (!edit || !edit.attrs) continue;
    for (const [name, value] of Object.entries(edit.attrs)) out.push([selector, name, value]);
  }
  return out;
}

// Selector -> replacement text pairs (only edits that change the words).
export function textPairs(overrides: StyleOverrides): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [selector, edit] of Object.entries(overrides)) {
    if (edit && typeof edit.text === "string") pairs.push([selector, edit.text]);
  }
  return pairs;
}

// Selector -> replacement innerHTML pairs (from inline visual edits).
export function htmlPairs(overrides: StyleOverrides): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [selector, edit] of Object.entries(overrides)) {
    if (edit && typeof edit.html === "string") pairs.push([selector, edit.html]);
  }
  return pairs;
}
