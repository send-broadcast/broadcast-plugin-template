# My plugin

A Broadcast plugin (`local.my-plugin`), from the `event-listener` template.

```sh
node kit/cli/broadcast-plugin.mjs build      # src/main.js -> dist/main.js
node kit/cli/broadcast-plugin.mjs check      # repo layout and manifest (the plugin store's rules)
deno task test                               # test/ in the kit's plugin runtime, no server
node kit/cli/broadcast-plugin.mjs push       # upload the draft (BROADCAST_URL, BROADCAST_TOKEN)
node kit/cli/broadcast-plugin.mjs validate
node kit/cli/broadcast-plugin.mjs submit     # an admin reviews and deploys it
```

See AGENTS.md for the layout and the rules, and kit/AGENTS.md for the plugin API.
