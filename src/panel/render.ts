import type {
  ColorToken,
  DesignTokens,
  Enrichment,
  FontFamilyToken,
} from "../shared/types";

// All renderers are pure: token JSON (+ optional enrichment) -> string.
// They run BEFORE any LLM. Enrichment only supplies names/roles/guidance.

export type Density = "compact" | "extended";

const COMPACT_COLORS = 12;

// ── naming / role heuristics (used until DeepSeek polish replaces them) ────────

export function humanizeVar(name: string): string {
  return name
    .replace(/^--/, "")
    .replace(/^(color|c|clr|theme|brand|palette)-/, "")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "token"
  );
}

function dominantProp(c: ColorToken): string {
  let best = "";
  let max = -1;
  for (const [prop, count] of Object.entries(c.usedOn)) {
    if (count > max) {
      max = count;
      best = prop;
    }
  }
  return best;
}

const ROLE_LABELS: Record<string, string> = {
  "background-color": "Background surface",
  color: "Text / foreground",
  "border-color": "Border / divider",
  fill: "Icon / decorative fill",
  stroke: "Icon stroke",
  "box-shadow": "Shadow tint",
};

function defaultColorName(c: ColorToken): string {
  return c.cssVar ? humanizeVar(c.cssVar) : c.value;
}

function defaultColorRole(c: ColorToken, isTop: boolean): string {
  const label = ROLE_LABELS[dominantProp(c)] || "Accent";
  return isTop ? `${label} · most-used` : label;
}

// ── name resolution that prefers enrichment, then heuristics ───────────────────

interface ResolvedColor {
  value: string;
  name: string;
  slug: string;
  token: string;
  role: string;
}

function resolveColors(
  tokens: DesignTokens,
  enrichment: Enrichment | null,
  density: Density,
): ResolvedColor[] {
  const list =
    density === "compact" ? tokens.colors.slice(0, COMPACT_COLORS) : tokens.colors;
  const enrichMap = new Map<string, { name: string; role: string }>();
  if (enrichment) {
    for (const e of enrichment.colors) enrichMap.set(e.value.toLowerCase(), e);
  }
  const usedSlugs = new Map<string, number>();
  return list.map((c, i) => {
    const e = enrichMap.get(c.value.toLowerCase());
    const name = e?.name || defaultColorName(c);
    const role = e?.role || defaultColorRole(c, i === 0);
    // unnamed colors fall back to a plain index so the token reads `--color-1`,
    // not `--color-color-1`; named colors slugify their evocative name.
    let slug = slugify(name === c.value ? `${i + 1}` : name);
    const seen = usedSlugs.get(slug) || 0;
    usedSlugs.set(slug, seen + 1);
    if (seen) slug = `${slug}-${seen + 1}`;
    return { value: c.value, name, slug, token: `--color-${slug}`, role };
  });
}

// ── CSS Variables tab ─────────────────────────────────────────────────────────

export function renderCssVariables(tokens: DesignTokens, density: Density): string {
  const lines: string[] = [":root {"];
  const vars = Object.entries(tokens.cssVariables);
  if (vars.length) {
    lines.push("  /* Custom properties read from the page */");
    for (const [name, value] of vars) lines.push(`  ${name}: ${value};`);
    lines.push("");
  }
  lines.push("  /* Extracted color palette */");
  const colors = resolveColors(tokens, null, density);
  for (const c of colors) lines.push(`  ${c.token}: ${c.value};`);

  const radii = density === "compact" ? tokens.radii.slice(0, 6) : tokens.radii;
  if (radii.length) {
    lines.push("", "  /* Radii */");
    radii.forEach((r, i) => lines.push(`  --radius-${i + 1}: ${r.value};`));
  }
  const spacing = density === "compact" ? tokens.spacing.slice(0, 8) : tokens.spacing;
  if (spacing.length) {
    lines.push("", "  /* Spacing */");
    spacing.forEach((s, i) => lines.push(`  --spacing-${i + 1}: ${s.value};`));
  }
  lines.push("}");
  return lines.join("\n");
}

