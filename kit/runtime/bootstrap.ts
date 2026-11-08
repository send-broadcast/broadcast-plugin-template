// Runs inside each plugin process (V3-IMPLEMENTATION.md section 5). The supervisor starts it as
//   deno run --no-prompt --no-config --no-lock --cached-only --v8-flags=... [--allow-net=...]
//     --allow-env=PLUGIN_PROXY_URL,PLUGIN_PROXY_ROLE,PLUGIN_PROXY_TOKEN,PLUGIN_REQUEST_LOG_KEY
//     --allow-write=/proc/self/oom_score_adj bootstrap.ts
// and talks to it with newline-delimited JSON on stdin/stdout.
//
// Hook dispatch (`call` message -> plugin function):
//   hook "sequenceStep" -> plugin.sequenceSteps[args[0].name]
//   hook "aiTool"       -> plugin.aiTools[args[0].name]
//   hook "apiEndpoint"  -> plugin.apiEndpoints[args[0].name]
//   hook "publicAction" -> plugin.publicActions[args[0].name]
//   hook "mergeTags"    -> plugin.mergeTags[args[0].name]      (or plugin.mergeTags itself if a function)
//   hook "liquidFilter" -> plugin.liquidFilters[args[0].name]  (or plugin.liquidFilters itself if a function)
//   hook "onEvents"     -> plugin.onEvents(events), or plugin.onEvent once per event (resolveOnEvents)
//   any other hook      -> plugin[hook]
// A map entry is a function or an object with a `run` function. It is called as fn(...args, ctx).
// Missing -> error code `no_hook`; a throw -> `plugin_error`.
//
// Test runs (section 10): the load message carries `fixtures`, the process has no net permission,
// and fetch answers from the fixtures (same method; URL equal, or a prefix when it ends with "*").
// In the kit's sandbox it may also carry `now`: the plugin's clock starts there (setClock).

import { AsyncLocalStorage } from "node:async_hooks";

type Json = unknown;
type Msg = Record<string, any>;
type LogEntry = { level: "info" | "warn" | "error"; message: string; at: string };

// 1. Read the proxy credential and the request log key, then remove env access before any plugin
// code exists.
const PROXY_URL = Deno.env.get("PLUGIN_PROXY_URL") ?? "";
const PROXY_ROLE = Deno.env.get("PLUGIN_PROXY_ROLE") ?? "";
const PROXY_TOKEN = Deno.env.get("PLUGIN_PROXY_TOKEN") ?? "";
const REQUEST_LOG_KEY = Deno.env.get("PLUGIN_REQUEST_LOG_KEY") ?? "";
for (const name of ["PLUGIN_PROXY_URL", "PLUGIN_PROXY_ROLE", "PLUGIN_PROXY_TOKEN", "PLUGIN_REQUEST_LOG_KEY"]) Deno.env.delete(name);
Deno.permissions.revokeSync({ name: "env" });

// 2. The kernel OOM killer must pick a plugin, never the supervisor. Then drop the write grant.
try {
  Deno.writeTextFileSync("/proc/self/oom_score_adj", "1000");
} catch { /* not Linux, or not writable */ }
Deno.permissions.revokeSync({ name: "write" });

// 3. Every fetch leaves through the egress proxy with this process's own credential (F3). A
// plugin's own `client` is replaced. Workers would get an unwrapped fetch, so there are none.
// Test runs swap baseFetch for the fixtures (load). The global fetch also logs each request to the
// call that made it (recordFetch).
const realFetch = globalThis.fetch;
let baseFetch: typeof fetch = realFetch;
if (PROXY_URL) {
  const client = Deno.createHttpClient({
    proxy: { url: PROXY_URL, basicAuth: { username: PROXY_ROLE, password: PROXY_TOKEN } },
  });
  baseFetch = (input: RequestInfo | URL, init?: RequestInit) => realFetch(input, { ...(init ?? {}), client } as RequestInit);
}
Object.defineProperty(globalThis, "fetch", {
  value: (input: RequestInfo | URL, init?: RequestInit) => recordFetch(input, init),
  writable: false,
  configurable: false,
});
Object.defineProperty(globalThis, "Worker", { value: undefined, writable: false, configurable: false });

