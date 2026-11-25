// Studio alignment geometry: snapping (smart guides), layout-grid columns, ⌥-measure distances, translate.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const od = mkdtempSync(join(tmpdir(), "sl-align-"));
await build({ entryPoints: { a: "src/studio/align.ts" }, outdir: od, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
const { snapBox, gridColumns, gridLines, measureBetween, parseTranslate, formatTranslate, DEFAULT_GRIDS } = await import(pathToFileURL(join(od, "a.js")));
let passed = 0; const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };
const B = (left, top, width, height) => ({ left, top, width, height });

const card = B(100, 100, 200, 100);
let s = snapBox(B(303, 260, 50, 50), [card]);
ok(s.dx === -3 && s.dy === 0, `a box 3 px off a card's right edge snaps onto it (dx ${s.dx})`);
ok(s.guides.some((g) => g.axis === "x" && g.at === 300 && g.from === 100 && g.to === 310), "…and a vertical guide runs along that edge, spanning both boxes");
s = snapBox(B(172, 300, 60, 40), [card]);
ok(s.dx === -2 && s.guides.some((g) => g.axis === "x" && g.at === 200), "centres snap to centres (a guide through both middles)");
s = snapBox(B(400, 205, 50, 50), [card], {}, 6);
ok(s.dy === -5 && s.guides.some((g) => g.axis === "y" && g.at === 200), "a top edge 5 px below a bottom edge snaps up to it");
s = snapBox(B(400, 400, 50, 50), [card]);
ok(s.dx === 0 && s.dy === 0 && s.guides.length === 0, "nothing near: no snap, no guides");
s = snapBox(B(84, 400, 50, 50), [], { x: [80, 158] });
ok(s.dx === -4 && s.guides.some((g) => g.at === 80 && g.from < -1000), "snaps to a layout-grid column edge (a full-height guide)");
s = snapBox(B(303, 103, 50, 50), [card, B(500, 100, 40, 40)]);
ok(s.dx === -3 && s.dy === -3 && s.guides.filter((g) => g.axis === "y" && g.at === 100).length === 2 && s.guides.some((g) => g.axis === "y" && g.at === 150), "snaps on both axes at once; every box that lines up gets a guide (tops of both, the card's middle)");

const cols = gridColumns(1440, DEFAULT_GRIDS.base);
ok(cols.length === 12 && cols[0].start === 80 && Math.abs(cols[11].end - 1360) < 0.01 && Math.abs((cols[1].start - cols[0].end) - 24) < 0.01, "a 12-column grid with 80 px margins and 24 px gutters across 1440 px");
ok(gridLines(390, DEFAULT_GRIDS.phone).length === 8 && gridColumns(100, { columns: 12, gutter: 24, margin: 80 }).length === 0, "4 phone columns give 8 snap lines; a grid that doesn't fit draws nothing");

let m = measureBetween(B(0, 0, 100, 50), B(140, 10, 100, 50));
ok(m.length === 1 && m[0].axis === "x" && m[0].value === 40 && m[0].at === 30, "⌥-measure: the gap between two boxes side by side (40 px, through their overlap)");
m = measureBetween(B(0, 0, 100, 50), B(20, 90, 60, 30));
ok(m.length === 1 && m[0].axis === "y" && m[0].value === 40, "⌥-measure: the gap to a box below (40 px)");
m = measureBetween(B(30, 20, 40, 40), B(0, 0, 100, 100));
ok(m.length === 4 && m.map((x) => x.value).join(",") === "30,30,20,40", "⌥-measure inside a container: the distance to each of its sides");

ok(JSON.stringify(parseTranslate("12px -4px")) === '{"x":12,"y":-4}' && JSON.stringify(parseTranslate("none")) === '{"x":0,"y":0}' && parseTranslate("8px").y === 0, "reads a CSS translate");
ok(formatTranslate(12.4, -3.6) === "12px -4px" && formatTranslate(0.2, -0.3) === "", "writes whole pixels; a move back to the start clears it");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("Studio alignment verified ✓");
