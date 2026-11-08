// Signal v1: pre-built web components for Broadcast plugin pages. Served by the core at
// /plugin-kit/v1/kit.js. No framework and no build step. Components render into the light DOM, so
// kit.css styles them and a plugin can inspect them. All text goes in as text, never as HTML.
// v1 only grows: a change that breaks a plugin needs v2.

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};
const flag = (host, name) => host.hasAttribute(name) && host.getAttribute(name) !== "false";
let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;
const emit = (host, name, detail) => host.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
const safeHref = (href) => (/^(https?:|mailto:|\/|#)/i.test(href ?? "") ? href : "#");

const ICONS = {
  check: "M4 12l5 5L20 6", x: "M6 6l12 12M18 6L6 18", plus: "M12 5v14M5 12h14", search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1", edit: "M4 20h4L19 9l-4-4L4 16v4z", trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  download: "M12 4v12M7 11l5 5 5-5M4 20h16", upload: "M12 20V8M7 13l5-5 5 5M4 4h16", link: "M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6", user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0", users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3a4 4 0 0 1 0 8M18 14a6 6 0 0 1 4 7",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2", settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 11v6M12 7v.5", warning: "M12 3L2 21h20L12 3zM12 10v5M12 18v.5", more: "M5 12h.5M12 12h.5M19 12h.5",
  chevron: "M6 9l6 6 6-6", arrow: "M5 12h14M13 6l6 6-6 6", refresh: "M20 11a8 8 0 1 0-2 6M20 5v6h-6", gift: "M3 9h18v4H3zM5 13v8h14v-8M12 9v12M12 9S7 9 7 6a2 2 0 0 1 5 0c0-3 5-3 5 0a2 2 0 0 1-5 3",
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("sg-icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name] ?? ICONS.info);
  svg.append(path);
  return svg;
}

// One render on first connect; children the author wrote are taken out first, so a component can
// put them where they belong. slot="x" children stay apart from the default children.
class Base extends HTMLElement {
  connectedCallback() {
    if (this.sgReady) return;
    this.sgReady = true;
    const kids = [...this.childNodes];
    this.sgSlots = { default: [] };
    for (const kid of kids) {
      const slot = kid.nodeType === 1 && kid.getAttribute("slot");
      if (slot) (this.sgSlots[slot] ??= []).push(kid);
      else this.sgSlots.default.push(kid);
    }
    this.replaceChildren();
    this.render();
    // A title attribute left on the element would be a browser tooltip over all of it
    this.removeAttribute("title");
  }
  slotted(name = "default") { return this.sgSlots?.[name] ?? []; }
  attr(name, fallback = "") { return this.getAttribute(name) ?? fallback; }
  render() { this.append(...this.slotted()); }
}

// A component that shows data from a property. Setting it renders again.
function dataProperty(cls, ...names) {
  for (const name of names) {
    Object.defineProperty(cls.prototype, name, {
      get() { return this[`_${name}`]; },
      set(value) { this[`_${name}`] = value; if (this.sgReady) this.draw(); },
    });
  }
}
function jsonAttr(host, name, fallback) {
  try { return host.hasAttribute(name) ? JSON.parse(host.getAttribute(name)) : fallback; } catch { return fallback; }
}

// Layout ------------------------------------------------------------------------------------------
class SgPage extends Base {
  render() {
    const page = el("div", "sg-page");
    const head = el("header", "sg-page-head");
    const titles = el("div");
    titles.append(el("h1", "sg-page-title", this.attr("title")));
    if (this.hasAttribute("description")) titles.append(el("p", "sg-page-description", this.attr("description")));
    head.append(titles);
    if (this.slotted("actions").length) {
      const actions = el("div", "sg-page-actions");
      actions.append(...this.slotted("actions"));
      head.append(actions);
    }
    const body = el("div", "sg-page-body");
    body.append(...this.slotted());
    page.append(head, body);
    this.append(page);
  }
}
class SgSection extends Base {
  render() {
    if (this.hasAttribute("title") || this.slotted("actions").length) {
      const head = el("div", "sg-section-head");
      head.append(el("h2", "sg-section-title", this.attr("title")), ...this.slotted("actions"));
      this.append(head);
    }
    const body = el("div", "sg-section-body");
    body.append(...this.slotted());
    this.append(body);
  }
}
class SgCard extends Base {
  render() {
    if (this.hasAttribute("title") || this.slotted("actions").length) {
      const head = el("div", "sg-card-head");
      const titles = el("div");
      titles.append(el("div", "sg-card-title", this.attr("title")));
      if (this.hasAttribute("description")) titles.append(el("div", "sg-help", this.attr("description")));
      head.append(titles, ...this.slotted("actions"));
      this.append(head);
    }
    const body = el("div", "sg-card-body");
    body.append(...this.slotted());
    this.append(body);
  }
}
class SgGrid extends Base {
  render() {
    this.style.setProperty("--sg-columns", this.attr("columns", "2"));
    super.render();
  }
}
class SgWidget extends Base {
  render() {
    const box = el("div", "sg-widget");
    if (this.hasAttribute("title")) box.append(el("div", "sg-widget-title", this.attr("title")));
    box.append(...this.slotted());
    this.append(box);
  }
}

// Actions -----------------------------------------------------------------------------------------
class SgButton extends Base {
  render() {
    const link = this.hasAttribute("href");
    const button = el(link ? "a" : "button", "sg-button");
    if (link) button.href = safeHref(this.getAttribute("href"));
    else button.type = this.attr("type", "button");
    const variant = this.attr("variant");
    if (variant) button.classList.add(`sg-button--${variant}`);
    if (this.attr("size") === "small") button.classList.add("sg-button--small");
    if (this.hasAttribute("icon")) button.append(icon(this.getAttribute("icon")));
    button.append(...this.slotted());
    if (flag(this, "disabled")) button.disabled = true;
    if (this.hasAttribute("label")) button.setAttribute("aria-label", this.getAttribute("label"));
    this.button = button;
    this.append(button);
  }
  set disabled(value) { this.toggleAttribute("disabled", value); if (this.button) this.button.disabled = value; }
  get disabled() { return flag(this, "disabled"); }
  set busy(value) { if (!this.button) return; this.button.setAttribute("aria-busy", String(value)); this.button.disabled = value; }
}
class SgLink extends Base {
  render() {
    const link = el("a");
    link.href = safeHref(this.getAttribute("href"));
    if (flag(this, "external")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      // The sandbox has no popups, so inside Broadcast the host opens the link.
      link.addEventListener("click", (event) => {
        if (window.parent === window) return;
        event.preventDefault();
        openExternal(link.href).catch(() => toast("This link cannot open.", { tone: "danger" }));
      });
    }
    link.append(...this.slotted());
    this.append(link);
  }
}
class SgIcon extends Base { render() { this.append(icon(this.attr("name"))); } }
class SgCopy extends Base {
  render() {
    const box = el("div", "sg-copy");
    this.valueNode = el("span", "sg-copy-value", this.attr("value"));
    this.valueNode.title = this.attr("value");
    const button = el("button", "sg-button sg-button--small", this.attr("label", "Copy"));
    button.type = "button";
    button.addEventListener("click", async () => {
      const copied = await copyText(this.value);
      button.textContent = copied ? "Copied" : "Press Cmd+C";
      setTimeout(() => { button.textContent = this.attr("label", "Copy"); }, 1500);
    });
    box.append(this.valueNode, button);
    this.append(box);
  }
  get value() { return this.attr("value"); }
  set value(text) {
    this.setAttribute("value", text);
    if (this.valueNode) { this.valueNode.textContent = text; this.valueNode.title = text; }
  }
}
// The sandbox can refuse the clipboard API, so the old command is the fallback.
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* use the fallback */ }
  const area = el("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let done = false;
  try { done = document.execCommand("copy"); } catch { done = false; }
  area.remove();
  return done;
}
class SgMenu extends Base {
  render() {
    const toggle = el("button", "sg-button");
    toggle.type = "button";
    toggle.setAttribute("aria-haspopup", "menu");
    toggle.setAttribute("aria-expanded", "false");
    toggle.append(document.createTextNode(this.attr("label", "Actions")), icon("chevron"));
    const list = el("div", "sg-menu-list");
    list.setAttribute("role", "menu");
    list.hidden = true;
    for (const item of this.slotted().filter((node) => node.nodeType === 1)) {
      const entry = el("button", "sg-menu-item", item.textContent.trim());
      entry.type = "button";
      entry.setAttribute("role", "menuitem");
      if (item.getAttribute("variant") === "danger") entry.classList.add("sg-menu-item--danger");
      entry.addEventListener("click", () => { close(); emit(this, "sg-select", { value: item.getAttribute("value") }); });
      list.append(entry);
    }
    const close = () => { list.hidden = true; toggle.setAttribute("aria-expanded", "false"); };
    toggle.addEventListener("click", () => {
      list.hidden = !list.hidden;
      toggle.setAttribute("aria-expanded", String(!list.hidden));
    });
    document.addEventListener("click", (event) => { if (!this.contains(event.target)) close(); });
    this.addEventListener("keydown", (event) => { if (event.key === "Escape") { close(); toggle.focus(); } });
    this.append(toggle, list);
  }
}
class SgTooltip extends Base {
  render() {
    const text = el("span", "sg-tooltip-text", this.attr("text"));
    text.setAttribute("role", "tooltip");
    this.append(...this.slotted(), text);
  }
}
class SgDialog extends Base {
  render() {
    const dialog = el("dialog", "sg-dialog");
    if (this.hasAttribute("title")) dialog.append(el("div", "sg-dialog-head", this.attr("title")));
    const body = el("div", "sg-dialog-body");
    body.append(...this.slotted());
    dialog.append(body);
    if (this.slotted("footer").length) {
      const foot = el("div", "sg-dialog-foot");
      foot.append(...this.slotted("footer"));
      dialog.append(foot);
    }
    dialog.addEventListener("close", () => emit(this, "sg-close", { value: dialog.returnValue }));
    this.dialog = dialog;
    this.append(dialog);
  }
  open() { this.dialog.returnValue = ""; this.dialog.showModal(); }
  close(value = "") { this.dialog.close(value); }
}
// window.confirm does not work in the sandbox, so this is the way to ask.
function confirmDialog({ title = "Are you sure?", message = "", confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    const dialog = el("dialog", "sg-dialog");
    const body = el("div", "sg-dialog-body", message);
    const foot = el("div", "sg-dialog-foot");
    const button = (label, className, value) => {
      const node = el("button", className, label);
      node.type = "button";
      node.addEventListener("click", () => dialog.close(value));
      return node;
    };
    foot.append(button(cancelLabel, "sg-button", "no"), button(confirmLabel, `sg-button ${danger ? "sg-button--danger" : "sg-button--primary"}`, "yes"));
    dialog.append(el("div", "sg-dialog-head", title), body, foot);
    dialog.addEventListener("close", () => { resolve(dialog.returnValue === "yes"); dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
  });
}

// Forms -------------------------------------------------------------------------------------------
function errorNode(host) {
  const node = el("div", "sg-error");
  node.setAttribute("role", "alert");
  node.hidden = !host.pendingError;
  node.textContent = host.pendingError ?? "";
  host.errorNode = node;
  return node;
}
function showError(host, message) {
  host.pendingError = message;
  if (!host.errorNode) return;
  host.errorNode.textContent = message ?? "";
  host.errorNode.hidden = !message;
  const input = host.input ?? host.entry;
  if (!input) return;
  if (message) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

class Field extends Base {
  control() { return el("input", "sg-control"); }
  render() {
    const id = nextId("sg-field");
    const field = el("div", "sg-field");
    this.input = this.control();
    this.input.id = id;
    this.input.name = this.attr("name");
    for (const name of ["placeholder", "maxlength", "min", "max", "rows", "pattern"]) if (this.hasAttribute(name)) this.input.setAttribute(name, this.getAttribute(name));
    if (flag(this, "required")) this.input.required = true;
    if (flag(this, "disabled")) this.input.disabled = true;
    if (flag(this, "readonly")) this.input.readOnly = true;
    if (this.hasAttribute("value")) this.input.value = this.getAttribute("value");
    if (this.pendingValue !== undefined) this.input.value = this.pendingValue;
    this.startValue = this.input.value;
    if (this.hasAttribute("label")) {
      const label = el("label", "sg-label", this.attr("label"));
      label.htmlFor = id;
      if (flag(this, "required")) label.append(el("span", "sg-required", " *"));
      field.append(label);
    }
    field.append(this.input);
    if (this.hasAttribute("help")) {
      const help = el("div", "sg-help", this.attr("help"));
      help.id = `${id}-help`;
      this.input.setAttribute("aria-describedby", help.id);
      field.append(help);
    }
    field.append(errorNode(this));
    this.append(field);
    showError(this, this.pendingError);
  }
  get name() { return this.attr("name"); }
  get value() { return this.input?.value ?? this.pendingValue ?? this.attr("value"); }
  set value(text) { if (this.input) this.input.value = text; else this.pendingValue = text; }
  set error(message) { showError(this, message); }
  check() { return this.input.checkValidity(); }
  problem() { return this.input.validationMessage; }
  reset() { this.input.value = this.startValue; showError(this, ""); }
}
class SgInput extends Field {
  control() {
    const input = super.control();
    input.type = this.attr("type", "text");
    return input;
  }
}
class SgDateInput extends Field {
  control() {
    const input = super.control();
    input.type = "date";
    return input;
  }
}
class SgTextarea extends Field { control() { return el("textarea", "sg-control"); } }
class SgSelect extends Field {
  control() {
    const select = el("select", "sg-control");
    if (this.pendingOptions) select.append(...this.pendingOptions);
    for (const item of this.slotted().filter((node) => node.nodeType === 1)) {
      const option = el("option", undefined, item.textContent);
      option.value = item.getAttribute("value") ?? item.textContent;
      if (item.hasAttribute("selected")) option.selected = true;
      select.append(option);
    }
    return select;
  }
  set options(items) {
    const options = items.map((item) => {
      const option = el("option", undefined, item.label ?? item.value);
      option.value = item.value;
      return option;
    });
    if (this.input) this.input.replaceChildren(...options);
    else this.pendingOptions = options;
  }
}
class SgSearch extends Field {
  control() {
    const input = super.control();
    input.type = "search";
    input.placeholder = this.attr("placeholder", "Search");
    input.setAttribute("aria-label", this.attr("label", "Search"));
    let timer;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => emit(this, "sg-search", { value: input.value }), Number(this.attr("delay", "250")));
    });
    return input;
  }
}
class Checkable extends Base {
  build(className, track) {
    const label = el("label", className);
    this.input = el("input");
    this.input.type = "checkbox";
    this.input.name = this.attr("name");
    this.input.checked = flag(this, "checked");
    this.input.disabled = flag(this, "disabled");
    this.input.addEventListener("change", () => emit(this, "sg-change", { checked: this.input.checked }));
    label.append(this.input);
    if (track) label.append(el("span", "sg-switch-track"));
    label.append(el("span", undefined, this.attr("label")));
    this.startChecked = this.input.checked;
    this.append(label, errorNode(this));
  }
  get name() { return this.attr("name"); }
  get checked() { return this.input?.checked ?? flag(this, "checked"); }
  set checked(value) { if (this.input) this.input.checked = value; else this.toggleAttribute("checked", value); }
  get value() { return this.checked; }
  set value(state) { this.checked = Boolean(state); }
  set error(message) { showError(this, message); }
  check() { return !flag(this, "required") || this.checked; }
  problem() { return "Tick this box to go on."; }
  reset() { this.checked = this.startChecked; showError(this, ""); }
}
class SgCheckbox extends Checkable { render() { this.build("sg-check"); } }
class SgSwitch extends Checkable {
  render() {
    this.build("sg-check sg-switch", true);
    this.input.setAttribute("role", "switch");
  }
}
class SgRadioGroup extends Base {
  render() {
    const group = el("fieldset", "sg-radios");
    group.append(el("legend", "sg-label", this.attr("label")));
    const name = this.attr("name") || nextId("sg-radio");
    this.inputs = [];
    for (const item of this.slotted().filter((node) => node.nodeType === 1)) {
      const label = el("label", "sg-check");
      const input = el("input");
      input.type = "radio";
      input.name = name;
      input.value = item.getAttribute("value") ?? item.textContent.trim();
      input.checked = item.hasAttribute("checked");
      input.addEventListener("change", () => emit(this, "sg-change", { value: input.value }));
      label.append(input, el("span", undefined, item.textContent.trim()));
      group.append(label);
      this.inputs.push(input);
    }
    this.startValue = this.value;
    this.append(group, errorNode(this));
  }
  get name() { return this.attr("name"); }
  get value() { return this.inputs?.find((input) => input.checked)?.value ?? ""; }
  set value(text) { for (const input of this.inputs ?? []) input.checked = input.value === text; }
  set error(message) { showError(this, message); }
  check() { return !flag(this, "required") || Boolean(this.value); }
  problem() { return "Choose one."; }
  reset() { this.value = this.startValue; showError(this, ""); }
}
class SgTagInput extends Base {
  render() {
    this.tags ??= jsonAttr(this, "value", []);
    this.startTags = [...this.tags];
    const field = el("div", "sg-field");
    if (this.hasAttribute("label")) field.append(el("span", "sg-label", this.attr("label")));
    this.box = el("div", "sg-control sg-tags");
    this.entry = el("input");
    this.entry.setAttribute("aria-label", this.attr("label", "Add a tag"));
    this.entry.placeholder = this.attr("placeholder", "Add, then press Enter");
    this.entry.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === ",") {
        event.preventDefault();
        this.add(this.entry.value);
      } else if (event.key === "Backspace" && !this.entry.value) {
        this.tags.pop();
        this.draw();
      }
    });
    field.append(this.box);
    if (this.hasAttribute("help")) field.append(el("div", "sg-help", this.attr("help")));
    field.append(errorNode(this));
    this.append(field);
    this.draw();
  }
  add(text) {
    const tag = String(text).trim();
    if (tag && !this.tags.includes(tag)) this.tags.push(tag);
    this.entry.value = "";
    this.draw();
  }
  draw() {
    const chips = this.tags.map((tag) => {
      const chip = el("span", "sg-badge", tag);
      const remove = el("button", "sg-tag-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${tag}`);
      remove.addEventListener("click", () => { this.tags = this.tags.filter((item) => item !== tag); this.draw(); });
      chip.append(remove);
      return chip;
    });
    this.box.replaceChildren(...chips, this.entry);
    emit(this, "sg-change", { value: [...this.tags] });
  }
  get name() { return this.attr("name"); }
  get value() { return [...(this.tags ?? [])]; }
  set value(list) { this.tags = [...list]; if (this.sgReady) this.draw(); }
  set error(message) { showError(this, message); }
  check() { return !flag(this, "required") || this.tags.length > 0; }
  problem() { return "Add at least one."; }
  reset() { this.value = this.startTags; showError(this, ""); }
}
// The sandbox forbids a real form post (form-action 'none'), so this hands the values to the plugin.
const FIELD_TAGS = "sg-input, sg-textarea, sg-select, sg-checkbox, sg-switch, sg-radio-group, sg-tag-input, sg-date-input, sg-search";
class SgForm extends Base {
  render() {
    const form = el("form", "sg-form-body");
    form.noValidate = true;
    form.append(...this.slotted());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.errors = {};
      const fields = [...this.querySelectorAll(FIELD_TAGS)];
      const invalid = fields.filter((field) => !field.check());
      for (const field of invalid) field.error = field.problem();
      if (invalid.length) { (invalid[0].input ?? invalid[0].entry ?? invalid[0].inputs?.[0])?.focus(); return; }
      emit(this, "sg-submit", { values: this.values });
    });
    this.form = form;
    this.append(form);
  }
  get values() {
    return Object.fromEntries([...this.querySelectorAll(FIELD_TAGS)].filter((field) => field.name).map((field) => [field.name, field.value]));
  }
  set errors(messages) {
    for (const field of this.querySelectorAll(FIELD_TAGS)) if ("error" in field) field.error = messages?.[field.name] ?? "";
  }
  reset() { for (const field of this.querySelectorAll(FIELD_TAGS)) field.reset(); }
  set busy(value) { for (const button of this.querySelectorAll('button[type="submit"]')) { button.disabled = value; button.setAttribute("aria-busy", String(value)); } }
}

