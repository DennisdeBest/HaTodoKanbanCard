import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupDom, makeHass, tick } from "./helpers.mjs";

const dom = setupDom();

/*
 * `<ha-form>` belongs to Home Assistant, so here it is a stand-in that records what it
 * was handed and can be told to emit a change. What is under test is the editor's half
 * of the contract: the schema it asks for, the data it passes down, and the config it
 * emits back — not the rendering of the real form.
 */
class FakeHaForm extends dom.window.HTMLElement {
  emit(value) {
    this.dispatchEvent(new dom.window.CustomEvent("value-changed", {
      detail: { value },
      bubbles: true,
      composed: true,
    }));
  }
}
dom.window.customElements.define("ha-form", FakeHaForm);
dom.window.customElements.define("ha-icon", class extends dom.window.HTMLElement {});

await import("../todo-kanban-card.js");

const CONFIG = {
  title: "Shopping",
  lanes: [
    { entity: "todo.urgent", title: "Urgent", icon: "mdi:alert-octagon", color: "red" },
    { entity: "todo.normal" },
    { entity: "todo.later" },
  ],
};

function editor(config = CONFIG) {
  const { hass } = makeHass(
    { "todo.urgent": [], "todo.normal": [], "todo.later": [], "todo.spare": [] },
    []
  );
  const el = document.createElement("todo-kanban-card-editor");
  el.setConfig(structuredClone(config));
  el.hass = hass;
  document.body.appendChild(el);
  const changes = [];
  el.addEventListener("config-changed", (ev) => changes.push(ev.detail.config));
  const forms = () => [...el.shadowRoot.querySelectorAll("ha-form")];
  // Pick forms out by what they ask for rather than by position, so adding a section to
  // the editor does not quietly renumber every assertion.
  const names = (f) => f.schema.flatMap((x) => (x.schema ? x.schema : [x])).map((x) => x.name);
  const byField = (field) => forms().filter((f) => names(f).includes(field));
  const cardForm = () => byField("default_collapsed")[0];
  const laneForms = () => byField("entity").filter((f) => !names(f).includes("add"));
  const addLaneForm = () => byField("add")[0];
  const tagForms = () => byField("tag");
  const addTagForm = () => byField("add_tag")[0];
  return { el, changes, forms, hass, cardForm, laneForms, addLaneForm, tagForms, addTagForm };
}

beforeEach(() => {
  document.body.innerHTML = "";
});
after(() => dom.window.close());

describe("the card exposes an editor", () => {
  test("getConfigElement returns one", () => {
    const made = customElements.get("todo-kanban-card").getConfigElement();
    assert.equal(made.localName, "todo-kanban-card-editor");
  });

  test("getStubConfig picks real todo entities", () => {
    const hass = { states: { "todo.a": {}, "todo.b": {}, "light.x": {}, "todo.c": {}, "todo.d": {} } };
    const stub = customElements.get("todo-kanban-card").getStubConfig(hass);
    assert.deepEqual(stub.lanes.map((l) => l.entity), ["todo.a", "todo.b", "todo.c"]);
    assert.doesNotThrow(() => document.createElement("todo-kanban-card").setConfig(stub));
  });

  test("getStubConfig still returns something valid with no todo lists", () => {
    const stub = customElements.get("todo-kanban-card").getStubConfig({ states: {} });
    assert.doesNotThrow(() => document.createElement("todo-kanban-card").setConfig(stub));
  });
});

describe("the editor form", () => {
  test("one form per lane, plus the card form and both add pickers", () => {
    const { laneForms, cardForm, addLaneForm, addTagForm } = editor();
    assert.equal(laneForms().length, 3);
    assert.ok(cardForm() && addLaneForm() && addTagForm());
  });

  test("asks for a todo entity picker, an icon and a colour", () => {
    const { laneForms } = editor();
    const lane = laneForms()[0];
    const names = lane.schema.flatMap((f) => (f.schema ? f.schema : [f])).map((f) => f.name);
    assert.deepEqual(names, ["entity", "title", "icon", "color"]);
    assert.deepEqual(lane.schema[0].selector, { entity: { domain: "todo" } });
    assert.ok(lane.schema[2].selector.ui_color);
  });

  test("passes each lane's own values down", () => {
    const { laneForms } = editor();
    assert.deepEqual(laneForms()[0].data,
      { entity: "todo.urgent", title: "Urgent", icon: "mdi:alert-octagon", color: "red" });
    assert.deepEqual(laneForms()[1].data, { entity: "todo.normal" });
  });
});