// 4. stdout is the protocol channel: keep a private writer and send console output to stderr.
const encoder = new TextEncoder();
const stdoutWrite = Deno.stdout.writeSync.bind(Deno.stdout);
const stderrWrite = Deno.stderr.writeSync.bind(Deno.stderr);

function writeAll(write: (b: Uint8Array) => number, bytes: Uint8Array) {
  let off = 0;
  while (off < bytes.length) off += write(bytes.subarray(off));
}

function send(msg: Msg) {
  writeAll(stdoutWrite, encoder.encode(JSON.stringify(msg) + "\n"));
}

// A request log line goes out on its own with the key, so the supervisor can tell it from a line
// plugin code writes to stdout itself. Plugin code shares this process and can replace built-ins
// (JSON.stringify, TextEncoder, Uint8Array and Array methods, toJSON): the key is joined into the
// line with + only, and the line is encoded and written with functions kept from before plugin code
// loads, so no replaced built-in ever sees it.
// deno-lint-ignore no-explicit-any
const callOf = (fn: (...a: any[]) => unknown) => Function.prototype.call.bind(fn) as (self: unknown, ...a: unknown[]) => unknown;
const jsonString = JSON.stringify;
const encodeText = callOf(TextEncoder.prototype.encode);
const byteLength = callOf(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "length")!.get!);
const bufferOf = callOf(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "buffer")!.get!);
const byteOffsetOf = callOf(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteOffset")!.get!);
const Bytes = Uint8Array;

function sendRequestLine(id: number, level: LogEntry["level"], message: string) {
  const line = '{"t":"request_log","id":' + jsonString(id) + ',"key":' + jsonString(REQUEST_LOG_KEY) +
    ',"level":' + jsonString(level) + ',"message":' + jsonString(message) + "}\n";
  const bytes = encodeText(encoder, line) as Uint8Array;
  const total = byteLength(bytes) as number;
  let off = 0;
  while (off < total) {
    off += stdoutWrite(off === 0 ? bytes : new Bytes(bufferOf(bytes) as ArrayBuffer, (byteOffsetOf(bytes) as number) + off, total - off));
  }
}

function format(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : Deno.inspect(a, { depth: 4 }))).join(" ");
}

for (const name of ["log", "info", "debug", "warn", "error", "trace", "dir", "table"] as const) {
  (console as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
    try {
      writeAll(stderrWrite, encoder.encode(format(args) + "\n"));
    } catch { /* stderr closed */ }
  };
}

// A stray rejection or timer error in plugin code must not end the process.
globalThis.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  console.error("unhandled rejection:", e.reason);
});
globalThis.addEventListener("error", (e) => {
  e.preventDefault();
  console.error("uncaught error:", e.error ?? e.message);
});

// 5. Plugin loading.
(globalThis as Record<string, unknown>).definePlugin = (plugin: unknown) => plugin;
let plugin: Record<string, any> | null = null;

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

type Fixture = { method: string; url: string; status: number; headers: Record<string, string>; body: string };

// Request is used only to read method and URL the way fetch would; `client` and the rest of init
// are ignored, so a plugin cannot reach the network around the fixtures.
function fixtureFetch(fixtures: Fixture[]) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const req = new Request(input, init);
      const method = req.method.toUpperCase();
      const fixture = fixtures.find((f) =>
        f.method.toUpperCase() === method &&
        (f.url.endsWith("*") ? req.url.startsWith(f.url.slice(0, -1)) : req.url === new URL(f.url).href)
      );
      if (!fixture) return Promise.reject(new TypeError(`No fixture for ${method} ${req.url}`));
      const empty = [101, 103, 204, 205, 304].includes(fixture.status);
      return Promise.resolve(
        new Response(empty ? null : fixture.body, { status: fixture.status, headers: fixture.headers }),
      );
    } catch (err) {
      return Promise.reject(err instanceof TypeError ? err : new TypeError(errorMessage(err)));
    }
  };
}

