// Offline test harness for Broadcast plugins: runs hooks in the real plugin runtime (../runtime, a
// copy of Broadcast's) against a fake Host API. No Broadcast server and no network: every call is a
// test run, so fetch answers only from the fixtures you give it.
//
//   import { startTestRuntime } from "<kit>/testing/mod.ts";
//   const kit = await startTestRuntime();
//   const plugin = await kit.load("./my-plugin");          // manifest.json + dist/main.js
//   await plugin.call("onEvent", [event], { settings, secrets, fixtures });
//   kit.host.store.get("key"); kit.host.calls;              // what the plugin did
//   kit.host.handle("tags.add", (args) => ({ ok: true }));  // ops the fake does not have
//   await kit.close();
//
// The fake host has the store, events, log and secret ops. Every other op (subscribers, tags,
// broadcasts, ...) is refused until you add it with kit.host.handle: decide in each test what
// Broadcast answers. Permissions are not checked here; the server check is authoritative.
import { startSupervisor } from "../runtime/supervisor.ts";

export type Json = unknown;
export type Args = Record<string, any>;
export type Fixture = { method?: string; url: string; status?: number; headers?: Record<string, string>; body?: string };
export type CallOptions = { settings?: Record<string, Json>; secrets?: Record<string, string>; fixtures?: Fixture[]; timeoutMs?: number };
export type LogEntry = { level: string; message: string; at: string };
export type Reply = { ok: boolean; result?: Json; error?: { code: string; message: string }; logs: LogEntry[]; ms?: number };
export type HostCall = { op: string; args: Args };
export type OpHandler = (args: Args) => Json | Promise<Json>;

export class HookError extends Error {
  constructor(public hook: string, public code: string, detail: string, public reply: Reply) {
    super(`${hook}: ${code} ${detail}`);
    this.name = "HookError";
  }
}

// What the plugin's ctx.broadcast / ctx.store calls reach. Throw an OpError to answer with an error.
export class OpError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const STORE_LIST_LIMIT = 100;

export class FakeHost {
  readonly calls: HostCall[] = [];
  readonly store = new FakeStore();
  private handlers = new Map<string, OpHandler>();
  private secretsByToken = new Map<string, Record<string, string>>();

  constructor() {
    const s = this.store;
    this.handlers.set("store.get", (a) => s.get(a.key, a));
    this.handlers.set("store.set", (a) => (s.set(a.key, a.value, a), true));
    this.handlers.set("store.delete", (a) => s.delete(a.key, a));
    this.handlers.set("store.increment", (a) => s.increment(a.key, a.by ?? 1, a));
    this.handlers.set("store.list", (a) => s.list(a.prefix ?? "", a, { cursor: a.cursor, limit: a.limit }));
    this.handlers.set("events.record", () => ({ ok: true }));
    this.handlers.set("events.bulkRecord", (a) => (Array.isArray(a.items) ? a.items : []).map(() => ({ ok: true })));
    this.handlers.set("log.write", () => true);
  }

  // Adds or replaces an op. Return the op's result; throw OpError(code, message) for an error.
  handle(op: string, handler: OpHandler) {
    this.handlers.set(op, handler);
  }

  /** @internal */
  secretsFor(token: string, secrets: Record<string, string>) {
    this.secretsByToken.set(token, secrets);
  }

  /** @internal */
  async answer(op: string, args: Args, token: string): Promise<{ status: number; body: Json }> {
    this.calls.push({ op, args });
    if (op === "settings.secret" && !this.handlers.has(op)) {
      const value = this.secretsByToken.get(token)?.[args.name];
      if (value === undefined) return fail(404, "not_found", `no secret ${args.name}: pass it in the call's secrets`);
      return { status: 200, body: { ok: true, result: value } };
    }
    const handler = this.handlers.get(op);
    if (!handler) return fail(403, "forbidden", `the test host has no op ${op}. Add it in the test: kit.host.handle("${op}", (args) => ...)`);
    try {
      return { status: 200, body: { ok: true, result: (await handler(args)) ?? null } };
    } catch (err) {
      if (err instanceof OpError) return fail(422, err.code, err.message);
      return fail(500, "host_error", (err as Error).message);
    }
  }
}

function fail(status: number, code: string, message: string) {
  return { status, body: { ok: false, error: { code, message } } };
}

// The plugin's store: channel rows, and rows per subscriber (ctx.store.forSubscriber)
export type StoreEntry = { key: string; value: Json; subscriber_id: Json };
type Scope = { subscriber_id?: Json };

export class FakeStore {
  private rows = new Map<string, StoreEntry>();
  private id = (key: string, scope?: Scope) => `${scope?.subscriber_id ?? ""}|${key}`;

