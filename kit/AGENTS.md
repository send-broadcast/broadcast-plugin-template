# Broadcast plugins: guide for agents and developers

This is the reference for writing a Broadcast plugin. The MCP tool `plugin_api_reference` returns
this file. Read it all before you write code.

## 1. What a plugin is

A plugin adds a feature to one self-hosted Broadcast server. It is JavaScript that runs in its own
sandboxed process. It can only do what its manifest declares and an admin approved. It reaches
Broadcast only through `ctx` (the Host API) and the internet only through declared hosts.

You can write and test a draft. **You cannot deploy.** An admin reviews the code change and the
permissions in Broadcast and deploys it, then turns it on per channel.

## 2. The workflow (MCP tools)

1. `plugin_draft_create` with `name` (a new plugin) or `from` (a new version of an installed plugin).
2. `plugin_draft_write_file` for `manifest.json` and `dist/main.js` (and optional `src/`, `ui/`,
   `assets/`, `README.md`).
3. `plugin_draft_validate` until `valid` is true.
4. `plugin_draft_test` to run a hook against test data. Read `plugin_logs`. Repeat.
5. `plugin_draft_request_deploy`. Tell the user that an admin must review and deploy it in
   Application > Plugins.

Test runs have no network: `fetch` answers only from the `fixtures` you pass. Subscribers are
generated (`person1@example.test` ...). Writes are simulated. Settings and secrets come only from
the `settings` and `secrets` you pass.

## 3. Files

```
manifest.json       required
dist/main.js        required: the code that runs, one ES module
src/...             optional: your sources, for reference
ui/...              optional: HTML, JS and CSS of plugin pages
assets/...          optional: images
README.md           optional
```

`dist/main.js` rules (the validator enforces them):

- One module with `export default definePlugin({ ... })`. `definePlugin` is a global.
- No `import` or `export ... from`, no `import()`, no `import.meta`. Inline every dependency.
- No `eval`, `new Function` or `Function()` (they also fail at run time).
- Readable code: no line longer than 2,000 characters (no minified code). The admin reviews it.
- TypeScript: compile to JavaScript first (`node path/to/plugin_kit/cli/broadcast-plugin.mjs build`; the kit is not on npm).

## 4. manifest.json

```json
{
  "id": "local.signup-alert",
  "name": "Signup alert",
  "version": "1.0.0",
  "requires": { "broadcast": ">=3.0.0 <4.0.0", "pluginApi": "1" },
  "permissions": {
    "subscribers": "read",
    "tags": "write",
    "network": ["hooks.slack.com", { "fromSetting": "webhook_url" }]
  },
  "hooks": {
    "events": ["subscriber.created"],
    "schedules": [{ "name": "daily", "cron": "0 9 * * *" }]
  },
  "settings": {
    "webhook_url": { "type": "url", "secret": true, "required": true },
    "channel": { "type": "string", "label": "Slack channel" }
  },
  "ui": { "pages": [{ "slot": "nav", "title": "Signups", "path": "ui/index.html" }] }
}
```

- `id`: `local.<name>` for your own plugins (lower case, digits, `-`). Only the plugin directory
  can sign other ids.
- `version`: semantic version. A deploy needs a version newer than the live one.
- `requires.pluginApi`: the plugin API major the code is written for (today `"1"`). An addition to
  the API keeps the major; a removal or a change of shape makes a new major. Broadcast serves the
  current major and the one before for at least 12 months after a new major ships. On the older
  one, `validate` gives a warning with the date Broadcast stops serving it; after that date the
  plugin stops until it moves to the current major.
- `settings` types: `string`, `text`, `url`, `integer`, `boolean`, `select` (with `options`).
  Mark keys, tokens and webhook URLs `"secret": true`.

### Icon and listing

Both are optional, and both go through review with the code.

```json
"icon": "assets/icon.png",
"listing": {
  "features": ["One short line per feature, up to 3"],
  "support": "help@example.com",
  "privacy": "https://example.com/privacy",
  "changelog": "What changed in this version, up to 2000 characters."
}
```

The icon is a PNG of exactly 512 x 512 pixels, 256 KB at most, in `assets/`. SVG is refused. Leave
square corners: Broadcast rounds them. Use no words and no copy of another brand. With no icon,
Broadcast shows the first letter on a colour tile. `support` is an email address or an `https`
address; `privacy` is an `https` address.

### Permissions

Ask for the least. Each permission is shown to the admin in plain language.