// ── Tailwind v4 @theme tab ─────────────────────────────────────────────────────

export function renderTailwind(tokens: DesignTokens, density: Density): string {
  const lines: string[] = ["@theme {"];
  const colors = resolveColors(tokens, null, density);
  for (const c of colors) lines.push(`  ${c.token}: ${c.value};`);

  const fams =
    density === "compact" ? tokens.typography.families.slice(0, 4) : tokens.typography.families;
  if (fams.length) {
    lines.push("");
    const usedSlugs = new Map<string, number>();
    for (const f of fams) {
      let slug = slugify(f.family);
      const seen = usedSlugs.get(slug) || 0;
      usedSlugs.set(slug, seen + 1);
      if (seen) slug = `${slug}-${seen + 1}`;
      lines.push(`  --font-${slug}: "${f.family}";`);
    }
  }
  const radii = density === "compact" ? tokens.radii.slice(0, 6) : tokens.radii;
  if (radii.length) {
    lines.push("");
    radii.forEach((r, i) => lines.push(`  --radius-${i + 1}: ${r.value};`));
  }
  const shadows = density === "compact" ? tokens.shadows.slice(0, 6) : tokens.shadows;
  if (shadows.length) {
    lines.push("");
    shadows.forEach((s, i) => lines.push(`  --shadow-${i + 1}: ${s.value};`));
  }
  const spacing = density === "compact" ? tokens.spacing.slice(0, 8) : tokens.spacing;
  if (spacing.length) {
    lines.push("");
    spacing.forEach((s, i) => lines.push(`  --spacing-${i + 1}: ${s.value};`));
  }
  lines.push("}");
  return lines.join("\n");
}

// ── W3C Design Tokens tab ──────────────────────────────────────────────────────

export function renderDesignTokensJson(tokens: DesignTokens, density: Density): string {
  const colors = resolveColors(tokens, null, density);
  const colorGroup: Record<string, unknown> = {};
  colors.forEach((c) => {
    colorGroup[c.slug] = { $value: c.value, $type: "color" };
  });

  const fontGroup: Record<string, unknown> = {};
  const fams =
    density === "compact" ? tokens.typography.families.slice(0, 4) : tokens.typography.families;
  fams.forEach((f) => {
    fontGroup[slugify(f.family)] = { $value: f.family, $type: "fontFamily" };
  });

  const radiusGroup: Record<string, unknown> = {};
  (density === "compact" ? tokens.radii.slice(0, 6) : tokens.radii).forEach((r, i) => {
    radiusGroup[`radius-${i + 1}`] = { $value: r.value, $type: "dimension" };
  });

  const shadowGroup: Record<string, unknown> = {};
  (density === "compact" ? tokens.shadows.slice(0, 6) : tokens.shadows).forEach((s, i) => {
    shadowGroup[`shadow-${i + 1}`] = { $value: s.value, $type: "shadow" };
  });

  const spacingGroup: Record<string, unknown> = {};
  (density === "compact" ? tokens.spacing.slice(0, 8) : tokens.spacing).forEach((s, i) => {
    spacingGroup[`spacing-${i + 1}`] = { $value: s.value, $type: "dimension" };
  });

  return JSON.stringify(
    {
      color: colorGroup,
      fontFamily: fontGroup,
      radius: radiusGroup,
      shadow: shadowGroup,
      spacing: spacingGroup,
    },
    null,
    2,
  );
}

// ── DESIGN.md tab ──────────────────────────────────────────────────────────────

function fontRole(f: FontFamilyToken, enrichment: Enrichment | null): string {
  if (enrichment) {
    const e = enrichment.fonts.find((x) => x.family === f.family);
    if (e?.role) return e.role;
  }
  const map = { display: "Display / headings", body: "Body copy", ui: "UI / labels", mono: "Monospace / code" };
  return map[f.likelyRole];
}

