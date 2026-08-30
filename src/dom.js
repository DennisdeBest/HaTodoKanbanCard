/*
 * Hand-built DOM, because the card has no framework. `el` is the whole of it: a tag, a
 * bag of properties, some children.
 */
export function el(tag, props, children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "style") {
      // Object.assign onto a CSSStyleDeclaration silently drops custom properties,
      // which is how --lane-accent and --lane-min quietly did nothing.
      for (const [prop, value] of Object.entries(v)) {
        if (prop.startsWith("--")) node.style.setProperty(prop, value);
        else node.style[prop] = value;
      }
    }
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(children || [])) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function icon(name, cls) {
  return el("ha-icon", { icon: name, class: cls || "" });
}

// "2026-08-30" -> "Sat 30 Aug", and a plain marker for today / tomorrow / overdue.
export function dueLabel(due) {
  if (!due) return null;
  const day = String(due).slice(0, 10);
  const d = new Date(day + "T00:00:00");
  if (isNaN(d)) return { text: String(due), state: "" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  const text =
    days === 0 ? "today" :
    days === 1 ? "tomorrow" :
    days === -1 ? "yesterday" :
    d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return { text, state: days < 0 ? "overdue" : days <= 1 ? "soon" : "" };
}
