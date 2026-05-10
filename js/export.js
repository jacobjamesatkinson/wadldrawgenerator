/**
 * CSV export for generated debates (respects selection state on each row).
 */

import { sanitizeCsvCell } from "./merge.js";

function esc(s) {
  const x = String(s ?? "");
  if (/[",\n]/.test(x)) return `"${x.replace(/"/g, '""')}"`;
  return x;
}

export function debatesToCsv(debates) {
  const headers = [
    "pool_label",
    "venue_label",
    "timeslot",
    "scheduled_at",
    "tabbycat_room",
    "kind",
    "aff",
    "neg",
    "note",
    "included",
    "posted",
  ];
  const lines = [headers.join(",")];
  for (const d of debates) {
    const aff = d.aff?.csvLabel ?? d.aff?.short_name ?? d.aff?.long_name ?? "";
    const neg = d.neg?.csvLabel ?? d.neg?.short_name ?? d.neg?.long_name ?? "";
    lines.push(
      [
        esc(d.poolLabel),
        esc(d.venueLabel),
        esc(sanitizeCsvCell(String(d.timeslot ?? ""))),
        esc(d._scheduledAt ?? ""),
        esc(d.tabbycatVenueDisplay ?? ""),
        esc(d.kind),
        esc(aff),
        esc(neg),
        esc(d.note),
        esc(d.included ? "yes" : "no"),
        esc(d.posted ? "yes" : "no"),
      ].join(",")
    );
  }
  return lines.join("\n");
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
