// Weekly insights docs (cafes/{id}/insights/{weekStart}) are written by the
// agent's backend. The keys in `counts` may grow, so known ones get a label
// and anything new is still shown, with its key turned into words.

const COUNT_LABELS = {
  customerQuestions: "Customer questions",
  uniqueCustomers: "Customers",
  menuUpdates: "Menu updates",
  menuViews: "Menu views",
};

const ORDER = Object.keys(COUNT_LABELS);

/** "customerQuestions" → "Customer questions". */
export function humanizeKey(key) {
  const words = String(key)
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** [{ key, label, value }] — known counts first in a fixed order, then the rest A–Z. */
export function countRows(counts) {
  const entries = Object.entries(counts ?? {}).filter(([, value]) => typeof value === "number");
  const rank = (key) => (ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length);
  return entries
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([key, value]) => ({ key, label: COUNT_LABELS[key] ?? humanizeKey(key), value }));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-09" → "Week of Nov 9". Unparseable input is returned as-is. */
export function weekLabel(weekStart) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(weekStart));
  if (!match) return String(weekStart);
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `Week of ${month} ${Number(match[3])}` : String(weekStart);
}

/** "today", "yesterday", "3 days ago", or "Nov 2" for anything older than a week. */
export function relativeDay(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}
