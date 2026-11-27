import type {
  AssetEntry,
  Assets,
  ComponentBlueprint,
  ComponentExplanation,
  DesignTokens,
  Enrichment,
  ExplainComponentResponse,
  PolishResponse,
  Settings,
  StyleOverrides,
  StructOp,
} from "../shared/types";
import { OVERRIDES_KEY, STRUCT_KEY } from "../shared/types";
import { countEdits, overridesToCss, textPairs } from "../shared/overrides";
import { extractDesignTokens } from "../extractor/extract";
import { pickAndInspectComponent } from "../extractor/inspect";
import { injectVisualEditor, stopVisualEditor } from "../extractor/visual-editor";
import { capturePage, type CaptureOptions, type CaptureResult } from "../extractor/capture";
import { settleAnimations } from "../extractor/settle";
import { applyFramerAppear } from "../extractor/framer-appear";
import { createSiteProject, newProjectId, saveProject, saveScenes } from "../shared/projects";
import { addWholeLayout, ensureBreakpointRules, mergeVariantCaptures, needsVariantCapture, needsWholeLayout, unhideLoneVariants, type LayoutLabel } from "./variants";
import { colorToHex, EDIT_TABS, type EditableField } from "./editor";
import { icon } from "./icons";
import { htmlToJsx } from "./jsx";
import { inlineForOffline, inlineStylesheetLinks } from "./offline";
import { buildHtmlProject, buildSiteProject, missingAssets, type FileMap } from "./project";
import { buildReactViteProject, buildNextProject, buildNextSiteProject } from "./react-project";
import { crawlSite, type CrawlPage } from "./crawl";
import { buildElementorTemplate, listSections, type SectionInfo } from "./elementor";
import { buildLiveMirror, buildSiteMirror, type MirrorPage } from "./mirror";
import { addIslandTag, hasIslands, islandFiles, type IslandFiles } from "./islands";
import { makeByteFetcher } from "../shared/fetch-bytes";
import { startPreview, type PreviewSession } from "./preview";
import { buildFigmaBundle } from "./figma-export";
import { SUPPORT_EMAIL, browserLabel, reportMailto, reportText } from "../shared/report";
import { loadPublishSettings, loadTargets, publishNetlify, publishVercel, pushGitHub, saveTarget, slugName, type PublishTargets } from "../shared/publish";
import { loadWp, wpConfigured, wpImport, type WpImportResult } from "../shared/wordpress";
import { downloadBlob as saveText, downloadZip as saveZip } from "./export-helpers";
import { markdownToHtml } from "./markdown";
import { motionRuntimeSource } from "../studio/motion";
import { introRecorderSource } from "../extractor/intro-recorder";
import {
  renderCssVariables,
  renderDesignMd,
  renderDesignTokensJson,
  renderTailwind,
  type Density,
} from "./render";
import {
  componentTabText,
  renderComponentMd,
  type ComponentTab,
} from "./component";

type PageTab = "design" | "tailwind" | "cssvars" | "tokens" | "assets";
type Mode = "page" | "component" | "edit" | "source";

const PAGE_TABS: { id: PageTab; label: string }[] = [
  { id: "design", label: "DESIGN.md" },
  { id: "tailwind", label: "Tailwind v4" },
  { id: "cssvars", label: "CSS Variables" },
  { id: "tokens", label: "Design Tokens" },
  { id: "assets", label: "Assets" },
];
const COMPONENT_TABS: { id: ComponentTab; label: string }[] = [
  { id: "guide", label: "Guide" },
  { id: "structure", label: "Structure" },
  { id: "animations", label: "Animations" },
  { id: "code", label: "Code" },
  { id: "assets", label: "Assets" },
  { id: "tokens", label: "Tokens" },
];

const state = {
  mode: "page" as Mode,
  tokens: null as DesignTokens | null,
  enrichment: null as Enrichment | null,
  component: null as ComponentBlueprint | null,
  explanation: null as ComponentExplanation | null,
  pageTab: "design" as PageTab,
  componentTab: "guide" as ComponentTab,
  density: "compact" as Density,
  hasKey: false,
  // visual edit
  editorActive: false,
  overrides: {} as StyleOverrides,
  structOps: [] as StructOp[],
  origin: "",
  // current selection (pushed from the in-page editor)
  sel: null as null | {
    selector: string;
    label: string;
    tag: string;
    ancestors: { ref: string; label: string; tag: string }[];
    values: Record<string, string>;
    attrs: Record<string, string>;
    bg: string;
    media: { loop: boolean; muted: boolean; autoplay: boolean; controls: boolean } | null;
    canText: boolean;
    text: string;
  },
  editTab: "style",
  scope: "base", // base | hover | tablet | mobile
  canUndo: false,
  canRedo: false,
  aiBusy: false,
  device: "desktop", // responsive preview: desktop | tablet | mobile
  // source capture
  source: {
    scope: "page" as "page" | "site",
    scripts: "strip" as "strip" | "keep",
    reveal: true,
    deferred: true,
    cookies: true,
    intro: true, // reload once with the intro recorder before capturing
    live3d: true, // keep the page's 3D scenes live in the project exports (the site's own code, in frames)
    maxPages: 25,
    maxDepth: 3,
    sitemap: true,
    busy: false,
    cancel: false,
    progress: 0,
    log: [] as string[],
    last: null as CaptureResult | null,
    lastPages: null as CrawlPage[] | null,
    // "Send to WordPress": the captured page and the sections picked for import
    wp: null as null | {
      html: string; title: string; url: string; sections: SectionInfo[]; picked: Set<number>;
      target: "template" | "page"; scoped: boolean; sideload: boolean; busy: boolean;
      result?: WpImportResult; error?: string;
    },
    // the last export, kept for Preview / Download again / Publish (see renderReady)
    ready: null as ReadyExport | null,
    /** the button whose job is running (its spinner; the other buttons wait) */
    running: "",
  },
  // layers tree
  layersOpen: false,
  treeKids: new Map<string, { ref: string; label: string; tag: string; hasChildren: boolean }[]>(),
  treeExpanded: new Set<string>(),
};

// ── element refs ────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const output = $("#output");
const statusEl = $("#status");
// icons named in the static markup (data-icon) — one set shared with Studio
document.querySelectorAll<HTMLElement>("[data-icon]").forEach((el) => el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon || "", 15)));
const metaLine = $("#meta-line");
const modebar = $("#modebar");
const tabsNav = $("#tabs");
const subtoggle = $("#subtoggle");
const extractBtn = $<HTMLButtonElement>("#extract-btn");
const inspectBtn = $<HTMLButtonElement>("#inspect-btn");
const editBtn = $<HTMLButtonElement>("#edit-btn");
const sourceBtn = $<HTMLButtonElement>("#source-btn");
const aiBtn = $<HTMLButtonElement>("#ai-btn");
const copyBtn = $<HTMLButtonElement>("#copy-btn");
const downloadBtn = $<HTMLButtonElement>("#download-btn");
const settingsBtn = $<HTMLButtonElement>("#settings-btn");
$<HTMLButtonElement>("#report-btn").addEventListener("click", () => void openReport());

// Chrome's own wording for common failures → what the user can do about it
const PLAIN_ERRORS: [RegExp, string][] = [
  [/showing error page|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION/i,
    "The page didn't load — Chrome is showing an error page instead of the website. Check your internet connection, reload the page, then try again."],
  [/No tab with id|Tabs cannot be edited right now|tab was closed/i, "The tab was closed or changed while StyleLift was working. Open the page again and retry."],
  [/Cannot access contents of (the )?url|Cannot access a chrome|extensions gallery cannot be scripted/i,
    "Chrome doesn't let extensions read this kind of page (browser pages, the Web Store, other extensions). Open a normal website."],
  [/Another debugger is already attached/i, "Close the DevTools window on this page (Chrome allows one debugger at a time), then try again."],
];
function plainError(msg: string): string {
  if (!msg || !msg.trim()) return "Something went wrong without an error message. Reload the page and try again (details are in the log below).";
  for (const [re, plain] of PLAIN_ERRORS) if (re.test(msg)) return plain;
  return msg;
}
/** Show an export failure, and keep its technical details in the log for support. */
function exportFailed(err: unknown): void {
  const e = err as { name?: string; message?: string; stack?: string } | null;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : e?.message || "";
  srcLog(`✗ ${e?.name || typeof err}: ${msg || "(no message)"}${e?.stack ? " — " + e.stack.split("\n").slice(1, 3).map((l) => l.trim()).join(" ← ") : ""}`.slice(0, 400));
  setStatus(msg, "error");
}
function setStatus(msg: string, kind: "" | "busy" | "error" | "ok" | "warn" = ""): void {
  if (kind === "error") msg = plainError(msg);
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
  if (kind !== "busy" && msg) lastOutcome = msg;
  if (kind === "error") {
    // every failure offers a report (the user sees it before anything is sent)
    const r = document.createElement("button");
    r.className = "link-btn";
    r.dataset.report = "1";
    r.innerHTML = icon("flag", 13) + "Report this problem";
    r.addEventListener("click", () => void openReport());
    statusEl.append(" ", r);
  }
}

// ── Report a problem (sent by the user's own email app; see shared/report.ts) ──────────────────
let lastAction = "";
let lastOutcome = "";
document.addEventListener(
  "click",
  (e) => {
    const b = (e.target as Element | null)?.closest?.("button");
    if (b && !b.dataset.report && !b.closest(".sheet") && b.textContent?.trim()) lastAction = b.textContent.trim().replace(/\s+/g, " ").slice(0, 60);
  },
  true,
);
async function openReport(): Promise<void> {
  document.querySelector(".sheet")?.remove();
  let site = "";
  try {
    site = (await chrome.tabs.get((await activeTab()).id)).url || "";
  } catch {
    /* no tab */
  }
  if (!/^https?:/i.test(site)) site = state.source.ready?.sourceUrl || (/^https?:/i.test(state.origin || "") ? state.origin : "");
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-labelledby", "rp-title");
  sheet.innerHTML = `<div class="sheet-card">
    <div class="sheet-head"><h2 id="rp-title">${icon("flag", 16)}Report a problem</h2><button class="btn icon" data-close aria-label="Close">${icon("close", 15)}</button></div>
    <p class="edit-note">Tell us what didn't work. Your email app opens with this report filled in — nothing is sent until you press Send there.</p>
    <label class="sheet-field"><span>What went wrong?</span><textarea rows="4" placeholder="e.g. the 3D scene is missing in the Live mirror"></textarea></label>
    <label class="sheet-check"><input type="checkbox" data-site checked><span>Include the site address <code></code></span></label>
    <label class="sheet-check"><input type="checkbox" data-log checked><span>Include the panel log (what StyleLift did)</span></label>
    <details class="sheet-preview"><summary>See exactly what will be sent</summary><pre></pre></details>
    <div class="sheet-actions"><button class="btn primary" data-send>${icon("message", 15)}Send by email</button><button class="btn" data-copy>${icon("copy", 15)}Copy report</button></div>
    <div class="edit-note" data-note></div>
  </div>`;
  const $s = <T extends Element>(sel: string) => sheet.querySelector(sel) as T;
  $s<HTMLElement>("code").textContent = site || "(none)";
  const input = () => ({
    site,
    action: lastAction,
    outcome: lastOutcome,
    note: $s<HTMLTextAreaElement>("textarea").value,
    log: state.source.log,
    includeSite: $s<HTMLInputElement>("[data-site]").checked,
    includeLog: $s<HTMLInputElement>("[data-log]").checked,
    version: chrome.runtime.getManifest().version,
    browser: browserLabel(navigator.userAgent, navigator.platform),
  });
  const refresh = () => ($s<HTMLElement>("pre").textContent = reportText(input()));
  sheet.addEventListener("input", refresh);
  sheet.addEventListener("change", refresh);
  refresh();
  const note = $s<HTMLElement>("[data-note]");
  const close = () => sheet.remove();
  $s<HTMLButtonElement>("[data-close]").addEventListener("click", close);
  sheet.addEventListener("click", (e) => { if (e.target === sheet) close(); });
  sheet.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") close(); });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportText(input()));
      return true;
    } catch {
      return false;
    }
  };
  $s<HTMLButtonElement>("[data-copy]").addEventListener("click", async () => {
    note.textContent = (await copy()) ? "Copied. Paste it into an email" + (SUPPORT_EMAIL ? ` to ${SUPPORT_EMAIL}.` : ".") : "The browser blocked the clipboard — select the report above and copy it.";
  });
  const send = $s<HTMLButtonElement>("[data-send]");
  if (!SUPPORT_EMAIL) {
    send.disabled = true;
    send.title = "No support address in this build (VITE_SUPPORT_EMAIL)";
    note.textContent = "This build has no support address yet — use Copy report.";
  }
  send.addEventListener("click", async () => {
    if (!SUPPORT_EMAIL) return;
    const copied = await copy(); // the full text, in case the mail app shortens a long message
    const { href, shortened } = reportMailto(input(), SUPPORT_EMAIL);
    const a = document.createElement("a");
    a.href = href;
    a.click();
    note.textContent = `Your email app should open with the report to ${SUPPORT_EMAIL}.` + (shortened && copied ? " It was long, so the full report is also on your clipboard." : "") + " If nothing opens, use Copy report and email it.";
  });
  document.body.appendChild(sheet);
  $s<HTMLTextAreaElement>("textarea").focus();
}

// ── active tab text (drives Copy) ─────────────────────────────────────────────
function activeText(): string {
  if (state.mode === "component" && state.component) {
    return componentTabText(state.component, state.explanation, state.componentTab);
  }
  const t = state.tokens;
  if (!t) return "";
  switch (state.pageTab) {
    case "design":
      return renderDesignMd(t, state.enrichment, state.density);
    case "tailwind":
      return renderTailwind(t, state.density);
    case "cssvars":
      return renderCssVariables(t, state.density);
    case "tokens":
      return renderDesignTokensJson(t, state.density);
    case "assets":
      return assetsToText(t.assets);
  }
}

function assetsToText(a: Assets): string {
  const sec = (title: string, items: { url: string; type: string }[]) =>
    items.length ? `## ${title}\n${items.map((x) => `- ${x.url}`).join("\n")}` : "";
  return [
    sec("Fonts", a.fonts),
    sec("Images", a.images),
    sec("Videos", a.videos),
    sec("3D Models", a.models),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ── chrome injection helper ───────────────────────────────────────────────────
async function activeTab(): Promise<{ id: number; origin: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  if (/^chrome-extension:/.test(tab.url || "") && (tab.url || "").includes(chrome.runtime.id)) {
    // StyleLift's own Studio / preview tab is in front: say which tab to use instead
    throw new Error("StyleLift works on the website tab in front — Studio is in front right now. Click the website's tab (e.g. figma.com), then the button again.");
  }
  if (/^(chrome|chrome-error|edge|about|chrome-extension|view-source|devtools):/.test(tab.url || "")) {
    throw new Error("This page type can't be inspected. Open a normal website tab.");
  }
  let origin = "";
  try {
    origin = new URL(tab.url || "").origin;
  } catch {
    /* leave blank */
  }
  return { id: tab.id, origin };
}
async function activeTabId(): Promise<number> {
  return (await activeTab()).id;
}

// ── extraction (page mode) ────────────────────────────────────────────────────
async function extract(): Promise<void> {
  setStatus("Reading the page…", "busy");
  extractBtn.disabled = true;
  try {
    const tabId = await activeTabId();
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: extractDesignTokens,
    });
    const tokens = results[0]?.result as DesignTokens | undefined;
    if (!tokens) throw new Error("Extraction returned no data.");
    state.tokens = tokens;
    state.enrichment = null;
    state.mode = "page";
    metaLine.textContent = `${tokens.colors.length} colors · ${tokens.typography.families.length} fonts · ${tokens.radii.length} radii · ${tokens.shadows.length} shadows`;
    setStatus("Extracted. Values are measured from the page.", "ok");
    renderAll();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  } finally {
    extractBtn.disabled = false;
  }
}

// ── component inspection ──────────────────────────────────────────────────────
async function inspect(): Promise<void> {
  setStatus("Click a section in the page to inspect it (Esc to cancel)…", "busy");
  inspectBtn.disabled = true;
  try {
    const tabId = await activeTabId();
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: pickAndInspectComponent,
    });
    const bp = results[0]?.result as ComponentBlueprint | null | undefined;
    if (!bp) {
      setStatus("Inspection cancelled.", "");
      return;
    }
    state.component = bp;
    state.explanation = null;
    state.mode = "component";
    state.componentTab = "guide";
    metaLine.textContent = `${bp.label} · ${bp.nodeCount} nodes · ${bp.animations.length} anim · ${bp.transitions.length} transitions · ${bp.techniques.length} techniques`;
    setStatus("Component inspected. Structure & CSS measured from the page.", "ok");
    renderAll();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  } finally {
    inspectBtn.disabled = false;
  }
}

// ── visual editor ────────────────────────────────────────────────────────────
let editTabId = 0;

async function toggleEditor(): Promise<void> {
  if (state.editorActive) return stopEditor();
  return startEditor();
}

async function startEditor(): Promise<void> {
  editBtn.disabled = true;
  try {
    const { id, origin } = await activeTab();
    editTabId = id;
    state.origin = origin;
    await refreshEditsFromStorage();
    // tear down any prior editor first (incl. a stale one from an older build, whose
    // stop() is still on window.__slEditor), then remove orphan hosts — so we never
    // stack two toolbars.
    await chrome.scripting
      .executeScript({ target: { tabId: id }, func: stopVisualEditor })
      .catch(() => {});
    await chrome.scripting
      .executeScript({
        target: { tabId: id },
        func: () => {
          document.querySelectorAll("#__sl_editor_host").forEach((n) => n.remove());
          (window as unknown as { __slEditorActive?: boolean }).__slEditorActive = false;
        },
      })
      .catch(() => {});
    await chrome.scripting.executeScript({
      target: { tabId: id, allFrames: false },
      func: injectVisualEditor,
    });
    state.editorActive = true;
    state.mode = "edit";
    setStatus("Visual editor active — click any element on the page to edit it.", "ok");
    renderAll();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  } finally {
    editBtn.disabled = false;
  }
}

