/**
 * Derive venue grouping prefix from Tabbycat room `name` (strip trailing digits only).
 * Examples: "H2.15" → "H2.", "BL1" → "BL", "BU10" → "BU"
 * @param {string} name
 */
export function venuePrefixFromRoomName(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  const stripped = s.replace(/\d+$/, "");
  return stripped || s;
}

/** Natural sort for room codes like H2.15, H2.16, … then BL1, BL10 */
export function compareRoomNames(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}
