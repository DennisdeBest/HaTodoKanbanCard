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