| Manifest | Allows | Level |
|---|---|---|
| (none) | its own settings, store, logs, events; the channel name | basic |
| `"subscribers": "read"` | `subscribers.get/find/list` (first 100) | standard |
| `"subscribers": "write"` | read, plus `update` and `bulkUpsert` of existing people | standard |
| `"subscribers": ["read", "export"]` | list beyond 100 and next pages | sensitive |
| `"subscribers": ["write", "create"]` | `bulkUpsert` may create people | sensitive |
| `"tags": "read"` / `"write"` | list tags / add and remove tags | standard |
| `"broadcasts": "read"`, `"sequences": "read"`, `"segments": "read"` | read those | standard |
| `"network": ["api.example.com"]` | exact hosts (port 443 unless given) | standard |
| `"network": ["*.example.com"]` | one level of subdomains | sensitive |
| `"network": [{ "fromSetting": "x" }]` | the host of the URL the admin enters in setting `x` (type `url`) | sensitive |
| `"output": "html"` | merge tags and filters may return HTML (it is sanitized) | sensitive |
| `"elevated": ["network.private"]` | one private host the admin enters | elevated, off until an admin turns it on |
| `"webhook": true` on an event in `events` | an admin can send the event to a webhook endpoint | sensitive |

Hooks `beforeSend`, `apiEndpoints` and `publicActions` are sensitive. Never possible: SQL, files, env, processes,
resubscribing people, removing suppressions, changing recipients or the unsubscribe link.

Network hosts must be public DNS names. IP addresses, `localhost`, `.local`, `.internal` and the
like are refused. Private and metadata addresses are refused by the proxy too.

## 5. Hooks

Event data: the core decides what `event.data` holds. With any `subscribers` permission you get the
whole webhook payload. Without one you get an allowlist per event family, for example
`subscriber_id`, `is_active`, `subscribed_at`, `unsubscribed_at`, `confirmed_at` on `subscriber.*`,
and ids and flags on `email.*`. To read the person, declare `"subscribers": "read"` and call
`subscribers.get`.

```js
export default definePlugin({
  // hooks.events: same names as webhooks (subscriber.created, email.opened, broadcast.sent, ...)
  async onEvent(event, ctx) {
    // event = { id, type, occurred_at, data }. Delivery is at least once: use event.id to skip repeats.
    // data is the webhook payload only with a subscribers permission. Without one it has ids, state and
    // counts, never email, names, custom_data, signup_ref or free text (see "Event data" above).
  },

  // Optional. Bulk work (an import, a bulk call, a broadcast send) delivers up to 100 events of one
  // type in one call. Without onEvents, each event of the batch goes to onEvent, in order, in the same
  // call. Any throw retries the whole batch, so skip repeats by event.id.
  async onEvents(events, ctx) {},

  // Lifecycle: declare each with true in hooks (hooks.onInstall: true, ...).
  // onInstall and onUpgrade are delivered at least once: make them safe to repeat.
  async onInstall({ version }, ctx) {},         // the first time the plugin is on in a channel
  async onUpgrade({ from_version, to_version, rollback }, ctx) {
    // After a deploy or a rollback, once per channel: migrate ctx.store rows here. Page through them:
    // for (let page = await ctx.store.list({ prefix: "poll:" }); page.length;
    //      page = await ctx.store.list({ prefix: "poll:", cursor: page.at(-1).key })) { ... }
  },
  async onUninstall({ version }, ctx) {},       // just before removal, with its data: clean up outside
                                                // Broadcast (a webhook you registered). Once, 5 s

  // hooks.schedules: { name, scheduled_for }
  async onSchedule(run, ctx) {},

  // hooks.apiEndpoints: [{ "name": "orders", "method": "POST", "permission": "subscribers_write" }]
  // Endpoints have fixed names, no path params: pass ids in the query or the body.
  // Called at POST /api/plugins/<id>/orders with an API token that has subscribers_write and allows
  // "<id>/orders". Return { status, body } or any JSON.
  apiEndpoints: {
    async orders(request, ctx) { return { status: 201, body: { ok: true } }; },
  },

  // hooks.publicActions: [{ "name": "vote" }]
  // A person clicks a link in an email: <a href="{{ plugins.acme_polls.actions.vote }}?value=yes">.
  // The core signs the link for each subscriber, so subscriber_id is proven. value is NOT signed:
  // check it, and make the action safe to repeat. title and message are shown as plain text.
  publicActions: {
    // subscribed is false for a person who unsubscribed; links never expire, so you decide
    async vote({ name, value, subscriber_id, subscribed }, ctx) { return { title: "Thanks", message: "Saved." }; },
  },

  // ui.pages: data for your page, asked through the bridge (op "pageData")
  async pageData(request, ctx) { return { rows: [] }; },

  // Remove personal data you keep outside ctx.store.forSubscriber
  async onSubscriberDeleted({ subscriber_id, email }, ctx) {},
});
```

