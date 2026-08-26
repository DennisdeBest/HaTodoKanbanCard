import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom, makeHass, tick, click, input } from "./helpers.mjs";

setupDom();
await import("../todo-kanban-card.js");

const LANES = [
  { entity: "todo.urgent", title: "Urgent", icon: "mdi:alert-octagon", color: "var(--error-color)" },
  { entity: "todo.normal", title: "Normal", icon: "mdi:cart" },
  { entity: "todo.later", title: "Later", icon: "mdi:calendar-clock" },
];

function fixture(overrides = {}, seed) {
  const items = seed || {
    "todo.urgent": [
      { uid: "u1", summary: "Bin bags", status: "needs_action", due: null, description: null },
      { uid: "u2", summary: "Pepper", status: "needs_action", due: "2026-08-27", description: "coarse" },
    ],
    "todo.normal": [
      { uid: "n1", summary: "Lemon juice", status: "needs_action" },
      { uid: "n2", summary: "Cling film", status: "completed" },
    ],
    "todo.later": [],
  };
  const calls = [];
  const { hass, subs } = makeHass(items, calls);
  const card = document.createElement("todo-kanban-card");
  card.setConfig({ lanes: LANES, ...overrides });
  card.hass = hass;
  document.body.appendChild(card);
  const $ = (s) => card.shadowRoot.querySelector(s);
  const $$ = (s) => [...card.shadowRoot.querySelectorAll(s)];
  return { card, calls, items, subs, $, $$ };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("rendering", () => {
  test("draws one lane per config entry", async () => {
    const { $$ } = fixture();
    await tick();
    assert.equal($$(".lane").length, 3);
  });

  test("renders each render into a clean shadow root", async () => {
    // Regression: `shadowRoot.querySelectorAll(":scope > *")` matches nothing, which
    // stacked every render on top of the last one.
    const { card, $$, subs, items } = fixture();
    await tick();
    subs.find(([, e]) => e === "todo.urgent")[0]({ items: items["todo.urgent"] });
    subs.find(([, e]) => e === "todo.urgent")[0]({ items: items["todo.urgent"] });
    await tick();
    assert.equal($$(".lane").length, 3);
    assert.equal(card.shadowRoot.querySelectorAll("ha-card").length, 1);
  });

  test("shows outstanding items, hides completed behind a toggle", async () => {
    const { $$ } = fixture();
    await tick();
    const [urgent, normal] = $$(".lane");
    assert.equal(urgent.querySelectorAll(".items > [data-uid]").length, 2);
    assert.equal(urgent.querySelector(".count").textContent, "2");
    assert.equal(normal.querySelectorAll(".items > [data-uid]").length, 1);
    assert.match(normal.querySelector(".done-head").textContent, /1 done/);
  });

  test("marks a due date and a note", async () => {
    const { $$ } = fixture();
    await tick();
    const urgent = $$(".lane")[0];
    assert.ok(urgent.querySelector(".due"));
    assert.ok(urgent.querySelector(".note"));
  });

  test("an empty lane starts collapsed, a full one starts open", async () => {
    const { $$ } = fixture();
    await tick();
    const [urgent, normal, later] = $$(".lane");
    assert.ok(!urgent.classList.contains("collapsed"));
    assert.ok(!normal.classList.contains("collapsed"));
    assert.ok(later.classList.contains("collapsed"));
  });

  test("says so when an entity is missing", async () => {
    const { card, $$ } = fixture();
    await tick();
    delete card._hass.states["todo.later"];
    card._render();
    assert.match($$(".lane")[2].textContent, /not available/);
  });
});

describe("controls", () => {
  test("the checkbox completes an item", async () => {
    const { $$, calls } = fixture();
    await tick();
    click($$(".lane")[0].querySelector(".check"));
    assert.deepEqual(calls.at(-1)[0], "todo.update_item");
    assert.equal(calls.at(-1)[1].status, "completed");
  });

  test("the checkbox un-completes one that is already done", async () => {
    const { $$, calls } = fixture();
    await tick();
    click($$(".lane")[1].querySelector(".link")); // reveal the done section
    click($$(".lane")[1].querySelector(".done-items .check"));
    assert.equal(calls.at(-1)[1].status, "needs_action");
  });

  test("the add box adds to its own lane", async () => {
    const { $$, calls } = fixture();
    await tick();
    const lane = $$(".lane")[1];
    input(lane.querySelector(".add .field"), "Milk");
    click(lane.querySelector(".add .icon-btn"));
    await tick();
    assert.equal(calls.at(-1)[0], "todo.add_item");
    assert.deepEqual(calls.at(-1)[1], { entity_id: "todo.normal", item: "Milk" });
  });

  test("an empty add box does nothing", async () => {
    const { $$, calls } = fixture();
    await tick();
    const before = calls.length;
    input($$(".lane")[1].querySelector(".add .field"), "   ");
    click($$(".lane")[1].querySelector(".add .icon-btn"));
    await tick();
    assert.equal(calls.length, before);
  });

  test("clear removes the completed items", async () => {
    const { $$, calls } = fixture();
    await tick();
    click($$(".lane")[1].querySelector(".link.danger"));
    assert.equal(calls.at(-1)[0], "todo.remove_completed_items");
  });
});

describe("collapsing", () => {
  test("a click on the header sticks", async () => {
    const { $$ } = fixture();
    await tick();
    click($$(".lane")[0].querySelector(".lane-head"));
    assert.ok($$(".lane")[0].classList.contains("collapsed"));
    assert.equal(localStorage.getItem("todo-kanban.collapsed.todo.urgent"), "1");
  });

  test("crossing empty resets the lane to its default", async () => {
    const { $$, subs, items } = fixture();
    await tick();
    click($$(".lane")[0].querySelector(".lane-head"));
    subs.find(([, e]) => e === "todo.urgent")[0]({ items: [] });
    await tick();
    assert.equal(localStorage.getItem("todo-kanban.collapsed.todo.urgent"), null);
    items["todo.urgent"] = [{ uid: "u9", summary: "Back", status: "needs_action" }];
    subs.find(([, e]) => e === "todo.urgent")[0]({ items: items["todo.urgent"] });
    await tick();
    assert.ok(!$$(".lane")[0].classList.contains("collapsed"));
  });

  test("default_collapsed: true pins every lane shut", async () => {
    const { $$ } = fixture({ default_collapsed: true });
    await tick();
    assert.equal($$(".lane.collapsed").length, 3);
  });

  test("default_collapsed: false pins them open, empty ones included", async () => {
    const { $$ } = fixture({ default_collapsed: false });
    await tick();
    assert.equal($$(".lane.collapsed").length, 0);
  });

  test("a pinned lane keeps a manual override across an empty crossing", async () => {
    const { $$, subs } = fixture({ default_collapsed: false });
    await tick();
    click($$(".lane")[0].querySelector(".lane-head"));
    subs.find(([, e]) => e === "todo.urgent")[0]({ items: [] });
    await tick();
    assert.equal(localStorage.getItem("todo-kanban.collapsed.todo.urgent"), "1");
  });

  test("a lane can override the card", async () => {
    const { $$ } = fixture({
      default_collapsed: true,
      lanes: [{ ...LANES[0], default_collapsed: false }, LANES[1], LANES[2]],
    });
    await tick();
    assert.ok(!$$(".lane")[0].classList.contains("collapsed"));
    assert.ok($$(".lane")[1].classList.contains("collapsed"));
  });
});

describe("options", () => {
  test("hide_completed drops the done section entirely", async () => {
    const { $$ } = fixture({ hide_completed: true });
    await tick();
    assert.equal($$(".done-head").length, 0);
  });

  test("hide_add drops the add box", async () => {
    const { $$ } = fixture({ hide_add: true });
    await tick();
    assert.equal($$(".add").length, 0);
  });

  test("hide_add can be set on one lane only", async () => {
    const { $$ } = fixture({ lanes: [{ ...LANES[0], hide_add: true }, LANES[1], LANES[2]] });
    await tick();
    assert.equal($$(".lane")[0].querySelectorAll(".add").length, 0);
    assert.equal($$(".lane")[1].querySelectorAll(".add").length, 1);
  });

  test("min_lane_width reaches the board", async () => {
    const { $ } = fixture({ min_lane_width: 400 });
    await tick();
    assert.equal($(".board").style.getPropertyValue("--lane-min"), "400px");
  });

  test("a lane colour reaches the lane as a custom property", async () => {
    const { $$ } = fixture();
    await tick();
    assert.equal($$(".lane")[0].style.getPropertyValue("--lane-accent"), "var(--error-color)");
  });

  test("title renders when given", async () => {
    const { $ } = fixture({ title: "Shopping" });
    await tick();
    assert.equal($(".card-title").textContent, "Shopping");
  });
});

describe("the item editor", () => {
  test("opens prefilled and offers the other lanes", async () => {
    const { $, $$ } = fixture();
    await tick();
    click($$(".lane")[1].querySelector(".items > [data-uid] .label"));
    assert.ok($(".editor"));
    assert.equal($(".editor input[type=text]").value, "Lemon juice");
    assert.equal($$(".editor .moveto .chip").length, 2);
  });

  test("saves a rename and a due date in one call", async () => {
    const { $, $$, calls } = fixture();
    await tick();
    click($$(".lane")[1].querySelector(".items > [data-uid] .label"));
    $(".editor input[type=text]").value = "Lime juice";
    $(".editor input[type=date]").value = "2026-09-01";
    click([...$(".editor").querySelectorAll(".actions .chip")].at(-1));
    await tick();
    assert.equal(calls.at(-1)[0], "todo.update_item");
    assert.equal(calls.at(-1)[1].rename, "Lime juice");
    assert.equal(calls.at(-1)[1].due_date, "2026-09-01");
    assert.equal($(".editor"), null);
  });

  test("clears a due date with null, never an empty string", async () => {
    // `due_date: ""` is a 400 from the todo integration; null is how you clear it.
    const { $, $$, calls } = fixture();
    await tick();
    click($$(".lane")[0].querySelectorAll(".items > [data-uid] .label")[1]); // has a due date
    $(".editor input[type=date]").value = "";
    click([...$(".editor").querySelectorAll(".actions .chip")].at(-1));
    await tick();
    assert.equal(calls.at(-1)[1].due_date, null);
  });

  test("saves nothing when nothing changed", async () => {
    const { $, $$, calls } = fixture();
    await tick();
    click($$(".lane")[1].querySelector(".items > [data-uid] .label"));
    const before = calls.length;
    click([...$(".editor").querySelectorAll(".actions .chip")].at(-1));
    await tick();
    assert.equal(calls.length, before);
  });

  test("delete removes the item", async () => {
    const { $, $$, calls } = fixture();
    await tick();
    click($$(".lane")[1].querySelector(".items > [data-uid] .label"));
    click($(".editor .actions .chip.danger"));
    await tick();
    assert.equal(calls.at(-1)[0], "todo.remove_item");
    assert.equal(calls.at(-1)[1].item, "n1");
  });

  test("a push from elsewhere does not wipe a half-typed edit", async () => {
    const { $, $$, subs } = fixture();
    await tick();
    click($$(".lane")[1].querySelector(".items > [data-uid] .label"));
    $(".editor input[type=text]").value = "half typed";
    subs.find(([, e]) => e === "todo.normal")[0]({
      items: [{ uid: "zz", summary: "someone else added this", status: "needs_action" }],
    });
    await tick();
    assert.equal($(".editor input[type=text]").value, "half typed");
  });
});

describe("moving between lanes", () => {
  test("the Move to button adds to the target then removes from the source", async () => {
    const { $, $$, calls } = fixture();
    await tick();
    click($$(".lane")[1].querySelector(".items > [data-uid] .label"));
    const before = calls.length;
    click($(".editor .moveto .chip"));
    await tick(30);
    const seq = calls.slice(before).map((c) => c[0]);
    assert.ok(seq.indexOf("todo.add_item") < seq.indexOf("todo.remove_item"));
    assert.equal(calls.slice(before).find((c) => c[0] === "todo.add_item")[1].entity_id, "todo.urgent");
    assert.equal(calls.slice(before).find((c) => c[0] === "todo.remove_item")[1].entity_id, "todo.normal");
  });

  test("a move carries the due date and the note across", async () => {
    const { card, calls } = fixture();
    await tick();
    const before = calls.length;
    await card._moveBetween(
      "todo.normal",
      { uid: "n1", summary: "Lemon juice", due: "2026-09-01", description: "unwaxed" },
      "todo.urgent",
      undefined
    );
    const added = calls.slice(before).find((c) => c[0] === "todo.add_item")[1];
    assert.equal(added.due_date, "2026-09-01");
    assert.equal(added.description, "unwaxed");
  });
});

describe("the drop arithmetic", () => {
  const seed = {
    "todo.urgent": [
      { uid: "a", summary: "A", status: "needs_action" },
      { uid: "b", summary: "B", status: "needs_action" },
      { uid: "c", summary: "C", status: "needs_action" },
    ],
    "todo.normal": [{ uid: "x", summary: "X", status: "needs_action" }],
    "todo.later": [],
  };

  function drag(card, from, item, target) {
    card._drag = {
      from,
      item,
      row: document.createElement("div"),
      ghost: document.createElement("div"),
      placeholder: document.createElement("div"),
      target,
    };
  }

  test("dropping at the top sends no previous_uid", async () => {
    const { card, calls } = fixture({}, structuredClone(seed));
    await tick();
    calls.length = 0;
    drag(card, "todo.urgent", seed["todo.urgent"][2], { entity: "todo.urgent", beforeUid: null, append: false });
    await card._onDragEnd();
    assert.equal(calls[0][1].type, "todo/item/move");
    assert.equal(calls[0][1].uid, "c");
    assert.ok(!("previous_uid" in calls[0][1]));
  });

  test("dropping an item back where it already sits calls nothing", async () => {
    const { card, calls } = fixture({}, structuredClone(seed));
    await tick();
    calls.length = 0;
    drag(card, "todo.urgent", seed["todo.urgent"][1], { entity: "todo.urgent", beforeUid: "a", append: false });
    await card._onDragEnd();
    assert.equal(calls.length, 0);
  });

  test("dropping on a collapsed header appends rather than jumping to the top", async () => {
    const { card, calls } = fixture({}, structuredClone(seed));
    await tick();
    calls.length = 0;
    drag(card, "todo.urgent", seed["todo.urgent"][0], { entity: "todo.urgent", beforeUid: null, append: true });
    await card._onDragEnd();
    assert.equal(calls[0][1].previous_uid, "c");
  });

  test("a cross-lane drop moves rather than reorders", async () => {
    const { card, calls } = fixture({}, structuredClone(seed));
    await tick();
    calls.length = 0;
    drag(card, "todo.urgent", seed["todo.urgent"][0], { entity: "todo.normal", beforeUid: "x", append: false });
    await card._onDragEnd();
    const kinds = calls.map((c) => c[0]);
    assert.ok(kinds.includes("todo.add_item"));
    assert.ok(kinds.includes("todo.remove_item"));
  });
});

describe("config validation", () => {
  for (const [name, cfg] of [
    ["no lanes at all", {}],
    ["an empty lane list", { lanes: [] }],
    ["a lane with no entity", { lanes: [{}] }],
    ["a lane that is not a todo entity", { lanes: [{ entity: "light.kitchen" }] }],
    ["a bad default_collapsed", { lanes: [{ entity: "todo.x" }], default_collapsed: "sometimes" }],
  ]) {
    test(`rejects ${name}`, () => {
      assert.throws(() => document.createElement("todo-kanban-card").setConfig(cfg));
    });
  }

  test("getStubConfig gives the card picker something valid", () => {
    const card = document.createElement("todo-kanban-card");
    assert.doesNotThrow(() => card.setConfig(customElements.get("todo-kanban-card").getStubConfig()));
  });
});
