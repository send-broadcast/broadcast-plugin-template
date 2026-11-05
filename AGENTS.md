# My plugin: guide for coding agents

This repo is a Broadcast plugin (`local.my-plugin`). Read `kit/AGENTS.md` before you write code: it is the
full reference for the plugin API, the manifest and the permissions. The types are in
`kit/types/index.d.ts`.

## Layout

```
manifest.json       id, version, the Broadcast versions it supports, permissions, hooks, settings
src/main.js         the plugin code (or src/main.ts); imports stay inside src/
ui/, assets/        optional: plugin pages and images
test/               tests that run dist/main.js in the kit's plugin runtime, with no server
kit/                a pinned copy of the plugin kit (CLI, runtime, test harness, types); do not edit
README.md, LICENSE  shown on the plugin's store page
```

`dist/` is built, never committed. The plugin store builds it again from `src/`.

## Commands

Run them from the repo root. They need Node 22 and Deno 2.

```sh
node kit/cli/broadcast-plugin.mjs build   # src/ -> dist/main.js, then the server's bundle check
node kit/cli/broadcast-plugin.mjs check   # repo layout and manifest, the plugin store's rules
deno task test                            # test/ against dist/main.js (build first)
node kit/cli/broadcast-plugin.mjs pack    # <id>-<version>.broadcast-plugin
```

`build` uses esbuild when it is on PATH: install the version in `kit/spec/plugin-repo.json`
(`build.esbuild`). Without esbuild, `build` copies a `src/main.js` that has no imports.

With a Broadcast server (env `BROADCAST_URL`, `BROADCAST_TOKEN`): `push`, `test`, `logs`,
`validate`, `submit`. You cannot deploy: an admin reviews and deploys the plugin.

## Rules

- Before you finish: `build`, `check` (no errors, no warnings) and `deno task test` pass.
- Each hook has a test in `test/`. The fake host answers only the ops you add with
  `kit.host.handle(...)`, and fetch answers only from the fixtures you pass.
- Never commit `dist/`, packages, `.env` files or keys. Secrets come from `ctx.settings.secret()`.
- Never write personal data (emails, names) to the log.
- Events can come more than once: make each handler safe to run again.
- A new permission or host in `manifest.json` needs an admin's approval again: add only what the
  plugin uses.

## The kit

`kit/` pins the kit this plugin is tested with, and `kit/KIT_SOURCE` says where it came from. To
update it, download `/plugin-kit/broadcast-plugin-kit.zip` from your Broadcast server and replace
`kit/` with the zip's `broadcast-plugin-kit/` folder.
