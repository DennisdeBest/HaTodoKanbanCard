# Changelog

## 1.3.0

- **Every tag gets a colour, whether or not you chose one.** A tag's preferred colour
  comes from a hash of its name, so it is the same on every device and after every
  reload; where two tags want the same one, or a configured tag has taken it, the next
  free colour is used instead. So a board of tags arrives looking varied without anyone
  choosing anything.
- **The editor lists every tag in play**, not just the ones already given a colour — a
  tag invented while adding a task appears there to be recoloured, marked *auto* until
  you pick something. It watches the lists, so a tag typed while the dialog is open turns
  up without reopening it.
- **The tag chips in an item's editor wear the tag's own colour** — filled when the tag
  is on, faded when it is off — rather than the lane's accent, so the row shows what the
  tags will actually look like.
- **Editing an item shows on the item as you go.** Toggling a tag or typing a name is
  reflected on the row straight away instead of only after saving, and cancelling puts
  it back.
- **Tags can contain spaces**, written in quotes after the hash: `Flour #"weekend
  baking"`. Unquoted they would read back as several one-word tags.
- **The source is split into modules under `src/`,** and `npm run build` bundles them
  into the single file HACS installs. That file is still committed, still unminified and
  still readable — the single file is forced by HACS, which downloads exactly one — but
  it is no longer the thing you edit.
- **Tags are off by default.** `enable_tags: true` switches them on, per card or per
  lane. A `#` in an item may well be there for another reason, and a card update should
  not quietly start eating it.
- **Tags.** Write one into an item — `Milk #dairy` — and the card shows *Milk* with a
  `dairy` chip beside it. Colour them with a `tags:` map; any tag you have not coloured
  still shows, in a neutral chip, so tagging something never means visiting the editor
  first. `hide_tags: true` turns the parsing off, on the card or one lane.

  Tags live in the item's summary rather than a field of their own because Home
  Assistant's to-do items do not have one — the fields are summary, status, due and
  description, and nothing else. Keeping them in the summary means they survive editing
  from the companion app or the core to-do card, they are visible to anyone not using
  this card, and uninstalling it leaves `Milk #dairy` rather than stray metadata.
- **Tags complete as you type.** `#dai` narrows the suggestions to what matches; click
  one or press Tab for the first, and the word completes. Enter is deliberately left
  alone — it adds the item, and turning that into "accept a completion" would be a nasty
  surprise mid-list.
- **Or pick one without typing.** The `#` button beside the add box lists every
  tag already in use; clicking one drops it into what you are typing. The same chips are
  in an item's editor, lit for the tags it already has, so one tap adds or removes a tag.
  The card takes the list from the lanes it already subscribes to, so suggestions cost no
  extra round trip. Neither the button nor the chips take focus, so a phone keyboard
  stays open throughout.
- **The visual editor suggests tags you have already used** when giving them colours. It
  reads the configured lists and offers what it finds, while still accepting a tag that
  does not exist yet.

## 1.2.1

Documentation only — the card itself is unchanged from 1.2.0.

- **The screenshots now render inside HACS.** HACS shows a repository's README by
  fetching it raw from GitHub at the release tag, and does not rewrite relative links —
  so every `docs/*.png` resolved against the reader's own Home Assistant and 404'd, in
  exactly the view someone uses to decide whether to install. The image URLs are
  absolute now, which GitHub renders identically.
- An "open this repository in HACS" button, release and licence badges, and issue
  templates that ask for the version, the card YAML, and whether the problem happened on
  a phone or a desktop — dragging and the keyboard behave differently on each.

## 1.2.0

- **A visual editor.** Adding the card from the picker now opens a proper form instead
  of a YAML box: choose the lists, name them, give each an icon and a colour, and
  reorder or remove them. It is built on Home Assistant's own `ha-form`, so the entity,
  icon and colour pickers are the real ones — themed, translated and behaving as they do
  everywhere else.
  It never emits a config the card would reject: a list is only added once one has
  actually been picked, and the last one cannot be removed. Per-list overrides
  (`hide_add`, `hide_completed`, `default_collapsed`) remain YAML-only and are left
  untouched if you have set them.
- **Lane colours accept Home Assistant palette names.** `color: red` now resolves to
  `var(--red-color)` and follows the theme, using the same mapping the core cards use.
  Raw CSS (`#9c27b0`, `var(--error-color)`) still passes straight through, so existing
  configurations are unaffected.
- **A card added from the picker starts with your actual lists.** `getStubConfig` reads
  the first few `todo` entities off the instance rather than guessing at
  `todo.shopping`.

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
