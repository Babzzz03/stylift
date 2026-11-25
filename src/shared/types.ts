// ── Deterministic token shapes (produced entirely by the page extractor) ──────
// CRITICAL CONTRACT: every VALUE in here is measured from the rendered page.
// The DeepSeek polish layer may only attach NAMES / ROLES / DESCRIPTIONS — never
// invent or alter a value.

export interface TokenMeta {
  url: string;
  title: string;
  extractedAt: string;
}

export interface ColorToken {
  value: string; // normalized lowercase hex, e.g. "#fdfcfc" or "#fdfcfc80" (with alpha)
  cssVar: string | null; // matched :root custom property name, if any
  count: number;
  usedOn: Record<string, number>; // property -> count, e.g. { "background-color": 800, "fill": 0 }
  sampleSelectors: string[]; // up to a few representative selectors
}

export interface FontFamilyToken {
  family: string;
  count: number;
  weights: number[];
  sizes: string[];
  likelyRole: "display" | "body" | "mono" | "ui";
}

export interface TypeScaleStep {
  size: string;
  weight: number;
  lineHeight: string;
  letterSpacing: string;
  family: string;
  count: number;
}

export interface FontFace {
  family: string;
  weight: number | string;
  style: string;
  format: string;
  src: string;
}

export interface Typography {
  families: FontFamilyToken[];
  scale: TypeScaleStep[];
  fontFaces: FontFace[];
}

export interface CountedValue {
  value: string;
  count: number;
}

export interface ShadowToken {
  value: string;
  blur: number;
  spread: number;
  opacity: number;
  count: number;
}

export interface AssetEntry {
  url: string;
  type: string; // file extension or, for inline assets, the mime subtype (png/webp/…)
  inline?: boolean; // true for data: URIs (embedded base64)
  bytes?: number; // decoded size for inline assets, when known
}

export interface Assets {
  fonts: AssetEntry[];
  images: AssetEntry[];
  videos: AssetEntry[];
  models: AssetEntry[];
}

export interface DesignTokens {
  meta: TokenMeta;
  colors: ColorToken[];
  cssVariables: Record<string, string>;
  typography: Typography;
  radii: CountedValue[];
  shadows: ShadowToken[];
  spacing: CountedValue[];
  assets: Assets;
}

// ── DeepSeek enrichment shapes (names / roles / guidance only) ────────────────

export interface ColorEnrichment {
  value: string; // must echo back one of the measured color values
  name: string; // evocative token name
  role: string; // grounded role description
}

export interface FontEnrichment {
  family: string;
  role: string;
  substitutes: string[]; // open-source substitute fonts
}

export interface Enrichment {
  theme: string; // one-line poetic tagline
  colors: ColorEnrichment[];
  fonts: FontEnrichment[];
  do: string[];
  dont: string[];
}

// ── Component inspection (deterministic subtree analysis) ─────────────────────
// Point at one section/card and reverse-engineer how it's built. Same contract:
// structure and CSS VALUES come from the page; DeepSeek only explains and guides.

export interface ComponentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnimationInfo {
  selector: string; // where the animation runs, within the subtree
  name: string;
  duration: string;
  timingFunction: string;
  iterationCount: string;
  delay: string;
  direction: string;
  fillMode: string;
  source: "css" | "script" | "hover"; // CSS @keyframes, JS/WAAPI, or a :hover rule
}

export interface TransitionInfo {
  selector: string;
  property: string;
  duration: string;
  timingFunction: string;
  delay: string;
}

export interface TriggerRule {
  selectorText: string; // e.g. ".card:hover" — what state drives a change
  css: string; // the declarations inside that rule
}

export interface KeyframesBlock {
  name: string;
  css: string; // verbatim @keyframes block from the stylesheet
}

export interface StyleDigest {
  selector: string;
  label: string;
  styles: Record<string, string>; // curated, denoised computed styles
}

export interface ComponentTokens {
  colors: string[];
  fonts: string[];
  radii: string[];
  shadows: string[];
  gradients: string[];
  spacing: string[];
}

export interface ComponentBlueprint {
  label: string;
  selector: string;
  rect: ComponentRect;
  nodeCount: number;
  html: string; // cleaned outerHTML of the section
  techniques: string[]; // deterministically detected architecture techniques
  animations: AnimationInfo[];
  transitions: TransitionInfo[];
  keyframes: KeyframesBlock[];
  triggers: TriggerRule[]; // :hover / :focus / :active rules matching the subtree
  digests: StyleDigest[]; // curated computed styles for root + notable nodes
  tokens: ComponentTokens;
  assets: {
    images: AssetEntry[]; // <img>, background/mask url(), <use>/<image> refs
    videos: AssetEntry[];
    svgs: InlineSvg[]; // inline <svg> markup, copyable as-is
  };
}

export interface InlineSvg {
  label: string;
  markup: string; // the (possibly truncated) outerHTML of the <svg>
}

// DeepSeek's grounded explanation of a component (no invented values).
export interface ComponentExplanation {
  summary: string;
  techniques: { title: string; detail: string }[];
  steps: string[];
  gotchas: string[];
}

// ── Live edit overrides ───────────────────────────────────────────────────────
// User edits are stored as CSS overrides keyed by a selector, so they re-apply to
// re-rendered elements for free and export cleanly.

export interface SelectorEdit {
  props: Record<string, string>; // base/desktop structured controls
  states?: Record<string, Record<string, string>>; // pseudo states: { hover: {prop:val} }
  responsive?: Record<string, Record<string, string>>; // breakpoints: { tablet:{}, mobile:{} }
  css?: string; // optional raw declarations for power users
  text?: string; // replacement text content (for text-leaf elements)
  html?: string; // replacement innerHTML (from inline visual-editor edits)
  attrs?: Record<string, string>; // attribute edits (src, href, alt, poster, …)
  label?: string; // human label for the targeted element
}

// Breakpoint max-widths used for responsive overrides.
export const BREAKPOINTS: Record<string, number> = { tablet: 1024, mobile: 640 };

export type StyleOverrides = Record<string, SelectorEdit>; // selector -> edit

// chrome.storage.local["stylelift:overrides"] = { [origin]: StyleOverrides }
export const OVERRIDES_KEY = "stylelift:overrides";

// Structural edits (DOM ops). Order-dependent; replayed on reload (best-effort).
export type StructOpKind =
  | "duplicate"
  | "moveUp"
  | "moveDown"
  | "delete"
  | "insert"
  | "moveBefore";
export interface StructOp {
  selector: string;
  op: StructOpKind;
  label?: string;
  html?: string; // for "insert"
  position?: "before" | "after" | "append"; // for "insert"
  targetSelector?: string; // for "moveBefore" (drag-to-reorder)
}
// chrome.storage.local["stylelift:structops"] = { [origin]: StructOp[] }
export const STRUCT_KEY = "stylelift:structops";

// ── Messaging contract (panel <-> background) ─────────────────────────────────

export interface PolishRequest {
  type: "POLISH";
  tokens: DesignTokens;
}

export interface PolishResponse {
  ok: boolean;
  enrichment?: Enrichment;
  error?: string;
}

export interface ExplainComponentRequest {
  type: "EXPLAIN_COMPONENT";
  blueprint: ComponentBlueprint;
}

export interface ExplainComponentResponse {
  ok: boolean;
  explanation?: ComponentExplanation;
  error?: string;
}

export type RuntimeMessage = PolishRequest | ExplainComponentRequest;

// ── Settings ──────────────────────────────────────────────────────────────────

export interface Settings {
  deepseekApiKey: string;
  deepseekModel: string;
}

export const DEFAULT_MODEL = "deepseek-chat";
