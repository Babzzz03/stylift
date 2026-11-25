// Studio projects, stored in the extension's IndexedDB (pages are often 1–5 MB, far
// beyond chrome.storage quotas). Shared by the side panel (creates a project from a
// capture) and the studio (loads, autosaves, lists).
//
// A project is one page (html + edits on the project itself) or a whole site: then `pageList` names its
// pages and each page's html + edits live in their own record ("pages" store), so an autosave writes only
// the page being edited, not every page of the site.
import type { StyleEdits } from "../studio/model";

export interface StudioPageRef {
  url: string;
  path: string; // index.html | about/index.html … (the site export's file for this page)
  title: string;
}
export interface StudioProject {
  id: string;
  url: string;
  title: string;
  html: string; // canonical document (with data-sl-id on every body element); "" for a site project
  edits: StyleEdits;
  createdAt: number;
  updatedAt: number;
  thumb?: string; // small data: URL, optional
  /** a whole-site project: its pages, in crawl order (html + edits per page via getPage / savePage) */
  pageList?: StudioPageRef[];
  /** the page open in a site project */
  page?: number;
  /** artboard sizes the user chose (width, and the screen height 100vh is measured against) per breakpoint */
  frames?: Partial<Record<"base" | "tablet" | "phone", { w: number; h: number }>>;
  /** layers locked on the canvas (editor-only: they can't be selected or dragged there) */
  locked?: string[];
  /** layout grid per breakpoint (columns, gutter, side margin) */
  grids?: Partial<Record<"base" | "tablet" | "phone", { columns: number; gutter: number; margin: number }>>;
}
export interface StudioPageData {
  html: string;
  edits: StyleEdits;
}

const DB = "stylelift-studio";
const STORE = "projects";
const PAGES = "pages";
/** a project's live 3D scenes: the site's own files that keep them running in the exports (see panel/islands.ts) */
const SCENES = "scenes";
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 3);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
      if (!req.result.objectStoreNames.contains(PAGES)) req.result.createObjectStore(PAGES, { keyPath: "key" });
      if (!req.result.objectStoreNames.contains(SCENES)) req.result.createObjectStore(SCENES, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = run(t.objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const pageKey = (id: string, i: number) => `${id}:${i}`;
const pagesOf = (id: string) => IDBKeyRange.bound(`${id}:`, `${id}:￿`);

export const saveProject = (p: StudioProject) => tx(STORE, "readwrite", (s) => s.put({ ...p, updatedAt: Date.now() })).then(() => undefined);
export const getProject = (id: string) => tx<StudioProject | undefined>(STORE, "readonly", (s) => s.get(id));
export async function deleteProject(id: string): Promise<void> {
  await tx(STORE, "readwrite", (s) => s.delete(id));
  await tx(PAGES, "readwrite", (s) => s.delete(pagesOf(id)));
  await tx(SCENES, "readwrite", (s) => s.delete(id));
}
export type SceneFiles = Record<string, Uint8Array | string>;
/** Keep a project's live 3D scene files (the site's own files, at the paths an export serves them from). */
export const saveScenes = (id: string, files: SceneFiles) => tx(SCENES, "readwrite", (s) => s.put({ id, files })).then(() => undefined);
export async function getScenes(id: string): Promise<SceneFiles | undefined> {
  const r = await tx<{ id: string; files: SceneFiles } | undefined>(SCENES, "readonly", (s) => s.get(id));
  return r?.files;
}
export async function listProjects(): Promise<Omit<StudioProject, "html">[]> {
  const all = await tx<StudioProject[]>(STORE, "readonly", (s) => s.getAll());
  return all.map(({ html: _html, ...rest }) => rest).sort((a, b) => b.updatedAt - a.updatedAt);
}
export const savePage = (projectId: string, index: number, d: StudioPageData) =>
  tx(PAGES, "readwrite", (s) => s.put({ key: pageKey(projectId, index), projectId, index, html: d.html, edits: d.edits })).then(() => undefined);
export async function getPage(projectId: string, index: number): Promise<StudioPageData | undefined> {
  const r = await tx<(StudioPageData & { key: string }) | undefined>(PAGES, "readonly", (s) => s.get(pageKey(projectId, index)));
  return r ? { html: r.html, edits: r.edits || {} } : undefined;
}
/** A new whole-site project: one record for the project, one per page. */
export async function createSiteProject(p: Omit<StudioProject, "html" | "edits" | "pageList" | "page">, pages: (StudioPageRef & { html: string })[]): Promise<void> {
  for (let i = 0; i < pages.length; i++) await savePage(p.id, i, { html: pages[i].html, edits: {} });
  await saveProject({ ...p, html: "", edits: {}, page: 0, pageList: pages.map(({ url, path, title }) => ({ url, path, title })) });
}
export const newProjectId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