export function renderDesignMd(
  tokens: DesignTokens,
  enrichment: Enrichment | null,
  density: Density,
): string {
  const md: string[] = [];
  const title = tokens.meta.title || tokens.meta.url || "Design Reference";
  md.push(`# ${title} — Design Reference`, "");
  const theme = enrichment?.theme || "A design system extracted directly from the rendered page.";
  md.push(`> ${theme}`, "");
  md.push(`*Source: ${tokens.meta.url}*  `);
  md.push(`*Extracted: ${tokens.meta.extractedAt}*`, "");

  // Colors
  const colors = resolveColors(tokens, enrichment, density);
  if (colors.length) {
    md.push("## Colors", "");
    md.push("| Name | Value | Token | Role |");
    md.push("| --- | --- | --- | --- |");
    for (const c of colors) {
      md.push(`| ${c.name} | \`${c.value}\` | \`${c.token}\` | ${c.role} |`);
    }
    md.push("");
  }

  // Typography
  const fams =
    density === "compact" ? tokens.typography.families.slice(0, 4) : tokens.typography.families;
  if (fams.length) {
    md.push("## Typography", "");
    for (const f of fams) {
      md.push(`### ${f.family}`, "");
      md.push(`- **Weights:** ${f.weights.join(", ") || "—"}`);
      md.push(`- **Sizes:** ${f.sizes.join(", ") || "—"}`);
      const step = tokens.typography.scale.find((s) => s.family === f.family);
      md.push(`- **Line height:** ${step?.lineHeight || "—"}`);
      md.push(`- **Letter spacing:** ${step?.letterSpacing || "0"}`);
      md.push(`- **Role:** ${fontRole(f, enrichment)}`);
      if (enrichment) {
        const e = enrichment.fonts.find((x) => x.family === f.family);
        if (e?.substitutes?.length) {
          md.push(`- **Open-source substitutes:** ${e.substitutes.join(", ")}`);
        }
      }
      md.push("");
    }
  }

  // Radii / shadows quick reference
  if (tokens.radii.length) {
    const r = (density === "compact" ? tokens.radii.slice(0, 6) : tokens.radii)
      .map((x) => `\`${x.value}\``)
      .join(" · ");
    md.push("## Radii", "", r, "");
  }
  if (tokens.shadows.length) {
    md.push("## Shadows", "");
    for (const s of density === "compact" ? tokens.shadows.slice(0, 6) : tokens.shadows) {
      md.push(`- \`${s.value}\` — blur ${s.blur}px, spread ${s.spread}px, opacity ${s.opacity}`);
    }
    md.push("");
  }

  // Guidelines
  md.push("## Guidelines", "");
  const dos = enrichment?.do?.length
    ? enrichment.do
    : defaultDos(tokens, colors);
  const donts = enrichment?.dont?.length
    ? enrichment.dont
    : defaultDonts(tokens, colors);
  md.push("**Do**", "");
  for (const d of dos) md.push(`- ${d}`);
  md.push("", "**Don't**", "");
  for (const d of donts) md.push(`- ${d}`);
  md.push("");

  return md.join("\n");
}

function defaultDos(tokens: DesignTokens, colors: ResolvedColor[]): string[] {
  const out: string[] = [];
  if (colors[0]) out.push(`Use ${colors[0].name} (\`${colors[0].value}\`) for primary surfaces — it is the most-used color on the page.`);
  if (tokens.typography.families[0]) {
    out.push(`Set body text in ${tokens.typography.families[0].family}.`);
  }
  if (tokens.radii[0]) out.push(`Reuse the established radius scale (e.g. ${tokens.radii[0].value}).`);
  out.push("Pull values from these tokens rather than hand-picking new ones.");
  return out;
}

function defaultDonts(_tokens: DesignTokens, colors: ResolvedColor[]): string[] {
  const out: string[] = [];
  const fillOnly = colors.find((c) => {
    const tok = c.role.toLowerCase();
    return tok.includes("icon") || tok.includes("fill");
  });
  if (fillOnly) out.push(`Don't use ${fillOnly.name} for interactive UI — it appears only as decorative fill.`);
  out.push("Don't introduce off-scale colors, type sizes, or radii not present above.");
  out.push("Don't rename or restyle tokens whose values were measured from the page.");
  return out;
}
