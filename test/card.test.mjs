import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom, makeHass, tick, click, input } from "./helpers.mjs";

const dom = setupDom();
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

  test("a completed item has no drag handle", async () => {
    // Moving a done item cannot do anything useful: a move changes position, not
    // status, so it would snap back under "done" on the next render.
    const { $$ } = fixture();
    await tick();
    const lane = $$(".lane")[1];
    click(lane.querySelector(".link"));                    // reveal the done section
    const doneRow = lane.querySelector(".done-items > [data-uid]");
    assert.ok(doneRow, "expected a completed row");
    assert.equal(doneRow.querySelector(".grip"), null);
    assert.ok(lane.querySelector(".items > [data-uid] .grip"), "open items keep theirs");
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

describe("tags written into an item", () => {
  const tagged = {
    "todo.urgent": [
      { uid: "t1", summary: "Milk #dairy", status: "needs_action" },
      { uid: "t2", summary: "#frozen Peas #veg", status: "needs_action" },
      { uid: "t3", summary: "Nothing tagged here", status: "needs_action" },
    ],
    "todo.normal": [],
    "todo.later": [],
  };
  const chips = (row) => [...row.querySelectorAll(".tag")].map((c) => c.textContent);

  test("shows tags as chips and takes them out of the item's text", async () => {
    const { $$ } = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(tagged));
    await tick();
    const rows = $$(".lane")[0].querySelectorAll(".items > [data-uid]");
    assert.equal(rows[0].querySelector(".summary").textContent, "Milk");
    assert.deepEqual(chips(rows[0]), ["dairy"]);
    assert.equal(rows[1].querySelector(".summary").textContent, "Peas");
    assert.deepEqual(chips(rows[1]), ["frozen", "veg"]);
  });

  test("an untagged item is left alone", async () => {
    const { $$ } = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(tagged));
    await tick();
    const row = $$(".lane")[0].querySelectorAll(".items > [data-uid]")[2];
    assert.equal(row.querySelector(".summary").textContent, "Nothing tagged here");
    assert.equal(chips(row).length, 0);
  });

  test("a configured tag gets its colour", async () => {
    const { $$ } = fixture(
      { default_collapsed: false, enable_tags: true, tags: { dairy: "blue", veg: "#4caf50" } },
      structuredClone(tagged)
    );
    await tick();
    const rows = $$(".lane")[0].querySelectorAll(".items > [data-uid]");
    assert.equal(rows[0].querySelector(".tag").style.getPropertyValue("--tag-color"),
      "var(--blue-color)");
    assert.equal([...rows[1].querySelectorAll(".tag")][1].style.getPropertyValue("--tag-color"),
      "#4caf50");
  });

  test("an unconfigured tag is given a colour of its own, the same one every time", async () => {
    const paint = () => {
      document.body.innerHTML = "";
      const { $$ } = fixture({ default_collapsed: false, enable_tags: true },
        structuredClone(tagged));
      return $$;
    };
    const first = paint();
    await tick();
    const colour = first(".lane")[1] && null;   // settle
    const chips = () => [...document.querySelector("todo-kanban-card").shadowRoot
      .querySelectorAll(".tag")].map((c) => c.style.getPropertyValue("--tag-color"));
    const once = chips();
    assert.ok(once.every((c) => /^var\(--[a-z-]+-color\)$/.test(c)),
      `expected palette colours, got ${JSON.stringify(once)}`);
    paint();
    await tick();
    assert.deepEqual(chips(), once, "the same tag should not change colour between renders");
  });

  test("tags are off unless asked for, leaving the raw text alone", async () => {
    const { $$ } = fixture(
      { default_collapsed: false, enable_tags: false },
      structuredClone(tagged)
    );
    await tick();
    const row = $$(".lane")[0].querySelector(".items > [data-uid]");
    assert.equal(row.querySelector(".summary").textContent, "Milk #dairy");
    assert.equal(chips(row).length, 0);
  });

  test("the editor still shows the full text, tags included", async () => {
    const { $, $$ } = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(tagged));
    await tick();
    click($$(".lane")[0].querySelector(".items > [data-uid] .label"));
    assert.equal($(".editor input[type=text]").value, "Milk #dairy");
  });

  test("renaming through the editor keeps whatever tags were typed", async () => {
    const { $, $$, calls } = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(tagged));
    await tick();
    click($$(".lane")[0].querySelector(".items > [data-uid] .label"));
    $(".editor input[type=text]").value = "Oat milk #dairy #new";
    click([...$(".editor").querySelectorAll(".actions .chip")].at(-1));
    await tick();
    assert.equal(calls.at(-1)[1].rename, "Oat milk #dairy #new");
  });

  test("rejects a tags value that is not a map", () => {
    assert.throws(() => document.createElement("todo-kanban-card")
      .setConfig({ lanes: [{ entity: "todo.a" }], tags: ["dairy"] }));
  });
});

