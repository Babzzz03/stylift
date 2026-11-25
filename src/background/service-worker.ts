import {
  DEFAULT_MODEL,
  OVERRIDES_KEY,
  STRUCT_KEY,
  type ComponentBlueprint,
  type ComponentExplanation,
  type DesignTokens,
  type Enrichment,
  type ExplainComponentResponse,
  type PolishResponse,
  type RuntimeMessage,
  type Settings,
  type StructOp,
  type StyleOverrides,
} from "../shared/types";
import { overridesToCss, textPairs, htmlPairs, attrTriples } from "../shared/overrides";
import { applyEdits, applyStructuralOps } from "../extractor/edit";

// Open the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn("setPanelBehavior failed:", e));
});

// Re-apply a site's saved edits whenever one of its pages finishes loading, so
// live edits persist across reloads and navigations within the same origin.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !tab.url || !/^https?:/.test(tab.url)) return;
  let origin: string;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return;
  }
  chrome.storage.local.get([OVERRIDES_KEY, STRUCT_KEY]).then((data) => {
    const overrides = ((data[OVERRIDES_KEY] || {}) as Record<string, StyleOverrides>)[origin];
    const ops = ((data[STRUCT_KEY] || {}) as Record<string, StructOp[]>)[origin];
    const hasOverrides = overrides && Object.keys(overrides).length > 0;
    const hasOps = ops && ops.length > 0;
    if (!hasOverrides && !hasOps) return;

    // structural replay first (so cloned/moved elements exist before styling)
    if (hasOps) {
      chrome.scripting
        .executeScript({ target: { tabId }, func: applyStructuralOps, args: [ops] })
        .catch(() => {});
    }
    if (hasOverrides) {
      const css = overridesToCss(overrides);
      const text = textPairs(overrides);
      const html = htmlPairs(overrides);
      const attrs = attrTriples(overrides);
      chrome.scripting
        .executeScript({ target: { tabId }, func: applyEdits, args: [css, text, html, attrs] })
        .catch(() => {
          /* tab not scriptable */
        });
    }
  });
});

