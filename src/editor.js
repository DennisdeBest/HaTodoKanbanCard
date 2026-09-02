import { el } from "./dom.js";
import { splitTags } from "./tags.js";
import { tagColor } from "./colors.js";
import EDITOR_STYLE from "./editor-styles.css";

const EDITOR_LABELS = {
  title: "Title",
  default_collapsed: "Folding",
  hide_completed: "Hide completed",
  hide_add: "Hide the add box",
  enable_tags: "Treat #words in an item as tags",
  min_lane_width: "Minimum list width",
  entity: "List",
  icon: "Icon",
  color: "Colour",
  add: "Add a list",
  tag: "Tag",
};

const CARD_SCHEMA = [
  { name: "title", selector: { text: {} } },
  {
    name: "default_collapsed",
    selector: {
      select: {
        mode: "dropdown",
        options: [
          { value: "auto", label: "Automatic — fold a list when it is empty" },
          { value: "false", label: "Always open" },
          { value: "true", label: "Always folded" },
        ],
      },
    },
  },
  {
    name: "",
    type: "grid",
    schema: [
      { name: "hide_completed", selector: { boolean: {} } },
      { name: "hide_add", selector: { boolean: {} } },
    ],
  },
  {
    name: "min_lane_width",
    selector: { number: { min: 120, max: 600, step: 10, mode: "box", unit_of_measurement: "px" } },
  },
];

const LANE_SCHEMA = [
  { name: "entity", required: true, selector: { entity: { domain: "todo" } } },
  {
    name: "",
    type: "grid",
    schema: [
      { name: "title", selector: { text: {} } },
      { name: "icon", selector: { icon: {} } },
    ],
  },
  { name: "color", selector: { ui_color: { include_none: true, default_color: "none" } } },
];

const ADD_SCHEMA = [{ name: "add", selector: { entity: { domain: "todo" } } }];

/*
 * `custom_value: true` is what makes this an autocomplete rather than a fixed list: the
 * options are the tags already written on items across the configured lists, but a tag
 * that does not exist yet can simply be typed.
 */
const tagSchema = [
  { name: "color", selector: { ui_color: { include_none: true, default_color: "none" } } },
];

