import type { ComponentBlueprint, ComponentExplanation } from "../shared/types";

// Deterministic renderers for an inspected component. Structure and CSS values
// come from the blueprint (measured from the page). A ComponentExplanation, when
// present, only adds narration — it never supplies values.

export type ComponentTab = "guide" | "structure" | "animations" | "code" | "assets" | "tokens";

// ── Guide tab → COMPONENT.md ───────────────────────────────────────────────────

export function renderComponentMd(
  bp: ComponentBlueprint,
  ex: ComponentExplanation | null,
): string {
  const md: string[] = [];
  md.push(`# Component: \`${bp.label}\``, "");
  const summary =
    ex?.summary ||
    `A ${bp.rect.width}×${bp.rect.height}px section built from ${bp.nodeCount} elements. The breakdown below is measured directly from the rendered DOM.`;
  md.push(`> ${summary}`, "");
  md.push(`*Selector: \`${bp.selector}\`*`, "");

  // Architecture
  md.push("## Architecture", "");
  if (ex?.techniques?.length) {
    for (const t of ex.techniques) md.push(`- **${t.title}** — ${t.detail}`);
  } else if (bp.techniques.length) {
    for (const t of bp.techniques) md.push(`- ${t}`);
  } else {
    md.push("- Static layout — no animations, transforms, or layered positioning detected.");
  }
  md.push("");

  // Motion
  if (bp.animations.length || bp.transitions.length || bp.triggers.length) {
    md.push("## Motion", "");
    if (bp.animations.length) {
      md.push("**Animations**", "");
      for (const a of bp.animations) {
        const tag =
          a.source === "script"
            ? " — _JS / Web Animations API_"
            : a.source === "hover"
              ? " — _starts on hover/focus_"
              : "";
        const timing = [a.duration, a.timingFunction].filter((x) => x && x !== "0s").join(" ");
        const iter = a.iterationCount && a.iterationCount !== "1" ? `, ${a.iterationCount}×` : "";
        const delay = a.delay && a.delay !== "0s" && a.delay !== "0ms" ? `, delay ${a.delay}` : "";
        md.push(`- \`${a.name}\` on \`${a.selector}\`${timing ? ` — ${timing}` : ""}${iter}${delay}${tag}`);
      }
      md.push("");
    }
    if (bp.transitions.length) {
      md.push("**Transitions**", "");
      for (const t of bp.transitions.slice(0, 12)) {
        md.push(`- \`${t.property}\` ${t.duration} ${t.timingFunction} on \`${t.selector}\``);
      }
      md.push("");
    }
    if (bp.triggers.length) {
      md.push("**Triggered states** (what drives the motion)", "");
      for (const tr of bp.triggers.slice(0, 12)) md.push(`- \`${tr.selectorText}\``);
      md.push("");
    }
  }

  // Replication
  md.push("## How to replicate", "");
  const steps = ex?.steps?.length ? ex.steps : defaultSteps(bp);
  steps.forEach((s, i) => md.push(`${i + 1}. ${s}`));
  md.push("");
  md.push("*Full markup and curated CSS are in the **Code** tab; copy them as a starting point.*", "");

  // Tokens used
  const t = bp.tokens;
  if (t.colors.length || t.fonts.length || t.gradients.length) {
    md.push("## Tokens used here", "");
    if (t.colors.length) md.push(`- **Colors:** ${t.colors.map((c) => `\`${c}\``).join(" ")}`);
    if (t.fonts.length) md.push(`- **Fonts:** ${t.fonts.join(", ")}`);
    if (t.radii.length) md.push(`- **Radii:** ${t.radii.map((r) => `\`${r}\``).join(" ")}`);
    if (t.shadows.length) md.push(`- **Shadows:** ${t.shadows.length}`);
    if (t.gradients.length) md.push(`- **Gradients:** ${t.gradients.length}`);
    md.push("");
  }

  // Assets
  const a = bp.assets;
  if (a.svgs.length || a.images.length || a.videos.length) {
    md.push("## Assets", "");
    if (a.svgs.length) md.push(`- **Inline SVGs:** ${a.svgs.length} (${a.svgs.map((s) => s.label).slice(0, 6).join(", ")}) — copy the markup from the **Code** tab.`);
    if (a.images.length) md.push(`- **Images:** ${a.images.length}${a.images.some((i) => i.type === "svg") ? " (incl. SVG files)" : ""}`);
    if (a.videos.length) md.push(`- **Videos:** ${a.videos.length}`);
    md.push("");
  }

  // Gotchas
  if (ex?.gotchas?.length) {
    md.push("## Gotchas", "");
    for (const g of ex.gotchas) md.push(`- ${g}`);
    md.push("");
  }
  return md.join("\n");
}

function defaultSteps(bp: ComponentBlueprint): string[] {
  const steps: string[] = [];
  const root = bp.digests[0];
  if (root) {
    const layout = root.styles.display || "block";
    const pos = root.styles.position ? `, ${root.styles.position}` : "";
    steps.push(`Set up the container as \`display: ${layout}\`${pos}${root.styles["grid-template-columns"] ? ` with \`grid-template-columns: ${root.styles["grid-template-columns"]}\`` : ""}.`);
  } else {
    steps.push("Set up the container element.");
  }
  if (bp.techniques.some((t) => t.startsWith("Layered"))) {
    steps.push("Recreate the stacked layers with absolutely-positioned children and explicit `z-index` (see the Code tab's digest entries).");
  }
  const visual: string[] = [];
  if (bp.tokens.gradients.length) visual.push("gradient background");
  if (bp.tokens.radii.length) visual.push(`radius (${bp.tokens.radii[0]})`);
  if (bp.tokens.shadows.length) visual.push("box-shadow");
  if (visual.length) steps.push(`Apply the surface styling: ${visual.join(", ")}.`);
  if (bp.keyframes.length) {
    steps.push(`Add the \`@keyframes\` block(s) — ${bp.keyframes.map((k) => `\`${k.name}\``).join(", ")} — and attach the matching \`animation\` shorthand.`);
  }
  if (bp.transitions.length || bp.triggers.length) {
    steps.push("Wire interaction motion: add the `transition` declarations and the `:hover`/`:focus` rules from the Code tab.");
  }
  const media: string[] = [];
  if (bp.assets.svgs.length) media.push(`${bp.assets.svgs.length} inline SVG icon(s)`);
  if (bp.assets.images.length) media.push(`${bp.assets.images.length} image(s)`);
  if (bp.assets.videos.length) media.push(`${bp.assets.videos.length} video(s)`);
  if (media.length) steps.push(`Drop in the media — ${media.join(", ")} (in the Code tab).`);
  steps.push("Swap measured values for your own design tokens where appropriate.");
  return steps;
}

