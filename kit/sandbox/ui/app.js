// The sandbox screen: the plugin's pages (with the bridge) and the tabs Compose, Inbox, People,
// Events, Time, Ops, Store, Logs and Settings. It reads /api/state and listens to /api/stream for live changes.
const main = document.getElementById("main");
let state = null;
let frame = null;
// The last hook answer on the Events and Time tabs, kept when a tab redraws
const answers = {};
// Choices in the Events and Time tabs, kept when a tab redraws
const picks = {};
const keep = (node) => {
  if (picks[node.id] !== undefined) node[node.type === "checkbox" ? "checked" : "value"] = picks[node.id];
  node.addEventListener("change", () => (picks[node.id] = node.type === "checkbox" ? node.checked : node.value));
  return node;
};
const answerBox = (view, note) => el("div", { class: "result" }, answers[view] ? el("pre", {}, JSON.stringify(answers[view], null, 2)) : el("p", { class: "note" }, note));
const answer = async (view, reply) => {
  answers[view] = reply;
  await render();
};

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null) node.append(child instanceof Node ? child : String(child));
  return node;
};
const short = (value, max = 160) => {
  const text = value === undefined ? "" : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString() : "");
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");
// Cron times are UTC on a server, so schedules show UTC
const utc = (iso) => (iso ? `${new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC` : "");

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-sandbox": "1" }, body: JSON.stringify(body ?? {}) });
  return await res.json();
}

async function load() {
  state = await (await fetch("/api/state")).json();
  document.getElementById("plugin-line").textContent = `${state.plugin.id} ${state.version}`;
  document.getElementById("ops-count").textContent = state.ops.length || "";
  document.getElementById("inbox-count").textContent = state.inbox.length || "";
  const links = document.getElementById("page-links");
  links.replaceChildren(...(state.plugin.manifest.ui?.pages ?? []).map((page, index) =>
    page.slot === "nav" ? el("a", { href: `#page-${index}`, "data-view": `page-${index}` }, page.title ?? `Page ${index + 1}`) : null
  ));
}

// --- views ---

// An email shown as it renders, in a frame with no scripts; links open in a new tab
function emailFrame(email) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font:15px system-ui,sans-serif;margin:16px;color:#141a24;background:#fff}</style></head><body>${email.body}</body></html>`;
  return el("iframe", { class: "email-frame", sandbox: "allow-popups allow-popups-to-escape-sandbox", srcdoc: doc, title: email.subject || "Email" });
}