  get(key: string, scope?: Scope): Json {
    return this.rows.get(this.id(key, scope))?.value ?? null;
  }
  has(key: string, scope?: Scope): boolean {
    return this.rows.has(this.id(key, scope));
  }
  set(key: string, value: Json, scope?: Scope) {
    this.rows.set(this.id(key, scope), { key, value, subscriber_id: scope?.subscriber_id ?? null });
  }
  delete(key: string, scope?: Scope): boolean {
    return this.rows.delete(this.id(key, scope));
  }
  increment(key: string, by: number, scope?: Scope): number {
    const value = Number(this.get(key, scope) ?? 0) + by;
    this.set(key, value, scope);
    return value;
  }
  // Like the real op: rows of one scope, ordered by key, after the cursor key, at most 100
  list(prefix: string, scope?: Scope, page: { cursor?: string; limit?: number } = {}) {
    const subscriber = String(scope?.subscriber_id ?? "");
    const limit = Math.min(Math.max(Math.trunc(Number(page.limit ?? STORE_LIST_LIMIT)) || 1, 1), STORE_LIST_LIMIT);
    return [...this.rows.values()]
      .filter((row) => String(row.subscriber_id ?? "") === subscriber && row.key.startsWith(prefix))
      .filter((row) => !page.cursor || row.key > page.cursor)
      .sort((a, b) => (a.key < b.key ? -1 : 1)).slice(0, limit)
      .map(({ key, value }) => ({ key, value }));
  }
  // Every row, channel and subscriber rows, in the order they were first written
  entries(): StoreEntry[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
  get size(): number {
    return this.rows.size;
  }
  clear() {
    this.rows.clear();
  }
}

export type TestPlugin = {
  id: string;
  version: string;
  manifest: Args;
  // The hook's result, or a HookError
  call(hook: string, args: Json[], options?: CallOptions): Promise<any>;
  // The runtime's whole reply: ok, result or error, logs, ms
  invoke(hook: string, args: Json[], options?: CallOptions): Promise<Reply>;
};

export type TestRuntime = {
  host: FakeHost;
  load(dir: string): Promise<TestPlugin>;
  plugin(source: { id: string; code: string; version?: string; manifest?: Args }): TestPlugin;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function startTestRuntime(options: { maxHeapMb?: number } = {}): Promise<TestRuntime> {
  const secret = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const host = new FakeHost();
  const bundles = new Map<string, string>();

  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
    if (req.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ ok: false }, { status: 401 });
    const path = new URL(req.url).pathname;
    const bundle = path.match(/^\/internal\/plugins\/bundles\/(.+)$/);
    if (req.method === "GET" && bundle) {
      const code = bundles.get(bundle[1]);
      if (code === undefined) return Response.json({ ok: false }, { status: 404 });
      return Response.json({ plugin_id: "test", version: "0", digest: bundle[1], code });
    }
    const op = path.match(/^\/internal\/plugins\/host\/(.+)$/);
    if (req.method === "POST" && op) {
      const answer = await host.answer(op[1], await req.json(), req.headers.get("x-plugin-token") ?? "");
      return Response.json(answer.body, { status: answer.status });
    }
    return new Response("not found", { status: 404 });
  });
  const hostUrl = `http://127.0.0.1:${server.addr.port}`;

  // Test runs have no network, so the egress proxy is never used
  const supervisor = startSupervisor({
    port: 0,
    hostname: "127.0.0.1",
    secret,
    hostApiUrl: hostUrl,
    egressUrl: "http://127.0.0.1:9",
    idleSeconds: 300,
    memoryLimitMb: 1024,
    maxHeapMb: options.maxHeapMb ?? 128,
    safeMode: false,
  });
  const runtimeUrl = `http://127.0.0.1:${supervisor.port}`;
  let seq = 0;

  const makePlugin = (id: string, version: string, manifest: Args, code: string): TestPlugin => {
    let digest: string | null = null;
    const invoke = async (hook: string, args: Json[], callOptions: CallOptions = {}): Promise<Reply> => {
      if (!digest) {
        digest = `sha256:${await sha256(code)}`;
        bundles.set(digest, code);
      }
      const callId = `test-${++seq}`;
      const token = `token-${callId}`;
      host.secretsFor(token, callOptions.secrets ?? {});
      const res = await fetch(`${runtimeUrl}/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({
          call_id: callId,
          plugin: { id, version, digest, net: [], private_net: [], keep_warm: false },
          token,
          hook,
          args,
          settings: callOptions.settings ?? {},
          timeout_ms: callOptions.timeoutMs ?? 10_000,
          test: { fixtures: callOptions.fixtures ?? [] },
        }),
      });
      if (res.status !== 200) throw new Error(`the runtime refused the call (HTTP ${res.status}): ${await res.text()}`);
      return await res.json();
    };
    return {
      id,
      version,
      manifest,
      invoke,
      async call(hook, args, callOptions) {
        const reply = await invoke(hook, args, callOptions);
        if (!reply.ok) throw new HookError(hook, reply.error?.code ?? "error", reply.error?.message ?? "", reply);
        return reply.result;
      },
    };
  };

  const close = async () => {
    await supervisor.shutdown();
    await server.shutdown();
  };

  return {
    host,
    async load(dir: string) {
      const root = dir.replace(/\/+$/, "");
      const manifest = JSON.parse(await Deno.readTextFile(`${root}/manifest.json`));
      const code = await Deno.readTextFile(`${root}/dist/main.js`);
      return makePlugin(String(manifest.id), String(manifest.version ?? "0.0.0"), manifest, code);
    },
    plugin(source) {
      return makePlugin(source.id, source.version ?? "0.0.0", source.manifest ?? { id: source.id }, source.code);
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