// The sandbox's clock for a test run: Date and Temporal.Now start at nowMs and run on from there.
// Set before the plugin's code loads; the globals are locked and the real Date is not reachable, so
// the plugin cannot put the clock back. Dates made from a value, Date.parse and Date.UTC are unchanged.
function setClock(nowMs: number) {
  const Real = Date;
  const realNow = Real.now.bind(Real);
  const offset = nowMs - realNow();
  const now = () => realNow() + offset;
  const lock = (target: object, key: string, value: unknown) =>
    Object.defineProperty(target, key, { value, writable: false, enumerable: false, configurable: false });
  // A function, not a subclass: Object.getPrototypeOf(Date) must not lead to the real Date
  const Clock = function (this: unknown, ...args: unknown[]) {
    if (!new.target) return new Real(now()).toString();
    return Reflect.construct(Real, args.length ? args : [now()], new.target);
  } as unknown as DateConstructor;
  lock(Clock, "now", now);
  lock(Clock, "parse", Real.parse);
  lock(Clock, "UTC", Real.UTC);
  Object.defineProperty(Clock, "prototype", { value: Real.prototype, writable: false });
  Object.defineProperty(Clock, "name", { value: "Date" });
  Object.defineProperty(Clock, "length", { value: 7 });
  lock(Real.prototype, "constructor", Clock);
  lock(globalThis, "Date", Clock);

  type Zoned = { toPlainDateTime(): unknown; toPlainDate(): unknown; toPlainTime(): unknown };
  type TemporalApi = { Now?: { timeZoneId(): string }; Instant: { fromEpochMilliseconds(ms: number): { toZonedDateTimeISO(zone: string): Zoned } } };
  const temporal = (globalThis as { Temporal?: TemporalApi }).Temporal;
  if (temporal?.Now) {
    const real = temporal.Now;
    const Instant = temporal.Instant;
    const instant = () => Instant.fromEpochMilliseconds(now());
    const zoned = (zone?: string) => instant().toZonedDateTimeISO(zone ?? real.timeZoneId());
    lock(temporal, "Now", Object.freeze({
      instant,
      timeZoneId: () => real.timeZoneId(),
      zonedDateTimeISO: zoned,
      plainDateTimeISO: (zone?: string) => zoned(zone).toPlainDateTime(),
      plainDateISO: (zone?: string) => zoned(zone).toPlainDate(),
      plainTimeISO: (zone?: string) => zoned(zone).toPlainTime(),
    }));
  }
}

async function load(code: string, fixtures: unknown, nowMs?: unknown) {
  try {
    if (Array.isArray(fixtures)) baseFetch = fixtureFetch(fixtures);
    if (Array.isArray(fixtures) && typeof nowMs === "number" && Number.isFinite(nowMs)) setClock(nowMs);
    const mod = await import("data:application/javascript;base64," + base64(encoder.encode(code)));
    if (!mod.default || typeof mod.default !== "object") throw new Error("the bundle must export default definePlugin({...})");
    plugin = mod.default;
    send({ t: "loaded" });
  } catch (err) {
    send({ t: "load_error", message: errorMessage(err) });
  }
}

// 6. Calls and the ctx object.
const MAP_HOOKS: Record<string, string> = {
  sequenceStep: "sequenceSteps",
  aiTool: "aiTools",
  apiEndpoint: "apiEndpoints",
  publicAction: "publicActions",
  mergeTags: "mergeTags",
  liquidFilter: "liquidFilters",
};

class HostError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

const liveCalls = new Set<number>();

// The request log (shown with the call's log lines): which call is running is kept across awaits,
// so concurrent calls of one plugin each get their own requests.
const MAX_REQUEST_LINES = 50;
const currentCall = new AsyncLocalStorage<number>();
const requestLogs = new Map<number, { lines: number; more: number }>();

function noteRequest(level: LogEntry["level"], message: string) {
  const id = currentCall.getStore();
  const entry = id === undefined ? undefined : requestLogs.get(id);
  if (!entry) return;
  if (entry.lines >= MAX_REQUEST_LINES) {
    entry.more++;
    return;
  }
  entry.lines++;
  try {
    sendRequestLine(id!, level, message);
  } catch { /* stdout closed */ }
}

// Method and URL without reading the body (a stream body must stay unread); no query, it can hold a token
function requestLabel(input: RequestInfo | URL, init?: RequestInit): string {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    return `fetch ${method} ${url.origin}${url.pathname}`;
  } catch {
    return "fetch";
  }
}

async function recordFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const label = requestLabel(input, init);
  const started = performance.now();
  const took = () => `(${Math.round(performance.now() - started)} ms)`;
  try {
    const res = await baseFetch(input, init);
    noteRequest(res.status >= 400 ? "warn" : "info", `${label}: ${res.status} ${took()}`);
    return res;
  } catch (err) {
    noteRequest("warn", `${label}: failed (${errorMessage(err).slice(0, 300)}) ${took()}`);
    throw err;
  }
}