describe("picking tags instead of typing them", () => {
  const seeded = {
    "todo.urgent": [{ uid: "p1", summary: "Milk #dairy", status: "needs_action" }],
    "todo.normal": [{ uid: "p2", summary: "Peas #frozen #veg", status: "needs_action" }],
    "todo.later": [],
  };

  test("suggestions come from tags in use plus tags given a colour", async () => {
    const { card } = fixture({ enable_tags: true, tags: { pantry: "brown" } }, structuredClone(seeded));
    await tick();
    assert.deepEqual(card._knownTags(), ["dairy", "frozen", "pantry", "veg"]);
  });

  test("the add box has a tag button that reveals the suggestions", async () => {
    const { $$ } = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(seeded));
    await tick();
    const add = $$(".lane")[0].querySelector(".add");
    const suggest = add.querySelector(".tag-suggest");
    assert.ok(suggest.hidden, "starts out of the way");
    click(add.querySelector(".tag-btn"));
    assert.ok(!suggest.hidden);
    assert.deepEqual([...suggest.querySelectorAll(".tag-chip")].map((c) => c.textContent),
      ["dairy", "frozen", "veg"]);
  });

  test("clicking a suggestion writes the tag into the field", async () => {
    const { $$ } = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(seeded));
    await tick();
    const add = $$(".lane")[0].querySelector(".add");
    const field = add.querySelector(".field");
    field.value = "Butter";
    click(add.querySelector(".tag-btn"));
    click(add.querySelectorAll(".tag-chip")[0]);
    assert.equal(field.value, "Butter #dairy");
  });

  test("clicking it again takes the tag back out", async () => {
    const { $$ } = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(seeded));
    await tick();
    const add = $$(".lane")[0].querySelector(".add");
    const field = add.querySelector(".field");
    field.value = "Butter";
    click(add.querySelector(".tag-btn"));
    const chip = add.querySelectorAll(".tag-chip")[0];
    click(chip);
    click(chip);
    assert.equal(field.value, "Butter");
  });

  test("an added item carries the picked tag through to the service call", async () => {
    const { $$, calls } = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(seeded));
    await tick();
    const add = $$(".lane")[0].querySelector(".add");
    input(add.querySelector(".field"), "Butter");
    click(add.querySelector(".tag-btn"));
    click(add.querySelectorAll(".tag-chip")[0]);
    click(add.querySelector(".icon-btn"));
    await tick();
    assert.equal(calls.at(-1)[0], "todo.add_item");
    assert.equal(calls.at(-1)[1].item, "Butter #dairy");
  });

  test("the tag buttons never steal focus from the field", async () => {
    const { $$ } = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(seeded));
    await tick();
    const add = $$(".lane")[0].querySelector(".add");
    click(add.querySelector(".tag-btn"));
    for (const el of [add.querySelector(".tag-btn"), add.querySelector(".tag-chip")]) {
      const ev = new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      assert.ok(ev.defaultPrevented, `${el.className} stole focus`);
    }
  });

  test("the item editor offers the same chips, showing which are already on", async () => {
    const { $, $$ } = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(seeded));
    await tick();
    click($$(".lane")[0].querySelector(".items > [data-uid] .label"));
    const chips = [...$(".editor").querySelectorAll(".tag-chip")];
    assert.deepEqual(chips.map((c) => c.textContent), ["dairy", "frozen", "veg"]);
    assert.ok(chips[0].classList.contains("on"), "dairy is on this item");
    assert.ok(!chips[1].classList.contains("on"));
  });

  test("toggling a chip in the editor edits the name, and saving keeps it", async () => {
    const { $, $$, calls } = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(seeded));
    await tick();
    click($$(".lane")[0].querySelector(".items > [data-uid] .label"));
    click([...$(".editor").querySelectorAll(".tag-chip")][1]);   // frozen
    assert.equal($(".editor input[type=text]").value, "Milk #dairy #frozen");
    click([...$(".editor").querySelectorAll(".actions .chip")].at(-1));
    await tick();
    assert.equal(calls.at(-1)[1].rename, "Milk #dairy #frozen");
  });
});

