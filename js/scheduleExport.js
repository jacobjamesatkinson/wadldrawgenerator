/**
 * Excel (.xlsx) and CSV export for staff draw sheets. Uses ExcelJS (dynamic ESM import).
 */

import { STANDARD_TIMESLOTS } from "./timeslot.js";

const COLORS = {
  sheetBg: "FFFFFFFF",
  text: "FF1A1A1A",
  headerBg: "FFE8E8E0",
  headerAlt: "FFF3F3EF",
  border: "FFC8C8C8",
  title: "FF2C3E50",
  novice: "FFC8E6C9",
  noviceText: "FF1B5E20",
  junior: "FFF0E6D2",
  juniorText: "FF5D4037",
  senior: "FFE1D5F0",
  seniorText: "FF4527A0",
  legendNovice: "FFC8E6C9",
  legendJunior: "FFF0E6D2",
  legendSenior: "FFE1D5F0",
  adjCol: "FFF7F9FC",
};

function divisionFillArgb(division) {
  const d = String(division || "");
  if (d === "Novice") return COLORS.novice;
  if (d === "Junior") return COLORS.junior;
  if (d === "Senior") return COLORS.senior;
  return COLORS.sheetBg;
}

function divisionFontArgb(division) {
  const d = String(division || "");
  if (d === "Novice") return COLORS.noviceText;
  if (d === "Junior") return COLORS.juniorText;
  if (d === "Senior") return COLORS.seniorText;
  return COLORS.text;
}

