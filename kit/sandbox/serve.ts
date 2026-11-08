// `broadcast-plugin serve`: the sandbox screen at http://localhost:8080 for one plugin folder.
//
//   GET  /                     the screen (sandbox/ui)
//   GET  /plugin-ui/<path>     the plugin's ui/ and assets/ files, under Broadcast's sandbox rules
//   GET  /plugin-kit/v1/<file> Signal (kit.css, kit.js), a copy of Broadcast's
//   GET  /api/state            what the screen shows; GET /api/stream sends "ops" and "state" events
//   POST /api/bridge           a plugin page's call ({ op, args }), as the viewer
//   POST /api/events | /api/settings | /api/people/<id>/<action> | /api/reset
//
// It listens on 127.0.0.1 only. A POST needs the x-sandbox header, which a page on another site
// cannot send without a CORS preflight that this server never answers.
import { type Args, type Json } from "../testing/mod.ts";
import { openSandbox, type Sandbox } from "./sandbox.ts";
import { formValue } from "./settings.ts";

// PluginUiController::SANDBOX_CSP
export const SANDBOX_CSP = "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'self'; style-src 'self'; webrtc 'block'; " +
  "img-src 'self' data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'";
const TYPES: Record<string, string> = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain",
};
const UI = new URL("./ui/", import.meta.url);
const SIGNAL = new URL("./signal/", import.meta.url);
const SCREEN_FILES: Record<string, string> = { "/app.js": "text/javascript", "/app.css": "text/css" };
const SIGNAL_FILES: Record<string, string> = { "kit.css": "text/css", "kit.js": "text/javascript" };

export type ServeOptions = { dir: string; port?: number; hostname?: string };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// The Host header must name this machine and this port
export function localHost(header: string | null, port: number): boolean {
  const host = String(header ?? "").toLowerCase();
  return ["localhost", "127.0.0.1", "[::1]"].some((name) => host === `${name}:${port}`);
}

function extension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function screenState(sandbox: Sandbox): Args {
  const declared = sandbox.plugin.manifest.settings ?? {};
  const settings = Object.fromEntries(Object.entries(declared).map(([key, setting]) => {
    // The form starts with the manifest default when nothing is saved, as Broadcast's form does
    const value = formValue(setting as Args, sandbox.world.settings[key]);
    return [key, (setting as Args)?.secret === true ? { secret: true, set: value != null && value !== "" } : { secret: false, value: value ?? null }];
  }));
  return {
    plugin: sandbox.plugin,
    version: sandbox.versionLabel,
    permissions: sandbox.host.grant.permissions,
    channel: sandbox.world.channel,
    people: sandbox.world.people.map((p) => ({ ...sandbox.host.serialize(p), erased: p.erased === true })),
    store: sandbox.host.store.entries(),
    events: sandbox.world.events.slice(-200),
    logs: sandbox.world.logs.slice(-300),
    settings,
    ops: sandbox.ops.slice(-300),
    drafts: sandbox.world.drafts,
    inbox: sandbox.world.inbox.slice(-200),
    now: new Date(sandbox.now()).toISOString(),
    clockOffsetMs: sandbox.world.clockOffsetMs ?? 0,
    schedules: sandbox.schedules(),
    // What "send again" can repeat, without the payloads
    sent: sandbox.world.sent.map(({ id, type, at, batch, events }) => ({ id, type, at, batch, count: events.length, subscriber_ids: events.map((e) => e.data.subscriber_id) })),
  };
}