describe("tags are opt-in", () => {
  const withHash = {
    "todo.urgent": [{ uid: "h1", summary: "Call #12 plumber #home", status: "needs_action" }],
    "todo.normal": [], "todo.later": [],
  };

  test("by default a # in an item is just text", async () => {
    const { $$ } = fixture({ default_collapsed: false }, structuredClone(withHash));
    await tick();
    const row = $$(".lane")[0].querySelector(".items > [data-uid]");
    assert.equal(row.querySelector(".summary").textContent, "Call #12 plumber #home");
    assert.equal(row.querySelectorAll(".tag").length, 0);
  });

  test("and the tag button is not offered", async () => {
    const { $$ } = fixture({ default_collapsed: false }, structuredClone(withHash));
    await tick();
    assert.equal($$(".lane")[0].querySelectorAll(".add .tag-btn").length, 0);
  });

  test("enable_tags turns it on, and can be set for one lane only", async () => {
    const { $$ } = fixture({
      default_collapsed: false,
      lanes: [{ entity: "todo.urgent", enable_tags: true }, { entity: "todo.normal" }, { entity: "todo.later" }],
    }, structuredClone(withHash));
    await tick();
    assert.equal($$(".lane")[0].querySelectorAll(".add .tag-btn").length, 1);
    assert.equal($$(".lane")[1].querySelectorAll(".add .tag-btn").length, 0);
    assert.equal($$(".lane")[0].querySelector(".summary").textContent, "Call plumber");
  });
});

describe("completing a tag as you type", () => {
  const seeded = {
    "todo.urgent": [{ uid: "c1", summary: "Milk #dairy", status: "needs_action" }],
    "todo.normal": [{ uid: "c2", summary: "Peas #frozen #veg #dessert", status: "needs_action" }],
    "todo.later": [],
  };
  const setup = async () => {
    const f = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(seeded));
    await tick();
    const add = f.$$(".lane")[0].querySelector(".add");
    return { ...f, add, field: add.querySelector(".field"), suggest: add.querySelector(".tag-suggest") };
  };
  const type = (field, value) => {
    field.value = value;
    field.setSelectionRange(value.length, value.length);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const shown = (suggest) => [...suggest.querySelectorAll(".tag-chip")].map((c) => c.textContent);

  test("typing # offers everything, and narrows as you go", async () => {
    const { field, suggest } = await setup();
    type(field, "Butter #");
    assert.deepEqual(shown(suggest), ["dairy", "dessert", "frozen", "veg"]);
    type(field, "Butter #d");
    assert.deepEqual(shown(suggest), ["dairy", "dessert"]);
    type(field, "Butter #dai");
    assert.deepEqual(shown(suggest), ["dairy"]);
  });

  test("no matches means no suggestions in the way", async () => {
    const { field, suggest } = await setup();
    type(field, "Butter #zzz");
    assert.ok(suggest.hidden);
  });

  test("plain text shows nothing", async () => {
    const { field, suggest } = await setup();
    type(field, "Butter");
    assert.ok(suggest.hidden);
  });

  test("clicking a match completes the word being typed", async () => {
    const { field, suggest } = await setup();
    type(field, "Butter #dai");
    click(suggest.querySelector(".tag-chip"));
    assert.equal(field.value, "Butter #dairy ");
  });

  test("tab takes the first match", async () => {
    const { field, suggest } = await setup();
    type(field, "Butter #d");
    field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    assert.equal(field.value, "Butter #dairy ");
    assert.ok(suggest.hidden || shown(suggest).length >= 0);
  });

  test("enter still adds the item rather than accepting a completion", async () => {
    const { field, calls } = await setup();
    type(field, "Butter #dai");
    field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    assert.equal(calls.at(-1)[0], "todo.add_item");
    assert.equal(calls.at(-1)[1].item, "Butter #dai");
  });

  test("completing mid-sentence keeps what came after", async () => {
    const { field, suggest } = await setup();
    field.value = "Butter #dai for the cake";
    field.setSelectionRange(11, 11);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    click(suggest.querySelector(".tag-chip"));
    assert.equal(field.value, "Butter #dairy for the cake");
  });
});