// The DeepSeek API key lives here, in the worker — it never reaches page context.
chrome.runtime.onMessage.addListener(
  (
    msg: RuntimeMessage,
    _sender,
    sendResponse: (r: PolishResponse | ExplainComponentResponse) => void,
  ) => {
    if (msg?.type === "POLISH") {
      polish(msg.tokens)
        .then((enrichment) => sendResponse({ ok: true, enrichment }))
        .catch((err) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
      return true; // keep the message channel open for the async response
    }
    if (msg?.type === "EXPLAIN_COMPONENT") {
      explainComponent(msg.blueprint)
        .then((explanation) => sendResponse({ ok: true, explanation }))
        .catch((err) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
      return true;
    }
    if ((msg as { type?: string })?.type === "AI_EDIT") {
      aiEdit(msg as unknown as AiEditRequest)
        .then((patch) => sendResponse({ ok: true, patch } as unknown as PolishResponse))
        .catch((err) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
      return true;
    }
    return false;
  },
);

// ── AI chat-to-edit ────────────────────────────────────────────────────────────
interface AiEditRequest {
  instruction: string;
  selector: string;
  label: string;
  tag: string;
  values: Record<string, string>;
  text: string;
}
async function aiEdit(req: AiEditRequest): Promise<{ props?: Record<string, string>; text?: string }> {
  const s = (await chrome.storage.local.get(["deepseekApiKey", "deepseekModel"])) as Partial<Settings>;
  if (!s.deepseekApiKey) throw new Error("No DeepSeek API key set.");
  const model = s.deepseekModel || DEFAULT_MODEL;
  const system =
    "You are a CSS/UX assistant inside a visual web editor. Given one element (its tag, its " +
    "current computed styles, and its text) and a plain-English instruction, return ONLY the " +
    "minimal set of changes. Respond with STRICT JSON: " +
    '{"props": {"css-prop": "value"}, "text": "new text or omit"}. Use real CSS property names ' +
    "and values. Omit anything you are not changing. No prose, no markdown.";
  const user =
    `Element: <${req.tag}> (${req.label})\n` +
    `Current styles: ${JSON.stringify(req.values)}\n` +
    (req.text ? `Current text: ${JSON.stringify(req.text)}\n` : "") +
    `Instruction: ${req.instruction}\n` +
    'Return JSON like {"props":{"color":"#1a1a1a","font-weight":"700"},"text":"…"}';
  const content = await chatJSON(system, user, s.deepseekApiKey, model);
  let str = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const a = str.indexOf("{");
  const b = str.lastIndexOf("}");
  if (a !== -1 && b !== -1) str = str.slice(a, b + 1);
  let obj: { props?: Record<string, string>; text?: string };
  try {
    obj = JSON.parse(str);
  } catch {
    throw new Error("DeepSeek returned malformed JSON.");
  }
  const props: Record<string, string> = {};
  if (obj.props && typeof obj.props === "object") {
    for (const [k, v] of Object.entries(obj.props)) {
      if (typeof v === "string" || typeof v === "number") props[k] = String(v);
    }
  }
  return { props, text: typeof obj.text === "string" ? obj.text : undefined };
}

// ── DeepSeek polish ──────────────────────────────────────────────────────────

async function polish(tokens: DesignTokens): Promise<Enrichment> {
  const s = (await chrome.storage.local.get([
    "deepseekApiKey",
    "deepseekModel",
  ])) as Partial<Settings>;
  if (!s.deepseekApiKey) {
    throw new Error("No DeepSeek API key set. Open settings to add one.");
  }
  const model = s.deepseekModel || DEFAULT_MODEL;

  const payload = compactForPrompt(tokens);
  const system =
    "You are a design-system documentarian. You are given design tokens that were " +
    "measured deterministically from a live web page. You must NOT invent or change any " +
    "values — you only NAME and DESCRIBE what was measured. Every color role MUST be " +
    "justified by the supplied `usedOn` counts and `sampleSelectors`; do not claim a usage " +
    "the data does not support. Respond with STRICT JSON only — no prose, no markdown fences.";

  const user =
    "Token data (values are ground truth, do not alter them):\n" +
    JSON.stringify(payload) +
    "\n\nReturn JSON with EXACTLY this shape:\n" +
    `{
  "theme": "one-line poetic tagline for the overall aesthetic",
  "colors": [{"value":"<echo an exact measured hex>","name":"evocative name","role":"role grounded in usedOn/sampleSelectors"}],
  "fonts": [{"family":"<measured family>","role":"role","substitutes":["open-source substitute fonts"]}],
  "do": ["actionable DO guidelines inferred from the patterns"],
  "dont": ["actionable DON'T guidelines, e.g. a color seen only in SVG fills is decorative, never a UI affordance"]
}\n` +
    "Echo each color's `value` exactly as given. Cover the most significant colors and every font.";

  const content = await chatJSON(system, user, s.deepseekApiKey, model);
  const parsed = parseEnrichment(content);
  return sanitizeAgainstTokens(parsed, tokens);
}

// Shared OpenAI-compatible chat call that returns the raw assistant message text.
async function chatJSON(
  system: string,
  user: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const resp = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.6,
      response_format: { type: "json_object" },
      stream: false,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`DeepSeek ${resp.status}: ${body.slice(0, 200) || resp.statusText}`);
  }
  const data = await resp.json();
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("DeepSeek returned an empty response.");
  return content;
}

// ── Component explanation ──────────────────────────────────────────────────────

async function explainComponent(bp: ComponentBlueprint): Promise<ComponentExplanation> {
  const s = (await chrome.storage.local.get([
    "deepseekApiKey",
    "deepseekModel",
  ])) as Partial<Settings>;
  if (!s.deepseekApiKey) {
    throw new Error("No DeepSeek API key set. Open settings to add one.");
  }
  const model = s.deepseekModel || DEFAULT_MODEL;

  const system =
    "You are a senior front-end engineer explaining how a UI component is built. You are " +
    "given a blueprint that was measured deterministically from a live page: its cleaned HTML, " +
    "detected techniques, animations, transitions, @keyframes, interaction rules, curated " +
    "computed styles, and the tokens it uses. You must NOT invent CSS values, selectors, or " +
    "keyframes — explain ONLY what the blueprint contains, and ground every claim in it. Be " +
    "concrete and practical. Respond with STRICT JSON only — no prose, no markdown fences.";

  const user =
    "Component blueprint (ground truth):\n" +
    JSON.stringify(compactBlueprint(bp)) +
    "\n\nReturn JSON with EXACTLY this shape:\n" +
    `{
  "summary": "one short paragraph: what this component is and the core approach behind it",
  "techniques": [{"title":"a technique actually present in the blueprint","detail":"how/why it is used here, referencing the measured CSS"}],
  "steps": ["ordered, concrete steps to rebuild it from scratch using the measured structure and values"],
  "gotchas": ["pitfalls or non-obvious details a developer should know when replicating it"]
}`;

  const content = await chatJSON(system, user, s.deepseekApiKey, model);
  return sanitizeExplanation(parseExplanation(content));
}

// Trim the blueprint so the prompt stays focused (and within budget).
function compactBlueprint(bp: ComponentBlueprint) {
  return {
    label: bp.label,
    rect: bp.rect,
    nodeCount: bp.nodeCount,
    techniques: bp.techniques,
    animations: bp.animations,
    transitions: bp.transitions.slice(0, 12),
    keyframes: bp.keyframes,
    triggers: bp.triggers.slice(0, 16),
    digests: bp.digests.slice(0, 16),
    tokens: bp.tokens,
    html: bp.html.slice(0, 4000),
  };
}

function parseExplanation(raw: string): ComponentExplanation {
  let str = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const first = str.indexOf("{");
  const last = str.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) str = str.slice(first, last + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(str);
  } catch {
    throw new Error("DeepSeek returned malformed JSON.");
  }
  const o = obj as Partial<ComponentExplanation>;
  return {
    summary: typeof o.summary === "string" ? o.summary : "",
    techniques: Array.isArray(o.techniques) ? o.techniques : [],
    steps: Array.isArray(o.steps) ? o.steps : [],
    gotchas: Array.isArray(o.gotchas) ? o.gotchas : [],
  };
}

