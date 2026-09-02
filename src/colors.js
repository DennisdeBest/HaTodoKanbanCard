/*
 * Home Assistant's own colour palette, so `color: red` works in a lane and follows the
 * theme, while `#9c27b0` and `var(--error-color)` still pass straight through. Same
 * mapping the core cards use: a known name becomes `var(--<name>-color)`, anything else
 * is handed to CSS untouched.
 */
export const HA_COLORS = new Set([
  "primary", "accent", "red", "pink", "purple", "deep-purple", "indigo", "blue",
  "light-blue", "cyan", "teal", "green", "light-green", "lime", "yellow", "amber",
  "orange", "deep-orange", "brown", "light-grey", "grey", "dark-grey", "blue-grey",
  "black", "white", "primary-text", "secondary-text", "disabled",
]);

export function computeCssColor(value) {
  if (!value || typeof value !== "string") return value;
  return HA_COLORS.has(value) ? `var(--${value}-color)` : value;
}

/*
 * Colours handed out to tags nobody has configured. Deterministic rather than random,
 * so a tag looks the same on every device and after every reload — and picked from a
 * spread of hues so two tags side by side rarely look alike.
 */
export const TAG_PALETTE = [
  "blue", "green", "orange", "purple", "teal", "pink",
  "amber", "indigo", "light-green", "deep-orange", "cyan", "brown",
];

function hashOf(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash;
}

/*
 * Automatic colours for the tags nobody has coloured by hand.
 *
 * A tag's preferred slot comes from a hash of its name, so it keeps the same colour
 * across devices and reloads. Where two tags want the same slot, or where the slot is
 * already spoken for by a configured tag, the next free one is taken instead — walking
 * the tags in a stable order so the result does not depend on who was looked up first.
 * Twelve colours means a thirteenth tag has to repeat one; it is a shopping list, not a
 * colour scheme.
 */
export function autoTagColors(tags, configured) {
  const chosen = configured || {};
  const taken = new Set(Object.values(chosen).filter(Boolean));
  const out = {};
  for (const tag of [...new Set(tags || [])].sort((a, b) => a.localeCompare(b))) {
    if (chosen[tag]) continue;
    const start = hashOf(String(tag)) % TAG_PALETTE.length;
    let pick = TAG_PALETTE[start];
    for (let i = 0; i < TAG_PALETTE.length; i++) {
      const candidate = TAG_PALETTE[(start + i) % TAG_PALETTE.length];
      if (!taken.has(candidate)) { pick = candidate; break; }
    }
    taken.add(pick);
    out[tag] = pick;
  }
  return out;
}

// The colour a tag is drawn in: the configured one, or its automatic slot. Pass the
// full set of tags in play and no two of them will land on the same colour.
export function tagColor(tag, configured, allTags) {
  const set = (configured || {})[tag];
  if (set) return computeCssColor(set);
  if (allTags && allTags.length) {
    const auto = autoTagColors(allTags, configured);
    if (auto[tag]) return computeCssColor(auto[tag]);
  }
  return computeCssColor(TAG_PALETTE[hashOf(String(tag)) % TAG_PALETTE.length]);
}
