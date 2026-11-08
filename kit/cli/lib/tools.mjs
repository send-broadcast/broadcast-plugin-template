// release, doctor, fixtures record, audit and dev. The CLI passes in what they share with it
// (build, readManifest, findOnPath, Fail, ...), so this file has no state of its own.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { checkRepo } from "./repo_check.mjs";
import { loadSpec } from "./spec.mjs";
import { callTool, mcpConfig } from "./mcp.mjs";
import { storeConfig, whoami } from "./store.mjs";

// --- release ---

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function nextVersion(current, which, Fail) {
  const now = SEMVER.exec(String(current ?? ""));
  if (!now) throw new Fail(`manifest.json version ${JSON.stringify(current)} is not x.y.z.`);
  const [major, minor, patch] = now.slice(1).map(Number);
  let next;
  if (which === "major") next = [major + 1, 0, 0];
  else if (which === "minor") next = [major, minor + 1, 0];
  else if (which === "patch") next = [major, minor, patch + 1];
  else if (SEMVER.test(which ?? "")) next = SEMVER.exec(which).slice(1).map(Number);
  else throw new Fail("release needs patch, minor, major or a version x.y.z.");
  const newer = next[0] - major || next[1] - minor || next[2] - patch;
  if (newer <= 0) throw new Fail(`${next.join(".")} is not newer than ${current}.`);
  return next.join(".");
}

const gitIn = (dir, ...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });

export function release(dir, positional, flags, { readManifest, Fail }) {
  const manifest = readManifest(dir);
  const version = nextVersion(manifest.version, positional[0], Fail);
  const inGit = gitIn(dir, "rev-parse", "--is-inside-work-tree").stdout?.trim() === "true";

  if (inGit) {
    const changed = [
      ...gitIn(dir, "ls-files", "--modified", "--others", "--exclude-standard").stdout.split("\n"),
      ...gitIn(dir, "diff", "--cached", "--name-only", "--relative").stdout.split("\n"),
    ].filter((path) => path && path !== "manifest.json");
    if (changed.length) throw new Fail(`Commit or stash these first; a release commits only manifest.json:\n  ${[...new Set(changed)].join("\n  ")}`);
    if (gitIn(dir, "rev-parse", "-q", "--verify", `refs/tags/v${version}`).status === 0) throw new Fail(`The tag v${version} exists already.`);
  }

  manifest.version = version;
  if (flags.notes) manifest.listing = { ...(manifest.listing ?? {}), changelog: flags.notes };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  if (!inGit) return console.log(`Version ${version} (not a git repo: no commit or tag).`);
  for (const args of [["add", "manifest.json"], ["commit", "-q", "-m", `Release ${version}`], ["tag", `v${version}`]]) {
    const res = gitIn(dir, ...args);
    if (res.status !== 0) throw new Fail(`git ${args[0]} failed: ${(res.stderr || res.stdout).trim()}`);
  }
  console.log(`Released ${version}: committed manifest.json and tagged v${version}. Next: git push --follow-tags, then broadcast-plugin publish.`);
}

// --- doctor ---

export async function doctor(dir, { findOnPath, KIT }) {
  const rows = [];
  const row = (level, name, text) => rows.push([level, name, text]);

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  row(nodeMajor >= 22 ? "ok" : "fail", "node", `${process.versions.node}${nodeMajor >= 22 ? "" : " (the kit needs Node 22 or newer)"}`);

  const deno = findOnPath("deno");
  const denoVersion = deno && spawnSync(deno, ["--version"], { encoding: "utf8" }).stdout?.split("\n")[0];
  row(deno ? "ok" : "warn", "deno", deno ? denoVersion : "not on PATH: the tests and test --local need Deno 2 (https://deno.com)");

  const spec = loadSpec();
  const esbuild = findOnPath("esbuild");
  const esbuildVersion = esbuild && spawnSync(esbuild, ["--version"], { encoding: "utf8" }).stdout?.trim();
  if (!esbuild) row("warn", "esbuild", `not on PATH: build copies a src/main.js without imports; the plugin store builds with esbuild ${spec.build.esbuild}`);
  else row(esbuildVersion === spec.build.esbuild ? "ok" : "warn", "esbuild", esbuildVersion === spec.build.esbuild ? esbuildVersion : `${esbuildVersion}; the plugin store builds with ${spec.build.esbuild}`);

  if (existsSync(join(dir, "manifest.json"))) {
    const problems = checkRepo(dir, spec);
    const errors = problems.filter((p) => p.level === "error");
    const warnings = problems.filter((p) => p.level === "warning");
    if (errors.length) row("fail", "check", `${errors.length} error(s): ${errors.map((p) => p.id).join(", ")} (run broadcast-plugin check)`);
    else if (warnings.length) row("warn", "check", `${warnings.length} warning(s): ${warnings.map((p) => p.id).join(", ")}`);
    else row("ok", "check", "the repo passes the structure check");
  } else {
    row("warn", "check", `no manifest.json in ${dir}`);
  }

  const kitSource = join(dir, "kit", "KIT_SOURCE");
  row(existsSync(kitSource) ? "ok" : "warn", "kit", existsSync(kitSource) ? readFileSync(kitSource, "utf8").split("\n")[0] : `no kit/ in this repo (this command runs the kit at ${KIT})`);

  try {
    const config = mcpConfig();
    await callTool(config, "plugins_list", {});
    row("ok", "server", `${config.url} answers with this token`);
  } catch (err) {
    row("warn", "server", `${err.message} (push, test, logs, validate and submit need it)`);
  }

  try {
    const { publisher } = await whoami(storeConfig());
    row("ok", "store", `logged in as ${publisher.name}`);
  } catch (err) {
    row("warn", "store", `${err.message.split("\n")[0]} (publish and status need it)`);
  }

  for (const [level, name, text] of rows) console.log(`${level.padEnd(5)} ${name.padEnd(8)} ${text}`);
  return rows.every(([level]) => level !== "fail");
}

