// The core of `broadcast-plugin serve`: one plugin folder in the real plugin runtime, against the
// sandbox Host API (testing/sandbox_host.ts) with a world that is saved in <plugin>/.sandbox/.
// serve.ts puts the screen at localhost:8080 on top of this.
import { type Args, type Json, type Reply, startTestRuntime, type TestPlugin, type TestRuntime } from "../testing/mod.ts";
import { emptyWorld, manifestPermissions, type Person, SandboxHost, type World } from "../testing/sandbox_host.ts";
import SPEC from "../spec/plugin-api-1.json" with { type: "json" };
import { type Cron, nextTime, parseCron, previousTime } from "./cron.ts";
import { makeToken, readToken } from "./links.ts";
import { publicSettings } from "./settings.ts";
import { SendHooks } from "./send.ts";

// What a plugin page may call through the bridge (Plugins::ViewerGrant::BRIDGE_OPS). The sandbox
// viewer is an admin, so only the plugin's own permissions narrow it.
export const BRIDGE_OPS = [
  "channel.get", "store.get", "store.set", "store.delete", "store.increment", "store.list", "subscribers.get", "subscribers.find",
  "subscribers.list", "tags.list", "broadcasts.get", "broadcasts.list", "sequences.get", "sequences.list", "segments.get", "segments.list",
];
const STORE_WRITES = ["store.set", "store.delete", "store.increment"];

// event.data of subscriber.* events: the webhook payload's fields, and the fields a plugin with no
// subscribers permission gets (spec events, generated from Broadcast's code)
const SUBSCRIBER_EVENT = SPEC.events.subscriber;
const EVENT_FIELDS = SPEC.events.allowedWithoutSubscribers as Record<string, string[]>;

export type Draft = { id: number; subject: string; preheader: string; body: string; updated_at: string };
export type InboxEmail = {
  id: number; draft_id: number; subscriber_id: number; to: string; subject: string; preheader: string; body: string;
  headers: Record<string, string>; sent_at: string;
};
export type PluginEvent = { id: string; type: string; occurred_at: string; data: Args };
// An event or a batch the sandbox delivered, with the full data: "send again" narrows it again to
// the permissions of that moment, as PluginEventJob does on a retry
export type SentEvents = { id: string; type: string; at: string; batch: boolean; events: PluginEvent[] };
// The sandbox's own parts of the world, saved with it. clockOffsetMs moves the sandbox's time away
// from the computer's; scheduleRuns holds each schedule's last due time (PluginScheduleRun).
export type SandboxWorld = World & {
  drafts: Draft[]; inbox: InboxEmail[]; actionKey?: string; clockOffsetMs?: number; scheduleRuns?: Record<string, string>; sent: SentEvents[];
};
// collapsed: the schedules that passed more than CATCH_UP_RUNS due times and ran only the latest
export type ClockMove = { ok: true; now: string; ran: number; collapsed: string[] };
export type ScheduleView = { name: string; cron: string; valid: boolean; last_run_at: string | null; next_at: string | null };
export type ActionAnswer = { status: number; title: string; message: string | null };

const PUBLIC = SPEC.limits.publicActions;
const TEXT = { confirmTitle: "One moment", confirmButton: "Continue", doneTitle: "Thank you", failedTitle: "Something went wrong",
  failedBody: "We could not save this. Please try the link again later." };

export type OpEntry = { seq: number; at: string; op: string; hook?: string; args: Json; ok: boolean; result?: Json; error?: Json; ms: number };
export type ReloadResult = { ok: boolean; message: string; version?: string; permissions?: { added: string[]; removed: string[] } };
export type SandboxPlugin = { id: string; name: string; version: string; manifest: Args };