describe("tags with spaces in them", () => {
  const seeded = {
    "todo.urgent": [
      { uid: "q1", summary: 'Cake #"weekend baking" #veg', status: "needs_action" },
      { uid: "q2", summary: "Call #12 plumber", status: "needs_action" },
    ],
    "todo.normal": [], "todo.later": [],
  };
  const on = { default_collapsed: false, enable_tags: true };

  test("a quoted tag is one tag, not several", async () => {
    const { $$ } = fixture(on, structuredClone(seeded));
    await tick();
    const row = $$(".lane")[0].querySelectorAll(".items > [data-uid]")[0];
    assert.equal(row.querySelector(".summary").textContent, "Cake");
    assert.deepEqual([...row.querySelectorAll(".tag")].map((t) => t.textContent),
      ["weekend baking", "veg"]);
  });

  test("the chip shows the tag without its quotes", async () => {
    const { $$ } = fixture(on, structuredClone(seeded));
    await tick();
    assert.equal($$(".lane")[0].querySelector(".tag").textContent, "weekend baking");
  });

  test("a colour can be given to a tag with spaces", async () => {
    const { $$ } = fixture(
      { ...on, tags: { "weekend baking": "amber" } }, structuredClone(seeded));
    await tick();
    assert.equal($$(".lane")[0].querySelector(".tag").style.getPropertyValue("--tag-color"),
      "var(--amber-color)");
  });

  test("picking one from the editor writes it back quoted", async () => {
    const { $, $$, calls } = fixture(on, structuredClone(seeded));
    await tick();
    click($$(".lane")[0].querySelectorAll(".items > [data-uid] .label")[1]);   // the plumber item
    const chips = [...$(".editor").querySelectorAll(".tag-chip")];
    click(chips.find((c) => c.textContent === "weekend baking"));
    assert.equal($(".editor input[type=text]").value, 'Call #12 plumber #"weekend baking"');
  });

  test("and toggling it off again removes the whole quoted tag", async () => {
    const { $, $$ } = fixture(on, structuredClone(seeded));
    await tick();
    click($$(".lane")[0].querySelector(".items > [data-uid] .label"));
    const chip = [...$(".editor").querySelectorAll(".tag-chip")]
      .find((c) => c.textContent === "weekend baking");
    click(chip);
    assert.equal($(".editor input[type=text]").value, "Cake #veg");
  });

  test("completing works part-way through a quoted tag", async () => {
    const { $$ } = fixture(on, structuredClone(seeded));
    await tick();
    const add = $$(".lane")[0].querySelector(".add");
    const field = add.querySelector(".field");
    field.value = 'Flour #"week';
    field.setSelectionRange(field.value.length, field.value.length);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const suggest = add.querySelector(".tag-suggest");
    assert.deepEqual([...suggest.querySelectorAll(".tag-chip")].map((c) => c.textContent),
      ["weekend baking"]);
    click(suggest.querySelector(".tag-chip"));
    assert.equal(field.value, 'Flour #"weekend baking" ');
  });

  test("the # button writes a spaced tag quoted too", async () => {
    const { $$ } = fixture(on, structuredClone(seeded));
    await tick();
    const add = $$(".lane")[0].querySelector(".add");
    add.querySelector(".field").value = "Flour";
    click(add.querySelector(".tag-btn"));
    click([...add.querySelectorAll(".tag-chip")].find((c) => c.textContent === "weekend baking"));
    assert.equal(add.querySelector(".field").value, 'Flour #"weekend baking"');
  });
});

