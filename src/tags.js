/*
 * Tags. Home Assistant's todo items have four fields — summary, status, due,
 * description — and no notion of a tag, so anything tag-shaped has to live inside one
 * of them. These functions are the whole of that convention: how a tag is written into
 * an item's text, read back out, and completed while being typed.
 */
export const TAG_PATTERN = /(?:^|\s)#(?:"([^"\n]+)"|'([^'\n]+)'|([\p{L}\p{N}][\p{L}\p{N}_-]*))/gu;

export function splitTags(summary) {
  const raw = String(summary ?? "");
  const tags = [];
  const text = raw
    .replace(TAG_PATTERN, (_match, quoted, singled, bare) => {
      const tag = (quoted ?? singled ?? bare).trim();
      if (tag && !tags.includes(tag)) tags.push(tag);
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  // An item that is nothing but tags still needs something to show.
  return { text: text || raw.trim(), tags };
}

// How a tag is written back into item text. Anything with a space in it has to be
// quoted, or reading it back would find several one-word tags instead of one.
export function formatTag(tag) {
  const clean = String(tag ?? "").trim();
  return /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(clean) ? `#${clean}` : `#"${clean}"`;
}

// Add or remove a tag in a piece of item text, leaving the rest of it alone.
export function toggleTag(text, tag) {
  const raw = String(text ?? "");
  if (!splitTags(raw).tags.includes(tag)) return `${raw.trim()} ${formatTag(tag)}`.trim();
  return raw
    .replace(TAG_PATTERN, (match, quoted, singled, bare) => {
      const found = (quoted ?? singled ?? bare).trim();
      return found === tag ? " " : match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/*
 * The tag the caret is sitting in, which is what a completion replaces. Quoted tags
 * contain spaces, so this cannot simply split the line on whitespace: it looks back for
 * the nearest `#` and then decides where that tag ends — at the closing quote, or at the
 * next space for a bare one.
 */
export function tagTokenAt(value, caret) {
  const text = String(value ?? "");
  const at = Math.max(0, Math.min(caret ?? text.length, text.length));
  const hash = text.lastIndexOf("#", Math.max(0, at - 1));
  const none = { from: at, to: at, query: null };
  if (hash === -1) return none;
  if (hash > 0 && !/\s/.test(text[hash - 1])) return none;   // mid-word, not a tag

  const rest = text.slice(hash + 1);
  if (rest.startsWith('"')) {
    const close = rest.indexOf('"', 1);
    const to = close === -1 ? text.length : hash + 1 + close + 1;
    if (at > to) return none;
    return { from: hash, to, query: rest.slice(1, close === -1 ? undefined : close) };
  }
  const space = rest.search(/\s/);
  const to = space === -1 ? text.length : hash + 1 + space;
  if (at > to) return none;
  return { from: hash, to, query: rest.slice(0, space === -1 ? undefined : space) };
}