const SEED_PEOPLE = 25;
const OPS_KEPT = 500;
const SENT_KEPT = 50;
const EVENTS = SPEC.limits.events;
const LIFECYCLE = SPEC.limits.lifecycle;
// A clock move that passes more due times of one schedule than this runs only the latest, as
// Broadcast does after a long stop (PluginScheduleTickJob claims the latest due time)
export const CATCH_UP_RUNS = 50;
const LIFECYCLE_HOOKS = ["onInstall", "onUpgrade", "onUninstall"];
// Broadcast's time format for scheduled_for (Time#iso8601)
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function seedWorld(): SandboxWorld {
  const world: SandboxWorld = { ...emptyWorld("Sandbox"), drafts: [], inbox: [], sent: [] };
  world.topics = [{ name: "Newsletter", storage: "tag", tag_name: "newsletter" }];
  const at = new Date().toISOString();
  for (let i = 1; i <= SEED_PEOPLE; i++) {
    const tags = [i % 3 === 0 && "customer", i % 4 === 0 && "beta", i % 5 === 0 && "vip", i % 7 === 0 && "lead", i % 2 === 1 && "newsletter"]
      .filter(Boolean) as string[];
    world.people.push({
      id: world.nextId++, email: `person${i}@example.test`, first_name: "Person", last_name: String(i), is_active: i !== 20,
      subscribed_at: at, unsubscribed_at: i === 20 ? at : null, tags, custom_data: { plan: i % 3 === 0 ? "pro" : "free" },
      source: "sandbox", signup_ref: null, confirmed_at: at, created_at: at, updated_at: at,
    });
  }
  return world;
}

export class Sandbox {
  ops: OpEntry[] = [];
  // Reloads since the sandbox opened: the version shows as <version>+dev.<n>
  private devBuild = 0;
  // The address the links in sandbox emails point at (serve sets it to its own)
  baseUrl = "http://localhost:8080";
  private actionCalls = new Map<string, number[]>();
  private actionsRunning = 0;
  private seq = 0;
  private hookStack: string[] = [];
  private listeners = new Set<(kind: string, payload: Json) => void>();

  constructor(
    readonly dir: string,
    public plugin: SandboxPlugin,
    public world: SandboxWorld,
    public host: SandboxHost,
    private runtime: TestRuntime,
    private runner: TestPlugin,
    private code: string,
  ) {
    host.onCall = (call) => {
      const body = call.body as Args;
      this.record({ op: call.op, hook: this.hookStack.at(-1), args: call.args, ok: call.ok, result: body?.result, error: body?.error, ms: call.ms });
    };
  }

  get stateDir() {
    return `${this.dir}/.sandbox`;
  }

