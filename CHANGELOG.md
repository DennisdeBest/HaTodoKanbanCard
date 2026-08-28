# Changelog

## 1.0.0

First release.

- Any number of `todo` entities as lanes, side by side, wrapping on narrow screens.
- Drag an item between lanes — the thing core Home Assistant cannot do.
- Drag within a lane to reorder.
- Per-item editor: rename, due date, note, delete, and a **Move to** row that does the
  same job as a drag without needing one.
- Add and complete items, and a foldaway "done" section per lane with a clear button.
- Lane folding, remembered per browser, defaulting to "shut when the lane is empty".
- Live updates over `todo/item/subscribe`, so the board follows changes made anywhere.
- `hide_completed`, `hide_add`, `default_collapsed` and `min_lane_width`, settable on
  the card and overridable per lane.

## 1.1.0

Three things that only show up once the card is in daily use, two of them on a phone.

- **Adding several items in a row no longer fights you.** The board is updated in place
  instead of being rebuilt, so the "add an item" field keeps focus and the caret after
  each item, and the add button no longer takes focus when tapped. On a phone the
  keyboard stays open between items — re-focusing programmatically could never have
  achieved that.
- **Dragging near the top or bottom of the screen scrolls the page.** Previously an item
  could not be dropped into a lane that was off the bottom of a phone screen: the grip
  sets `touch-action: none`, so nothing scrolled and a finger held still fired no further
  events. There is now an animation-frame loop that scrolls and recalculates the drop
  position while the pointer is parked at an edge.
- Touch drags take a pointer capture, so the browser can no longer decide mid-gesture
  that the drag was really a scroll and cancel it.

Also: the README has screenshots and an animation of a drag, generated from the demo page
by `npm run shots`; and a note on why lanes sometimes refuse to sit side by side (a
sections view caps each column at ~500 px — raise `max_columns` and `column_span`).