export class TodoKanbanCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { lanes: [] };
    this._built = false;
    this._known = [];     // every tag in play: configured, or written on an item
    this._seen = {};      // entity -> its items, from the subscriptions
    this._subs = [];
  }

  disconnectedCallback() {
    this._unsubscribe();
  }

  /*
   * Watch the configured lists, so a tag typed into an item while this dialog is open
   * turns up here without reopening it. `todo/item/subscribe` pushes the current items
   * immediately as well as on every change, so this covers the first load too.
   */
  _subscribe() {
    this._unsubscribe();
    if (!this._hass || !this._config) return;
    for (const lane of this._config.lanes || []) {
      const p = this._hass.connection.subscribeMessage(
        (msg) => {
          this._seen[lane.entity] = (msg && msg.items) || [];
          this._refreshKnown();
        },
        { type: "todo/item/subscribe", entity_id: lane.entity }
      );
      p.catch(() => { /* a list that cannot be read contributes no tags */ });
      this._subs.push(p);
    }
  }

  _unsubscribe() {
    for (const p of this._subs) p.then((unsub) => unsub && unsub()).catch(() => {});
    this._subs = [];
  }

  _refreshKnown() {
    const found = new Set(Object.keys(this._config.tags || {}));
    for (const items of Object.values(this._seen)) {
      for (const item of items || []) {
        for (const tag of splitTags(item.summary).tags) found.add(tag);
      }
    }
    const known = [...found].sort((a, b) => a.localeCompare(b));
    if (known.join("\u0000") === this._known.join("\u0000")) return;
    this._known = known;
    this._built = false;   // the rows and the options both change
    this._render();
  }

  setConfig(config) {
    this._config = { ...config, lanes: [...((config && config.lanes) || [])] };
    this._render();
    this._subscribe();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    this._render();
    if (first) this._subscribe();
  }

  get hass() {
    return this._hass;
  }

  _emit(config) {
    this._config = config;
    this._render();
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config },
      bubbles: true,
      composed: true,
    }));
  }

  // `select` hands back strings, and `default_collapsed` is auto | true | false.
  _cardData() {
    const c = this._config;
    return {
      title: c.title ?? "",
      default_collapsed: String(c.default_collapsed ?? "auto"),
      hide_completed: !!c.hide_completed,
      hide_add: !!c.hide_add,
      min_lane_width: c.min_lane_width ?? 270,
    };
  }

  _cardChanged(ev) {
    ev.stopPropagation();
    const v = ev.detail.value;
    const next = { ...this._config };

    if (v.title) next.title = v.title; else delete next.title;

    const fold = v.default_collapsed;
    if (fold === "auto" || fold === undefined) delete next.default_collapsed;
    else next.default_collapsed = fold === "true";

    if (v.hide_completed) next.hide_completed = true; else delete next.hide_completed;
    if (v.hide_add) next.hide_add = true; else delete next.hide_add;

    const width = Number(v.min_lane_width);
    if (width && width !== 270) next.min_lane_width = width; else delete next.min_lane_width;

    this._emit(next);
  }

  _laneChanged(index, ev) {
    ev.stopPropagation();
    const v = ev.detail.value;
    if (!v.entity) return;                       // never write a lane with no list
    const lane = { ...this._config.lanes[index], entity: v.entity };
    for (const key of ["title", "icon", "color"]) {
      if (v[key]) lane[key] = v[key]; else delete lane[key];
    }
    const lanes = [...this._config.lanes];
    lanes[index] = lane;
    this._emit({ ...this._config, lanes });
  }

  // The config carries `tags` as a map, which is the readable thing in YAML; the editor
  // needs an ordered list to render rows from, so it converts in both directions.
  /*
   * A row for every tag in play — the ones given a colour and the ones merely written
   * on an item — so a tag invented while adding a task can be recoloured here without
   * having to be picked out of a dropdown first. An uncoloured tag shows the colour it
   * is being drawn in, and only becomes configuration once it is changed.
   */
  _tagRows() {
    const configured = this._config.tags || {};
    return this._known.map((tag) => ({
      tag,
      color: configured[tag] || "",
      automatic: !configured[tag],
    }));
  }

  _emitTags(rows) {
    const next = { ...this._config };
    const tags = {};
    for (const row of rows) {
      if (!row.tag || !row.color) continue;   // an automatic colour is not configuration
      tags[row.tag] = row.color;
    }
    if (Object.keys(tags).length) next.tags = tags;
    else delete next.tags;
    this._emit(next);
  }

  _tagChanged(tag, ev) {
    ev.stopPropagation();
    const rows = this._tagRows().map((row) =>
      row.tag === tag ? { ...row, color: ev.detail.value.color || "" } : row);
    this._emitTags(rows);
  }

  // "auto" while the colour is the card's choice, a reset button once it is yours.
  _tagRowEnd(row) {
    return row.automatic
      ? el("span", { class: "auto-note", title: "Chosen automatically", text: "auto" })
      : this._button("mdi:backup-restore", "Back to the automatic colour",
          () => this._resetTag(row.tag));
  }

  // Back to the colour the card picks for it. The tag itself lives in the item text,
  // so there is nothing here to delete.
  _resetTag(tag) {
    this._emitTags(this._tagRows().map((row) =>
      row.tag === tag ? { ...row, color: "" } : row));
  }

  _addLane(ev) {
    ev.stopPropagation();
    const entity = ev.detail.value && ev.detail.value.add;
    if (!entity) return;
    this._emit({ ...this._config, lanes: [...this._config.lanes, { entity }] });
  }

  _removeLane(index) {
    if (this._config.lanes.length <= 1) return;  // a board needs at least one list
    const lanes = this._config.lanes.filter((_, i) => i !== index);
    this._emit({ ...this._config, lanes });
  }

  _moveLane(index, delta) {
    const to = index + delta;
    const lanes = [...this._config.lanes];
    if (to < 0 || to >= lanes.length) return;
    [lanes[index], lanes[to]] = [lanes[to], lanes[index]];
    this._emit({ ...this._config, lanes });
  }

  _form(schema, data, onChange) {
    const form = document.createElement("ha-form");
    form.schema = schema;
    form.computeLabel = (field) => EDITOR_LABELS[field.name] || field.name;
    form.addEventListener("value-changed", onChange);
    form.hass = this._hass;
    form.data = data;
    return form;
  }

  _button(icon, label, onClick, disabled) {
    const b = el("button", { class: "tool", title: label, "aria-label": label, onclick: onClick },
      [el("ha-icon", { icon })]);
    if (disabled) b.setAttribute("disabled", "");
    return b;
  }

  _render() {
    if (!this._hass || !this._config) return;
    const lanes = this._config.lanes || [];

    // Rebuild only when the number of lanes changes; otherwise refresh the existing
    // forms in place so the field being typed into keeps focus.
    const tagRows = this._tagRows();
    if (this._built && this._laneCount === lanes.length && this._tagCount === tagRows.length) {
      this._cardForm.hass = this._hass;
      this._cardForm.data = this._cardData();
      this._laneForms.forEach((form, i) => {
        form.hass = this._hass;
        form.data = { ...lanes[i] };
      });
      this._addForm.hass = this._hass;
      this._tagForms.forEach((form, i) => {
        form.hass = this._hass;
        form.data = { color: tagRows[i].color };
      });
      // The chip beside each colour picker has to be repainted too — changing a colour
      // or resetting one does not change how many rows there are, so this is the only
      // path that runs, and the chip would otherwise keep the colour it was built with.
      this._tagPreviews.forEach((preview, i) => {
        preview.style.setProperty("--tag-color",
          tagColor(tagRows[i].tag, this._config.tags || {}, this._known));
        preview.classList.toggle("automatic", tagRows[i].automatic);
      });
      // ...and the end of the row swaps between the "auto" marker and the reset button.
      this._tagEnds.forEach((end, i) => end.replaceChildren(this._tagRowEnd(tagRows[i])));
      if (this._tagsForm) {
        this._tagsForm.hass = this._hass;
        this._tagsForm.data = { enable_tags: !!this._config.enable_tags };
      }
      return;
    }

    const root = this.shadowRoot;
    while (root.firstChild) root.firstChild.remove();
    root.appendChild(el("style", { text: EDITOR_STYLE }));

    this._cardForm = this._form(CARD_SCHEMA, this._cardData(), (ev) => this._cardChanged(ev));
    root.appendChild(this._cardForm);

    root.appendChild(el("h3", { class: "section-title", text: "Lists" }));
    this._laneForms = [];
    lanes.forEach((lane, i) => {
      const form = this._form(LANE_SCHEMA, { ...lane }, (ev) => this._laneChanged(i, ev));
      this._laneForms.push(form);
      root.appendChild(el("div", { class: "lane-row" }, [
        el("div", { class: "lane-tools" }, [
          this._button("mdi:arrow-up", "Move up", () => this._moveLane(i, -1), i === 0),
          this._button("mdi:arrow-down", "Move down", () => this._moveLane(i, 1), i === lanes.length - 1),
          this._button("mdi:delete-outline", "Remove this list",
            () => this._removeLane(i), lanes.length <= 1),
        ]),
        form,
      ]));
    });

    this._addForm = this._form(ADD_SCHEMA, { add: "" }, (ev) => this._addLane(ev));
    root.appendChild(el("div", { class: "add-row" }, [this._addForm]));

    root.appendChild(el("h3", { class: "section-title", text: "Tags" }));
    root.appendChild(el("p", { class: "hint", text:
      "Off by default, since a \u201c#\u201d in an item may well be there for another reason. " +
      "Switched on, \u201cMilk #dairy\u201d shows as Milk with a chip, and the add box " +
      "suggests tags you have already used." }));
    this._tagsForm = this._form(
      [{ name: "enable_tags", selector: { boolean: {} } }],
      { enable_tags: !!this._config.enable_tags },
      (ev) => {
        ev.stopPropagation();
        const next = { ...this._config };
        if (ev.detail.value.enable_tags) next.enable_tags = true;
        else delete next.enable_tags;
        this._emit(next);
      }
    );
    root.appendChild(this._tagsForm);

    this._tagForms = [];
    this._tagPreviews = [];
    this._tagEnds = [];
    if (!tagRows.length) {
      root.appendChild(el("p", { class: "hint", text:
        "No tags yet. Write one into an item — \u201cMilk #dairy\u201d — and it will appear "
        + "here to colour." }));
    }
    tagRows.forEach((row) => {
      const form = this._form(tagSchema, { color: row.color }, (ev) => this._tagChanged(row.tag, ev));
      this._tagForms.push(form);
      const preview = el("span", { class: "tag-preview", text: row.tag });
      preview.style.setProperty("--tag-color", tagColor(row.tag, this._config.tags || {}, this._known));
      if (row.automatic) preview.classList.add("automatic");
      this._tagPreviews.push(preview);
      const end = el("span", { class: "tag-row-end" }, [this._tagRowEnd(row)]);
      this._tagEnds.push(end);
      root.appendChild(el("div", { class: "lane-row tag-row" }, [
        preview,
        form,
        end,
      ]));
    });

    root.appendChild(el("p", { class: "hint", text:
      "Per-list overrides for folding, the add box and completed items are available " +
      "in YAML, and are left alone by this editor." }));

    this._built = true;
    this._laneCount = lanes.length;
    this._tagCount = tagRows.length;
  }
}
