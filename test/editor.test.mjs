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
  return { el, changes, forms, hass };
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
    const { forms } = editor();
    assert.equal(forms().length, 3 + 2);
  });

  test("asks for a todo entity picker, an icon and a colour", () => {
    const { forms } = editor();
    const lane = forms()[1];
    const names = lane.schema.flatMap((f) => (f.schema ? f.schema : [f])).map((f) => f.name);
    assert.deepEqual(names, ["entity", "title", "icon", "color"]);
    assert.deepEqual(lane.schema[0].selector, { entity: { domain: "todo" } });
    assert.ok(lane.schema[2].selector.ui_color);
  });

  test("passes each lane's own values down", () => {
    const { forms } = editor();
    assert.deepEqual(forms()[1].data,
      { entity: "todo.urgent", title: "Urgent", icon: "mdi:alert-octagon", color: "red" });
    assert.deepEqual(forms()[2].data, { entity: "todo.normal" });
  });
});

describe("editing", () => {
  test("renaming a lane keeps the rest of the config", () => {
    const { forms, changes } = editor();
    forms()[1].emit({ entity: "todo.urgent", title: "Right now", icon: "mdi:alert-octagon", color: "red" });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].lanes[0].title, "Right now");
    assert.equal(changes[0].lanes.length, 3);
    assert.equal(changes[0].title, "Shopping");
  });

  test("clearing a field removes the key rather than writing an empty one", () => {
    const { forms, changes } = editor();
    forms()[1].emit({ entity: "todo.urgent", title: "", icon: "", color: "" });
    assert.deepEqual(changes[0].lanes[0], { entity: "todo.urgent" });
  });

  test("a lane change with no entity is ignored", () => {
    const { forms, changes } = editor();
    forms()[1].emit({ entity: "", title: "orphan" });
    assert.equal(changes.length, 0);
  });

  test("card options round-trip, and defaults are not written out", () => {
    const { forms, changes } = editor();
    forms()[0].emit({ title: "Groceries", default_collapsed: "auto",
                      hide_completed: true, hide_add: false, min_lane_width: 270 });
    const c = changes[0];
    assert.equal(c.title, "Groceries");
    assert.equal(c.hide_completed, true);
    assert.ok(!("default_collapsed" in c), "auto is the default and should not be written");
    assert.ok(!("hide_add" in c));
    assert.ok(!("min_lane_width" in c));
  });

  test("folding converts the dropdown's string back to a boolean", () => {
    const { forms, changes } = editor();
    forms()[0].emit({ title: "", default_collapsed: "false", min_lane_width: 270 });
    assert.equal(changes[0].default_collapsed, false);
  });
});

describe("adding, removing and reordering lists", () => {
  test("the add picker appends a lane", () => {
    const { forms, changes } = editor();
    forms().at(-1).emit({ add: "todo.spare" });
    assert.deepEqual(changes[0].lanes.map((l) => l.entity),
      ["todo.urgent", "todo.normal", "todo.later", "todo.spare"]);
  });

  test("an empty pick adds nothing", () => {
    const { forms, changes } = editor();
    forms().at(-1).emit({ add: "" });
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
    const { el, forms, changes } = editor();
    forms().at(-1).emit({ add: "todo.spare" });
    el.shadowRoot.querySelectorAll(".lane-row")[0].querySelectorAll(".tool")[2].click();
    forms()[0].emit({ title: "x", default_collapsed: "true", min_lane_width: 200 });
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
