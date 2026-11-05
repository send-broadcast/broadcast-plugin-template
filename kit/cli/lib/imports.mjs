// The import rules of spec/plugin-repo.json (`imports`): every module in src/ may import only other
// files in src/. The plugin store has the same check (send-broadcast PluginRepoImports);
// spec/plugin-repo-vectors.json (importCases) keeps the two in step.
//
// A small tokenizer tells strings, template literals, comments and regular expression literals
// apart; whether / starts a regular expression is guessed from the token before it, as tools
// without a full parser do.
import { extname } from "node:path";

const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const PUNCTUATORS_AFTER_VALUE = new Set([")", "]", "}"]);
const NAME = /[A-Za-z_$\p{L}][\w$\p{L}\p{N}]*/uy;
const NUMBER = /\d[\w.]*/y;
const SPACE = /\s+/y;
const LINE_COMMENT = /\/\/[^\n]*/y;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//y;

function regexAllowed(previous) {
  if (!previous) return true;
  if (previous.kind === "name") return KEYWORDS_BEFORE_REGEX.has(previous.value);
  if (previous.kind !== "punct") return false;
  return !PUNCTUATORS_AFTER_VALUE.has(previous.value);
}

// Names, strings (their raw text), templates and punctuators; comments, spaces, numbers and
// regular expression literals are dropped (a regex becomes a value token).
export function tokens(text) {
  const out = [];
  const braces = []; // "template" when the { opened a ${ in a template
  let i = 0;
  const at = (re) => {
    re.lastIndex = i;
    const match = re.exec(text);
    return match ? match[0] : null;
  };

  const stringBody = (quote) => {
    let body = "";
    while (i < text.length) {
      const char = text[i++];
      if (char === quote) return body;
      body += char;
      if (char === "\\" && i < text.length) body += text[i++];
    }
    return body;
  };

  const template = (continued) => {
    let body = "";
    while (i < text.length) {
      const char = text[i++];
      if (char === "`") return { kind: continued ? "template" : "string", value: body };
      if (char === "$" && text[i] === "{") {
        i++;
        braces.push("template");
        return { kind: "template", value: body };
      }
      body += char;
      if (char === "\\" && i < text.length) body += text[i++];
    }
    return { kind: "template", value: body };
  };

  const skipRegex = () => {
    i++; // the opening /
    let inClass = false;
    while (i < text.length) {
      const char = text[i++];
      if (char === "\\") i++;
      else if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "\n") return;
      else if (char === "/" && !inClass) break;
    }
    while (i < text.length && /[a-z]/.test(text[i])) i++;
  };

  while (i < text.length) {
    let match;
    if ((match = at(SPACE) ?? at(LINE_COMMENT) ?? at(BLOCK_COMMENT))) {
      i += match.length;
    } else if (text.startsWith("/*", i)) {
      break; // an unclosed comment runs to the end
    } else if ((match = at(NAME))) {
      out.push({ kind: "name", value: match });
      i += match.length;
    } else if ((match = at(NUMBER))) {
      out.push({ kind: "name", value: "0" });
      i += match.length;
    } else if (text[i] === '"' || text[i] === "'") {
      const quote = text[i++];
      out.push({ kind: "string", value: stringBody(quote) });
    } else if (text[i] === "`") {
      i++;
      out.push(template(false));
    } else if (text[i] === "/" && regexAllowed(out.at(-1))) {
      skipRegex();
      out.push({ kind: "name", value: "/re/" });
    } else if (text[i] === "{") {
      i++;
      braces.push("block");
      out.push({ kind: "punct", value: "{" });
    } else if (text[i] === "}") {
      i++;
      if (braces.pop() === "template") out.push(template(true));
      else out.push({ kind: "punct", value: "}" });
    } else {
      // One character (a whole code point, so a surrogate pair stays together)
      const char = String.fromCodePoint(text.codePointAt(i));
      out.push({ kind: "punct", value: char });
      i += char.length;
    }
  }
  return out;
}

// folder + relative specifier, normalised; null when it climbs above the repo root
function resolve(folder, specifier) {
  const parts = folder === "." ? [] : folder.split("/");
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.pop() === undefined) return null;
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

export function checkImports(files, spec) {
  const rules = spec.imports;
  const problem = (id, path, values) => {
    const rule = rules.problems[id];
    // Like the store (Ruby String#truncate(100)): a long specifier is cut in the message text only
    const cut = (text) => (text.length > 100 ? `${text.slice(0, 97)}...` : text);
    const message = rule.message.replace(/%\{(\w+)\}/g, (_, name) => (name === "path" ? path : name === "specifier" ? cut(values[name]) : values[name]));
    const extra = {};
    if (values.specifier !== undefined) extra.specifier = values.specifier;
    if (values.call !== undefined) extra.call = values.call;
    return { id, level: rule.level, path, ...extra, message };
  };

  const checkSpecifier = (path, specifier) => {
    if (specifier.includes("\\")) return [problem("import-backslash", path, { specifier })];
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return [problem("import-not-relative", path, { specifier })];
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    const resolved = resolve(folder, specifier.replace(/[?#][\s\S]*$/, ""));
    if (resolved === null || !resolved.startsWith("src/")) return [problem("import-outside-src", path, { specifier })];
    if (rules.refusedExtensions.includes(extname(resolved).toLowerCase())) return [problem("import-css", path, { specifier })];
    return [];
  };

  const checkCall = (path, call, argument, after) => {
    if (argument?.kind === "string" && after?.kind === "punct" && (after.value === ")" || after.value === ",")) {
      return checkSpecifier(path, argument.value);
    }
    return [problem("import-computed", path, { call })];
  };

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const results = [];
  for (const path of [...files.keys()].sort()) {
    if (!path.startsWith("src/") || !rules.sourceExtensions.includes(extname(path).toLowerCase())) continue;
    let text;
    try {
      text = decoder.decode(files.get(path));
    } catch {
      results.push(problem("import-not-utf8", path, {}));
      continue;
    }
    const list = tokens(text);
    const found = [];
    list.forEach((token, index) => {
      if (token.kind !== "name") return;
      const before = list[index - 1];
      const after = list[index + 1];
      if (before?.kind === "punct" && before.value === ".") return; // obj.import, obj.require, x.from
      if (token.value === "from" || token.value === "import") {
        if (after?.kind === "string") found.push(...checkSpecifier(path, after.value));
        else if (token.value === "import" && after?.value === "(") found.push(...checkCall(path, "import()", list[index + 2], list[index + 3]));
      } else if (token.value === "require" && after?.value === "(") {
        found.push(...checkCall(path, "require()", list[index + 2], list[index + 3]));
      }
    });
    const seen = new Set();
    for (const item of found) {
      if (seen.has(item.message)) continue;
      seen.add(item.message);
      results.push(item);
    }
  }
  return results;
}