function sanitizeExplanation(e: ComponentExplanation): ComponentExplanation {
  return {
    summary: String(e.summary || "").slice(0, 600),
    techniques: e.techniques
      .filter((t) => t && (t.title || t.detail))
      .map((t) => ({
        title: String(t.title ?? "").slice(0, 80),
        detail: String(t.detail ?? "").slice(0, 300),
      }))
      .slice(0, 10),
    steps: e.steps.map((x) => String(x).slice(0, 300)).slice(0, 12),
    gotchas: e.gotchas.map((x) => String(x).slice(0, 240)).slice(0, 8),
  };
}

// Trim the token object down to what the model needs to name/describe.
function compactForPrompt(t: DesignTokens) {
  return {
    meta: { title: t.meta.title, url: t.meta.url },
    colors: t.colors.slice(0, 24).map((c) => ({
      value: c.value,
      cssVar: c.cssVar,
      count: c.count,
      usedOn: c.usedOn,
      sampleSelectors: c.sampleSelectors,
    })),
    typography: {
      families: t.typography.families.map((f) => ({
        family: f.family,
        count: f.count,
        weights: f.weights,
        sizes: f.sizes,
        likelyRole: f.likelyRole,
      })),
    },
    radii: t.radii.slice(0, 8),
    shadows: t.shadows.slice(0, 8).map((s) => ({ value: s.value, opacity: s.opacity })),
  };
}

// Strip stray fences and parse defensively.
function parseEnrichment(raw: string): Enrichment {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  // grab the outermost JSON object if there is surrounding prose
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    throw new Error("DeepSeek returned malformed JSON.");
  }
  const o = obj as Partial<Enrichment>;
  return {
    theme: typeof o.theme === "string" ? o.theme : "",
    colors: Array.isArray(o.colors) ? o.colors : [],
    fonts: Array.isArray(o.fonts) ? o.fonts : [],
    do: Array.isArray(o.do) ? o.do : [],
    dont: Array.isArray(o.dont) ? o.dont : [],
  };
}

// Enforce the core contract: the model may only attach names/roles to values that
// actually exist in the measured tokens. Anything it invents is dropped.
function sanitizeAgainstTokens(e: Enrichment, t: DesignTokens): Enrichment {
  const validColors = new Set(t.colors.map((c) => c.value.toLowerCase()));
  const validFonts = new Set(t.typography.families.map((f) => f.family.toLowerCase()));
  return {
    theme: e.theme.slice(0, 200),
    colors: e.colors
      .filter((c) => c && typeof c.value === "string" && validColors.has(c.value.toLowerCase()))
      .map((c) => ({
        value: c.value.toLowerCase(),
        name: String(c.name ?? "").slice(0, 60),
        role: String(c.role ?? "").slice(0, 160),
      })),
    fonts: e.fonts
      .filter((f) => f && typeof f.family === "string" && validFonts.has(f.family.toLowerCase()))
      .map((f) => ({
        family: f.family,
        role: String(f.role ?? "").slice(0, 120),
        substitutes: Array.isArray(f.substitutes)
          ? f.substitutes.map((x) => String(x)).slice(0, 5)
          : [],
      })),
    do: e.do.map((x) => String(x)).slice(0, 8),
    dont: e.dont.map((x) => String(x)).slice(0, 8),
  };
}
