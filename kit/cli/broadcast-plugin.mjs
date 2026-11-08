#!/usr/bin/env node
// broadcast-plugin: write, build, pack and test Broadcast plugins (see ../AGENTS.md).
// Node 22, no dependencies. esbuild is used when it is on PATH; it is never downloaded.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBundle } from "./lib/check.mjs";
import { checkImports } from "./lib/imports.mjs";
import { checkRepo } from "./lib/repo_check.mjs";
import { loadSpec } from "./lib/spec.mjs";
import { callTool, mcpConfig, ToolError } from "./lib/mcp.mjs";
import { audit, dev, doctor, recordFixture, release } from "./lib/tools.mjs";
import { removeCredentials, saveCredentials, storeConfig, StoreError, storeUrl, submitPackage, versions, whoami } from "./lib/store.mjs";
import { ALLOWED_FILES, ALLOWED_FOLDERS, packagePathError, zipFiles } from "./lib/zip.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = ["event-listener", "scheduled-sync", "settings-page", "api-endpoint"];
const SERVER_NOTE = "This is a local check; the server check is authoritative (run `broadcast-plugin validate`).";

const HELP = `broadcast-plugin <command> [options]

  init <name> [--template ${TEMPLATES.join("|")}]
                 Create ./<name>, a plugin repo the plugin store accepts: manifest.json (id
                 local.<name>), src/main.js, test/, README.md, LICENSE, AGENTS.md, CLAUDE.md,
                 .gitignore, a GitHub Actions workflow and kit/ (a pinned copy of this kit).
  build          src/main.ts or src/main.js -> dist/main.js (esbuild when it is on PATH; else a
                 copy of an entry without imports), then check it like the server does.
  check          Check the repo layout and manifest.json with the plugin store's structure rules
                 (spec/plugin-repo.json). Errors exit 1; warnings do not. In a git repo, files git
                 would not commit (dist/, .sandbox/ in .gitignore) are left out, as the store sees
                 only the commit.
  pack           Write <id>-<version>.broadcast-plugin (manifest.json, dist/main.js, src/, ui/,
                 assets/, README.md, LICENSE).

  test --local [--hook onEvent] [--args ...] [--fixtures ...] [--settings ...] [--secrets ...]
                 Run one hook of ./dist/main.js in the kit's own runtime, with no server (needs
                 deno on PATH). The store, events and logs are faked; fetch answers only from
                 fixtures. Prints the reply and the ops the plugin used. For tests in code, see
                 testing/mod.ts.
  serve [--port 8080]
                 Build, then open the sandbox at http://localhost:8080: the plugin in the real
                 runtime against a fake Broadcast with 25 test people (needs deno on PATH). Its
                 pages, Compose and Inbox, People, Events (batches, send again), Time (a clock,
                 schedules, lifecycle hooks), Ops, Store, Logs and Settings. Data stays in
                 .sandbox/, never in the repo. A change in src/ or manifest.json builds and reloads
                 the plugin (the data stays; onUpgrade runs when declared; new permissions are
                 listed); a change in ui/ or assets/ refreshes.
  dev [--once] [--hook ... (as test --local)]
                 Build and run the tests (deno task test) now and on each change in src/, ui/,
                 test/ or manifest.json. --once runs one time and exits 1 when the tests fail.
  fixtures record <url> [--method GET] [--header 'name: value'] [--body <text>] [--out test/fixtures.json]
                 Make the real request and keep its response as a test fixture (status, content
                 type, body). Request headers are never written.
  audit [--json] What a reviewer sees: permissions, hosts, hooks, secret settings, pages, and the
                 problems of check and the bundle rules. Exits 1 on a problem.
  release <patch|minor|major|x.y.z> [--notes <text>]
                 Set the version (and listing.changelog), commit manifest.json and tag v<version>.
                 Refuses when other files have uncommitted changes.
  doctor         Check node, deno, esbuild, the repo, the kit, the server and the store login.

  These talk to the plugin store (sendbroadcast.net; env BROADCAST_STORE_URL to change it):
  login          Read a publishing token from stdin (Dashboard > Plugins > Publishing token),
                 check it, and keep it in ~/.config/broadcast-plugin (BROADCAST_PUBLISHER_TOKEN wins).
  logout         Remove the kept token.
  publish [--summary <text>] [--category <slug>]
                 check, build and pack, then send the package to the store for review.
  status         The store's review state of each version of this plugin.

  These talk to your server (env BROADCAST_URL and BROADCAST_TOKEN, a plugin developer token):
  push           Create or reuse the draft for this plugin's id and upload its files.
  test [--hook onEvent] [--args <json|file>] [--fixtures <json|file>] [--settings <json|file>]
       [--secrets <json|file>]
                 Run one hook of the draft against test data. fetch answers only from fixtures.
  logs [--limit 50]
                 The log lines of the draft's test runs.
  validate       Check the draft with the server's rules.
  submit         Ask for deploy. An admin reviews and deploys it; you cannot.
  help           This text.

Options for every command: --dir <plugin folder> (default: the current folder).`;

