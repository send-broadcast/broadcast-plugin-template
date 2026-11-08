// The Host API of the plugin sandbox (`broadcast-plugin serve`): a FakeHost that answers every op
// of plugin API 1 from a small Broadcast world (one channel, people, tags, topics, plugin events),
// with the permissions of the plugin's manifest. It copies the rules of Broadcast's Host API
// (app/services/plugins/host_api): spec/plugin-api-1-vectors.json holds the cases that both must
// pass (test/sandbox_vectors_test.ts here, test/services/plugins/host_api_vectors_test.rb in Broadcast).
//
// Not in the sandbox yet: broadcasts, sequences and segments reads, the event quota, suppressed
// addresses. The hourly read limit without subscribers:export is applied.
import { type Args, FakeHost, type Json, OpError, type StoreEntry } from "./mod.ts";
import SPEC from "../spec/plugin-api-1.json" with { type: "json" };

export type Person = {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  is_active: boolean;
  subscribed_at: string | null;
  unsubscribed_at: string | null;
  tags: string[];
  custom_data: Record<string, Json>;
  source: string | null;
  signup_ref: string | null;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
  // Erased (GDPR): gone for plugins, like Subscriber.visible
  erased?: boolean;
};
export type Topic = { name: string; storage: "tag" | "custom_data"; tag_name?: string; custom_data_key?: string };
export type PluginEvent = {
  id: number;
  name: string;
  subscriber_id: number | null;
  email: string;
  occurred_at: string;
  value: Json;
  properties: Record<string, Json>;
  idempotency_key: string | null;
};
export type LogLine = { level: string; message: string; at: string; hook?: string };

// Everything the sandbox keeps between runs (.sandbox/state.json)
export type World = {
  channel: { id: number; name: string };
  people: Person[];
  topics: Topic[];
  events: PluginEvent[];
  store: StoreEntry[];
  settings: Record<string, Json>;
  logs: LogLine[];
  reads: Record<string, number>;
  nextId: number;
};

export type Grant = { pluginId: string; manifest: Args; permissions: string[] };

const LIMITS = SPEC.limits;
const PERMISSIONS = SPEC.permissions as unknown as Record<string, { tier?: number | null; ops?: string[]; forbidden?: boolean }>;
const OP_PERMISSION = new Map<string, string>(
  Object.entries(PERMISSIONS).flatMap(([name, p]) => (p.ops ?? []).map((op) => [op, name] as [string, string])),
);
const BASIC = Object.entries(PERMISSIONS).filter(([, p]) => p.tier === 0).map(([name]) => name);
const EMAIL = /^[^@\s]+@[^@\s]+$/;
const DAY_MS = 86_400_000;

// Broadcast's catalog permissions for a manifest (Plugins::ManifestValidator#check_permissions and hooks)
export function manifestPermissions(manifest: Args): string[] {
  const out = new Set<string>();
  const add = (name: string) => {
    const p = PERMISSIONS[name];
    if (p && !p.forbidden && p.tier !== 0) out.add(name);
  };
  for (const [area, value] of Object.entries(manifest.permissions ?? {})) {
    if (area === "network") {
      for (const rule of [value].flat()) {
        add("network");
        if (rule && typeof rule === "object" && "fromSetting" in rule) add("network:fromSetting");
        else if (String(rule).startsWith("*.")) add("network:wildcard");
      }
    } else if (area === "output") {
      add(`output:${value}`);
    } else if (area === "elevated") {
      for (const name of [value].flat().map(String)) if (PERMISSIONS[name]?.tier === 3) add(name);
    } else {
      const modes = [value].flat().map(String);
      if (modes.includes("write") && PERMISSIONS[`${area}:read`] && !modes.includes("read")) modes.push("read");
      for (const mode of modes) add(`${area}:${mode}`);
    }
  }
  const hooks = manifest.hooks ?? {};
  if ((hooks.apiEndpoints ?? []).length) add("hooks:apiEndpoints");
  if ((hooks.publicActions ?? []).length) add("hooks:publicActions");
  if (hooks.beforeSend === true) add("hooks:beforeSend");
  for (const declaration of Object.values(manifest.events ?? {})) {
    if ((declaration as Args)?.webhook === true) add("events:webhook");
  }
  return [...out].sort();
}