async function stopEditor(): Promise<void> {
  await clearDevice();
  try {
    const tabId = editTabId || (await activeTab()).id;
    await chrome.scripting.executeScript({ target: { tabId }, func: stopVisualEditor });
  } catch {
    /* tab gone */
  }
  state.editorActive = false;
  state.sel = null;
  setStatus("Visual editor stopped. Your edits are saved.", "ok");
  renderAll();
}

// send a command to the in-page editor on the active tab
async function sendToEditor(msg: Record<string, unknown>): Promise<unknown> {
  try {
    const tabId = editTabId || (await activeTab()).id;
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return undefined; // editor not present
  }
}
// ── responsive preview (real viewport emulation via the debugger API) ─────────
const DEVICE_SIZES: Record<string, { width: number; height: number; mobile: boolean } | null> = {
  desktop: null,
  tablet: { width: 834, height: 1112, mobile: false },
  mobile: { width: 390, height: 844, mobile: true },
};
async function setDevice(device: string): Promise<void> {
  try {
    const tabId = editTabId || (await activeTab()).id;
    const size = DEVICE_SIZES[device];
    if (!size) {
      try {
        await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride");
      } catch {
        /* not overridden */
      }
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        /* not attached */
      }
    } else {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch {
        /* already attached */
      }
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
        width: size.width,
        height: size.height,
        deviceScaleFactor: 0,
        mobile: size.mobile,
      });
    }
    state.device = device;
    renderOutput();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}
async function clearDevice(): Promise<void> {
  if (state.device === "desktop") return;
  try {
    const tabId = editTabId || (await activeTab()).id;
    await chrome.debugger.detach({ tabId }).catch(() => {});
  } catch {
    /* ignore */
  }
  state.device = "desktop";
}

// ── layers navigator ────────────────────────────────────────────────────────
function selectByRef(ref: string): void {
  sendToEditor({ type: "SL_SELECT_BY", ref });
}
function hiliteRef(ref: string | null): void {
  sendToEditor({ type: "SL_HILITE", ref });
}
async function loadChildren(ref: string | null): Promise<void> {
  const key = ref || "__root__";
  const resp = (await sendToEditor({ type: "SL_GET_CHILDREN", ref })) as
    | { children?: { ref: string; label: string; tag: string; hasChildren: boolean }[] }
    | undefined;
  state.treeKids.set(key, resp?.children || []);
}
function scopeBucket(e: StyleOverrides[string], scope: string): Record<string, string> {
  if (scope === "hover" || scope === "focus") return ((e.states ||= {})[scope] ||= {});
  if (scope === "tablet" || scope === "mobile") return ((e.responsive ||= {})[scope] ||= {});
  return e.props;
}
function applyProp(prop: string, value: string): void {
  if (!state.sel) return;
  const scope = state.scope;
  sendToEditor({ type: "SL_APPLY_PROP", selector: state.sel.selector, prop, value, scope });
  const e = state.overrides[state.sel.selector] || (state.overrides[state.sel.selector] = { props: {}, label: state.sel.label });
  const b = scopeBucket(e, scope);
  if (value === "") delete b[prop];
  else b[prop] = value;
}
function currentPropValue(selector: string, prop: string): string {
  const e = state.overrides[selector];
  if (!e) return "";
  const scope = state.scope;
  if (scope === "hover" || scope === "focus") return e.states?.[scope]?.[prop] ?? "";
  if (scope === "tablet" || scope === "mobile") return e.responsive?.[scope]?.[prop] ?? "";
  return e.props?.[prop] ?? "";
}
function applyCustomCss(css: string): void {
  if (!state.sel) return;
  sendToEditor({ type: "SL_APPLY_CSS", selector: state.sel.selector, css });
  (state.overrides[state.sel.selector] || (state.overrides[state.sel.selector] = { props: {}, label: state.sel.label })).css = css;
}
function applyText(value: string): void {
  if (!state.sel) return;
  sendToEditor({ type: "SL_SET_TEXT", selector: state.sel.selector, value });
}
function applyAttr(name: string, value: string | null): void {
  if (!state.sel) return;
  sendToEditor({ type: "SL_APPLY_ATTR", selector: state.sel.selector, name, value });
  const e = state.overrides[state.sel.selector] || (state.overrides[state.sel.selector] = { props: {}, label: state.sel.label });
  if (!e.attrs) e.attrs = {};
  if (value == null) delete e.attrs[name];
  else e.attrs[name] = value;
  if (state.sel) state.sel.attrs[name] = value ?? "";
}
function pickFile(accept: string, onData: (dataUrl: string) => void): void {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = accept;
  inp.addEventListener("change", () => {
    const file = inp.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onData(String(reader.result));
    reader.readAsDataURL(file);
  });
  inp.click();
}
function applyStruct(op: string): void {
  if (!state.sel) return;
  sendToEditor({ type: "SL_STRUCT", selector: state.sel.selector, op });
}
function doUndo(): void {
  sendToEditor({ type: "SL_UNDO" });
}
function doRedo(): void {
  sendToEditor({ type: "SL_REDO" });
}
function insertWidget(kind: string): void {
  sendToEditor({ type: "SL_INSERT", kind });
}
async function matchCopy(): Promise<void> {
  await sendToEditor({ type: "SL_MATCH_COPY" });
  setStatus("Style copied — select another element and paste.", "ok");
}
function matchPaste(): void {
  sendToEditor({ type: "SL_MATCH_PASTE" });
  setStatus("Style pasted.", "ok");
}

// AI chat-to-edit: describe a change → DeepSeek returns a style/text patch → apply.
async function aiEdit(instruction: string): Promise<void> {
  if (!state.sel || !instruction.trim()) return;
  if (!state.hasKey) {
    setStatus("Add a DeepSeek key in settings to use AI editing.", "error");
    return;
  }
  state.aiBusy = true;
  renderOutput();
  setStatus("Asking DeepSeek…", "busy");
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: "AI_EDIT",
      instruction,
      selector: state.sel.selector,
      label: state.sel.label,
      tag: state.sel.tag,
      values: state.sel.values,
      text: state.sel.text,
    })) as { ok: boolean; patch?: { props?: Record<string, string>; text?: string }; error?: string };
    if (!resp?.ok || !resp.patch) throw new Error(resp?.error || "AI edit failed.");
    const patch = resp.patch;
    if (patch.props) for (const [p, v] of Object.entries(patch.props)) applyProp(p, String(v));
    if (typeof patch.text === "string" && state.sel.canText) applyText(patch.text);
    setStatus("Applied AI edit.", "ok");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  } finally {
    state.aiBusy = false;
    renderOutput();
  }
}

// The in-page editor writes overrides/structOps to storage directly; mirror them
// into panel state so the counts and export stay in sync.
async function refreshEditsFromStorage(): Promise<void> {
  if (!state.origin) return;
  const data = await chrome.storage.local.get([OVERRIDES_KEY, STRUCT_KEY]);
  state.overrides = ((data[OVERRIDES_KEY] || {}) as Record<string, StyleOverrides>)[state.origin] || {};
  state.structOps = ((data[STRUCT_KEY] || {}) as Record<string, StructOp[]>)[state.origin] || [];
}

async function resetAllEdits(): Promise<void> {
  if (!state.origin) return;
  const hadStruct = state.structOps.length > 0;
  const ov = await chrome.storage.local.get(OVERRIDES_KEY);
  const st = await chrome.storage.local.get(STRUCT_KEY);
  const allOv = (ov[OVERRIDES_KEY] || {}) as Record<string, StyleOverrides>;
  const allSt = (st[STRUCT_KEY] || {}) as Record<string, StructOp[]>;
  delete allOv[state.origin];
  delete allSt[state.origin];
  await chrome.storage.local.set({ [OVERRIDES_KEY]: allOv, [STRUCT_KEY]: allSt });
  state.overrides = {};
  state.structOps = [];
  // reload to wipe live style/structure changes (and let the editor re-attach clean)
  try {
    const tabId = editTabId || (await activeTab()).id;
    await chrome.tabs.reload(tabId);
    if (state.editorActive) {
      // re-inject the editor after the reload settles
      setTimeout(() => {
        chrome.scripting
          .executeScript({ target: { tabId }, func: injectVisualEditor })
          .catch(() => {});
      }, 1200);
    }
  } catch {
    /* ignore */
  }
  void hadStruct;
  setStatus("All edits cleared on this site.", "ok");
  renderAll();
}

function exportCss(): void {
  const css = overridesToCss(state.overrides, false);
  const texts = textPairs(state.overrides);
  if (!css && !texts.length) {
    setStatus("No style edits to export yet.", "error");
    return;
  }
  let out = `/* StyleLift edits — ${state.origin} */\n`;
  if (css) out += css + "\n";
  if (texts.length) {
    out += `\n/* Text changes (apply in markup — CSS can't set text):\n`;
    for (const [sel, val] of texts) out += `   ${sel}  →  ${JSON.stringify(val)}\n`;
    out += `*/\n`;
  }
  downloadBlob(out, `stylelift.${hostOf(state.origin)}.css`, "text/css");
}
function exportJson(): void {
  if (!Object.keys(state.overrides).length && !state.structOps.length) {
    setStatus("No edits to export yet.", "error");
    return;
  }
  const manifest = {
    origin: state.origin,
    savedAt: new Date().toISOString(),
    overrides: state.overrides,
    structuralOps: state.structOps,
  };
  downloadBlob(JSON.stringify(manifest, null, 2), `stylelift.${hostOf(state.origin)}.json`, "application/json");
}

// ── source capture ────────────────────────────────────────────────────────────
function captureOptions(): CaptureOptions {
  const o = state.source;
  return { scripts: o.scripts, revealHidden: o.reveal, loadDeferred: o.deferred, stripCookieBanners: o.cookies };
}
function srcLog(line: string): void {
  state.source.log.push(line);
  if (state.source.log.length > 200) state.source.log.shift();
  if (state.mode === "source") renderOutput();
}
// Run the capture engine in a tab. The function is injected whole (it closes over
// nothing), and its options travel as JSON args.
async function captureTab(tabId: number, opts: CaptureOptions, _final = true): Promise<CaptureResult> {
  if (opts.loadDeferred !== false) {
    // fast-forward page-world animations (WAAPI, GSAP) so we freeze the final frame
    await chrome.scripting
      .executeScript({ target: { tabId, allFrames: false }, world: "MAIN", func: settleAnimations })
      .catch(() => undefined);
  }
  const run = async () =>
    (await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, func: capturePage, args: [opts] }))[0]?.result as
      | CaptureResult
      | undefined;
  let r = await run();
  // nothing back = the page navigated or reloaded while the capture ran (a slow reload, a page that
  // reloads itself, an export clicked mid-load): wait until it has loaded, then try once more
  if (!r || !r.html) {
    await whenLoaded(tabId);
    await new Promise((res) => setTimeout(res, 1500));
    if (opts.loadDeferred !== false) {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, world: "MAIN", func: settleAnimations }).catch(() => undefined);
    }
    r = await run();
  }
  if (!r || !r.html) throw new Error("The page kept reloading while StyleLift captured it. Wait until it has fully loaded, then try again.");
  applyFramerAppear(r); // Framer entrance animations → CSS keyframes
  await screenshotCanvases(tabId, r);
  addMotionTrigger(r);
  return r;
}
/** Entrances recorded from the page (GSAP) that wait until they're scrolled into view need the small
 *  trigger script; every export carries it (React / Next.js wrap it in their own loader). */
