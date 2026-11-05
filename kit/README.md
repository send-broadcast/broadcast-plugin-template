# Broadcast plugin kit

Tools to write, build, pack and test Broadcast plugins. The API reference is
[AGENTS.md](AGENTS.md); read it first.

## Install

Node 22 or newer. No dependencies. Copy this folder, then run the CLI from it:

```sh
node path/to/plugin_kit/cli/broadcast-plugin.mjs help
```

The kit is not on npm: `npx broadcast-plugin` does not work. Your Broadcast server serves a copy of
this folder at `/plugin-kit/broadcast-plugin-kit.zip`, the same version as the server.

For TypeScript or a plugin with imports, put [esbuild](https://esbuild.github.io) on your PATH;
`build` uses it when it finds it.

## Commands

| Command | Does |
|---|---|
| `init <name> [--template event-listener\|scheduled-sync\|settings-page\|api-endpoint]` | A new plugin repo, id `local.<name>`, that passes `check`: code, a test, README, LICENSE, AGENTS.md, CLAUDE.md, .gitignore, CI and `kit/` |
| `build` | `src/main.ts\|js` to `dist/main.js`, then a local copy of the server's bundle rules |
| `pack` | `<id>-<version>.broadcast-plugin`, to upload in Application > Plugins |
| `push` | Create or reuse the draft for the plugin's id on your server and upload its files |
| `validate` | The server's checks on the draft |
| `test --hook onEvent --args a.json --fixtures f.json --settings s.json --secrets x.json` | Run a hook on test data; `fetch` answers only from fixtures |
| `test --local --hook onEvent --args a.json ...` | The same in the kit's own runtime, with no server (needs [Deno](https://deno.com) 2 on PATH); prints the reply and the ops the plugin used |
| `logs [--limit 50]` | Log lines of the draft's test runs |
| `submit` | Ask for deploy; an admin reviews and deploys it |

`push`, `validate`, `test` (without `--local`), `logs` and `submit` use `BROADCAST_URL` (your server) and
`BROADCAST_TOKEN` (a plugin developer token). Every command takes `--dir <plugin folder>`.

The local bundle check is stricter than the server's (it refuses the words `import`, `eval` and
`Function` anywhere, even in strings), and the server check is authoritative.

## Contents

- `cli/`: the CLI. `types/`: TypeScript types for `definePlugin`, `ctx` and `manifest.json`.
- `templates/`: what `init` copies (`_repo/` for every plugin, then the template's own files). `examples/`: four working plugins made with the kit.
- `testing/`: test your plugin in code, with no server. `runtime/`: the Broadcast plugin runtime it
  runs your plugin in.

## Testing without a server

`testing/mod.ts` runs hooks in the real plugin runtime against a fake Broadcast (Deno 2):

```ts
import { assertEquals } from "jsr:@std/assert";
import { startTestRuntime } from "./broadcast-plugin-kit/testing/mod.ts";

Deno.test("counts signups", async () => {
  await using kit = await startTestRuntime();
  const plugin = await kit.load(".");                     // manifest.json + dist/main.js
  const event = { id: "evt_1", type: "subscriber.created", occurred_at: null, data: { subscriber_id: 7 } };
  await plugin.call("onEvent", [event], { settings: {}, secrets: { api_key: "test" }, fixtures: [] });
  assertEquals(kit.host.store.get("signups"), 1);
});
```

- The store, `events.record`, `events.bulkRecord` and logs are faked with the real rules. A secret
  comes from the call's `secrets`.
- `fetch` answers only from `fixtures` (`{ method, url, status, headers, body }`; a URL that ends
  with `*` is a prefix). There is no network.
- Any other op (`subscribers.get`, `tags.add`, ...) fails until the test says what Broadcast
  answers: `kit.host.handle("tags.add", (args) => ({ ok: true }))`. Throw `OpError(code, message)`
  for an error answer.
- `kit.host.calls` lists every op the plugin used. `plugin.invoke` returns the whole reply (`ok`,
  `result` or `error`, `logs`); `plugin.call` returns the result or throws `HookError`.
- Permissions are not checked here. Run `validate` on your server: its check is authoritative.

Run with `deno test --allow-net=127.0.0.1 --allow-read --allow-run --allow-env`.

## Tests

```sh
cd plugin_kit
node --test test/*.test.mjs   # CLI, bundle check, zip, MCP client (Node 22 needs the glob)
deno task test                # each example in the real plugin runtime
deno task check               # the types
```
