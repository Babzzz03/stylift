// StyleLift for Figma — the plugin: its window (ui.html) reads the bundle, the builder (builder.ts) makes the layers.
/// <reference types="@figma/plugin-typings" />
import type { FigmaSnapshot } from "../../src/extractor/figma-snapshot";
import { build } from "./builder";
import { readSelection } from "./reader";

figma.showUI(__html__, { width: 380, height: 380, themeColors: true });

type Msg = { type: "import"; snap: FigmaSnapshot; images: Record<string, Uint8Array>; variables: boolean } | { type: "read" };
figma.ui.onmessage = async (msg: Msg) => {
  if (msg.type === "read") {
    // the selected frames → a StyleLift design (Studio opens it; HTML, React, Next.js from there)
    try {
      const out = await readSelection();
      if (!out.design.pages.length) throw new Error("Select one or more frames first (or keep frames on this page).");
      figma.ui.postMessage({ type: "read-done", ...out });
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  if (msg.type !== "import") return;
  try {
    const out = await build(msg.snap, msg.images, msg.variables, (layers) => figma.ui.postMessage({ type: "progress", layers }));
    figma.ui.postMessage({ type: "done", ...out });
    figma.notify(`StyleLift: ${out.layers} layers built${out.missingFonts.length ? ` · ${out.missingFonts.length} font(s) replaced` : ""}`);
  } catch (e) {
    figma.ui.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
