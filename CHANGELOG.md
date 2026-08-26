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