const views = {
  compose() {
    const drafts = state.drafts;
    const current = drafts.find((d) => String(d.id) === sessionStorage.getItem("draft")) ?? drafts.at(-1) ?? { subject: "", preheader: "", body: "" };
    const live = state.people.filter((p) => !p.erased);
    const recipients = live.filter((p) => p.is_active).length;
    const subject = el("input", { id: "draft-subject", value: current.subject, placeholder: "Subject" });
    const preheader = el("input", { id: "draft-preheader", value: current.preheader, placeholder: "Preheader" });
    const body = el("textarea", { id: "draft-body", rows: "12", class: "mono" }, current.body);
    const person = el("select", { id: "preview-person" }, live.map((p) => el("option", { value: p.id }, `${p.id} · ${p.email}`)));
    const out = el("div", { class: "result" }, el("p", { class: "note" }, "The preview shows here: plugin merge tags, filters, links and beforeSend, for one person."));
    const save = async () => {
      const draft = await post("/api/drafts", { id: current.id, subject: subject.value, preheader: preheader.value, body: body.value });
      sessionStorage.setItem("draft", String(draft.id));
      current.id = draft.id;
      return draft;
    };
    return el("div", { class: "view" },
      el("h1", {}, "Compose"),
      el("p", { class: "note" }, "Write a test email. Paste the HTML a plugin page gives you, such as a poll's links. Liquid works as in Broadcast: {{ first_name }}, {{ plugins.<plugin>.<tag> }}."),
      drafts.length > 1 ? el("label", {}, "Draft", el("select", { onchange: (e) => { sessionStorage.setItem("draft", e.target.value); render(); } },
        drafts.map((d) => el("option", { value: d.id, selected: d.id === current.id }, `${d.id} · ${d.subject || "(no subject)"}`)))) : null,
      el("label", {}, "Subject", subject), el("label", {}, "Preheader", preheader), el("label", {}, "Body (HTML)", body),
      el("div", { class: "row" },
        el("button", { onclick: async () => { await save(); await render(); } }, "Save"),
        el("button", { onclick: () => { sessionStorage.removeItem("draft"); post("/api/drafts", {}).then((d) => { sessionStorage.setItem("draft", String(d.id)); render(); }); } }, "New draft"),
        el("label", {}, "Preview as", person),
        el("button", { onclick: async () => {
          const draft = await save();
          const email = await post("/api/preview", { draft_id: draft.id, subscriber_id: Number(person.value) });
          out.replaceChildren(el("p", {}, el("strong", {}, email.subject), email.skip ? el("span", { class: "pill bad" }, " beforeSend skips this person") : ""), emailFrame(email));
        } }, "Preview"),
        el("button", { class: "primary", onclick: async () => {
          const draft = await save();
          const result = await post("/api/send", { draft_id: draft.id });
          if (result.ok === false) return alertLine(result.error);
          location.hash = "#inbox";
        } }, `Send to ${recipients} people`),
      ),
      out,
    );
  },

  inbox() {
    const list = state.inbox.slice().reverse();
    const shown = list.find((m) => String(m.id) === sessionStorage.getItem("email")) ?? list[0];
    return el("div", { class: "view" },
      el("h1", {}, "Inbox"),
      el("p", { class: "note" }, "Every email the sandbox sent. Nothing leaves your computer. Click a link in an email to act as that person."),
      list.length ? el("div", { class: "inbox" },
        el("table", {}, el("tbody", {}, list.map((m) =>
          el("tr", { class: m === shown ? "hook" : "", style: "cursor:pointer", onclick: () => { sessionStorage.setItem("email", String(m.id)); render(); } },
            el("td", { class: "nowrap" }, time(m.sent_at)), el("td", { class: "mono" }, m.to), el("td", {}, m.subject))
        ))),
        shown ? el("div", { class: "result" }, el("p", {}, el("strong", {}, shown.subject), " · ", el("span", { class: "mono" }, shown.to)),
          Object.keys(shown.headers ?? {}).length ? el("p", { class: "note mono" }, Object.entries(shown.headers).map(([k, v]) => `${k}: ${v}`).join(" · ")) : null,
          emailFrame(shown)) : null,
      ) : el("p", { class: "note" }, "No emails yet. Write one in Compose and send it."),
    );
  },

  people() {
    const events = state.plugin.manifest.hooks?.events ?? [];
    return el("div", { class: "view" },
      el("h1", {}, "People"),
      el("p", { class: "note" }, `The test channel "${state.channel.name}". Unsubscribe, resubscribe or erase a person to see what the plugin does.`),
      el("form", { class: "row", onsubmit: async (event) => {
        event.preventDefault();
        const form = event.target;
        const body = Object.fromEntries(["email", "first_name", "signup_ref"].map((name) => [name, form.elements[name].value]));
        const reply = await post("/api/people", body);
        if (reply.ok === false) return alertLine(reply.error);
        form.reset();
        await render();
      } },
        el("label", {}, "Email", el("input", { name: "email", type: "email", required: true, placeholder: "new@example.test" })),
        el("label", {}, "First name", el("input", { name: "first_name" })),
        el("label", {}, "Signup ref", el("input", { name: "signup_ref", placeholder: "from a referral link" })),
        el("button", { class: "primary" }, "Add a person"),
        el("span", { class: "note" }, events.includes("subscriber.created") ? "A new person fires subscriber.created, as a signup does." : "")),
      el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "ID"), el("th", {}, "Email"), el("th", {}, "Name"), el("th", {}, "Tags"), el("th", {}, "State"), el("th", {}, ""))),
        el("tbody", {}, state.people.map((p) =>
          el("tr", { class: p.erased ? "dim" : "" },
            el("td", { class: "mono" }, p.id), el("td", { class: "mono" }, p.email), el("td", {}, [p.first_name, p.last_name].filter(Boolean).join(" ")),
            el("td", {}, p.tags.map((tag) => el("span", { class: "pill" }, tag))),
            el("td", {}, p.erased ? el("span", { class: "pill bad" }, "erased") : el("span", { class: `pill ${p.is_active ? "ok" : ""}` }, p.is_active ? "subscribed" : "unsubscribed")),
            el("td", {}, p.erased ? "" : el("div", { class: "row" },
              el("button", { onclick: () => act(`/api/people/${p.id}/${p.is_active ? "unsubscribe" : "resubscribe"}`) }, p.is_active ? "Unsubscribe" : "Resubscribe"),
              events.includes("subscriber.created") ? el("button", { onclick: () => act("/api/events", { type: "subscriber.created", subscriber_id: p.id }) }, "subscriber.created") : null,
              el("button", { class: "danger", onclick: () => act(`/api/people/${p.id}/erase`) }, "Erase"),
            )),
          )
        )),
      ),
    );
  },

  events() {
    const declared = state.plugin.manifest.hooks?.events ?? [];
    const live = state.people.filter((p) => !p.erased);
    const result = answerBox("events", "The answer of onEvent or onEvents shows here.");
    const type = keep(el("select", { id: "event-type" }, declared.map((name) => el("option", {}, name))));
    const person = keep(el("select", { id: "event-person" }, live.map((p) => el("option", { value: p.id }, `${p.id} · ${p.email}`))));
    const count = keep(el("input", { id: "event-count", type: "number", min: "1", max: "100", value: "10", style: "width:6em" }));
    const sentRows = state.sent.slice().reverse().map((entry) =>
      el("tr", {}, el("td", { class: "nowrap" }, time(entry.at)), el("td", { class: "mono" }, entry.type),
        el("td", {}, entry.batch ? `onEvents, ${entry.count} events` : `onEvent, person ${entry.subscriber_ids[0]}`),
        el("td", { class: "mono" }, entry.id),
        el("td", {}, el("button", { onclick: async () => answer("events", await post("/api/events/repeat", { id: entry.id })) }, "Send again"))));
    return el("div", { class: "view" },
      el("h1", {}, "Events"),
      el("p", { class: "note" }, declared.length
        ? "Send one of the events in manifest.json hooks.events to onEvent, as Broadcast does. Bulk work (an import, a send) gives a plugin up to 100 events of one type in one onEvents call; without onEvents, each goes to onEvent. Without a subscribers permission, event.data has only ids, state and times."
        : "manifest.json hooks.events lists no events."),
      declared.length ? el("div", { class: "row" }, el("label", {}, "Event", type), el("label", {}, "Person", person),
        el("button", { class: "primary", onclick: async () => {
          await answer("events", await post("/api/events", { type: type.value, subscriber_id: Number(person.value) }));
        } }, "Send event")) : null,
      declared.length ? el("div", { class: "row" }, el("label", {}, "Batch of", count), el("span", { class: "note" }, "people"),
        el("button", { onclick: async () => {
          await answer("events", await post("/api/events/batch", { type: type.value, count: Number(count.value) }));
        } }, "Send as a batch")) : null,
      result,
      state.sent.length ? el("h2", {}, "Sent by the sandbox") : null,
      state.sent.length ? el("p", { class: "note" }, "Broadcast delivers an event at least once. Send again repeats the same event ids, as a retry does; the plugin should do its work only once.") : null,
      el("table", {}, el("tbody", {}, sentRows)),
      el("h2", {}, "Events the plugin recorded"),
      el("table", {}, el("tbody", {}, state.events.slice().reverse().map((e) =>
        el("tr", {}, el("td", {}, time(e.occurred_at)), el("td", { class: "mono" }, e.name), el("td", { class: "mono" }, e.email), el("td", { class: "mono" }, short(e.properties))),
      ))),
    );
  },

  time() {
    const hooks = state.plugin.manifest.hooks ?? {};
    const out = answerBox("time", "The answer of a clock move or a hook shows here.");
    const show = (reply) => answer("time", reply);
    const clock = el("strong", { id: "clock-now" }, `${when(state.now)} (${utc(state.now)})`);
    const move = (ms) => el("button", { onclick: async () => show(await post("/api/clock", { advance_ms: ms })) },
      ms < 86_400_000 ? `+${ms / 3_600_000} hour${ms === 3_600_000 ? "" : "s"}` : `+${ms / 86_400_000} day${ms === 86_400_000 ? "" : "s"}`);
    const setAt = keep(el("input", { id: "clock-set", type: "datetime-local" }));
    const scheduleRows = state.schedules.map((s) =>
      el("tr", { class: s.valid ? "" : "err" }, el("td", { class: "mono" }, s.name), el("td", { class: "mono" }, s.cron),
        el("td", {}, s.valid ? utc(s.last_run_at) : "not a cron expression"), el("td", {}, utc(s.next_at)),
        el("td", {}, s.valid ? el("button", { onclick: async () => show(await post("/api/schedules/run", { name: s.name })) }, "Run now") : null)));
    const scheduleBody = el("tbody", {}, scheduleRows);
    const from = keep(el("input", { id: "upgrade-from", value: state.plugin.version, style: "width:8em" }));
    const rollback = keep(el("input", { id: "upgrade-rollback", type: "checkbox" }));
    const life = (hook, label, body = () => ({})) => hooks[hook] === true
      ? el("button", { onclick: async () => show(await post("/api/lifecycle", { hook, ...body() })) }, label)
      : el("button", { disabled: true, title: `manifest.json hooks.${hook} is not true` }, label);
    return el("div", { class: "view" },
      el("h1", {}, "Time"),
      el("h2", {}, "Clock"),
      el("p", { class: "note" }, "The sandbox's time. Move it forward to run the schedules it passes, in order. The plugin's Date.now(), Temporal.Now, ops, event times, logs and scheduled_for use it."),
      el("p", {}, "Now: ", clock, state.clockOffsetMs ? el("span", { class: "pill" }, "moved") : null),
      el("div", { class: "row" }, move(3_600_000), move(6 * 3_600_000), move(86_400_000), move(7 * 86_400_000),
        el("label", {}, "Go to", setAt), el("button", { onclick: async () => setAt.value && show(await post("/api/clock", { set: new Date(setAt.value).toISOString() })) }, "Go"),
        el("button", { onclick: async () => show(await post("/api/clock", { reset: true })) }, "Back to now")),
      el("h2", {}, "Schedules"),
      el("p", { class: "note" }, state.schedules.length
        ? "manifest.json hooks.schedules. As on a server, a schedule seen for the first time waits for its next due time. A clock move that passes more than 50 due times of one schedule runs only the latest, as Broadcast does after a long stop. A move back starts each schedule again."
        : "manifest.json hooks.schedules lists no schedules."),
      state.schedules.length ? el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Cron (UTC unless a zone is given)"), el("th", {}, "Last due"), el("th", {}, "Next due"), el("th", {}, ""))),
        scheduleBody) : null,
      el("h2", {}, "Lifecycle"),
      el("p", { class: "note" }, "The hooks set to true in manifest.json. A new sandbox runs onInstall once. A reload runs onUpgrade. On a server, Broadcast deletes the plugin's data after onUninstall; the sandbox keeps it."),
      el("div", { class: "row" }, life("onInstall", "Run onInstall"),
        el("label", {}, "From version", from), el("label", { class: "inline" }, rollback, "Rollback"),
        life("onUpgrade", "Run onUpgrade", () => ({ from_version: from.value, rollback: rollback.checked })),
        life("onUninstall", "Run onUninstall")),
      out,
    );
  },

  ops() {
    return el("div", { class: "view" },
      el("h1", {}, "Ops"),
      el("p", { class: "note" }, "Each hook call and each call the plugin made to Broadcast, newest first."),
      el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "Time"), el("th", {}, "Call"), el("th", {}, "From"), el("th", {}, "Arguments"), el("th", {}, "Answer"), el("th", {}, "ms"))),
        el("tbody", { id: "ops-body" }, state.ops.slice().reverse().map(opRow)),
      ),
    );
  },

  store() {
    return el("div", { class: "view" },
      el("h1", {}, "Store"),
      el("p", { class: "note" }, "The plugin's rows. Keys that start with __ belong to Broadcast; the plugin cannot see them."),
      el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "Key"), el("th", {}, "Person"), el("th", {}, "Value"))),
        el("tbody", {}, state.store.slice().sort((a, b) => (a.key < b.key ? -1 : 1)).map((row) =>
          el("tr", { class: row.key.startsWith("__") ? "dim" : "" }, el("td", { class: "mono" }, row.key), el("td", { class: "mono" }, row.subscriber_id ?? ""), el("td", { class: "mono" }, short(row.value, 400))),
        )),
      ),
    );
  },

  logs() {
    return el("div", { class: "view" },
      el("h1", {}, "Logs"),
      el("p", { class: "note" }, "ctx.log lines and hook failures, newest first. Email addresses are hidden, as in Broadcast."),
      el("table", {}, el("tbody", {}, state.logs.slice().reverse().map((log) =>
        el("tr", { class: log.level === "error" ? "err" : "" }, el("td", {}, time(log.at)), el("td", {}, el("span", { class: "pill" }, log.level)), el("td", { class: "mono" }, log.hook ?? ""), el("td", {}, log.message)),
      ))),
    );
  },

  settings() {
    const declared = state.plugin.manifest.settings ?? {};
    const fields = Object.entries(declared).map(([key, setting]) => {
      const current = state.settings[key];
      const attrs = { name: key, id: `setting-${key}` };
      let input;
      if (setting.type === "boolean") input = el("input", { ...attrs, type: "checkbox", checked: current?.value === true });
      else if (setting.type === "select") input = el("select", attrs, (setting.options ?? []).map((o) => el("option", { selected: current?.value === (o.value ?? o) }, o.value ?? o)));
      else if (setting.type === "text") input = el("textarea", attrs, current?.value ?? "");
      else input = el("input", { ...attrs, type: setting.secret ? "password" : setting.type === "integer" ? "number" : "text", value: setting.secret ? "" : current?.value ?? "", placeholder: setting.secret && current?.set ? "set (leave empty to keep)" : "" });
      return el("label", {}, `${setting.label ?? key}${setting.secret ? " (secret)" : ""}`, input);
    });
    const form = el("form", { class: "view", onsubmit: async (event) => {
      event.preventDefault();
      const body = {};
      for (const [key, setting] of Object.entries(declared)) {
        const input = form.querySelector(`[name="${CSS.escape(key)}"]`);
        body[key] = setting.type === "boolean" ? input.checked : input.value;
      }
      await post("/api/settings", body);
      await render();
    } },
      el("h1", {}, "Settings"),
      el("p", { class: "note" }, "The values an admin enters on the plugin's settings page. Secrets reach the plugin only through ctx.settings.secret."),
      fields.length ? fields : el("p", { class: "note" }, "manifest.json declares no settings."),
      el("div", { class: "row" }, fields.length ? el("button", { class: "primary" }, "Save") : null,
        el("button", { type: "button", class: "danger", onclick: () => act("/api/reset") }, "Reset sandbox data")),
      el("h2", {}, "Permissions"),
      el("p", { class: "note" }, state.permissions.length ? state.permissions.join(", ") : "Basic only: settings, store, log, channel and events."),
    );
    return form;
  },
};

