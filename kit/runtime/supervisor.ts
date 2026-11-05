// Plugin runtime supervisor (V3-IMPLEMENTATION.md sections 3-5). One `deno run` process per plugin,
// started on demand, stopped when idle, killed at the call time limit. Started by bin/plugin-runtime.
//
// POST /invoke        run one hook call (section 3)
// GET  /health        process count, memory, safe mode
// POST /stop          {plugin_id} stop that plugin's process now
// GET  /egress/roles  the proxy credential (sha256) and hosts of each running process (section 8)
// An /invoke with `test: {fixtures}` (section 10) runs in its own process with no network; fetch
// answers from the fixtures, and the process stops when the call answers.
// All endpoints need `Authorization: Bearer <runtime secret>`.

export type SupervisorConfig = {
  port: number;
  hostname?: string;
  // A Unix socket in place of the port: no other user can bind it or connect to it.
  socketPath?: string;
  secret: string;
  hostApiUrl: string;
  egressUrl: string;
  idleSeconds: number;
  memoryLimitMb: number;
  maxHeapMb: number;
  safeMode: boolean;
  maxConcurrent?: number;
  maxQueue?: number;
  // Counted per process when its RSS cannot be read (no ps).
  processEstimateMb?: number;
  // ps binary for process RSS (default "ps" on PATH)
  psPath?: string;
  denoPath?: string;
};

type Json = unknown;
type Log = { level: string; message: string; at: string; kind?: "request" };
type CallResult = { ok: true; result: Json; logs: Log[] } | { ok: false; error: { code: string; message: string; stack?: string }; logs: Log[] };
export type Fixture = { method: string; url: string; status: number; headers: Record<string, string>; body: string };
// private_net: the one private host an admin approved (network.private); the egress proxy lets only
// this role reach it, and only on a private address.
type PluginSpec = { id: string; version: string; digest: string; net: string[]; private_net: string[]; keep_warm: boolean };
type Invocation = {
  plugin: PluginSpec;
  token: string;
  hook: string;
  args: Json[];
  settings: Record<string, Json>;
  channel: Json;
  timeoutMs: number;
  fixtures: Fixture[] | null;
  resolve: (r: CallResult) => void;
  queueTimer?: ReturnType<typeof setTimeout>;
};
type Inflight = { inv: Invocation; timer: ReturnType<typeof setTimeout>; stderr: Log[] };
type Proc = {
  entry: Entry;
  pluginId: string;
  digest: string;
  netKey: string;
  role: string;
  child: Deno.ChildProcess;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  inflight: Map<number, Inflight>;
  seq: number;
  lastUsed: number;
  // Strict order for LRU; two calls can end in the same millisecond.
  useTick: number;
  keepWarm: boolean;
  ready: boolean;
  exitReason: { code: string; message: string } | null;
  sawOom: boolean;
  exited: Promise<void>;
};
// A test entry is private to one test call; it is never in `entries`, so no later call reuses it.
type Entry = { id: string; queue: Invocation[]; proc: Proc | null; starting: boolean; test: boolean };

const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const NET_ENTRY = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;
const PRIVATE_ENTRY = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*:\d{1,5}$/i;
const HOST_OP = /^[a-z]+\.[a-zA-Z]+$/;
const START_TIMEOUT_MS = 10_000;
const MAX_LINE = 32 * 1024 * 1024;
const MAX_FIXTURES = 100;
const MAX_FIXTURE_BODY = 1024 * 1024;

const BOOTSTRAP = new URL("./bootstrap.ts", import.meta.url).pathname;
const encoder = new TextEncoder();

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const buf = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Compares fixed-length hashes so the time does not depend on where the inputs differ.
async function sameSecret(given: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MAX_STACK = 4000;

function fail(code: string, message: string, logs: Log[] = [], stack?: unknown): CallResult {
  const error: { code: string; message: string; stack?: string } = { code, message };
  if (typeof stack === "string" && stack) error.stack = stack.slice(0, MAX_STACK);
  return { ok: false, error, logs };
}

function now(): string {
  return new Date().toISOString();
}

// `ps -o pid=,rss=` output (kB) -> MB per pid
export function parsePsRss(output: string): Map<number, number> {
  const rss = new Map<number, number>();
  for (const line of output.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) rss.set(Number(match[1]), Number(match[2]) / 1024);
  }
  return rss;
}

