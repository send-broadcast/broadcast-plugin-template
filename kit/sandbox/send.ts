// Send-time plugin hooks for one sandbox email, as Plugins::SendHooks does them in Broadcast:
// mergeTags ({{ plugins.<ns>.<tag> }}), liquidFilters ({{ v | <ns>_<filter>: args }}), public action
// links ({{ plugins.<ns>.actions.<name> }}) and beforeSend. Calls go in batches of 100 people with a
// 5 second limit, and fail open: a failure gives empty values and no changes, and the email goes out.
// Liquid is rendered by liquidjs; Broadcast uses Ruby Liquid in lax mode, so rare templates can differ.
import { Liquid } from "./vendor/liquid.mjs";
import { sanitize } from "./sanitize.ts";
import type { Args, Json } from "../testing/mod.ts";
import type { Person } from "../testing/sandbox_host.ts";
import SPEC from "../spec/plugin-api-1.json" with { type: "json" };

const TAG = /plugins\.([a-z0-9_]+)\.([a-z0-9_]+)/g;
const ACTION = /plugins\.([a-z0-9_]+)\.actions\.([a-z0-9_]+)/g;
const FILTER = /\|\s*([a-z0-9_]+)/g;
const BATCH = SPEC.limits.sendHooks.batchSize;
const TIMEOUT_MS = SPEC.limits.sendHooks.timeoutMs;
const MAX_VALUE = SPEC.limits.sendHooks.maxValueLength;
const HEADER_NAME = /^X-[A-Za-z0-9-]{1,60}$/;

export type Decision = { skip: boolean; subject: string | null; prepend_html: string | null; append_html: string | null; headers: Record<string, string> };
const NO_CHANGE: Decision = { skip: false, subject: null, prepend_html: null, append_html: null, headers: {} };

// What SendHooks needs from the sandbox
export type SendHost = {
  plugin: { id: string; manifest: Args };
  permissions: string[];
  invoke(hook: string, args: Json[], timeoutMs: number): Promise<{ ok: boolean; result?: Json }>;
  actionUrl(person: Person, action: string): Promise<string>;
};

export const namespace = (pluginId: string) => pluginId.replace(/[.-]/g, "_");

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, "");
const blank = (value: unknown) => value == null || (typeof value === "string" && value.trim() === "");

type Tag = { name: string; html: boolean };

export class SendHooks {
  private ns: string;
  private tags: Tag[];
  private actions: string[];
  private filters = new Map<string, Tag>();
  private beforeSend: boolean;
  private values = new Map<string, Map<number, string>>();
  private filterValues = new Map<string, string>();
  private decisions = new Map<number, Decision>();
  private collecting: string[] | null = null;
  private html = true;
  private about: Args;

  constructor(private host: SendHost, texts: string[], options: { beforeSend?: boolean; about?: Args } = {}) {
    this.about = options.about ?? {};
    const text = texts.join("\n");
    const hooks = host.plugin.manifest.hooks ?? {};
    const outputHtml = host.permissions.includes("output:html");
    this.ns = namespace(host.plugin.id);
    const declared = (list: unknown[], name: string) =>
      (list ?? []).find((entry) => (typeof entry === "string" ? entry : (entry as Args)?.name) === name) as string | Args | undefined;
    this.tags = [...new Set([...text.matchAll(TAG)].filter((m) => m[1] === this.ns).map((m) => m[2]))].flatMap((name) => {
      const entry = declared(hooks.mergeTags, name);
      return entry ? [{ name, html: typeof entry === "object" && entry.output === "html" && outputHtml }] : [];
    });
    this.actions = [...new Set([...text.matchAll(ACTION)].filter((m) => m[1] === this.ns).map((m) => m[2]))].filter((name) =>
      host.permissions.includes("hooks:publicActions") && (hooks.publicActions ?? []).some((a: Args) => a?.name === name)
    );
    const wanted = new Set([...text.matchAll(FILTER)].map((m) => m[1]));
    for (const entry of hooks.liquidFilters ?? []) {
      const name = typeof entry === "string" ? entry : entry?.name;
      if (name && wanted.has(`${this.ns}_${name}`)) {
        this.filters.set(`${this.ns}_${name}`, { name, html: typeof entry === "object" && entry.output === "html" && outputHtml });
      }
    }
    this.beforeSend = options.beforeSend !== false && hooks.beforeSend === true && host.permissions.includes("hooks:beforeSend");
  }

  // Fetch the values for these people. render(person) renders one email; it is needed only when the
  // templates use plugin filters (their inputs are collected by rendering).
  async prepare(people: Person[], render: (person: Person) => Promise<unknown>) {
    for (let i = 0; i < people.length; i += BATCH) {
      const slice = people.slice(i, i + BATCH);
      for (const tag of this.tags) await this.fetchValues(tag, slice);
      if (this.filters.size) await this.fetchFilterValues(slice, render);
      if (this.beforeSend) await this.fetchDecisions(slice);
    }
  }

  // A Liquid engine with this send's plugin filters
  liquid(): Liquid {
    const engine = new Liquid({ strictFilters: false, strictVariables: false });
    for (const name of this.filters.keys()) {
      engine.registerFilter(name, (input: unknown, ...args: unknown[]) => this.filterResult(name, input, args));
    }
    return engine;
  }

