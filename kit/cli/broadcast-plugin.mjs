#!/usr/bin/env node
// broadcast-plugin: write, build, pack and test Broadcast plugins (see ../AGENTS.md).
// Node 22, no dependencies. esbuild is used when it is on PATH; it is never downloaded.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBundle } from "./lib/check.mjs";
import { checkImports } from "./lib/imports.mjs";
import { checkRepo } from "./lib/repo_check.mjs";
import { loadSpec } from "./lib/spec.mjs";
import { callTool, mcpConfig, ToolError } from "./lib/mcp.mjs";
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
                 (spec/plugin-repo.json). Errors exit 1; warnings do not.
  pack           Write <id>-<version>.broadcast-plugin (manifest.json, dist/main.js, src/, ui/,
                 assets/, README.md, LICENSE).

  test --local [--hook onEvent] [--args ...] [--fixtures ...] [--settings ...] [--secrets ...]
                 Run one hook of ./dist/main.js in the kit's own runtime, with no server (needs
                 deno on PATH). The store, events and logs are faked; fetch answers only from
                 fixtures. Prints the reply and the ops the plugin used. For tests in code, see
                 testing/mod.ts.
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
const SWITCHES = new Set(["local"]);

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

function checkCommand(dir) {
  const problems = checkRepo(dir, loadSpec());
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

function build(dir) {
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
  console.log(`Built dist/main.js${esbuild ? ` with esbuild ${version}` : " (copied: no imports)"}. ${SERVER_NOTE}`);
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
    case "submit": {
      print(await callTool(mcpConfig(), "plugin_draft_request_deploy", { plugin_key: key() }));
      return console.log("Submitted. An admin must review and deploy it in Application > Plugins.");
    }
    default:
      throw new Fail(`Unknown command ${command}. Run broadcast-plugin help.`);
  }
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof Fail || err instanceof ToolError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
