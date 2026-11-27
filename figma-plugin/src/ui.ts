// The plugin's window: open a StyleLift Figma bundle (.zip), read it, hand the snapshot and its pictures to the
// builder (code.ts), show how it went.
import type { FigmaSnapshot } from "../../src/extractor/figma-snapshot";
import { strToU8, zipSync } from "../../src/panel/zip";
import type { DesignBundle } from "./reader";
import { unzip } from "../../src/shared/unzip";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const drop = $<HTMLLabelElement>("drop");
const input = $<HTMLInputElement>("file");
const status = $<HTMLParagraphElement>("status");
const system = $<HTMLInputElement>("system");

const say = (text: string, kind: "" | "busy" | "ok" | "error" = "") => {
  status.textContent = text;
  status.className = kind;
};

async function open(file: File): Promise<void> {
  try {
    say(`Reading ${file.name}…`, "busy");
    const files = await unzip(new Uint8Array(await file.arrayBuffer()));
    const json = files.get("figma.json") || Array.from(files.entries()).find(([k]) => k.endsWith("/figma.json"))?.[1];
    if (!json) throw new Error("No figma.json in this .zip — export the page with StyleLift → Figma.");
    const snap = JSON.parse(new TextDecoder().decode(json)) as FigmaSnapshot;
    if (snap.v !== 1 || !snap.root) throw new Error("This bundle is from a newer StyleLift: update the plugin.");
    const prefix = json === files.get("figma.json") ? "" : Array.from(files.keys()).find((k) => k.endsWith("/figma.json"))!.slice(0, -"figma.json".length);
    const images: Record<string, Uint8Array> = {};
    for (const im of snap.images) {
      const hit = Array.from(files.keys()).find((k) => k.startsWith(`${prefix}images/${im.id}.`));
      if (hit) images[im.id] = files.get(hit)!;
    }
    say(`Building ${snap.stats.nodes} layers from ${new URL(snap.url).hostname}…`, "busy");
    parent.postMessage({ pluginMessage: { type: "import", snap, images, variables: system.checked } }, "*");
  } catch (e) {
    say(e instanceof Error ? e.message : String(e), "error");
  }
}

input.addEventListener("change", () => { if (input.files?.[0]) void open(input.files[0]); input.value = ""; });
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  const f = e.dataTransfer?.files?.[0];
  if (f) void open(f);
});

// ── the two directions ───────────────────────────────────────────────────────────
const tabIn = $<HTMLButtonElement>("tab-in"), tabOut = $<HTMLButtonElement>("tab-out");
const show = (out: boolean) => {
  tabIn.classList.toggle("on", !out);
  tabOut.classList.toggle("on", out);
  $<HTMLElement>("pane-in").hidden = out;
  $<HTMLElement>("pane-out").hidden = !out;
  say("");
};
tabIn.addEventListener("click", () => show(false));
tabOut.addEventListener("click", () => show(true));

// Figma → StyleLift: the plugin reads the frames; this window packs them (design.json + the pictures) and saves it
$<HTMLButtonElement>("send").addEventListener("click", () => {
  say("Reading the frames…", "busy");
  parent.postMessage({ pluginMessage: { type: "read" } }, "*");
});
const extOf = (b: Uint8Array) => (b[0] === 0x89 && b[1] === 0x50 ? "png" : b[0] === 0xff && b[1] === 0xd8 ? "jpg" : b[0] === 0x47 && b[1] === 0x49 ? "gif" : b[0] === 0x52 && b[8] === 0x57 ? "webp" : "bin");
function saveDesign(design: DesignBundle, images: Record<string, Uint8Array>): void {
  const entries = [{ name: "design.json", data: strToU8(JSON.stringify(design)) }];
  for (const [id, bytes] of Object.entries(images)) entries.push({ name: `images/${id}.${extOf(bytes)}`, data: bytes });
  const blob = new Blob([zipSync(entries) as Uint8Array<ArrayBuffer>], { type: "application/zip" });
  const name = (design.pages.length === 1 ? design.pages[0].title : design.file).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "design";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.stylelift.zip`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  const layers = design.pages.reduce((n, p) => n + p.stats.nodes, 0);
  say(`Saved ${a.download}: ${design.pages.length} page(s), ${layers} layers, ${Object.keys(images).length} pictures. Open it in StyleLift Studio → Open a Figma design.`, "ok");
}

type Reply =
  | { type: "progress"; layers: number }
  | { type: "done"; layers: number; missingFonts: string[]; variables: number; styles: number; images: number; imagesFailed: number }
  | { type: "error"; message: string }
  | { type: "read-done"; design: DesignBundle; images: Record<string, Uint8Array>; skipped: number };
onmessage = (e: MessageEvent) => {
  const m = e.data?.pluginMessage as Reply | undefined;
  if (!m) return;
  if (m.type === "progress") say(`Building… ${m.layers} layers so far`, "busy");
  else if (m.type === "error") say(`It stopped: ${m.message}`, "error");
  else if (m.type === "read-done") saveDesign(m.design, m.images);
  else {
    const bits = [`${m.layers} layers built`];
    if (m.variables) bits.push(`${m.variables} colour variables`);
    if (m.styles) bits.push(`${m.styles} text styles`);
    let text = bits.join(" · ") + ".";
    if (m.imagesFailed) text += ` ${m.imagesFailed} picture(s) Figma couldn't read were left out.`;
    if (m.missingFonts.length) text += ` Fonts Figma doesn't have here (shown in Inter until you install them): ${m.missingFonts.join(", ")}.`;
    say(text, m.missingFonts.length || m.imagesFailed ? "" : "ok");
  }
};