describe("editing", () => {
  test("renaming a lane keeps the rest of the config", () => {
    const { laneForms, cardForm, addLaneForm, changes } = editor();
    laneForms()[0].emit({ entity: "todo.urgent", title: "Right now", icon: "mdi:alert-octagon", color: "red" });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].lanes[0].title, "Right now");
    assert.equal(changes[0].lanes.length, 3);
    assert.equal(changes[0].title, "Shopping");
  });

  test("clearing a field removes the key rather than writing an empty one", () => {
    const { laneForms, cardForm, addLaneForm, changes } = editor();
    laneForms()[0].emit({ entity: "todo.urgent", title: "", icon: "", color: "" });
    assert.deepEqual(changes[0].lanes[0], { entity: "todo.urgent" });
  });

  test("a lane change with no entity is ignored", () => {
    const { laneForms, cardForm, addLaneForm, changes } = editor();
    laneForms()[0].emit({ entity: "", title: "orphan" });
    assert.equal(changes.length, 0);
  });

  test("card options round-trip, and defaults are not written out", () => {
    const { laneForms, cardForm, addLaneForm, changes } = editor();
    cardForm().emit({ title: "Groceries", default_collapsed: "auto",
                      hide_completed: true, hide_add: false, min_lane_width: 270 });
    const c = changes[0];
    assert.equal(c.title, "Groceries");
    assert.equal(c.hide_completed, true);
    assert.ok(!("default_collapsed" in c), "auto is the default and should not be written");
    assert.ok(!("hide_add" in c));
    assert.ok(!("min_lane_width" in c));
  });

  test("folding converts the dropdown's string back to a boolean", () => {
    const { laneForms, cardForm, addLaneForm, changes } = editor();
    cardForm().emit({ title: "", default_collapsed: "false", min_lane_width: 270 });
    assert.equal(changes[0].default_collapsed, false);
  });
});

describe("adding, removing and reordering lists", () => {
  test("the add picker appends a lane", () => {
    const { laneForms, cardForm, addLaneForm, changes } = editor();
    addLaneForm().emit({ add: "todo.spare" });
    assert.deepEqual(changes[0].lanes.map((l) => l.entity),
      ["todo.urgent", "todo.normal", "todo.later", "todo.spare"]);
  });

  test("an empty pick adds nothing", () => {
    const { laneForms, cardForm, addLaneForm, changes } = editor();
    addLaneForm().emit({ add: "" });
    assert.equal(changes.length, 0);
  });

  test("the delete button removes that lane", () => {
    const { el, changes } = editor();
    el.shadowRoot.querySelectorAll(".lane-row")[1]
      .querySelectorAll(".tool")[2].click();
    assert.deepEqual(changes[0].lanes.map((l) => l.entity), ["todo.urgent", "todo.later"]);
  });

  test("the last lane cannot be removed", () => {
    const { el, changes } = editor({ lanes: [{ entity: "todo.urgent" }] });
    const button = el.shadowRoot.querySelector(".lane-row").querySelectorAll(".tool")[2];
    assert.ok(button.hasAttribute("disabled"));
    button.click();
    assert.equal(changes.length, 0);
  });

  test("lanes move up and down, and cannot move off the ends", () => {
    const { el, changes } = editor();
    el.shadowRoot.querySelectorAll(".lane-row")[1].querySelectorAll(".tool")[0].click();
    assert.deepEqual(changes[0].lanes.map((l) => l.entity),
      ["todo.normal", "todo.urgent", "todo.later"]);
    const first = el.shadowRoot.querySelectorAll(".lane-row")[0];
    assert.ok(first.querySelectorAll(".tool")[0].hasAttribute("disabled"));
  });

  test("every config the editor emits is one the card accepts", () => {
    const { el, cardForm, addLaneForm, changes } = editor();
    addLaneForm().emit({ add: "todo.spare" });
    el.shadowRoot.querySelectorAll(".lane-row")[0].querySelectorAll(".tool")[2].click();
    cardForm().emit({ title: "x", default_collapsed: "true", min_lane_width: 200 });
    assert.ok(changes.length >= 3);
    for (const config of changes) {
      assert.doesNotThrow(() => document.createElement("todo-kanban-card").setConfig(config),
        `card rejected ${JSON.stringify(config)}`);
    }
  });
});

describe("colours", () => {
  test("a palette name becomes a theme variable, anything else is left alone", async () => {
    const { hass } = makeHass({ "todo.a": [{ uid: "1", summary: "x", status: "needs_action" }] }, []);
    const card = document.createElement("todo-kanban-card");
    card.setConfig({ default_collapsed: false, lanes: [
      { entity: "todo.a", color: "red" },
      { entity: "todo.a", color: "#9c27b0" },
      { entity: "todo.a", color: "var(--error-color)" },
    ]});
    card.hass = hass;
    document.body.appendChild(card);
    await tick();
    const got = [...card.shadowRoot.querySelectorAll(".lane")]
      .map((l) => l.style.getPropertyValue("--lane-accent"));
    assert.deepEqual(got, ["var(--red-color)", "#9c27b0", "var(--error-color)"]);
  });
});

