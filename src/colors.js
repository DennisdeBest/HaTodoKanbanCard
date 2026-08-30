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

// The colour a tag should be drawn in: what the config says, or a stable one derived
// from its name so that an unconfigured tag still arrives looking like something.
export function tagColor(tag, configured) {
  const set = (configured || {})[tag];
  if (set) return computeCssColor(set);
  return computeCssColor(TAG_PALETTE[hashOf(String(tag)) % TAG_PALETTE.length]);
}

// The first palette colour no other tag has taken — what the editor prefills a new row
// with, so a list of tags ends up looking varied without anyone choosing.
export function nextFreeTagColor(configured) {
  const taken = new Set(Object.values(configured || {}).filter(Boolean));
  return TAG_PALETTE.find((c) => !taken.has(c)) || TAG_PALETTE[0];
}
