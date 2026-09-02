import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { autoTagColors, tagColor, computeCssColor, TAG_PALETTE } from "../src/colors.js";

/*
 * These are pure functions, so they are tested directly rather than through a card.
 * The behaviour that matters: distinct colours while there are colours left, a sensible
 * one after that, and the same answer every time so a tag does not change colour when
 * you reload.
 */
describe("automatic tag colours", () => {
  test("gives every tag a colour from the palette", () => {
    const tags = Array.from({ length: 30 }, (_, i) => `tag${i}`);
    const auto = autoTagColors(tags, {});
    assert.equal(Object.keys(auto).length, tags.length);
    for (const [tag, colour] of Object.entries(auto)) {
      assert.ok(TAG_PALETTE.includes(colour), `${tag} got ${colour}, which is not in the palette`);
    }
  });

  test("keeps them distinct while there are colours to go round", () => {
    const tags = Array.from({ length: TAG_PALETTE.length }, (_, i) => `tag${i}`);
    const values = Object.values(autoTagColors(tags, {}));
    assert.equal(new Set(values).size, TAG_PALETTE.length);
  });

  test("carries on once the palette runs out, rather than failing", () => {
    const tags = Array.from({ length: TAG_PALETTE.length * 3 }, (_, i) => `tag${i}`);
    const auto = autoTagColors(tags, {});
    const values = Object.values(auto);
    assert.equal(values.length, tags.length, "every tag still gets one");
    assert.ok(values.every((v) => TAG_PALETTE.includes(v)));
    assert.equal(new Set(values).size, TAG_PALETTE.length, "and it reuses the palette");
  });

  test("still copes when configured tags have taken every colour", () => {
    const configured = Object.fromEntries(TAG_PALETTE.map((c, i) => [`cfg${i}`, c]));
    const auto = autoTagColors(["alpha", "beta", "gamma"], configured);
    assert.deepEqual(Object.keys(auto), ["alpha", "beta", "gamma"]);
    assert.ok(Object.values(auto).every((v) => TAG_PALETTE.includes(v)));
  });

  test("leaves a configured tag alone", () => {
    const auto = autoTagColors(["alpha", "beta"], { alpha: "red" });
    assert.ok(!("alpha" in auto));
    assert.ok(auto.beta);
  });

  test("avoids a colour a configured tag is already using", () => {
    const [first] = Object.values(autoTagColors(["solo"], {}));
    const avoided = autoTagColors(["solo"], { other: first });
    assert.notEqual(avoided.solo, first);
  });

  test("gives the same answer every time", () => {
    const tags = ["dairy", "veg", "frozen", "kek", "lol"];
    assert.deepEqual(autoTagColors(tags, {}), autoTagColors([...tags].reverse(), {}));
  });

  test("tagColor falls back sensibly with no context at all", () => {
    assert.match(tagColor("anything"), /^var\(--[a-z-]+-color\)$/);
    assert.match(tagColor("anything", {}, []), /^var\(--[a-z-]+-color\)$/);
    assert.equal(tagColor("anything", { anything: "#123456" }), "#123456");
  });

  test("handles nothing at all without throwing", () => {
    assert.deepEqual(autoTagColors(undefined, undefined), {});
    assert.deepEqual(autoTagColors([], null), {});
  });
});

describe("palette names", () => {
  test("a known name becomes a theme variable", () => {
    assert.equal(computeCssColor("red"), "var(--red-color)");
    assert.equal(computeCssColor("blue-grey"), "var(--blue-grey-color)");
  });

  test("anything else is handed to CSS untouched", () => {
    assert.equal(computeCssColor("#9c27b0"), "#9c27b0");
    assert.equal(computeCssColor("var(--error-color)"), "var(--error-color)");
    assert.equal(computeCssColor(""), "");
    assert.equal(computeCssColor(undefined), undefined);
  });
});
