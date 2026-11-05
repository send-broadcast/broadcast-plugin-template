# Plugin API types

`index.d.ts` types `definePlugin` (a global), every hook and its input, `ctx` exactly as the
runtime provides it (`plugin_runtime/bootstrap.ts`), and `manifest.json` (`Manifest`).

In a TypeScript plugin, add at the top of `src/main.ts`:

```ts
/// <reference path="../node_modules/broadcast-plugin/types/index.d.ts" />
```

(or a relative path to this file), then build with `broadcast-plugin build` (needs esbuild). Do not
import anything from this package in your code: `dist/main.js` may not import.

A refused host call rejects with an error whose `code` is `forbidden`, `not_found`, `invalid`,
`rate_limited`, `call_ended` or `host_error`.
