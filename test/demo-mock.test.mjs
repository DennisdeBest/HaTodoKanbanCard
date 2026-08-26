import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDom, tick, click, input } from "./helpers.mjs";

setupDom();
const { createMockHass } = await import("../demo/mock-hass.js");
await import("../todo-kanban-card.js");

/*
 * The demo page is only as trustworthy as its stand-in for Home Assistant, so the
 * mock gets driven by the real card here — if these pass, what you see in the browser
 * is what the todo integration would actually do.
 */
function board() {
  const { hass, store } = createMockHass({
    "todo.a": [{ summary: "one" }, { summary: "two" }, { summary: "three" }],
    "todo.b": [{ summary: "other" }],
  });
  const card = document.createElement("todo-kanban-card");
  card.setConfig({
    default_collapsed: false,
    lanes: [{ entity: "todo.a", title: "A" }, { entity: "todo.b", title: "B" }],
  });
  card.hass = hass;
  document.body.appendChild(card);
  const $$ = (s) => [...card.shadowRoot.querySelectorAll(s)];
  return { card, store, $$, hass };
}

const summaries = (store, e) => store.get(e).map((i) => i.summary);

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("the demo's mock hass", () => {
  test("renders the seeded lists", async () => {
    const { $$ } = board();
    await tick();
    assert.equal($$(".lane")[0].querySelectorAll(".items > [data-uid]").length, 3);
  });

  test("adding through the card lands in the store", async () => {
    const { $$, store } = board();
    await tick();
    input($$(".lane")[0].querySelector(".add .field"), "four");
    click($$(".lane")[0].querySelector(".add .icon-btn"));
    await tick();
    assert.deepEqual(summaries(store, "todo.a"), ["one", "two", "three", "four"]);
    assert.equal($$(".lane")[0].querySelectorAll(".items > [data-uid]").length, 4);
  });

  test("completing an item moves it out of the outstanding count", async () => {
    const { $$, store, hass } = board();
    await tick();
    click($$(".lane")[0].querySelector(".check"));
    await tick();
    assert.equal(store.get("todo.a")[0].status, "completed");
    assert.equal(hass.states["todo.a"].state, "2");
    assert.equal($$(".lane")[0].querySelector(".count").textContent, "2");
  });

  test("a reorder respects previous_uid", async () => {
    const { card, store } = board();
    await tick();
    const third = store.get("todo.a")[2];
    await card._reorder("todo.a", third, null); // null = to the top
    assert.deepEqual(summaries(store, "todo.a"), ["three", "one", "two"]);
    await card._reorder("todo.a", third, store.get("todo.a")[2].uid); // after the last
    assert.deepEqual(summaries(store, "todo.a"), ["one", "two", "three"]);
  });

  test("a move across lanes carries the item and its due date", async () => {
    const { card, store } = board();
    await tick();
    const item = { ...store.get("todo.a")[1], due: "2026-09-09" };
    await card._moveBetween("todo.a", item, "todo.b", undefined);
    assert.deepEqual(summaries(store, "todo.a"), ["one", "three"]);
    assert.deepEqual(summaries(store, "todo.b"), ["other", "two"]);
    assert.equal(store.get("todo.b").at(-1).due, "2026-09-09");
  });

  test("a move to a position lands there, not at the bottom", async () => {
    const { card, store } = board();
    await tick();
    const item = store.get("todo.a")[0];
    await card._moveBetween("todo.a", item, "todo.b", null); // null = top of the target
    assert.deepEqual(summaries(store, "todo.b"), ["one", "other"]);
  });

  test("clearing done items empties only the completed ones", async () => {
    const { card, store } = board();
    await tick();
    await card._toggle("todo.a", store.get("todo.a")[0]);
    await card._call("remove_completed_items", { entity_id: "todo.a" });
    assert.deepEqual(summaries(store, "todo.a"), ["two", "three"]);
  });
});
