// Readable code in the React / Next.js exports: the generated components, pages and helpers are laid out by
// Prettier (MIT, its JavaScript / JSX parser is Babel's) — long tags broken one attribute per line, consistent
// indentation and quotes. Loaded only when such an export is made (a separate chunk, ~0.6 MB); a file that is
// too big or doesn't parse is kept exactly as generated, and the whole pass is bounded in time.
type Files = Record<string, string | Uint8Array>;
export async function prettifyCode(files: Files, budgetMs = 20000): Promise<number> {
  const targets = Object.keys(files).filter((k) => /\.(jsx?|tsx?|mjs)$/.test(k) && !/^public\//.test(k) && typeof files[k] === "string" && (files[k] as string).length <= 400_000);
  if (!targets.length) return 0;
  let prettier: typeof import("prettier/standalone"), plugins: unknown[];
  try {
    const [p, babel, estree] = await Promise.all([import("prettier/standalone"), import("prettier/plugins/babel"), import("prettier/plugins/estree")]);
    prettier = p;
    plugins = [babel, estree];
  } catch {
    return 0; // the formatter didn't load: the files stay as generated
  }
  const t0 = Date.now();
  let n = 0;
  for (const k of targets) {
    if (Date.now() - t0 > budgetMs) break;
    try {
      files[k] = await prettier.format(files[k] as string, { parser: /\.tsx?$/.test(k) ? "babel-ts" : "babel", plugins: plugins as never, printWidth: 100 });
      n++;
    } catch {
      /* kept as generated */
    }
  }
  return n;
}
