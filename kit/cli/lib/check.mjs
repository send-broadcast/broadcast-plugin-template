// A local copy of the server's dist/main.js rules (lib/plugins/check_bundle.ts on the server).
// It has no parser, so it is stricter: it refuses the words themselves, even inside strings and
// comments. A bundle it accepts can still fail on the server: the server check is authoritative.

const MAX_LINE_LENGTH = 2000;

const RULES = [
  [/\bimport\b/, "uses `import` (an import statement, import(), import.meta, or the word in a string or comment). Bundle every dependency into dist/main.js."],
  [/\bexport\s*\*/, "re-exports another module (export * from). Bundle every dependency."],
  [/\bexport\s*\{[^}]*\}\s*from\b/, "re-exports another module (export { } from). Bundle every dependency."],
  [/\bfrom\s*["'`]/, "looks like it loads another module (from \"...\"). Bundle every dependency."],
  [/\beval\b/, "uses eval. This is not allowed."],
  [/\bFunction\b/, "uses Function (new Function() or Function()). This is not allowed."],
];

// e or \u{65} that spells an ASCII letter or digit can hide `eval` in an identifier.
const LETTER_ESCAPE = /\\u(?:\{0*([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/g;

// Returns a list of problems (empty when the bundle passes this check).
export function checkBundle(code) {
  const problems = [];
  const lines = code.split("\n");
  lines.forEach((line, index) => {
    const at = `line ${index + 1}`;
    for (const [pattern, message] of RULES) {
      if (pattern.test(line)) problems.push(`${at}: ${message}`);
    }
    for (const match of line.matchAll(LETTER_ESCAPE)) {
      const char = String.fromCodePoint(parseInt(match[1] ?? match[2], 16));
      if (/[A-Za-z0-9_$]/.test(char)) {
        problems.push(`${at}: a \\u escape spells "${char}". Write the character itself.`);
        break;
      }
    }
    if (line.length > MAX_LINE_LENGTH) {
      problems.push(`${at}: longer than ${MAX_LINE_LENGTH} characters. Minified code is not allowed.`);
    }
  });
  // export default definePlugin(...), or the export { x as default } that esbuild --format=esm writes
  const esbuildDefault = /^\s*export\s*\{[^}]*\bas\s+default\b[^}]*\}\s*;?\s*$/m;
  if (!/^\s*export\s+default\s+definePlugin\s*\(/m.test(code) && !esbuildDefault.test(code)) {
    problems.push("no `export default definePlugin({...})` at the start of a line.");
  }
  return problems;
}