// Data --------------------------------------------------------------------------------------------
class SgTable extends Base {
  render() {
    this._columns ??= jsonAttr(this, "columns", []);
    this._rows ??= jsonAttr(this, "rows", null);
    this.sort = null;
    this.draw();
  }
  draw() {
    const rows = [...(this._rows ?? [])];
    if (this._rows === null || this._rows === undefined) return this.replaceChildren(skeleton(4));
    if (!rows.length) return this.replaceChildren(empty(this.attr("empty-title", "Nothing here yet"), this.attr("empty-text")));

    if (this.sort) {
      const { key, direction } = this.sort;
      rows.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * direction);
    }
    const head = el("tr");
    for (const column of this._columns) {
      const th = el("th");
      th.scope = "col";
      if (column.align) th.dataset.align = column.align;
      if (column.sortable) {
        const button = el("button", undefined, column.label + (this.sort?.key === column.key ? (this.sort.direction > 0 ? " ↑" : " ↓") : ""));
        button.type = "button";
        button.addEventListener("click", () => {
          const direction = this.sort?.key === column.key ? -this.sort.direction : 1;
          this.sort = { key: column.key, direction };
          this.draw();
        });
        th.append(button);
      } else {
        th.textContent = column.label;
      }
      head.append(th);
    }
    const body = el("tbody");
    for (const row of rows) {
      const tr = el("tr");
      if (flag(this, "clickable")) {
        tr.dataset.clickable = "";
        tr.addEventListener("click", () => emit(this, "sg-row-click", { row }));
      }
      for (const column of this._columns) {
        const td = el("td");
        if (column.align) td.dataset.align = column.align;
        const value = column.render ? column.render(row) : row[column.key];
        if (value instanceof Node) td.append(value);
        else td.textContent = value ?? "";
        tr.append(td);
      }
      body.append(tr);
    }
    const thead = el("thead");
    thead.append(head);
    const table = el("table", "sg-table");
    table.append(thead, body);
    const wrap = el("div", "sg-table-wrap");
    wrap.append(table);
    this.replaceChildren(wrap);
  }
}
dataProperty(SgTable, "columns", "rows");
class SgPagination extends Base {
  render() { this.draw(); }
  draw() {
    const page = Number(this.attr("page", "1"));
    const pages = Math.max(1, Number(this.attr("pages", "1")));
    const box = el("div", "sg-pagination");
    box.append(el("span", undefined, `Page ${page} of ${pages}`));
    const buttons = el("sg-button-group");
    const step = (label, target, off) => {
      const button = el("button", "sg-button sg-button--small", label);
      button.type = "button";
      button.disabled = off;
      button.addEventListener("click", () => { this.setAttribute("page", target); this.draw(); emit(this, "sg-page", { page: target }); });
      return button;
    };
    buttons.append(step("Previous", page - 1, page <= 1), step("Next", page + 1, page >= pages));
    box.append(buttons);
    this.replaceChildren(box);
  }
}
class SgStat extends Base {
  get value() { return this.attr("value"); }
  set value(text) {
    this.setAttribute("value", text);
    if (this.valueNode) this.valueNode.textContent = text;
  }
  render() {
    this.valueNode = el("div", "sg-stat-value", this.attr("value"));
    this.append(el("div", "sg-stat-label", this.attr("label")), this.valueNode);
    if (this.hasAttribute("change")) {
      const change = this.getAttribute("change");
      const tone = change.startsWith("-") ? "down" : "up";
      this.append(el("div", `sg-stat-change sg-stat-change--${tone}`, change));
    }
    this.append(...this.slotted());
  }
}
class SgMeter extends Base {
  get value() { return Number(this.attr("value", "0")); }
  set value(number) { this.setAttribute("value", number); this.draw(); }
  set detail(text) { this.setAttribute("detail", text); this.draw(); }
  render() { this.draw(); }
  draw() {
    if (!this.sgReady) return;
    const max = Number(this.attr("max", "100")) || 100;
    const percent = Math.min(100, Math.max(0, (this.value / max) * 100));
    const row = el("div", "sg-meter-row");
    row.append(el("span", undefined, this.attr("label")), el("span", "sg-meter-value", this.attr("detail", `${Math.round(percent)}%`)));
    const track = el("div", "sg-meter-track");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuenow", String(Math.round(percent)));
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-label", this.attr("label", "Progress"));
    const fill = el("div", "sg-meter-fill");
    fill.style.setProperty("--sg-value", `${percent}%`);
    track.append(fill);
    this.replaceChildren(row, track);
  }
}
class SgBarChart extends Base {
  render() { this._data ??= jsonAttr(this, "data", []); this.draw(); }
  draw() {
    const data = this._data ?? [];
    const top = Math.max(...data.map((item) => item.value), 1);
    const chart = el("div", "sg-chart");
    for (const item of data) {
      const row = el("div", "sg-chart-row");
      const bar = el("div", "sg-chart-bar");
      bar.style.width = `${(item.value / top) * 100}%`;
      const holder = el("div");
      holder.append(bar);
      row.append(el("span", "sg-chart-label", item.label), holder, el("span", "sg-muted", item.value));
      chart.append(row);
    }
    this.replaceChildren(chart);
  }
}
dataProperty(SgBarChart, "data");
class SgSparkline extends Base {
  render() { this._data ??= jsonAttr(this, "data", []); this.draw(); }
  draw() {
    const data = this._data ?? [];
    const width = 96, height = 28;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.setAttribute("class", "sg-sparkline");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", this.attr("label", "Trend"));
    if (data.length > 1) {
      const low = Math.min(...data), span = Math.max(...data) - low || 1;
      const points = data.map((value, index) => `${(index / (data.length - 1)) * (width - 2) + 1},${height - 2 - ((value - low) / span) * (height - 4)}`);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      line.setAttribute("points", points.join(" "));
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "currentColor");
      line.setAttribute("stroke-width", "2");
      svg.append(line);
    }
    this.replaceChildren(svg);
  }
}
dataProperty(SgSparkline, "data");
class SgList extends Base {
  render() { this._items ??= jsonAttr(this, "items", null); if (this._items) this.draw(); else this.append(...this.slotted()); }
  draw() {
    const list = el("ul", "sg-list");
    for (const item of this._items ?? []) {
      const row = el("li", "sg-list-item");
      const text = el("div");
      text.append(el("div", undefined, item.title));
      if (item.description) text.append(el("div", "sg-help", item.description));
      row.append(text);
      if (item.meta) row.append(el("span", "sg-muted", item.meta));
      list.append(row);
    }
    this.replaceChildren(list);
  }
}
dataProperty(SgList, "items");
class SgTimeline extends Base {
  render() { this._items ??= jsonAttr(this, "items", []); this.draw(); }
  draw() {
    const list = el("ol", "sg-timeline");
    for (const item of this._items ?? []) {
      const row = el("li", "sg-timeline-item");
      row.append(el("div", undefined, item.title), el("div", "sg-timeline-time", item.time));
      list.append(row);
    }
    this.replaceChildren(list);
  }
}
dataProperty(SgTimeline, "items");
class SgBadge extends Base {
  render() {
    const badge = el("span", "sg-badge");
    badge.append(...this.slotted());
    this.append(badge);
  }
}
class SgAvatar extends Base {
  render() {
    const name = this.attr("name");
    const initials = name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("");
    const avatar = el("span", "sg-avatar", initials);
    avatar.setAttribute("aria-label", name);
    this.append(avatar);
  }
}
class SgCode extends Base {
  render() {
    this.node = el("pre", "sg-code", this.hasAttribute("value") ? this.getAttribute("value") : this.slotted().map((node) => node.textContent).join("").trim());
    this.append(this.node);
  }
  get value() { return this.node?.textContent ?? ""; }
  set value(text) { if (this.node) this.node.textContent = text; else this.setAttribute("value", text); }
}

