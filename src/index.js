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

import { TodoKanbanCard } from "./card.js";
import { TodoKanbanCardEditor } from "./editor.js";
import { VERSION } from "./version.js";

if (!customElements.get("todo-kanban-card-editor")) {
  customElements.define("todo-kanban-card-editor", TodoKanbanCardEditor);
}
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
