// How Broadcast cleans HTML a plugin returns (Plugins::SendHooks#sanitize): elements whose text must
// never show go whole, then EmailBlockRenderer::HtmlSanitizer.raw keeps only allowed tags and
// attributes (Rails SafeListSanitizer, Loofah rules for links and style). The lists come from
// spec/plugin-api-1.json sanitize; spec/plugin-api-1-vectors.json sanitize holds Broadcast's output
// for sample HTML, and test/sanitize_test.ts checks this file against it.
//
// Parsing is HTML5 (parse5, like Nokogiri's HTML5 parser) in a <body> context; the output is
// re-serialized from the tree, never pieced together from the input.
// deno-lint-ignore-file no-explicit-any
import { parse, parseFragment, serialize } from "./vendor/parse5.mjs";
import SPEC from "../spec/plugin-api-1.json" with { type: "json" };

const S = SPEC.sanitize;
const HTML_NS = "http://www.w3.org/1999/xhtml";
const DROPPED = new Set<string>(S.droppedElements);
const TAGS = new Set<string>(S.tags);
const ATTRIBUTES = new Set<string>(S.attributes);
const URI_ATTRIBUTES = new Set<string>(S.uriAttributes);
const PROTOCOLS = new Set<string>(S.allowedProtocols);
const DATA_TYPES = new Set<string>(S.allowedDataMediatypes);
const CSS_PROPERTIES = new Set<string>(S.css.properties);
const SVG_PROPERTIES = new Set<string>(S.css.svgProperties);
const SHORTHAND = new Set<string>(S.css.shorthandProperties);
const KEYWORDS = new Set<string>(S.css.keywords);
const FUNCTIONS = new Set<string>(S.css.functions);
const BROKEN_ESCAPING = new Set<string>(S.brokenEscaping.attributes);
const QUALIFYING_TAG = S.brokenEscaping.qualifyingTag as Record<string, string>;

// Ruby regex source to JavaScript: \A and \z anchors
const rubyRegex = (source: string, flags = "") => new RegExp(source.replaceAll("\\A", "^").replaceAll("\\z", "$"), flags);
const KEYWORDISH = rubyRegex(S.css.keywordish);
// LIQUID_TOKEN is /m in Ruby: the dot matches a newline
const LIQUID_TOKEN = rubyRegex(S.liquidToken, "gs");

