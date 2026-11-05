// Runs dist/main.js in the plugin runtime of the pinned kit (kit/), against a fake Broadcast.
// Build first: node kit/cli/broadcast-plugin.mjs build
import { assertEquals } from "./assert.ts";
import { startTestRuntime } from "../kit/testing/mod.ts";

const root = decodeURIComponent(new URL("..", import.meta.url).pathname);

Deno.test("onEvent handles an event once, and skips it when it comes again", async () => {
  await using kit = await startTestRuntime();
  const plugin = await kit.load(root);
  const event = { id: "evt_1", type: "subscriber.created", data: { subscriber_id: 1 } };

  assertEquals(await plugin.call("onEvent", [event]), { ok: true });
  assertEquals(await plugin.call("onEvent", [event]), { skipped: true });
  assertEquals(kit.host.store.get("seen:evt_1"), true);
});