describe("editing an item updates it as you go", () => {
  const seeded = {
    "todo.urgent": [{ uid: "e1", summary: "Milk #dairy", status: "needs_action" }],
    "todo.normal": [{ uid: "e2", summary: "Peas #frozen", status: "needs_action" }],
    "todo.later": [],
  };
  const on = { default_collapsed: false, enable_tags: true };
  const shown = ($$) => {
    // While the editor is open the row is wrapped; once it closes it is the row itself.
    const block = $$(".lane")[0].querySelector(".items > [data-uid]");
    const row = block.classList.contains("item") ? block : block.querySelector(".item");
    return {
      text: row.querySelector(".summary").textContent,
      tags: [...row.querySelectorAll(".tag")].map((t) => t.textContent),
    };
  };

  test("toggling a tag chip shows on the item straight away", async () => {
    const { $, $$ } = fixture(on, structuredClone(seeded));
    await tick();
    click($$(".lane")[0].querySelector(".items > [data-uid] .label"));
    assert.deepEqual(shown($$), { text: "Milk", tags: ["dairy"] });
    const chip = [...$(".editor").querySelectorAll(".tag-chip")].find((c) => c.textContent === "frozen");
    click(chip);
    assert.deepEqual(shown($$), { text: "Milk", tags: ["dairy", "frozen"] },
      "the item should follow the editor without waiting for save");
  });

  test("and toggling it back off removes it again", async () => {
    const { $, $$ } = fixture(on, structuredClone(seeded));
    await tick();
    click($$(".lane")[0].querySelector(".items > [data-uid] .label"));
    const chip = [...$(".editor").querySelectorAll(".tag-chip")].find((c) => c.textContent === "dairy");
    click(chip);
    assert.deepEqual(shown($$), { text: "Milk", tags: [] });
  });

  test("typing a name shows on the item too", async () => {
    const { $, $$ } = fixture(on, structuredClone(seeded));
    await tick();
    click($$(".lane")[0].querySelector(".items > [data-uid] .label"));
    input($(".editor input[type=text]"), "Oat milk #dairy");
    assert.deepEqual(shown($$), { text: "Oat milk", tags: ["dairy"] });
  });

  test("cancelling puts the item back the way it was", async () => {
    const { $, $$ } = fixture(on, structuredClone(seeded));
    await tick();
    click($$(".lane")[0].querySelector(".items > [data-uid] .label"));
    input($(".editor input[type=text]"), "Something else entirely");
    const cancel = [...$(".editor").querySelectorAll(".actions .chip")].find((b) => b.textContent === "Cancel");
    click(cancel);
    assert.deepEqual(shown($$), { text: "Milk", tags: ["dairy"] });
  });

  test("the picker chips carry each tag's own colour, not the lane's", async () => {
    const { $, $$ } = fixture({ ...on, tags: { dairy: "blue", frozen: "cyan" } },
      structuredClone(seeded));
    await tick();
    click($$(".lane")[0].querySelector(".items > [data-uid] .label"));
    const chips = [...$(".editor").querySelectorAll(".tag-chip")];
    const byName = Object.fromEntries(chips.map((c) => [c.textContent, c]));
    assert.equal(byName.dairy.style.getPropertyValue("--tag-color"), "var(--blue-color)");
    assert.equal(byName.frozen.style.getPropertyValue("--tag-color"), "var(--cyan-color)");
    assert.ok(byName.dairy.classList.contains("on"), "dairy is on this item");
    assert.ok(!byName.frozen.classList.contains("on"));
  });
});

describe("automatic tag colours", () => {
  const many = {
    "todo.urgent": [{ uid: "m1", summary: "a #kek #lol #zzz #alpha", status: "needs_action" }],
    "todo.normal": [], "todo.later": [],
  };
  const colours = ($$) =>
    [...$$(".lane")[0].querySelectorAll(".tag")].map((c) => c.style.getPropertyValue("--tag-color"));

  test("no two tags share a colour while there are colours left", async () => {
    const { $$ } = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(many));
    await tick();
    const got = colours($$);
    assert.equal(got.length, 4);
    assert.equal(new Set(got).size, 4, `expected four distinct colours, got ${JSON.stringify(got)}`);
  });

  test("an automatic colour avoids one a configured tag has taken", async () => {
    const first = fixture({ default_collapsed: false, enable_tags: true }, structuredClone(many));
    await tick();
    const before = Object.fromEntries(
      [...first.$$(".lane")[0].querySelectorAll(".tag")]
        .map((c) => [c.textContent, c.style.getPropertyValue("--tag-color")]));
    document.body.innerHTML = "";

    const { $$ } = fixture(
      { default_collapsed: false, enable_tags: true, tags: { alpha: before.kek.replace(/var\(--|-color\)/g, "") } },
      structuredClone(many));
    await tick();
    const got = colours($$);
    assert.equal(new Set(got).size, 4, "a configured colour should push the automatic ones aside");
  });

  test("the same tag keeps its colour across renders", async () => {
    const { $$, subs, items } = fixture({ default_collapsed: false, enable_tags: true },
      structuredClone(many));
    await tick();
    const before = colours($$);
    subs.find(([, e]) => e === "todo.urgent")[0]({ items: items["todo.urgent"] });
    await tick();
    assert.deepEqual(colours($$), before);
  });
});
