// Verifies the HTML → JSX (React) export converter.
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outdir = mkdtempSync(join(tmpdir(), "jsx-"));
await build({ entryPoints: { jsx: "src/panel/jsx.ts" }, outdir, bundle: true, format: "esm", platform: "neutral", logLevel: "silent" });
const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Node = dom.window.Node;
const { htmlToJsx } = await import(pathToFileURL(join(outdir, "jsx.js")));

let passed = 0;
const failures = [];
const ok = (c, l) => { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failures.push(l); console.log(`  ✗ ${l}`); } };

const html = `<section class="hero" style="color:#fff;background-color:#000">
  <h1 class="t">Hello</h1>
  <img src="/a.png" alt="x" srcset="/a.png 2x">
  <a href="/go" onclick="x()">Click</a>
  <input type="text" readonly>
  <br>
  <script>bad()</script>
</section>`;
const jsx = htmlToJsx(html, "Page");

ok(jsx.includes("export default function Page()"), "emits a React component");
ok(jsx.includes('className="hero"'), "class → className");
ok(/style=\{\{[^}]*color: "#fff"/.test(jsx), "inline style → object");
ok(jsx.includes("backgroundColor"), "style props camelCased");
ok(jsx.includes("srcSet="), "srcset → srcSet");
ok(jsx.includes("readOnly"), "readonly → readOnly");
ok(jsx.includes("<img") && jsx.includes("/>"), "void tags self-closed");
ok(!/onclick|onClick/.test(jsx), "inline handlers dropped");
ok(!/bad\(\)/.test(jsx), "scripts stripped");

// real-world cases that broke the first converter on live sites
const nasty = htmlToJsx(`<div data-json='{"a":"b\\c"}' title="say &quot;hi&quot;" @click="x" :class="y" _ngcontent-ng-c1="" xmlns:xlink="http://www.w3.org/1999/xlink">
  <svg viewBox="0 0 10 10"><defs><clipPath id="c"><rect/></clipPath><linearGradient id="g"/></defs><use xlink:href="#c" stroke-width="2" fill-rule="evenodd"/></svg>
  <b>Hello</b> <i>world</i> & {braces} <span>a</span><span>b</span>
  <pre>  keep
    spacing</pre>
  <input value="typed" type="text"><input type="checkbox" checked><input type="hidden" value="h">
  <textarea>multi
line</textarea>
  <select><option>a</option><option selected>b</option></select>
  <p style="background:url(data:image/png;base64,AA==) no-repeat; -webkit-line-clamp:2; -ms-flex:1; --brand: red; color: blue !important">x</p>
  <iframe srcdoc="<p>hi</p>" allowfullscreen></iframe>
  <div hidden contenteditable="false" autocapitalize="off" clippath="url(#x)"></div>
  <my-el><template shadowrootmode="open"><b>s</b></template>light</my-el>
</div>`, "Nasty");
ok(/data-json=\{"\{\\"a\\":\\"b\\\\c\\"\}"\}/.test(nasty), "attribute values with quotes/backslashes become {\"…\"} expressions");
ok(!/@click|:class/.test(nasty) && /_ngcontent-ng-c1=""/.test(nasty), "invalid JSX attribute names dropped, framework attrs kept verbatim");
ok(/xmlnsXlink=/.test(nasty) && /xlinkHref="#c"/.test(nasty), "xlink/xmlns attributes mapped");
ok(/<clipPath id="c">/.test(nasty) && /<linearGradient id="g"/.test(nasty), "SVG tag case preserved (clipPath, linearGradient)");
ok(/strokeWidth="2"/.test(nasty) && /fillRule="evenodd"/.test(nasty) && /viewBox="0 0 10 10"/.test(nasty), "SVG attributes camelCased");
ok(/<\/b>\n\s*\{" "\}\n\s*<i>/.test(nasty), "space between inline elements preserved");
ok(/\{"& \{braces\}"\}/.test(nasty), "& and braces in text emitted safely");
ok(/\{"  keep\\n    spacing"\}/.test(nasty), "<pre> whitespace kept verbatim");
ok(/<input defaultValue="typed" type="text" \/>/.test(nasty) && /<input type="checkbox" defaultChecked \/>/.test(nasty) && /<input type="hidden" value="h" \/>/.test(nasty), "inputs → defaultValue/defaultChecked (hidden keeps value)");
ok(/<textarea defaultValue=\{"multi\\nline"\} \/>/.test(nasty), "textarea → defaultValue");
ok(/<select defaultValue="b">/.test(nasty) && !/<option selected/.test(nasty), "select → defaultValue, option selected dropped");
ok(/background: "url\(data:image\/png;base64,AA==\) no-repeat"/.test(nasty), "style parser keeps ';' inside url(data:…)");
ok(/WebkitLineClamp: "2"/.test(nasty) && /msFlex: "1"/.test(nasty) && /"--brand": "red"/.test(nasty), "vendor prefixes + custom properties mapped");
ok(/data-sl-important="s\d+"/.test(nasty) && /color: blue !important/.test(nasty), "!important moved to a CSS rule");
ok(/srcDoc="<p>hi<\/p>"/.test(nasty) && /allowFullScreen/.test(nasty), "srcdoc/allowfullscreen mapped");
ok(/<div hidden contentEditable="false" autoCapitalize="off" \/>/.test(nasty), "booleans bare, camelCase props, bogus clippath attr dropped");
ok(/ref=\{shadow\("<b>s<\/b>", "open"\)\}/.test(nasty) && /import \{ shadow \}/.test(nasty), "declarative shadow root → runtime ref");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
console.log("React (JSX) export verified ✓");
