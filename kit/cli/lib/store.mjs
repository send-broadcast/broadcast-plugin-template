// The plugin store's publish API (sendbroadcast.net, /api/plugin-directory/v1) with the publisher's
// token. The token comes from BROADCAST_PUBLISHER_TOKEN, or from `broadcast-plugin login`, which
// keeps it in <config dir>/credentials.json, readable by this user only.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export class StoreError extends Error {}

const DEFAULT_STORE = "https://sendbroadcast.net";
const API = "/api/plugin-directory/v1";

export function configDir(env = process.env) {
  return env.BROADCAST_PLUGIN_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "broadcast-plugin");
}

const credentialsPath = (env) => join(configDir(env), "credentials.json");

function saved(env) {
  try {
    return JSON.parse(readFileSync(credentialsPath(env), "utf8"));
  } catch {
    return {};
  }
}

export function storeUrl(env = process.env) {
  return (env.BROADCAST_STORE_URL || saved(env).store_url || DEFAULT_STORE).replace(/\/+$/, "");
}

// { url, token } for the store, or a StoreError that says how to log in
export function storeConfig(env = process.env) {
  const token = env.BROADCAST_PUBLISHER_TOKEN || saved(env).token;
  if (!token) {
    throw new StoreError("No publisher token. Run broadcast-plugin login (the token is in the store: Dashboard > Plugins > Publishing token), or set BROADCAST_PUBLISHER_TOKEN.");
  }
  return { url: storeUrl(env), token };
}

export function saveCredentials(url, token, env = process.env) {
  mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
  const path = credentialsPath(env);
  writeFileSync(path, JSON.stringify({ store_url: url, token }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function removeCredentials(env = process.env) {
  const path = credentialsPath(env);
  const there = existsSync(path);
  rmSync(path, { force: true });
  return there;
}

// One request to the store. Returns the JSON answer; throws StoreError with the store's errors.
export async function storeRequest(config, method, path, body) {
  let res;
  try {
    res = await fetch(`${config.url}${API}${path}`, { method, headers: { authorization: `Bearer ${config.token}`, accept: "application/json" }, body });
  } catch (err) {
    throw new StoreError(`Cannot reach the plugin store at ${config.url}: ${err.cause?.message ?? err.message}`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new StoreError(`The plugin store answered HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new StoreError((json.errors ?? [`HTTP ${res.status}`]).join("\n"));
  return json;
}

export const whoami = (config) => storeRequest(config, "GET", "/publisher");

export function submitPackage(config, { name, zip, summary, category }) {
  const form = new FormData();
  form.append("package", new Blob([zip], { type: "application/zip" }), name);
  if (summary) form.append("summary", summary);
  if (category) form.append("category", category);
  return storeRequest(config, "POST", "/submissions", form);
}

export const versions = (config, id) => storeRequest(config, "GET", `/plugins/${encodeURIComponent(id)}/versions`);