// Process memory in MB by pid, from ps (Deno refuses /proc/<pid>/status of another process without
// --allow-all; procps is in the image and bin/plugin-runtime allows running it). Unknown -> absent.
// clearEnv: the image's entrypoint exports LD_PRELOAD (jemalloc), and Deno refuses to pass it to a
// subprocess unless --allow-run is unrestricted.
export async function readPsRss(psPath: string, pids: number[]): Promise<Map<number, number>> {
  if (pids.length === 0) return new Map();
  try {
    const out = await new Deno.Command(psPath, {
      args: ["-o", "pid=,rss=", "-p", pids.join(",")], clearEnv: true, stdout: "piped", stderr: "null",
    }).output();
    return parsePsRss(new TextDecoder().decode(out.stdout));
  } catch {
    return new Map();
  }
}

// A process is replaced when its hosts change
function netKey(spec: PluginSpec): string {
  return `${spec.net.join(",")}|${spec.private_net.join(",")}`;
}

export function startSupervisor(config: SupervisorConfig) {
  const maxConcurrent = config.maxConcurrent ?? 4;
  const maxQueue = config.maxQueue ?? 50;
  const estimateMb = config.processEstimateMb ?? 12;
  const denoPath = config.denoPath ?? Deno.execPath();
  const egress = new URL(config.egressUrl);
  const egressHostPort = `${egress.hostname}:${egress.port || (egress.protocol === "https:" ? 443 : 80)}`;

  const entries = new Map<string, Entry>();
  const bundles = new Map<string, string>();
  const roles = new Map<string, { token_sha256: string; hosts: string[]; private_hosts: string[] }>();
  const testEntries = new Set<Entry>();
  let roleSeq = 0;
  let useTicks = 0;

  function entryFor(id: string): Entry {
    let e = entries.get(id);
    if (!e) entries.set(id, e = { id, queue: [], proc: null, starting: false, test: false });
    return e;
  }

  // Section 4: fetch by digest, verify sha256, cache in memory.
  async function loadBundle(digest: string): Promise<string> {
    const cached = bundles.get(digest);
    if (cached !== undefined) return cached;
    const res = await fetch(`${config.hostApiUrl}/internal/plugins/bundles/${digest}`, {
      headers: { authorization: `Bearer ${config.secret}` },
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`bundle fetch failed: HTTP ${res.status}`);
    }
    const body = await res.json();
    if (typeof body?.code !== "string") throw new Error("bundle has no code");
    if (`sha256:${await sha256Hex(body.code)}` !== digest) throw new Error("bundle digest mismatch");
    bundles.set(digest, body.code);
    return body.code;
  }

  // Unknown -> absent (an estimate is used)
  function rssByPid(pids: number[]): Promise<Map<number, number>> {
    return readPsRss(config.psPath ?? "ps", pids);
  }

  async function rssMb(proc: Proc): Promise<number | null> {
    return (await rssByPid([proc.child.pid])).get(proc.child.pid) ?? null;
  }

  function liveProcs(): Proc[] {
    return [...entries.values(), ...testEntries].flatMap((e) => (e.proc && !e.proc.exitReason ? [e.proc] : []));
  }

  async function totalRssMb(): Promise<number> {
    const procs = liveProcs();
    const rss = await rssByPid(procs.map((p) => p.child.pid));
    return procs.reduce((total, p) => total + (rss.get(p.child.pid) ?? estimateMb), 0);
  }

  // Section 5 memory cap: stop least recently used idle processes before a start.
  async function makeRoom(startingId: string) {
    const cap = config.memoryLimitMb * 0.8;
    while ((await totalRssMb()) > cap) {
      const idle = liveProcs()
        .filter((p) => p.pluginId !== startingId && p.inflight.size === 0 && p.entry.queue.length === 0)
        .sort((a, b) => a.useTick - b.useTick);
      if (!idle.length) return;
      await stopProc(idle[0], { code: "crashed", message: "stopped to free memory" });
    }
  }

  function write(proc: Proc, msg: Record<string, Json>) {
    proc.writer.write(encoder.encode(JSON.stringify(msg) + "\n")).catch(() => {});
  }

  async function stopProc(proc: Proc, reason: { code: string; message: string }) {
    if (!proc.exitReason) {
      proc.exitReason = reason;
      try {
        proc.child.kill("SIGKILL");
      } catch { /* already gone */ }
    }
    await proc.exited;
  }

  // Starts the process for the head of the queue and waits until the bundle has loaded.
  async function startProc(entry: Entry, spec: PluginSpec, fixtures: Fixture[] | null): Promise<Proc> {
    const code = await loadBundle(spec.digest);
    await makeRoom(spec.id);

    const role = `${spec.id}#${++roleSeq}`;
    const token = randomHex(32);
    // A test run gets no network at all, whatever the manifest says (section 10).
    const hosts = [...spec.net, ...spec.private_net];
    const net = hosts.length && !entry.test ? [...hosts, egressHostPort] : [];
    const args = [
      "run",
      "--no-prompt",
      "--no-config",
      "--no-lock",
      "--cached-only",
      // Deno 2 allows imports from deno.land, jsr.io and others by default, and --cached-only
      // still loads a module that is already cached: only --deny-import refuses both.
      "--deny-import",
      `--v8-flags=--max-old-space-size=${config.maxHeapMb},--disallow-code-generation-from-strings`,
      ...(net.length ? [`--allow-net=${net.join(",")}`] : []),
      "--allow-env=PLUGIN_PROXY_URL,PLUGIN_PROXY_ROLE,PLUGIN_PROXY_TOKEN",
      // Only so the bootstrap can raise its own oom_score_adj; revoked before plugin code loads.
      "--allow-write=/proc/self/oom_score_adj",
      BOOTSTRAP,
    ];
    // A plugin with no hosts gets no net permission, so no proxy credential either.
    const env: Record<string, string> = net.length
      ? { PLUGIN_PROXY_URL: config.egressUrl, PLUGIN_PROXY_ROLE: role, PLUGIN_PROXY_TOKEN: token }
      : {};
    // Deno itself (not the plugin: no env permission) needs its cache directory.
    const denoDir = Deno.env.get("DENO_DIR");
    if (denoDir) env.DENO_DIR = denoDir;
    const child = new Deno.Command(denoPath, {
      args,
      clearEnv: true,
      env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    let loaded!: (err: string | null) => void;
    const loadedPromise = new Promise<string | null>((r) => loaded = r);
    const proc: Proc = {
      entry,
      pluginId: spec.id,
      digest: spec.digest,
      netKey: netKey(spec),
      role,
      child,
      writer: child.stdin.getWriter(),
      inflight: new Map(),
      seq: 0,
      lastUsed: Date.now(),
      useTick: ++useTicks,
      keepWarm: spec.keep_warm,
      ready: false,
      exitReason: null,
      sawOom: false,
      exited: Promise.resolve(),
    };
    if (net.length) {
      roles.set(role, { token_sha256: await sha256Hex(token), hosts: [...spec.net], private_hosts: [...spec.private_net] });
    }
    entry.proc = proc;

    const stdoutDone = readLines(child.stdout, (line) => onStdout(proc, line, loaded));
    const stderrDone = readLines(child.stderr, (line) => onStderr(proc, line));
    proc.exited = (async () => {
      const status = await child.status;
      await Promise.allSettled([stdoutDone, stderrDone]);
      onExit(entry, proc, status);
      loaded("the process exited while loading");
    })();

    const startTimer = setTimeout(() => loaded("loading took too long"), START_TIMEOUT_MS);
    // Fixtures travel in the load message, never in env or argv.
    write(proc, entry.test ? { t: "load", code, fixtures } : { t: "load", code });
    const err = await loadedPromise;
    clearTimeout(startTimer);
    if (err) {
      await stopProc(proc, { code: "load_failed", message: err });
      throw new Error(err);
    }
    proc.ready = true;
    return proc;
  }

  async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
    let buffer = "";
    try {
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          onLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
        if (buffer.length > MAX_LINE) throw new Error("line too long");
      }
      if (buffer) onLine(buffer);
    } catch { /* the process is gone or misbehaving; onExit handles the calls */ }
  }

  function onStderr(proc: Proc, line: string) {
    if (/out of memory|heap limit/i.test(line)) proc.sawOom = true;
    if (!line.trim()) return;
    const log = { level: "error", message: line.slice(0, 4000), at: now() };
    for (const f of proc.inflight.values()) if (f.stderr.length < 50) f.stderr.push(log);
  }

  function onStdout(proc: Proc, line: string, loaded: (err: string | null) => void) {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      return onStderr(proc, line);
    }
    if (msg.t === "loaded") return loaded(null);
    if (msg.t === "load_error") return loaded(String(msg.message ?? "load error"));
    if (msg.t === "host") return void hostCall(proc, msg);
    if (msg.t === "result") {
      const f = proc.inflight.get(msg.id);
      if (!f) return;
      finish(proc, msg.id, msg.ok
        ? { ok: true, result: msg.result ?? null, logs: [...cleanLogs(msg.logs), ...f.stderr] }
        : fail(String(msg.error?.code ?? "plugin_error"), String(msg.error?.message ?? ""), [...cleanLogs(msg.logs), ...f.stderr], msg.error?.stack));
    }
  }

  function cleanLogs(logs: unknown): Log[] {
    if (!Array.isArray(logs)) return [];
    return logs.slice(0, 200).map((l) => ({
      level: ["info", "warn", "error"].includes(l?.level) ? l.level : "info",
      message: String(l?.message ?? "").slice(0, 4000),
      at: String(l?.at ?? now()),
      // Only the request log's mark passes; Rails trusts no other kind from a plugin process
      ...(l?.kind === "request" ? { kind: "request" as const } : {}),
    }));
  }

  // Section 5/6: forward a host op to Rails with the call's token; the plugin never sees it.
  async function hostCall(proc: Proc, msg: Record<string, any>) {
    const reply = (body: Record<string, Json>) => write(proc, { t: "host_result", rid: msg.rid, ...body });
    const f = proc.inflight.get(msg.id);
    if (!f) return reply({ ok: false, error: { code: "call_ended", message: "this call has ended" } });
    if (typeof msg.op !== "string" || !HOST_OP.test(msg.op)) {
      return reply({ ok: false, error: { code: "invalid", message: "unknown host op" } });
    }
    try {
      const res = await fetch(`${config.hostApiUrl}/internal/plugins/host/${msg.op}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.secret}`,
          "x-plugin-token": f.inv.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(msg.args ?? {}),
      });
      const text = await res.text();
      let body: Record<string, any> | null = null;
      try {
        body = JSON.parse(text);
      } catch { /* not JSON */ }
      if (body && body.ok === true) return reply({ ok: true, result: body.result ?? null });
      const error = body?.error && typeof body.error === "object"
        ? { code: String(body.error.code ?? "host_error"), message: String(body.error.message ?? "") }
        : { code: "host_error", message: `Host API HTTP ${res.status}` };
      reply({ ok: false, error });
    } catch (err) {
      reply({ ok: false, error: { code: "host_error", message: `Host API unreachable: ${(err as Error).message}` } });
    }
  }

  function finish(proc: Proc, id: number, result: CallResult) {
    const f = proc.inflight.get(id);
    if (!f) return;
    clearTimeout(f.timer);
    proc.inflight.delete(id);
    proc.lastUsed = Date.now();
    proc.useTick = ++useTicks;
    f.inv.resolve(result);
    pump(proc.entry);
  }

  function onExit(entry: Entry, proc: Proc, status: Deno.CommandStatus) {
    roles.delete(proc.role);
    if (entry.proc === proc) entry.proc = null;
    // Ours: the reason we set. Not ours: V8 heap limit or the kernel OOM killer (SIGKILL), else a crash.
    const reason = proc.exitReason ??
      (proc.sawOom || status.signal === "SIGKILL"
        ? { code: "memory", message: "the plugin ran out of memory" }
        : { code: "crashed", message: `the plugin process exited (code ${status.code})` });
    proc.exitReason = reason;
    for (const [id, f] of proc.inflight) {
      clearTimeout(f.timer);
      proc.inflight.delete(id);
      f.inv.resolve(fail(reason.code, reason.message, f.stderr));
    }
    try {
      proc.writer.releaseLock();
    } catch { /* closed */ }
    pump(entry);
  }

  function dispatch(proc: Proc, inv: Invocation) {
    if (inv.queueTimer) clearTimeout(inv.queueTimer);
    const id = ++proc.seq;
    proc.keepWarm = inv.plugin.keep_warm;
    proc.lastUsed = Date.now();
    proc.useTick = ++useTicks;
    // A call over its time limit may be a busy loop: only killing the process stops it.
    const timer = setTimeout(() => {
      const f = proc.inflight.get(id);
      if (!f) return;
      proc.inflight.delete(id);
      f.inv.resolve(fail("timeout", `the call took longer than ${inv.timeoutMs} ms`, f.stderr));
      stopProc(proc, { code: "crashed", message: "another call on this plugin timed out" });
    }, inv.timeoutMs);
    proc.inflight.set(id, { inv, timer, stderr: [] });
    write(proc, { t: "call", id, hook: inv.hook, args: inv.args, settings: inv.settings, channel: inv.channel });
  }

  // Runs queued calls: starts or replaces the process as needed, at most maxConcurrent at once.
  function pump(entry: Entry) {
    if (entry.starting) return;
    while (entry.queue.length) {
      const head = entry.queue[0];
      const proc = entry.proc;
      if (!proc || proc.exitReason) {
        if (proc) return; // exiting; onExit pumps again
        entry.starting = true;
        startProc(entry, head.plugin, head.fixtures).then(
          () => {
            entry.starting = false;
            pump(entry);
          },
          (err: Error) => {
            entry.starting = false;
            // Fail every queued call for this digest, or the queue would retry forever.
            const failed = entry.queue.filter((q) => q.plugin.digest === head.plugin.digest);
            entry.queue = entry.queue.filter((q) => q.plugin.digest !== head.plugin.digest);
            for (const q of failed) {
              if (q.queueTimer) clearTimeout(q.queueTimer);
              q.resolve(fail("load_failed", err.message));
            }
            pump(entry);
          },
        );
        return;
      }
      if (proc.digest !== head.plugin.digest || proc.netKey !== netKey(head.plugin)) {
        // New version or new hosts: replace the process once its calls are done.
        if (proc.inflight.size === 0) stopProc(proc, { code: "crashed", message: "replaced by a new version" });
        return;
      }
      if (proc.inflight.size >= maxConcurrent) return;
      dispatch(proc, entry.queue.shift()!);
    }
  }

  // Section 10: a fresh process for this one call, stopped as soon as the call answers.
  function invokeTest(inv: Invocation) {
    const entry: Entry = { id: inv.plugin.id, queue: [inv], proc: null, starting: false, test: true };
    testEntries.add(entry);
    const answer = inv.resolve;
    inv.resolve = (result) => {
      answer(result);
      const proc = entry.proc;
      if (!proc) return void testEntries.delete(entry);
      stopProc(proc, { code: "crashed", message: "the test run is over" }).then(() => testEntries.delete(entry));
    };
    pump(entry);
  }

  function invoke(inv: Invocation) {
    if (inv.fixtures) return invokeTest(inv);
    const entry = entryFor(inv.plugin.id);
    const load = entry.queue.length + (entry.proc?.inflight.size ?? 0);
    if (load >= maxConcurrent + maxQueue) {
      return inv.resolve(fail("busy", "too many calls for this plugin"));
    }
    // A call that waits in the queue longer than its time limit gives up without killing anything.
    inv.queueTimer = setTimeout(() => {
      const i = entry.queue.indexOf(inv);
      if (i < 0) return;
      entry.queue.splice(i, 1);
      inv.resolve(fail("busy", "the call waited too long in the queue"));
    }, inv.timeoutMs);
    entry.queue.push(inv);
    pump(entry);
  }

  // Idle stop (section 5).
  const idleMs = config.idleSeconds * 1000;
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const p of liveProcs()) {
      if (!p.keepWarm && p.ready && p.inflight.size === 0 && p.entry.queue.length === 0 && p.lastUsed < cutoff) {
        stopProc(p, { code: "crashed", message: "stopped after idle time" });
      }
    }
  }, Math.max(100, Math.min(1000, idleMs / 2)));

  function parseInvoke(body: any): Omit<Invocation, "resolve"> | null {
    if (!body || typeof body !== "object") return null;
    const p = body.plugin;
    if (!p || typeof p.id !== "string" || !PLUGIN_ID.test(p.id)) return null;
    if (typeof p.digest !== "string" || !DIGEST.test(p.digest)) return null;
    const net = p.net ?? [];
    if (!Array.isArray(net) || net.length > 50 || !net.every((h: unknown) => typeof h === "string" && NET_ENTRY.test(h))) return null;
    const privateNet = p.private_net ?? [];
    if (!Array.isArray(privateNet) || privateNet.length > 1) return null;
    if (!privateNet.every((h: unknown) => typeof h === "string" && PRIVATE_ENTRY.test(h))) return null;
    if (typeof body.hook !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(body.hook)) return null;
    if (body.args !== undefined && !Array.isArray(body.args)) return null;
    if (typeof body.token !== "string") return null;
    const settings = body.settings ?? {};
    if (typeof settings !== "object" || Array.isArray(settings)) return null;
    const timeout = Number(body.timeout_ms ?? 10_000);
    if (!Number.isFinite(timeout) || timeout <= 0) return null;
    let fixtures: Fixture[] | null = null;
    if (body.test !== undefined) {
      fixtures = parseFixtures(body.test);
      if (!fixtures) return null;
    }
    return {
      plugin: { id: p.id, version: String(p.version ?? ""), digest: p.digest, net, private_net: privateNet, keep_warm: p.keep_warm === true },
      token: body.token,
      hook: body.hook,
      args: body.args ?? [],
      settings,
      channel: body.channel ?? null,
      timeoutMs: Math.min(timeout, 300_000),
      fixtures,
    };
  }

  // `test: { fixtures: [{ method, url, status, headers, body }] }`; null when the shape is wrong.
  function parseFixtures(test: any): Fixture[] | null {
    if (!test || typeof test !== "object" || Array.isArray(test)) return null;
    const list = test.fixtures;
    if (!Array.isArray(list) || list.length > MAX_FIXTURES) return null;
    const fixtures: Fixture[] = [];
    for (const f of list) {
      if (!f || typeof f !== "object" || Array.isArray(f)) return null;
      const method = f.method ?? "GET";
      if (typeof method !== "string" || !/^[A-Za-z]{1,16}$/.test(method)) return null;
      if (typeof f.url !== "string" || !/^https?:\/\/[^\s]+$/i.test(f.url)) return null;
      try {
        new URL(f.url.replace(/\*$/, ""));
      } catch {
        return null;
      }
      const status = f.status ?? 200;
      if (!Number.isInteger(status) || status < 100 || status > 599) return null;
      const headers = f.headers ?? {};
      if (typeof headers !== "object" || Array.isArray(headers)) return null;
      if (!Object.values(headers).every((v) => typeof v === "string")) return null;
      const fbody = f.body ?? "";
      if (typeof fbody !== "string" || encoder.encode(fbody).length > MAX_FIXTURE_BODY) return null;
      fixtures.push({ method: method.toUpperCase(), url: f.url, status, headers, body: fbody });
    }
    return fixtures;
  }

  async function health() {
    const plugins: Record<string, Json> = {};
    let total = 0;
    for (const p of liveProcs()) {
      const rss = await rssMb(p);
      total += rss ?? estimateMb;
      plugins[p.pluginId] = {
        pid: p.child.pid,
        rss_mb: rss === null ? null : Math.round(rss * 10) / 10,
        inflight: p.inflight.size,
        queued: p.entry.queue.length,
        keep_warm: p.keepWarm,
        digest: p.digest,
      };
    }
    return {
      ok: true,
      processes: Object.keys(plugins).length,
      memory: { rss_mb: Math.round(total * 10) / 10, limit_mb: config.memoryLimitMb, plugins },
      safe_mode: config.safeMode,
    };
  }

  const bad = (msg: string) => Response.json({ ok: false, error: msg }, { status: 400 });

  if (config.socketPath) {
    try {
      Deno.removeSync(config.socketPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  const listen: any = config.socketPath
    ? { path: config.socketPath, transport: "unix", onListen: () => {} }
    : { port: config.port, hostname: config.hostname ?? "0.0.0.0", onListen: () => {} };
  const server = Deno.serve(
    listen,
    async (req: Request) => {
      const auth = req.headers.get("authorization") ?? "";
      if (!auth.startsWith("Bearer ") || !(await sameSecret(auth.slice(7), config.secret))) {
        await req.body?.cancel();
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/health") return Response.json(await health());
      if (req.method === "GET" && path === "/egress/roles") return Response.json(Object.fromEntries(roles));
      if (req.method !== "POST") return Response.json({ ok: false, error: "not found" }, { status: 404 });

      let body: any;
      try {
        body = await req.json();
      } catch {
        return bad("invalid JSON");
      }
      if (path === "/stop") {
        if (typeof body?.plugin_id !== "string") return bad("plugin_id is required");
        const entry = entries.get(body.plugin_id);
        const proc = entry?.proc;
        for (const q of entry?.queue.splice(0) ?? []) {
          if (q.queueTimer) clearTimeout(q.queueTimer);
          q.resolve(fail("crashed", "the plugin was stopped"));
        }
        if (!proc || proc.exitReason) return Response.json({ ok: true, stopped: false });
        await stopProc(proc, { code: "crashed", message: "the plugin was stopped" });
        return Response.json({ ok: true, stopped: true });
      }
      if (path === "/invoke") {
        const parsed = parseInvoke(body);
        if (!parsed) return bad("invalid invoke request");
        const started = performance.now();
        let result: CallResult;
        if (config.safeMode) {
          result = fail("safe_mode", "plugins are off (safe mode)");
        } else {
          result = await new Promise<CallResult>((resolve) => invoke({ ...parsed, resolve }));
        }
        return Response.json({ ...result, ms: Math.round((performance.now() - started) * 1000) / 1000 });
      }
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    },
  );
  if (config.socketPath) Deno.chmodSync(config.socketPath, 0o600);

  return {
    port: (server.addr as unknown as Deno.NetAddr).port ?? 0,
    async shutdown() {
      clearInterval(sweeper);
      await Promise.all(liveProcs().map((p) => stopProc(p, { code: "crashed", message: "the runtime is stopping" })));
      await server.shutdown();
    },
  };
}

if (import.meta.main) {
  const env = (name: string, fallback: string) => Deno.env.get(name) || fallback;
  const secretFile = env("PLUGIN_RUNTIME_SECRET_FILE", "/run/secrets/plugin_runtime_secret");
  const secret = (await Deno.readTextFile(secretFile)).trim();
  if (!/^[0-9a-f]{64}$/i.test(secret)) {
    console.error(`${secretFile} must hold 64 hex characters`);
    Deno.exit(1);
  }
  const sup = startSupervisor({
    port: Number(env("PLUGIN_RUNTIME_PORT", "8787")),
    socketPath: Deno.env.get("PLUGIN_RUNTIME_SOCKET") || undefined,
    secret,
    hostApiUrl: env("PLUGIN_HOST_API_URL", "http://app:3100").replace(/\/$/, ""),
    egressUrl: env("PLUGIN_EGRESS_URL", "http://egress:4750"),
    idleSeconds: Number(env("PLUGIN_IDLE_SECONDS", "300")),
    memoryLimitMb: Number(env("PLUGINS_MEMORY_LIMIT_MB", "256")),
    maxHeapMb: Number(env("PLUGIN_MAX_HEAP_MB", "64")),
    safeMode: env("BROADCAST_PLUGINS_SAFE_MODE", "") === "1",
    psPath: Deno.env.get("PLUGIN_PS_BIN") || undefined,
  });
  console.log(`plugin runtime on ${Deno.env.get("PLUGIN_RUNTIME_SOCKET") || `:${sup.port}`}${Deno.env.get("BROADCAST_PLUGINS_SAFE_MODE") === "1" ? " (safe mode)" : ""}`);
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    Deno.addSignalListener(sig, () => sup.shutdown().then(() => Deno.exit(0)));
  }
}
