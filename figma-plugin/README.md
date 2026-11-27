# StyleLift for Figma

The Figma plugin that builds a page StyleLift exported (**This page → Figma (.zip)**) as Figma layers:

- frames placed where the page had them;
- text you can edit, with its runs (font, weight, size, line height, tracking, colour, case, decoration, links);
- pictures (fill, fit, tile or exact crop);
- vector icons and logos;
- strokes, corner radii, shadows and blurs;
- Auto Layout wherever the page's own flex layout reproduces the measured positions;
- the page's colours as variables and its type as text styles.

## Build

```sh
node scripts/build-figma-plugin.mjs   # → figma-plugin/dist (code.js + ui.html) and public/figma-plugin
npx tsc -p figma-plugin               # type-check against Figma's plugin API
```

`npm run build` and `npm run build:test` run the first step too. Every Figma bundle the extension exports carries
the built plugin under `figma-plugin/`, so the zip is all a first-time user needs.

## Use it in Figma (until it's published)

1. In the Figma desktop app: **Plugins → Development → Import plugin from manifest…** and pick
   `figma-plugin/manifest.json`, either from this folder or from inside an exported zip.
2. In any design file: **Plugins → Development → StyleLift**, and choose the `.figma.zip`.

Fonts: Figma uses the fonts installed on the computer. Install the page's fonts first (README.txt in the bundle lists
them), or Figma shows Inter in their place and the plugin says which ones it replaced.

## Publishing

Publishing to the Figma Community is done from the owner's Figma account. Figma then assigns the real plugin `id`,
which replaces `stylelift-import` in `manifest.json`.

## How accuracy is checked

`node scripts/verify-figma.mjs [url …]` runs this plugin's own code against a stand-in for Figma's API
(`scripts/figma-emulator.js`). The stand-in draws the layers the way Figma does and fails the way Figma fails. The
test then compares the drawing with the page, pixel by pixel.

## Files

- `src/code.ts`: the builder (Figma's sandbox).
- `src/geometry.ts`: CSS ↔ Figma arithmetic (gradients, rotation, font styles, blend modes).
- `src/ui.ts` and `src/ui.html`: the plugin window.
- `src/unzip.ts`: reads the bundle.
