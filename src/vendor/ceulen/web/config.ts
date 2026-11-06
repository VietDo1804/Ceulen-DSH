// ponytail: DSH shim for the vendored web libs (manifest mode: patched).
// Upstream config.ts delegates findEnvValue to lib/settings.ts, which reads
// ~/.pi/agent + a trusted project's .pi/settings.json. DSH has neither: the
// chain here is process.env → the DSH credential store → the `web` section of
// ~/.dsh/ceulen/settings.json. cwd/includeCwd stay in the signature because
// every upstream call site passes them; they are intentionally ignored.
import { credential } from "../../../core/credentials.js";
import { loadSettingsSync } from "../../../core/settings.js";

/** Env var → settings.json key inside the `web` section (path after "web."). */
export const ENV_TO_SETTINGS_KEY: Record<string, string> = {
  SEARXNG_BASE_URL: "searxng.baseUrl",
  BRAVE_API_KEY: "brave.apiKey",
  FIRECRAWL_API_URL: "firecrawl.baseUrl",
  FIRECRAWL_API_KEY: "firecrawl.apiKey",
  FIRECRAWL_TIMEOUT_MS: "firecrawl.timeoutMs",
  CRAWL4AI_API_URL: "crawl4ai.baseUrl",
  CRAWL4AI_API_TOKEN: "crawl4ai.apiToken",
  CRAWL4AI_API_TIMEOUT_MS: "crawl4ai.timeoutMs",
  GEMINI_WEB_SECURE_1PSID: "gemini.cookie",
  GEMINI_WEB_SECURE_1PSIDTS: "gemini.psidts",
  GEMINI_WEB_PROXY: "gemini.proxy",
  ZAI_API_KEY: "image.zaiKey",
  WEB_IMAGE_API_BASE_URL: "image.customUrl",
  WEB_IMAGE_API_KEY: "image.customKey",
  WEB_IMAGE_DAILY_CAP: "image.dailyCap",
  WEB_CHAT_API_BASE_URL: "chat.baseUrl",
  WEB_CHAT_API_KEY: "chat.apiKey",
  CHATGPT_WEB_MODEL: "chat.model",
};

/** One product key can be filed under several refs in the credential store
 *  (Z.AI: the coding-plan key is account-wide on paas v4 — verified 200 on
 *  /models; add a dedicated pay-as-you-go ZAI_API_KEY only if image calls 403). */
const CREDENTIAL_ALIASES: Record<string, string[]> = {
  ZAI_API_KEY: ["Z_AI_API_KEY", "ZAI_ANTHROPIC_API_KEY"],
};

function sectionValue(section: Record<string, unknown>, key: string): unknown {
  if (key.length === 0) return undefined;
  // Accept both the flat panel form ("brave.apiKey") and the nested form.
  if (Object.prototype.hasOwnProperty.call(section, key)) return section[key];
  let node: unknown = section;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

export function findEnvValue(
  name: string,
  _cwd = process.cwd(),
  _includeCwd = true,
): { value?: string; source: string } {
  const resolved = credential(name, ...(CREDENTIAL_ALIASES[name] ?? []));
  if (resolved.value !== undefined) {
    return { value: resolved.value, source: resolved.source === "env" ? "env" : "credential store" };
  }
  const value = sectionValue(loadSettingsSync().web, ENV_TO_SETTINGS_KEY[name] ?? "");
  if (value !== undefined && value !== null && value !== "") {
    return { value: String(value), source: "settings.json" };
  }
  return { value: undefined, source: "" };
}

export function cwdFromContext(ctx: Record<string, unknown>): string {
  return typeof ctx?.cwd === "string" && (ctx.cwd as string) ? (ctx.cwd as string) : process.cwd();
}

export function includeProjectEnv(ctx: Record<string, unknown>): boolean {
  return typeof ctx?.isProjectTrusted === "function" ? (ctx.isProjectTrusted as () => boolean)() : false;
}