// Navigation --------------------------------------------------------------------------------------
class SgTabs extends Base {
  render() {
    const panels = this.slotted().filter((node) => node.nodeType === 1);
    const list = el("div", "sg-tablist");
    list.setAttribute("role", "tablist");
    const buttons = panels.map((panel, index) => {
      const tab = el("button", "sg-tab", panel.getAttribute("label"));
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.id = nextId("sg-tab");
      panel.id ||= nextId("sg-panel");
      tab.setAttribute("aria-controls", panel.id);
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
      tab.addEventListener("click", () => this.select(index));
      tab.addEventListener("keydown", (event) => {
        const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
        if (!move) return;
        const target = (index + move + panels.length) % panels.length;
        this.select(target);
        this.buttons[target].focus();
      });
      return tab;
    });
    this.buttons = buttons;
    this.panels = panels;
    list.append(...buttons);
    this.append(list, ...panels);
    this.select(Math.max(0, panels.findIndex((panel) => panel.hasAttribute("selected"))), false);
  }
  select(index, notify = true) {
    this.buttons.forEach((tab, position) => {
      tab.setAttribute("aria-selected", String(position === index));
      tab.tabIndex = position === index ? 0 : -1;
      this.panels[position].hidden = position !== index;
    });
    if (notify) emit(this, "sg-tab", { index, value: this.panels[index].getAttribute("value") });
  }
}
class SgAccordion extends Base {
  render() {
    for (const item of this.slotted().filter((node) => node.nodeType === 1)) {
      const details = el("details", "sg-accordion-item");
      details.open = item.hasAttribute("open");
      const body = el("div", "sg-accordion-body");
      body.append(...item.childNodes);
      details.append(el("summary", undefined, item.getAttribute("label")), body);
      this.append(details);
    }
  }
}