export function emptyWorld(name = "Sandbox"): World {
  return { channel: { id: 1, name }, people: [], topics: [], events: [], store: [], settings: {}, logs: [], reads: {}, nextId: 1 };
}

// Ruby's blank?: nil, false, "", "  ", [] and {} are blank; 0 is not
function blank(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

// Ruby's to_i: "12abc" -> 12, "abc" -> 0, null -> 0
function toI(value: unknown): number {
  if (typeof value === "number") return Math.trunc(value);
  const match = String(value ?? "").trim().match(/^[+-]?\d+/);
  return match ? Number(match[0]) : 0;
}

// Ruby's Array(): null -> [], a list stays, anything else -> [it]
function list(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isObject(value: unknown): value is Args {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isoTime(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim())) return null;
  const time = Date.parse(value.trim());
  if (Number.isNaN(time)) return null;
  // Date.parse rolls 2026-02-30 over to March; Broadcast refuses it
  const [y, m, d] = value.trim().slice(0, 10).split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCMonth() === m - 1 && day.getUTCDate() === d ? time : null;
}

const invalid = (message: string) => new OpError("invalid", message);

// Store keys that start with __ are Broadcast's own (PluginStoreEntry::RESERVED_PREFIX): hidden from
// get and list, refused by set, delete and increment
export const RESERVED_PREFIX = "__";
const reserved = (key: unknown) => String(key ?? "").startsWith(RESERVED_PREFIX);
function writableKey(key: unknown): string {
  if (reserved(key)) throw invalid(`Store keys that start with ${RESERVED_PREFIX} are Broadcast's own.`);
  return String(key ?? "");
}
const forbidden = (message: string) => new OpError("forbidden", message);
const notFound = (message: string) => new OpError("not_found", message);

// Tags as acts-as-taggable keeps them: stripped, no blanks, one per name whatever the case
function cleanTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags.map((t) => String(t).trim()).filter(Boolean)) {
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

export type SandboxOptions = {
  // The clock (the sandbox's Clock tab moves it)
  now?: () => number;
  // Smaller limits for a test
  limits?: { subscriberReadsPerHour?: number };
};

export class SandboxHost extends FakeHost {
  private now: () => number;
  private readCap: number;

  constructor(public world: World, public grant: Grant, options: SandboxOptions = {}) {
    super();
    this.now = options.now ?? Date.now;
    this.readCap = options.limits?.subscriberReadsPerHour ?? LIMITS.subscriberReadsPerHour;
    this.store.restore(world.store);
    const ops: Record<string, (args: Args) => Json | Promise<Json>> = {
      "channel.get": () => ({ ...this.world.channel }),
      "settings.secret": (a) => this.settingsSecret(a),
      "store.get": (a) => {
        const scope = this.storeScope(a);
        return reserved(a.key) ? null : this.store.get(String(a.key ?? ""), scope);
      },
      "store.set": (a) => this.storeSet(a),
      "store.delete": (a) => {
        const scope = this.storeScope(a);
        return this.store.delete(writableKey(a.key), scope);
      },
      "store.increment": (a) => this.storeIncrement(a),
      "store.list": (a) => this.storeList(a),
      "log.write": (a) => this.logWrite(a),
      "subscribers.get": (a) => this.serialize(this.admitRead(this.findPerson(a.id))),
      "subscribers.find": (a) => this.subscribersFind(a),
      "subscribers.list": (a) => this.subscribersList(a),
      "subscribers.update": (a) => this.subscribersUpdate(a),
      "subscribers.bulkUpsert": (a) => this.bulkUpsert(a),
      "tags.list": () => this.tagsList(),
      "tags.add": (a) => this.changeTags(this.findPerson(a.subscriber_id), a.tags, "add"),
      "tags.remove": (a) => this.changeTags(this.findPerson(a.subscriber_id), a.tags, "remove"),
      "tags.bulkAdd": (a) => this.bulkTags(a, "add"),
      "tags.bulkRemove": (a) => this.bulkTags(a, "remove"),
      // With a key the answer is kept like a bulk call's; with none nothing is kept
      "events.record": (a) => blank(a.idempotency_key) ? this.recordEvents([a])[0] : (this.eventsBulkRecord({ items: [a], idempotency_key: a.idempotency_key }) as Json[])[0],
      "events.bulkRecord": (a) => this.eventsBulkRecord(a),
    };
    for (const [op, handler] of Object.entries(ops)) this.handle(op, handler);
  }

  // Deny by default, like Plugins::HostApi::OperationsController: the op must exist and the grant
  // must hold its catalog permission
  protected override async run(op: string, args: Args, token: string) {
    const permission = OP_PERMISSION.get(op);
    const allowed = permission && (BASIC.includes(permission) || this.grant.permissions.includes(permission));
    const answer = !allowed || !this.handlers.has(op)
      ? { status: 403, body: { ok: false, error: { code: "forbidden", message: `The plugin may not use ${op}.${permission && !allowed ? ` It needs the permission ${permission} in manifest.json.` : ""}` } } }
      : await super.run(op, isObject(args) ? args : {}, token);
    this.world.store = this.store.entries();
    return answer;
  }

  permitted(name: string): boolean {
    return BASIC.includes(name) || this.grant.permissions.includes(name);
  }

  // --- people ---

  people(): Person[] {
    return this.world.people.filter((p) => !p.erased);
  }

  private findPerson(id: unknown): Person {
    const want = typeof id === "number" ? id : typeof id === "string" && /^\s*\d/.test(id) ? toI(id) : NaN;
    const person = this.people().find((p) => p.id === want);
    if (!person) throw notFound("No such subscriber in this channel.");
    return person;
  }

  // Without export, at most subscriberReadsPerHour different people per hour (REVIEW S2)
  private admitRead(person: Person): Person {
    if (this.permitted("subscribers:export")) return person;
    const hourAgo = this.now() - 3_600_000;
    for (const [id, at] of Object.entries(this.world.reads)) if (at < hourAgo) delete this.world.reads[id];
    if (!(person.id in this.world.reads) && Object.keys(this.world.reads).length >= this.readCap) {
      throw forbidden(`Reading more than ${this.readCap} different subscribers an hour needs subscribers:export.`);
    }
    this.world.reads[person.id] ??= this.now();
    return person;
  }

  serialize(p: Person): Args {
    return {
      id: p.id, email: p.email, first_name: p.first_name, last_name: p.last_name, is_active: p.is_active,
      subscribed_at: p.subscribed_at, unsubscribed_at: p.unsubscribed_at, tags: [...p.tags], custom_data: structuredClone(p.custom_data),
      source: p.source, signup_ref: p.signup_ref, confirmed_at: p.confirmed_at, created_at: p.created_at, updated_at: p.updated_at,
    };
  }

  private subscribersFind(a: Args) {
    const email = String(a.email ?? "").trim().toLowerCase();
    const person = this.people().find((p) => p.email === email);
    return person ? this.serialize(this.admitRead(person)) : null;
  }

  private subscribersList(a: Args) {
    const exporting = !blank(a.cursor) || toI(a.limit) > LIMITS.subscribersPageLimit;
    if (exporting && !this.permitted("subscribers:export")) throw forbidden("Reading past the first 100 subscribers needs subscribers:export.");
    const max = exporting ? LIMITS.subscribersExportPageLimit : LIMITS.subscribersPageLimit;
    const limit = Math.min(Math.max(a.limit == null ? LIMITS.subscribersPageLimit : toI(a.limit), 1), max);
    let since: number | null = null;
    if (!blank(a.updated_since)) {
      since = isoTime(a.updated_since);
      if (since === null) throw invalid("updated_since must be an ISO 8601 time.");
    }
    const after = blank(a.cursor) ? 0 : toI(a.cursor);
    const items = this.people().filter((p) => p.email && p.id > after && (since === null || Date.parse(p.updated_at) >= since))
      .sort((x, y) => x.id - y.id).slice(0, limit + 1);
    const more = items.length > limit;
    const page = items.slice(0, limit);
    return { items: page.map((p) => this.serialize(p)), next_cursor: more ? String(page.at(-1)!.id) : null };
  }

  private subscribersUpdate(a: Args) {
    const person = this.admitRead(this.findPerson(a.id));
    this.applyFields(person, a);
    person.updated_at = new Date(this.now()).toISOString();
    return this.serialize(person);
  }

  private applyFields(person: Person, item: Args) {
    this.refuseTopicKeys(item.custom_data);
    for (const field of SPEC.updatableFields as ("first_name" | "last_name")[]) {
      if (field in item) person[field] = item[field] == null ? null : String(item[field]);
    }
    if (isObject(item.custom_data)) person.custom_data = { ...person.custom_data, ...item.custom_data };
  }

  private bulkUpsert(a: Args) {
    const items = this.bulkItems(a.items);
    return this.idempotent(a.idempotency_key, "subscribers.bulkUpsert", () =>
      items.map((item) => {
        try {
          return this.upsertOne(item);
        } catch (err) {
          if (!(err instanceof OpError)) throw err;
          return { email: isObject(item) ? item.email ?? null : null, ok: false, error: { code: err.code, message: err.message } };
        }
      }));
  }

  private upsertOne(item: unknown) {
    if (!isObject(item) || blank(item.email)) throw invalid("Each item must be an object with an email.");
    const email = String(item.email).trim().toLowerCase();
    let person = this.world.people.find((p) => p.email === email);
    const created = !person;
    if (person?.erased) throw invalid("This email belongs to an erased subscriber.");
    if (!person) {
      if (!this.permitted("subscribers:create")) throw forbidden("Creating subscribers needs subscribers:create.");
      const hourAgo = this.now() - 3_600_000;
      const source = `plugin:${this.grant.pluginId}`;
      if (this.world.people.filter((p) => p.source === source && Date.parse(p.created_at) >= hourAgo).length >= LIMITS.createLimitPerHour) {
        throw new OpError("rate_limited", "Too many new subscribers this hour.");
      }
      person = this.newPerson({ email, source });
    }
    // Checked before anything changes, as Broadcast's save fails as a whole
    this.refuseTopicKeys(item.custom_data);
    const tags = list(item.tags).map(String);
    this.refuseTopicTags(tags);
    if (created) this.world.people.push(person);
    this.applyFields(person, item);
    if (tags.length) person.tags = cleanTags([...person.tags, ...tags]);
    person.updated_at = new Date(this.now()).toISOString();
    return { email, ok: true, id: person.id, created };
  }

  newPerson(fields: Partial<Person> & { email: string }): Person {
    const at = new Date(this.now()).toISOString();
    return {
      id: this.world.nextId++, first_name: null, last_name: null, is_active: true, subscribed_at: at, unsubscribed_at: null, tags: [],
      custom_data: {}, source: null, signup_ref: null, confirmed_at: null, created_at: at, updated_at: at, ...fields,
      email: fields.email.trim().toLowerCase(),
    };
  }

  private tagsList() {
    const names = new Map<string, string>();
    for (const p of this.world.people) for (const tag of p.tags) if (!names.has(tag.toLowerCase())) names.set(tag.toLowerCase(), tag);
    return [...names.values()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)).slice(0, 1000);
  }

  private changeTags(person: Person, tags: unknown, direction: "add" | "remove") {
    const names = list(tags).map(String).filter((name) => !blank(name));
    if (!names.length) throw invalid("tags must be a list of names.");
    this.refuseTopicTags(names);
    if (direction === "add") person.tags = cleanTags([...person.tags, ...names]);
    else {
      const gone = new Set(cleanTags(names));
      person.tags = person.tags.filter((tag) => !gone.has(tag));
    }
    person.updated_at = new Date(this.now()).toISOString();
    return [...person.tags];
  }

  private bulkTags(a: Args, direction: "add" | "remove") {
    const ids = this.bulkItems(a.subscriber_ids);
    return ids.map((id) => {
      const person = this.people().find((p) => p.id === toI(id));
      if (!person) return { id, ok: false, error: { code: "not_found", message: "No such subscriber in this channel." } };
      try {
        this.changeTags(person, a.tags, direction);
        return { id: person.id, ok: true };
      } catch (err) {
        if (!(err instanceof OpError)) throw err;
        return { id, ok: false, error: { code: err.code, message: err.message } };
      }
    });
  }

  private refuseTopicTags(names: string[]) {
    const topic = this.world.topics.find((t) => t.storage === "tag" && names.some((name) => name.trim().toLowerCase() === String(t.tag_name).toLowerCase()));
    if (topic) throw forbidden(`The tag ${topic.tag_name} is a topic. A topic is the subscriber's consent, so a plugin cannot change it.`);
  }

  private refuseTopicKeys(customData: unknown) {
    if (!isObject(customData)) return;
    const topic = this.world.topics.find((t) => t.storage === "custom_data" && t.custom_data_key! in customData);
    if (topic) throw forbidden(`The custom field ${topic.custom_data_key} is a topic. A topic is the subscriber's consent, so a plugin cannot change it.`);
  }

  private bulkItems(items: unknown): unknown[] {
    if (!Array.isArray(items)) throw invalid("items must be a list.");
    if (items.length > LIMITS.bulkLimit) throw invalid(`A bulk call takes at most ${LIMITS.bulkLimit} items.`);
    return items;
  }

  // Broadcast keeps a bulk call's answer under its key in the plugin's own store
  private idempotent(key: unknown, op: string, run: () => Json): Json {
    if (blank(key)) throw invalid("A bulk call needs an idempotency_key.");
    const entryKey = `__idem:${op}:${String(key).slice(0, 100)}`;
    if (this.store.has(entryKey)) return this.store.get(entryKey);
    const result = run();
    this.store.set(entryKey, result);
    return result;
  }

  // --- store, settings, log ---

  private storeScope(a: Args): { subscriber_id?: Json } | undefined {
    if (blank(a.subscriber_id)) return undefined;
    return { subscriber_id: this.findPerson(a.subscriber_id).id };
  }

  private storeSet(a: Args) {
    const scope = this.storeScope(a);
    const key = writableKey(a.key);
    if (!key) throw invalid("Key can't be blank");
    if (key.length > 200) throw invalid("Key is too long (maximum is 200 characters)");
    const bytes = new TextEncoder().encode(JSON.stringify(a.value ?? null)).length;
    if (bytes > 256 * 1024) throw invalid("Value is too long (maximum is 262144 characters)");
    this.store.set(key, a.value ?? null, scope);
    return true;
  }

  private storeIncrement(a: Args) {
    const by = a.by ?? 1;
    if (!Number.isInteger(by)) throw invalid("by must be a whole number.");
    const scope = this.storeScope(a);
    const key = writableKey(a.key);
    const current = this.store.has(key, scope) ? this.store.get(key, scope) : 0;
    if (!Number.isInteger(current)) throw invalid(`${key} does not hold a whole number.`);
    return this.store.increment(key, by as number, scope);
  }

  private storeList(a: Args) {
    return this.store.list(blank(a.prefix) ? "" : String(a.prefix), this.storeScope(a), {
      cursor: blank(a.cursor) ? undefined : String(a.cursor),
      limit: a.limit == null || a.limit === false ? LIMITS.storeListLimit : toI(a.limit),
      hideReserved: true,
    });
  }

  private settingsSecret(a: Args) {
    const name = String(a.name ?? "");
    if (!(name in (this.grant.manifest.settings ?? {}))) throw notFound(`The plugin declares no setting ${name}.`);
    return this.world.settings[name] ?? null;
  }

  private logWrite(a: Args) {
    this.writeLog(a.level, a.message);
    return true;
  }

  // A line on the plugin's log page. Broadcast hides email addresses in logs.
  writeLog(level: unknown, message: unknown, hook?: string) {
    const safeLevel = ["info", "warn", "error"].includes(String(level)) ? String(level) : "info";
    const text = String(message ?? "").slice(0, 2000).replace(/([^\s@<>"']{1})[^\s@<>"']*@([^\s@<>"']+)/g, "$1***@$2");
    this.world.logs.push({ level: safeLevel, message: text, at: new Date(this.now()).toISOString(), ...(hook ? { hook } : {}) });
    if (this.world.logs.length > 1000) this.world.logs.splice(0, this.world.logs.length - 1000);
  }

  // --- events ---

  private eventsBulkRecord(a: Args) {
    const items = this.bulkItems(a.items);
    return this.idempotent(a.idempotency_key, "events.bulkRecord", () => this.recordEvents(items));
  }

  private recordEvents(items: unknown[]): Json[] {
    return items.map((item) => {
      try {
        this.recordEvent(item);
        return { ok: true };
      } catch (err) {
        if (!(err instanceof OpError)) throw err;
        return { ok: false, error: { code: err.code, message: err.message } };
      }
    });
  }

  private recordEvent(item: unknown) {
    if (!isObject(item)) throw invalid("Each event must be an object.");
    const declaration = (this.grant.manifest.events ?? {})[String(item.name ?? "")];
    if (!isObject(declaration)) throw invalid(`${JSON.stringify(item.name ?? null)} is not an event this plugin declares.`);
    let person = blank(item.subscriber_id) ? undefined : this.people().find((p) => p.id === toI(item.subscriber_id));
    const email = String(person?.email ?? item.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(email)) throw invalid("An event needs an email or a subscriber_id of this channel.");
    person ??= this.people().find((p) => p.email === email);
    let occurred = this.now();
    if (!blank(item.occurred_at)) {
      const time = isoTime(item.occurred_at);
      if (time === null) throw invalid("occurred_at must be an ISO 8601 time.");
      if (time > this.now() + DAY_MS) throw invalid("occurred_at is in the future.");
      occurred = time;
    }
    const value = typed(item.value, declaration.value, "value");
    const properties = item.properties ?? {};
    if (!isObject(properties)) throw invalid("properties must be an object.");
    const declared = isObject(declaration.properties) ? declaration.properties : {};
    const typedProperties: Record<string, Json> = {};
    for (const [key, raw] of Object.entries(properties)) {
      if (!(key in declared)) throw invalid(`${key} is not a declared property of this event.`);
      typedProperties[key] = typed(raw, declared[key], key);
    }
    const key = blank(item.idempotency_key) ? null : String(item.idempotency_key).slice(0, 200);
    if (key && this.world.events.some((e) => e.idempotency_key === key && e.name === item.name)) return;
    this.world.events.push({
      id: this.world.nextId++, name: String(item.name), subscriber_id: person?.is_active ? person.id : null, email,
      occurred_at: new Date(occurred).toISOString(), value, properties: typedProperties, idempotency_key: key,
    });
    if (declaration.webhook === true) {
      this.logWrite({ level: "info", message: `Sandbox: a webhook endpoint that ticks plugin.${this.grant.pluginId}.${item.name} would get this event.` });
    }
  }
}

// Plugins::HostApi::EventOps#typed_value
function typed(value: unknown, type: unknown, name: string): Json {
  if (value === null || value === undefined) return null;
  const bad = () => invalid(`${name} must be a ${type}.`);
  switch (type) {
    case "decimal": {
      const text = String(value).trim();
      if (typeof value === "boolean" || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) throw bad();
      return String(Number(text));
    }
    case "integer": {
      const text = String(value).trim();
      if (typeof value === "boolean" || !/^[+-]?\d+$/.test(text.replaceAll("_", ""))) throw bad();
      return Number(text.replaceAll("_", ""));
    }
    case "string":
      if (typeof value !== "string") throw bad();
      return value.slice(0, 500);
    case "boolean":
      if (typeof value !== "boolean") throw bad();
      return value;
    default:
      throw invalid(`${name} is not declared for this event.`);
  }
}