export async function startServe(options: ServeOptions) {
  let sandbox = await openSandbox(options.dir);
  const root = sandbox.dir;
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const broadcast = (kind: string, payload: Json) => {
    const chunk = encoder.encode(`event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
    for (const stream of streams) {
      try {
        stream.enqueue(chunk);
      } catch {
        streams.delete(stream);
      }
    }
  };
  let unsubscribe = sandbox.subscribe(broadcast);

  async function pluginFile(path: string, req: Request): Promise<Response> {
    const notFound = () => new Response("not found", { status: 404 });
    if (!/^(ui|assets)\//.test(path) || /[\\\0]/.test(path)) return notFound();
    if (path.split("/").some((part) => part === ".." || part === "" || part.startsWith("."))) return notFound();
    const html = extension(path) === ".html" && path.startsWith("ui/");
    // Plugin HTML runs only in the screen's sandboxed frame (PluginUiController#whole_page?)
    const dest = req.headers.get("sec-fetch-dest");
    if (html && dest && dest !== "iframe") return notFound();
    let body: Uint8Array;
    try {
      // A symlink must not lead out of ui/ or assets/ (to ~/.ssh, or to manifest.json)
      const real = await Deno.realPath(`${root}/${path}`);
      const folder = await Deno.realPath(`${root}/${path.split("/")[0]}`);
      if (!real.startsWith(`${folder}/`)) return notFound();
      body = await Deno.readFile(real);
    } catch {
      return notFound();
    }
    const type = html ? "text/html" : TYPES[extension(path)] ?? "application/octet-stream";
    const headers: Record<string, string> = { "content-type": type, "content-security-policy": SANDBOX_CSP, "x-content-type-options": "nosniff", "cache-control": "no-store" };
    if (type === "text/javascript") headers["access-control-allow-origin"] = "*";
    if (type === "application/octet-stream") headers["content-disposition"] = "attachment";
    return new Response(body as Uint8Array<ArrayBuffer>, { headers });
  }

  // The public side of a public action link (PluginPublicActionsController): GET shows a page that
  // submits itself, POST runs the plugin. The answer is plain text in the sandbox's page.
  function actionHtml(title: string, inner: string, status: number): Response {
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${escapeHtml(title)}</title><style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;background:#f5f7fa;color:#141a24}` +
      `main{background:#fff;border-radius:10px;padding:32px;max-width:420px;text-align:center;box-shadow:0 1px 3px #0002}h1{font-size:20px;margin:0 0 12px}` +
      `button{font:inherit;font-weight:600;padding:8px 16px;border:0;border-radius:6px;background:#1d5fd6;color:#fff}</style></head>` +
      `<body><main><h1>${escapeHtml(title)}</h1>${inner}</main></body></html>`;
    return new Response(page, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
  }

  async function actionLink(req: Request, token: string, url: URL): Promise<Response> {
    if (req.method === "GET") {
      const page = await sandbox.actionPage(token);
      if (page.status !== 200) return new Response("not found", { status: 404 });
      const value = url.searchParams.has("value") ? `<input type="hidden" name="value" value="${escapeHtml(url.searchParams.get("value") ?? "")}">` : "";
      return actionHtml(page.title, `<form id="action" method="post" action="/plugin-action/${escapeHtml(token)}">${value}<button type="submit">Continue</button></form>` +
        `<script>document.getElementById("action").submit();</script>`, 200);
    }
    let value: string | null = null;
    const type = req.headers.get("content-type") ?? "";
    if (type.startsWith("application/x-www-form-urlencoded")) {
      const form = new URLSearchParams(await req.text());
      value = form.has("value") ? form.get("value") : null;
    } else {
      await req.body?.cancel();
    }
    const answer = await sandbox.publicAction(token, value);
    if (answer.status === 404 || answer.status === 422) return new Response(answer.status === 404 ? "not found" : "invalid", { status: answer.status });
    return actionHtml(answer.title, answer.message ? `<p>${escapeHtml(answer.message)}</p>` : "", answer.status);
  }

  async function screen(): Promise<Response> {
    const page = (await Deno.readTextFile(new URL("index.html", UI))).replaceAll("{{plugin_name}}", escapeHtml(sandbox.plugin.name));
    return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
  }

  async function api(path: string, body: Args): Promise<Response> {
    if (path === "/api/bridge") return json(await sandbox.bridge(String(body.op ?? ""), body.args ?? {}));
    // broadcast-plugin serve watches the folder: after a build it asks for a reload; a ui/ change
    // only refreshes the screen; a failed build shows on the screen
    if (path === "/api/reload") {
      const result = await sandbox.reload();
      if (!result.ok) broadcast("build-error", { message: result.message });
      return json(result);
    }
    if (path === "/api/refresh") {
      broadcast("refresh", null);
      return json({ ok: true });
    }
    if (path === "/api/build-error") {
      broadcast("build-error", { message: String(body.message ?? "The build failed.").slice(0, 4000) });
      return json({ ok: true });
    }
    if (path === "/api/drafts") return json(await sandbox.saveDraft(body));
    if (path === "/api/preview") return json(await sandbox.preview(Number(body.draft_id), Number(body.subscriber_id)));
    if (path === "/api/send") return json(await sandbox.send(Number(body.draft_id)));
    if (path === "/api/events") return json(await sandbox.fireEvent(String(body.type ?? ""), Number(body.subscriber_id)));
    if (path === "/api/events/batch") {
      const ids = Array.isArray(body.subscriber_ids)
        ? body.subscriber_ids.map(Number)
        : sandbox.host.people().slice(0, Math.max(0, Number(body.count) || 0)).map((p) => p.id);
      return json(await sandbox.fireEvents(String(body.type ?? ""), ids));
    }
    if (path === "/api/events/repeat") return json(await sandbox.repeatEvent(String(body.id ?? "")));
    // The Clock: { advance_ms }, { set: "<ISO time>" } or { reset: true }
    if (path === "/api/clock") {
      if (body.reset === true) return json(await sandbox.resetClock());
      if (typeof body.set === "string") {
        const at = Date.parse(body.set);
        if (Number.isNaN(at)) return json({ ok: false, error: { code: "invalid", message: "set is not a time." } }, 422);
        return json(await sandbox.setClock(at));
      }
      const ms = Number(body.advance_ms);
      if (!Number.isFinite(ms) || ms <= 0) return json({ ok: false, error: { code: "invalid", message: "advance_ms must be more than 0." } }, 422);
      return json(await sandbox.advanceClock(ms));
    }
    if (path === "/api/schedules/run") return json(await sandbox.runSchedule(String(body.name ?? "")));
    if (path === "/api/lifecycle") {
      return json(await sandbox.lifecycle(String(body.hook ?? ""), { from_version: body.from_version ? String(body.from_version) : undefined, rollback: body.rollback === true }));
    }
    if (path === "/api/settings") {
      const declared = sandbox.plugin.manifest.settings ?? {};
      for (const [key, raw] of Object.entries(body)) {
        const setting = declared[key];
        if (!setting) return json({ ok: false, error: { code: "invalid", message: `The plugin declares no setting ${key}.` } }, 422);
        // An empty secret field keeps the secret, as Broadcast's settings form does
        if (setting.secret === true && (raw === "" || raw == null)) continue;
        sandbox.world.settings[key] = setting.type === "integer" ? (raw === "" ? null : Number(raw)) : setting.type === "boolean" ? raw === true || raw === "true" : raw;
      }
      await sandbox.save();
      return json({ ok: true });
    }
    if (path === "/api/people") {
      const added = await sandbox.addPerson(body);
      return json(added, added.ok ? 200 : 422);
    }
    const person = path.match(/^\/api\/people\/(\d+)\/(unsubscribe|resubscribe|erase)$/);
    if (person) {
      const id = Number(person[1]);
      if (person[2] === "erase") return json(await sandbox.erase(id));
      const p = sandbox.person(id);
      if (!p) return json({ ok: false, error: { code: "not_found" } }, 404);
      const active = person[2] === "resubscribe";
      p.is_active = active;
      p.unsubscribed_at = active ? null : new Date(sandbox.now()).toISOString();
      p.updated_at = new Date(sandbox.now()).toISOString();
      await sandbox.save();
      const type = active ? "subscriber.resubscribed" : "subscriber.unsubscribed";
      const declared: string[] = sandbox.plugin.manifest.hooks?.events ?? [];
      return json(declared.includes(type) ? await sandbox.fireEvent(type, id) : { ok: true, result: null });
    }
    if (path === "/api/reset") {
      unsubscribe();
      await sandbox.close();
      await Deno.remove(`${root}/.sandbox/state.json`).catch(() => {});
      sandbox = await openSandbox(root);
      sandbox.baseUrl = `http://localhost:${listening}`;
      unsubscribe = sandbox.subscribe(broadcast);
      broadcast("state", null);
      return json({ ok: true });
    }
    return json({ ok: false, error: { code: "not_found" } }, 404);
  }

  let listening = -1;
  const server = Deno.serve({ port: options.port ?? 8080, hostname: options.hostname ?? "127.0.0.1", onListen: () => {} }, async (req) => {
    // DNS rebinding: a page on another name that resolves to 127.0.0.1 would be same-origin to the screen
    if (!localHost(req.headers.get("host"), listening)) return new Response("This sandbox answers only to localhost.", { status: 403 });
    const url = new URL(req.url);
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const action = path.match(/^\/plugin-action\/([^/]+)$/);
    if (action && (req.method === "GET" || req.method === "POST")) return await actionLink(req, action[1], url);
    if (req.method === "POST") {
      if (req.headers.get("x-sandbox") !== "1") return json({ ok: false, error: { code: "forbidden", message: "Missing x-sandbox header." } }, 403);
      let body: Args = {};
      try {
        const text = await req.text();
        body = text ? JSON.parse(text) : {};
      } catch {
        return json({ ok: false, error: { code: "invalid", message: "The body is not JSON." } }, 400);
      }
      try {
        return await api(path, body ?? {});
      } catch (err) {
        return json({ ok: false, error: { code: "sandbox_error", message: (err as Error).message } }, 500);
      }
    }
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    if (path === "/" || path === "/index.html") return await screen();
    if (SCREEN_FILES[path]) {
      return new Response(await Deno.readFile(new URL(path.slice(1), UI)), { headers: { "content-type": SCREEN_FILES[path], "cache-control": "no-store" } });
    }
    if (path.startsWith("/plugin-ui/")) return await pluginFile(path.slice("/plugin-ui/".length), req);
    const kit = path.match(/^\/plugin-kit\/v1\/([^/]+)$/);
    if (kit && SIGNAL_FILES[kit[1]]) {
      return new Response(await Deno.readFile(new URL(kit[1], SIGNAL)), {
        headers: { "content-type": SIGNAL_FILES[kit[1]], "access-control-allow-origin": "*", "x-content-type-options": "nosniff" },
      });
    }
    if (path === "/api/state") return json(screenState(sandbox));
    if (path === "/api/stream") {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          streams.add(c);
          c.enqueue(encoder.encode(": connected\n\n"));
        },
        cancel() {
          streams.delete(controller);
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  });

  listening = server.addr.port;
  sandbox.baseUrl = `http://localhost:${listening}`;
  // Schedules run while serve runs, as Broadcast's tick does every minute
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await sandbox.tick();
    } catch (err) {
      console.error(`tick    ${(err as Error).message}`);
    } finally {
      ticking = false;
    }
  };
  await tick();
  const ticker = setInterval(tick, 15_000);
  Deno.unrefTimer(ticker);
  return {
    port: server.addr.port,
    get sandbox() {
      return sandbox;
    },
    async shutdown() {
      clearInterval(ticker);
      for (const stream of streams) {
        try {
          stream.close();
        } catch { /* gone */ }
      }
      streams.clear();
      await sandbox.close();
      await server.shutdown();
    },
  };
}

if (import.meta.main) {
  const input = JSON.parse(Deno.args[0] ?? "{}");
  const server = await startServe({ dir: String(input.dir ?? "."), port: Number(input.port ?? 8080) });
  const s = server.sandbox;
  console.log(`load    ${s.plugin.id} ${s.plugin.version} · plugin API ${s.plugin.manifest.requires?.pluginApi ?? "?"}`);
  console.log(`perms   ${s.host.grant.permissions.join(", ") || "(basic only)"}`);
  console.log(`world   channel "${s.world.channel.name}" · ${s.host.people().length} people · data in .sandbox/`);
  console.log(`\n  Sandbox ready at http://localhost:${server.port}\n  Press Ctrl+C to stop.`);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    Deno.addSignalListener(sig, () => server.shutdown().then(() => Deno.exit(0)));
  }
}
