// `broadcast-plugin test --local` runs this with one JSON argument:
//   { dir, hook, args, settings?, secrets?, fixtures? }
// It prints the runtime's reply plus host_calls (the ops the plugin used) as JSON, and exits 1 when
// the hook failed.
import { startTestRuntime } from "./mod.ts";

const input = JSON.parse(Deno.args[0] ?? "{}");
const kit = await startTestRuntime();
let ok = false;
try {
  const plugin = await kit.load(String(input.dir));
  const reply = await plugin.invoke(String(input.hook ?? "onEvent"), Array.isArray(input.args) ? input.args : [], {
    settings: input.settings,
    secrets: input.secrets,
    fixtures: input.fixtures,
  });
  ok = reply.ok;
  console.log(JSON.stringify({ ...reply, host_calls: kit.host.calls }, null, 2));
} finally {
  await kit.close();
}
Deno.exit(ok ? 0 : 1);
