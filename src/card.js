import { el, icon, dueLabel } from "./dom.js";
import { splitTags, formatTag, toggleTag, tagTokenAt } from "./tags.js";
import { computeCssColor, tagColor } from "./colors.js";
import STYLE from "./styles.css";

const STORE = "todo-kanban.collapsed.";
const DEFAULT_ICON = "mdi:format-list-checks";

/*
 * Card-wide defaults. A lane may override any of these for itself.
 */
const DEFAULTS = {
  title: undefined,
  // "auto" opens a lane that has something in it and shuts one that does not; true and
  // false pin it. Whatever the default, a click on the header wins until the lane next
  // crosses empty (and under true/false, until the browser forgets).
  default_collapsed: "auto",
  hide_completed: false,
  hide_add: false,
  // Off by default: plenty of people have a `#` in an item for reasons of their own,
  // and a card update should not quietly start eating it.
  enable_tags: false,
  min_lane_width: 270,
  // tag name -> colour. Any tag not listed here still shows, in a neutral chip.
  tags: {},
};

export class TodoKanbanCard extends HTMLElement {
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

  static getConfigElement() {
    return document.createElement("todo-kanban-card-editor");
  }

  // What the card picker drops in. Real lists if this instance has any, so the card is
  // useful the moment it is added rather than showing an error about todo.shopping.
  static getStubConfig(hass) {
    const todos = Object.keys((hass && hass.states) || {})
      .filter((id) => id.startsWith("todo."))
      .slice(0, 3);
    return { lanes: (todos.length ? todos : ["todo.shopping"]).map((entity) => ({ entity })) };
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
    if (config.tags !== undefined
        && (typeof config.tags !== "object" || config.tags === null || Array.isArray(config.tags))) {
      throw new Error("todo-kanban-card: `tags` must be a map of tag name to colour");
    }
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
    if (lane.color) laneEl.style.setProperty("--lane-accent", computeCssColor(lane.color));

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
    const lane = (this._config.lanes || []).find((l) => l.entity === entity) || {};
    const parsed = this._opt(lane, "enable_tags")
      ? splitTags(item.summary)
      : { text: item.summary, tags: [] };
    const palette = this._config.tags || {};
    const known = this._knownTags();

    // Rebuilt in place while the editor is open, so toggling a tag or typing a name is
    // reflected on the item straight away rather than only once it is saved.
    const paint = (summary) => {
      const shown = this._opt(lane, "enable_tags")
        ? splitTags(summary)
        : { text: summary, tags: [] };
      label.replaceChildren(
        el("span", { class: "summary", text: shown.text }),
        ...shown.tags.map((tag) => {
          const chip = el("span", { class: "tag", text: tag });
          chip.style.setProperty("--tag-color", tagColor(tag, palette, known));
          return chip;
        }),
        ...(due ? [el("span", { class: `due ${due.state}`, text: due.text })] : []),
        ...(item.description ? [icon("mdi:text", "note")] : [])
      );
    };

    const label = el("div", {
      class: "label",
      onclick: () => {
        this._editing = editing ? null : item.uid;
        this._render();
      },
    }, [
      el("span", { class: "summary", text: parsed.text }),
      // A tag with no colour configured still shows, in a neutral chip — tagging
      // something should not require a trip to the editor first.
      ...parsed.tags.map((tag) => {
        const chip = el("span", { class: "tag", text: tag });
        chip.style.setProperty("--tag-color", tagColor(tag, palette, known));
        return chip;
      }),
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
      [row, this._renderEditor(entity, item, paint)]);
    return wrap;
  }

  _renderEditor(entity, item, preview) {
    const key = `edit.${item.uid}`;
    const name = el("input", {
      type: "text", class: "field", value: item.summary, "data-focus": `${key}.name`,
      // Typing shows on the item as you go, the same as toggling a chip does.
      oninput: (ev) => preview(ev.target.value),
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

    const close = () => {
      preview(item.summary);          // undo anything previewed but not saved
      this._editing = null;
      this._render();
    };
    const save = async () => {
      await this._save(entity, item, {
        summary: name.value.trim() || item.summary,
        due: dueInput.value,
        description: desc.value,
      });
      close();
    };

    const others = this._config.lanes.filter((l) => l.entity !== entity);
    const known = this._opt(
      (this._config.lanes || []).find((l) => l.entity === entity) || {}, "enable_tags"
    ) ? this._knownTags() : [];
    return el("div", { class: "editor" }, [
      name,
      el("div", { class: "row" }, [dueInput, desc]),
      known.length
        ? el("div", { class: "moveto" }, [
            el("span", { class: "moveto-label", text: "Tags" }),
            ...known.map((tag) => this._tagChip(tag, name, (value) => preview(value))),
          ])
        : null,
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

  /*
   * Every tag currently in play: the ones given a colour, plus the ones actually
   * written on items. The card already subscribes to every lane, so this costs nothing
   * — no extra round trip to offer suggestions.
   */
  _knownTags() {
    const found = new Set(Object.keys(this._config.tags || {}));
    for (const items of Object.values(this._items)) {
      for (const item of items || []) {
        for (const tag of splitTags(item.summary).tags) found.add(tag);
      }
    }
    return [...found].sort((a, b) => a.localeCompare(b));
  }

  // A chip that puts a tag into, or takes it out of, a text field.
  /*
   * A chip that puts a tag into, or takes it out of, a text field.
   *
   * It wears the tag's own colour when it is on and a muted version of it when it is
   * off, rather than the lane's accent — the point of the row is to show what the tags
   * look like. A tag whose colour happens to be grey is then harder to read as on or
   * off, which is the price of every other tag being obvious.
   */
  _tagChip(tag, field, onChange) {
    const chip = el("button", {
      class: "chip tag-chip",
      // Never take focus: on a phone that closes the keyboard mid-edit.
      onmousedown: (ev) => ev.preventDefault(),
      onclick: () => {
        field.value = toggleTag(field.value, tag);
        chip.classList.toggle("on", splitTags(field.value).tags.includes(tag));
        if (onChange) onChange(field.value);
        field.focus();
      },
    }, [tag]);
    chip.style.setProperty("--tag-color", tagColor(tag, this._config.tags || {}, this._knownTags()));
    if (splitTags(field.value).tags.includes(tag)) chip.classList.add("on");
    return chip;
  }

  _renderAdd(entity) {
    const key = `add.${entity}`;
    const lane = (this._config.lanes || []).find((l) => l.entity === entity) || {};
    const input = el("input", {
      type: "text",
      class: "field",
      placeholder: "Add an item",
      value: this._drafts[entity] || "",
      "data-focus": key,
      oninput: (ev) => { this._drafts[entity] = ev.target.value; refresh(); },
      onkeyup: () => refresh(),
      onclick: () => refresh(),
      onkeydown: (ev) => {
        if (ev.key === "Enter") { submit(); return; }
        // Tab takes the first suggestion. Enter is left alone — it adds the item, and
        // quietly turning that into "accept a completion" would be a nasty surprise.
        if (ev.key === "Tab" && !suggest.hidden) {
          const first = suggest.querySelector(".tag-chip");
          if (first) { ev.preventDefault(); first.click(); }
        }
      },
    });
    const submit = async () => {
      const text = input.value;
      if (!text.trim()) return;
      this._drafts[entity] = "";
      input.value = "";
      this._focus = [key, 0];
      await this._add(entity, text);
    };
    /*
     * Tag suggestions, in two modes.
     *
     * The `#` button lists every tag in use, and a chip toggles it. Typing `#dai` into
     * the field instead filters the same row down to what matches and completes the
     * word you are part-way through — so a tag can be picked, typed, or half-typed and
     * then picked.
     *
     * It is all built on demand rather than up front, because the add row is created
     * once for the life of the card — that is what keeps the field focused between
     * items — so it cannot rely on a re-render to refresh itself.
     */
    const suggest = el("div", { class: "tag-suggest", hidden: true });
    let pinned = false;   // the button was pressed, so keep the full list showing

    const token = () => tagTokenAt(input.value, input.selectionStart);

    const complete = (tag) => {
      const { from, to } = token();
      const before = input.value.slice(0, from);
      const after = input.value.slice(to);
      const written = formatTag(tag);
      input.value = `${before}${written}${after.startsWith(" ") ? "" : " "}${after}`;
      const caret = (before + written + " ").length;
      input.setSelectionRange(caret, caret);
      this._drafts[entity] = input.value;
      input.focus();
      refresh();
    };

    const refresh = () => {
      if (!this._opt(lane, "enable_tags")) return;
      const known = this._knownTags();
      const { query } = token();

      if (query !== null) {
        const needle = query.toLowerCase();
        const already = splitTags(input.value).tags;
        const matches = known.filter(
          (t) => t.toLowerCase().startsWith(needle) && (t.toLowerCase() !== needle || !already.includes(t))
        );
        suggest.replaceChildren(...matches.map((tag) => {
          const chip = el("button", {
            class: "chip tag-chip",
            onmousedown: (ev) => ev.preventDefault(),
            onclick: () => complete(tag),
          }, [tag]);
          return chip;
        }));
        suggest.hidden = matches.length === 0;
        return;
      }

      if (!pinned) {
        suggest.hidden = true;
        return;
      }
      suggest.replaceChildren(
        ...(known.length
          ? known.map((tag) => this._tagChip(tag, input, (v) => { this._drafts[entity] = v; }))
          : [el("span", { class: "no-tags", text: "No tags yet — type #something into an item" })])
      );
      suggest.hidden = false;
    };

    const tagButton = el("button", {
      class: "tag-btn",
      title: "Tags",
      onmousedown: (ev) => ev.preventDefault(),
      onclick: () => {
        pinned = !pinned;
        refresh();
        input.focus();
      },
    }, [icon("mdi:pound")]);

    return el("div", { class: "add" }, [
      el("div", { class: "add-row" }, [
        input,
        this._opt(lane, "enable_tags") ? tagButton : null,
        el("button", {
          class: "icon-btn",
          title: "Add",
          // Stops the tap moving focus off the input, so the caret stays put and a phone
          // keyboard does not close between items. Programmatically re-focusing after the
          // fact does not reopen a mobile keyboard, so it has to never leave.
          onmousedown: (ev) => ev.preventDefault(),
          onclick: submit,
        }, [icon("mdi:plus")]),
      ]),
      suggest,
    ]);
  }
}