  // Tell the screen what changed ("ops", "state")
  subscribe(listener: (kind: string, payload: Json) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(kind: string, payload: Json) {
    for (const listener of this.listeners) listener(kind, payload);
  }

  // The sandbox's time: the computer's, moved by the Clock. The host's times (updated_at, logs, read
  // limits), event times, scheduled_for and the plugin's own Date and Temporal.Now use it.
  now(): number {
    return Date.now() + (this.world.clockOffsetMs ?? 0);
  }

  private record(entry: Omit<OpEntry, "seq" | "at">) {
    const full = { seq: ++this.seq, at: new Date(this.now()).toISOString(), ...entry };
    this.ops.push(full);
    if (this.ops.length > OPS_KEPT) this.ops.splice(0, this.ops.length - OPS_KEPT);
    this.emit("ops", full);
  }

  // Run one hook. Settings are the non-secret ones, with manifest defaults (publicSettings); a secret
  // comes through settings.secret. fetch
  // answers only from .sandbox/fixtures.json, as in a draft test run.
  async invoke(hook: string, args: Json[], timeoutMs = 10_000, options: { logFailure?: boolean } = {}): Promise<Reply> {
    const settings = publicSettings(this.plugin.manifest.settings, this.world.settings) as Record<string, Json>;
    this.hookStack.push(hook);
    const started = performance.now();
    let reply: Reply;
    try {
      // A moved clock reaches the plugin too: its Date and Temporal.Now start at the sandbox's time
      const now = this.world.clockOffsetMs ? this.now() : undefined;
      reply = await this.runner.invoke(hook, args, { settings, fixtures: await this.fixtures(), timeoutMs, now });
    } catch (err) {
      reply = { ok: false, error: { code: "runtime_error", message: (err as Error).message }, logs: [] };
    } finally {
      this.hookStack.pop();
    }
    for (const log of reply.logs ?? []) this.host.writeLog(log.level, log.message, hook);
    if (!reply.ok && options.logFailure !== false) this.host.writeLog("error", `${hook} failed: ${reply.error?.code}${reply.error?.message ? `: ${reply.error.message}` : ""}`, hook);
    this.record({ op: `hook:${hook}`, args: args as Json, ok: reply.ok, result: reply.result, error: reply.error, ms: performance.now() - started });
    await this.save();
    return reply;
  }

  private async fixtures() {
    try {
      return JSON.parse(await Deno.readTextFile(`${this.stateDir}/fixtures.json`));
    } catch {
      return [];
    }
  }

  person(id: number): Person | undefined {
    return this.host.people().find((p) => p.id === id);
  }

  private notDeclared(type: string): Reply | null {
    const declared: string[] = this.plugin.manifest.hooks?.events ?? [];
    return declared.includes(type) ? null : { ok: false, error: { code: "not_declared", message: `manifest.json hooks.events does not list ${type}.` }, logs: [] };
  }

  private buildEvent(type: string, subscriberId: number): PluginEvent {
    const person = this.person(subscriberId);
    const data: Args = person ? subscriberPayload(person) : { subscriber_id: subscriberId };
    return { id: `evt_${crypto.randomUUID()}`, type, occurred_at: new Date(this.now()).toISOString(), data };
  }

  // Plugins::EventData: without a subscribers permission, event.data keeps only ids, state and times
  private narrow(event: PluginEvent): PluginEvent {
    const withPeople = this.host.grant.permissions.some((name) => name.startsWith("subscribers:"));
    if (withPeople) return event;
    const allowed = EVENT_FIELDS[event.type.split(".")[0]] ?? [];
    return { ...event, data: Object.fromEntries(Object.entries(event.data).filter(([key]) => allowed.includes(key))) };
  }

  private async deliver(sent: SentEvents): Promise<Reply> {
    const events = sent.events.map((event) => this.narrow(event));
    return sent.batch ? await this.invoke("onEvents", [events], EVENTS.batchTimeoutMs) : await this.invoke("onEvent", [events[0]]);
  }

  private remember(sent: SentEvents) {
    this.world.sent.push(sent);
    if (this.world.sent.length > SENT_KEPT) this.world.sent.splice(0, this.world.sent.length - SENT_KEPT);
  }

  // A webhook event as Broadcast delivers it to onEvent
  async fireEvent(type: string, subscriberId: number): Promise<Reply> {
    const refused = this.notDeclared(type);
    if (refused) return refused;
    const event = this.buildEvent(type, subscriberId);
    const sent = { id: event.id, type, at: event.occurred_at, batch: false, events: [event] };
    this.remember(sent);
    return await this.deliver(sent);
  }

  // Bulk work (an import, a bulk API call, a send) gives a plugin its events of one type in batches:
  // one onEvents call, or one onEvent call per event when the plugin has no onEvents
  async fireEvents(type: string, subscriberIds: number[]): Promise<Reply> {
    const refused = this.notDeclared(type);
    if (refused) return refused;
    if (subscriberIds.length === 0 || subscriberIds.length > EVENTS.batchSize) {
      return { ok: false, error: { code: "too_many", message: `A batch has 1 to ${EVENTS.batchSize} events.` }, logs: [] };
    }
    const events = subscriberIds.map((id) => this.buildEvent(type, id));
    const sent = { id: `batch_${crypto.randomUUID()}`, type, at: events[0].occurred_at, batch: true, events };
    this.remember(sent);
    return await this.deliver(sent);
  }

  // Broadcast delivers at least once: a retry repeats the same event ids
  async repeatEvent(id: string): Promise<Reply> {
    const sent = this.world.sent.find((entry) => entry.id === id);
    if (!sent) return { ok: false, error: { code: "not_found", message: "The sandbox no longer has this event." }, logs: [] };
    return await this.deliver(sent);
  }

  // --- the clock and schedules (PluginScheduleTickJob, PluginScheduleJob) ---

  private scheduleList(): { name: string; cron: string; parsed: Cron | null }[] {
    const list = Array.isArray(this.plugin.manifest.hooks?.schedules) ? this.plugin.manifest.hooks.schedules : [];
    return list.filter((s: Args) => s && typeof s.name === "string")
      .map((s: Args) => ({ name: s.name, cron: String(s.cron ?? ""), parsed: parseCron(String(s.cron ?? "")) }));
  }

  schedules(): ScheduleView[] {
    const runs = this.world.scheduleRuns ?? {};
    return this.scheduleList().map(({ name, cron, parsed }) => {
      const next = parsed ? nextTime(parsed, this.now()) : null;
      return { name, cron, valid: parsed !== null, last_run_at: runs[name] ?? null, next_at: next === null ? null : iso(next) };
    });
  }

  private async runOnSchedule(name: string, due: number): Promise<Reply> {
    return await this.invoke("onSchedule", [{ name, scheduled_for: iso(due) }]);
  }

  // One tick, as every minute on a server: a schedule seen for the first time only notes its last due
  // time; a later due time runs once (the latest, when several passed)
  async tick(): Promise<ClockMove> {
    const runs = this.world.scheduleRuns ??= {};
    let ran = 0;
    for (const { name, parsed } of this.scheduleList()) {
      if (!parsed) continue;
      const due = previousTime(parsed, this.now());
      if (due === null) continue;
      if (!runs[name]) {
        runs[name] = iso(due);
        continue;
      }
      if (due <= Date.parse(runs[name])) continue;
      runs[name] = iso(due);
      await this.runOnSchedule(name, due);
      ran++;
    }
    await this.save();
    return { ok: true, now: iso(this.now()), ran, collapsed: [] };
  }

  // Move the sandbox's time. Moving forward runs each due time it passes, in order, with the clock at
  // that time; a schedule with more than CATCH_UP_RUNS due times runs only the latest one. Moving back
  // makes each schedule seen anew, so nothing runs for the time between.
  async setClock(target: number): Promise<ClockMove> {
    if (target < this.now()) {
      const from = iso(this.now());
      this.world.clockOffsetMs = target - Date.now();
      this.world.scheduleRuns = {};
      this.record({ op: "clock", args: { from, to: iso(target) } as Json, ok: true, ms: 0 });
      return await this.tick();
    }
    await this.tick();
    const runs = this.world.scheduleRuns!;
    const queue: { name: string; due: number }[] = [];
    const collapsed: string[] = [];
    for (const { name, parsed } of this.scheduleList()) {
      if (!parsed || !runs[name]) continue;
      // Count no further than one past the limit: a year of an every-minute cron is 525,600 times
      const times: number[] = [];
      for (let at = nextTime(parsed, Date.parse(runs[name])); at !== null && at <= target && times.length <= CATCH_UP_RUNS; at = nextTime(parsed, at)) times.push(at);
      if (times.length > CATCH_UP_RUNS) {
        // The latest due time at or before the target
        collapsed.push(name);
        queue.push({ name, due: previousTime(parsed, target + 1)! });
      } else {
        for (const due of times) queue.push({ name, due });
      }
    }
    queue.sort((a, b) => a.due - b.due);
    const from = iso(this.now());
    for (const { name, due } of queue) {
      this.world.clockOffsetMs = due + 1_000 - Date.now();
      runs[name] = iso(due);
      await this.runOnSchedule(name, due);
    }
    this.world.clockOffsetMs = target - Date.now();
    this.record({ op: "clock", args: { from, to: iso(target), ran: queue.length, collapsed } as Json, ok: true, ms: 0 });
    await this.save();
    return { ok: true, now: iso(this.now()), ran: queue.length, collapsed };
  }

  async advanceClock(ms: number): Promise<ClockMove> {
    return await this.setClock(this.now() + ms);
  }

  // Back to the computer's time; each schedule is seen anew, so nothing runs for the jump
  async resetClock(): Promise<ClockMove> {
    const from = iso(this.now());
    this.world.clockOffsetMs = 0;
    this.world.scheduleRuns = {};
    this.record({ op: "clock", args: { from, to: iso(this.now()), reset: true } as Json, ok: true, ms: 0 });
    return await this.tick();
  }

  // A "Run now" button: onSchedule for the schedule's last due time; its place does not change
  async runSchedule(name: string): Promise<Reply> {
    const schedule = this.scheduleList().find((s) => s.name === name);
    if (!schedule) return { ok: false, error: { code: "not_declared", message: `manifest.json hooks.schedules has no ${name}.` }, logs: [] };
    if (!schedule.parsed) return { ok: false, error: { code: "invalid", message: `${schedule.cron} is not a cron expression.` }, logs: [] };
    const due = previousTime(schedule.parsed, this.now());
    if (due === null) return { ok: false, error: { code: "invalid", message: `${schedule.cron} has no due time before now.` }, logs: [] };
    return await this.runOnSchedule(name, due);
  }

  // --- lifecycle hooks (Plugins::Lifecycle), declared with true in manifest.json hooks ---

  async lifecycle(hook: string, input: { from_version?: string; rollback?: boolean } = {}): Promise<Reply> {
    if (!LIFECYCLE_HOOKS.includes(hook) || this.plugin.manifest.hooks?.[hook] !== true) {
      return { ok: false, error: { code: "not_declared", message: `manifest.json hooks.${hook} is not true.` }, logs: [] };
    }
    const version = this.versionLabel;
    if (hook === "onUninstall") return await this.invoke(hook, [{ version }], LIFECYCLE.uninstallTimeoutMs);
    if (hook === "onInstall") return await this.invoke(hook, [{ version }], LIFECYCLE.timeoutMs);
    const args = { from_version: String(input.from_version ?? version), to_version: version, rollback: input.rollback === true };
    return await this.invoke(hook, [args], LIFECYCLE.timeoutMs);
  }

  // A plugin page's call, as the viewer (PluginBridgesController + Plugins::ViewerGrant)
  async bridge(op: string, args: Args): Promise<{ ok: boolean; result?: Json; error?: { code: string; message?: string } }> {
    if (op === "pageData") {
      const page = Number.parseInt(String(args?.page ?? 0), 10) || 0;
      const reply = await this.invoke("pageData", [{ page, input: args?.input ?? {} }]);
      return reply.ok ? { ok: true, result: reply.result } : { ok: false, error: { code: reply.error?.code ?? "error" } };
    }
    const reserved = STORE_WRITES.includes(op) && String(args?.key ?? "").startsWith("__");
    if (!BRIDGE_OPS.includes(op) || reserved) return { ok: false, error: { code: "forbidden", message: `The page may not use ${op}.` } };
    this.hookStack.push("page");
    try {
      const { body } = (await this.host.answer(op, args ?? {}, "bridge")) as { body: { ok: boolean; result?: Json; error?: { code: string; message?: string } } };
      await this.save();
      return body;
    } finally {
      this.hookStack.pop();
    }
  }

  // A new person, as a signup form makes one (confirmed, source "sandbox"); subscriber.created goes
  // to the plugin when the manifest declares it. signup_ref is what a referral link carries.
  async addPerson(fields: { email?: string; first_name?: string; last_name?: string; signup_ref?: string; tags?: string[] }):
    Promise<{ ok: boolean; person?: Person; reply?: Reply; error?: { code: string; message: string } }> {
    const email = String(fields.email ?? "").trim().toLowerCase();
    const refuse = (message: string) => ({ ok: false, error: { code: "invalid", message } });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return refuse("Enter an email address.");
    if (this.world.people.some((p) => p.email === email)) return refuse(`${email} is already in the channel.`);
    const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 255) : null);
    const person = this.host.newPerson({
      email, first_name: text(fields.first_name), last_name: text(fields.last_name), signup_ref: text(fields.signup_ref),
      source: "sandbox", confirmed_at: new Date(this.now()).toISOString(),
      tags: Array.isArray(fields.tags) ? fields.tags.map(String).filter(Boolean) : [],
    });
    this.world.people.push(person);
    await this.save();
    const declared: string[] = this.plugin.manifest.hooks?.events ?? [];
    if (!declared.includes("subscriber.created")) return { ok: true, person };
    return { ok: true, person, reply: await this.fireEvent("subscriber.created", person.id) };
  }

  // Erase a person (GDPR): the plugin hears it first, then its rows about them go and they are gone
  async erase(id: number): Promise<Reply> {
    const person = this.person(id);
    if (!person) return { ok: false, error: { code: "not_found", message: "No such person." }, logs: [] };
    let reply: Reply = { ok: true, result: null, logs: [] };
    if (this.plugin.manifest.hooks?.onSubscriberDeleted === true) {
      reply = await this.invoke("onSubscriberDeleted", [{ subscriber_id: person.id, email: person.email }]);
    }
    for (const row of this.host.store.entries()) {
      if (row.subscriber_id === person.id) this.host.store.delete(row.key, { subscriber_id: person.id });
    }
    person.erased = true;
    person.email = `erased-${person.id}@redacted.invalid`;
    person.first_name = person.last_name = null;
    person.custom_data = {};
    person.tags = [];
    await this.save();
    return reply;
  }

  // --- emails ---

  async saveDraft(fields: { id?: number; subject?: string; preheader?: string; body?: string }): Promise<Draft> {
    const drafts = this.world.drafts;
    let draft = drafts.find((d) => d.id === fields.id);
    if (!draft) drafts.push(draft = { id: this.world.nextId++, subject: "", preheader: "", body: "", updated_at: "" });
    draft.subject = String(fields.subject ?? draft.subject);
    draft.preheader = String(fields.preheader ?? draft.preheader);
    draft.body = String(fields.body ?? draft.body);
    draft.updated_at = new Date(this.now()).toISOString();
    await this.save();
    return draft;
  }

  private draft(id: number): Draft {
    const draft = this.world.drafts.find((d) => d.id === id);
    if (!draft) throw new Error(`No draft ${id}.`);
    return draft;
  }

  // BroadcastEmailRenderer#render_for_subscriber with Plugins::SendHooks, for these people
  private async renderAll(draft: Draft, people: Person[]) {
    const hooks = new SendHooks({
      plugin: this.plugin, permissions: this.host.grant.permissions,
      invoke: (hook, args, timeoutMs) => this.invoke(hook, args, timeoutMs),
      actionUrl: async (person, action) => `${this.baseUrl}/plugin-action/${await this.actionToken(person.id, action)}`,
    }, [draft.subject, draft.preheader, draft.body], { about: { broadcast_id: draft.id, subject: draft.subject } });
    const liquid = hooks.liquid();
    const variables = (p: Person) => ({
      subscriber: { ...this.host.serialize(p) }, tags: p.tags, email: p.email, first_name: p.first_name, last_name: p.last_name,
      name: [p.first_name, p.last_name].filter(Boolean).join(" "), data: p.custom_data, custom_data: p.custom_data,
      preferences_url: `${this.baseUrl}/#people`,
    });
    const render = async (p: Person) => {
      const text = { ...variables(p), ...(await hooks.contextFor(p, false)) };
      const body = await liquid.parseAndRender(draft.body, { ...variables(p), unsubscribe_url: `${this.baseUrl}/#people`, ...(await hooks.contextFor(p, true)) });
      const [subject, preheader] = await hooks.rendering(false, async () => [
        await liquid.parseAndRender(draft.subject, text), await liquid.parseAndRender(draft.preheader, text),
      ]);
      const decision = hooks.decisionFor(p);
      return {
        person: p, skip: decision.skip, subject: decision.subject ?? subject, preheader,
        body: `${decision.prepend_html ?? ""}${body}${decision.append_html ?? ""}`, headers: decision.headers,
      };
    };
    await hooks.prepare(people, render);
    const out = [];
    for (const p of people) out.push(await render(p));
    return out;
  }

  // One person's email, as it would go out; nothing is sent
  async preview(draftId: number, personId: number) {
    const person = this.person(personId);
    if (!person) throw new Error(`No person ${personId}.`);
    const [email] = await this.renderAll(this.draft(draftId), [person]);
    return { subject: email.subject, preheader: email.preheader, body: email.body, skip: email.skip, headers: email.headers };
  }

  // Send to every subscribed person: the emails go to the sandbox inbox, never out
  async send(draftId: number): Promise<{ sent: number; skipped: number }> {
    const draft = this.draft(draftId);
    const people = this.host.people().filter((p) => p.is_active && !p.unsubscribed_at);
    const emails = await this.renderAll(draft, people);
    const inbox = this.world.inbox;
    const at = new Date(this.now()).toISOString();
    let sent = 0;
    for (const e of emails.filter((e) => !e.skip)) {
      inbox.push({ id: this.world.nextId++, draft_id: draft.id, subscriber_id: e.person.id, to: e.person.email, subject: e.subject, preheader: e.preheader, body: e.body, headers: e.headers, sent_at: at });
      sent++;
    }
    if (inbox.length > 2000) inbox.splice(0, inbox.length - 2000);
    await this.save();
    return { sent, skipped: emails.length - sent };
  }

  // --- public actions (Plugins::PublicActionLink, PluginPublicActionsController) ---

  private actionKey(): Uint8Array {
    if (!this.world.actionKey) {
      this.world.actionKey = [...crypto.getRandomValues(new Uint8Array(64))].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    return new Uint8Array(this.world.actionKey.match(/../g)!.map((b) => parseInt(b, 16)));
  }

  async actionToken(personId: number, action: string): Promise<string> {
    return await makeToken(this.actionKey(), [this.plugin.id, this.world.channel.id, personId, action]);
  }

  async readActionToken(token: string) {
    return await readToken(this.actionKey(), token);
  }

  // GET of a link: runs nothing (mail scanners open links)
  async actionPage(token: string): Promise<{ status: number; title: string }> {
    return (await this.loadAction(token)) ? { status: 200, title: TEXT.confirmTitle } : { status: 404, title: "" };
  }

  private async loadAction(token: string) {
    const fields = await this.readActionToken(token);
    if (!fields) return null;
    const [pluginKey, channelId, subscriberId, action] = fields as [string, number, number, string];
    if (pluginKey !== this.plugin.id || channelId !== this.world.channel.id) return null;
    const person = this.person(Number(subscriberId));
    const declared = this.host.grant.permissions.includes("hooks:publicActions") &&
      (this.plugin.manifest.hooks?.publicActions ?? []).some((a: Args) => a?.name === action);
    return person && declared ? { person, action } : null;
  }

  // POST of a link: the plugin's publicAction, with Broadcast's limits
  async publicAction(token: string, value: unknown, now = Date.now()): Promise<ActionAnswer> {
    const failed = (status: number): ActionAnswer => ({ status, title: TEXT.failedTitle, message: TEXT.failedBody });
    // Rack::Attack, before the controller: calls per link per minute
    const calls = (this.actionCalls.get(token) ?? []).filter((at) => at > now - 60_000);
    calls.push(now);
    this.actionCalls.set(token, calls);
    if (calls.length > PUBLIC.callsPerLinkPerMinute) return { status: 429, title: "Too many requests", message: null };

    const loaded = await this.loadAction(token);
    if (!loaded) return { status: 404, title: "", message: null };
    if (!(value == null || (typeof value === "string" && value.length <= PUBLIC.maxValueLength))) return { status: 422, title: "", message: null };
    if (this.actionsRunning >= PUBLIC.maxCallsAtOnce) return failed(503);

    const { person, action } = loaded;
    const request: Args = { name: action, subscriber_id: person.id, subscribed: person.is_active && !person.unsubscribed_at };
    if (typeof value === "string" && value.trim() !== "") request.value = value;
    this.actionsRunning++;
    let reply: Reply;
    try {
      reply = await this.invoke("publicAction", [request], PUBLIC.timeoutMs, { logFailure: false });
    } finally {
      this.actionsRunning--;
    }
    if (!reply.ok) {
      this.host.writeLog("error", `Public action ${action} failed: ${reply.error?.code}${reply.error?.message ? `: ${reply.error.message}` : ""}`, "publicAction");
      await this.save();
      return failed(503);
    }
    const answer = reply.result && typeof reply.result === "object" && !Array.isArray(reply.result) ? reply.result as Args : {};
    const text = (v: unknown, limit: number) => (typeof v === "string" ? v.trim().slice(0, limit) || null : null);
    return { status: 200, title: text(answer.title, PUBLIC.maxTitleLength) ?? TEXT.doneTitle, message: text(answer.message, PUBLIC.maxMessageLength) };
  }

  get versionLabel(): string {
    return this.devBuild ? `${this.plugin.version}+dev.${this.devBuild}` : this.plugin.version;
  }

  // Load the plugin folder again (after a build): new code and manifest, same data. Runs onUpgrade
  // when the manifest declares it, as Broadcast does after a deploy.
  // New permissions apply at once here; the message says that a server holds them for approval.
  async reload(): Promise<ReloadResult> {
    let next: { plugin: SandboxPlugin; code: string };
    try {
      next = await readPlugin(this.dir);
    } catch (err) {
      return { ok: false, message: `Could not read the plugin: ${(err as Error).message}` };
    }
    if (next.plugin.id !== this.plugin.id) {
      return { ok: false, message: `manifest.json id changed from ${this.plugin.id} to ${next.plugin.id}. Stop serve and start it again.` };
    }
    const from = this.versionLabel;
    const changed = next.code !== this.code || JSON.stringify(next.plugin.manifest) !== JSON.stringify(this.plugin.manifest);
    if (!changed) return { ok: true, message: "No change.", version: from };
    this.devBuild++;
    const before = this.host.grant.permissions;
    const after = manifestPermissions(next.plugin.manifest);
    const permissions = { added: after.filter((p) => !before.includes(p)), removed: before.filter((p) => !after.includes(p)) };
    this.plugin = next.plugin;
    this.code = next.code;
    this.host.grant = { pluginId: next.plugin.id, manifest: next.plugin.manifest, permissions: after };
    this.runner = this.runtime.plugin({ id: next.plugin.id, version: this.versionLabel, manifest: next.plugin.manifest, code: next.code });
    this.record({ op: "reload", args: { from, to: this.versionLabel, permissions } as Json, ok: true, ms: 0 });
    if (next.plugin.manifest.hooks?.onUpgrade === true) {
      await this.invoke("onUpgrade", [{ from_version: from, to_version: this.versionLabel, rollback: false }], LIFECYCLE.timeoutMs);
    }
    await this.save();
    const message = [
      `Reloaded ${this.versionLabel}.`,
      permissions.added.length && `Permissions added: ${permissions.added.join(", ")}.`,
      permissions.removed.length && `Permissions removed: ${permissions.removed.join(", ")}.`,
      permissions.added.length && "On a server, this version waits for an admin's approval.",
    ].filter(Boolean).join(" ");
    this.emit("reload", { version: this.versionLabel, message, permissions });
    return { ok: true, message, version: this.versionLabel, permissions };
  }

  async save() {
    this.world.store = this.host.store.entries();
    await Deno.mkdir(this.stateDir, { recursive: true });
    // The folder never goes into git, even in a repo whose .gitignore does not list it
    await Deno.writeTextFile(`${this.stateDir}/.gitignore`, "*\n");
    const temp = `${this.stateDir}/state.json.tmp`;
    await Deno.writeTextFile(temp, JSON.stringify(this.world, null, 1));
    await Deno.rename(temp, `${this.stateDir}/state.json`);
    this.emit("state", null);
  }

  async close() {
    await this.save();
    await this.runtime.close();
  }
}

