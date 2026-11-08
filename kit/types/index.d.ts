// Types for Broadcast plugins (Plugin API v1). They describe what plugin_runtime/bootstrap.ts
// provides at run time and what Broadcast sends to each hook. See ../AGENTS.md.
//
// Use in a TypeScript plugin:  /// <reference types="broadcast-plugin/types" />
// (or a relative path to this file). `definePlugin` is a global: no import is needed or allowed.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// ---------- hook arguments ----------

/**
 * onEvent: the same event names as Broadcast's webhooks. Delivered at least once. data is the whole
 * webhook payload only for a plugin with a subscribers permission; any other plugin gets allowlisted
 * ids, state and counts, never email, names, custom_data or free text.
 */
export interface BroadcastEvent<Data = JsonObject> {
  id: string;
  type: string;
  occurred_at: string | null;
  data: Data;
}

/** onInstall and onUninstall (manifest hooks.onInstall / onUninstall: true). */
export interface LifecycleInput {
  version: string;
}

/**
 * onUpgrade (manifest hooks.onUpgrade: true): after a deploy or a rollback, once in each channel the
 * plugin is on. The place to migrate ctx.store rows. Delivered at least once: make it safe to repeat.
 */
export interface UpgradeInput {
  from_version: string;
  to_version: string;
  rollback: boolean;
}

/** onSchedule: one of manifest hooks.schedules. */
export interface ScheduleRun {
  name: string;
  scheduled_for: string;
}

/** publicActions.<name>: a person clicked a signed link in an email. */
export interface PublicActionRequest {
  name: string;
  /** Proven by the link's signature. */
  subscriber_id: number;
  /** From the link's ?value=. NOT signed: check it before you use it. Absent when the link has none. */
  value?: string;
  /** false when the person unsubscribed or is inactive. Links never expire, so decide what such a person may still do. */
  subscribed: boolean;
}

/** Shown to the person as plain text. HTML is never rendered. */
export interface PublicActionAnswer {
  title?: string;
  message?: string;
}

/** apiEndpoints.<name>: a request to POST|GET /api/plugins/<id>/<name>. */
export interface ApiRequest {
  name: string;
  method: "GET" | "POST";
  query: Record<string, string | string[]>;
  /** Parsed JSON, the raw text when it is not JSON, or null. */
  body: Json;
  token_label: string;
}

/** Return { status, body } to choose the HTTP status (200-599); any other value is the body. */
export type ApiResponse = { status?: number; body: Json } | Json;

/** pageData: asked by a plugin page through the bridge (op "pageData"). */
export interface PageDataRequest {
  page: number;
  input: JsonObject;
}

/** The input of a map hook (sequenceSteps, aiTools, mergeTags, liquidFilters): `name` picks the entry. */
export interface NamedInput {
  name: string;
  [key: string]: Json;
}

// ---------- ctx ----------

export interface Channel {
  id: number;
  name: string;
}

export interface Subscriber {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  is_active: boolean;
  subscribed_at: string | null;
  unsubscribed_at: string | null;
  tags: string[];
  custom_data: JsonObject;
  source: string | null;
  created_at: string;
  updated_at: string;
}

/** One answer per item of a bulk call; a bad item fails alone. */
export interface BulkItemResult {
  id?: number | string;
  ok: boolean;
  error?: { code: string; message: string };
  [key: string]: Json | undefined;
}

/** A refused host op rejects with this error (code: forbidden, not_found, invalid, rate_limited, call_ended, host_error). */
export interface HostError extends Error {
  name: "HostError";
  code: string;
}

export interface Store {
  get<T = Json>(key: string): Promise<T | null>;
  set(key: string, value: Json): Promise<Json>;
  delete(key: string): Promise<Json>;
  /** Adds to a whole number, atomically, and returns the new value. A missing key counts from 0. */
  increment(key: string, by?: number): Promise<number>;
  /**
   * Rows by key order: at most 100 (or limit) after the cursor key. Page on with the last key as the
   * cursor until a page comes back short.
   */
  list<T = Json>(page?: string | { prefix?: string; cursor?: string; limit?: number }): Promise<{ key: string; value: T }[]>;
}