function endRequestLog(id: number) {
  const entry = requestLogs.get(id);
  requestLogs.delete(id);
  if (entry?.more) {
    try {
      sendRequestLine(id, "info", `fetch: ${entry.more} more requests not logged`);
    } catch { /* stdout closed */ }
  }
}
const pendingHost = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
let nextRid = 0;

// The plugin's own frames as main.js:line:column; the bundle's data: URL and the runtime's frames go
const MAX_FRAMES = 20;
function errorStack(err: unknown): string | undefined {
  if (!(err instanceof Error) || typeof err.stack !== "string") return undefined;
  const [head, ...frames] = err.stack.split("\n");
  const own = frames
    .map((line) => line.replace(/data:application\/javascript;base64,[A-Za-z0-9+/=.]+/g, "main.js"))
    .filter((line) => line.includes("main.js"))
    .slice(0, MAX_FRAMES);
  return [head, ...own].join("\n").slice(0, 4000);
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 4000);
}

function resolveHook(hook: string, args: unknown[]): ((...a: unknown[]) => unknown) | null {
  if (!plugin) return null;
  const mapName = MAP_HOOKS[hook];
  let entry: any;
  if (mapName) {
    const map = plugin[mapName];
    if (typeof map === "function") return map.bind(plugin);
    const name = (args[0] as { name?: unknown } | undefined)?.name;
    if (!map || typeof map !== "object" || typeof name !== "string" || !Object.hasOwn(map, name)) return null;
    entry = map[name];
  } else {
    if (!Object.hasOwn(plugin, hook)) return null;
    entry = plugin[hook];
  }
  if (typeof entry === "function") return entry;
  if (entry && typeof entry.run === "function") return entry.run.bind(entry);
  return null;
}

// Batched onEvent (V3-EXTENSIONS.md 8.3): the plugin's own onEvents(events, ctx), or else one
// onEvent(event, ctx) per event, in order. Every event runs; any failure fails the whole call, so
// the job retries the batch and the plugin skips repeats by event id (delivery is at least once).
function resolveOnEvents(): ((events: unknown, ctx: unknown) => unknown) | null {
  const own = resolveHook("onEvents", []);
  const single = own ? null : resolveHook("onEvent", []);
  if (!own && !single) return null;
  return async (events, ctx) => {
    if (!Array.isArray(events)) throw new Error("onEvents takes an array of events");
    if (own) return await own(events, ctx);
    const results: unknown[] = [];
    const failed: { id: unknown; message: string }[] = [];
    for (const event of events) {
      try {
        results.push(await single!(event, ctx));
      } catch (err) {
        failed.push({ id: (event as { id?: unknown } | null)?.id, message: errorMessage(err) });
      }
    }
    if (failed.length) {
      throw new Error(`${failed.length} of ${events.length} events failed. First error (${failed[0].id}): ${failed[0].message}`);
    }
    return results.map((r) => (r === undefined ? null : r));
  };
}