// WebhookEventCreator#build_subscriber_event_data, in the spec's field order
function subscriberPayload(person: Person): Args {
  const values: Args = { ...person, subscriber_id: person.id, change_source: null };
  const payload: Args = {};
  for (const field of SUBSCRIBER_EVENT.fields) {
    if (SUBSCRIBER_EVENT.onlyWhenPresent.includes(field) && (values[field] == null || values[field] === "")) continue;
    payload[field] = values[field] ?? null;
  }
  return payload;
}

export async function readPlugin(dir: string): Promise<{ plugin: SandboxPlugin; code: string }> {
  const manifest = JSON.parse(await Deno.readTextFile(`${dir}/manifest.json`));
  const code = await Deno.readTextFile(`${dir}/dist/main.js`);
  return { plugin: { id: String(manifest.id), name: String(manifest.name ?? manifest.id), version: String(manifest.version ?? "0.0.0"), manifest }, code };
}

export async function openSandbox(dir: string): Promise<Sandbox> {
  const root = dir.replace(/\/+$/, "");
  const { plugin, code } = await readPlugin(root);
  let world: SandboxWorld;
  let fresh = false;
  try {
    world = JSON.parse(await Deno.readTextFile(`${root}/.sandbox/state.json`));
  } catch {
    world = seedWorld();
    fresh = true;
  }
  world.drafts ??= [];
  world.inbox ??= [];
  world.sent ??= [];
  const host = new SandboxHost(world, { pluginId: plugin.id, manifest: plugin.manifest, permissions: manifestPermissions(plugin.manifest) }, {
    now: () => Date.now() + (world.clockOffsetMs ?? 0),
  });
  const runtime = await startTestRuntime({ host });
  const runner = runtime.plugin({ id: plugin.id, version: plugin.version, manifest: plugin.manifest, code });
  const sandbox = new Sandbox(root, plugin, world, host, runtime, runner, code);
  // A new sandbox is the plugin's first enable in a channel
  if (fresh && plugin.manifest.hooks?.onInstall === true) await sandbox.lifecycle("onInstall");
  return sandbox;
}