export interface Log {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface Ctx {
  /** The channel this call runs in: { id, name } */
  readonly channel: Channel;
  readonly settings: {
    /** A non-secret setting; undefined when not set. */
    get<T = Json>(name: string): T | undefined;
    /** A secret setting, fetched from Broadcast for this call. Never cache, log or store it. */
    secret(name: string): Promise<string | null>;
  };
  readonly store: Store & {
    /** Data about one person, deleted with them. */
    forSubscriber(subscriberId: number | string): Store;
  };
  /** Shown on the plugin page. Never log personal data. Never throws. */
  readonly log: Log;
  readonly broadcast: {
    readonly subscribers: {
      get(id: number | string | { id: number | string }): Promise<Subscriber>;
      /** null when no subscriber in this channel has the email (get rejects with not_found instead). */
      find(email: string | { email: string }): Promise<Subscriber | null>;
      list(args?: { limit?: number; cursor?: string; updated_since?: string }): Promise<{ items: Subscriber[]; next_cursor: string | null }>;
      update(args: { id: number | string; first_name?: string | null; last_name?: string | null; custom_data?: JsonObject }): Promise<Subscriber>;
      bulkUpsert(args: {
        items: { email: string; first_name?: string | null; last_name?: string | null; custom_data?: JsonObject; tags?: string[] }[];
        idempotency_key: string;
      }): Promise<BulkItemResult[]>;
    };
    /** A tag that holds a topic is consent: add and remove throw forbidden, the bulk calls refuse per item. */
    readonly tags: {
      /** The tag names used in this channel */
      list(): Promise<string[]>;
      add(args: { subscriber_id: number | string; tags: string[] }): Promise<string[]>;
      remove(args: { subscriber_id: number | string; tags: string[] }): Promise<string[]>;
      bulkAdd(args: { subscriber_ids: (number | string)[]; tags: string[]; idempotency_key?: string }): Promise<BulkItemResult[]>;
      bulkRemove(args: { subscriber_ids: (number | string)[]; tags: string[]; idempotency_key?: string }): Promise<BulkItemResult[]>;
    };
    readonly events: {
      record(args: JsonObject): Promise<Json>;
      bulkRecord(args: { items: JsonObject[]; idempotency_key: string }): Promise<BulkItemResult[]>;
    };
    readonly broadcasts: ReadFacade;
    readonly sequences: ReadFacade;
    readonly segments: ReadFacade;
  };
}

export interface ReadFacade {
  get(id: number | string | { id: number | string }): Promise<JsonObject>;
  list(args?: JsonObject): Promise<Json>;
}

// ---------- the plugin ----------

type Awaitable<T> = T | Promise<T>;
// Results are sent as JSON (JSON.stringify), so any serializable value works.
type Fn<In, Out = unknown> = (input: In, ctx: Ctx) => Awaitable<Out>;
/** A map entry is a function or an object with a `run` function. */
type Entry<In, Out> = Fn<In, Out> | { run: Fn<In, Out>; [key: string]: unknown };
/** A map of named entries, picked by input.name; or one function for every name. */
type NamedHooks<In, Out> = Record<string, Entry<In, Out>> | Fn<In, Out>;

export interface PluginDefinition {
  /** manifest hooks.events */
  onEvent?: Fn<BroadcastEvent>;
  /**
   * Optional. Bulk work (an import, a bulk call, a broadcast send) delivers up to 100 events of one
   * type in one call. Without onEvents, each event of the batch goes to onEvent, in order. A throw
   * retries the whole batch, so skip repeats by event.id.
   */
  onEvents?: Fn<BroadcastEvent[]>;
  /** manifest hooks.schedules */
  onSchedule?: Fn<ScheduleRun>;
  /** The first time the plugin is enabled in a channel. At least once: safe to repeat. */
  onInstall?: Fn<LifecycleInput>;
  /** After a new version is deployed (or rolled back): migrate ctx.store here. */
  onUpgrade?: Fn<UpgradeInput>;
  /** Just before the plugin and its data are removed: clean up outside Broadcast. Once, 5 seconds. */
  onUninstall?: Fn<LifecycleInput>;
  /** Remove personal data kept outside ctx.store.forSubscriber. */
  onSubscriberDeleted?: Fn<{ subscriber_id: number; email: string }>;
  /** Data for the plugin's pages (ui.pages), asked through the bridge. */
  pageData?: Fn<PageDataRequest>;
  /** manifest hooks.apiEndpoints, by endpoint name. */
  apiEndpoints?: NamedHooks<ApiRequest, ApiResponse | unknown>;
  /** manifest hooks.publicActions, by action name. */
  publicActions?: NamedHooks<PublicActionRequest, PublicActionAnswer | void>;
  /** manifest hooks.sequenceSteps, by step name. */
  sequenceSteps?: NamedHooks<NamedInput, unknown>;
  /** manifest hooks.aiTools, by tool name. */
  aiTools?: NamedHooks<NamedInput, unknown>;
  /** manifest hooks.mergeTags (batched, sync, fails open). */
  mergeTags?: NamedHooks<NamedInput, unknown>;
  /** manifest hooks.liquidFilters (batched, sync, fails open). */
  liquidFilters?: NamedHooks<NamedInput, unknown>;
  /** manifest hooks.beforeSend: true (batched, sync, fails open). */
  beforeSend?: Fn<JsonObject>;
}

declare global {
  /** Provided by Broadcast. `export default definePlugin({ ... })` in dist/main.js. */
  function definePlugin<T extends PluginDefinition>(plugin: T): T;
}

// ---------- manifest.json ----------

export type SettingType = "string" | "text" | "url" | "integer" | "boolean" | "select";

export interface SettingDefinition {
  type: SettingType;
  label?: string;
  secret?: boolean;
  required?: boolean;
  options?: (string | { value: string; label?: string })[];
  /** What ctx.settings.get gives until an admin saves a value; the form starts with it. Must match
   * the type (integer: a whole number; boolean: true/false; select: one of options; url: "" or an
   * http(s) address). Not allowed on a secret. */
  default?: string | number | boolean;
  [key: string]: unknown;
}

export type NetworkRule = string | { fromSetting: string };

export interface Manifest {
  /** local.<name> unless signed by the plugin directory. */
  id: string;
  name: string;
  /** Semantic version, for example 1.2.0. */
  version: string;
  requires: { broadcast: string; pluginApi: "1" };
  permissions?: {
    subscribers?: "read" | "write" | ("read" | "write" | "export" | "create")[];
    tags?: "read" | "write";
    broadcasts?: "read";
    sequences?: "read";
    segments?: "read";
    network?: NetworkRule[];
    output?: "html";
    elevated?: string[];
    [area: string]: unknown;
  };
  /**
   * Events the plugin records. webhook: true lets an admin send the event to a webhook endpoint
   * (permission events:webhook, sensitive). The core builds that payload: event, plugin,
   * subscriber_id, value, properties, occurred_at. Never an email.
   */
  events?: Record<string, { value?: "decimal" | "integer"; properties?: Record<string, "string" | "decimal" | "integer" | "boolean">; webhook?: boolean }>;
  hooks?: {
    events?: string[];
    schedules?: { name: string; cron: string }[];
    apiEndpoints?: { name: string; method: "GET" | "POST"; permission: string }[];
    publicActions?: { name: string }[];
    sequenceSteps?: (string | { name: string; [key: string]: unknown })[];
    aiTools?: (string | { name: string; [key: string]: unknown })[];
    mergeTags?: (string | { name: string; [key: string]: unknown })[];
    liquidFilters?: (string | { name: string; [key: string]: unknown })[];
    beforeSend?: boolean;
    onSubscriberDeleted?: boolean;
    onInstall?: true;
    onUpgrade?: true;
    onUninstall?: true;
  };
  settings?: Record<string, SettingDefinition>;
  ui?: { pages?: { slot: "nav" | "subscriberPanel" | "dashboardWidget"; title: string; path: string }[] };
}
