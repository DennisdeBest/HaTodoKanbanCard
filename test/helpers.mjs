import { JSDOM } from "jsdom";

/*
 * jsdom gives us a DOM with no layout: `getBoundingClientRect` is all zeros and
 * `elementFromPoint` does not exist. Everything that does not depend on geometry is
 * testable here — rendering, collapsing, the service calls each control fires, the
 * drop arithmetic. Pointer dragging itself needs the demo page in a real browser.
 */
export function setupDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const k of ["window", "document", "HTMLElement", "customElements", "CustomEvent",
                   "Event", "Node", "localStorage", "requestAnimationFrame"]) {
    globalThis[k] = k === "window" ? dom.window : dom.window[k];
  }
  return dom;
}

export function makeHass(items, calls) {
  const subs = [];
  return {
    subs,
    hass: {
      states: Object.fromEntries(
        Object.keys(items).map((e) => [
          e,
          {
            state: String(items[e].filter((i) => i.status !== "completed").length),
            attributes: { friendly_name: e },
          },
        ])
      ),
      connection: {
        subscribeMessage: (cb, msg) => {
          subs.push([cb, msg.entity_id]);
          setTimeout(() => cb({ items: items[msg.entity_id] || [] }), 0);
          return Promise.resolve(() => {});
        },
      },
      callWS: (msg) => {
        calls.push(["ws", msg]);
        return Promise.resolve({ items: items[msg.entity_id] || [] });
      },
      callService: (domain, service, data) => {
        calls.push([`${domain}.${service}`, data]);
        return Promise.resolve();
      },
    },
  };
}

export const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

export function click(node) {
  node.dispatchEvent(new globalThis.window.Event("click", { bubbles: true }));
}

export function input(node, value) {
  node.value = value;
  node.dispatchEvent(new globalThis.window.Event("input", { bubbles: true }));
}
