import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));

/** Read the project-local .env once; explicit process environment variables take precedence. */
export function loadProjectEnv(): void {
  if (existsSync(envPath)) loadEnvFile(envPath);
}

export function resolveOpenAIBaseUrl(raw: string | undefined): string {
  const value = raw?.trim() || "https://api.openai.com/v1";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OPENAI_BASE_URL must be an absolute URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("OPENAI_BASE_URL must use HTTPS (HTTP is allowed only for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("OPENAI_BASE_URL cannot include credentials, query, or fragment");
  }
  return url.href.replace(/\/$/, "");
}