// --- fixtures record ---

export async function recordFixture(dir, positional, flags, { Fail }) {
  if (positional[0] !== "record" || !positional[1]) throw new Fail("Use: broadcast-plugin fixtures record <url> [--method GET] [--header 'name: value'] [--body <text>] [--out test/fixtures.json]");
  const url = positional[1];
  const method = (flags.method ?? "GET").toUpperCase();
  const headers = {};
  if (flags.header) {
    const at = flags.header.indexOf(":");
    if (at < 1) throw new Fail("--header must be 'name: value'.");
    headers[flags.header.slice(0, at).trim()] = flags.header.slice(at + 1).trim();
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: flags.body });
  } catch (err) {
    throw new Fail(`Cannot reach ${url}: ${err.cause?.message ?? err.message}`);
  }
  const fixture = { method, url, status: res.status, headers: {}, body: await res.text() };
  // Only the response's content type: request headers (keys, tokens) are never written
  const type = res.headers.get("content-type");
  if (type) fixture.headers["content-type"] = type;

  const out = join(dir, flags.out ?? "test/fixtures.json");
  const fixtures = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : [];
  if (!Array.isArray(fixtures)) throw new Fail(`${out} is not a list of fixtures.`);
  const kept = fixtures.filter((f) => !(f.url === url && (f.method ?? "GET").toUpperCase() === method));
  writeFileSync(out, `${JSON.stringify([...kept, fixture], null, 2)}\n`);
  console.log(`Recorded ${method} ${url} (${res.status}) in ${relative(dir, out)}. Check the body for personal data before you commit it.`);
}

// --- audit ---

function describe(manifest) {
  const permissions = manifest.permissions ?? {};
  const words = (value) => (Array.isArray(value) ? value.join(", ") : String(value));
  const hooks = manifest.hooks ?? {};
  return {
    id: manifest.id, version: manifest.version,
    requires: manifest.requires ?? {},
    permissions: Object.entries(permissions).filter(([key]) => !["network", "elevated"].includes(key)).map(([key, value]) => `${key}: ${words(value)}`),
    network: (permissions.network ?? []).map((host) => (typeof host === "string" ? host : `from setting ${host.fromSetting}`)),
    elevated: permissions.elevated ?? [],
    hooks: Object.entries(hooks).map(([key, value]) => {
      if (key === "events") return `events: ${words(value)}`;
      if (Array.isArray(value)) return `${key}: ${value.map((v) => (typeof v === "object" ? v.name : v)).join(", ")}`;
      return key;
    }),
    secretSettings: Object.entries(manifest.settings ?? {}).filter(([, d]) => d?.secret).map(([name]) => name),
    pages: (manifest.ui?.pages ?? []).map((page) => `${page.slot}: ${page.path}`),
  };
}

export function audit(dir, flags, { readManifest, build, Fail }) {
  const manifest = readManifest(dir);
  const problems = checkRepo(dir, loadSpec()).filter((p) => p.level === "error").map((p) => `${p.id}: ${p.message}`);
  try {
    build(dir, { quiet: true });
  } catch (err) {
    if (!(err instanceof Fail)) throw err;
    problems.push(err.message);
  }
  const report = { ...describe(manifest), problems };
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.id} ${report.version} (pluginApi ${report.requires.pluginApi}, Broadcast ${report.requires.broadcast})`);
    console.log(`permissions: ${report.permissions.join("; ") || "none"}`);
    console.log(`network: ${report.network.join(", ") || "none"}`);
    if (report.elevated.length) console.log(`elevated: ${report.elevated.join(", ")}`);
    console.log(`hooks: ${report.hooks.join("; ") || "none"}`);
    console.log(`secret settings: ${report.secretSettings.join(", ") || "none"}`);
    if (report.pages.length) console.log(`pages: ${report.pages.join(", ")}`);
    console.log(problems.length ? `problems:\n  ${problems.join("\n  ")}` : "problems: none (the server check is authoritative: broadcast-plugin validate)");
  }
  return problems.length === 0;
}

// --- dev ---

export function dev(dir, flags, { build, testLocal, findOnPath, Fail }) {
  const cycle = () => {
    try {
      build(dir);
      if (existsSync(join(dir, "test")) && existsSync(join(dir, "deno.json"))) {
        const deno = findOnPath("deno");
        if (!deno) throw new Fail("deno is not on PATH: the tests need Deno 2 (https://deno.com).");
        const res = spawnSync(deno, ["task", "test"], { cwd: dir, encoding: "utf8" });
        process.stdout.write(res.stdout ?? "");
        process.stdout.write(res.stderr ?? "");
        console.log(res.status === 0 ? "dev: tests passed." : "dev: tests failed.");
        return res.status === 0;
      }
      if (flags.hook) testLocal(dir, flags);
      console.log("dev: built.");
      return true;
    } catch (err) {
      if (!(err instanceof Fail)) throw err;
      console.log(`dev: ${err.message}`);
      console.log("dev: tests failed.");
      return false;
    }
  };

  if (flags.once) return cycle();

  cycle();
  console.log("dev: watching src/, ui/, test/ and manifest.json. Press Ctrl-C to stop.");
  let timer = null;
  const onChange = (_event, file) => {
    if (file && String(file).startsWith("dist")) return;
    clearTimeout(timer);
    timer = setTimeout(cycle, 300);
  };
  for (const path of ["src", "ui", "test", "manifest.json"]) {
    const full = join(dir, path);
    if (existsSync(full)) watch(full, { recursive: path !== "manifest.json" }, onChange);
  }
  return new Promise(() => {});
}