function opRow(entry) {
  const hook = entry.op.startsWith("hook:");
  return el("tr", { class: `${hook ? "hook" : ""} ${entry.ok ? "" : "err"}` },
    el("td", { class: "nowrap" }, time(entry.at)), el("td", { class: "mono nowrap" }, hook ? entry.op.slice(5) : entry.op), el("td", { class: "mono nowrap" }, hook ? "" : entry.hook ?? ""),
    el("td", { class: "mono" }, short(entry.args)), el("td", { class: "mono" }, entry.ok ? short(entry.result) : short(entry.error)), el("td", {}, Math.round(entry.ms)));
}

async function act(path, body) {
  const reply = await post(path, body);
  if (reply && reply.ok === false) alertLine(reply.error);
  await render();
}

function alertLine(error) {
  const line = el("div", { class: "result", role: "alert" }, `Failed: ${error?.code ?? "error"}${error?.message ? `: ${error.message}` : ""}`);
  main.prepend(line);
}

// --- plugin pages and the bridge (plugin_bridge_controller.js) ---

function showPage(index) {
  const page = state.plugin.manifest.ui?.pages?.[index];
  if (!page) return false;
  main.classList.add("frame");
  frame = el("iframe", { sandbox: "allow-scripts allow-forms", title: page.title ?? "Plugin page" });
  main.replaceChildren(frame);
  frame.src = `/plugin-ui/${page.path}`;
  return true;
}