More hooks: `sequenceSteps`, `aiTools`, `mergeTags` and `liquidFilters` are maps of named
functions (`fn(input, ctx)`; an entry may also be `{ run }`); `mergeTags` and `liquidFilters` may
also be one function. `beforeSend` is one function.

```js
  // hooks.sequenceSteps: [{ "name": "post_to_slack", "label": "Post to Slack",
  //                         "settings": { "text": { "type": "string" } } }]
  // The admin adds the step to a sequence and fills its settings. Return { continue: false } to end
  // the person's enrollment; throw to fail the step (it is retried).
  sequenceSteps: {
    async post_to_slack({ name, config, subscriber_id, subscriber_email, sequence_id, step_id }, ctx) {
      return { continue: true };
    },
  },

  // hooks.mergeTags: ["last_order"] or [{ "name": "last_order", "output": "html" }]
  // A personal link ({ "name": "referral_link", "tracked": false }) is not click tracked: a tracked
  // copy would make one redirect row per person.
  // Used in an email as {{ plugins.<id with . and - as _>.last_order }}. Called once per batch of up
  // to 100 people: return { "<subscriber id>": "value" }. Text is HTML-escaped; "output": "html"
  // (with the output permission) is sanitized. People get id and email; names and custom_data
  // only with subscribers permission.
  mergeTags: {
    async last_order({ name, subscribers }, ctx) { return { [subscribers[0].id]: "#42" }; },
  },

  // hooks.liquidFilters: ["money"]. Used as {{ value | <id with . and - as _>_money: "EUR" }}.
  // Called once per batch with the distinct inputs: return one output per item, in order.
  liquidFilters: {
    async money({ name, items }, ctx) { return items.map(({ input, args }) => `${input} ${args[0]}`); },
  },

  // hooks.beforeSend: true. Once per batch of a broadcast: return per subscriber id any of
  // { skip: true, subject, prepend_html, append_html }. Everything else is ignored: you cannot
  // change recipients, the sender or the unsubscribe link. HTML is sanitized.
  async beforeSend({ broadcast_id, subject, subscribers }, ctx) { return {}; },
```

Merge tags, filters and public action links work in broadcasts and sequence emails; `beforeSend`
runs for broadcasts. A public action link is `{{ plugins.<id with . and - as _>.actions.<name> }}`.
Opening it runs nothing, so mail scanners change nothing; the page then submits itself. A call has
5 seconds; a failure shows a generic message. It is limited to 5 calls a minute per link.
Send-time hooks have 5 seconds per call and fail open: an error or timeout means empty values
and no changes, and the email goes out.

Limits: a call has 10 seconds (send-time hooks much less). A plugin that fails 20 times in a row
is turned off and the admins are emailed. Keep no state between calls in memory: processes stop
when idle.

## 6. ctx

```js
ctx.settings.get("channel")                 // non-secret setting (sync)
await ctx.settings.secret("webhook_url")    // secret setting; fetched per call, never cached
await ctx.store.get(key) / set(key, value) / delete(key) / list(prefix | { prefix, cursor, limit })  // at most 100 rows after cursor, by key
await ctx.store.increment(key, by = 1)      // atomic counter, returns the new value; use it for counts
ctx.store.forSubscriber(id).get(key) ...    // data about one person: deleted with them (GDPR)
ctx.log.info("...") / warn / error          // shown on the plugin page; never log personal data
ctx.channel                                 // { id, name }

await ctx.broadcast.subscribers.get(id)
await ctx.broadcast.subscribers.find("ada@example.com")   // null when the email is not in the channel; get rejects with not_found
await ctx.broadcast.subscribers.list({ limit: 100, cursor, updated_since })  // { items, next_cursor }
await ctx.broadcast.subscribers.update({ id, first_name, last_name, custom_data })
await ctx.broadcast.subscribers.bulkUpsert({ items: [{ email, first_name, custom_data, tags }], idempotency_key })
await ctx.broadcast.tags.add({ subscriber_id, tags: ["vip"] }) / remove(...)
await ctx.broadcast.tags.bulkAdd({ subscriber_ids: [1, 2], tags: ["plan:pro"] }) / bulkRemove(...)
await ctx.broadcast.tags.list()
await ctx.broadcast.broadcasts.get(id) / list({}) ...   // also sequences, segments
await ctx.broadcast.events.record({ ... }) / bulkRecord({ items, idempotency_key })
```

