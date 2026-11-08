# Broadcast plugin kit

Tools to write, build, pack and test Broadcast plugins. The API reference is
[AGENTS.md](AGENTS.md); read it first.

## Install

Node 22 or newer. No dependencies.

```sh
npm install --global @send-broadcast/plugin-kit
broadcast-plugin help
```

Or run it once with `npx @send-broadcast/plugin-kit help`. Your Broadcast server also serves a copy
of this folder at `/plugin-kit/broadcast-plugin-kit.zip`, the same version as the server; run it with
`node path/to/kit/cli/broadcast-plugin.mjs`.

In a plugin repo with a `kit/` folder (`init` makes one), the global `broadcast-plugin` runs that
pinned kit for `build`, `test`, `dev`, `serve` and `pack`, so the repo builds and tests with the kit
it was made with. It says so when the two versions differ. `check`, `audit` and the other commands
always use the global kit: they never run code from a repo you are only looking at. Set
`BROADCAST_PLUGIN_PINNED=1` to use the global kit for every command.

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
| `serve [--port 8080]` | The sandbox: your plugin in a Broadcast-like screen at http://localhost:8080, with no server (needs Deno 2). See [The sandbox](#the-sandbox) |
| `logs [--limit 50]` | Log lines of the draft's test runs |
| `submit` | Ask for deploy; an admin reviews and deploys it |
| `check` | The repo layout and manifest, with the plugin store's structure rules. In a git repo, files git would not commit are left out |
| `dev [--once]` | Build and run the tests now and on each change; `--once` runs one time |
| `fixtures record <url> [--header 'name: value']` | Make the real request and keep the response as a test fixture (request headers are never written) |
| `audit [--json]` | What a reviewer sees (permissions, hosts, hooks, secret settings, pages) and the problems |
| `release <patch\|minor\|major\|x.y.z> [--notes <text>]` | Set the version and changelog, commit manifest.json, tag `v<version>` |
| `doctor` | Check node, deno, esbuild, the repo, the kit, the server and the store login |
| `login` / `logout` | Keep or remove the publisher token for the plugin store (read from stdin) |
| `publish [--summary <text>] [--category <slug>]` | check, build, pack, and send the package to the plugin store for review |
| `status` | The store's review state of each version |

`push`, `validate`, `test` (without `--local`), `logs` and `submit` use `BROADCAST_URL` (your server) and
`BROADCAST_TOKEN` (a plugin developer token). `login`, `publish` and `status` use the plugin store
(`BROADCAST_STORE_URL`, default https://sendbroadcast.net) and the publisher token
(`BROADCAST_PUBLISHER_TOKEN`, or the one `login` keeps). Every command takes `--dir <plugin folder>`.

The local bundle check is stricter than the server's (it refuses the words `import`, `eval` and
`Function` anywhere, even in strings), and the server check is authoritative.

## Contents

- `cli/`: the CLI. `types/`: TypeScript types for `definePlugin`, `ctx` and `manifest.json`.
- `templates/`: what `init` copies (`_repo/` for every plugin, then the template's own files). `examples/`: four working plugins made with the kit.
- `testing/`: test your plugin in code, with no server. `runtime/`: the Broadcast plugin runtime it
  runs your plugin in.

## The sandbox

`serve` builds the plugin and runs it in the real plugin runtime against a fake Broadcast: one
channel with 25 test people. Open http://localhost:8080 (it answers only to localhost).

- The plugin's pages, with the same frame rules and bridge as in Broadcast.
- Compose and Inbox: write an email, preview it for one person, send it to everyone. Merge tags,
  filters, `beforeSend` and public action links work. The emails go to the Inbox; nothing leaves
  your computer. Click a link in an email to act as that person.
- People and Events: unsubscribe, erase, or send an event to `onEvent`. Send a batch to `onEvents`,
  or send an event again with the same id, as a retry does.
- Time: move the clock. Schedules run at each due time the clock passes, and the plugin's
  `Date.now()` follows the clock. Buttons run `onInstall`, `onUpgrade` and `onUninstall`.
- Ops, Store, Logs and Settings: every call the plugin made, its rows, its log lines, its settings.
- Hot reload: a change in `src/` or `manifest.json` builds and reloads the plugin and keeps the
  data. A reload lists new and removed permissions; on a server, new ones wait for an admin.

The data stays in `.sandbox/` in the plugin folder. It is never part of the repo: `.gitignore`
lists it, and the plugin store refuses a repo that has it. `fetch` answers only from
`.sandbox/fixtures.json`, as in a test run. Reset sandbox data (Settings) starts again.

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