window.addEventListener("message", async (event) => {
  if (!frame || event.source !== frame.contentWindow) return;
  const { id, op, args } = event.data || {};
  if (typeof op !== "string") return;
  if (op === "openExternal") return openExternal(id, args?.url);
  let reply;
  try {
    reply = await post("/api/bridge", { op, args: args || {} });
  } catch (error) {
    reply = { ok: false, error: { code: "bridge_failed", message: String(error) } };
  }
  frame.contentWindow?.postMessage({ id, ...reply }, "*");
});

function openExternal(id, url) {
  let address = null;
  try {
    address = new URL(url);
  } catch { /* invalid */ }
  if (!address || address.protocol !== "https:" || address.username || address.password || String(url).length > 2048) {
    return frame.contentWindow?.postMessage({ id, ok: false, error: { code: "invalid_url" } }, "*");
  }
  const dialog = document.getElementById("open-link");
  const go = document.getElementById("open-link-go");
  document.getElementById("open-link-address").textContent = address.href;
  go.href = address.href;
  let opened = false;
  go.onclick = () => {
    opened = true;
    dialog.close();
  };
  dialog.onclose = () => frame.contentWindow?.postMessage({ id, ok: true, result: { opened } }, "*");
  dialog.showModal();
}

// --- routing and live updates ---

