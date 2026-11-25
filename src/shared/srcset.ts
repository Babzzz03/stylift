// Captures keep the chosen image as a ONE-candidate srcset (`url 400w` + sizes, or
// `url 2x`) so its intrinsic size — and every layout sized from it (fit-content, auto
// widths) — stays what the live page had, even though the file is the sharpest one.
// Exports that move the file elsewhere must move that candidate with it.

/**
 * `oldSrc` was the image's src before the export moved it to `newSrc`. A srcset whose
 * only candidate IS that file moves along (same descriptor); any other srcset would
 * still point at the old files (or at a different file than src), so it is dropped.
 */
export function retargetSrcset(img: Element, oldSrc: string, newSrc: string): void {
  const set = (img.getAttribute("srcset") || "").trim();
  if (!set) return;
  const m = /^(\S+)\s+(\d+(?:\.\d+)?[wx])$/.exec(set);
  if (m && m[1] === oldSrc) img.setAttribute("srcset", `${newSrc} ${m[2]}`);
  else img.removeAttribute("srcset");
}
