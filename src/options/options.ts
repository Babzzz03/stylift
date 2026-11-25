import { DEFAULT_MODEL, type Settings } from "../shared/types";
import { loadWp, saveWp, wpConfigured, wpStatus } from "../shared/wordpress";
import { loadPublishSettings, savePublishSettings, whoAmI } from "../shared/publish";

const keyInput = document.getElementById("key") as HTMLInputElement;
const modelSelect = document.getElementById("model") as HTMLSelectElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;

function setStatus(msg: string, kind: "ok" | "error" | "" = ""): void {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

async function load(): Promise<void> {
  const s = (await chrome.storage.local.get([
    "deepseekApiKey",
    "deepseekModel",
  ])) as Partial<Settings>;
  keyInput.value = s.deepseekApiKey || "";
  modelSelect.value = s.deepseekModel || DEFAULT_MODEL;
}

saveBtn.addEventListener("click", async () => {
  const settings: Settings = {
    deepseekApiKey: keyInput.value.trim(),
    deepseekModel: modelSelect.value || DEFAULT_MODEL,
  };
  await chrome.storage.local.set(settings);
  setStatus(
    settings.deepseekApiKey ? "Saved. Polish is now enabled in the panel." : "Saved.",
    "ok",
  );
});

clearBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove("deepseekApiKey");
  keyInput.value = "";
  setStatus("API key cleared. Extraction still works without it.", "ok");
});

load();

// ── WordPress connection ──────────────────────────────────────────────────────
const wpSite = document.getElementById("wp-site") as HTMLInputElement;
const wpUser = document.getElementById("wp-user") as HTMLInputElement;
const wpPass = document.getElementById("wp-pass") as HTMLInputElement;
const wpStatusEl = document.getElementById("wp-status") as HTMLDivElement;
const wpSaveBtn = document.getElementById("wp-save") as HTMLButtonElement;
const wpClearBtn = document.getElementById("wp-clear") as HTMLButtonElement;
function setWpStatus(msg: string, kind: "ok" | "error" | "" = ""): void {
  wpStatusEl.textContent = msg;
  wpStatusEl.className = "status" + (kind ? " " + kind : "");
}
async function loadWpFields(): Promise<void> {
  const s = await loadWp();
  wpSite.value = s.wpSite;
  wpUser.value = s.wpUser;
  wpPass.value = s.wpAppPassword;
}
wpSaveBtn.addEventListener("click", async () => {
  await saveWp({ wpSite: wpSite.value, wpUser: wpUser.value, wpAppPassword: wpPass.value });
  const s = await loadWp();
  wpSite.value = s.wpSite;
  if (!wpConfigured(s)) return setWpStatus("Fill in the site address, username and application password.", "error");
  setWpStatus("Testing the connection…");
  wpSaveBtn.disabled = true;
  try {
    const st = await wpStatus(s);
    const notes = [
      st.elementor_active ? `Elementor ${st.elementor_version || ""} is active.` : "Elementor isn't active yet: imports are stored and open in Elementor once it is activated.",
      st.can_import_html ? "" : "This account can't save raw HTML: use an Administrator or Editor account.",
    ].filter(Boolean).join(" ");
    setWpStatus(`Connected to “${st.site}” as ${st.user}. ${notes}`, st.can_import_html ? "ok" : "error");
  } catch (e) {
    setWpStatus(e instanceof Error ? e.message : String(e), "error");
  } finally {
    wpSaveBtn.disabled = false;
  }
});
wpClearBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove(["wpSite", "wpUser", "wpAppPassword"]);
  await loadWpFields();
  setWpStatus("Disconnected. The password was removed from this browser.", "ok");
});
loadWpFields();

// ── Publishing (Netlify / Vercel / GitHub) ─────────────────────────────────────
const pub = (id: string) => document.getElementById(id) as HTMLInputElement;
const PROVIDERS = {
  netlify: { label: "Netlify", fields: { netlifyToken: "netlify-token" } },
  vercel: { label: "Vercel", fields: { vercelToken: "vercel-token", vercelTeamId: "vercel-team" } },
  github: { label: "GitHub", fields: { githubToken: "github-token" } },
} as const;
type Provider = keyof typeof PROVIDERS;
function setPubStatus(p: Provider, msg: string, kind: "ok" | "error" | "" = ""): void {
  const el = document.getElementById(`${p}-status`) as HTMLDivElement;
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}
async function loadPublishFields(): Promise<void> {
  const s = await loadPublishSettings();
  pub("netlify-token").value = s.netlifyToken;
  pub("vercel-token").value = s.vercelToken;
  pub("vercel-team").value = s.vercelTeamId;
  pub("github-token").value = s.githubToken;
  pub("github-private").checked = s.githubPrivate;
}
for (const p of Object.keys(PROVIDERS) as Provider[]) {
  const { label, fields } = PROVIDERS[p];
  const save = document.getElementById(`${p}-save`) as HTMLButtonElement;
  save.addEventListener("click", async () => {
    const values: Record<string, string | boolean> = {};
    for (const [key, id] of Object.entries(fields)) values[key] = pub(id).value;
    if (p === "github") values.githubPrivate = pub("github-private").checked;
    await savePublishSettings(values);
    const s = await loadPublishSettings();
    const token = p === "netlify" ? s.netlifyToken : p === "vercel" ? s.vercelToken : s.githubToken;
    if (!token) return setPubStatus(p, `Paste a ${label} token first.`, "error");
    setPubStatus(p, "Testing the token…");
    save.disabled = true;
    try {
      const who = await whoAmI(p, s);
      setPubStatus(p, `Connected to ${label} as ${who}. Publish from the panel's “Your export” card.`, "ok");
    } catch (e) {
      setPubStatus(p, e instanceof Error ? e.message : String(e), "error");
    } finally {
      save.disabled = false;
    }
  });
  (document.getElementById(`${p}-clear`) as HTMLButtonElement).addEventListener("click", async () => {
    await chrome.storage.local.remove(Object.keys(fields));
    await loadPublishFields();
    setPubStatus(p, `${label} disconnected. The token was removed from this browser.`, "ok");
  });
}
pub("github-private").addEventListener("change", () => void savePublishSettings({ githubPrivate: pub("github-private").checked }));
loadPublishFields();