  async rendering<T>(html: boolean, run: () => Promise<T>): Promise<T> {
    const previous = this.html;
    this.html = html;
    try {
      return await run();
    } finally {
      this.html = previous;
    }
  }

  private filterResult(name: string, input: unknown, args: unknown[]): string {
    const key = JSON.stringify([name, String(input ?? ""), args.map((a) => String(a ?? ""))]);
    if (this.collecting) {
      this.collecting.push(key);
      return "";
    }
    return this.present(this.filterValues.get(key) ?? "", this.filters.get(name)!, this.html);
  }

  async contextFor(person: Person, html: boolean): Promise<Args> {
    const plugin: Args = {};
    for (const tag of this.tags) plugin[tag.name] = this.present(this.values.get(tag.name)?.get(person.id) ?? "", tag, html);
    if (this.actions.length) {
      plugin.actions = {};
      for (const name of this.actions) plugin.actions[name] = await this.host.actionUrl(person, name);
    }
    return { plugins: Object.keys(plugin).length ? { [this.ns]: plugin } : {} };
  }

  decisionFor(person: Person): Decision {
    return this.decisions.get(person.id) ?? NO_CHANGE;
  }

  private present(value: string, tag: Tag, html: boolean): string {
    if (blank(value)) return value;
    if (html && tag.html) return sanitize(value);
    if (html) return escapeHtml(value);
    return tag.html ? stripTags(value) : value;
  }

  // What a send-time hook learns about each person: id and email; names and custom data only with a
  // subscribers permission
  private people(people: Person[]): Args[] {
    const details = this.host.permissions.some((name) => name.startsWith("subscribers:"));
    return people.map((p) => (details
      ? { id: p.id, email: p.email, first_name: p.first_name, last_name: p.last_name, custom_data: p.custom_data }
      : { id: p.id, email: p.email }));
  }

  private async call(hook: string, input: Args): Promise<Json | null> {
    const reply = await this.host.invoke(hook, [input], TIMEOUT_MS);
    return reply.ok ? reply.result ?? null : null;
  }

  private async fetchValues(tag: Tag, people: Person[]) {
    const answer = await this.call("mergeTags", { name: tag.name, subscribers: this.people(people) });
    const values = this.values.get(tag.name) ?? new Map<number, string>();
    this.values.set(tag.name, values);
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return;
    for (const p of people) {
      const value = (answer as Args)[String(p.id)];
      values.set(p.id, typeof value === "string" || typeof value === "number" ? String(value).slice(0, MAX_VALUE) : "");
    }
  }

  private async fetchFilterValues(people: Person[], render: (person: Person) => Promise<unknown>) {
    this.collecting = [];
    try {
      for (const p of people) await render(p);
    } finally {
      const keys = [...new Set(this.collecting)].filter((key) => !this.filterValues.has(key));
      this.collecting = null;
      const byName = new Map<string, string[]>();
      for (const key of keys) byName.set(JSON.parse(key)[0], [...(byName.get(JSON.parse(key)[0]) ?? []), key]);
      for (const [name, list] of byName) {
        for (let i = 0; i < list.length; i += BATCH) {
          const chunk = list.slice(i, i + BATCH);
          const items = chunk.map((key) => {
            const [, input, args] = JSON.parse(key);
            return { input, args };
          });
          const answer = await this.call("liquidFilter", { name: this.filters.get(name)!.name, items });
          chunk.forEach((key, index) => {
            const value = Array.isArray(answer) ? answer[index] : null;
            this.filterValues.set(key, typeof value === "string" || typeof value === "number" ? String(value).slice(0, MAX_VALUE) : "");
          });
        }
      }
    }
  }

  private async fetchDecisions(people: Person[]) {
    const answer = await this.call("beforeSend", { ...this.about, subscribers: this.people(people) });
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) return;
    for (const p of people) {
      const d = (answer as Args)[String(p.id)];
      if (!d || typeof d !== "object" || Array.isArray(d)) continue;
      const current = this.decisions.get(p.id) ?? NO_CHANGE;
      const subject = typeof d.subject === "string" ? d.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 998) || null : null;
      const join = (now: string | null, add: unknown) => {
        if (typeof add !== "string") return now;
        const clean = sanitize(add.slice(0, MAX_VALUE));
        return clean ? `${now ?? ""}${clean}` : now;
      };
      const headers = { ...current.headers };
      if (d.headers && typeof d.headers === "object") {
        for (const [name, value] of Object.entries(d.headers as Args)) {
          if (Object.keys(headers).length >= 10 || !HEADER_NAME.test(name) || !(typeof value === "string" || typeof value === "number")) continue;
          headers[name] ??= String(value).replace(/[\r\n]+/g, " ").trim().slice(0, 500);
        }
      }
      this.decisions.set(p.id, {
        skip: current.skip || d.skip === true, subject: subject ?? current.subject,
        prepend_html: join(current.prepend_html, d.prepend_html), append_html: join(current.append_html, d.append_html), headers,
      });
    }
  }
}