function addMotionTrigger(r: CaptureResult): void {
  // entrances waiting to scroll into view, the site's pointer effects (magnetic, tilt, cursor followers) and
  // its widgets (tabs, gallery arrows, video buttons)
  if (!/data-sl-in-on="enter"|data-sl-(magnet|tilt|cursor|play|tabs|paddle|media|media-v|scroll-classes|hold)=/.test(r.html) || /data-sl-motion-runtime/.test(r.html)) return;
  const tag = `<script data-sl-motion-runtime="">${motionRuntimeSource()}</script>`;
  // (a function, not a string: "$`" / "$&" in the minified script would be read as replacement patterns)
  r.html = /<\/body>/i.test(r.html) ? r.html.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${tag}</body>`) : r.html + tag;
}
// Stitch screenshot strips (device pixels) into one image of the canvas's full size.
async function stitchStrips(strips: { dx: number; dy: number; w: number; h: number; data: string; type?: string }[], w: number, h: number): Promise<string | null> {
  try {
    const bitmaps = await Promise.all(strips.map(async (st) => createImageBitmap(await (await fetch(`data:${st.type || "image/png"};base64,` + st.data)).blob())));
    const ratio = bitmaps[0].width / strips[0].w; // device pixels per CSS pixel
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * ratio));
    c.height = Math.max(1, Math.round(h * ratio));
    const g = c.getContext("2d");
    if (!g) return null;
    strips.forEach((st, i) => g.drawImage(bitmaps[i], Math.round(st.dx * ratio), Math.round(st.dy * ratio), Math.round(st.w * ratio), Math.round(st.h * ratio)));
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}
// WebGL canvases drawn once (Rive icons, a paused 3D scene) can't be read back by the
// page — their buffer is cleared once shown. Screenshot exactly that canvas through
// the debugger instead: everything else hidden, page background transparent, so the
// image holds the canvas pixels only (no text that sits on top, alpha kept).
async function screenshotCanvases(tabId: number, r: CaptureResult): Promise<void> {
  const ids = r.needsScreenshot || [];
  if (!ids.length) return;
  const shots = new Map<string, string>();
  let attached = false;
  try {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attached = true;
    } catch {
      /* already attached (responsive capture / preview) */
    }
    const [{ result: start }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => [scrollX, scrollY] });
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (const id of ids) {
      // where the canvas sits on the page (only it painted, page background transparent)
      const [{ result: box }] = await chrome.scripting.executeScript({
        target: { tabId },
        args: [id],
        func: async (id: string) => {
          // the element may sit in a shadow root (web components): look through open ones
          const deep = (root: Document | ShadowRoot): Element | null => {
            const hit = root.querySelector(`[data-sl-shoot="${id}"]`);
            if (hit) return hit;
            for (const h of Array.from(root.querySelectorAll("*"))) if (h.shadowRoot) { const r = deep(h.shadowRoot); if (r) return r; }
            return null;
          };
          const el = deep(document);
          if (!el) return null;
          el.scrollIntoView({ block: "start", inline: "nearest" });
          let st = document.getElementById("__sl_shoot_style");
          if (!st) {
            st = document.createElement("style");
            st.id = "__sl_shoot_style";
            document.documentElement.appendChild(st);
          }
          st.textContent = `html, body { background: transparent !important; } body * { visibility: hidden !important; transition: none !important; } [data-sl-shoot="${id}"] { visibility: visible !important; }`;
          // inside a shadow root the page's rule can't reach it: it inherits the hidden host, so show it from in there
          for (let r = el.getRootNode(); r instanceof ShadowRoot; r = (r.host as Element).getRootNode()) {
            r.querySelectorAll("style.__sl_shoot").forEach((x) => x.remove());
            const inner = document.createElement("style");
            inner.className = "__sl_shoot";
            inner.textContent = r === el.getRootNode() ? `[data-sl-shoot="${id}"] { visibility: visible !important; }` : "";
            r.appendChild(inner);
          }
          await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, el.localName === "iframe" ? 1200 : 200)))); // a player needs a moment to draw
          const b = el.getBoundingClientRect();
          return { sy: scrollY, sx: scrollX, top: b.top, left: b.left, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight };
        },
      });
      // an embedded player the site removed or rebuilt since (players that only exist on screen): go to
      // where it was, give it time to come back, and picture that area of the screen
      if ((!box || box.w < 2 || box.h < 2) && id.startsWith("f") && r.shotBoxes?.[id]) {
        const b = r.shotBoxes[id];
        await chrome.debugger.sendCommand({ tabId }, "Emulation.setDefaultBackgroundColorOverride", {});
        const [{ result: at2 }] = await chrome.scripting.executeScript({
          target: { tabId },
          args: [b.y],
          func: async (y: number) => {
            document.getElementById("__sl_shoot_style")?.remove();
            scrollTo(scrollX, Math.max(0, y - 80));
            await new Promise((res) => setTimeout(res, 1600));
            return { sy: scrollY, sx: scrollX, vh: innerHeight, vw: innerWidth };
          },
        });
        const top = at2 ? b.y - at2.sy : -1, h = at2 ? Math.min(b.h, at2.vh - top) : 0;
        if (at2 && top >= 0 && h > 20) {
          const shot = (await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", { format: "webp", quality: 82, clip: { x: b.x, y: b.y, width: Math.min(b.w, at2.vw - (b.x - at2.sx)), height: h, scale: 1 } })) as { data?: string };
          if (shot?.data) shots.set(id, "data:image/webp;base64," + shot.data);
        }
        await chrome.debugger.sendCommand({ tabId }, "Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
        continue;
      }
      if (!box || box.w < 2 || box.h < 2) continue;
      // A canvas taller than the screen is shot in strips as it scrolls through, then
      // stitched. Positions are read from the screen at each step, so fixed elements
      // (which don't move with the page) work too; parts outside the page's width are
      // never visible and stay transparent.
      const strips: { dx: number; dy: number; w: number; h: number; data: string; type?: string }[] = [];
      let at = box;
      let covered = 0; // CSS px of the canvas, from its top, already shot
      for (let n = 0; n < 8 && covered < at.h - 1; n++) {
        if (n > 0) {
          const target = at.sy + at.top + covered; // bring the next unshot row to the top
          const [{ result: next }] = await chrome.scripting.executeScript({
            target: { tabId },
            args: [id, target],
            func: async (id: string, target: number) => {
              scrollTo(scrollX, target);
              await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 200))));
              const deep = (root: Document | ShadowRoot): Element | null => {
                const hit = root.querySelector(`[data-sl-shoot="${id}"]`);
                if (hit) return hit;
                for (const h of Array.from(root.querySelectorAll("*"))) if (h.shadowRoot) { const r = deep(h.shadowRoot); if (r) return r; }
                return null;
              };
              const el = deep(document);
              if (!el) return null;
              const b = el.getBoundingClientRect();
              return { sy: scrollY, sx: scrollX, top: b.top, left: b.left, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight };
            },
          });
          if (!next) break;
          at = next;
        }
        const y0 = Math.max(at.top + covered, 0), y1 = Math.min(at.top + at.h, at.vh);
        const x0 = Math.max(at.left, 0), x1 = Math.min(at.left + at.w, at.vw);
        if (y1 - y0 < 1 || x1 - x0 < 1) break; // nothing more comes into view
        const embed = id.startsWith("f"); // a picture of an embedded player: WebP keeps it small
        const shot = (await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
          format: embed ? "webp" : "png",
          ...(embed ? { quality: 82 } : {}),
          clip: { x: x0 + at.sx, y: y0 + at.sy, width: x1 - x0, height: y1 - y0, scale: 1 },
        })) as { data?: string };
        if (!shot?.data) break;
        strips.push({ dx: x0 - at.left, dy: y0 - at.top, w: x1 - x0, h: y1 - y0, data: shot.data, type: embed ? "image/webp" : "image/png" });
        covered = y1 - at.top;
      }
      const box2 = { w: at.w, h: at.h };
      if (!strips.length) continue;
      if (strips.length === 1 && strips[0].dx === 0 && strips[0].dy === 0 && Math.abs(strips[0].w - box2.w) < 1 && Math.abs(strips[0].h - box2.h) < 1) {
        shots.set(id, `data:${strips[0].type || "image/png"};base64,` + strips[0].data);
        continue;
      }
      const stitched = await stitchStrips(strips, box2.w, box2.h);
      if (stitched) shots.set(id, stitched);
    }
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setDefaultBackgroundColorOverride", {});
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [start as number[]],
      func: (start: number[]) => {
        document.getElementById("__sl_shoot_style")?.remove();
        const clean = (root: Document | ShadowRoot) => {
          root.querySelectorAll("[data-sl-shoot]").forEach((e) => e.removeAttribute("data-sl-shoot"));
          root.querySelectorAll("style.__sl_shoot").forEach((e) => e.remove());
          root.querySelectorAll("*").forEach((h) => h.shadowRoot && clean(h.shadowRoot));
        };
        clean(document);
        scrollTo(start[0], start[1]);
      },
    });
  } catch {
    /* no debugger access: the canvases stay as captured */
  } finally {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => undefined);
  }
  // patch the copy (and drop the markers either way)
  const doc = new DOMParser().parseFromString(r.html, "text/html");
  let embeds = 0;
  // the copy keeps shadow DOM as <template shadowrootmode>, whose content a plain query doesn't search
  const deepAll = (root: ParentNode): Element[] => {
    const out = Array.from(root.querySelectorAll("[data-sl-shoot]"));
    root.querySelectorAll("template").forEach((t) => out.push(...deepAll((t as HTMLTemplateElement).content)));
    return out;
  };
  deepAll(doc).forEach((el) => {
    const d = shots.get(el.getAttribute("data-sl-shoot") || "");
    if (d && el.localName === "iframe") {
      // the embed stays; its picture sits behind it (seen wherever the embed itself can't run)
      const st = (el.getAttribute("style") || "").trim();
      el.setAttribute("style", `${st}${st && !st.endsWith(";") ? ";" : ""} background: url("${d}") center / cover no-repeat;`);
      el.setAttribute("data-sl-poster", "");
      embeds++;
    } else if (d) el.setAttribute("src", d);
    el.removeAttribute("data-sl-shoot");
  });
  r.html = "<!doctype html>\n" + doc.documentElement.outerHTML;
  if (shots.size - embeds) srcLog(`  + ${shots.size - embeds} WebGL canvas(es) captured from the screen (they can't be read back)`);
  if (embeds) srcLog(`  + ${embeds} embedded player(s) / widget(s) pictured behind their embed (shown where they can't run, e.g. in Studio)`);
}
// Some sites (Framer) only build their tablet / phone layouts with JavaScript at that
// width. Re-capture at those widths (viewport emulation, like the responsive preview)
// and merge the missing layouts into the desktop capture.
const LAYOUT_WIDTHS = [
  { label: "tablet", width: 810, height: 1080, mobile: false },
  { label: "phone", width: 390, height: 844, mobile: true },
];
async function captureResponsiveLayouts(tabId: number, base: CaptureResult): Promise<void> {
  if (!needsVariantCapture(base.html)) return;
  const extras: { label: LayoutLabel; width: number; html: string }[] = [];
  const baseHtml = base.html;
  let attached = false;
  try {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attached = true;
    } catch {
      /* already attached by the responsive preview */
    }
    for (const w of LAYOUT_WIDTHS) {
      setStatus(`Capturing the ${w.label} layout…`, "busy");
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", { width: w.width, height: w.height, deviceScaleFactor: 0, mobile: w.mobile });
      await new Promise((res) => setTimeout(res, 3200)); // let the site build that layout and finish its entrance animations
      const x = await captureTab(tabId, { ...captureOptions(), maxScrollMs: 16000 }, false);
      extras.push({ label: w.label as LayoutLabel, width: w.width, html: x.html });
    }
  } catch (e) {
    srcLog(`  ⚠ tablet/phone layouts could not be captured (${e instanceof Error ? e.message : String(e)}); showing the desktop layout at every size.`);
  } finally {
    try {
      if (state.device !== "desktop") await setDevice(state.device);
      else {
        await chrome.debugger.sendCommand({ tabId }, "Emulation.clearDeviceMetricsOverride");
        if (attached) await chrome.debugger.detach({ tabId });
      }
    } catch {
      /* tab closed */
    }
  }
  if (!extras.length) return;
  // widths where components swap design with JavaScript keep their whole page as
  // their own layout; the others contribute their missing .ssr-variant sections
  const whole = extras.filter((x) => needsWholeLayout(base.html, x.html));
  const partial = extras.filter((x) => !whole.includes(x));
  if (partial.length) {
    const m = mergeVariantCaptures(base.html, partial.map((x) => x.html));
    base.html = m.html;
    srcLog(
      `  ${m.added ? "+" : "·"} ${partial.map((x) => x.label).join("/")} layouts: ${m.added} section(s) added` +
        (m.covered ? `, ${m.covered} already shown by the desktop version` : "") +
        (m.unplaced ? `, ${m.unplaced} with no matching spot (left out)` : ""),
    );
  }
  for (const x of whole) {
    base.html = addWholeLayout(base.html, x.html, x.label).html;
    srcLog(`  + ${x.label} page kept as its own layout (its components change design at that width)`);
  }
  // every width's variants are now in one page: each must stay hidden at the others
  const baseWidth = (base.stats as { viewportWidth?: number }).viewportWidth || 1440;
  const bp = ensureBreakpointRules(base.html, [{ width: baseWidth, html: baseHtml }, ...extras]);
  base.html = bp.html;
  if (bp.rules) srcLog(`  + ${bp.rules} breakpoint rule(s) rebuilt so each width shows only its own layout`);
}

/** Reload the page with the intro recorder attached from its first moment and let the intro play, so the
 *  capture can replay it (see intro-recorder.ts). Without debugger access the capture goes on without it. */
/** The page's original HTML as the browser received it on the intro reload (for its live 3D scenes). */
let introPage: { tabId: number; url: string; html: Promise<string | null> } | null = null;
async function replayIntro(tabId: number): Promise<void> {
  let attached = false;
  let scriptId: string | null = null;
  try {
    setStatus("Capturing — reloading the page to record its intro animation…", "busy");
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attached = true;
    } catch {
      /* already attached */
    }
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    // (+ the file list and the page's original HTML: what keeping its 3D scenes live needs)
    const added = (await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: introRecorderSource() + "\n" + MIRROR_RECORDER })) as { identifier: string };
    scriptId = added.identifier;
    let doc: { html: Promise<string | null>; stop: () => void } | null = null;
    if (state.source.live3d) {
      await chrome.debugger.sendCommand({ tabId }, "Network.enable", { maxTotalBufferSize: 30_000_000, maxResourceBufferSize: 15_000_000 }).catch(() => {});
      doc = watchDocument(tabId);
    }
    const loaded = new Promise<void>((res) => {
      const on = (src: chrome.debugger.Debuggee, method: string) => {
        if (src.tabId === tabId && method === "Page.loadEventFired") {
          chrome.debugger.onEvent.removeListener(on);
          res();
        }
      };
      chrome.debugger.onEvent.addListener(on);
      setTimeout(() => {
        chrome.debugger.onEvent.removeListener(on);
        res();
      }, 25000);
    });
    await chrome.debugger.sendCommand({ tabId }, "Page.reload", { ignoreCache: false });
    await loaded;
    await whenLoaded(tabId, 30000);
    if (doc) {
      const url = (await chrome.tabs.get(tabId)).url || "";
      const d = doc;
      introPage = { tabId, url, html: Promise.race([d.html, new Promise<null>((res) => setTimeout(() => res(null), 4000))]).finally(() => d.stop()) };
      await chrome.debugger.sendCommand({ tabId }, "Network.disable").catch(() => {});
    }
    setStatus("Capturing — watching the intro…", "busy");
    await new Promise((res) => setTimeout(res, 7500)); // the recorder writes down what it saw 7 s after load
    // …and an intro that runs longer (one waiting for its media, a busy machine) is let finish: until nothing has
    // appeared or gone away for 1.5 s (bounded) — captured mid-way, its last steps would be fast-forwarded past
    for (let waited = 0; waited < 12500; waited += 500) {
      const q = (await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "window.__slIntro && window.__slIntro.quiet ? window.__slIntro.quiet() : 1e9", returnByValue: true }).catch(() => null)) as { result?: { value?: number } } | null;
      if (!q || (q.result?.value ?? 1e9) >= 1500) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    srcLog("  + reloaded the page to record its intro");
  } catch {
    /* no debugger access: captured as it is */
  } finally {
    if (scriptId) await chrome.debugger.sendCommand({ tabId }, "Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId }).catch(() => undefined);
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => undefined);
  }
}
async function captureCurrent(): Promise<CaptureResult> {
  const tabId = editTabId || (await activeTab()).id;
  introPage = null;
  if ((state.source.intro || state.source.live3d) && state.source.deferred) await replayIntro(tabId);
  setStatus("Capturing — loading lazy content and animations…", "busy");
  let r = await captureTab(tabId, captureOptions());
  // Self-healing: if the first pass came back very thin (anti-bot, slow JS render,
  // or a long first paint), wait a bit and try once more with scripts kept.
  const q0 = (r.stats as { quality?: number }).quality ?? 0;
  if (q0 < 40 && (r.html.length < 20000 || !(r.html.match(/<img/g) || []).length)) {
    srcLog(`  … thin result (${q0}%); retrying with scripts kept…`);
    await new Promise((res) => setTimeout(res, 2500));
    const r2 = await captureTab(tabId, { ...captureOptions(), scripts: "keep" });
    const q1 = (r2.stats as { quality?: number }).quality ?? 0;
    if (q1 > q0) r = r2;
  }
  await captureResponsiveLayouts(tabId, r);
  r.html = unhideLoneVariants(r.html).html;
  state.source.last = r;
  const s = r.stats;
  if (r.warnings.length) for (const w of r.warnings) srcLog(`  ⚠ ${w}`);
  const q = (s as { quality?: number }).quality ?? 0;
  const qLabel = q >= 85 ? "high" : q >= 60 ? "medium" : "low";
  srcLog(`✓ ${r.url}  —  quality ${q}% (${qLabel})`);
  srcLog(`  ${(s.bytes / 1024).toFixed(0)} KB · ${s.imagesLoaded}/${s.images} images loaded · ${s.sheets + s.crossOriginSheets} stylesheets · ${s.scriptsStripped} scripts stripped · ${s.revealed} revealed${s.bannersRemoved ? ` · ${s.bannersRemoved} cookie banner removed` : ""}`);
  return r;
}
async function captureHtml(): Promise<string> {
  // prefer the selected element's edited markup; otherwise the whole page
  if (state.sel) {
    try {
      const tabId = editTabId || (await activeTab()).id;
      const resp = (await chrome.tabs.sendMessage(tabId, {
        type: "SL_GET_HTML",
        selector: state.sel.selector,
      })) as { html?: string } | undefined;
      if (resp?.html) return resp.html;
    } catch {
      /* fall through to full capture */
    }
  }
  return (await captureCurrent()).html;
}

// Crawl window: pages are captured in a real, visible window (background tabs
// throttle timers/rAF, so scroll animations and lazy loading would never run).
let crawlWin: { windowId: number; tabId: number } | null = null;
async function openCrawlWindow(): Promise<{ windowId: number; tabId: number }> {
  if (crawlWin) {
    try {
      await chrome.windows.get(crawlWin.windowId);
      return crawlWin;
    } catch {
      crawlWin = null;
    }
  }
  // focused and in front: Chrome slows the timers of a hidden window (behind another window, minimized,
  // display asleep) to as little as once a minute, which would stall a capture for hours
  const w = await chrome.windows.create({ url: "about:blank", type: "popup", width: 1440, height: 960, focused: true });
  const tabId = w.tabs?.[0]?.id;
  if (!w.id || !tabId) throw new Error("Could not open the capture window.");
  crawlWin = { windowId: w.id, tabId };
  return crawlWin;
}
/** Bring the capture window back to the front before a page is captured (the user may have clicked away). */
async function showCrawlWindow(): Promise<void> {
  if (!crawlWin) return;
  await chrome.windows.update(crawlWin.windowId, { focused: true, state: "normal" }).catch(() => {});
}
async function closeCrawlWindow(): Promise<void> {
  if (!crawlWin) return;
  await chrome.windows.remove(crawlWin.windowId).catch(() => {});
  crawlWin = null;
}
/** Resolves once the tab has finished loading (at once if it already has). */
async function whenLoaded(tabId: number, timeoutMs = 25000): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.status === "complete") return;
  await waitForLoad(tabId, timeoutMs);
}
function waitForLoad(tabId: number, timeoutMs = 25000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(t);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") done();
    };
    const t = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}
async function captureUrlInWindow(url: string): Promise<CaptureResult> {
  const { tabId } = await openCrawlWindow();
  await showCrawlWindow();
  await chrome.tabs.update(tabId, { url });
  await waitForLoad(tabId);
  await new Promise((r) => setTimeout(r, 1200)); // hydration / fonts
  const r = await captureTab(tabId, captureOptions());
  await captureResponsiveLayouts(tabId, r);
  r.html = unhideLoneVariants(r.html).html;
  return r;
}