// ── Structure tab → indented tree (built from the cleaned HTML) ─────────────────

export function renderStructure(bp: ComponentBlueprint): string {
  // Lightweight tag-only outline parsed from the cleaned HTML, so the user sees
  // the skeleton without the full attribute noise.
  const lines: string[] = [`${bp.label}  (${bp.nodeCount} nodes, ${bp.rect.width}×${bp.rect.height})`, ""];
  const tagRe = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let depth = 0;
  let m: RegExpExecArray | null;
  const VOID = new Set(["img", "input", "br", "hr", "source", "meta", "link", "path", "circle", "rect", "use"]);
  let count = 0;
  while ((m = tagRe.exec(bp.html)) && count < 400) {
    const [, closing, tag, attrs, selfClose] = m;
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const idMatch = attrs.match(/\bid="([^"]+)"/);
    const clsMatch = attrs.match(/\bclass="([^"]+)"/);
    const id = idMatch ? `#${idMatch[1]}` : "";
    const cls = clsMatch ? "." + clsMatch[1].trim().split(/\s+/).slice(0, 3).join(".") : "";
    lines.push("  ".repeat(depth) + `${tag}${id}${cls}`);
    count++;
    if (!selfClose && !VOID.has(tag.toLowerCase())) depth++;
  }
  return lines.join("\n");
}

// ── Animations tab → motion-focused dump ────────────────────────────────────────

export function renderAnimations(bp: ComponentBlueprint): string {
  const out: string[] = [];
  if (!bp.animations.length && !bp.transitions.length && !bp.keyframes.length && !bp.triggers.length) {
    return "No CSS animations, transitions, or interaction rules were detected in this component.";
  }
  if (bp.animations.length) {
    out.push("/* ── Animations ── */");
    for (const a of bp.animations) {
      const src = a.source === "script" ? "JS / Web Animations API" : a.source === "hover" ? "starts on hover/focus" : "CSS @keyframes";
      out.push(`/* ${a.selector}  —  ${src} */`);
      const parts = [a.name, a.duration, a.timingFunction, a.delay, a.iterationCount, a.direction, a.fillMode]
        .filter((x) => x && x !== "0s" && x !== "0ms" && x !== "normal" && x !== "none");
      out.push(`animation: ${parts.join(" ")};`, "");
    }
  }
  if (bp.keyframes.length) {
    out.push("/* ── @keyframes (verbatim) ── */");
    for (const k of bp.keyframes) out.push(k.css, "");
  }
  if (bp.transitions.length) {
    out.push("/* ── Transitions ── */");
    for (const t of bp.transitions) {
      out.push(`/* ${t.selector} */`);
      out.push(`transition: ${t.property} ${t.duration} ${t.timingFunction}${t.delay && t.delay !== "0s" ? " " + t.delay : ""};`, "");
    }
  }
  if (bp.triggers.length) {
    out.push("/* ── Triggered states (:hover / :focus / :active) ── */");
    for (const tr of bp.triggers) out.push(`${tr.selectorText} { ${tr.css} }`);
  }
  return out.join("\n");
}

