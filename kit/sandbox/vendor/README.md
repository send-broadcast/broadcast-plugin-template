# Vendored files

| File | Source | sha256 |
|---|---|---|
| liquid.mjs | npm liquidjs@10.29.0, dist/liquid.browser.mjs (MIT, liquid.LICENSE) | a9a0755dc452ce59be886ca7a4bb1859ef410825e10079e32d80256ba4753cc8 |
| parse5.mjs | npm parse5@7.3.0 (MIT, parse5.LICENSE) with entities@6.0.1 (BSD-2-Clause, entities.LICENSE), bundled from an entry file with `export { parse, parseFragment, serialize } from "npm:parse5@7.3.0";` by `deno bundle --platform browser --minify --lock=parse5.lock --frozen -o parse5.mjs entry.ts` (parse5.lock pins parse5 7.3.0 and entities 6.0.1 with their integrity hashes) | e3e7429d5e49933c0ec700d91c6768c726b10249b5123080307a25a0f342dd4d |

Vendored so `broadcast-plugin serve` needs no npm install and works offline. To update liquid.mjs: npm pack liquidjs@<version>, copy dist/liquid.browser.mjs. To update parse5.mjs: run the deno bundle command above. Then update this table.
