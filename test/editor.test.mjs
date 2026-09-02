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
  test("one form per lane, plus the card form and the add picker", () => {
    const { laneForms, cardForm, addLaneForm } = editor();
    assert.equal(laneForms().length, 3);
    assert.ok(cardForm() && addLaneForm());
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
  /*
   * The editor watches the configured lists, so this mock has to answer
   * todo/item/subscribe — which is also how a tag invented while the dialog is open
   * turns up in it.
   */
  function tagEditor(config, items) {
    const seeded = items || {
      "todo.urgent": [{ uid: "1", summary: "Milk #dairy", status: "needs_action" }],
      "todo.normal": [{ uid: "2", summary: "#frozen Peas #veg", status: "needs_action" }],
      "todo.later": [{ uid: "4", summary: "Pan #kitchen", status: "needs_action" }],
    };
    const calls = [];
    const { hass, subs } = makeHass(seeded, calls);
    const el = document.createElement("todo-kanban-card-editor");
    el.setConfig(structuredClone(config));
    el.hass = hass;
    document.body.appendChild(el);
    const changes = [];
    el.addEventListener("config-changed", (ev) => changes.push(ev.detail.config));
    const rows = () => [...el.shadowRoot.querySelectorAll(".tag-row")];
    const rowFor = (tag) => rows().find((r) => r.querySelector(".tag-preview").textContent === tag);
    return { el, changes, rows, rowFor, subs };
  }

  const BASE = { lanes: [{ entity: "todo.urgent" }, { entity: "todo.normal" }, { entity: "todo.later" }] };

  test("lists every tag written on an item, not only the configured ones", async () => {
    const { rows } = tagEditor(BASE);
    await tick(40);
    assert.deepEqual(rows().map((r) => r.querySelector(".tag-preview").textContent),
      ["dairy", "frozen", "kitchen", "veg"]);
  });

  test("a configured tag with nothing using it is listed too", async () => {
    const { rows } = tagEditor({ ...BASE, tags: { retired: "grey" } });
    await tick(40);
    assert.ok(rows().some((r) => r.querySelector(".tag-preview").textContent === "retired"));
  });

  test("an uncoloured tag is marked automatic and carries no colour in the form", async () => {
    const { rowFor } = tagEditor(BASE);
    await tick(40);
    const row = rowFor("dairy");
    assert.ok(row.querySelector(".auto-note"), "expected the automatic marker");
    assert.deepEqual(row.querySelector("ha-form").data, { color: "" });
  });

  test("the preview chip wears the colour the tag is drawn in", async () => {
    const { rowFor } = tagEditor({ ...BASE, tags: { dairy: "blue" } });
    await tick(40);
    assert.equal(rowFor("dairy").querySelector(".tag-preview").style.getPropertyValue("--tag-color"),
      "var(--blue-color)");
    // an automatic one still gets something, just not a configured one
    assert.match(rowFor("veg").querySelector(".tag-preview").style.getPropertyValue("--tag-color"),
      /^var\(--[a-z-]+-color\)$/);
  });

  test("choosing a colour writes it against the tag", async () => {
    const { rowFor, changes } = tagEditor(BASE);
    await tick(40);
    rowFor("dairy").querySelector("ha-form").emit({ color: "purple" });
    assert.deepEqual(changes.at(-1).tags, { dairy: "purple" });
  });

  test("an automatic colour is never written into the config", async () => {
    const { rowFor, changes } = tagEditor({ ...BASE, tags: { dairy: "blue" } });
    await tick(40);
    rowFor("veg").querySelector("ha-form").emit({ color: "" });
    assert.deepEqual(changes.at(-1).tags, { dairy: "blue" }, "only chosen colours belong in config");
  });

  test("resetting a tag puts it back to automatic", async () => {
    const { rowFor, changes } = tagEditor({ ...BASE, tags: { dairy: "blue", veg: "green" } });
    await tick(40);
    rowFor("dairy").querySelector(".tool").click();
    assert.deepEqual(changes.at(-1).tags, { veg: "green" });
  });

  test("resetting the last one drops the key entirely", async () => {
    const { rowFor, changes } = tagEditor({ ...BASE, tags: { dairy: "blue" } });
    await tick(40);
    rowFor("dairy").querySelector(".tool").click();
    assert.ok(!("tags" in changes.at(-1)));
  });

  test("a tag invented while the dialog is open shows up in it", async () => {
    const { rows, subs } = tagEditor(BASE);
    await tick(40);
    assert.ok(!rows().some((r) => r.querySelector(".tag-preview").textContent === "baking"));
    subs.find(([, e]) => e === "todo.urgent")[0]({
      items: [{ uid: "9", summary: 'Flour #"baking"', status: "needs_action" }],
    });
    await tick(40);
    assert.ok(rows().some((r) => r.querySelector(".tag-preview").textContent === "baking"),
      "a tag typed while the editor is open should appear without reopening it");
  });

  test("says so when there are no tags at all", async () => {
    const { el, rows } = tagEditor(BASE, { "todo.urgent": [], "todo.normal": [], "todo.later": [] });
    await tick(40);
    assert.equal(rows().length, 0);
    assert.match(el.shadowRoot.textContent, /No tags yet/);
  });

  test("everything it emits is still a config the card accepts", async () => {
    const { rowFor, changes } = tagEditor({ ...BASE, tags: { dairy: "blue" } });
    await tick(40);
    rowFor("veg").querySelector("ha-form").emit({ color: "cyan" });
    rowFor("dairy").querySelector(".tool").click();
    assert.ok(changes.length >= 2);
    for (const config of changes) {
      assert.doesNotThrow(() => document.createElement("todo-kanban-card").setConfig(config));
    }
  });
});