// Feedback ----------------------------------------------------------------------------------------
class SgBanner extends Base {
  render() {
    const banner = el("div", "sg-banner");
    banner.setAttribute("role", this.attr("tone") === "danger" ? "alert" : "status");
    const text = el("div");
    if (this.hasAttribute("title")) text.append(el("div", "sg-banner-title", this.attr("title")));
    text.append(...this.slotted());
    banner.append(text);
    if (flag(this, "dismissible")) {
      const close = el("button", "sg-banner-close");
      close.type = "button";
      close.title = "Dismiss";
      close.setAttribute("aria-label", "Dismiss");
      close.append(icon("x"));
      close.addEventListener("click", () => this.remove());
      banner.append(close);
    }
    this.append(banner);
  }
}
function empty(title, text, action = []) {
  const box = el("div", "sg-empty");
  box.append(el("div", "sg-empty-title", title));
  if (text) box.append(el("div", "sg-empty-text", text));
  box.append(...action);
  return box;
}
class SgEmpty extends Base { render() { this.append(empty(this.attr("title"), this.attr("text"), this.slotted())); } }
class SgSpinner extends Base {
  render() {
    const spinner = el("span", "sg-spinner");
    spinner.setAttribute("role", "status");
    spinner.setAttribute("aria-label", this.attr("label", "Loading"));
    this.append(spinner);
  }
}
function skeleton(lines) {
  const box = el("div", "sg-skeleton");
  box.setAttribute("aria-hidden", "true");
  for (let index = 0; index < lines; index++) box.append(el("div", "sg-skeleton-line"));
  return box;
}
class SgSkeleton extends Base { render() { this.append(skeleton(Number(this.attr("lines", "3")))); } }

