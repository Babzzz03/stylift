// Real-browser proof of the in-page VISUAL editor: launches headless Chrome,
// navigates to a real URL (or a local page), injects the editor, and drives its
// programmatic API to edit text, restyle, duplicate, move and delete — verifying
// the live DOM actually changes and the edit model is recorded.
//
// Usage: node scripts/verify-live-editor.mjs [url]
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const arg = process.argv[2];

const outdir = mkdtempSync(join(tmpdir(), "sl-veditor-"));
await build({
  entryPoints: { ve: "src/extractor/visual-editor.ts" },
  outdir,
  bundle: true,
  format: "iife",
  globalName: "__SL__",
  platform: "browser",
  logLevel: "silent",
});
const bundle = readFileSync(join(outdir, "ve.js"), "utf8");

let url = arg;
if (!url) {
  const page = join(outdir, "page.html");
  writeFileSync(
    page,
    `<!doctype html><html><head><meta charset=utf-8><style>
      body{font-family:system-ui;margin:40px;background:#0b0e14;color:#ddd}
      h1{color:#8a93a6;font-size:28px}
      ul{list-style:none;padding:0} li{padding:8px;border:1px solid #222}
    </style></head><body>
      <h1 id="title">Original Heading</h1>
      <p class="lede">Some intro copy.</p>
      <img id="pic" src="https://example.com/old.png" alt="old" />
      <a id="cta" href="https://old.example.com">Click</a>
      <ul id="list"><li class="a">Alpha</li><li class="b">Beta</li><li class="c">Gamma</li></ul>
    </body></html>`,
  );
  url = "file://" + page;
}

const port = 9366;
const userDir = mkdtempSync(join(tmpdir(), "sve-chrome-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
]);
chrome.on("error", (e) => { console.error("Chrome launch failed:", e); process.exit(1); });

const http = async (p, m = "GET") => (await fetch(`http://127.0.0.1:${port}${p}`, { method: m })).json();
let version;
for (let i = 0; i < 50; i++) {
  try { version = await http("/json/version"); if (version) break; } catch { await sleep(200); }
}
if (!version) { console.error("DevTools never came up"); chrome.kill(); process.exit(1); }
console.log("Launched:", version.Browser, "\n  target:", url, "\n");

let WS;
try { ({ WebSocket: WS } = await import("ws")); } catch { WS = globalThis.WebSocket; }
const target = await http(`/json/new?${encodeURIComponent(url)}`, "PUT");
const ws = new WS(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m.result); }
});
await new Promise((r) => ws.addEventListener("open", () => r()));
const send = (method, params = {}) => new Promise((resolve) => { const mid = ++id; pending.set(mid, { resolve }); ws.send(JSON.stringify({ id: mid, method, params })); });
await send("Page.enable");
await send("Runtime.enable");
const loaded = new Promise((r) => send("Page.navigate", { url }).then(() => {}));
void loaded;
await sleep(arg ? 3500 : 800);

const evalJS = async (expression) => {
  const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || "eval error");
  return result.value;
};

let failures = 0;
const ok = (c, l) => { console.log(`  ${c ? "✓" : "✗"} ${l}`); if (!c) failures++; };

// inject + activate the editor
await evalJS(bundle);
await evalJS("__SL__.injectVisualEditor()");
ok(await evalJS("!!document.getElementById('__sl_editor_host')"), "editor overlay injected (shadow host present)");
ok(await evalJS("!!window.__slEditor"), "programmatic API exposed");
// re-injecting must NOT stack a second toolbar
await evalJS("__SL__.injectVisualEditor()");
await evalJS("__SL__.injectVisualEditor()");
ok((await evalJS("document.querySelectorAll('#__sl_editor_host').length")) === 1, "re-injecting keeps a single toolbar (no duplicates)");

