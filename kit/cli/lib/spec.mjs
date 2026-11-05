// The repo structure spec (../../spec/plugin-repo.json). The plugin store reads the same file.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SPEC_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "spec", "plugin-repo.json");
export const LEVELS = ["error", "warning"];
// file: that file; anyFile: one of paths; folder: a folder with at least one file in it;
// absent: that path must not exist
export const RULE_KINDS = ["file", "anyFile", "folder", "absent"];

export function loadSpec(path = SPEC_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}
