// Checks a plugin repo folder against the structure spec (spec/plugin-repo.json, its `matching`
// section). The plugin store implements the same rules; spec/plugin-repo-vectors.json keeps the two
// in step. Returns problems: [{ id, level, path?, message }].
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkImports } from "./imports.mjs";

function patternToRegExp(pattern) {
  const escaped = pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

// Every entry under root: { path, type: "file" | "folder" | "symlink", size }. Skipped names (at the
// root only) and forbidden folders are not looked into.
function walk(root, spec, problems) {
  const forbidden = spec.repo.forbidden.map((rule) => ({ ...rule, regexp: patternToRegExp(rule.pattern) }));
  const exceptions = new Set(spec.repo.forbiddenExceptions.map((name) => name.toLowerCase()));
  const entries = [];

  const visit = (relative) => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      if (relative === "" && spec.repo.skip.includes(name)) continue;
      const path = relative + name;
      const stat = lstatSync(join(root, path));
      const folder = stat.isDirectory();
      const shown = folder ? `${path}/` : path;
      if (stat.isSymbolicLink()) {
        problems.push({ id: spec.repo.symlinks.id, level: spec.repo.symlinks.level, path, message: spec.repo.symlinks.message });
        continue;
      }
      const lower = name.toLowerCase();
      const rule = exceptions.has(lower) ? null : forbidden.find((candidate) => candidate.regexp.test(lower));
      if (rule) {
        problems.push({ id: rule.id, level: rule.level, path: shown, message: `${shown}: ${rule.message}` });
        continue;
      }
      if (folder) {
        entries.push({ path: shown, type: "folder" });
        visit(shown);
      } else if (stat.isFile()) {
        entries.push({ path, type: "file", size: stat.size });
      }
    }
  };
  visit("");
  return entries;
}

function ruleProblem(rule, entries, files) {
  switch (rule.kind) {
    case "file":
      return files.has(rule.path) ? null : {};
    case "anyFile":
      return rule.paths.some((path) => files.has(path)) ? null : {};
    case "folder":
      return [...files.keys()].some((path) => path.startsWith(rule.path)) ? null : {};
    case "absent": {
      const there = entries.some((entry) => entry.path === rule.path);
      return there ? { path: rule.path } : null;
    }
    default:
      throw new Error(`Unknown rule kind ${rule.kind}`);
  }
}

function blank(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function manifestProblems(root, spec, files) {
  if (!files.has("manifest.json")) return [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  } catch {
    manifest = undefined;
  }
  const { invalid, missing } = spec.manifest;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [{ id: invalid.id, level: invalid.level, message: invalid.message }];
  }
  return spec.manifest.required
    .filter((key) => blank(key.split(".").reduce((value, part) => (value && typeof value === "object" ? value[part] : undefined), manifest)))
    .map((key) => ({ id: `${missing.idPrefix}${key}`, level: missing.level, message: missing.message.replace("%s", key) }));
}

// path -> bytes of the files in src/ (the import check reads these)
export function srcFiles(root, files) {
  return new Map([...files.keys()].filter((path) => path.startsWith("src/")).map((path) => [path, readFileSync(join(root, path))]));
}

export function checkRepo(root, spec) {
  const problems = [];
  const entries = walk(root, spec, problems);
  const files = new Map(entries.filter((entry) => entry.type === "file").map((entry) => [entry.path, entry.size]));

  for (const rule of spec.repo.rules) {
    const problem = ruleProblem(rule, entries, files);
    if (problem) problems.push({ id: rule.id, level: rule.level, message: rule.message, ...problem });
  }
  problems.push(...manifestProblems(root, spec, files));
  problems.push(...checkImports(srcFiles(root, files), spec));

  const totals = { "limits.maxFiles": files.size, "limits.maxBytes": [...files.values()].reduce((sum, size) => sum + size, 0) };
  for (const limit of spec.repo.limits) {
    if (totals[limit.id] > limit.value) problems.push({ id: limit.id, level: limit.level, message: limit.message });
  }
  return problems;
}