const fetchText = async (url: string): Promise<string | null> => {
  try {
    const r = await fetch(url);
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
};
function downloadZip(files: FileMap, name: string): number {
  return saveZip(files, name);
}

/** One export / Studio / mirror job at a time, shown on its own button until it ends (any way it ends). */
async function runSourceAction(label: string, fn: () => void | Promise<void>): Promise<void> {
  const src = state.source;
  if (src.running || src.busy) return;
  src.running = label;
  renderOutput();
  try {
    await fn();
  } finally {
    src.running = "";
    renderOutput();
  }
}

// ── the last export: Preview, Download again, Publish (Netlify / Vercel / GitHub) ──────────────
type ExportKind = "mirror" | "html" | "react" | "next" | "site-html" | "site-next" | "site-files";
interface ReadyExport {
  files: FileMap;
  kind: ExportKind;
  zipName: string;
  sourceUrl: string;
  host: string;
  /** the page the preview opens first */
  entry: string;
  count: number;
  bytes: number;
  published: PublishTargets;
  /** the provider being published to right now ("" = none) */
  busy: "" | "netlify" | "vercel" | "github";
  previewing: boolean;
}
const KIND_NAMES: Record<ExportKind, string> = {
  mirror: "Live mirror",
  html: "HTML project",
  react: "React (Vite) project",
  next: "Next.js project",
  "site-html": "HTML site",
  "site-next": "Next.js site",
  "site-files": "single-file pages",
};
// what each kind of export can do: plain files preview and host anywhere; React / Next.js need a build
// first, which Vercel does for them (Netlify's upload API publishes files as they are)
const STATIC_KINDS = new Set<ExportKind>(["mirror", "html", "site-html", "site-files"]);
const VERCEL_FRAMEWORK: Record<ExportKind, string | null> = { mirror: null, html: null, "site-html": null, "site-files": null, react: "vite", next: "nextjs", "site-next": "nextjs" };
let previewSession: PreviewSession | null = null;
const readyKey = (r: ReadyExport) => `${r.host}|${r.kind === "mirror" ? "mirror" : r.kind}`;
const readyName = (r: ReadyExport) => slugName(`${r.host}-${r.kind === "mirror" ? "mirror" : r.kind}`, 58);

async function setReady(files: FileMap, kind: ExportKind, zipName: string, sourceUrl: string, entry = "/"): Promise<void> {
  if (previewSession) await previewSession.stop();
  let bytes = 0;
  for (const d of Object.values(files)) bytes += typeof d === "string" ? d.length : d.length;
  const r: ReadyExport = { files, kind, zipName, sourceUrl, host: hostOf(sourceUrl), entry, count: Object.keys(files).length, bytes, published: {}, busy: "", previewing: false };
  state.source.ready = r;
  try {
    r.published = await loadTargets(readyKey(r));
  } catch {
    /* nothing published before */
  }
  renderOutput();
}

/** The files a static host gets: a mirror's server.mjs / package.json are for running it locally only
 *  (on Vercel a package.json would also start a Node build). */
function hostedFiles(r: ReadyExport): FileMap {
  if (r.kind !== "mirror") return r.files;
  const out: FileMap = {};
  for (const [k, v] of Object.entries(r.files)) if (k !== "server.mjs" && k !== "package.json") out[k] = v;
  return out;
}

async function previewReady(): Promise<void> {
  const r = state.source.ready;
  if (!r) return;
  try {
    if (previewSession) await previewSession.stop();
    previewSession = await startPreview(r.files, r.sourceUrl, r.entry, () => {
      previewSession = null;
      if (state.source.ready === r) {
        r.previewing = false;
        renderOutput();
      }
    });
    r.previewing = true;
    setStatus(`Preview open at ${previewSession.origin} — served from your export, nothing was uploaded. Keep this panel open while you look around.`, "ok");
    srcLog(`▶ Preview of the ${KIND_NAMES[r.kind]}: ${previewSession.url}`);
    renderOutput();
  } catch (err) {
    exportFailed(err);
  }
}

async function publishReady(provider: "netlify" | "vercel" | "github"): Promise<void> {
  const r = state.source.ready;
  if (!r || r.busy) return;
  const s = await loadPublishSettings();
  const token = provider === "netlify" ? s.netlifyToken : provider === "vercel" ? s.vercelToken : s.githubToken;
  const label = provider === "netlify" ? "Netlify" : provider === "vercel" ? "Vercel" : "GitHub";
  if (!token) {
    setStatus(`Connect ${label} first: Settings → Publishing (paste an access token once).`, "error");
    chrome.runtime.openOptionsPage();
    return;
  }
  r.busy = provider;
  renderOutput();
  const progress = (m: string) => setStatus(m, "busy");
  const key = readyKey(r);
  const name = readyName(r);
  try {
    if (provider === "netlify") {
      const res = await publishNetlify(hostedFiles(r), { token, siteId: r.published.netlify?.siteId, name }, progress);
      r.published.netlify = { siteId: res.siteId, url: res.url, at: Date.now() };
      await saveTarget(key, "netlify", r.published.netlify);
      setStatus(`Published to Netlify: ${res.url}`, "ok");
      srcLog(`✓ Netlify: ${res.url} (${res.uploaded} new file(s) uploaded)`);
    } else if (provider === "vercel") {
      const res = await publishVercel(r.kind === "mirror" ? hostedFiles(r) : r.files, { token, teamId: s.vercelTeamId || undefined, project: r.published.vercel?.project || name, framework: VERCEL_FRAMEWORK[r.kind] }, progress);
      r.published.vercel = { project: res.project, url: res.url, at: Date.now() };
      await saveTarget(key, "vercel", r.published.vercel);
      setStatus(`Published to Vercel: ${res.url}`, "ok");
      srcLog(`✓ Vercel: ${res.url}`);
    } else {
      const repo = r.published.github?.repo.split("/")[1] || name;
      const res = await pushGitHub(r.files, { token, repo, private: s.githubPrivate, message: `${KIND_NAMES[r.kind]} of ${r.sourceUrl}, exported by StyleLift`, description: `${KIND_NAMES[r.kind]} of ${r.host}` }, progress);
      r.published.github = { repo: res.repo, url: res.url, at: Date.now() };
      await saveTarget(key, "github", r.published.github);
      setStatus(`Pushed to GitHub: ${res.url}`, "ok");
      srcLog(`✓ GitHub: ${res.url} (${res.uploaded} changed file(s))`);
    }
  } catch (err) {
    exportFailed(err);
  } finally {
    r.busy = "";
    renderOutput();
  }
}

function renderReady(r: ReadyExport): HTMLElement {
  const box = document.createElement("div");
  box.className = "edit-group ready-card";
  const h = document.createElement("h3");
  h.textContent = `Your export: ${KIND_NAMES[r.kind]}`;
  const meta = document.createElement("div");
  meta.className = "edit-note";
  meta.textContent = `${r.host} · ${r.count} files · ${(r.bytes / 1e6).toFixed(1)} MB · downloaded as ${r.zipName}`;
  box.append(h, meta);
  const READY_ICON: Record<string, string> = { Preview: "play", "Stop preview": "stop", "Download again": "download" };
  const btn = (label: string, cls: string, title: string, fn: () => void, disabled = false, ic = READY_ICON[label] || "") => {
    const b = document.createElement("button");
    b.className = "btn " + cls;
    b.innerHTML = ic ? icon(ic, 14) : "";
    b.append(label);
    b.title = title;
    b.disabled = disabled || !!r.busy || state.source.busy;
    b.addEventListener("click", fn);
    return b;
  };
  const isStatic = STATIC_KINDS.has(r.kind);
  const row1 = document.createElement("div");
  row1.className = "editor-footer";
  row1.append(
    r.previewing
      ? btn("Stop preview", "danger-ghost", "Close the preview's connection to this panel", () => void previewSession?.stop())
      : btn("Preview", "primary", isStatic ? "Open it in a new tab, served from this export — nothing is uploaded" : "React and Next.js projects need a build first: use Edit in Studio, or Publish to Vercel (it builds them)", () => void previewReady(), !isStatic),
    btn("Download again", "", `Save ${r.zipName} again`, () => downloadZip(r.files, r.zipName)),
  );
  const row2 = document.createElement("div");
  row2.className = "editor-footer";
  const pub = (p: "netlify" | "vercel" | "github", label: string, title: string, ok = true) =>
    btn(r.busy === p ? "Publishing…" : label, "accent", title, () => void publishReady(p), !ok, p === "github" ? "branch" : "upload");
  row2.append(
    pub("netlify", r.published.netlify ? "Update Netlify" : "Publish to Netlify", isStatic ? "Upload to your Netlify account and get an https link" : "Netlify publishes files as they are: React / Next.js projects need a build — use Vercel or GitHub", isStatic),
    pub("vercel", r.published.vercel ? "Update Vercel" : "Publish to Vercel", VERCEL_FRAMEWORK[r.kind] ? `Vercel builds the ${KIND_NAMES[r.kind]} and gives an https link` : "Upload to your Vercel account and get an https link"),
    pub("github", r.published.github ? "Push to GitHub again" : "Push to GitHub", "Commit every file to a repository in your GitHub account"),
  );
  box.append(row1, row2);
  if (r.previewing) {
    const n = document.createElement("div");
    n.className = "edit-note";
    n.textContent = "The preview runs at a private .test address and is answered from this export. Chrome shows a “StyleLift started debugging this browser” bar while it's open.";
    box.appendChild(n);
  }
  const links: [string, string][] = [];
  if (r.published.netlify) links.push(["Netlify", r.published.netlify.url]);
  if (r.published.vercel) links.push(["Vercel", r.published.vercel.url]);
  if (r.published.github) links.push(["GitHub", r.published.github.url]);
  if (links.length) {
    const list = document.createElement("div");
    list.className = "ready-links";
    for (const [name, url] of links) {
      const row = document.createElement("div");
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent = url.replace(/^https:\/\//, "");
      row.append(document.createTextNode(`${name}: `), a);
      list.appendChild(row);
    }
    box.appendChild(list);
  }
  // a mirror's own styles layer, edited here and seen in the preview (the site's code stays untouched)
  if (r.kind === "mirror" && typeof r.files["site/stylelift-custom.css"] === "string") {
    const d = document.createElement("details");
    d.className = "ready-css";
    const sum = document.createElement("summary");
    sum.textContent = "Your styles (stylelift-custom.css)";
    const ta = document.createElement("textarea");
    ta.spellcheck = false;
    ta.rows = 10;
    ta.value = r.files["site/stylelift-custom.css"] as string;
    const apply = btn(r.previewing ? "Apply and reload the preview" : "Apply", "", "Save into the export: Preview, Download again and Publish use it", async () => {
      r.files["site/stylelift-custom.css"] = ta.value;
      if (previewSession) await previewSession.reload();
      setStatus(r.previewing ? "Your styles are applied — the preview reloaded." : "Your styles are saved into the export. Preview it, download it again or publish it.", "ok");
    });
    apply.style.marginTop = "6px";
    d.append(sum, ta, apply);
    box.appendChild(d);
  }
  return box;
}
// Whole site → list of captured pages (the current tab is the seed, so edits on it are kept).
async function captureSite(): Promise<CrawlPage[]> {
  const src = state.source;
  src.cancel = false;
  src.busy = true;
  src.log = [];
  src.progress = 0;
  renderOutput();
  try {
    const seed = await captureCurrent();
    const startUrl = seed.url;
    const pages = await crawlSite(
      startUrl,
      seed,
      { maxPages: Math.max(1, src.maxPages), maxDepth: Math.max(0, src.maxDepth), useSitemap: src.sitemap },
      {
        capture: async (url) => {
          srcLog(`→ ${url}`);
          const r = await captureUrlInWindow(url);
          const s = r.stats;
          srcLog(`  ✓ ${(s.bytes / 1024).toFixed(0)} KB · ${s.imagesLoaded}/${s.images} images · ${s.revealed} revealed`);
          return r;
        },
        fetchText,
        onProgress: (done, queued) => {
          src.progress = done / Math.max(1, Math.min(src.maxPages, done + queued));
          setStatus(`Capturing site — ${done} page(s) done, ${queued} queued…`, "busy");
        },
        isCancelled: () => src.cancel,
      },
    );
    src.lastPages = pages;
    srcLog(`Captured ${pages.length} page(s).`);
    return pages;
  } finally {
    await closeCrawlWindow();
    src.busy = false;
    src.progress = 1;
    renderOutput();
  }
}

// ── exports ───────────────────────────────────────────────────────────────────
async function exportRawHtml(): Promise<void> {
  try {
    const r = await captureCurrent();
    // CDN stylesheets the page-side capture could not read are fetched here (host permissions)
    let html = r.stats.crossOriginSheets ? await inlineStylesheetLinks(r.html, r.url, fetchText) : r.html;
    // fonts are served without CORS by many sites, so a copy opened elsewhere would fall
    // back to system fonts: embed font files (only) as data: URIs
    const fontData = async (u: string): Promise<string | null> => {
      if (!/\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(u)) return null;
      try {
        const resp = await fetch(u);
        if (!resp.ok) return null;
        const b = await resp.blob();
        if (b.size > 3_000_000) return null;
        return await new Promise<string>((res) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result));
          fr.readAsDataURL(b);
        });
      } catch {
        return null;
      }
    };
    html = await inlineForOffline(html, r.url, { fetchText: async () => null, fetchData: fontData });
    downloadBlob(html, `${hostOf(r.url)}.page.html`, "text/html");
    setStatus("Exported page HTML (styles and fonts embedded, images linked online).", "ok");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}

async function exportOffline(): Promise<void> {
  try {
    const r = await captureCurrent();
    setStatus("Building single-file HTML — embedding assets…", "busy");
    const cache = new Map<string, string | null>();
    const blobToDataUrl = (b: Blob) =>
      new Promise<string>((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.readAsDataURL(b);
      });
    const fetchData = async (url: string): Promise<string | null> => {
      if (cache.has(url)) return cache.get(url) ?? null;
      let out: string | null = null;
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          const b = await resp.blob();
          if (b.size <= 8_000_000) out = await blobToDataUrl(b); // cap per-asset at 8 MB
        }
      } catch {
        /* unreachable / blocked */
      }
      cache.set(url, out);
      return out;
    };
    const out = await inlineForOffline(r.html, r.url, { fetchText, fetchData });
    downloadBlob(out, `${hostOf(r.url)}.offline.html`, "text/html");
    setStatus("Exported a self-contained single-file page (assets embedded).", "ok");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}

/** The site's own file, byte for byte (Live mirror / live 3D scenes). */
const mirrorFetch = async (u: string): Promise<{ bytes: Uint8Array; type: string } | null> => {
  try {
    const x = await fetch(u, { credentials: "include" });
    if (!x.ok) return null;
    return { bytes: new Uint8Array(await x.arrayBuffer()), type: x.headers.get("content-type") || "" };
  } catch {
    return null;
  }
};
/** Live 3D: the files that keep a captured page's 3D scenes running from the site's own code in a project
 *  export (see islands.ts) — or null (none, the option is off, or the page's files couldn't be had). */