Bulk calls take up to 1,000 items and return one result per item (a bad item fails alone).
A topic is consent, so no plugin can change one. A tag or custom field that holds a topic in the
channel is refused with `forbidden`: `tags.add` and `tags.remove` throw, the bulk calls return it per
item, and `subscribers.update` and `bulkUpsert` refuse the same way. Tags match without regard to
case. Catch the refusal if the rest of your work must go on.

An event with `"webhook": true` can go to the admin's webhook endpoints. The admin ticks
`plugin.<plugin id>.<event>` per endpoint; nothing is sent until then. The core builds the payload:
`event`, `plugin`, `subscriber_id`, `value`, `properties`, `occurred_at`. You cannot add fields, an
email is never sent, and a string property that holds an address is dropped. The limit is 1000
events a minute per plugin and channel. Over it the event is saved, no webhook goes out and your log
says so. A webhook is sent once per stored event, so use `idempotency_key` on retries.

`subscribers.bulkUpsert` and `events.bulkRecord` need an `idempotency_key`: a retry with the same key
returns the first answer and changes nothing twice. Tag changes are safe to repeat as they are.

`fetch(url, options)` works for declared hosts only (through Broadcast's egress proxy).

## 7. Plugin pages (ui/)

Build every page from Signal, the shared kit: it makes a plugin look like Broadcast, and it has 44
components (`/plugin-kit/v1/gallery.html` shows them all). Load it from the server, do not copy it:

```html
<link rel="stylesheet" href="/plugin-kit/v1/kit.css">
<script type="module" src="/plugin-kit/v1/kit.js"></script>
<script type="module" src="app.js"></script>
<sg-page title="Polls" description="One line about the page."><sg-card title="...">...</sg-card></sg-page>
```

`window.sg` has `pageData(input)`, `call(op, args)`, `toast(text)`, `confirm({ title, message })`,
`copy(text)`, `openExternal(url)` and `subscriberId()`. Use them in place of the bridge code below.

A page cannot open a new window. For a link out, use `<sg-link href="https://..." external>` or
`await sg.openExternal(url)` from a click: Broadcast shows the viewer the full address, and the answer
is `{ opened: true | false }`. Only plain `https` addresses work, with no user name or password, up to
2048 characters. Errors: `invalid_url`, `no_user_action` (no recent click inside the frame), `busy` (a
dialog is open, or one closed less than a second ago). A page cannot leave the plugin's own files: a
script that sets `location` to any other address is stopped.

A page runs in a sandboxed frame: no cookies, no localStorage, no direct `fetch`, no inline
scripts and no inline `<style>` (use files in `ui/`). The raw bridge, with `postMessage`:

```js
let next = 0;
const pending = {};
window.addEventListener("message", (e) => pending[e.data.id]?.(e.data));
function call(op, args) {
  return new Promise((resolve) => {
    const id = ++next;
    pending[id] = resolve;
    window.parent.postMessage({ id, op, args }, "*");
  });
}
const reply = await call("pageData", { page: 0, input: {} }); // or "store.get", "subscribers.list", ...
```

The page acts as the person viewing it: it gets only data that person may see.

Slots: `nav` is a full page in the sidebar; it fills the main area edge to edge, so the page
sets its own padding. `subscriberPanel` is a small frame on each
subscriber's page; it gets the subscriber in its URL fragment (`#subscriber_id=12`, read
`location.hash`). `dashboardWidget` is a small frame on the dashboard. Small frames are 16rem high.

## 8. Rules for every plugin

1. Declare everything in the manifest.
2. Ask for the least permission; exact hosts rather than wildcards.
3. Read only the personal data the feature needs; store it with `ctx.store.forSubscriber` or
   implement `onSubscriberDeleted`; never log it; send it only to the declared hosts.
4. Read secrets only with `ctx.settings.secret()`; never log or store them.
5. Handle events idempotently (event.id); use bulk calls for many items; no busy loops.
6. Changes to events, rules and settings are additive; a breaking change needs a new name.