function toast(message, { tone, duration = 4000 } = {}) {
  let box = document.querySelector(".sg-toasts");
  if (!box) {
    box = el("div", "sg-toasts");
    box.setAttribute("aria-live", "polite");
    document.body.append(box);
  }
  const node = el("div", `sg-toast${tone === "danger" ? " sg-toast--danger" : ""}`, message);
  box.append(node);
  setTimeout(() => node.remove(), duration);
  return node;
}

// The bridge to Broadcast -------------------------------------------------------------------------
class SgError extends Error {
  constructor(error) {
    super(error?.message ?? error?.code ?? "The call failed.");
    this.name = "SgError";
    this.code = error?.code;
  }
}
const pending = new Map();
let nextCall = 0;
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const resolve = pending.get(event.data?.id);
  if (!resolve) return;
  pending.delete(event.data.id);
  resolve(event.data);
});
async function call(op, args = {}) {
  const reply = await new Promise((resolve) => {
    const id = `sg-${++nextCall}`;
    pending.set(id, resolve);
    window.parent.postMessage({ id, op, args }, "*");
  });
  if (!reply.ok) throw new SgError(reply.error);
  return reply.result;
}

const openExternal = (url) => call("openExternal", { url });

const components = {
  "sg-page": SgPage, "sg-section": SgSection, "sg-card": SgCard, "sg-stack": Base, "sg-grid": SgGrid, "sg-divider": Base, "sg-widget": SgWidget, "sg-panel": SgWidget,
  "sg-button": SgButton, "sg-button-group": Base, "sg-link": SgLink, "sg-icon": SgIcon, "sg-copy": SgCopy, "sg-menu": SgMenu, "sg-tooltip": SgTooltip, "sg-dialog": SgDialog,
  "sg-form": SgForm, "sg-input": SgInput, "sg-date-input": SgDateInput, "sg-textarea": SgTextarea, "sg-select": SgSelect, "sg-search": SgSearch,
  "sg-checkbox": SgCheckbox, "sg-switch": SgSwitch, "sg-radio-group": SgRadioGroup, "sg-tag-input": SgTagInput,
  "sg-table": SgTable, "sg-pagination": SgPagination, "sg-stat": SgStat, "sg-meter": SgMeter, "sg-bar-chart": SgBarChart, "sg-sparkline": SgSparkline,
  "sg-list": SgList, "sg-timeline": SgTimeline, "sg-badge": SgBadge, "sg-avatar": SgAvatar, "sg-code": SgCode, "sg-kbd": Base,
  "sg-tabs": SgTabs, "sg-accordion": SgAccordion, "sg-banner": SgBanner, "sg-empty": SgEmpty, "sg-spinner": SgSpinner, "sg-skeleton": SgSkeleton,
};
for (const [name, base] of Object.entries(components)) {
  // One class can back only one tag name, so a shared class gets a small subclass.
  if (!customElements.get(name)) customElements.define(name, class extends base {});
}

window.sg = Object.freeze({
  version: "1",
  call,
  pageData: (input = {}, page = 0) => call("pageData", { page, input }),
  toast,
  confirm: confirmDialog,
  copy: copyText,
  openExternal,
  subscriberId: () => new URLSearchParams(location.hash.slice(1)).get("subscriber_id"),
  SgError,
});
