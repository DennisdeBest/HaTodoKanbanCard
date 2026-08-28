/*
 * todo-kanban-card — a kanban board over Home Assistant `todo` entities.
 * https://github.com/DennisdeBest/HaTodoKanbanCard
 *
 * Home Assistant can show you a todo list. It cannot move an item from one list to
 * another: the core todo-list card has no such control, and there is no service for it
 * either. This card adds that, and arranges any number of lists as lanes you can drag
 * between — shopping split by urgency, chores by room, a project backlog as
 * Backlog / Doing / Done, a meal plan by day.
 *
 * A move is add-on-the-target followed by remove-from-the-source, run in that order so
 * a failure between the two duplicates an item rather than losing it.
 *
 * Items arrive over `todo/item/subscribe`, one subscription per lane, so the board
 * follows changes made anywhere — this card, the companion app, another tablet, an
 * automation.
 *
 * No build step, no dependencies: plain custom element, shadow DOM, hand-built DOM.
 *
 * MIT licensed. See README.md for the full config reference and more examples.
 */

const VERSION = "1.1.0";
const STORE = "todo-kanban.collapsed.";

const DEFAULT_ICON = "mdi:format-list-checks";

const DEFAULTS = {
  title: undefined,
  // "auto" opens a lane that has something in it and shuts one that does not; true and
  // false pin it. Whatever the default, a click on the header wins until the lane next
  // crosses empty (and under true/false, until the browser forgets).
  default_collapsed: "auto",
  hide_completed: false,
  hide_add: false,
  min_lane_width: 270,
};

function el(tag, props, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "style") {
      // Object.assign onto a CSSStyleDeclaration silently drops custom properties,
      // which is how --lane-accent and --lane-min quietly did nothing.
      for (const [prop, value] of Object.entries(v)) {
        if (prop.startsWith("--")) node.style.setProperty(prop, value);
        else node.style[prop] = value;
      }
    }
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(children || [])) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function icon(name, cls) {
  return el("ha-icon", { icon: name, class: cls || "" });
}