if (!arg) {
  // local page: select by selector and verify the exact element
  await evalJS(`window.__slEditor.selectBySelector('#title')`);
  await evalJS(`window.__slEditor.setText('StyleLift was here ✨')`);
  const afterText = await evalJS(`document.querySelector('#title').textContent`);
  console.log(`  text → ${JSON.stringify(afterText)}`);
  ok(afterText === "StyleLift was here ✨", "inline text edit changed the element's words");
  ok(await evalJS(`Object.values(window.__slEditor.state().overrides).some(e=>typeof e.html==='string')`), "text edit recorded as an html override");
  await evalJS(`window.__slEditor.quickStyle('color','rgb(255,0,0)')`);
  ok((await evalJS(`getComputedStyle(document.querySelector('#title')).color`)) === "rgb(255, 0, 0)", "quick style recolored the element live");
} else {
  // real site: find a visible text element (piercing shadow DOM) and drive a REAL
  // mouse click on it — the editor resolves the deep target via composedPath().
  const spot = await evalJS(`(() => {
    function* deep(root){ for (const el of root.querySelectorAll('*')){ yield el; if (el.shadowRoot) yield* deep(el.shadowRoot); } }
    for (const el of deep(document)) {
      const t = (el.textContent||'').trim();
      if (t.length < 2 || el.children.length > 3) continue;
      if (!/^(H1|H2|H3|H4|P|A|BUTTON|SPAN|LI)$/.test(el.tagName)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 24 && r.height > 10 && r.top > 50 && r.top < innerHeight - 20) {
        return { x: Math.round(r.left + Math.min(r.width/2, 30)), y: Math.round(r.top + r.height/2), tag: el.tagName, text: t.slice(0,40) };
      }
    }
    return null;
  })()`);
  if (spot) console.log("  clicking", spot.tag, JSON.stringify(spot.text));
  if (spot) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: spot.x, y: spot.y, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: spot.x, y: spot.y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(120);
  }
  ok(await evalJS(`window.__slEditor.hasSelection()`), "a real click selected an element (works through shadow DOM)");
  console.log("  selected:", await evalJS(`window.__slEditor.selectedLabel()`));
  await evalJS(`window.__slEditor.quickStyle('outline','3px solid rgb(255,0,0)')`);
  ok(await evalJS(`window.__slEditor.state() && Object.keys(window.__slEditor.state().overrides).length > 0`), "edit recorded for the selected element");
  await evalJS(`window.__slEditor.setText('StyleLift edit ✨')`);
  ok(await evalJS(`Object.values(window.__slEditor.state().overrides).some(e=>typeof e.html==='string')`), "inline text edit recorded on the real site");
}