async function liveScenes(r: CaptureResult, prefix: string): Promise<IslandFiles | null> {
  if (!state.source.live3d || !hasIslands(r.html)) return null;
  try {
    const tabId = editTabId || (await activeTab()).id;
    setStatus("Keeping the 3D scenes live — collecting the site's own files for them…", "busy");
    const [{ result: resources }] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: readMirrorResources });
    const seen = introPage && introPage.tabId === tabId ? await introPage.html : null;
    const page = seen && /<html|<!doctype|<head|<body/i.test(seen.slice(0, 5000)) ? { html: seen } : await fetchPageHtml(r.url);
    if (!page) {
      srcLog("  ⚠ the page's original HTML couldn't be had: its 3D scenes stay pictures");
      return null;
    }
    // what a scene needs: the site's code, styles, models, textures, data — not the page's own pictures and videos
    // (the editable copy has its own copies; the scene frame hides them; online they still load from the site)
    const shown = new Set<string>();
    const doc = new DOMParser().parseFromString(r.html, "text/html");
    const abs = (u: string) => { try { return new URL(u, r.url).href; } catch { return ""; } };
    doc.querySelectorAll("img[src], source[src], video[src], video[poster], audio[src]").forEach((e) => {
      for (const a of ["src", "poster"]) { const v = e.getAttribute(a); if (v && !/^data:/.test(v)) shown.add(abs(v)); }
    });
    doc.querySelectorAll("img[srcset], source[srcset]").forEach((e) => (e.getAttribute("srcset") || "").split(",").forEach((c) => { const u = c.trim().split(/\s+/)[0]; if (u) shown.add(abs(u)); }));
    const media = /\.(mp4|webm|mov|m4v|ogv|mp3|wav|m4a|aac|ogg)(\?|#|$)/i;
    const needed = ((resources as string[]) || []).filter((u) => !shown.has(u) && !media.test(u));
    srcLog(`  … 3D scenes: ${needed.length} of the page's ${((resources as string[]) || []).length} files (its own pictures and videos left to the copy)`);
    const m = await buildLiveMirror(r.url, page.html, needed, { fetchFile: mirrorFetch, skip: (u) => shown.has(u) || media.test(u), maxBytes: LIVE_3D_BUDGET }, (done, total) => setStatus(`Keeping the 3D scenes live — the site's files ${done}/${total}…`, "busy"));
    // more than an editable export should carry (and a modest computer should hold while zipping): pictures instead
    if (m.overBudget) {
      srcLog(`  ⚠ the 3D scenes would need more than ${Math.round(LIVE_3D_BUDGET / 1e6)} MB of the site's files: they stay pictures in this export (a Live mirror keeps them running)`);
      return null;
    }
    if (m.missingEssential.length) srcLog(`  ⚠ ${m.missingEssential.length} of the site's own scripts / stylesheets couldn't be downloaded: its 3D scenes may not run`);
    const n = ((r.html.match(/\sdata-sl-island="/g) || []) as string[]).length;
    srcLog(`  + ${n} 3D scene(s) kept live: ${m.count} of the site's files, ${(m.bytes / 1e6).toFixed(1)} MB (served from the site's root; a page opened from disk shows their pictures)`);
    return islandFiles(m, r.url, prefix);
  } catch (e) {
    srcLog(`  ⚠ the 3D scenes stay pictures: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// the most of a site's own files a page export takes along to keep its 3D scenes live
const LIVE_3D_BUDGET = 150_000_000;

// Page → zipped project (HTML, React/Vite or Next.js).
const KIND_LABEL = { html: "HTML", react: "React (Vite)", next: "Next.js" } as const;
async function exportProject(kind: "html" | "react" | "next"): Promise<void> {
  try {
    const r = await captureCurrent();
    const scenes = await liveScenes(r, kind === "html" ? "" : "public/");
    const html = scenes ? addIslandTag(r.html) : r.html;
    setStatus(`Building ${KIND_LABEL[kind]} project — collecting assets…`, "busy");
    const host = hostOf(r.url);
    const resolvers = { fetchText, fetchBytes: makeByteFetcher() };
    const files: FileMap =
      kind === "react"
        ? await buildReactViteProject(html, r.url, resolvers, host)
        : kind === "next"
          ? await buildNextProject(html, r.url, resolvers, host)
          : await buildHtmlProject(html, r.url, resolvers, host);
    if (scenes) Object.assign(files, scenes);
    const comps = Object.keys(files).filter((p) => /components\/.+\.jsx$/.test(p)).length;
    const missing = missingAssets.get(files)?.size || 0;
    const n = downloadZip(files, `${host}.${kind}.zip`);
    await setReady(files, kind, `${host}.${kind}.zip`, r.url);
    setStatus(
      `Exported ${KIND_LABEL[kind]} project: ${n} files${comps ? `, ${comps} components` : ""}.` +
        (missing ? ` ${missing} asset(s) couldn't be downloaded and still load from the site (listed in README.md).` : ""),
      missing ? "warn" : "ok", // done — a few files still come from the site (listed in the README)
    );
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}

// Page → Figma: the copy (edits included) measured as Figma layers, with its pictures and the StyleLift plugin for
// Figma, in one .zip the plugin opens.
async function exportFigma(): Promise<void> {
  try {
    const tabId = editTabId || (await activeTab()).id;
    // the width the page is seen at: the copy is laid out at it for Figma
    const [{ result: view }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ width: innerWidth, height: innerHeight }) });
    const r = await captureCurrent();
    setStatus("Building the copy for Figma — collecting assets…", "busy");
    const host = hostOf(r.url);
    const files = await buildHtmlProject(r.html, r.url, { fetchText, fetchBytes: makeByteFetcher() }, host);
    const b = await buildFigmaBundle(files, r.url, view && view.width > 200 ? view : { width: 1440, height: 900 }, makeByteFetcher(), (t) => setStatus(t, "busy"));
    const zip: FileMap = {};
    for (const e of b.entries) zip[e.name] = e.data;
    downloadZip(zip, `${host}.figma.zip`);
    const st = b.snap.stats;
    srcLog(`✓ Figma: ${st.nodes} layers (${st.texts} texts, ${st.images} pictures, ${st.svgs} vectors, ${st.autoLayout} Auto Layout) · ${b.snap.width} × ${b.snap.height} px${b.picturesMissing ? ` · ⚠ ${b.picturesMissing} picture(s) couldn't be packed` : ""}${st.skipped ? ` · ⚠ ${st.skipped} layer(s) past the limit left out` : ""}`);
    setStatus(
      `Exported for Figma: ${st.nodes} layers, ${b.pictures} pictures. In Figma run the StyleLift plugin and choose ${host}.figma.zip (the first time: Plugins → Development → Import plugin from manifest, figma-plugin/manifest.json inside the zip — see README.txt).`,
      b.picturesMissing ? "warn" : "ok",
    );
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}

// Whole site → zipped multi-page project, or one self-contained .html per page.
async function exportSite(kind: "project" | "offline" | "next"): Promise<void> {
  try {
    const pages = await captureSite();
    if (!pages.length) throw new Error("No pages captured.");
    const host = hostOf(pages[0].url);
    setStatus(`Packaging ${pages.length} page(s) — collecting assets…`, "busy");
    let files: FileMap;
    if (kind === "project") {
      files = await buildSiteProject(pages, { fetchText, fetchBytes: makeByteFetcher() }, host);
    } else if (kind === "next") {
      files = await buildNextSiteProject(pages, { fetchText, fetchBytes: makeByteFetcher() }, host);
    } else {
      files = {};
      const cache = new Map<string, string | null>();
      const fetchData = async (url: string): Promise<string | null> => {
        if (cache.has(url)) return cache.get(url) ?? null;
        let out: string | null = null;
        try {
          const resp = await fetch(url);
          if (resp.ok) {
            const b = await resp.blob();
            if (b.size <= 8_000_000)
              out = await new Promise<string>((res) => {
                const fr = new FileReader();
                fr.onload = () => res(String(fr.result));
                fr.readAsDataURL(b);
              });
          }
        } catch {
          /* unreachable */
        }
        cache.set(url, out);
        return out;
      };
      for (const p of pages) {
        srcLog(`embedding ${p.path}…`);
        files[p.path] = await inlineForOffline(p.html, p.url, { fetchText, fetchData });
      }
      files["README.md"] = `# ${host} — ${pages.length} self-contained page(s) exported by StyleLift\n\n` + pages.map((p) => `- ${p.path}  ←  ${p.url}`).join("\n") + "\n";
    }
    const zipName = `${host}.site${kind === "offline" ? ".single-files" : kind === "next" ? ".nextjs" : ""}.zip`;
    const n = downloadZip(files, zipName);
    await setReady(files, kind === "project" ? "site-html" : kind === "next" ? "site-next" : "site-files", zipName, pages[0].url);
    setStatus(`Exported ${pages.length} page(s) (${n} files) as ${kind === "project" ? "a static site project" : kind === "next" ? "a Next.js site (one route per page)" : "a set of single-file pages"}.`, "ok");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}

// Capture → Studio project → open the editor in a new tab.
async function openInStudio(): Promise<void> {
  try {
    const r = await captureCurrent();
    const scenes = await liveScenes(r, ""); // its 3D scenes, kept live in Studio's Preview and project exports
    setStatus("Opening in Studio…", "busy");
    const id = newProjectId();
    if (scenes) await saveScenes(id, scenes);
    await saveProject({ id, url: r.url, title: r.title || hostOf(r.url), html: r.html, edits: {}, createdAt: Date.now(), updatedAt: Date.now() });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/studio/index.html?id=${encodeURIComponent(id)}`) });
    setStatus("Opened in StyleLift Studio — edit, then export from the Studio's Export menu.", "ok");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}

// Whole site → one Studio project: every crawled page, each edited on its own canvas, exported together.
async function openSiteInStudio(): Promise<void> {
  try {
    const pages = await captureSite();
    if (!pages.length) throw new Error("No pages captured.");
    setStatus(`Opening ${pages.length} page(s) in Studio…`, "busy");
    const id = newProjectId();
    const host = hostOf(pages[0].url);
    await createSiteProject(
      { id, url: pages[0].url, title: `${host} — ${pages.length} pages`, createdAt: Date.now(), updatedAt: Date.now() },
      pages.map((p) => ({ url: p.url, path: p.path, title: p.title || p.path, html: p.html })),
    );
    await chrome.tabs.create({ url: chrome.runtime.getURL(`src/studio/index.html?id=${encodeURIComponent(id)}`) });
    setStatus(`Opened ${pages.length} pages in StyleLift Studio — pick a page under Pages, edit it, then export the whole site from Export.`, "ok");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}

// ── Live mirror: the site's own code + files, so 3D and interactions run as on the original ──
// The tab reloads once with a recorder that starts before the site's code (so every file
// it loads is listed — the browser's own list stops at ~250), then the capture's scroll pass
// triggers lazy 3D models, textures and chunks, and everything is downloaded.
// Runs in every frame: same-origin iframes (widgets built from inline HTML, e.g. a signup form that
// loads Vue from a CDN) add their files to the page's list.
const MIRROR_RECORDER = `(() => { if (window.__slResources) return; let seen = null;
  try { if (window.top !== window && window.top.__slResources) seen = window.top.__slResources; } catch (e) {}
  if (!seen) seen = new Set(); window.__slResources = seen;
  try { performance.setResourceTimingBufferSize(20000); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) seen.add(e.name); }).observe({ type: "resource", buffered: true }); } catch (e) {} })();`;
/** Every file the page (and any iframe the page can reach) loaded. Injected as source: self-contained. */
function readMirrorResources(): string[] {
  const out = new Set<string>(Array.from(((window as unknown as { __slResources?: Set<string> }).__slResources) || []));
  const walk = (w: Window, depth: number) => {
    if (depth > 4) return;
    for (let i = 0; i < w.frames.length; i++) {
      try {
        const f = w.frames[i];
        for (const e of f.performance.getEntriesByType("resource")) out.add(e.name);
        const own = (f as unknown as { __slResources?: Set<string> }).__slResources;
        if (own) for (const u of own) out.add(u);
        walk(f, depth + 1);
      } catch {
        /* a cross-origin frame: another site's widget, not this site */
      }
    }
  };
  walk(window, 0);
  return Array.from(out);
}
/** The page's HTML exactly as the browser received it when it loaded (debugger attached, Network on):
 *  no second request — a bot wall that let the browser through can't refuse it. Resolves null if the
 *  document wasn't seen (served from cache, a service worker, …); then the caller downloads it. */
function watchDocument(tabId: number): { html: Promise<string | null>; stop: () => void } {
  let docId: string | null = null;
  let finish: (v: string | null) => void = () => {};
  const html = new Promise<string | null>((r) => (finish = r));
  const on = async (src: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (src.tabId !== tabId) return;
    const p = (params || {}) as { requestId?: string; type?: string; response?: { status?: number; mimeType?: string } };
    if (method === "Network.responseReceived" && p.type === "Document" && !docId && /html/i.test(p.response?.mimeType || "") && (p.response?.status || 200) < 400) docId = p.requestId || null;
    if (method === "Network.loadingFinished" && docId && p.requestId === docId) {
      try {
        const b = (await chrome.debugger.sendCommand({ tabId }, "Network.getResponseBody", { requestId: docId })) as { body: string; base64Encoded: boolean };
        finish(b.base64Encoded ? new TextDecoder().decode(Uint8Array.from(atob(b.body), (c) => c.charCodeAt(0))) : b.body);
      } catch {
        finish(null);
      }
    }
    if (method === "Network.loadingFailed" && docId && p.requestId === docId) finish(null);
  };
  chrome.debugger.onEvent.addListener(on);
  return { html, stop: () => { chrome.debugger.onEvent.removeListener(on); finish(null); } };
}
async function documentHtml(watch: { html: Promise<string | null>; stop: () => void } | null, url: string): Promise<{ html: string; type: string } | null> {
  if (watch) {
    const seen = await Promise.race([watch.html, new Promise<null>((r) => setTimeout(() => r(null), 8000))]);
    watch.stop();
    if (seen && /<html|<!doctype|<head|<body/i.test(seen.slice(0, 5000))) return { html: seen, type: "text/html" };
  }
  return fetchPageHtml(url);
}

/** The page's original HTML; shops and CDNs answer "too many requests" for a moment under load, so retry. */
async function fetchPageHtml(url: string): Promise<{ html: string; type: string } | null> {
  for (let i = 0; i < 4; i++) {
    try {
      const resp = await fetch(url, { credentials: "include" });
      if (resp.ok) return { html: await resp.text(), type: resp.headers.get("content-type") || "" };
      if (resp.status !== 429 && resp.status < 500) return null;
    } catch {
      /* dropped connection: try again */
    }
    await new Promise((r) => setTimeout(r, [2000, 5000, 10000][i] || 10000));
  }
  return null;
}
async function exportMirror(): Promise<void> {
  const tabId = editTabId || (await activeTab()).id;
  let attached = false;
  let scriptId: string | null = null;
  try {
    setStatus("Live mirror: reloading the page so StyleLift sees every file it loads…", "busy");
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      attached = true;
    } catch {
      /* already attached */
    }
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    const added = (await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: MIRROR_RECORDER })) as { identifier: string };
    scriptId = added.identifier;
    const loaded = new Promise<void>((res) => {
      const on = (src: chrome.debugger.Debuggee, method: string) => {
        if (src.tabId === tabId && method === "Page.loadEventFired") { chrome.debugger.onEvent.removeListener(on); res(); }
      };
      chrome.debugger.onEvent.addListener(on);
      setTimeout(() => { chrome.debugger.onEvent.removeListener(on); res(); }, 20000);
    });
    // the main document as the browser receives it on this reload (bodies kept small: only it is read)
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", { maxTotalBufferSize: 30_000_000, maxResourceBufferSize: 15_000_000 }).catch(() => {});
    const doc = watchDocument(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Page.reload", { ignoreCache: false });
    await loaded;
    await whenLoaded(tabId, 40000); // a heavy page can still be loading when the 20 s wait gives up
    const original = await documentHtml(doc, (await chrome.tabs.get(tabId)).url || "");
    await chrome.debugger.sendCommand({ tabId }, "Network.disable").catch(() => {});
    await new Promise((res) => setTimeout(res, 2500));
    setStatus("Live mirror: scrolling the page so it loads its 3D models, textures and code…", "busy");
    const r = await captureTab(tabId, captureOptions(), false);
    const [{ result: resources }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: readMirrorResources,
    });
    const page = original || (await fetchPageHtml(r.url));
    if (!page) throw new Error("StyleLift couldn't get this page's HTML: the site refused it (a bot check?) and the browser didn't keep a copy. Reload the page and try again.");
    const html = page.html;
    const m = await buildLiveMirror(
      r.url,
      html,
      (resources as string[]) || [],
      {
        fetchFile: async (u) => {
          try {
            const x = await fetch(u, { credentials: "include" });
            if (!x.ok) return null;
            return { bytes: new Uint8Array(await x.arrayBuffer()), type: x.headers.get("content-type") || "" };
          } catch {
            return null;
          }
        },
      },
      (done, total) => setStatus(`Live mirror: downloading files ${done}/${total}…`, "busy"),
    );
    downloadZip(m.files, `${hostOf(r.url)}-live-mirror.zip`);
    await setReady(m.files, "mirror", `${hostOf(r.url)}-live-mirror.zip`, r.url, m.entryPath);
    srcLog(`✓ Live mirror of ${r.url}: ${m.count} files, ${(m.bytes / 1e6).toFixed(1)} MB${m.missing.length ? ` · ${m.missing.length} couldn't be downloaded (listed in README.md)` : ""}`);
    if (m.missingEssential.length) setStatus(`Live mirror downloaded, but INCOMPLETE: ${m.missingEssential.length} of the page's own scripts / stylesheets couldn't be downloaded (connection dropped?), so it won't look or work right offline. Check your connection and export it again.`, "error");
    else setStatus(`Live mirror downloaded (${m.count} files). Preview it or publish it from “Your export” below — or unzip it and drag the folder onto app.netlify.com/drop.`, "ok");
  } catch (err) {
    exportFailed(err);
  } finally {
    try {
      if (scriptId) await chrome.debugger.sendCommand({ tabId }, "Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
      if (attached) await chrome.debugger.detach({ tabId });
    } catch {
      /* tab closed */
    }
  }
}

// Whole site → one live mirror: the capture window visits each page with the recorder attached
// (so every file each page loads is seen), and each page keeps its own original HTML.
async function exportSiteMirror(): Promise<void> {
  const src = state.source;
  src.cancel = false;
  src.busy = true;
  src.log = [];
  src.progress = 0;
  renderOutput();
  const resources = new Set<string>();
  const originals = new Map<string, string>();
  let tabId = 0;
  let attached = false;
  try {
    const start = (await chrome.tabs.get((await activeTab()).id)).url || "";
    if (!/^https?:/i.test(start)) throw new Error("Open the website you want to mirror first.");
    tabId = (await openCrawlWindow()).tabId;
    await chrome.debugger.attach({ tabId }, "1.3");
    attached = true;
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    // stays in force for every page this tab opens while attached
    await chrome.debugger.sendCommand({ tabId }, "Page.addScriptToEvaluateOnNewDocument", { source: MIRROR_RECORDER });
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", { maxTotalBufferSize: 30_000_000, maxResourceBufferSize: 15_000_000 }).catch(() => {});
    const pages = await crawlSite(
      start,
      null,
      { maxPages: Math.max(1, src.maxPages), maxDepth: Math.max(0, src.maxDepth), useSitemap: src.sitemap },
      {
        capture: async (url) => {
          srcLog(`→ ${url}`);
          await showCrawlWindow();
          const doc = watchDocument(tabId);
          await chrome.tabs.update(tabId, { url });
          await waitForLoad(tabId);
          const original = await documentHtml(doc, url);
          await new Promise((r) => setTimeout(r, 2500)); // scenes, models and fonts start loading
          const r = await captureTab(tabId, captureOptions(), false); // scroll pass: lazy files load
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: readMirrorResources,
          });
          const got = (result as string[]) || [];
          for (const u of got) resources.add(u);
          const page = original || (await fetchPageHtml(r.url));
          if (page && /html/i.test(page.type || "html")) {
            originals.set(url, page.html);
            originals.set(r.url, page.html);
          } else srcLog("  ⚠ its HTML couldn't be downloaded — left out of the mirror");
          srcLog(`  ✓ ${got.length} files loaded`);
          return r;
        },
        fetchText,
        onProgress: (done, queued) => {
          src.progress = done / Math.max(1, Math.min(src.maxPages, done + queued));
          setStatus(`Live mirror — ${done} page(s) visited, ${queued} queued…`, "busy");
        },
        isCancelled: () => src.cancel,
      },
    );
    const list: MirrorPage[] = pages.map((p) => ({ url: p.url, html: originals.get(p.url) || "" })).filter((p) => p.html);
    if (!list.length) throw new Error("None of the pages answered with their HTML.");
    const m = await buildSiteMirror(
      list,
      Array.from(resources),
      {
        fetchFile: async (u) => {
          try {
            const x = await fetch(u, { credentials: "include" });
            if (!x.ok) return null;
            return { bytes: new Uint8Array(await x.arrayBuffer()), type: x.headers.get("content-type") || "" };
          } catch {
            return null;
          }
        },
      },
      (done, total) => setStatus(`Live mirror: downloading files ${done}/${total}…`, "busy"),
    );
    downloadZip(m.files, `${hostOf(start)}-site-live-mirror.zip`);
    await setReady(m.files, "mirror", `${hostOf(start)}-site-live-mirror.zip`, start, m.entryPath);
    srcLog(`✓ Live mirror of ${m.pages} page(s): ${m.count} files, ${(m.bytes / 1e6).toFixed(1)} MB${m.missing.length ? ` · ${m.missing.length} couldn't be downloaded (listed in README.md)` : ""}`);
    if (m.missingEssential.length) setStatus(`Live mirror downloaded, but INCOMPLETE: ${m.missingEssential.length} of the pages' own scripts / stylesheets couldn't be downloaded (connection dropped?), so it won't look or work right offline. Check your connection and export it again.`, "error");
    else setStatus(`Live mirror downloaded (${m.pages} pages, ${m.count} files). Preview it or publish it from “Your export” below — or unzip it and drag the folder onto app.netlify.com/drop.`, "ok");
  } catch (err) {
    exportFailed(err);
  } finally {
    try {
      if (attached) await chrome.debugger.detach({ tabId });
    } catch {
      /* window closed */
    }
    await closeCrawlWindow();
    src.busy = false;
    src.progress = 1;
    renderOutput();
  }
}

