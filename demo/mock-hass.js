/*
 * A `hass` good enough to drive the card, with no Home Assistant anywhere.
 *
 * It implements the three entry points the card uses — `connection.subscribeMessage`,
 * `callWS` and `callService` — over an in-memory store, with the same semantics the
 * real `todo` integration has: add appends, move takes a `previous_uid`, and every
 * mutation pushes the whole list back to every subscriber.
 */
let seq = 0;
const uid = () => `demo-${++seq}`;

export function createMockHass(lists) {
  const store = new Map();
  for (const [entity, items] of Object.entries(lists)) {
    store.set(
      entity,
      items.map((i) => ({
        uid: uid(),
        summary: i.summary,
        status: i.status || "needs_action",
        due: i.due || null,
        description: i.description || null,
      }))
    );
  }

  const subscribers = new Map(); // entity -> Set<cb>
  const log = [];

  const push = (entity) => {
    for (const cb of subscribers.get(entity) || []) cb({ items: [...store.get(entity)] });
    render();
  };

  const find = (entity, ref) => {
    const items = store.get(entity) || [];
    return items.find((i) => i.uid === ref) || items.find((i) => i.summary === ref);
  };

  const hass = {
    themes: {},
    states: {},
    connection: {
      subscribeMessage(cb, msg) {
        if (!subscribers.has(msg.entity_id)) subscribers.set(msg.entity_id, new Set());
        subscribers.get(msg.entity_id).add(cb);
        setTimeout(() => cb({ items: [...(store.get(msg.entity_id) || [])] }), 0);
        return Promise.resolve(() => subscribers.get(msg.entity_id).delete(cb));
      },
    },
    async callWS(msg) {
      log.push(["ws", msg.type, msg]);
      if (msg.type === "todo/item/list") return { items: [...(store.get(msg.entity_id) || [])] };
      if (msg.type === "todo/item/move") {
        const items = store.get(msg.entity_id);
        const item = find(msg.entity_id, msg.uid);
        items.splice(items.indexOf(item), 1);
        const at = msg.previous_uid ? items.findIndex((i) => i.uid === msg.previous_uid) + 1 : 0;
        items.splice(at, 0, item);
        push(msg.entity_id);
        return null;
      }
      throw new Error(`mock hass: no handler for ${msg.type}`);
    },
    async callService(domain, service, data) {
      log.push(["service", `${domain}.${service}`, data]);
      const entity = data.entity_id;
      const items = store.get(entity);
      if (!items) throw new Error(`mock hass: unknown entity ${entity}`);
      if (service === "add_item") {
        items.push({
          uid: uid(),
          summary: data.item,
          status: "needs_action",
          due: data.due_date || null,
          description: data.description || null,
        });
      } else if (service === "update_item") {
        const item = find(entity, data.item);
        if (data.rename !== undefined) item.summary = data.rename;
        if (data.status !== undefined) item.status = data.status;
        if (data.due_date !== undefined) item.due = data.due_date;
        if (data.description !== undefined) item.description = data.description || null;
      } else if (service === "remove_item") {
        items.splice(items.indexOf(find(entity, data.item)), 1);
      } else if (service === "remove_completed_items") {
        store.set(entity, items.filter((i) => i.status !== "completed"));
      } else {
        throw new Error(`mock hass: no handler for todo.${service}`);
      }
      push(entity);
      return null;
    },
  };

  // Entity states, kept in step so lane titles and any badge read correctly.
  function render() {
    for (const [entity, items] of store) {
      hass.states[entity] = {
        entity_id: entity,
        state: String(items.filter((i) => i.status !== "completed").length),
        attributes: {
          friendly_name: entity.replace("todo.", "").replace(/_/g, " "),
          supported_features: 127,
        },
      };
    }
  }
  render();

  return { hass, store, log };
}