// structural ops on a list (local page) — skip the strict count check on arbitrary sites
if (!arg) {
  await evalJS(`window.__slEditor.selectBySelector('#list .b')`);
  await evalJS(`window.__slEditor.duplicate()`);
  ok((await evalJS(`document.querySelectorAll('#list .b').length`)) === 2, "duplicate added a clone");
  await evalJS(`window.__slEditor.selectBySelector('#list .a')`);
  await evalJS(`window.__slEditor.move('down')`);
  ok((await evalJS(`document.querySelector('#list li').className`)) !== "a", "move reordered siblings");
  await evalJS(`window.__slEditor.selectBySelector('#list .c')`);
  await evalJS(`window.__slEditor.remove()`);
  ok((await evalJS(`!document.querySelector('#list .c')`)), "delete removed the element");
  ok((await evalJS(`window.__slEditor.state().structOps.length`)) === 3, "3 structural ops recorded");

  // context-sensitive: replace image src + alt
  await evalJS(`window.__slEditor.selectBySelector('#pic')`);
  await evalJS(`window.__slEditor.applyAttr('src','https://example.com/NEW.png')`);
  await evalJS(`window.__slEditor.applyAttr('alt','new alt')`);
  ok((await evalJS(`document.querySelector('#pic').getAttribute('src')`)) === "https://example.com/NEW.png", "image src replaced");
  ok((await evalJS(`document.querySelector('#pic').getAttribute('alt')`)) === "new alt", "image alt updated");

  // context-sensitive: link href + target
  await evalJS(`window.__slEditor.selectBySelector('#cta')`);
  await evalJS(`window.__slEditor.applyAttr('href','https://new.example.com')`);
  await evalJS(`window.__slEditor.applyAttr('target','_blank')`);
  ok((await evalJS(`document.querySelector('#cta').getAttribute('href')`)) === "https://new.example.com", "link href changed");
  ok((await evalJS(`document.querySelector('#cta').getAttribute('target')`)) === "_blank", "link target set");
  ok((await evalJS(`Object.values(window.__slEditor.state().overrides).some(e=>e.attrs && e.attrs.src)`)), "attribute edit recorded in overrides");

  // hover-state styling
  await evalJS(`window.__slEditor.selectBySelector('#title')`);
  await evalJS(`window.__slEditor.applyProp('#title','color','rgb(255,0,0)','hover')`);
  ok((await evalJS(`!!(window.__slEditor.state().overrides['#title'].states && window.__slEditor.state().overrides['#title'].states.hover)`)), "hover state recorded");
  ok((await evalJS(`document.getElementById('__sl_editor_css').textContent.includes(':hover')`)), "hover CSS rule generated");

  // responsive
  await evalJS(`window.__slEditor.applyProp('#title','font-size','20px','mobile')`);
  ok((await evalJS(`document.getElementById('__sl_editor_css').textContent.includes('@media')`)), "responsive @media rule generated");

  // insert widget + undo/redo
  await evalJS(`window.__slEditor.selectBySelector('#title')`);
  const beforeCount = await evalJS(`document.querySelectorAll('h2').length`);
  await evalJS(`window.__slEditor.insertWidget('heading')`);
  ok((await evalJS(`document.querySelectorAll('h2').length`)) === beforeCount + 1, "insert widget added a heading");
  await evalJS(`window.__slEditor.undo()`);
  ok((await evalJS(`document.querySelectorAll('h2').length`)) === beforeCount, "undo removed the inserted heading");
  await evalJS(`window.__slEditor.redo()`);
  ok((await evalJS(`document.querySelectorAll('h2').length`)) === beforeCount + 1, "redo re-added the heading");

  // undo a style change
  await evalJS(`window.__slEditor.selectBySelector('.lede')`);
  await evalJS(`window.__slEditor.applyProp('.lede','color','rgb(0,0,255)','base')`);
  ok((await evalJS(`getComputedStyle(document.querySelector('.lede')).color`)) === "rgb(0, 0, 255)", "style applied");
  await evalJS(`window.__slEditor.undo()`);
  ok((await evalJS(`getComputedStyle(document.querySelector('.lede')).color`)) !== "rgb(0, 0, 255)", "undo reverted the style change");

  // drag-to-reorder (moveBefore)
  await evalJS(`window.__slEditor.selectBySelector('#list .b')`);
  await evalJS(`window.__slEditor.moveBefore('#list .a')`);
  ok((await evalJS(`document.querySelector('#list li').className`)) === "b", "moveBefore reordered (b is now first)");

  // ── Layers navigator: walk body → find #list → select a child by ref ──
  const found = await evalJS(`(() => {
    function find(ref, depth) {
      const kids = window.__slEditor.getChildren(ref);
      for (const k of kids) {
        if (k.label.includes('list')) return k.ref;
        if (k.hasChildren && depth < 6) { const r = find(k.ref, depth + 1); if (r) return r; }
      }
      return null;
    }
    const listRef = find(undefined, 0);
    if (!listRef) return { ok:false };
    const items = window.__slEditor.getChildren(listRef);
    if (!items.length) return { ok:false };
    const target = items[items.length - 1];        // last <li>
    const selected = window.__slEditor.selectByRef(target.ref);
    return { ok:true, selected, label: window.__slEditor.selectedLabel(), count: items.length };
  })()`);
  ok(found.ok, "Layers tree lists body → … → #list children");
  ok(found.selected && /li/.test(found.label), "selecting a layer by ref selects that element");

  // right-click context menu
  const ctx = await evalJS(`(() => {
    const t = document.querySelector('#title');
    t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    const menu = document.getElementById('__sl_editor_host').shadowRoot.querySelector('.ctxmenu');
    return { shown: menu && menu.style.display === 'block', items: menu ? menu.querySelectorAll('button').length : 0 };
  })()`);
  ok(ctx.shown, "right-click opens the context menu");
  ok(ctx.items >= 6, "context menu has the expected actions");
}

// stop cleans up
await evalJS("__SL__.stopVisualEditor()");
ok(!(await evalJS("!!document.getElementById('__sl_editor_host')")), "Done removes the editor overlay");

chrome.kill();
console.log(failures ? `\n${failures} failure(s).` : "\nVisual editor works in a real browser ✓");
process.exit(failures ? 1 : 0);