async function render() {
  await load();
  const view = location.hash.slice(1) || (state.plugin.manifest.ui?.pages?.length ? "page-0" : "people");
  for (const link of document.querySelectorAll(".side a")) link.classList.toggle("on", link.dataset.view === view);
  const page = view.match(/^page-(\d+)$/);
  if (page) {
    if (frame && main.classList.contains("frame") && main.dataset.view === view) return;
    main.dataset.view = view;
    if (showPage(Number(page[1]))) return;
  }
  frame = null;
  main.classList.remove("frame");
  main.dataset.view = view;
  main.replaceChildren((views[view] ?? views.people)());
}

window.addEventListener("hashchange", () => render());
const stream = new EventSource("/api/stream");
let pending = null;
stream.addEventListener("ops", (event) => {
  const entry = JSON.parse(event.data);
  const body = document.getElementById("ops-body");
  if (body) body.prepend(opRow(entry));
});
// A change while a plugin page is open leaves the page alone; the tabs redraw
stream.addEventListener("state", () => {
  clearTimeout(pending);
  pending = setTimeout(() => {
    // Only the data tabs redraw by themselves; Compose and Settings keep what is typed
    const typing = main.contains(document.activeElement) && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
    if (["people", "events", "time", "store", "logs", "inbox"].includes(main.dataset.view) && !typing && !main.querySelector("form:focus-within")) render();
    else load();
  }, 150);
});
// Hot reload: a new build or a ui/ change reloads the plugin page and redraws the tabs
function banner(text, kind) {
  document.getElementById("banner")?.remove();
  const node = el("div", { id: "banner", class: `banner ${kind}`, role: kind === "ok" ? "status" : "alert" }, text);
  document.body.append(node);
  // An error or a permission change stays until a click
  if (kind === "ok") setTimeout(() => node.remove(), 2500);
  else node.addEventListener("click", () => node.remove());
}
const refresh = async (text, kind = "ok") => {
  if (frame && main.classList.contains("frame")) frame.src = frame.src;
  else if (!["compose", "settings"].includes(main.dataset.view)) await render();
  else await load();
  if (text) banner(text, kind);
};
stream.addEventListener("reload", (event) => {
  const { version, message, permissions } = JSON.parse(event.data);
  const changed = permissions && (permissions.added.length || permissions.removed.length);
  refresh(message ?? `Reloaded ${version}`, changed ? "warn" : "ok");
});
stream.addEventListener("refresh", () => refresh("Page files changed"));
stream.addEventListener("build-error", (event) => banner(`Build failed: ${JSON.parse(event.data).message}`, "bad"));
render();