// ── Send to WordPress (StyleLift Importer plugin + Elementor) ─────────────────
async function openWpSend(): Promise<void> {
  const wp = await loadWp();
  if (!wpConfigured(wp)) {
    setStatus("Connect your WordPress site first: Settings → WordPress.", "error");
    chrome.runtime.openOptionsPage();
    return;
  }
  try {
    const r = await captureCurrent();
    const sections = listSections(r.html);
    state.source.wp = {
      html: r.html, title: r.title || hostOf(r.url), url: r.url, sections,
      picked: new Set(sections.map((x) => x.index)), target: "template", scoped: true, sideload: true, busy: false,
    };
    setStatus(`Pick the sections to send to ${new URL(wp.wpSite).host} (${sections.length} found).`, "ok");
    renderOutput();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}
async function sendWp(): Promise<void> {
  const w = state.source.wp;
  if (!w || !w.picked.size) return;
  const wp = await loadWp();
  const all = w.picked.size === w.sections.length;
  const only = all ? undefined : Array.from(w.picked).sort((a, b) => a - b);
  const first = w.sections.find((x) => x.index === only?.[0]);
  const title = all ? w.title : `${w.title} · ${(first?.label || "section").split(" · ")[0]}${only && only.length > 1 ? ` +${only.length - 1}` : ""}`;
  const tpl = buildElementorTemplate(w.html, title, { only, scoped: w.scoped });
  w.busy = true;
  w.error = undefined;
  w.result = undefined;
  renderOutput();
  try {
    w.result = await wpImport(wp, {
      title, target: w.target, template_type: all ? "page" : "section", content: tpl.content,
      page_settings: tpl.page_settings, source_url: w.url, sideload: w.sideload,
    });
    setStatus(`Sent to WordPress as ${w.result.target === "page" ? "a draft page" : "an Elementor template"}${w.result.images_imported ? ` with ${w.result.images_imported} images in the Media Library` : ""}.`, "ok");
  } catch (err) {
    w.error = err instanceof Error ? err.message : String(err);
    setStatus(w.error, "error");
  } finally {
    w.busy = false;
    renderOutput();
  }
}
function renderWpPicker(): HTMLElement {
  const w = state.source.wp!;
  const box = document.createElement("div");
  box.className = "edit-group wp-picker";
  const h = document.createElement("h3");
  h.textContent = "Send to WordPress";
  box.appendChild(h);
  const quick = document.createElement("div");
  quick.className = "seg wp-quick";
  for (const [label, all] of [["All", true], ["None", false]] as const) {
    const b = document.createElement("button");
    b.className = "btn ghost";
    b.textContent = label;
    b.disabled = w.busy;
    b.addEventListener("click", () => { w.picked = new Set(all ? w.sections.map((x) => x.index) : []); renderOutput(); });
    quick.appendChild(b);
  }
  box.appendChild(quick);
  const list = document.createElement("div");
  list.className = "wp-sections";
  for (const sec of w.sections) {
    const lab = document.createElement("label");
    lab.className = "wp-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `wp-sec-${sec.index}`;
    cb.checked = w.picked.has(sec.index);
    cb.disabled = w.busy;
    cb.addEventListener("change", () => { cb.checked ? w.picked.add(sec.index) : w.picked.delete(sec.index); renderOutput(); });
    const t = document.createElement("span");
    t.textContent = sec.label;
    lab.append(cb, t);
    list.appendChild(lab);
  }
  box.appendChild(list);
  const opt = (id: string, label: string, checked: boolean, on: (v: boolean) => void) => {
    const lab = document.createElement("label");
    lab.className = "wp-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.checked = checked;
    cb.disabled = w.busy;
    cb.addEventListener("change", () => { on(cb.checked); renderOutput(); });
    const t = document.createElement("span");
    t.textContent = label;
    lab.append(cb, t);
    return lab;
  };
  const target = document.createElement("div");
  target.className = "seg";
  for (const [val, label] of [["template", "Elementor template"], ["page", "Draft page"]] as const) {
    const b = document.createElement("button");
    b.className = "btn" + (w.target === val ? " active" : "");
    b.textContent = label;
    b.disabled = w.busy;
    b.addEventListener("click", () => { w.target = val; renderOutput(); });
    target.appendChild(b);
  }
  box.append(
    target,
    opt("wp-scoped", "Keep these styles from changing the rest of the site", w.scoped, (v) => (w.scoped = v)),
    opt("wp-sideload", "Copy images into the Media Library", w.sideload, (v) => (w.sideload = v)),
  );
  const actions = document.createElement("div");
  actions.className = "editor-footer";
  const send = document.createElement("button");
  send.className = "btn primary";
  send.textContent = w.busy ? "Sending…" : `Send ${w.picked.size === w.sections.length ? "the whole page" : `${w.picked.size} section${w.picked.size === 1 ? "" : "s"}`}`;
  send.disabled = w.busy || !w.picked.size;
  send.addEventListener("click", () => void sendWp());
  const close = document.createElement("button");
  close.className = "btn ghost";
  close.textContent = "Close";
  close.disabled = w.busy;
  close.addEventListener("click", () => { state.source.wp = null; renderOutput(); });
  actions.append(send, close);
  box.appendChild(actions);
  if (w.result) {
    const done = document.createElement("div");
    done.className = "edit-note";
    const a = document.createElement("a");
    a.href = w.result.edit_url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = w.result.elementor_active ? "Open in Elementor" : "Open in WordPress (activate Elementor to edit)";
    done.append("Done. ", a);
    box.appendChild(done);
  } else if (w.error) {
    const e = document.createElement("div");
    e.className = "edit-note wp-error";
    e.textContent = w.error;
    box.appendChild(e);
  }
  return box;
}

async function exportElementor(): Promise<void> {
  try {
    const r = await captureCurrent();
    const tpl = buildElementorTemplate(r.html, r.title || hostOf(r.url));
    downloadBlob(JSON.stringify(tpl, null, 2), `${hostOf(r.url)}.elementor.json`, "application/json");
    setStatus(`Exported an Elementor template (${tpl.content.length} containers). Import it via Templates → Saved Templates → Import.`, "ok");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}

async function exportReact(): Promise<void> {
  setStatus("Generating React component…", "busy");
  try {
    const html = await captureHtml();
    if (!html) throw new Error("Nothing to export.");
    const name = state.sel ? "Component" : "Page";
    const jsx = htmlToJsx(html, name);
    downloadBlob(jsx, `${hostOf(state.origin || "page")}.${name}.jsx`, "text/jsx");
    setStatus(
      state.sel
        ? "Exported the selected element as a React component (.jsx)."
        : "Exported the page as a React component (.jsx).",
      "ok",
    );
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  }
}

// ── DeepSeek (context-aware: Polish in page mode, Explain in component mode) ───
async function runAi(): Promise<void> {
  if (state.mode === "component") return explain();
  return polish();
}

async function polish(): Promise<void> {
  if (!state.tokens) return;
  setStatus("Polishing with DeepSeek…", "busy");
  aiBtn.disabled = true;
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: "POLISH",
      tokens: state.tokens,
    })) as PolishResponse;
    if (!resp?.ok || !resp.enrichment) throw new Error(resp?.error || "Polish failed.");
    state.enrichment = resp.enrichment;
    state.pageTab = "design";
    setStatus("Polished — names, roles, and guidelines applied.", "ok");
    renderAll();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  } finally {
    syncAiButton();
  }
}

async function explain(): Promise<void> {
  if (!state.component) return;
  setStatus("Explaining the component with DeepSeek…", "busy");
  aiBtn.disabled = true;
  try {
    const resp = (await chrome.runtime.sendMessage({
      type: "EXPLAIN_COMPONENT",
      blueprint: state.component,
    })) as ExplainComponentResponse;
    if (!resp?.ok || !resp.explanation) throw new Error(resp?.error || "Explain failed.");
    state.explanation = resp.explanation;
    state.componentTab = "guide";
    setStatus("Explained — architecture & replication guide added.", "ok");
    renderAll();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
  } finally {
    syncAiButton();
  }
}

// ── copy / download ───────────────────────────────────────────────────────────
async function copyActive(): Promise<void> {
  const text = activeText();
  if (!text) {
    setStatus("Nothing to copy yet.", "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copied active tab to clipboard.", "ok");
  } catch {
    setStatus("Clipboard blocked by the browser.", "error");
  }
}

function download(): void {
  let md: string;
  let name: string;
  if (state.mode === "component" && state.component) {
    md = renderComponentMd(state.component, state.explanation);
    name = `COMPONENT.${slugifyName(state.component.label)}.md`;
  } else if (state.tokens) {
    md = renderDesignMd(state.tokens, state.enrichment, state.density);
    name = `DESIGN.${hostOf(state.tokens.meta.url)}.md`;
  } else {
    setStatus("Nothing to download yet — extract or inspect first.", "error");
    return;
  }
  saveText(md, name, "text/markdown");
  setStatus(`Downloaded ${name}`, "ok");
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "site";
  }
}
function slugifyName(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "component";
}

// ── rendering ─────────────────────────────────────────────────────────────────
function renderAll(): void {
  renderModeBar();
  renderTabs();
  renderOutput();
  syncAiButton();
  subtoggle.style.display = state.mode === "page" ? "flex" : "none";
  tabsNav.style.display = state.mode === "edit" || state.mode === "source" ? "none" : "flex";
}

function renderModeBar(): void {
  const editCount = Object.keys(state.overrides).length + state.structOps.length;
  const hasEdits = editCount > 0;
  if (!state.tokens && !state.component && state.mode !== "edit" && state.mode !== "source" && !hasEdits) {
    modebar.innerHTML = "";
    return;
  }
  const btn = (active: boolean, label: string, disabled: boolean, onClick: () => void) => {
    const b = document.createElement("button");
    b.className = "modepill" + (active ? " active" : "");
    b.textContent = label;
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  };
  const pills = [
    btn(state.mode === "page", "Page tokens", !state.tokens, () => {
      state.mode = "page";
      renderAll();
    }),
    btn(
      state.mode === "component",
      state.component ? `Component · ${state.component.label}` : "Component",
      !state.component,
      () => {
        state.mode = "component";
        renderAll();
      },
    ),
  ];
  if (state.mode === "edit" || hasEdits) {
    pills.push(
      btn(state.mode === "edit", `Edit${hasEdits ? ` · ${editCount}` : ""}`, false, () => {
        state.mode = "edit";
        renderAll();
      }),
    );
  }
  if (state.mode === "source" || state.source.last) {
    pills.push(
      btn(state.mode === "source", "Source", false, () => {
        state.mode = "source";
        renderAll();
      }),
    );
  }
  modebar.replaceChildren(...pills);
}

function renderTabs(): void {
  if (state.mode === "edit" || state.mode === "source") {
    tabsNav.replaceChildren();
    return;
  }
  const config =
    state.mode === "component"
      ? COMPONENT_TABS.map((t) => ({ id: t.id as string, label: t.label }))
      : PAGE_TABS.map((t) => ({ id: t.id as string, label: t.label }));
  const activeId = state.mode === "component" ? state.componentTab : state.pageTab;
  tabsNav.replaceChildren(
    ...config.map(({ id, label }) => {
      const b = document.createElement("button");
      b.className = "tab" + (id === activeId ? " active" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        if (state.mode === "component") state.componentTab = id as ComponentTab;
        else state.pageTab = id as PageTab;
        renderTabs();
        renderOutput();
      });
      return b;
    }),
  );
}

// ── visual-editor control panel ─────────────────────────────────────────────────
function renderEditor(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "editor";

  // status + start/stop
  const head = document.createElement("div");
  head.className = "editor-head";
  head.innerHTML = state.editorActive
    ? `<div class="editor-live">● Visual editor <b>active</b></div>`
    : `<div class="editor-target">Visual editor stopped.</div>`;
  const toggle = document.createElement("button");
  toggle.className = "btn " + (state.editorActive ? "danger-ghost" : "primary");
  toggle.textContent = state.editorActive ? "Stop" : "Start editor";
  toggle.addEventListener("click", toggleEditor);
  head.appendChild(toggle);
  wrap.appendChild(head);

  if (state.editorActive) {
    // responsive preview device switcher
    const dev = document.createElement("div");
    dev.className = "device-bar";
    for (const [id, lbl, ic] of [["desktop", "Desktop", "desktop"], ["tablet", "Tablet", "tablet"], ["mobile", "Mobile", "phone"]] as [string, string, string][]) {
      const b = document.createElement("button");
      b.className = "device-btn" + (state.device === id ? " active" : "");
      b.innerHTML = icon(ic, 14) + lbl;
      b.title = `Preview the page at ${lbl.toLowerCase()} width`;
      b.addEventListener("click", () => setDevice(id));
      dev.appendChild(b);
    }
    wrap.appendChild(dev);

    // undo / redo toolbar
    const bar = document.createElement("div");
    bar.className = "edit-toolbar";
    const undoB = document.createElement("button");
    undoB.id = "sl-undo";
    undoB.className = "btn icon-btn";
    undoB.innerHTML = icon("undo") + " Undo";
    undoB.disabled = !state.canUndo;
    undoB.addEventListener("click", doUndo);
    const redoB = document.createElement("button");
    redoB.id = "sl-redo";
    redoB.className = "btn icon-btn";
    redoB.innerHTML = icon("redo") + " Redo";
    redoB.disabled = !state.canRedo;
    redoB.addEventListener("click", doRedo);
    bar.append(undoB, redoB);
    wrap.appendChild(bar);

    // insert-widget palette
    const ins = document.createElement("div");
    ins.className = "edit-group";
    ins.innerHTML = `<h3>Insert ${state.sel ? "after selection" : "(select a spot first)"}</h3>`;
    const palette = document.createElement("div");
    palette.className = "widget-palette";
    const WIDGETS: [string, string, string][] = [
      ["heading", "heading", "Heading"],
      ["text", "paragraph", "Text"],
      ["button", "button", "Button"],
      ["image", "image", "Image"],
      ["spacer", "spacer", "Spacer"],
      ["divider", "divider", "Divider"],
      ["container", "box", "Container"],
    ];
    for (const [kind, ic, lbl] of WIDGETS) {
      const b = document.createElement("button");
      b.className = "widget-chip";
      b.innerHTML = icon(ic) + " " + lbl;
      b.addEventListener("click", () => insertWidget(kind));
      palette.appendChild(b);
    }
    ins.appendChild(palette);
    wrap.appendChild(ins);

    // layers navigator
    wrap.appendChild(renderLayers());
  }

  if (state.editorActive && state.sel) {
    wrap.appendChild(renderPropertyPanel(state.sel));
  } else if (state.editorActive) {
    const hint = document.createElement("div");
    hint.className = "edit-group edit-tips";
    hint.innerHTML = `<div class="edit-note">Click any element on the page to edit it here.</div>`;
    wrap.appendChild(hint);
  }

  // summary + export
  const total = countEdits(state.overrides) + state.structOps.length;
  const summary = document.createElement("div");
  summary.className = "edit-group";
  summary.innerHTML = `<h3>Edits on this site</h3>
    <div class="edit-note">${total} change(s) · ${Object.keys(state.overrides).length} element(s) · ${state.structOps.length} structural.</div>`;
  wrap.appendChild(summary);

  const expHead = document.createElement("h3");
  expHead.className = "export-head";
  expHead.textContent = "Export project (.zip)";
  wrap.appendChild(expHead);

  // primary: editable multi-file projects
  const footer = document.createElement("div");
  footer.className = "editor-footer";
  const expHtmlZip = document.createElement("button");
  expHtmlZip.className = "btn primary";
  expHtmlZip.textContent = "HTML";
  expHtmlZip.title = "index.html + styles.css + assets/ as real files (editable in VS Code)";
  expHtmlZip.addEventListener("click", () => exportProject("html"));
  const expReactZip = document.createElement("button");
  expReactZip.className = "btn accent";
  expReactZip.textContent = "React";
  expReactZip.title = "Vite + React: src/App.jsx + src/components/<Section>.jsx + public/assets/";
  expReactZip.addEventListener("click", () => exportProject("react"));
  const expNextZip = document.createElement("button");
  expNextZip.className = "btn accent";
  expNextZip.textContent = "Next.js";
  expNextZip.title = "Next.js App Router: app/layout + app/page + one component per section + public/assets/";
  expNextZip.addEventListener("click", () => exportProject("next"));
  footer.append(expHtmlZip, expReactZip, expNextZip);
  wrap.appendChild(footer);

  // secondary: single-file / fragments
  const footer2 = document.createElement("div");
  footer2.className = "editor-footer";
  const single = document.createElement("button");
  single.className = "btn";
  single.textContent = "1-file HTML";
  single.title = "Single self-contained .html (assets embedded as data URIs)";
  single.addEventListener("click", exportOffline);
  const expReact = document.createElement("button");
  expReact.className = "btn";
  expReact.textContent = ".jsx";
  expReact.title = state.sel ? "Selected element → single .jsx" : "Page body → single .jsx";
  expReact.addEventListener("click", exportReact);
  const exp = document.createElement("button");
  exp.className = "btn";
  exp.textContent = "CSS";
  exp.addEventListener("click", exportCss);
  const expJson = document.createElement("button");
  expJson.className = "btn";
  expJson.textContent = "JSON";
  expJson.addEventListener("click", exportJson);
  const expFigma = document.createElement("button");
  expFigma.className = "btn";
  expFigma.textContent = "Figma";
  expFigma.title = "The page, with your edits, as Figma layers — open the .zip with the StyleLift plugin for Figma (included)";
  expFigma.addEventListener("click", exportFigma);
  footer2.append(single, expReact, exp, expJson, expFigma);
  wrap.appendChild(footer2);
  const more = document.createElement("button");
  more.className = "btn source";
  more.style.marginTop = "6px";
  more.textContent = "Whole site / Elementor / options →";
  more.addEventListener("click", () => {
    state.mode = "source";
    renderAll();
  });
  wrap.appendChild(more);

  if (total > 0) {
    const reset = document.createElement("button");
    reset.className = "btn danger-ghost";
    reset.style.width = "100%";
    reset.style.marginTop = "8px";
    reset.textContent = "Reset all edits";
    reset.addEventListener("click", resetAllEdits);
    wrap.appendChild(reset);
  }
  return wrap;
}