// Loofah::HTML5::Scrub
const CONTROL_CHARACTERS = /[`\u0000- \u007f\u0080-\u0101]/g;
const PROTOCOL_SEPARATOR = /:|(&#0*58)|(&#x0*3a)|(%|&#37;)3A/i;
const URI_PROTOCOL = new RegExp(`^[a-z][a-z0-9+\\-.]*(${PROTOCOL_SEPARATOR.source})`, "i");
const NUMERIC_REFERENCE = /&#(x[0-9a-f]+|[0-9]+);?/gi;
const DATA_MEDIATYPE = /^[a-z0-9!#$%&'*+\-.^_`|~]+\/[a-z0-9!#$%&'*+\-.^_`|~]+$/;
const STRING_WITHOUT_EMBEDDED_QUOTES = /^(["'])?[^"']+\1$/;

let bodyElement: any = null;
function body(): any {
  if (!bodyElement) {
    const html = parse("<!doctype html><html><head></head><body></body></html>").childNodes.find((n: any) => n.nodeName === "html");
    bodyElement = html.childNodes.find((n: any) => n.nodeName === "body");
  }
  return bodyElement;
}

const fragment = (html: string) => parseFragment(body(), html);
const isElement = (node: any) => typeof node.tagName === "string";
const children = (node: any): any[] => (node.nodeName === "template" ? node.content.childNodes : node.childNodes) ?? [];

function remove(node: any, keepChildren: boolean) {
  const parent = node.parentNode;
  const list = parent.childNodes as any[];
  const at = list.indexOf(node);
  const moved = keepChildren ? children(node) : [];
  for (const child of moved) child.parentNode = parent;
  list.splice(at, 1, ...moved);
}

export function sanitize(html: string): string {
  // SendHooks#sanitize: drop these elements with their content, then raw()
  const first = fragment(html);
  const drop = (node: any) => {
    for (const child of [...children(node)]) {
      if (isElement(child) && DROPPED.has(child.tagName)) remove(child, false);
      else drop(child);
    }
  };
  drop(first);
  return raw(serialize(first));
}

// EmailBlockRenderer::HtmlSanitizer.raw
export function raw(html: string): string {
  if (!html || !html.trim()) return "";
  const tokens: string[] = [];
  const safe = html.replace(LIQUID_TOKEN, (token) => {
    tokens.push(token);
    return `LIQUIDTOKEN${tokens.length - 1}X`;
  });
  const tree = fragment(safe);
  for (const child of [...children(tree)]) scrub(child);
  const out = serialize(tree).trim();
  return out.replace(/LIQUIDTOKEN(\d+)X/g, (_, i) => tokens[Number(i)]);
}

// Rails::HTML::PermitScrubber, bottom up: children first, then the node
function scrub(node: any) {
  for (const child of [...children(node)]) scrub(child);
  if (node.nodeName === "#text") return;
  if (isElement(node) && node.namespaceURI === HTML_NS && TAGS.has(node.tagName)) {
    scrubAttributes(node);
    return;
  }
  // A tag in svg or math is removed with what it holds (no namespace confusion); others keep their content
  remove(node, isElement(node) && node.namespaceURI === HTML_NS);
}

function scrubAttributes(node: any) {
  const attrs: any[] = node.attrs;
  for (const attr of [...attrs]) {
    const drop = () => attrs.splice(attrs.indexOf(attr), 1);
    if (!ATTRIBUTES.has(attr.name)) {
      drop();
      continue;
    }
    const name = attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name;
    if (URI_ATTRIBUTES.has(name) && !allowedUri(attr.value)) {
      drop();
      continue;
    }
    if (name === "src" && !/[^\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/.test(attr.value)) drop();
  }
  // Loofah's libxml2 workaround: spaces and quotes in these attributes are percent-escaped
  for (const attr of attrs) {
    if (!BROKEN_ESCAPING.has(attr.name)) continue;
    const tag = QUALIFYING_TAG[attr.name];
    if (tag && tag !== node.tagName) continue;
    attr.value = attr.value.replace(/[ "]/g, (m: string) => (m === " " ? "%20" : "%22"));
  }
  const style = attrs.find((a) => a.name === "style");
  if (style) style.value = scrubCss(style.value);
}

function decodeNumericReferences(text: string): string {
  return text.replace(NUMERIC_REFERENCE, (reference, digits: string) => {
    const hex = /^x/i.test(digits);
    const significant = (hex ? digits.slice(1) : digits).replace(/^0+/, "");
    if (significant.length > (hex ? 6 : 7)) return reference;
    const code = parseInt(significant || "0", hex ? 16 : 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return reference;
    }
  });
}

// CGI.unescapeHTML
function unescapeHtml(text: string): string {
  return text.replace(/&(amp|quot|gt|lt|apos|#39|#x27);/gi, (m, name: string) =>
    ({ amp: "&", quot: '"', gt: ">", lt: "<", apos: "'", "#39": "'", "#x27": "'" } as Record<string, string>)[name.toLowerCase()] ?? m
  );
}

// Loofah::HTML5::Scrub.allowed_uri?
export function allowedUri(value: string): boolean {
  let uri = unescapeHtml(decodeNumericReferences(value));
  uri = uri.replace(CONTROL_CHARACTERS, "").replace(/&(Tab|NewLine);/g, "").replace(/&colon;|&sol;/g, (m) => (m === "&colon;" ? ":" : "/"));
  uri = uri.toLowerCase();
  if (!URI_PROTOCOL.test(uri)) return true;
  const protocol = uri.split(PROTOCOL_SEPARATOR)[0];
  if (!PROTOCOLS.has(protocol)) return false;
  if (protocol === "data") return DATA_TYPES.has(dataMediatype(uri) ?? "");
  return true;
}

function dataMediatype(uri: string): string | null {
  const rest = uri.startsWith("data:") ? uri.slice(5) : uri;
  const comma = rest.indexOf(",");
  if (comma < 0) return null;
  const metadata = rest.slice(0, comma);
  const mediatype = (metadata.endsWith(";base64") ? metadata.slice(0, -7) : metadata).split(";", 1)[0].trim();
  return DATA_MEDIATYPE.test(mediatype) ? mediatype : "text/plain";
}

// --- CSS: a small Crass, enough for Loofah's scrub_css ---

type Token = { node: string; raw: string; value?: string; name?: string };

function tokenize(css: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const identStart = (c: string) => /[A-Za-z_\u0080-\uffff]/.test(c);
  const identChar = (c: string) => /[A-Za-z0-9_\-\u0080-\uffff]/.test(c);
  const readName = () => {
    const start = i;
    while (i < css.length && (identChar(css[i]) || (css[i] === "\\" && i + 1 < css.length))) i += css[i] === "\\" ? 2 : 1;
    return css.slice(start, i);
  };
  while (i < css.length) {
    const c = css[i];
    const start = i;
    if (/\s/.test(c)) {
      while (i < css.length && /\s/.test(css[i])) i++;
      out.push({ node: "whitespace", raw: css.slice(start, i) });
    } else if (c === '"' || c === "'") {
      i++;
      let bad = false;
      while (i < css.length && css[i] !== c) {
        if (css[i] === "\n") {
          bad = true;
          break;
        }
        i += css[i] === "\\" ? 2 : 1;
      }
      if (!bad) i++;
      out.push({ node: bad ? "bad_string" : "string", raw: css.slice(start, i) });
    } else if (c === "#" && i + 1 < css.length && identChar(css[i + 1])) {
      i++;
      readName();
      out.push({ node: "hash", raw: css.slice(start, i) });
    } else if (/[0-9]/.test(c) || ((c === "." || c === "+" || c === "-") && /[0-9]/.test(css[i + 1] === "." ? css[i + 2] ?? "" : css[i + 1] ?? ""))) {
      i++;
      while (i < css.length && /[0-9.]/.test(css[i])) i++;
      if (/[eE]/.test(css[i] ?? "") && /[0-9+-]/.test(css[i + 1] ?? "")) {
        i += 2;
        while (i < css.length && /[0-9]/.test(css[i])) i++;
      }
      if (css[i] === "%") i++;
      else if (identStart(css[i] ?? "") || css[i] === "-") readName();
      out.push({ node: "number", raw: css.slice(start, i) });
    } else if (identStart(c) || (c === "-" && (identStart(css[i + 1] ?? "") || css[i + 1] === "-"))) {
      const name = readName();
      if (css[i] === "(") {
        if (name.toLowerCase() === "url") {
          let j = i + 1;
          while (j < css.length && /\s/.test(css[j])) j++;
          if (css[j] !== '"' && css[j] !== "'") {
            const close = css.indexOf(")", j);
            i = close < 0 ? css.length : close + 1;
            out.push({ node: close < 0 ? "bad_url" : "url", raw: css.slice(start, i) });
            continue;
          }
        }
        let depth = 0;
        while (i < css.length) {
          if (css[i] === "(") depth++;
          else if (css[i] === ")" && --depth === 0) {
            i++;
            break;
          } else if (css[i] === '"' || css[i] === "'") {
            const q = css[i++];
            while (i < css.length && css[i] !== q) i += css[i] === "\\" ? 2 : 1;
          }
          i++;
        }
        out.push({ node: "function", raw: css.slice(start, i), name });
      } else {
        out.push({ node: "ident", raw: name, value: name });
      }
    } else {
      i++;
      out.push({ node: c === ";" ? "semicolon" : c === ":" ? "colon" : "delim", raw: c });
    }
  }
  return out;
}

type Property = { name: string; children: Token[]; important: boolean };

function parseProperties(css: string): Property[] {
  const tokens = tokenize(css);
  const props: Property[] = [];
  let current: Token[] = [];
  const finish = () => {
    let parts = current;
    current = [];
    while (parts.length && parts[0].node === "whitespace") parts = parts.slice(1);
    if (!parts.length || parts[0].node !== "ident") return;
    let k = 1;
    while (k < parts.length && parts[k].node === "whitespace") k++;
    if (parts[k]?.node !== "colon") return;
    let value = parts.slice(k + 1);
    let important = false;
    const meaningful = value.map((t, idx) => [t, idx] as const).filter(([t]) => t.node !== "whitespace");
    const last = meaningful.at(-1);
    const bang = meaningful.at(-2);
    if (last && bang && last[0].node === "ident" && last[0].raw.toLowerCase() === "important" && bang[0].raw === "!") {
      important = true;
      value = value.slice(0, bang[1]);
    }
    props.push({ name: parts[0].raw, children: value, important });
  };
  for (const token of tokens) {
    if (token.node === "semicolon") finish();
    else current.push(token);
  }
  finish();
  return props;
}

const stringify = (p: Property) => `${p.name}:${p.children.map((t) => t.raw).join("")}${p.important ? "!important" : ""}`;

function unsafe(p: Property): boolean {
  return p.children.some((t) =>
    ["url", "bad_url", "bad_string"].includes(t.node) ||
    (t.node === "string" && !STRING_WITHOUT_EMBEDDED_QUOTES.test(t.raw)) ||
    (t.node === "function" && !FUNCTIONS.has(String(t.name).toLowerCase()))
  );
}

// Loofah::HTML5::Scrub.scrub_css
export function scrubCss(style: string): string {
  let out = "";
  for (const prop of parseProperties(style)) {
    if (prop.children.some((t) => ["url", "bad_url", "bad_string"].includes(t.node))) continue;
    const name = prop.name.toLowerCase();
    const shorthand = SHORTHAND.has(name.split("-")[0]);
    if (!CSS_PROPERTIES.has(name) && !SVG_PROPERTIES.has(name) && !shorthand) continue;
    let value = prop.children.map((t) => {
      switch (t.node) {
        case "whitespace":
          return " ";
        case "string":
          return STRING_WITHOUT_EMBEDDED_QUOTES.test(t.raw) ? t.raw : "";
        case "function":
          return FUNCTIONS.has(String(t.name).toLowerCase()) ? t.raw : "";
        case "ident":
          return !shorthand || KEYWORDS.has(t.value!) || KEYWORDISH.test(t.value!) ? t.raw : "";
        default:
          return t.raw;
      }
    }).join("").trim();
    if (!value) continue;
    if (prop.important) value += " !important";
    const propstring = `${name}:${value}`;
    const again = parseProperties(propstring)[0];
    // Crass: the property must read back exactly as written
    if (!again || stringify(again) !== propstring) continue;
    if (unsafe(again)) continue;
    out += `${propstring};`;
  }
  return out;
}