describe("tag colours in the editor", () => {
  // The editor asks each list for its items to build the autocomplete, so the mock has
  // to answer todo/item/list rather than only carry states.
  function tagEditor(config) {
    const items = {
      "todo.urgent": [{ uid: "1", summary: "Milk #dairy", status: "needs_action" }],
      "todo.normal": [
        { uid: "2", summary: "#frozen Peas #veg", status: "needs_action" },
        { uid: "3", summary: "Plain item", status: "needs_action" },
      ],
      "todo.later": [{ uid: "4", summary: "Pan #kitchen", status: "needs_action" }],
    };
    const calls = [];
    const { hass } = makeHass(items, calls);
    const el = document.createElement("todo-kanban-card-editor");
    el.setConfig(structuredClone(config));
    el.hass = hass;
    document.body.appendChild(el);
    const changes = [];
    el.addEventListener("config-changed", (ev) => changes.push(ev.detail.config));
    const forms = () => [...el.shadowRoot.querySelectorAll("ha-form")];
    const names = (f) => f.schema.flatMap((x) => (x.schema ? x.schema : [x])).map((x) => x.name);
    const tagForms = () => forms().filter((f) => names(f).includes("tag"));
    const addTagForm = () => forms().find((f) => names(f).includes("add_tag"));
    return { el, changes, tagForms, addTagForm };
  }

  const BASE = { lanes: [{ entity: "todo.urgent" }, { entity: "todo.normal" }, { entity: "todo.later" }] };

  test("suggests the tags people have actually written", async () => {
    const { addTagForm } = tagEditor(BASE);
    await tick(40);
    assert.deepEqual(addTagForm().schema[0].selector.select.options,
      ["dairy", "frozen", "kitchen", "veg"]);
  });

  test("the suggestion field accepts a tag that does not exist yet", async () => {
    const { addTagForm } = tagEditor(BASE);
    await tick(40);
    assert.equal(addTagForm().schema[0].selector.select.custom_value, true);
  });

  test("configured tags are suggested too, even if nothing uses them yet", async () => {
    const { addTagForm } = tagEditor({ ...BASE, tags: { retired: "grey" } });
    await tick(40);
    assert.ok(addTagForm().schema[0].selector.select.options.includes("retired"));
  });

  test("one row per configured tag, prefilled", async () => {
    const { tagForms } = tagEditor({ ...BASE, tags: { dairy: "blue", veg: "green" } });
    await tick(40);
    assert.equal(tagForms().length, 2);
    assert.deepEqual(tagForms()[0].data, { tag: "dairy", color: "blue" });
    assert.deepEqual(tagForms()[1].data, { tag: "veg", color: "green" });
  });

  test("picking a tag adds a row, already on a colour", async () => {
    const { addTagForm, changes } = tagEditor(BASE);
    await tick(40);
    addTagForm().emit({ add_tag: "dairy" });
    assert.deepEqual(Object.keys(changes.at(-1).tags), ["dairy"]);
    assert.ok(changes.at(-1).tags.dairy, "a new tag should arrive with a colour to adjust");
  });

  test("a second tag does not get the same colour as the first", async () => {
    const { addTagForm, changes } = tagEditor({ ...BASE, tags: { dairy: "blue" } });
    await tick(40);
    addTagForm().emit({ add_tag: "veg" });
    const tags = changes.at(-1).tags;
    assert.notEqual(tags.veg, tags.dairy);
  });

  test("the same tag cannot be added twice", async () => {
    const { addTagForm, changes } = tagEditor({ ...BASE, tags: { dairy: "blue" } });
    await tick(40);
    addTagForm().emit({ add_tag: "dairy" });
    assert.equal(changes.length, 0);
  });

  test("setting a colour writes it against the tag", async () => {
    const { tagForms, changes } = tagEditor({ ...BASE, tags: { dairy: "" } });
    await tick(40);
    tagForms()[0].emit({ tag: "dairy", color: "purple" });
    assert.deepEqual(changes.at(-1).tags, { dairy: "purple" });
  });

  test("renaming a tag row replaces the key rather than adding one", async () => {
    const { tagForms, changes } = tagEditor({ ...BASE, tags: { dairy: "blue" } });
    await tick(40);
    tagForms()[0].emit({ tag: "milk", color: "blue" });
    assert.deepEqual(changes.at(-1).tags, { milk: "blue" });
  });

  test("removing the last tag drops the key entirely", async () => {
    const { el, changes } = tagEditor({ ...BASE, tags: { dairy: "blue" } });
    await tick(40);
    const rows = [...el.shadowRoot.querySelectorAll(".lane-row")];
    rows.at(-1).querySelector(".tool").click();
    assert.ok(!("tags" in changes.at(-1)), "an empty map should not be written out");
  });

  test("a nameless tag is never written", async () => {
    const { tagForms, changes } = tagEditor({ ...BASE, tags: { dairy: "blue" } });
    await tick(40);
    tagForms()[0].emit({ tag: "", color: "red" });
    assert.equal(changes.length, 0);
  });

  test("everything the tag editor emits is still a config the card accepts", async () => {
    const { addTagForm, tagForms, changes } = tagEditor({ ...BASE, tags: { dairy: "blue" } });
    await tick(40);
    addTagForm().emit({ add_tag: "veg" });
    tagForms()[0].emit({ tag: "dairy", color: "cyan" });
    assert.ok(changes.length >= 2);
    for (const config of changes) {
      assert.doesNotThrow(() => document.createElement("todo-kanban-card").setConfig(config));
    }
  });
});