// Collapsible Layers tree — lazily loads children, click to select (works for
// elements behind overlays and inside shadow DOM), hover to highlight on the page.
function renderLayers(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "edit-group";
  const head = document.createElement("button");
  head.className = "layers-head";
  head.innerHTML = `${icon(state.layersOpen ? "chevronDown" : "chevronRight", 13)}${icon("layers", 14)} Layers`;
  head.addEventListener("click", async () => {
    state.layersOpen = !state.layersOpen;
    if (state.layersOpen && !state.treeKids.has("__root__")) await loadChildren(null);
    renderOutput();
  });
  wrap.appendChild(head);

  if (state.layersOpen) {
    const tree = document.createElement("div");
    tree.className = "layers-tree";
    const roots = state.treeKids.get("__root__") || [];
    for (const node of roots) tree.appendChild(layerNode(node, 0));
    if (!roots.length) tree.innerHTML = `<div class="edit-note">Loading…</div>`;
    wrap.appendChild(tree);
  }
  return wrap;
}
function layerNode(
  node: { ref: string; label: string; tag: string; hasChildren: boolean },
  depth: number,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "layer-row";
  row.style.paddingLeft = 6 + depth * 12 + "px";
  const expanded = state.treeExpanded.has(node.ref);

  const twisty = document.createElement("button");
  twisty.className = "layer-twisty";
  twisty.innerHTML = node.hasChildren ? icon(expanded ? "chevronDown" : "chevronRight", 12) : "";
  twisty.disabled = !node.hasChildren;
  twisty.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!node.hasChildren) return;
    if (expanded) state.treeExpanded.delete(node.ref);
    else {
      state.treeExpanded.add(node.ref);
      if (!state.treeKids.has(node.ref)) await loadChildren(node.ref);
    }
    renderOutput();
  });

  const name = document.createElement("button");
  name.className = "layer-name" + (state.sel && state.sel.label === node.label ? " sel" : "");
  name.textContent = node.label;
  name.title = node.label;
  name.addEventListener("click", () => selectByRef(node.ref));
  name.addEventListener("mouseenter", () => hiliteRef(node.ref));
  name.addEventListener("mouseleave", () => hiliteRef(null));

  row.append(twisty, name);

  const container = document.createElement("div");
  container.appendChild(row);
  if (expanded) {
    const kids = state.treeKids.get(node.ref) || [];
    for (const k of kids) container.appendChild(layerNode(k, depth + 1));
  }
  return container;
}

// The Elementor-style property panel for the selected element.
function renderPropertyPanel(sel: NonNullable<typeof state.sel>): HTMLElement {
  const box = document.createElement("div");
  box.className = "prop-panel";

  // breadcrumb of ancestors — click any crumb to select it (great for reaching
  // a container behind an overlay)
  if (sel.ancestors && sel.ancestors.length) {
    const bc = document.createElement("div");
    bc.className = "breadcrumb";
    sel.ancestors.forEach((a, i) => {
      if (i) bc.appendChild(Object.assign(document.createElement("span"), { className: "bc-sep", textContent: "›" }));
      const crumb = document.createElement("button");
      crumb.className = "bc-item" + (i === sel.ancestors.length - 1 ? " active" : "");
      crumb.textContent = a.label;
      crumb.title = a.label;
      crumb.addEventListener("click", () => selectByRef(a.ref));
      crumb.addEventListener("mouseenter", () => hiliteRef(a.ref));
      crumb.addEventListener("mouseleave", () => hiliteRef(null));
      bc.appendChild(crumb);
    });
    box.appendChild(bc);
  }

  const title = document.createElement("div");
  title.className = "prop-title";
  title.innerHTML = `<code>${escHtml(sel.label)}</code>`;
  box.appendChild(title);

  // structure ops row
  const ops = document.createElement("div");
  ops.className = "struct-ops";
  const OP_TIPS: Record<string, string> = { moveUp: "Move up (before the previous element)", moveDown: "Move down (after the next element)", duplicate: "Duplicate this element", delete: "Delete this element" };
  const opBtn = (ic: string, op: string, danger = false, label = "") => {
    const b = document.createElement("button");
    b.className = "btn struct-btn" + (danger ? " danger-ghost" : "");
    b.innerHTML = icon(ic) + (label ? " " + label : "");
    b.title = OP_TIPS[op] || op;
    b.setAttribute("aria-label", OP_TIPS[op] || op);
    b.addEventListener("click", () => applyStruct(op));
    return b;
  };
  ops.append(
    opBtn("arrowUp", "moveUp"),
    opBtn("arrowDown", "moveDown"),
    opBtn("copy", "duplicate", false, "Duplicate"),
    opBtn("trash", "delete", true, "Delete"),
  );
  box.appendChild(ops);

  // match style (copy/paste look between elements)
  const match = document.createElement("div");
  match.className = "struct-ops match-row";
  const copyB = document.createElement("button");
  copyB.className = "btn struct-btn";
  copyB.innerHTML = icon("brush") + " Copy style";
  copyB.addEventListener("click", matchCopy);
  const pasteB = document.createElement("button");
  pasteB.className = "btn struct-btn";
  pasteB.innerHTML = icon("paste") + " Paste style";
  pasteB.addEventListener("click", matchPaste);
  match.append(copyB, pasteB);
  box.appendChild(match);

  // AI chat-to-edit
  const ai = document.createElement("div");
  ai.className = "edit-group ai-edit";
  ai.innerHTML = `<h3>${icon("wand")} AI edit ${state.hasKey ? "" : "<span class='edit-note'>(add key in settings)</span>"}</h3>`;
  const aiInput = document.createElement("input");
  aiInput.className = "edit-input";
  aiInput.placeholder = "e.g. make it bolder and dark blue";
  aiInput.disabled = !state.hasKey || state.aiBusy;
  const aiGo = document.createElement("button");
  aiGo.className = "btn accent";
  aiGo.style.width = "100%";
  aiGo.style.marginTop = "6px";
  aiGo.textContent = state.aiBusy ? "Thinking…" : "Apply AI edit";
  aiGo.disabled = !state.hasKey || state.aiBusy;
  aiGo.addEventListener("click", () => aiEdit(aiInput.value));
  aiInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") aiEdit(aiInput.value);
  });
  ai.append(aiInput, aiGo);
  box.appendChild(ai);

  // context-sensitive group based on the element type
  const ctx = renderContextGroup(sel);
  if (ctx) box.appendChild(ctx);

  // text (leaf elements)
  if (sel.canText) {
    const tg = document.createElement("div");
    tg.className = "edit-group";
    tg.innerHTML = `<h3>Content</h3>`;
    const ta = document.createElement("textarea");
    ta.className = "edit-css";
    ta.value = state.overrides[sel.selector]?.html ?? sel.text;
    ta.addEventListener("input", () => applyText(ta.value));
    tg.appendChild(ta);
    box.appendChild(tg);
  }

  // scope selector: Base / Hover / Tablet / Mobile (Elementor's state + device)
  const scopeRow = document.createElement("div");
  scopeRow.className = "scope-row";
  const SCOPES = [
    { id: "base", label: "Base", ic: "desktop" },
    { id: "hover", label: "Hover", ic: "cursor" },
    { id: "tablet", label: "Tablet", ic: "tablet" },
    { id: "mobile", label: "Mobile", ic: "phone" },
  ];
  for (const sc of SCOPES) {
    const b = document.createElement("button");
    b.className = "scope-btn" + (sc.id === state.scope ? " active" : "");
    b.innerHTML = icon(sc.ic, 13) + sc.label;
    b.addEventListener("click", () => {
      state.scope = sc.id;
      renderOutput();
    });
    scopeRow.appendChild(b);
  }
  box.appendChild(scopeRow);
  if (state.scope !== "base") {
    const note = document.createElement("div");
    note.className = "edit-note";
    note.textContent =
      state.scope === "hover"
        ? "Editing the :hover state — changes apply on mouse-over."
        : `Editing the ${state.scope} breakpoint (max-width ${state.scope === "tablet" ? 1024 : 640}px).`;
    box.appendChild(note);
  }

  // tabbed style controls
  const tabsRow = document.createElement("div");
  tabsRow.className = "prop-tabs";
  for (const tab of EDIT_TABS) {
    const b = document.createElement("button");
    b.className = "prop-tab" + (tab.id === state.editTab ? " active" : "");
    b.textContent = tab.label;
    b.addEventListener("click", () => {
      state.editTab = tab.id;
      renderOutput();
    });
    tabsRow.appendChild(b);
  }
  box.appendChild(tabsRow);

  const active = EDIT_TABS.find((t) => t.id === state.editTab) || EDIT_TABS[0];
  for (const group of active.groups) {
    const g = document.createElement("div");
    g.className = "edit-group";
    const h = document.createElement("h3");
    h.textContent = group.title;
    g.appendChild(h);
    for (const field of group.fields) {
      // base scope can show the page's computed value as a placeholder
      const computed = state.scope === "base" ? sel.values[field.prop] || "" : "";
      g.appendChild(propRow(field, currentPropValue(sel.selector, field.prop), computed));
    }
    box.appendChild(g);
  }

  if (state.editTab === "advanced") {
    const cg = document.createElement("div");
    cg.className = "edit-group";
    cg.innerHTML = `<h3>Custom CSS</h3>`;
    const ta = document.createElement("textarea");
    ta.className = "edit-css";
    ta.placeholder = "transform: rotate(2deg);\ncursor: pointer;";
    ta.value = state.overrides[sel.selector]?.css || "";
    ta.addEventListener("change", () => applyCustomCss(ta.value.trim()));
    cg.appendChild(ta);
    box.appendChild(cg);
  }
  return box;
}

// Element-type-aware controls (image replace/upload, link, video, background).
function renderContextGroup(sel: NonNullable<typeof state.sel>): HTMLElement | null {
  const g = document.createElement("div");
  g.className = "edit-group ctx-group";
  const ov = state.overrides[sel.selector]?.attrs || {};
  const cur = (name: string) => ov[name] ?? sel.attrs[name] ?? "";

  const textField = (label: string, name: string, placeholder = "") => {
    const row = document.createElement("label");
    row.className = "edit-field";
    row.innerHTML = `<span class="edit-label">${label}</span>`;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "edit-input";
    inp.placeholder = placeholder;
    inp.value = cur(name);
    inp.addEventListener("change", () => applyAttr(name, inp.value.trim() || null));
    row.appendChild(inp);
    return row;
  };
  const uploadBtn = (label: string, accept: string, onData: (d: string) => void) => {
    const b = document.createElement("button");
    b.className = "btn upload-btn";
    b.innerHTML = icon("plus") + " " + label;
    b.addEventListener("click", () => pickFile(accept, onData));
    return b;
  };
  const checkbox = (label: string, name: string, on: boolean) => {
    const row = document.createElement("label");
    row.className = "edit-field check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = on;
    cb.addEventListener("change", () => applyAttr(name, cb.checked ? "" : null));
    row.append(cb, Object.assign(document.createElement("span"), { textContent: label }));
    return row;
  };

  if (sel.tag === "img") {
    g.innerHTML = `<h3>Image</h3>`;
    if (cur("src")) {
      const prev = document.createElement("img");
      prev.className = "ctx-thumb";
      prev.src = cur("src");
      g.appendChild(prev);
    }
    g.appendChild(textField("Source", "src", "https://… or upload"));
    g.appendChild(uploadBtn("Upload image", "image/*", (d) => applyAttr("src", d)));
    g.appendChild(textField("Alt text", "alt"));
    g.appendChild(propRow({ prop: "object-fit", label: "Fit", type: "select", options: ["", "cover", "contain", "fill", "none", "scale-down"] }, state.overrides[sel.selector]?.props?.["object-fit"] ?? "", sel.values["object-fit"] || ""));
    return g;
  }
  if (sel.tag === "a") {
    g.innerHTML = `<h3>Link</h3>`;
    g.appendChild(textField("URL (href)", "href", "https://…"));
    g.appendChild(checkbox("Open in new tab", "target", cur("target") === "_blank"));
    return g;
  }
  if (sel.tag === "video") {
    g.innerHTML = `<h3>Video</h3>`;
    g.appendChild(textField("Source", "src", "https://… .mp4"));
    g.appendChild(uploadBtn("Upload video", "video/*", (d) => applyAttr("src", d)));
    g.appendChild(textField("Poster", "poster"));
    g.appendChild(uploadBtn("Upload poster", "image/*", (d) => applyAttr("poster", d)));
    if (sel.media) {
      g.appendChild(checkbox("Autoplay", "autoplay", sel.media.autoplay));
      g.appendChild(checkbox("Loop", "loop", sel.media.loop));
      g.appendChild(checkbox("Muted", "muted", sel.media.muted));
      g.appendChild(checkbox("Controls", "controls", sel.media.controls));
    }
    return g;
  }
  // any element: background image (incl. when it already has one)
  g.innerHTML = `<h3>Background image</h3>`;
  const bgRow = document.createElement("label");
  bgRow.className = "edit-field";
  bgRow.innerHTML = `<span class="edit-label">URL</span>`;
  const bgInp = document.createElement("input");
  bgInp.type = "text";
  bgInp.className = "edit-input";
  bgInp.placeholder = "https://… or upload";
  bgInp.value = state.overrides[sel.selector]?.props?.["background-image"] || "";
  bgInp.addEventListener("change", () => applyProp("background-image", bgInp.value.trim() ? `url("${bgInp.value.trim()}")` : ""));
  bgRow.appendChild(bgInp);
  g.appendChild(bgRow);
  g.appendChild(uploadBtn("Upload background", "image/*", (d) => applyProp("background-image", `url("${d}")`)));
  return g;
}

function propRow(field: EditableField, current: string, computed: string): HTMLElement {
  const row = document.createElement("label");
  row.className = "edit-field";
  const lab = document.createElement("span");
  lab.className = "edit-label";
  lab.textContent = field.label;
  row.appendChild(lab);
  const value = current || "";

  if (field.type === "color") {
    const wrapEl = document.createElement("div");
    wrapEl.className = "edit-color";
    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.value = colorToHex(value || computed || "#000000");
    const text = document.createElement("input");
    text.type = "text";
    text.className = "edit-input";
    text.placeholder = computed || "rgb / hex";
    text.value = value;
    swatch.addEventListener("input", () => {
      text.value = swatch.value;
      applyProp(field.prop, swatch.value);
    });
    text.addEventListener("change", () => {
      if (text.value) swatch.value = colorToHex(text.value);
      applyProp(field.prop, text.value.trim());
    });
    wrapEl.append(swatch, text);
    row.appendChild(wrapEl);
  } else if (field.type === "select") {
    const s = document.createElement("select");
    s.className = "edit-input";
    for (const opt of field.options || []) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt || `(${computed || "default"})`;
      s.appendChild(o);
    }
    s.value = value;
    s.addEventListener("change", () => applyProp(field.prop, s.value));
    row.appendChild(s);
  } else if (field.type === "range") {
    const rng = document.createElement("input");
    rng.type = "range";
    rng.min = "0";
    rng.max = "1";
    rng.step = "0.05";
    rng.value = value || computed || "1";
    rng.addEventListener("input", () => applyProp(field.prop, rng.value));
    row.appendChild(rng);
  } else {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "edit-input";
    inp.placeholder = field.placeholder || computed || "";
    inp.value = value;
    inp.addEventListener("change", () => applyProp(field.prop, inp.value.trim()));
    row.appendChild(inp);
  }
  return row;
}

function renderOutput(): void {
  if (state.mode === "edit") {
    output.replaceChildren(renderEditor());
    return;
  }
  if (state.mode === "source") {
    output.replaceChildren(renderSource());
    return;
  }
  if (state.mode === "component") {
    if (!state.component) return;
    if (state.componentTab === "guide") {
      output.replaceChildren(mdBlock(renderComponentMd(state.component, state.explanation)));
    } else if (state.componentTab === "assets") {
      output.replaceChildren(renderComponentAssets(state.component));
    } else {
      output.replaceChildren(
        codeBlock(componentTabText(state.component, state.explanation, state.componentTab)),
      );
    }
    return;
  }

  const t = state.tokens;
  if (!t) return;
  if (state.pageTab === "design") {
    output.replaceChildren(mdBlock(renderDesignMd(t, state.enrichment, state.density)));
  } else if (state.pageTab === "assets") {
    output.innerHTML = renderAssetsHtml(t.assets);
  } else {
    output.replaceChildren(codeBlock(activeText()));
  }
}