// "2026-08-30" -> "Sat 30 Aug", and a plain marker for today / tomorrow / overdue.
function dueLabel(due) {
  if (!due) return null;
  const day = String(due).slice(0, 10);
  const d = new Date(day + "T00:00:00");
  if (isNaN(d)) return { text: String(due), state: "" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  const text =
    days === 0 ? "today" :
    days === 1 ? "tomorrow" :
    days === -1 ? "yesterday" :
    d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return { text, state: days < 0 ? "overdue" : days <= 1 ? "soon" : "" };
}

class TodoKanbanCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._items = {};        // entity -> items[]
    this._subs = [];         // Promise<UnsubscribeFunc>[]
    this._drafts = {};       // entity -> text in its "add item" box
    this._wasEmpty = {};     // entity -> emptiness at the last render
    this._editing = null;    // uid of the item whose editor is open
    this._showDone = {};     // entity -> completed section expanded
    this._drag = null;
    this._error = null;
    this._focus = null;      // [key, selectionStart] to restore after a re-render
    this._lanes = new Map(); // entity -> the lane <section>, reused across renders
    this._shell = null;
    this._shellKey = null;
    this._scrollRaf = null;
    this._onDragMove = this._onDragMove.bind(this);
    this._onDragEnd = this._onDragEnd.bind(this);
    this._autoScroll = this._autoScroll.bind(this);
  }

  static getStubConfig() {
    return { lanes: [{ entity: "todo.shopping" }] };
  }

  setConfig(config) {
    const lanes = (config && config.lanes) || [];
    if (!lanes.length) throw new Error("todo-kanban-card: `lanes` needs at least one entry");
    lanes.forEach((lane, i) => {
      if (!lane || !lane.entity) throw new Error(`todo-kanban-card: lane ${i + 1} has no \`entity\``);
      if (!lane.entity.startsWith("todo.")) {
        throw new Error(`todo-kanban-card: ${lane.entity} is not a todo entity`);
      }
    });
    const collapse = config.default_collapsed;
    if (collapse !== undefined && !["auto", true, false].includes(collapse)) {
      throw new Error("todo-kanban-card: `default_collapsed` must be auto, true or false");
    }
    this._config = { ...DEFAULTS, ...config, lanes };
    this._render();
  }

  // Lane settings fall back to the card-wide setting, which falls back to DEFAULTS.
  _opt(lane, key) {
    return lane[key] !== undefined ? lane[key] : this._config[key];
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) {
      this._subscribe();
      this._render();
    }
  }

  connectedCallback() {
    if (this._hass && !this._subs.length) this._subscribe();
  }

  disconnectedCallback() {
    this._unsubscribe();
    this._endDragListeners();
  }

  getCardSize() {
    return 2 + 3 * ((this._config && this._config.lanes.length) || 1);
  }

  // ---------------------------------------------------------------- live data

  _subscribe() {
    if (!this._hass || !this._config) return;
    this._unsubscribe();
    for (const lane of this._config.lanes) {
      const p = this._hass.connection.subscribeMessage(
        (msg) => this._externalUpdate(lane.entity, (msg && msg.items) || []),
        { type: "todo/item/subscribe", entity_id: lane.entity }
      );
      p.catch((err) => this._fail(`${lane.entity}: ${err.message || err}`));
      this._subs.push(p);
    }
  }

  // A push from elsewhere (the phone app, the other tablet, this card's own service
  // calls) must not redraw the board while something is being dragged or edited — the
  // half-typed name would vanish. Hold it and redraw when the interaction finishes.
  _externalUpdate(entity, items) {
    this._items[entity] = items;
    if (this._drag || this._editing) {
      this._pending = true;
      return;
    }
    this._render();
  }

  _unsubscribe() {
    for (const p of this._subs) p.then((unsub) => unsub && unsub()).catch(() => {});
    this._subs = [];
  }

  async _refresh(entity) {
    try {
      const res = await this._hass.callWS({ type: "todo/item/list", entity_id: entity });
      this._items[entity] = (res && res.items) || [];
      return this._items[entity];
    } catch (err) {
      this._fail(err.message || String(err));
      return this._items[entity] || [];
    }
  }

  _fail(message) {
    this._error = message;
    this._render();
    clearTimeout(this._errorTimer);
    this._errorTimer = setTimeout(() => {
      this._error = null;
      this._render();
    }, 8000);
  }

  // ------------------------------------------------------------- item actions

  _call(service, data) {
    return this._hass.callService("todo", service, data).catch((err) => {
      this._fail(`${service}: ${(err && (err.message || err.error)) || err}`);
      throw err;
    });
  }

  _add(entity, summary) {
    const item = summary.trim();
    if (!item) return Promise.resolve();
    return this._call("add_item", { entity_id: entity, item });
  }

  _toggle(entity, item) {
    return this._call("update_item", {
      entity_id: entity,
      item: item.uid,
      status: item.status === "completed" ? "needs_action" : "completed",
    });
  }

  _remove(entity, item) {
    return this._call("remove_item", { entity_id: entity, item: item.uid });
  }

  async _save(entity, item, fields) {
    const data = { entity_id: entity, item: item.uid };
    if (fields.summary && fields.summary !== item.summary) data.rename = fields.summary;
    // Leaving a field out means "unchanged", so clearing one has to be explicit.
    // `due_date: null` clears it; `due_date: ""` is a 400 (probed on 2026.8.1), and
    // sending due_date and due_datetime together is a 400 as well.
    if ((fields.due || "") !== (item.due ? String(item.due).slice(0, 10) : "")) {
      data.due_date = fields.due || null;
    }
    if ((fields.description || "") !== (item.description || "")) {
      data.description = fields.description || "";
    }
    if (Object.keys(data).length === 2) return;
    await this._call("update_item", data);
  }

  /*
   * Move between lanes. HA has no such service, so: create on the target, delete from
   * the source. Add first — if the remove then fails the item exists twice, which is
   * annoying but recoverable, where the other order loses it outright.
   *
   * add_item appends, so landing it at a chosen position needs the new uid. Diffing
   * the target's uids before and after is exact (matching on the summary is not — two
   * "Milk"s are perfectly legal). If that lookup fails the item simply stays at the
   * bottom of the lane, which is a cosmetic loss, not a data one.
   */
  async _moveBetween(fromEntity, item, toEntity, beforeUid) {
    const before = new Set(((await this._refresh(toEntity)) || []).map((i) => i.uid));
    await this._call("add_item", {
      entity_id: toEntity,
      item: item.summary,
      ...(item.due ? { due_date: String(item.due).slice(0, 10) } : {}),
      ...(item.description ? { description: item.description } : {}),
    });
    await this._remove(fromEntity, item);

    if (beforeUid === undefined) return;
    for (let attempt = 0; attempt < 10; attempt++) {
      const items = await this._refresh(toEntity);
      const fresh = items.find((i) => !before.has(i.uid) && i.summary === item.summary);
      if (fresh) {
        try {
          await this._hass.callWS({
            type: "todo/item/move",
            entity_id: toEntity,
            uid: fresh.uid,
            ...(beforeUid ? { previous_uid: beforeUid } : {}),
          });
        } catch (err) {
          /* position is cosmetic — the item is already on the right list */
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async _reorder(entity, item, beforeUid) {
    try {
      await this._hass.callWS({
        type: "todo/item/move",
        entity_id: entity,
        uid: item.uid,
        ...(beforeUid ? { previous_uid: beforeUid } : {}),
      });
    } catch (err) {
      this._fail(`move: ${err.message || err}`);
    }
  }

  // ------------------------------------------------------------------ collapse

  _collapsed(lane, outstanding) {
    const entity = lane.entity;
    const mode = this._opt(lane, "default_collapsed");
    const empty = outstanding === 0;
    // Under "auto", crossing empty in either direction drops the manual override, so
    // the lane goes back to its default: open when it holds something, shut when it
    // does not. A pinned lane keeps whatever the user last chose.
    if (mode === "auto" && this._wasEmpty[entity] !== undefined && this._wasEmpty[entity] !== empty) {
      this._store(entity, null);
    }
    this._wasEmpty[entity] = empty;
    const stored = this._read(entity);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return mode === "auto" ? empty : !!mode;
  }

  _read(entity) {
    try {
      return localStorage.getItem(STORE + entity);
    } catch (err) {
      return null;
    }
  }

  _store(entity, value) {
    try {
      if (value === null) localStorage.removeItem(STORE + entity);
      else localStorage.setItem(STORE + entity, value);
    } catch (err) {
      /* private window, or site data blocked — collapse just stops persisting */
    }
  }

  // -------------------------------------------------------------------- drag

  _grip(laneEntity, item) {
    const handle = el("div", {
      class: "grip",
      title: "Drag to another list",
      onpointerdown: (ev) => this._onGripDown(ev, laneEntity, item),
    }, [icon("mdi:drag-horizontal-variant")]);
    return handle;
  }

  _onGripDown(ev, laneEntity, item) {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const row = ev.target.closest(".item");
    if (!row) return;
    // An item with its editor open is wrapped in a div; the wrapper is what sits in the
    // list, so that is what gets dragged and what the placeholder replaces.
    const block = row.parentNode.classList.contains("item-wrap") ? row.parentNode : row;
    const rect = row.getBoundingClientRect();

    const ghost = row.cloneNode(true);
    ghost.classList.add("ghost");
    ghost.style.width = `${rect.width}px`;
    this.shadowRoot.appendChild(ghost);

    this._drag = {
      from: laneEntity,
      item,
      row: block,
      ghost,
      dx: ev.clientX - rect.left,
      dy: ev.clientY - rect.top,
      placeholder: el("div", { class: "placeholder" }),
      target: null,
      point: { x: ev.clientX, y: ev.clientY },
      scrollers: this._scrollParents(),
      pointerId: ev.pointerId,
      capture: null,
    };
    // Capturing the pointer keeps touch drags alive: without it the browser is free to
    // decide mid-gesture that this was really a scroll and fire pointercancel.
    if (ev.pointerId !== undefined && ev.target.setPointerCapture) {
      try {
        ev.target.setPointerCapture(ev.pointerId);
        this._drag.capture = ev.target;
      } catch (err) { /* not supported here */ }
    }
    block.classList.add("dragging");
    block.parentNode.insertBefore(this._drag.placeholder, block);
    this._positionGhost(ev.clientX, ev.clientY);
    document.addEventListener("pointermove", this._onDragMove, { passive: false });
    document.addEventListener("pointerup", this._onDragEnd);
    document.addEventListener("pointercancel", this._onDragEnd);
    this._scrollRaf = requestAnimationFrame(this._autoScroll);
  }

  /*
   * Every scrollable ancestor, innermost first — crossing shadow boundaries, since the
   * card sits several shadow roots deep inside a Home Assistant dashboard and the thing
   * that actually scrolls is one of them, not the window.
   */
  _scrollParents() {
    const out = [];
    let node = this;
    let guard = 0;
    while (node && guard++ < 100) {
      if (node.nodeType === 1 && node !== this) {
        let style = null;
        try { style = getComputedStyle(node); } catch (err) { /* detached */ }
        if (style && /(auto|scroll|overlay)/.test(style.overflowY)
            && node.scrollHeight > node.clientHeight + 1) {
          out.push(node);
        }
      }
      const root = node.getRootNode && node.getRootNode();
      node = node.parentElement || (root && root.host) || null;
    }
    const doc = document.scrollingElement || document.documentElement;
    if (doc && doc.scrollHeight > doc.clientHeight + 1) out.push(doc);
    return out;
  }

  /*
   * Hold the item near the top or bottom of the screen and the page follows. Without
   * this a phone cannot move an item into a lane that is off the bottom of the
   * viewport: the grip sets `touch-action: none` so the browser will not scroll for us,
   * and a finger held still fires no further pointermove events — hence the rAF loop,
   * which re-runs the drop calculation itself rather than waiting to be told.
   */
  _autoScroll() {
    this._scrollRaf = null;
    if (!this._drag) return;
    const { x, y } = this._drag.point;
    const height = window.innerHeight || document.documentElement.clientHeight || 0;
    const EDGE = 90;   // px from the edge where scrolling starts
    const SPEED = 24;  // px per frame at the very edge

    let dy = 0;
    if (y < EDGE) dy = -SPEED * Math.min(1, (EDGE - y) / EDGE);
    else if (y > height - EDGE) dy = SPEED * Math.min(1, (y - (height - EDGE)) / EDGE);

    if (dy) {
      for (const node of this._drag.scrollers) {
        const before = node.scrollTop;
        node.scrollTop = before + dy;
        if (node.scrollTop !== before) break; // whichever one actually moved wins
      }
      this._updateDrop(x, y);
    }
    this._scrollRaf = requestAnimationFrame(this._autoScroll);
  }

  _positionGhost(x, y) {
    const g = this._drag.ghost;
    g.style.left = `${x - this._drag.dx}px`;
    g.style.top = `${y - this._drag.dy}px`;
  }

  _onDragMove(ev) {
    if (!this._drag) return;
    ev.preventDefault();
    this._drag.point = { x: ev.clientX, y: ev.clientY };
    this._positionGhost(ev.clientX, ev.clientY);
    this._updateDrop(ev.clientX, ev.clientY);
  }

  // Where would the item land if it were dropped at (x, y)? Moves the placeholder and
  // records the answer on `_drag.target`. Called on pointer move and, while the pointer
  // is parked at a screen edge, on every autoscroll frame.
  _updateDrop(x, y) {
    // `DocumentOrShadowRoot.elementFromPoint` is missing in some environments (jsdom
    // among them); without it there is nothing to hit-test against, so the drag simply
    // keeps the target it already had rather than throwing halfway through.
    const root = this.shadowRoot;
    const under = root.elementFromPoint ? root.elementFromPoint(x, y) : null;
    const laneEl = under && under.closest && under.closest("[data-lane]");
    if (!laneEl) return;
    const entity = laneEl.getAttribute("data-lane");

    // A folded lane shows only its header. Dropping on it appends to the end.
    if (laneEl.classList.contains("collapsed") || laneEl.classList.contains("gone")) {
      this._drag.target = { entity, beforeUid: null, append: true };
      if (this._drag.placeholder.parentNode) this._drag.placeholder.remove();
      laneEl.classList.add("drop-target");
      this._clearDropTargets(laneEl);
      return;
    }
    this._clearDropTargets(null);
    const list = laneEl.querySelector(".items");
    if (!list) return;

    // Direct children only. An item with its editor open is wrapped in a div, and
    // insertBefore against a grandchild throws.
    const rows = [...list.children].filter(
      (n) => n.hasAttribute("data-uid") && !n.classList.contains("dragging")
    );
    let beforeRow = null;
    for (const r of rows) {
      const box = r.getBoundingClientRect();
      if (y < box.top + box.height / 2) {
        beforeRow = r;
        break;
      }
    }
    if (beforeRow) list.insertBefore(this._drag.placeholder, beforeRow);
    else list.appendChild(this._drag.placeholder);

    // previous_uid is the row the item lands *after*, which is the one before the
    // placeholder — null meaning "top of the list".
    let prev = this._drag.placeholder.previousElementSibling;
    while (prev && !prev.hasAttribute("data-uid")) prev = prev.previousElementSibling;
    this._drag.target = {
      entity,
      beforeUid: prev ? prev.getAttribute("data-uid") : null,
      append: false,
    };
  }

  _clearDropTargets(except) {
    this.shadowRoot.querySelectorAll(".lane.drop-target").forEach((l) => {
      if (l !== except) l.classList.remove("drop-target");
    });
  }

  async _onDragEnd() {
    const drag = this._drag;
    if (!drag) return;
    this._endDragListeners();
    drag.ghost.remove();
    if (drag.placeholder.parentNode) drag.placeholder.remove();
    drag.row.classList.remove("dragging");
    this._clearDropTargets(null);
    this._drag = null;

    const target = drag.target;
    if (target) {
      if (target.entity === drag.from) {
        const current = (this._items[drag.from] || []).map((i) => i.uid);
        const at = current.indexOf(drag.item.uid);
        // Dropping on a collapsed lane header means "append", which for the item's own
        // lane is "after the last item" — not the null that _reorder reads as "top".
        const last = current.filter((uid) => uid !== drag.item.uid).slice(-1)[0] || null;
        const beforeUid = target.append ? last : target.beforeUid;
        const landsAfter = beforeUid ? current.indexOf(beforeUid) : -1;
        if (landsAfter !== at - 1) await this._reorder(drag.from, drag.item, beforeUid);
      } else {
        await this._moveBetween(
          drag.from,
          drag.item,
          target.entity,
          target.append ? undefined : target.beforeUid
        );
      }
    }
    this._render();
  }

  _endDragListeners() {
    document.removeEventListener("pointermove", this._onDragMove);
    document.removeEventListener("pointerup", this._onDragEnd);
    document.removeEventListener("pointercancel", this._onDragEnd);
    if (this._scrollRaf !== null) {
      cancelAnimationFrame(this._scrollRaf);
      this._scrollRaf = null;
    }
    const drag = this._drag;
    if (drag && drag.capture && drag.pointerId !== undefined) {
      try { drag.capture.releasePointerCapture(drag.pointerId); } catch (err) { /* gone */ }
    }
  }

  // ------------------------------------------------------------------ render

  /*
   * The board is built once and then updated in place. It used to be torn down and
   * rebuilt on every push, which destroyed the "add an item" input along with
   * everything else — so the field lost focus after each add, and on a phone the
   * keyboard closed between every item. Keeping the lane elements alive means the
   * input is never recreated, and adding five things in a row is five keystrokes and
   * five taps of enter rather than a re-focus in between.
   */
  _render() {
    if (!this._config) return;
    if (this._drag) return; // never redraw the board out from under a drag
    this._pending = false;

    const root = this.shadowRoot;
    const key = this._config.lanes.map((l) => l.entity).join("|");

    if (this._shellKey !== key) {
      // `:scope > *` does not match against a ShadowRoot — the old board would pile up
      // underneath the new one. Caught in a jsdom harness before this ever shipped.
      while (root.firstChild) root.firstChild.remove();
      root.appendChild(el("style", { text: STYLE }));

      const title = el("h1", { class: "card-title" });
      const error = el("div", { class: "error" });
      const board = el("div", { class: "board" });
      const card = el("ha-card", {}, [title, error, board]);
      root.appendChild(card);

      this._lanes = new Map();
      for (const lane of this._config.lanes) {
        const node = this._buildLane(lane);
        this._lanes.set(lane.entity, node);
        board.appendChild(node);
      }
      this._shell = { title, error, board };
      this._shellKey = key;
    }

    const { title, error, board } = this._shell;
    title.textContent = this._config.title || "";
    title.hidden = !this._config.title;
    error.replaceChildren(
      ...(this._error ? [icon("mdi:alert-circle-outline"), document.createTextNode(this._error)] : [])
    );
    error.hidden = !this._error;
    board.style.setProperty("--lane-min", `${parseInt(this._config.min_lane_width, 10) || 270}px`);

    for (const lane of this._config.lanes) this._syncLane(this._lanes.get(lane.entity), lane);

    // Only a safety net now that the add row survives a render: the item editor still
    // gets rebuilt, so a caret in one of its fields is restored here.
    if (this._focus) {
      const [fkey, caret] = this._focus;
      const target = root.querySelector(`[data-focus="${fkey}"]`);
      if (target) {
        target.focus();
        if (caret !== null && caret !== undefined && target.setSelectionRange) {
          try { target.setSelectionRange(caret, caret); } catch (err) { /* number inputs */ }
        }
      }
      this._focus = null;
    }
  }

  // The parts of a lane that never change. The add row is in here deliberately: it is
  // built once for the life of the card and `_syncLane` does not touch it.
  _buildLane(lane) {
    const entity = lane.entity;
    const laneEl = el("section", { class: "lane", "data-lane": entity });
    if (lane.color) laneEl.style.setProperty("--lane-accent", lane.color);

    const head = el("header", {
      class: "lane-head",
      onclick: () => {
        this._store(entity, laneEl.classList.contains("collapsed") ? "0" : "1");
        this._render();
      },
    });
    const missing = el("div", { class: "missing" });
    const items = el("div", { class: "items" });
    const done = el("div", { class: "done-wrap" });

    laneEl.append(head, missing, items);
    if (!this._opt(lane, "hide_add")) laneEl.appendChild(this._renderAdd(entity));
    laneEl.appendChild(done);

    laneEl._parts = { head, missing, items, done };
    return laneEl;
  }

  // Everything that depends on the current items. Rebuilds the header, the item rows
  // and the completed section; never the add row.
  _syncLane(laneEl, lane) {
    const entity = lane.entity;
    const { head, missing, items, done } = laneEl._parts;

    const all = this._items[entity] || [];
    const open = all.filter((i) => i.status !== "completed");
    const doneItems = this._opt(lane, "hide_completed")
      ? []
      : all.filter((i) => i.status === "completed");

    const stateObj = this._hass && this._hass.states[entity];
    const title = lane.title || (stateObj && stateObj.attributes.friendly_name) || entity;
    const collapsed = this._collapsed(lane, open.length);
    laneEl.classList.toggle("collapsed", collapsed);

    head.replaceChildren(
      icon(lane.icon || DEFAULT_ICON, "lane-icon"),
      el("span", { class: "lane-title", text: title }),
      open.length
        ? el("span", { class: "count", text: String(open.length) })
        : icon("mdi:check", "count done"),
      icon(collapsed ? "mdi:chevron-down" : "mdi:chevron-up", "chev")
    );

    const gone = !!this._hass && !stateObj;
    laneEl.classList.toggle("gone", gone);
    missing.hidden = !gone;
    missing.textContent = gone ? `${entity} is not available` : "";
    if (gone) {
      items.replaceChildren();
      done.replaceChildren();
      return;
    }

    const rows = open.map((item) => this._renderItem(entity, item));
    if (!open.length && !doneItems.length) {
      rows.push(el("div", { class: "empty", text: "Nothing on this list" }));
    }
    items.replaceChildren(...rows);

    if (!doneItems.length) {
      done.replaceChildren();
      return;
    }
    const showing = !!this._showDone[entity];
    const parts = [
      el("div", { class: "done-head" }, [
        el("button", {
          class: "link",
          onclick: () => {
            this._showDone[entity] = !showing;
            this._render();
          },
        }, [icon(showing ? "mdi:chevron-up" : "mdi:chevron-down"), `${doneItems.length} done`]),
        el("button", {
          class: "link danger",
          text: "Clear",
          onclick: () => this._call("remove_completed_items", { entity_id: entity }),
        }),
      ]),
    ];
    if (showing) {
      parts.push(el("div", { class: "items done-items" },
        doneItems.map((item) => this._renderItem(entity, item))));
    }
    done.replaceChildren(...parts);
  }

  _renderItem(entity, item) {
    const editing = this._editing === item.uid;
    const row = el("div", {
      class: `item${item.status === "completed" ? " completed" : ""}${editing ? " editing" : ""}`,
      "data-uid": item.uid,
    });

    const box = el("input", {
      type: "checkbox",
      class: "check",
      checked: item.status === "completed",
      onclick: (ev) => {
        ev.stopPropagation();
        this._toggle(entity, item);
      },
    });

    const due = dueLabel(item.due);
    const label = el("div", {
      class: "label",
      onclick: () => {
        this._editing = editing ? null : item.uid;
        this._render();
      },
    }, [
      el("span", { class: "summary", text: item.summary }),
      due ? el("span", { class: `due ${due.state}`, text: due.text }) : null,
      item.description ? icon("mdi:text", "note") : null,
    ]);

    row.appendChild(box);
    row.appendChild(label);
    // No drag handle on a completed item. Dragging one used to look like it worked and
    // then snap back: `todo/item/move` changes position, not status, so the next render
    // put the item straight back under "done". Dropping it on another lane was worse —
    // it arrived there quietly un-completed. Tick it first, then move it.
    if (item.status !== "completed") row.appendChild(this._grip(entity, item));
    if (!editing) return row;

    const wrap = el("div", { class: "item-wrap", "data-uid": item.uid },
      [row, this._renderEditor(entity, item)]);
    return wrap;
  }

  _renderEditor(entity, item) {
    const key = `edit.${item.uid}`;
    const name = el("input", {
      type: "text", class: "field", value: item.summary, "data-focus": `${key}.name`,
      onkeydown: (ev) => { if (ev.key === "Enter") save(); if (ev.key === "Escape") close(); },
    });
    const dueInput = el("input", {
      type: "date", class: "field short", value: item.due ? String(item.due).slice(0, 10) : "",
      "data-focus": `${key}.due`,
    });
    const desc = el("textarea", {
      class: "field", rows: 2, placeholder: "Note", "data-focus": `${key}.desc`,
    });
    desc.value = item.description || "";

    const close = () => { this._editing = null; this._render(); };
    const save = async () => {
      await this._save(entity, item, {
        summary: name.value.trim() || item.summary,
        due: dueInput.value,
        description: desc.value,
      });
      close();
    };

    const others = this._config.lanes.filter((l) => l.entity !== entity);
    return el("div", { class: "editor" }, [
      name,
      el("div", { class: "row" }, [dueInput, desc]),
      others.length
        ? el("div", { class: "moveto" }, [
            el("span", { class: "moveto-label", text: "Move to" }),
            ...others.map((l) =>
              el("button", {
                class: "chip",
                onclick: async () => {
                  this._editing = null;
                  await this._moveBetween(entity, item, l.entity, undefined);
                  this._render();
                },
              }, [
                icon(l.icon || DEFAULT_ICON),
                l.title || (this._hass.states[l.entity] &&
                  this._hass.states[l.entity].attributes.friendly_name) || l.entity,
              ])
            ),
          ])
        : null,
      el("div", { class: "actions" }, [
        el("button", { class: "chip danger", onclick: () => { this._editing = null; this._remove(entity, item); } },
          [icon("mdi:delete-outline"), "Delete"]),
        el("span", { class: "spacer" }),
        el("button", { class: "chip", text: "Cancel", onclick: close }),
        el("button", { class: "chip primary", text: "Save", onclick: save }),
      ]),
    ]);
  }

  _renderAdd(entity) {
    const key = `add.${entity}`;
    const input = el("input", {
      type: "text",
      class: "field",
      placeholder: "Add an item",
      value: this._drafts[entity] || "",
      "data-focus": key,
      oninput: (ev) => { this._drafts[entity] = ev.target.value; },
      onkeydown: (ev) => { if (ev.key === "Enter") submit(); },
    });
    const submit = async () => {
      const text = input.value;
      if (!text.trim()) return;
      this._drafts[entity] = "";
      input.value = "";
      this._focus = [key, 0];
      await this._add(entity, text);
    };
    return el("div", { class: "add" }, [
      input,
      el("button", {
        class: "icon-btn",
        title: "Add",
        // Stops the tap moving focus off the input, so the caret stays put and a phone
        // keyboard does not close between items. Programmatically re-focusing after the
        // fact does not reopen a mobile keyboard, so it has to never leave.
        onmousedown: (ev) => ev.preventDefault(),
        onclick: submit,
      }, [icon("mdi:plus")]),
    ]);
  }
}

const STYLE = `
:host { display: block; }
[hidden] { display: none !important; }
ha-card { padding: 8px 8px 12px; }
.card-title {
  font-size: var(--ha-font-size-l, 20px); font-weight: 500;
  margin: 8px 8px 4px; color: var(--primary-text-color);
}
.error {
  display: flex; align-items: center; gap: 8px; margin: 4px 8px 8px; padding: 8px 12px;
  border-radius: 10px; background: rgba(var(--rgb-error-color, 219,68,55), 0.12);
  color: var(--error-color); font-size: 13px;
}
.board {
  display: grid; gap: 8px;
  grid-template-columns: repeat(auto-fit, minmax(var(--lane-min, 270px), 1fr));
}
.lane {
  --lane-accent: var(--primary-color);
  display: flex; flex-direction: column; min-width: 0;
  border-radius: 12px; padding: 4px 6px 6px;
  background: var(--secondary-background-color, rgba(127,127,127,0.08));
  border: 1px solid transparent;
}
.lane.drop-target { border-color: var(--lane-accent); }
.lane.collapsed .items,
.lane.collapsed .add,
.lane.collapsed .done-wrap,
.lane.gone .items,
.lane.gone .add,
.lane.gone .done-wrap { display: none; }
.lane-head {
  display: flex; align-items: center; gap: 8px; padding: 8px 6px; cursor: pointer;
  user-select: none;
}
.lane-icon { color: var(--lane-accent); --mdc-icon-size: 20px; }
.lane-title {
  flex: 1; min-width: 0; font-weight: 500; color: var(--primary-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.count {
  min-width: 22px; padding: 1px 7px; border-radius: 11px; text-align: center;
  font-size: 12px; font-weight: 600; color: var(--text-primary-color, #fff);
  background: var(--lane-accent);
}
.count.done { background: none; color: var(--success-color, #4caf50); --mdc-icon-size: 20px; }
.chev { color: var(--secondary-text-color); --mdc-icon-size: 20px; }
.items { display: flex; flex-direction: column; gap: 2px; }
.empty, .missing { padding: 10px 8px; color: var(--secondary-text-color); font-size: 13px; }
.item {
  display: flex; align-items: center; gap: 6px; padding: 4px 2px 4px 4px;
  border-radius: 8px; background: var(--card-background-color);
}
.item.dragging { opacity: 0.35; }
.item.completed .summary { text-decoration: line-through; color: var(--secondary-text-color); }
.item-wrap { display: flex; flex-direction: column; gap: 2px; }
.check { flex: none; width: 18px; height: 18px; accent-color: var(--lane-accent); }
.label {
  flex: 1; min-width: 0; cursor: pointer; padding: 4px 2px;
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
}
.summary { color: var(--primary-text-color); font-size: 14px; word-break: break-word; }
.due {
  font-size: 11px; padding: 1px 6px; border-radius: 8px; color: var(--secondary-text-color);
  background: rgba(127,127,127,0.16);
}
.due.soon { color: var(--warning-color, #ff9800); }
.due.overdue { color: var(--error-color); }
.note { --mdc-icon-size: 14px; color: var(--secondary-text-color); }
.grip {
  flex: none; display: grid; place-items: center; width: 30px; height: 30px;
  color: var(--secondary-text-color); cursor: grab; touch-action: none;
}
.grip:active { cursor: grabbing; }
.ghost {
  position: fixed; z-index: 10; pointer-events: none; opacity: 0.95;
  box-shadow: var(--ha-card-box-shadow, 0 4px 14px rgba(0,0,0,0.35));
}
.placeholder {
  height: 30px; border-radius: 8px; border: 2px dashed var(--lane-accent); opacity: 0.7;
}
.add { display: flex; align-items: center; gap: 4px; padding: 6px 2px 2px; }
.field {
  flex: 1; min-width: 0; box-sizing: border-box; padding: 7px 10px; border-radius: 8px;
  border: 1px solid var(--divider-color); background: var(--card-background-color);
  color: var(--primary-text-color); font: inherit; font-size: 14px;
}
.field:focus { outline: none; border-color: var(--lane-accent); }
.field.short { flex: 0 0 auto; width: 9.5em; }
.icon-btn {
  flex: none; display: grid; place-items: center; width: 34px; height: 34px;
  border: none; border-radius: 8px; cursor: pointer;
  background: var(--lane-accent); color: var(--text-primary-color, #fff);
}
.editor {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px; margin: 0 0 2px; border-radius: 8px;
  background: var(--card-background-color);
  border: 1px solid var(--divider-color);
}
.editor .row { display: flex; gap: 6px; align-items: flex-start; }
.moveto { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.moveto-label { font-size: 12px; color: var(--secondary-text-color); }
.actions { display: flex; align-items: center; gap: 6px; }
.spacer { flex: 1; }
.chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px;
  border-radius: 14px; border: 1px solid var(--divider-color); cursor: pointer;
  background: transparent; color: var(--primary-text-color); font: inherit; font-size: 13px;
}
.chip ha-icon { --mdc-icon-size: 16px; }
.chip.primary { background: var(--lane-accent); border-color: transparent; color: var(--text-primary-color, #fff); }
.chip.danger { color: var(--error-color); }
.link {
  display: inline-flex; align-items: center; gap: 2px; padding: 4px 2px;
  background: none; border: none; cursor: pointer; font: inherit; font-size: 13px;
  color: var(--secondary-text-color);
}
.link ha-icon { --mdc-icon-size: 18px; }
.link.danger { color: var(--error-color); margin-left: auto; }
.done-head { display: flex; align-items: center; padding: 2px 4px; }
.done-items { opacity: 0.75; }
`;

if (!customElements.get("todo-kanban-card")) {
  customElements.define("todo-kanban-card", TodoKanbanCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "todo-kanban-card",
  name: "Todo Kanban Card",
  description: "Several todo lists side by side, with drag-and-drop between them.",
});

console.info(`%c TODO-KANBAN-CARD %c ${VERSION} `,
  "color:white;background:#3f51b5;font-weight:700",
  "color:#3f51b5;background:white");