// ── Code tab → cleaned HTML + curated, denoised CSS ─────────────────────────────

export function renderComponentCode(bp: ComponentBlueprint): string {
  const out: string[] = [];
  out.push("<!-- ═══ HTML ═══ -->", bp.html, "");
  out.push("/* ═══ CSS (curated computed styles — denoised) ═══ */");
  if (bp.keyframes.length) {
    for (const k of bp.keyframes) out.push(k.css);
    out.push("");
  }
  for (const d of bp.digests) {
    const decls = Object.entries(d.styles)
      .map(([p, v]) => `  ${p}: ${v};`)
      .join("\n");
    out.push(`/* ${d.label} */`);
    out.push(`${d.selector} {\n${decls}\n}`, "");
  }
  if (bp.triggers.length) {
    out.push("/* interaction rules */");
    for (const tr of bp.triggers) out.push(`${tr.selectorText} { ${tr.css} }`);
    out.push("");
  }
  if (bp.assets.svgs.length) {
    out.push("<!-- ═══ Inline SVGs (copy-ready) ═══ -->");
    for (const s of bp.assets.svgs) {
      out.push(`<!-- ${s.label} -->`, s.markup, "");
    }
  }
  if (bp.assets.images.length || bp.assets.videos.length) {
    out.push("/* ═══ Referenced media ═══ */");
    for (const a of bp.assets.images) out.push(`/* image: ${a.url} */`);
    for (const a of bp.assets.videos) out.push(`/* video: ${a.url} */`);
  }
  return out.join("\n");
}

// ── Tokens tab → scoped W3C-ish dump for just this component ─────────────────────

export function renderComponentTokens(bp: ComponentBlueprint): string {
  const t = bp.tokens;
  const lines: string[] = [`/* Tokens scoped to ${bp.label} */`, ""];
  if (t.colors.length) {
    lines.push(":root {");
    t.colors.forEach((c, i) => lines.push(`  --c-${i + 1}: ${c};`));
    lines.push("}", "");
  }
  if (t.gradients.length) {
    lines.push("/* gradients */");
    t.gradients.forEach((g, i) => lines.push(`--gradient-${i + 1}: ${g};`));
    lines.push("");
  }
  if (t.fonts.length) lines.push(`/* fonts: ${t.fonts.join(", ")} */`);
  if (t.radii.length) lines.push(`/* radii: ${t.radii.join(", ")} */`);
  if (t.spacing.length) lines.push(`/* spacing: ${t.spacing.join(", ")} */`);
  if (t.shadows.length) {
    lines.push("", "/* shadows */");
    t.shadows.forEach((s, i) => lines.push(`--shadow-${i + 1}: ${s};`));
  }
  return lines.join("\n");
}

// ── Assets tab → plain-text list (drives the global Copy) ───────────────────────

export function renderComponentAssetsText(bp: ComponentBlueprint): string {
  const a = bp.assets;
  const lines: string[] = [];
  if (a.svgs.length) {
    lines.push(`# Inline SVGs (${a.svgs.length})`);
    for (const s of a.svgs) lines.push("", `## ${s.label}`, s.markup);
    lines.push("");
  }
  if (a.images.length) {
    lines.push(`# Images (${a.images.length})`);
    for (const i of a.images) lines.push(`- ${i.url}`);
    lines.push("");
  }
  if (a.videos.length) {
    lines.push(`# Videos (${a.videos.length})`);
    for (const v of a.videos) lines.push(`- ${v.url}`);
  }
  return lines.join("\n").trim() || "No images, SVGs, or videos found in this component.";
}

// Convenience: which tab text feeds Copy.
export function componentTabText(bp: ComponentBlueprint, ex: ComponentExplanation | null, tab: ComponentTab): string {
  switch (tab) {
    case "guide":
      return renderComponentMd(bp, ex);
    case "structure":
      return renderStructure(bp);
    case "animations":
      return renderAnimations(bp);
    case "code":
      return renderComponentCode(bp);
    case "assets":
      return renderComponentAssetsText(bp);
    case "tokens":
      return renderComponentTokens(bp);
  }
}