function makeCtx(callId: number, settings: Record<string, Json>, channel: Json, logs: LogEntry[]) {
  const host = (op: string, args: Record<string, Json> = {}): Promise<any> => {
    if (!liveCalls.has(callId)) return Promise.reject(new HostError("call_ended", "this call has ended"));
    const rid = ++nextRid;
    return new Promise((resolve, reject) => {
      pendingHost.set(rid, { resolve, reject });
      send({ t: "host", id: callId, rid, op, args });
    });
  };
  // Object arguments pass through as the op's args; a bare value is the obvious key.
  const op = (name: string, key?: string) => (arg: unknown = {}) =>
    host(name, key && (typeof arg !== "object" || arg === null) ? { [key]: arg } : arg as Record<string, Json>);
  const facade = (prefix: string, names: string[]) =>
    Object.freeze(Object.fromEntries(names.map((n) => [n, op(`${prefix}.${n}`)])));
  const store = (extra: Record<string, Json>) =>
    Object.freeze({
      get: (key: string) => host("store.get", { key, ...extra }),
      set: (key: string, value: Json) => host("store.set", { key, value, ...extra }),
      delete: (key: string) => host("store.delete", { key, ...extra }),
      increment: (key: string, by = 1) => host("store.increment", { key, by, ...extra }),
      // A prefix, or { prefix, cursor, limit }: page on with the last key as the cursor
      list: (arg?: string | { prefix?: string; cursor?: string; limit?: number }) => {
        const page = typeof arg === "object" && arg !== null ? arg : { prefix: arg };
        const args: Record<string, Json> = {};
        if (page.prefix !== undefined) args.prefix = page.prefix;
        if (page.cursor !== undefined) args.cursor = page.cursor;
        if (page.limit !== undefined) args.limit = page.limit;
        return host("store.list", { ...args, ...extra });
      },
    });
  const log = (level: LogEntry["level"]) => (...args: unknown[]) => {
    try {
      if (logs.length < 200) logs.push({ level, message: format(args).slice(0, 4000), at: new Date().toISOString() });
    } catch { /* never throw from a log call */ }
  };
  const frozenSettings = Object.freeze({ ...settings });

  return Object.freeze({
    channel: channel ?? null,
    settings: Object.freeze({
      get: (name: string) => (Object.hasOwn(frozenSettings, name) ? frozenSettings[name] : undefined),
      // Fetched per call and never cached (F14).
      secret: (name: string) => host("settings.secret", { name }),
    }),
    store: Object.freeze({ ...store({}), forSubscriber: (id: Json) => store({ subscriber_id: id }) }),
    log: Object.freeze({ info: log("info"), warn: log("warn"), error: log("error") }),
    broadcast: Object.freeze({
      subscribers: Object.freeze({
        get: op("subscribers.get", "id"),
        find: op("subscribers.find", "email"),
        list: op("subscribers.list"),
        update: op("subscribers.update"),
        bulkUpsert: op("subscribers.bulkUpsert"),
      }),
      tags: facade("tags", ["list", "add", "remove", "bulkAdd", "bulkRemove"]),
      events: facade("events", ["record", "bulkRecord"]),
      broadcasts: Object.freeze({ get: op("broadcasts.get", "id"), list: op("broadcasts.list") }),
      sequences: Object.freeze({ get: op("sequences.get", "id"), list: op("sequences.list") }),
      segments: Object.freeze({ get: op("segments.get", "id"), list: op("segments.list") }),
    }),
  });
}

async function runCall(msg: Msg) {
  const id = msg.id as number;
  const args = Array.isArray(msg.args) ? msg.args : [];
  const logs: LogEntry[] = [];
  liveCalls.add(id);
  requestLogs.set(id, { lines: 0, more: 0 });
  try {
    const fn = msg.hook === "onEvents" ? resolveOnEvents() : resolveHook(String(msg.hook), args);
    if (!fn) {
      endRequestLog(id);
      send({ t: "result", id, ok: false, error: { code: "no_hook", message: `no hook ${msg.hook}` }, logs });
      return;
    }
    const ctx = makeCtx(id, msg.settings ?? {}, msg.channel, logs);
    const result = await currentCall.run(id, () => fn(...args, ctx));
    endRequestLog(id);
    let line: string;
    try {
      line = JSON.stringify({ t: "result", id, ok: true, result: result === undefined ? null : result, logs });
    } catch (err) {
      throw new Error(`the result is not JSON: ${errorMessage(err)}`);
    }
    writeAll(stdoutWrite, encoder.encode(line + "\n"));
  } catch (err) {
    endRequestLog(id);
    send({ t: "result", id, ok: false, error: { code: "plugin_error", message: errorMessage(err), stack: errorStack(err) }, logs });
  } finally {
    liveCalls.delete(id);
    requestLogs.delete(id);
  }
}

function handle(msg: Msg) {
  if (msg.t === "load") return load(String(msg.code ?? ""), msg.fixtures, msg.now);
  if (msg.t === "call") return runCall(msg);
  if (msg.t === "host_result") {
    const p = pendingHost.get(msg.rid);
    if (!p) return;
    pendingHost.delete(msg.rid);
    if (msg.ok) p.resolve(msg.result ?? null);
    else p.reject(new HostError(String(msg.error?.code ?? "host_error"), String(msg.error?.message ?? "host error")));
  }
}

// 7. Read stdin until the supervisor closes it.
let buffer = "";
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch (err) {
      console.error("bad message from supervisor:", errorMessage(err));
    }
  }
}
Deno.exit(0);
