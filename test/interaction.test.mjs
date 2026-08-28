import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupDom, makeHass, tick, click, input } from "./helpers.mjs";

const dom = setupDom();
await import("../todo-kanban-card.js");

/*
 * The behaviours that only matter when a person is actually using the thing: keeping
 * the add field usable for a run of items, and following the pointer to a lane that is
 * off the bottom of a phone screen.
 */
function board(overrides = {}) {
  const items = {
    "todo.a": [
      { uid: "a1", summary: "one", status: "needs_action" },
      { uid: "a2", summary: "two", status: "needs_action" },
    ],
    "todo.b": [{ uid: "b1", summary: "other", status: "needs_action" }],
  };
  const calls = [];
  const { hass, subs } = makeHass(items, calls);
  const card = document.createElement("todo-kanban-card");
  card.setConfig({ lanes: [{ entity: "todo.a" }, { entity: "todo.b" }], ...overrides });
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

// `pretendToBeVisual` runs jsdom's own animation-frame loop, which keeps the process
// alive once anything here has asked for a frame.
after(() => dom.window.close());

describe("adding several items in a row", () => {
  test("the lane elements survive a push instead of being rebuilt", async () => {
    const { card, $$, subs, items } = board();
    await tick();
    const before = $$(".lane");
    const addBefore = $$(".add .field");
    subs.find(([, e]) => e === "todo.a")[0]({
      items: [...items["todo.a"], { uid: "a3", summary: "three", status: "needs_action" }],
    });
    await tick();
    const after = $$(".lane");
    assert.equal(after[0], before[0], "lane element was replaced");
    assert.equal($$(".add .field")[0], addBefore[0], "add input was replaced");
    assert.equal(after[0].querySelectorAll(".items > [data-uid]").length, 3, "items did not update");
  });

  test("the input keeps focus and empties after an add", async () => {
    const { $$, calls } = board();
    await tick();
    const field = $$(".lane")[0].querySelector(".add .field");
    field.focus();
    input(field, "milk");
    click($$(".lane")[0].querySelector(".add .icon-btn"));
    await tick();
    assert.equal(calls.at(-1)[0], "todo.add_item");
    assert.equal(field.value, "", "field was not cleared");
    assert.equal($$(".lane")[0].querySelector(".add .field"), field);
  });

  test("enter submits, and a second item can follow straight away", async () => {
    const { $$, calls } = board();
    await tick();
    const field = $$(".lane")[0].querySelector(".add .field");
    const enter = () => field.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })
    );
    input(field, "bread");
    enter();
    await tick();
    input(field, "cheese");
    enter();
    await tick();
    const added = calls.filter((c) => c[0] === "todo.add_item").map((c) => c[1].item);
    assert.deepEqual(added, ["bread", "cheese"]);
  });

  test("the add button does not steal focus from the field", async () => {
    const { $$ } = board();
    await tick();
    const button = $$(".lane")[0].querySelector(".add .icon-btn");
    const ev = new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(ev);
    assert.ok(ev.defaultPrevented, "mousedown default was not prevented");
  });

  test("a folded lane keeps its add row in the DOM, ready for reopening", async () => {
    const { $$ } = board();
    await tick();
    const field = $$(".lane")[0].querySelector(".add .field");
    click($$(".lane")[0].querySelector(".lane-head"));   // fold
    click($$(".lane")[0].querySelector(".lane-head"));   // and back
    assert.equal($$(".lane")[0].querySelector(".add .field"), field);
  });
});

describe("dragging towards the edge of the screen", () => {
  function startDrag(card, y) {
    card._drag = {
      from: "todo.a",
      item: { uid: "a1", summary: "one" },
      row: document.createElement("div"),
      ghost: document.createElement("div"),
      placeholder: document.createElement("div"),
      target: null,
      point: { x: 100, y },
      scrollers: [],
      pointerId: 1,
      capture: null,
    };
  }

  // jsdom has no layout, so a scroller is stubbed: what is under test is the decision
  // to scroll and its direction, not the browser's own scrolling.
  function scroller(top = 500) {
    return { scrollTop: top, scrollHeight: 5000, clientHeight: 800 };
  }

  test("parks near the bottom edge and scrolls down", () => {
    const { card } = board();
    startDrag(card, (dom.window.innerHeight || 768) - 10);
    const s = scroller();
    card._drag.scrollers = [s];
    card._autoScroll();
    assert.ok(s.scrollTop > 500, `expected a downward scroll, got ${s.scrollTop}`);
  });

  test("parks near the top edge and scrolls up", () => {
    const { card } = board();
    startDrag(card, 5);
    const s = scroller();
    card._drag.scrollers = [s];
    card._autoScroll();
    assert.ok(s.scrollTop < 500, `expected an upward scroll, got ${s.scrollTop}`);
  });

  test("leaves the page alone in the middle of the screen", () => {
    const { card } = board();
    startDrag(card, (dom.window.innerHeight || 768) / 2);
    const s = scroller();
    card._drag.scrollers = [s];
    card._autoScroll();
    assert.equal(s.scrollTop, 500);
  });

  test("scrolls faster the closer to the edge the pointer is", () => {
    const { card } = board();
    const h = dom.window.innerHeight || 768;
    const travel = (y) => {
      startDrag(card, y);
      const s = scroller();
      card._drag.scrollers = [s];
      card._autoScroll();
      return s.scrollTop - 500;
    };
    assert.ok(travel(h - 2) > travel(h - 70), "edge should be faster than the threshold");
  });

  test("stops once the drag ends", () => {
    const { card } = board();
    startDrag(card, (dom.window.innerHeight || 768) - 10);
    card._drag.scrollers = [scroller()];
    card._autoScroll();
    assert.notEqual(card._scrollRaf, null, "the loop should have queued another frame");
    card._drag = null;
    card._autoScroll();
    assert.equal(card._scrollRaf, null, "the loop should stop when the drag is over");
  });
});