class Fail extends Error {}

// Flags that take no value
const SWITCHES = new Set(["local", "once", "json"]);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const name = argv[i].slice(2);
      if (SWITCHES.has(name)) {
        flags[name] = true;
        continue;
      }
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Fail(`--${name} needs a value.`);
      flags[name] = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

function readManifest(dir) {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) throw new Fail(`No manifest.json in ${dir}.`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Fail(`manifest.json is not valid JSON: ${err.message}`);
  }
}

// --- init ---

function init(dir, positional, flags) {
  const name = positional[0];
  if (!name || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(name)) {
    throw new Fail("init needs a name: lower case letters, digits and -, for example signup-alert.");
  }
  const template = flags.template ?? "event-listener";
  if (!TEMPLATES.includes(template)) throw new Fail(`Unknown template ${template}. Use one of: ${TEMPLATES.join(", ")}.`);
  const target = join(dir, name);
  if (existsSync(target)) throw new Fail(`${target} already exists.`);

  const title = name.split("-").map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  // The repo files every plugin has (templates/_repo), then the template's own files
  for (const source of [join(KIT, "templates", "_repo"), join(KIT, "templates", template)]) {
    for (const file of walk(source)) {
      const text = readFileSync(join(source, file), "utf8")
        .replaceAll("{{id}}", `local.${name}`)
        .replaceAll("{{name}}", name)
        .replaceAll("{{title}}", title)
        .replaceAll("{{year}}", String(new Date().getFullYear()));
      const path = join(target, repoPath(file));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }
  copyKit(join(target, "kit"));
  console.log(`Created ${target} (${template}). Next: edit src/main.js, then build, check and deno task test (see AGENTS.md).`);
}

// The kit zip leaves out dotfiles, so the templates name them without the dot.
function repoPath(file) {
  if (file === "gitignore") return ".gitignore";
  if (file.startsWith("github/")) return `.${file}`;
  return file;
}

// The kit a plugin repo pins: what the server's kit zip has, without examples and templates.
const KIT_LEFT_OUT = new Set(["test", "node_modules", "examples", "templates"]);

function copyKit(target) {
  for (const file of walk(KIT)) {
    const parts = file.split("/");
    if (KIT_LEFT_OUT.has(parts[0]) || parts.some((part) => part.startsWith("."))) continue;
    mkdirSync(dirname(join(target, file)), { recursive: true });
    writeFileSync(join(target, file), readFileSync(join(KIT, file)));
  }
  const { version } = JSON.parse(readFileSync(join(KIT, "package.json"), "utf8"));
  writeFileSync(join(target, "KIT_SOURCE"), `broadcast-plugin init, kit ${version}\ncreated ${new Date().toISOString()}\n`);
}

// --- check ---

// The paths of the folder that git would commit: tracked files, and untracked files it does not
// ignore. null when the folder is not in a git work tree (or git is not there).
function gitFiles(dir) {
  const res = spawnSync("git", ["-C", dir, "--literal-pathspecs", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], { encoding: "utf8" });
  if (res.status !== 0) return null;
  return res.stdout.split("\0").filter(Boolean);
}

function checkCommand(dir) {
  // The plugin store sees only what is committed. In a git repo, the check looks only at the files
  // git would commit: dist/ or serve's .sandbox/ in .gitignore are not there, do not count toward the
  // limits, and an ignored README.md is missing, as in the store.
  const files = gitFiles(dir);
  const problems = checkRepo(dir, loadSpec(), { only: files ? new Set(files) : null });
  const line = (problem) => `${problem.level} ${problem.id}: ${problem.message}`;
  for (const problem of problems.filter((p) => p.level === "warning")) console.log(line(problem));
  const errors = problems.filter((p) => p.level === "error");
  if (errors.length) throw new Fail(errors.map(line).join("\n"));
  console.log(`${dir} passes the structure check.`);
}

// --- build ---

function findOnPath(command) {
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    if (!folder) continue;
    const candidate = join(folder, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

// Conservative: anything that looks like loading another module needs a bundler.
const IMPORTS = /^\s*import\b|\bimport\s*\(|^\s*export\b[^\n;]*\bfrom\s*["'`]/m;

// path -> bytes of every file under src/
function sourceFiles(dir) {
  const files = new Map();
  if (!existsSync(join(dir, "src"))) return files;
  for (const file of walk(join(dir, "src"))) files.set(`src/${file}`, readFileSync(join(dir, "src", file)));
  return files;
}

function build(dir, { quiet = false } = {}) {
  const entry = ["src/main.ts", "src/main.js"].map((p) => join(dir, p)).find((p) => existsSync(p));
  if (!entry) throw new Fail("No src/main.ts or src/main.js.");
  const out = join(dir, "dist", "main.js");
  // The store refuses these before its build; refuse them here too, with the same messages
  const refused = checkImports(sourceFiles(dir), loadSpec());
  if (refused.length) throw new Fail(refused.map((problem) => problem.message).join("\n"));
  const esbuild = findOnPath("esbuild");
  let version = null;
  if (esbuild) {
    // The store builds with the spec's pinned version and flags; another version can give other bytes
    const spec = loadSpec().build;
    version = spawnSync(esbuild, ["--version"], { encoding: "utf8" }).stdout?.trim() || "unknown";
    if (version !== spec.esbuild) {
      console.error(`Warning: this is esbuild ${version}; the plugin store builds with esbuild ${spec.esbuild}. Install that version to get the same dist/main.js.`);
    }
    mkdirSync(dirname(out), { recursive: true });
    const res = spawnSync(esbuild, [entry, ...spec.flags, `--outfile=${out}`], { stdio: "inherit" });
    if (res.status !== 0) throw new Fail("esbuild failed.");
  } else {
    const code = readFileSync(entry, "utf8");
    if (entry.endsWith(".ts")) {
      throw new Fail("src/main.ts needs compiling: install esbuild (it must be on PATH), or write src/main.js.");
    }
    if (IMPORTS.test(code)) {
      throw new Fail("src/main.js imports other modules: install esbuild (it must be on PATH) to bundle them into dist/main.js.");
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, code);
  }
  const problems = checkBundle(readFileSync(out, "utf8"));
  if (problems.length) {
    throw new Fail(`dist/main.js breaks the bundle rules:\n  ${problems.join("\n  ")}\n${SERVER_NOTE}`);
  }
  if (!quiet) console.log(`Built dist/main.js${esbuild ? ` with esbuild ${version}` : " (copied: no imports)"}. ${SERVER_NOTE}`);
}

// --- files of a plugin, for pack and push ---

function walk(root, prefix = "") {
  const files = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(root, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

function pluginFiles(dir) {
  if (!existsSync(join(dir, "dist", "main.js"))) throw new Fail("No dist/main.js: run broadcast-plugin build first.");
  readManifest(dir);
  const files = ALLOWED_FILES.filter((f) => existsSync(join(dir, f)));
  for (const folder of ALLOWED_FOLDERS) {
    const root = join(dir, folder);
    if (!existsSync(root)) continue;
    // Dotfiles (.DS_Store, .gitkeep) are never part of a plugin.
    for (const file of walk(root)) if (!file.split("/").some((s) => s.startsWith("."))) files.push(folder + file);
  }
  for (const file of files) {
    const error = packagePathError(file);
    if (error) throw new Fail(`Cannot include ${error}`);
  }
  const problems = checkBundle(readFileSync(join(dir, "dist", "main.js"), "utf8"));
  if (problems.length) throw new Fail(`dist/main.js breaks the bundle rules:\n  ${problems.join("\n  ")}`);
  return files;
}

function pack(dir) {
  const manifest = readManifest(dir);
  if (!manifest.id || !manifest.version) throw new Fail("manifest.json needs id and version.");
  const files = pluginFiles(dir);
  const zip = zipFiles(files.map((path) => ({ path, data: readFileSync(join(dir, path)) })));
  const name = `${manifest.id}-${manifest.version}.broadcast-plugin`;
  writeFileSync(join(dir, name), zip);
  console.log(`Wrote ${name} (${files.length} files, ${zip.length} bytes).`);
  return { name, zip };
}

// --- plugin store commands (publisher token) ---

async function readStdin() {
  if (process.stdin.isTTY) process.stderr.write("Paste the publishing token (Dashboard > Plugins > Publishing token), then press Enter: ");
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.includes("\n")) break;
  }
  return text.split("\n")[0].trim();
}

async function login() {
  const token = await readStdin();
  if (!token) throw new Fail("No token given.");
  const url = storeUrl();
  const { publisher } = await whoami({ url, token });
  saveCredentials(url, token);
  console.log(`Logged in to ${url} as ${publisher.name}${publisher.verified ? " (verified)" : ""}.`);
}

async function publish(dir, flags) {
  const config = storeConfig();
  checkCommand(dir);
  build(dir);
  const { name, zip } = pack(dir);
  const result = await submitPackage(config, { name, zip, summary: flags.summary, category: flags.category });
  console.log(`Sent ${result.plugin_id} ${result.version} to the plugin store: ${result.status}.`);
  if (result.url) console.log(`Follow the review: ${result.url}`);
}

async function status(dir, flags) {
  const config = storeConfig();
  const id = flags.key ?? readManifest(dir).id;
  const result = await versions(config, id);
  console.log(`${result.plugin_id}${result.listed ? " (listed)" : ""}${result.url ? `  ${result.url}` : ""}`);
  for (const v of result.versions ?? []) {
    const notes = [v.submitted_at && `submitted ${v.submitted_at}`, v.decided_at && `decided ${v.decided_at}`,
      v.open_messages > 0 && `${v.open_messages} message${v.open_messages === 1 ? "" : "s"} to answer`, v.block_notice].filter(Boolean);
    console.log(`  ${String(v.version).padEnd(10)} ${String(v.status).padEnd(16)} ${notes.join(", ")}`);
  }
}

// --- server commands ---

function print(value) {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function jsonOption(dir, value, name) {
  if (value === undefined) return undefined;
  const text = /^\s*[[{]/.test(value) ? value : readFileSync(resolve(dir, value), "utf8");
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Fail(`--${name} is not JSON: ${err.message}`);
  }
}

async function push(dir) {
  const manifest = readManifest(dir);
  const id = String(manifest.id ?? "");
  if (!/^local\.[a-z0-9][a-z0-9-]{0,59}$/.test(id)) throw new Fail(`manifest id ${JSON.stringify(id)} must be local.<name>.`);
  const files = pluginFiles(dir);
  const config = mcpConfig();

  const installed = (await callTool(config, "plugins_list", {})).find((p) => p.plugin_key === id);
  if (!installed) {
    // The server makes the key from the name: create with the id's name so the key is the id.
    const draft = await callTool(config, "plugin_draft_create", { name: id.slice("local.".length) });
    if (draft.plugin_key !== id) {
      throw new Fail(`The server named the new draft ${draft.plugin_key}, not ${id} (the id is taken). Set "id": "${draft.plugin_key}" in manifest.json and push again.`);
    }
    console.log(`Created draft ${id}.`);
  } else if (!installed.versions?.some((v) => v.status === "draft")) {
    const draft = await callTool(config, "plugin_draft_create", { from: id });
    console.log(`Created draft ${draft.version} of ${id}.`);
  } else {
    console.log(`Updating the draft of ${id}.`);
  }

  const utf8 = new TextDecoder("utf-8", { fatal: true });
  for (const path of files) {
    let content;
    try {
      content = utf8.decode(readFileSync(join(dir, path)));
    } catch {
      console.warn(`Skipped ${path}: drafts hold text files only.`);
      continue;
    }
    await callTool(config, "plugin_draft_write_file", { plugin_key: id, path, content });
    console.log(`  ${path}`);
  }
  console.log("Pushed. Next: broadcast-plugin validate, then broadcast-plugin test.");
}

async function testRun(dir, flags) {
  if (flags.local) return testLocal(dir, flags);
  const key = flags.key ?? readManifest(dir).id;
  const args = jsonOption(dir, flags.args, "args") ?? [];
  const call = { plugin_key: key, hook: flags.hook ?? "onEvent", args: Array.isArray(args) ? args : [args] };
  for (const name of ["fixtures", "settings", "secrets"]) {
    const value = jsonOption(dir, flags[name], name);
    if (value !== undefined) call[name] = value;
  }
  const result = await callTool(mcpConfig(), "plugin_draft_test", call);
  print(result);
  if (result?.ok === false) throw new Fail(`The hook failed: ${result.error?.code}: ${result.error?.message}`);
}

// The sandbox screen (sandbox/serve.ts), run by deno until Ctrl+C. It may write only .sandbox/.
async function serve(dir, flags) {
  readManifest(dir);
  const deno = findOnPath("deno");
  if (!deno) throw new Fail("deno is not on PATH. serve runs the plugin in the Broadcast runtime, which needs Deno 2 (https://deno.com).");
  const port = Number(flags.port ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Fail("--port must be a number from 1 to 65535.");
  build(dir);
  const root = resolve(dir);
  // Read: the plugin folder, the kit (screen and Signal files) and the deno binary (the runtime starts
  // each plugin process with Deno.execPath()). Write: .sandbox/ only. Net: 127.0.0.1 only (the screen,
  // the fake Host API and the runtime). Run: deno for plugin processes, ps for their memory.
  // deno on PATH is often a symlink; Deno.execPath() gives the real file
  const read = [...new Set([root, KIT, deno, realpathSync(deno)])].join(",");
  const child = spawn(deno, ["run", "--no-prompt", "--quiet", "--allow-net=127.0.0.1", `--allow-read=${read}`, `--allow-write=${join(root, ".sandbox")}`,
    "--allow-run", "--allow-env", join(KIT, "sandbox", "serve.ts"), JSON.stringify({ dir: root, port })], { stdio: "inherit" });
  const watcher = watchForReload(dir, root, port);
  const stop = () => child.kill("SIGINT");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const code = await new Promise((done) => child.on("exit", (exit, signal) => done(signal ? 0 : exit ?? 1)));
  watcher.close();
  if (code !== 0) process.exitCode = code;
}

// Hot reload for serve: a change in src/ or manifest.json builds and reloads the plugin; a change in
// ui/ or assets/ refreshes the screen; a failed build shows on the screen and here.
function watchForReload(dir, root, port) {
  const call = async (path, body) => {
    try {
      const res = await fetch(`http://localhost:${port}${path}`, {
        method: "POST", headers: { "x-sandbox": "1", "content-type": "application/json" }, body: JSON.stringify(body ?? {}),
      });
      return await res.json();
    } catch {
      return null;
    }
  };
  const pending = new Set();
  let timer = null;
  let running = Promise.resolve();
  const flush = async () => {
    const files = [...pending];
    pending.clear();
    if (!files.some((f) => f.startsWith("src/") || f === "manifest.json")) {
      console.log(`change  ${files.join(", ")}`);
      await call("/api/refresh");
      return;
    }
    try {
      build(dir, { quiet: true });
    } catch (err) {
      const message = err instanceof Fail ? err.message : String(err?.message ?? err);
      console.error(`build   failed: ${message}`);
      await call("/api/build-error", { message });
      return;
    }
    const answer = await call("/api/reload");
    console.log(`reload  ${answer?.message ?? "the sandbox did not answer"}`);
  };
  return watch(root, { recursive: true }, (_event, file) => {
    if (!file) return;
    const path = String(file).split(sep).join("/");
    if (!/^(src|ui|assets)\//.test(path) && path !== "manifest.json") return;
    // Hidden, swap and backup files that editors and tools write next to the real one
    if (path.split("/").some((part) => part.startsWith(".") || part.endsWith("~") || /^#.*#$/.test(part) || /\.(swp|swx|tmp)$/.test(part))) return;
    pending.add(path);
    clearTimeout(timer);
    timer = setTimeout(() => (running = running.then(flush)), 150);
  });
}

// The kit's own runtime (runtime/, testing/), run by deno: no server, no network
function testLocal(dir, flags) {
  readManifest(dir);
  const deno = findOnPath("deno");
  if (!deno) throw new Fail("deno is not on PATH. test --local runs the plugin in the Broadcast runtime, which needs Deno 2 (https://deno.com).");
  const args = jsonOption(dir, flags.args, "args") ?? [];
  const input = { dir, hook: flags.hook ?? "onEvent", args: Array.isArray(args) ? args : [args] };
  for (const name of ["fixtures", "settings", "secrets"]) {
    const value = jsonOption(dir, flags[name], name);
    if (value !== undefined) input[name] = value;
  }
  const res = spawnSync(deno, ["run", "--no-prompt", "--quiet", "--allow-net=127.0.0.1", "--allow-read", "--allow-run", "--allow-env",
    join(KIT, "testing", "cli.ts"), JSON.stringify(input)], { encoding: "utf8" });
  if (res.stdout) process.stdout.write(res.stdout);
  let reply = null;
  try {
    reply = JSON.parse(res.stdout);
  } catch { /* the runtime did not answer */ }
  if (!reply) throw new Fail(`The local runtime did not answer: ${(res.stderr || "").trim().slice(0, 2000)}`);
  if (reply.ok === false) throw new Fail(`The hook failed: ${reply.error?.code}: ${reply.error?.message}`);
}

async function main(argv) {
  const [command = "help", ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const dir = resolve(flags.dir ?? ".");
  const key = () => flags.key ?? readManifest(dir).id;
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      return console.log(HELP);
    case "init":
      return init(dir, positional, flags);
    case "build":
      return build(dir);
    case "pack":
      return pack(dir);
    case "push":
      return await push(dir);
    case "test":
      return await testRun(dir, flags);
    case "logs": {
      const args = { plugin_key: key() };
      if (flags.limit) args.limit = Number(flags.limit);
      const logs = await callTool(mcpConfig(), "plugin_logs", args);
      if (Array.isArray(logs)) {
        for (const l of logs) console.log(`${l.at} ${String(l.level).padEnd(5)} ${l.hook} ${l.message}`);
        return;
      }
      return print(logs);
    }
    case "check":
      return checkCommand(dir);
    case "validate": {
      const result = await callTool(mcpConfig(), "plugin_draft_validate", { plugin_key: key() });
      print(result);
      if (result?.valid === false) throw new Fail("The draft is not valid.");
      return;
    }
    case "release":
      return release(dir, positional, flags, { readManifest, Fail });
    case "doctor":
      if (!(await doctor(dir, { findOnPath, KIT }))) throw new Fail("doctor found a problem (fail above).");
      return;
    case "fixtures":
      return await recordFixture(dir, positional, flags, { Fail });
    case "audit":
      if (!audit(dir, flags, { readManifest, build, Fail })) process.exitCode = 1;
      return;
    case "dev":
      if (!(await dev(dir, flags, { build, testLocal, findOnPath, Fail }))) process.exitCode = 1;
      return;
    case "serve":
      return await serve(dir, flags);
    case "login":
      return await login();
    case "logout":
      return console.log(removeCredentials() ? "Logged out: the publisher token is removed." : "No saved publisher token.");
    case "publish":
      return await publish(dir, flags);
    case "status":
      return await status(dir, flags);
    case "submit": {
      print(await callTool(mcpConfig(), "plugin_draft_request_deploy", { plugin_key: key() }));
      return console.log("Submitted. An admin must review and deploy it in Application > Plugins.");
    }
    default:
      throw new Fail(`Unknown command ${command}. Run broadcast-plugin help.`);
  }
}

// --name=value is the same as --name value
function splitEquals(argv) {
  return argv.flatMap((arg) => {
    const match = arg.match(/^(--[^=]+)=(.*)$/s);
    return match ? [match[1], match[2]] : [arg];
  });
}

// Installed globally (npm i -g @send-broadcast/plugin-kit), the command runs the plugin repo's
// pinned kit/ when the repo has one, so a repo builds and tests with the kit it pins. Only for the
// commands that run the repo's own code anyway: check, audit and the rest are how a reviewer looks
// at a repo not yet trusted, so they never run its kit/. Not when kit/ is this kit, and not again
// from the pinned kit.
const PINNED_COMMANDS = new Set(["build", "test", "dev", "serve", "pack"]);

function runPinnedKit(argv) {
  if (!PINNED_COMMANDS.has(argv[0]) || process.env.BROADCAST_PLUGIN_PINNED === "1") return null;
  const at = argv.indexOf("--dir");
  const dir = resolve(at >= 0 && argv[at + 1] ? argv[at + 1] : ".");
  const pinned = join(dir, "kit", "cli", "broadcast-plugin.mjs");
  if (!existsSync(pinned) || realpathSync(pinned) === realpathSync(fileURLToPath(import.meta.url))) return null;
  const versionOf = (root) => {
    try {
      return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "?";
    } catch {
      return "?";
    }
  };
  const [mine, theirs] = [versionOf(KIT), versionOf(join(dir, "kit"))];
  if (mine !== theirs) {
    console.error(`broadcast-plugin: using the repo's pinned kit/ (${theirs}); this command is ${mine}. To update kit/, see "The kit" in AGENTS.md (or set BROADCAST_PLUGIN_PINNED=1 to use ${mine}).`);
  }
  const res = spawnSync(process.execPath, [pinned, ...argv], { stdio: "inherit", env: { ...process.env, BROADCAST_PLUGIN_PINNED: "1" } });
  return res.status ?? 1;
}

const ARGS = splitEquals(process.argv.slice(2));
const pinnedExit = runPinnedKit(ARGS);
if (pinnedExit !== null) process.exit(pinnedExit);

try {
  await main(ARGS);
} catch (err) {
  if (err instanceof Fail || err instanceof ToolError || err instanceof StoreError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