// ── source capture panel ───────────────────────────────────────────────────────
function renderSource(): HTMLElement {
  const src = state.source;
  const wrap = document.createElement("div");

  const scope = document.createElement("div");
  scope.className = "edit-group";
  scope.innerHTML = `<h3>Get source code</h3><div class="edit-note">Captures the page exactly as rendered — lazy images loaded, scroll/appear animations settled, CSS-in-JS and shadow DOM included. Your visual edits are baked in.</div>`;
  const sc = document.createElement("div");
  sc.className = "src-scope";
  for (const [id, label] of [["page", "This page"], ["site", "Whole site"]] as const) {
    const b = document.createElement("button");
    b.className = "modepill" + (src.scope === id ? " active" : "");
    b.textContent = label;
    b.disabled = src.busy;
    b.addEventListener("click", () => {
      src.scope = id;
      renderOutput();
    });
    sc.appendChild(b);
  }
  scope.appendChild(sc);

  const opts = document.createElement("div");
  opts.className = "src-opts";
  const check = (label: string, value: boolean, title: string, on: (v: boolean) => void) => {
    const l = document.createElement("label");
    l.title = title;
    const i = document.createElement("input");
    i.type = "checkbox";
    i.checked = value;
    i.disabled = src.busy;
    i.addEventListener("change", () => on(i.checked));
    l.append(i, document.createTextNode(label));
    return l;
  };
  const num = (label: string, value: number, min: number, max: number, on: (v: number) => void) => {
    const l = document.createElement("label");
    const i = document.createElement("input");
    i.type = "number";
    i.min = String(min);
    i.max = String(max);
    i.value = String(value);
    i.disabled = src.busy;
    i.addEventListener("change", () => on(Math.min(max, Math.max(min, Number(i.value) || min))));
    l.append(document.createTextNode(label), i);
    return l;
  };
  opts.append(
    check("Load lazy content", src.deferred, "Scroll through the page first so lazy images and scroll/appear animations fire", (v) => (src.deferred = v)),
    check("Reveal animated-in elements", src.reveal, "Un-freeze elements an appear animation left at opacity 0 (Framer, GSAP, AOS…)", (v) => (src.reveal = v)),
    check("Remove cookie banners", src.cookies, "Drop consent dialogs / backdrops (CookieConsent, OneTrust, Cookiebot, Usercentrics…)", (v) => (src.cookies = v)),
    check("Replay the intro", src.intro, "Reload the page once and record its opening animation (hero text, loaders), so the copy plays it too", (v) => (src.intro = v)),
    check("Keep 3D scenes live", src.live3d, "HTML / React / Next.js projects keep the page's WebGL scenes running from the site's own code (interactive, not a picture). Needs a web server; only for sites you own or may copy.", (v) => (src.live3d = v)),
    check("Keep scripts", src.scripts === "keep", "Keep <script> tags (page may re-hydrate online). Off = clean static capture.", (v) => (src.scripts = v ? "keep" : "strip")),
  );
  if (src.scope === "site") {
    opts.append(
      check("Use sitemap.xml", src.sitemap, "Seed the crawl from /sitemap.xml too", (v) => (src.sitemap = v)),
      num("Max pages ", src.maxPages, 1, 200, (v) => (src.maxPages = v)),
      num("Link depth ", src.maxDepth, 0, 6, (v) => (src.maxDepth = v)),
    );
  }
  scope.appendChild(opts);
  wrap.appendChild(scope);

  const ex = document.createElement("div");
  ex.className = "edit-group";
  ex.innerHTML = `<h3>${src.scope === "site" ? "Export the whole site" : "Export this page"}</h3>`;
  const SRC_ICON: Record<string, string> = {
    "Edit in Studio": "edit", "Edit site in Studio": "edit", "Live mirror (.zip)": "cube", "Send to WordPress": "upload", "Next.js (.zip)": "fileCode", "React (.zip)": "atom",
    "HTML (.zip)": "code", "Figma (.zip)": "layers", "Next.js site (.zip)": "fileCode", "HTML site (.zip)": "globe", "Single-file pages (.zip)": "file", Cancel: "close",
  };
  const mk = (label: string, cls: string, title: string, fn: () => void | Promise<void>) => {
    const b = document.createElement("button");
    const mine = src.running === label;
    b.className = "btn " + cls + (mine ? " running" : "");
    // the button that's working shows it: a spinner in place of its icon
    b.innerHTML = mine ? `<span class="spin" aria-hidden="true"></span>` : SRC_ICON[label] ? icon(SRC_ICON[label], 14) : "";
    b.append(label);
    b.title = title;
    b.disabled = src.busy || (!!src.running && !mine) || (label !== "Cancel" && mine);
    if (mine) b.setAttribute("aria-busy", "true");
    b.addEventListener("click", label === "Cancel" ? fn : () => void runSourceAction(label, fn));
    return b;
  };
  const row1 = document.createElement("div");
  row1.className = "editor-footer";
  const row2 = document.createElement("div");
  row2.className = "editor-footer";
  if (src.scope === "site") {
    const studioSite = mk("Edit site in Studio", "primary", "Capture every page, then edit them in StyleLift Studio (a Pages list, one canvas per page) and export the whole site", openSiteInStudio);
    studioSite.style.width = "100%";
    studioSite.style.marginBottom = "8px";
    ex.appendChild(studioSite);
    row1.append(
      mk("Next.js site (.zip)", "primary", "Next.js App Router: one route per page, section components per page, shared public/assets/", () => exportSite("next")),
      mk("HTML site (.zip)", "accent", "index.html + <page>/index.html + styles/ + assets/ — internal links rewritten, assets shared", () => exportSite("project")),
    );
    row2.append(mk("Single-file pages (.zip)", "", "One self-contained .html per page (assets embedded as data URIs)", () => exportSite("offline")));
    const row3 = document.createElement("div");
    row3.className = "editor-footer";
    const siteMirror = mk("Live mirror (.zip)", "", "Every page with the site's own code and files, so 3D scenes and every interaction run like the original. Run it with: node server.mjs. Only for sites you own or may copy.", exportSiteMirror);
    siteMirror.style.width = "100%";
    row3.append(siteMirror);
    const note = document.createElement("div");
    note.className = "edit-note";
    note.textContent = "A capture window opens and visits each page (keep it visible — background tabs pause animations). Same-origin pages only.";
    ex.append(row1, row2, row3, note);
  } else {
    const studio = mk("Edit in Studio", "primary", "Open this page in StyleLift Studio: Desktop / Tablet / Phone canvas, layers, properties — then export", openInStudio);
    studio.style.width = "100%";
    studio.style.marginBottom = "8px";
    ex.appendChild(studio);
    row1.append(
      mk("Next.js (.zip)", "accent", "Next.js App Router: app/layout + app/page + one component per section + public/assets/", () => exportProject("next")),
      mk("React (.zip)", "", "Vite + React: src/App.jsx + src/components/<Section>.jsx + public/assets/", () => exportProject("react")),
      mk("HTML (.zip)", "", "index.html + styles.css + assets/ (editable in VS Code)", () => exportProject("html")),
    );
    row2.append(
      mk("1-file HTML", "", "Single self-contained .html (assets embedded)", exportOffline),
      mk("Raw HTML", "", "Captured document as-is (assets linked online)", exportRawHtml),
      mk("Elementor (.json)", "", "Elementor template: each section → container with an HTML widget. Import via Templates → Saved Templates → Import", exportElementor),
      mk(".jsx", "", "Page body → single React component", exportReact),
      mk("Figma (.zip)", "", "The page as Figma layers — frames, editable text, pictures, vectors, Auto Layout, colour variables and text styles. Open it with the StyleLift plugin for Figma (included in the zip)", exportFigma),
    );
    const row3 = document.createElement("div");
    row3.className = "editor-footer";
    const mirrorBtn = mk("Live mirror (.zip)", "", "The site's own code and files, so 3D scenes and every interaction run like the original. Run it with: node server.mjs. Only for sites you own or may copy.", exportMirror);
    mirrorBtn.style.width = "100%";
    mirrorBtn.style.marginBottom = "6px";
    const wpBtn = mk("Send to WordPress", "accent", "Pick sections of this page and send them to your WordPress site as an Elementor template or a draft page", openWpSend);
    wpBtn.style.width = "100%";
    row3.style.flexDirection = "column";
    row3.append(mirrorBtn, wpBtn);
    ex.append(row1, row2, row3);
  }
  if (src.busy) {
    const cancel = mk("Cancel", "danger-ghost", "Stop after the current page", () => {
      src.cancel = true;
      srcLog("Cancelling after the current page…");
    });
    cancel.disabled = false;
    cancel.style.width = "100%";
    cancel.style.marginTop = "8px";
    ex.appendChild(cancel);
  }
  wrap.appendChild(ex);
  if (src.wp) wrap.appendChild(renderWpPicker());
  if (src.ready) wrap.appendChild(renderReady(src.ready));

  if (src.busy || src.log.length) {
    const prog = document.createElement("div");
    prog.className = "edit-group";
    prog.innerHTML = `<h3>${src.busy ? "Capturing…" : "Last capture"}</h3>`;
    if (src.scope === "site" || src.busy) {
      const bar = document.createElement("div");
      bar.className = "src-bar";
      const fill = document.createElement("i");
      fill.style.width = `${Math.round(src.progress * 100)}%`;
      bar.appendChild(fill);
      prog.appendChild(bar);
    }
    const log = document.createElement("div");
    log.className = "src-log";
    log.textContent = src.log.slice(-40).join("\n");
    prog.appendChild(log);
    wrap.appendChild(prog);
    requestAnimationFrame(() => (log.scrollTop = log.scrollHeight));
  }
  return wrap;
}

// An always-visible inline Copy button that copies the given text.
function copyFab(text: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "copy-fab";
  btn.textContent = "Copy";
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied!";
      btn.classList.add("done");
      setStatus("Copied to clipboard.", "ok");
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("done");
      }, 1400);
    } catch {
      setStatus("Clipboard blocked by the browser.", "error");
    }
  });
  return btn;
}

// A scrollable code block with an inline Copy button.
function codeBlock(text: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "code-wrap";
  const pre = document.createElement("pre");
  pre.className = "code";
  pre.textContent = text;
  wrap.append(copyFab(text), pre);
  return wrap;
}

// A rendered-markdown block (Guide / DESIGN.md) whose Copy button copies the
// underlying markdown SOURCE, not the HTML.
function mdBlock(md: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "md-wrap";
  const doc = document.createElement("div");
  doc.className = "md";
  doc.innerHTML = markdownToHtml(md);
  wrap.append(copyFab(md), doc);
  return wrap;
}

// Visual assets view for an inspected component: inline-SVG previews (rendered
// safely via a data: URI in an <img>, so no page script can execute here),
// image thumbnails, and video links — each copyable / downloadable.
function renderComponentAssets(bp: ComponentBlueprint): HTMLElement {
  const a = bp.assets;
  const wrap = document.createElement("div");
  if (!a.svgs.length && !a.images.length && !a.videos.length) {
    wrap.innerHTML = `<div class="empty">No images, SVGs, or videos found in this component. Try inspecting a card that contains an icon or illustration.</div>`;
    return wrap;
  }

  if (a.svgs.length) {
    const group = document.createElement("div");
    group.className = "asset-group";
    const h = document.createElement("h3");
    h.textContent = `Inline SVGs (${a.svgs.length})`;
    group.append(h);
    for (const s of a.svgs) {
      const row = document.createElement("div");
      row.className = "svg-row";
      const prev = document.createElement("div");
      prev.className = "svg-prev";
      const previewable = /^<svg[\s>]/i.test(s.markup.trim()) && !s.markup.includes("truncated");
      if (previewable) {
        const img = document.createElement("img");
        img.src = `data:image/svg+xml,${encodeURIComponent(s.markup)}`;
        img.alt = s.label;
        img.loading = "lazy";
        // <use> sprite refs and CSS-only fills can't resolve standalone — show a chip
        img.addEventListener("error", () => {
          prev.classList.add("svg-na");
          prev.textContent = "SVG";
        });
        prev.append(img);
      } else {
        prev.classList.add("svg-na");
        prev.textContent = "SVG";
      }
      const meta = document.createElement("div");
      meta.className = "svg-meta";
      const label = document.createElement("span");
      label.className = "svg-label";
      label.textContent = s.label;
      const copy = copyFab(s.markup);
      copy.classList.add("inline-copy");
      copy.textContent = "Copy SVG";
      const dl = document.createElement("button");
      dl.className = "copy-fab inline-copy";
      dl.textContent = "Download";
      dl.addEventListener("click", () => downloadBlob(s.markup, `${slugifyName(s.label)}.svg`, "image/svg+xml"));
      meta.append(label, copy, dl);
      row.append(prev, meta);
      group.append(row);
    }
    wrap.append(group);
  }

  if (a.images.length || a.videos.length) {
    const [extImg, inlineImg] = splitInline(a.images);
    const rest = document.createElement("div");
    rest.innerHTML =
      assetGroupHtml("Images", extImg, true) +
      assetGroupHtml("Inline images", inlineImg, true) +
      assetGroupHtml("Videos", a.videos, false);
    wrap.append(rest);
  }
  return wrap;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}
function prettyBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

// One asset row, aware of inline (data:) entries vs external URLs.
function assetRow(it: AssetEntry, thumb: boolean): string {
  const img = thumb
    ? `<img class="asset-thumb" src="${escHtml(it.url)}" alt="" loading="lazy" />`
    : "";
  if (it.inline || it.url.startsWith("data:")) {
    const size = it.bytes ? ` · ${prettyBytes(it.bytes)}` : "";
    const name = `inline.${it.type || "img"}`;
    return `<li>${img}<span class="type">${escHtml(it.type || "img")}</span>
      <span class="asset-name">inline image${size}</span>
      <a class="dl" href="${escHtml(it.url)}" download="${escHtml(name)}" title="Download">↓</a></li>`;
  }
  return `<li>${img}<span class="type">${escHtml(it.type || "?")}</span>
    <a href="${escHtml(it.url)}" target="_blank" rel="noreferrer">${escHtml(it.url)}</a>
    <a class="dl" href="${escHtml(it.url)}" download target="_blank" rel="noreferrer" title="Download">↓</a></li>`;
}
function assetGroupHtml(title: string, items: AssetEntry[], thumb: boolean): string {
  if (!items.length) return "";
  const rows = items.map((it) => assetRow(it, thumb)).join("");
  return `<div class="asset-group"><h3>${title} (${items.length})</h3><ul class="asset-list">${rows}</ul></div>`;
}
// Split a list into external URLs vs inline data: entries.
function splitInline(items: AssetEntry[]): [AssetEntry[], AssetEntry[]] {
  const inline = items.filter((i) => i.inline || i.url.startsWith("data:"));
  const external = items.filter((i) => !(i.inline || i.url.startsWith("data:")));
  return [external, inline];
}

function downloadBlob(text: string, name: string, mime: string): void {
  saveText(text, name, mime);
  setStatus(`Downloaded ${name}`, "ok");
}

function renderAssetsHtml(a: Assets): string {
  const [extImg, inlineImg] = splitInline(a.images);
  const html =
    assetGroupHtml("Fonts", a.fonts, false) +
    assetGroupHtml("Images", extImg, true) +
    assetGroupHtml("Inline images", inlineImg, true) +
    assetGroupHtml("Videos", a.videos, false) +
    assetGroupHtml("3D Models", a.models, false);
  return html || `<div class="empty">No external assets detected on this page.</div>`;
}

// ── AI button state (label + enablement depend on mode) ───────────────────────
function syncAiButton(): void {
  // AI editing isn't part of this milestone — hide the button while editing.
  aiBtn.style.display = state.mode === "edit" ? "none" : "";
  if (state.mode === "component") {
    aiBtn.innerHTML = icon("wand", 15) + "Explain with DeepSeek";
    aiBtn.disabled = !state.hasKey || !state.component;
  } else {
    aiBtn.innerHTML = icon("wand", 15) + "Polish with DeepSeek";
    aiBtn.disabled = !state.hasKey || !state.tokens;
  }
  aiBtn.title = state.hasKey
    ? state.mode === "component"
      ? "Explain how this component is built"
      : "Name & describe tokens with DeepSeek"
    : "Add a DeepSeek key in settings to enable";
}

// ── density wiring ────────────────────────────────────────────────────────────
document.querySelectorAll<HTMLButtonElement>(".density").forEach((b) => {
  b.addEventListener("click", () => {
    state.density = b.dataset.density as Density;
    document
      .querySelectorAll<HTMLButtonElement>(".density")
      .forEach((d) => d.classList.toggle("active", d === b));
    if (state.tokens) renderOutput();
  });
});

extractBtn.addEventListener("click", extract);
inspectBtn.addEventListener("click", inspect);
editBtn.addEventListener("click", toggleEditor);
sourceBtn.addEventListener("click", async () => {
  try {
    const { origin } = await activeTab();
    if (origin) state.origin = origin;
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), "error");
    return;
  }
  state.mode = "source";
  renderAll();
});
aiBtn.addEventListener("click", runAi);
copyBtn.addEventListener("click", copyActive);
downloadBtn.addEventListener("click", download);
settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

// ── settings awareness (enables the AI button) ────────────────────────────────
async function refreshKeyState(): Promise<void> {
  const s = (await chrome.storage.local.get(["deepseekApiKey"])) as Partial<Settings>;
  state.hasKey = !!s.deepseekApiKey;
  syncAiButton();
}
// the in-page editor pushes the current selection here
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "SL_SELECT" && state.editorActive) {
    state.sel = {
      selector: msg.selector,
      label: msg.label,
      tag: msg.tag || "",
      ancestors: msg.ancestors || [],
      values: msg.values || {},
      attrs: msg.attrs || {},
      bg: msg.bg || "",
      media: msg.media || null,
      canText: !!msg.canText,
      text: msg.text || "",
    };
    if (state.mode === "edit") renderOutput();
  } else if (msg?.type === "SL_HISTORY" && state.editorActive) {
    state.canUndo = !!msg.canUndo;
    state.canRedo = !!msg.canRedo;
    // refresh just the toolbar buttons if present
    const u = document.getElementById("sl-undo") as HTMLButtonElement | null;
    const r = document.getElementById("sl-redo") as HTMLButtonElement | null;
    if (u) u.disabled = !state.canUndo;
    if (r) r.disabled = !state.canRedo;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.deepseekApiKey) refreshKeyState();
  // the in-page editor writes edits straight to storage — mirror them into the
  // panel, but DON'T re-render the property inputs (that would steal focus while
  // the user is typing). Only update the lightweight mode-bar pill counts.
  if ((changes[OVERRIDES_KEY] || changes[STRUCT_KEY]) && state.editorActive) {
    refreshEditsFromStorage().then(() => {
      if (state.mode === "edit") renderModeBar();
    });
  }
});

// initial render
renderTabs();
refreshKeyState();