function solidFill(argb) {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function thinBorder() {
  return {
    top: { style: "thin", color: { argb: COLORS.border } },
    left: { style: "thin", color: { argb: COLORS.border } },
    bottom: { style: "thin", color: { argb: COLORS.border } },
    right: { style: "thin", color: { argb: COLORS.border } },
  };
}

const TIMESLOT_DIVIDER_BORDER = { style: "thick", color: { argb: "FF3D3D3D" } };

function setBorderSide(cell, side, borderDef) {
  const b = cell.border || thinBorder();
  cell.border = { ...b, [side]: borderDef };
}

/**
 * Thick vertical rules between 5.15 / 6.15 / 7.15 blocks (and before row-level adjudicator column).
 * @param {import('exceljs').Worksheet} ws
 * @param {{ aff: number, neg: number, adj: number|null }[]} slotCols
 */
function applyTimeslotDividers(ws, slotCols, { perSlotAdj, adjOnlyCol, firstRow, lastRow }) {
  const slotEndCols = slotCols.map((sc) => (perSlotAdj ? sc.adj : sc.neg)).filter((c) => c != null);
  for (let row = firstRow; row <= lastRow; row++) {
    for (const endCol of slotEndCols) {
      setBorderSide(ws.getCell(row, endCol), "right", TIMESLOT_DIVIDER_BORDER);
    }
    if (!perSlotAdj && adjOnlyCol) {
      setBorderSide(ws.getCell(row, adjOnlyCol), "left", TIMESLOT_DIVIDER_BORDER);
    }
  }
}

function styleCell(cell, opts = {}) {
  const { fill, fontBold, fontColor, hAlign, fontSize } = opts;
  cell.font = {
    color: { argb: fontColor || COLORS.text },
    bold: !!fontBold,
    size: fontSize || 11,
    name: "Calibri",
  };
  cell.fill = solidFill(fill || COLORS.sheetBg);
  cell.border = thinBorder();
  cell.alignment = {
    horizontal: hAlign || "left",
    vertical: "middle",
    wrapText: true,
  };
}

export function debatesToScheduleCsv(debates) {
  const headers = ["division", "slug", "timeslot", "aff", "neg", "adj_from_api", "scheduled_at"];
  const esc = (s) => {
    const x = String(s ?? "");
    if (/[",\n]/.test(x)) return `"${x.replace(/"/g, '""')}"`;
    return x;
  };
  const lines = [headers.join(",")];
  for (const d of debates || []) {
    lines.push(
      [
        esc(d.division),
        esc(d.slug),
        esc(d.timeslot),
        esc(d.aff),
        esc(d.neg),
        esc(d.adjFromApi),
        esc(d.scheduled_at),
      ].join(",")
    );
  }
  return lines.join("\n");
}

function cellData(matrix, room, slot) {
  return matrix?.get(room)?.get(slot) ?? null;
}

function adjForExport(p, room, slot, cell) {
  if (p.inconsistentAdjAllocation) {
    const u = String(p.adjByRoomSlot?.[room]?.[slot] ?? "").trim();
    if (u) return u;
  } else {
    const u = String(p.adjByRoom?.[room] ?? "").trim();
    if (u) return u;
  }
  return String(cell?.adjFromApi ?? "").trim();
}

function autoFitColumns(ws, fromCol, toCol, { min = 8, max = 42 } = {}) {
  for (let c = fromCol; c <= toCol; c++) {
    let maxLen = min;
    ws.eachRow((row) => {
      const v = row.getCell(c).value;
      if (v == null) return;
      const s = typeof v === "object" && v.richText ? v.richText.map((t) => t.text).join("") : String(v);
      const lines = s.split(/\r?\n/);
      for (const line of lines) maxLen = Math.max(maxLen, line.length + 2);
    });
    ws.getColumn(c).width = Math.min(max, Math.max(min, maxLen));
  }
}

/** Longest AFF/NEG team name in the sheet (characters). */
function maxTeamNameChars(roomOrder, cellByRoomSlot, slotCols) {
  let maxLen = 3;
  for (const room of roomOrder || []) {
    for (const sc of slotCols) {
      const cell = cellData(cellByRoomSlot, room, sc.slot);
      const aff = String(cell?.aff ?? "").trim();
      const neg = String(cell?.neg ?? "").trim();
      if (aff) maxLen = Math.max(maxLen, aff.length);
      if (neg) maxLen = Math.max(maxLen, neg.length);
    }
  }
  return maxLen;
}

function teamColumnWidth(charLen, { min = 10, max = 44, padding = 2 } = {}) {
  return Math.min(max, Math.max(min, charLen + padding));
}

/** Same width on every AFF and NEG column. */
function applyUniformTeamColumnWidths(ws, slotCols, width) {
  for (const sc of slotCols) {
    ws.getColumn(sc.aff).width = width;
    ws.getColumn(sc.neg).width = width;
  }
}

/**
 * @param {import('exceljs').Worksheet} ws
 * @param {number} lastCol
 */
function applySheetChrome(ws, lastCol) {
  ws.views = [{ state: "frozen", ySplit: 6, showGridLines: true }];
  ws.properties.defaultRowHeight = 20;
  for (let c = 1; c <= lastCol; c++) {
    if (!ws.getColumn(c).width) ws.getColumn(c).width = 12;
  }
}

export async function buildScheduleWorkbook(p) {
  const mod = await import("https://esm.sh/exceljs@4.4.0");
  const ExcelJS = mod.default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "WADL draw sheet";
  const ws = wb.addWorksheet("Draw", { properties: { defaultRowHeight: 20 } });
  buildDrawSheet(ws, p);
  return wb;
}

/**
 * @param {import('exceljs').Worksheet} ws
 */
function buildDrawSheet(ws, p) {
  const {
    dateDisplay,
    weekday,
    venueTitle,
    ha,
    adjRoom,
    prepMonitorLines,
    roomOrder,
    adjByRoom,
    adjByRoomSlot,
    cellByRoomSlot,
    inconsistentAdjAllocation,
  } = p;
  const perSlotAdj = !!inconsistentAdjAllocation;

  let col = 2;
  const slotCols = STANDARD_TIMESLOTS.map((slot) => {
    const aff = col;
    const neg = col + 1;
    col += 2;
    const adj = perSlotAdj ? col++ : null;
    return { slot, aff, neg, adj };
  });
  const adjOnlyCol = perSlotAdj ? null : col;
  const lastDataCol = perSlotAdj ? slotCols[slotCols.length - 1].adj : adjOnlyCol;

  styleCell(ws.getCell(1, 1), { fontBold: true, fontSize: 12, fontColor: COLORS.title });
  ws.getCell(1, 1).value = dateDisplay;
  styleCell(ws.getCell(1, 2), { fontBold: true, fontSize: 14, hAlign: "center", fontColor: COLORS.title });
  ws.getCell(1, 2).value = venueTitle;
  ws.mergeCells(1, 2, 1, Math.min(6, lastDataCol));

  styleCell(ws.getCell(2, 1), { fontBold: true });
  ws.getCell(2, 1).value = weekday;
  if (ha) {
    styleCell(ws.getCell(2, lastDataCol - 1), {});
    ws.getCell(2, lastDataCol - 1).value = `HA: ${ha}`;
  }
  if (adjRoom) {
    styleCell(ws.getCell(2, lastDataCol), {});
    ws.getCell(2, lastDataCol).value = `Adj Room: ${adjRoom}`;
  }

  const legCol = lastDataCol + 2;
  styleCell(ws.getCell(1, legCol), { fill: COLORS.legendNovice, fontBold: true });
  ws.getCell(1, legCol).value = "Novices";
  styleCell(ws.getCell(2, legCol), { fill: COLORS.legendJunior, fontBold: true });
  ws.getCell(2, legCol).value = "Juniors";
  styleCell(ws.getCell(3, legCol), { fill: COLORS.legendSenior, fontBold: true });
  ws.getCell(3, legCol).value = "Seniors";

  const headerRow = 5;
  styleCell(ws.getCell(headerRow, 1), { fontBold: true, fill: COLORS.headerBg, hAlign: "center" });
  ws.getCell(headerRow, 1).value = "Room";

  for (const sc of slotCols) {
    styleCell(ws.getCell(headerRow, sc.aff), { fontBold: true, fill: COLORS.headerBg, hAlign: "center" });
    ws.getCell(headerRow, sc.aff).value = sc.slot;
    const spanEnd = perSlotAdj ? sc.adj : sc.neg;
    if (spanEnd > sc.aff) ws.mergeCells(headerRow, sc.aff, headerRow, spanEnd);
  }

  if (!perSlotAdj && adjOnlyCol) {
    styleCell(ws.getCell(headerRow, adjOnlyCol), { fontBold: true, fill: COLORS.headerBg, hAlign: "center" });
    ws.getCell(headerRow, adjOnlyCol).value = "Adjudicator";
  }

  const subRow = headerRow + 1;
  for (const sc of slotCols) {
    styleCell(ws.getCell(subRow, sc.aff), { fontBold: true, fill: COLORS.headerAlt, hAlign: "center" });
    ws.getCell(subRow, sc.aff).value = "AFF";
    styleCell(ws.getCell(subRow, sc.neg), { fontBold: true, fill: COLORS.headerAlt, hAlign: "center" });
    ws.getCell(subRow, sc.neg).value = "NEG";
    if (perSlotAdj && sc.adj) {
      styleCell(ws.getCell(subRow, sc.adj), { fontBold: true, fill: COLORS.headerAlt, hAlign: "center" });
      ws.getCell(subRow, sc.adj).value = "Adj";
    }
  }

  let r = subRow + 1;
  for (const room of roomOrder || []) {
    styleCell(ws.getCell(r, 1), { fill: COLORS.sheetBg, fontBold: true, hAlign: "center" });
    ws.getCell(r, 1).value = room;

    let rowAdj = "";
    for (const sc of slotCols) {
      const cell = cellData(cellByRoomSlot, room, sc.slot);
      const aff = cell?.aff ?? "";
      const neg = cell?.neg ?? "";
      const div = cell?.division ?? "";
      const affFill = aff ? divisionFillArgb(div) : COLORS.sheetBg;
      const negFill = neg ? divisionFillArgb(div) : COLORS.sheetBg;
      const divFont = aff || neg ? divisionFontArgb(div) : COLORS.text;

      styleCell(ws.getCell(r, sc.aff), { fill: affFill, hAlign: "center", fontColor: divFont });
      ws.getCell(r, sc.aff).value = aff;
      styleCell(ws.getCell(r, sc.neg), { fill: negFill, hAlign: "center", fontColor: divFont });
      ws.getCell(r, sc.neg).value = neg;

      if (perSlotAdj && sc.adj) {
        const adjVal = cell && (aff || neg) ? adjForExport(p, room, sc.slot, cell) : "";
        styleCell(ws.getCell(r, sc.adj), { fill: COLORS.adjCol, hAlign: "center" });
        ws.getCell(r, sc.adj).value = adjVal;
      } else if (cell && (aff || neg)) {
        rowAdj = adjForExport(p, room, sc.slot, cell);
      }
    }

    if (!perSlotAdj && adjOnlyCol) {
      styleCell(ws.getCell(r, adjOnlyCol), { fill: COLORS.adjCol, hAlign: "center" });
      ws.getCell(r, adjOnlyCol).value = rowAdj;
    }
    r++;
  }

  const lastDataRow = r - 1;
  applyTimeslotDividers(ws, slotCols, {
    perSlotAdj,
    adjOnlyCol,
    firstRow: headerRow,
    lastRow: lastDataRow,
  });

  r += 1;
  for (const line of prepMonitorLines || []) {
    if (!String(line).trim()) continue;
    styleCell(ws.getCell(r, Math.max(2, lastDataCol - 2)), {});
    ws.getCell(r, Math.max(2, lastDataCol - 2)).value = line;
    r++;
  }

  const teamWidth = teamColumnWidth(maxTeamNameChars(roomOrder, cellByRoomSlot, slotCols));
  applyUniformTeamColumnWidths(ws, slotCols, teamWidth);

  autoFitColumns(ws, 1, 1, { min: 10, max: 44 });
  if (adjOnlyCol) autoFitColumns(ws, adjOnlyCol, adjOnlyCol, { min: 14, max: 48 });
  else {
    for (const sc of slotCols) {
      if (sc.adj) autoFitColumns(ws, sc.adj, sc.adj, { min: 12, max: 48 });
    }
  }
  autoFitColumns(ws, legCol, legCol, { min: 10, max: 44 });
  applySheetChrome(ws, legCol);
}

export async function downloadWorkbook(wb, filename) {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function shareScheduleFile(file, title) {
  if (!navigator.share || !navigator.canShare) {
    throw new Error("Web Share API not available in this browser.");
  }
  const data = { files: [file], title: title || file.name };
  if (!navigator.canShare(data)) {
    throw new Error("This device cannot share .xlsx files (try Download).");
  }
  await navigator.share(data);
}

export async function workbookToXlsxFile(wb, baseName) {
  const buf = await wb.xlsx.writeBuffer();
  const name = baseName.endsWith(".xlsx") ? baseName : `${baseName}.xlsx`;
  return new File([buf], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
