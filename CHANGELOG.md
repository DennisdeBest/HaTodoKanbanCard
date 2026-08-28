# Changelog

## 1.1.0

Four fixes from a month of the card being used in anger, three of them on a phone.

- **Adding several items in a row no longer fights you.** The board is updated in place
  instead of being torn down and rebuilt on every change, so the "add an item" field is
  never recreated and keeps focus and its caret between items. The add button no longer
  takes focus when tapped either. On a phone the keyboard now stays open across a run of
  items — re-focusing programmatically could never have achieved that, because
  programmatic focus does not reopen a mobile keyboard.
- **Dragging near the top or bottom of the screen scrolls the page.** An item could not
  be dropped into a lane that was off the bottom of a phone screen: the drag handle sets
  `touch-action: none`, so the browser will not scroll, and a finger held still fires no
  further pointer events. There is now an animation-frame loop that scrolls the nearest
  scrollable ancestor — crossing shadow roots, since in a dashboard the thing that
  scrolls is several levels up — and recalculates the drop position as the page moves.
- **Touch drags take a pointer capture**, so the browser can no longer decide
  mid-gesture that the drag was really a scroll and cancel it.
- **Completed items have no drag handle.** Dragging one appeared to work and then
  snapped back: `todo/item/move` changes an item's position, not its status, so the next
  render returned it to the "done" section. Dropping one on another lane was worse — a
  cross-lane move is an add followed by a remove, and an added item is always
  `needs_action`, so it arrived quietly un-completed. Tick it first, then move it.

### Documentation

- The README has screenshots and an animation of a cross-list drag, generated from the
  demo page by `npm run shots`.
- **It now says how to give the card the width it needs in a `sections` view**, which
  turns out to need three settings agreeing rather than the obvious one. A section's
  internal grid is `12 × column_span` columns wide, so the familiar `columns: 12` spans
  only a third of a three-span section — `grid_options: {columns: "full"}` is the value
  that means full width whatever the span. The examples carry it now.

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
