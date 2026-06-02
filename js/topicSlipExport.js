/**
 * Topic slip export: Word (.docx) from WADL template + PDF (paginated).
 */

import { slipsToPages } from "./topicSlipData.js";

const TEMPLATE_URL = "assets/wadl-topic-slip-template.docx";
const LOGO_URL = "assets/wadl-logo.png";

function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtml(s) {
  return escapeXml(s).replace(/\n/g, "<br />");
}

/**
 * @param {string} xml
 * @param {string} label
 * @param {string} value
 */
function replaceBoldAfterLabel(xml, label, value) {
  const esc = escapeXml(value);
  const re = new RegExp(
    `(${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?<w:t[^>]*>)([^<]*)(</w:t>)`,
    "i"
  );
  return xml.replace(re, `$1${esc}$3`);
}

const TOPIC_CELL_PPR =
  '<w:pPr><w:widowControl w:val="0"/><w:spacing w:line="240" w:lineRule="auto"/><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Times New Roman"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:pPr>';
const TOPIC_CELL_RPR =
  '<w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Times New Roman"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr>';

function topicLabelPara(label) {
  return `<w:p>${TOPIC_CELL_PPR}<w:r>${TOPIC_CELL_RPR}<w:t>${escapeXml(label)}</w:t></w:r></w:p>`;
}

function topicBodyParas(text) {
  const lines = String(text || " ")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x, i, arr) => x || i === 0 || arr.length === 1);
  if (!lines.length) lines.push(" ");
  return lines
    .map((line) => {
      const t = escapeXml(line || " ");
      return `<w:p>${TOPIC_CELL_PPR}<w:r>${TOPIC_CELL_RPR}<w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    })
    .join("");
}

function replaceTopicCell(rowXml, topic, infoSlide) {
  const m = rowXml.match(/^(<w:tr[^>]*>)(<w:tc>)([\s\S]*?)(<\/w:tc>)([\s\S]*<\/w:tr>)$/);
  if (!m) return rowXml;
  const tcPr = m[3].match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/)?.[0] || "";
  const newTc = `${m[2]}${tcPr}${topicLabelPara("TOPIC:")}${topicBodyParas(topic)}${topicLabelPara("INFO SLIDE:")}${topicBodyParas(infoSlide)}${m[4]}`;
  return m[1] + newTc + m[5];
}

/** Add <w:keepNext/> to every paragraph in a fragment so its rows stay with the next row. */
function addKeepNextToParagraphs(xml) {
  let out = xml.replace(/<w:pPr>/g, "<w:pPr><w:keepNext/>");
  out = out.replace(/(<w:p\b[^>]*>)(?!<w:pPr>)/g, "$1<w:pPr><w:keepNext/></w:pPr>");
  return out;
}

/**
 * Let the row size to its content (like the template) but never split across a page.
 * When `keepWithNext` is set, the row is glued to the following row so a 2-row slip
 * table is always kept together on one page.
 * @param {string} rowXml
 * @param {boolean} keepWithNext
 */
function setRowKeep(rowXml, keepWithNext) {
  // Drop any forced/exact row height so the row grows to fit its content.
  let xml = rowXml.replace(/<w:trHeight[^/]*\/>/gi, "");
  if (/<w:trPr>/i.test(xml)) {
    if (!/<w:cantSplit\s*\/>/i.test(xml)) xml = xml.replace(/<w:trPr>/i, "<w:trPr><w:cantSplit/>");
  } else {
    xml = xml.replace(/^(<w:tr\b[^>]*>)/, "$1<w:trPr><w:cantSplit/></w:trPr>");
  }
  if (keepWithNext) xml = addKeepNextToParagraphs(xml);
  return xml;
}

/**
 * @param {string} rowXml
 * @param {import('./topicSlipData.js').TopicSlip} slip
 * @param {boolean} keepWithNext - glue this row to the following row (keeps the table whole)
 */
function fillSlipRow(rowXml, slip, keepWithNext) {
  let xml = replaceTopicCell(rowXml, slip.topic, slip.infoSlide);
  xml = xml.replace(/EXMPL 1/g, escapeXml(slip.team));
  xml = xml.replace(/Novice/g, escapeXml(slip.division));
  xml = replaceBoldAfterLabel(xml, "PREP ROOM: ", slip.prepRoom || "—");
  xml = replaceBoldAfterLabel(xml, "DEBATE ROOM: ", slip.debateRoom || "—");
  xml = replaceBoldAfterLabel(xml, "SIDE: ", slip.side);
  return setRowKeep(xml, keepWithNext);
}

/**
 * @param {string} docXml
 */
function extractRowTemplates(docXml) {
  const tblM = docXml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/);
  if (!tblM) throw new Error("Template table not found.");
  const tbl = tblM[0];
  const rows = [...tbl.matchAll(/<w:tr[\s\S]*?<\/w:tr>/g)].map((m) => m[0]);
  if (rows.length < 2) throw new Error("Template needs two slip rows (AFF and NEG).");
  // Keep the template's table properties as-is (normal margins + its own indent/borders).
  const tblPr = tbl.match(/<w:tblPr>[\s\S]*?<\/w:tblPr>/)?.[0] || "";
  const gridCols = tbl.match(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/)?.[0] || "";
  return { affRow: rows[0], negRow: rows[1], tblPr, gridCols };
}

function buildTableXml(tblPr, gridCols, rowXmlList) {
  return `<w:tbl>${tblPr}${gridCols}${rowXmlList.join("")}</w:tbl>`;
}

// A blank paragraph keeps adjacent tables from merging and gives a small gap + page-break point.
const SPACER_PARA = '<w:p><w:pPr><w:spacing w:before="0" w:after="120" w:line="240" w:lineRule="auto"/></w:pPr></w:p>';

/**
 * @param {import('./topicSlipData.js').TopicSlip[]} slips
 */
export async function buildTopicSlipDocx(slips) {
  const mod = await import("https://esm.sh/pizzip@3.1.7");
  const PizZip = mod.default;

  const res = await fetch(TEMPLATE_URL);
  if (!res.ok) throw new Error(`Could not load template (${TEMPLATE_URL}). Serve over HTTP.`);
  const buf = await res.arrayBuffer();
  const zip = new PizZip(buf);

  let docXml = zip.file("word/document.xml").asText();
  const { affRow, negRow, tblPr, gridCols } = extractRowTemplates(docXml);

  const pages = slipsToPages(slips);
  const blocks = [];
  for (const { aff, neg } of pages) {
    const rows = [];
    if (aff.side === "AFF") {
      rows.push(fillSlipRow(affRow, aff, !!neg));
      if (neg) rows.push(fillSlipRow(negRow, neg, false));
    } else {
      rows.push(fillSlipRow(negRow, aff, false));
    }
    // Each debate is its own table; the spacer keeps consecutive tables separate
    // and lets the table flow to the next page (cantSplit + keepNext) without clipping.
    blocks.push(buildTableXml(tblPr, gridCols, rows));
    blocks.push(SPACER_PARA);
  }

  const bodyContent = blocks.join("");
  docXml = docXml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>(\s*<w:p\b[\s\S]*?<\/w:p>)?/, bodyContent);

  zip.file("word/document.xml", docXml);
  return zip.generate({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

export async function downloadTopicSlipDocx(slips, filename) {
  const blob = await buildTopicSlipDocx(slips);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith(".docx") ? filename : `${filename}.docx`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function slipBlockHtml(slip) {
  const divClass =
    slip.division === "Novice" ? "div-nov" : slip.division === "Junior" ? "div-jnr" : slip.division === "Senior" ? "div-snr" : "";
  return `<div class="slip-half">
    <table class="slip-inner"><tr>
      <td class="slip-topic">
        <p class="lbl">TOPIC:</p>
        <div class="val">${escapeHtml(slip.topic || " ")}</div>
        <p class="lbl">INFO SLIDE:</p>
        <div class="val">${escapeHtml(slip.infoSlide || " ")}</div>
      </td>
      <td class="slip-logo">
        <img src="${LOGO_URL}" alt="WADL" width="72" height="54" />
        <p class="slip-div ${divClass}">${escapeXml(slip.division)} Division</p>
      </td>
      <td class="slip-meta">
        <p><span class="lbl">TEAM:</span> <strong>${escapeXml(slip.team)}</strong></p>
        <p><span class="lbl">SIDE:</span> <strong>${escapeXml(slip.side)}</strong></p>
        <p><span class="lbl">PREP ROOM:</span> <strong>${escapeXml(slip.prepRoom || "—")}</strong></p>
        <p><span class="lbl">DEBATE ROOM:</span> <strong>${escapeXml(slip.debateRoom)}</strong></p>
        <p class="slip-ts">${escapeXml(slip.timeslot)}</p>
      </td>
    </tr></table>
  </div>`;
}

/**
 * @param {import('./topicSlipData.js').TopicSlip[]} slips
 * @param {{ venueTitle?: string, roundLabel?: string }} meta
 */
export function buildTopicSlipPrintHtml(slips, meta = {}) {
  const title = escapeXml(meta.venueTitle || "WADL topic slips");
  const pageHtml = buildPagesInnerHtml(slips);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>${title}</title>
<style>
@page { size: A4 portrait; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font-family: Georgia, "Times New Roman", serif; color: #111; }
.pdf-page {
  width: 210mm;
  height: 297mm;
  margin: 0;
  padding: 0;
  overflow: hidden;
  page-break-after: always;
  break-after: page;
  display: flex;
  flex-direction: column;
}
.pdf-page:last-child { page-break-after: auto; break-after: auto; }
.slip-half {
  flex: 0 0 50%;
  height: 148.5mm;
  max-height: 148.5mm;
  overflow: hidden;
  border-bottom: 2px solid #000;
}
.slip-half:last-child { border-bottom: none; }
table.slip-inner {
  width: 100%;
  height: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
table.slip-inner td {
  border: 2px solid #000;
  vertical-align: top;
  padding: 4mm;
  font-size: 10pt;
  line-height: 1.35;
}
.slip-topic { width: 52%; }
.slip-logo { width: 18%; text-align: center; }
.slip-meta { width: 30%; font-size: 9pt; }
.slip-topic .lbl { font-size: 11pt; margin: 0 0 1mm; }
.slip-topic .val { margin: 0 0 3mm; font-size: 10pt; line-height: 1.3; max-height: 38mm; overflow: hidden; }
.slip-logo img { display: block; margin: 0 auto 2mm; }
.slip-div { margin: 0; font-size: 10pt; text-align: center; }
.slip-div.div-nov { color: #1b5e20; }
.slip-div.div-jnr { color: #5d4037; }
.slip-div.div-snr { color: #4527a0; }
.slip-meta p { margin: 0 0 2mm; }
.slip-ts { color: #555; font-size: 8pt; }
</style>
</head>
<body>
${pageHtml}
</body>
</html>`;
}

/**
 * @param {import('./topicSlipData.js').TopicSlip[]} slips
 * @param {string} filename
 * @param {{ venueTitle?: string, roundLabel?: string }} meta
 */
function buildPagesInnerHtml(slips) {
  return slipsToPages(slips)
    .map((p) => {
      const halves = [slipBlockHtml(p.aff)];
      if (p.neg) halves.push(slipBlockHtml(p.neg));
      return `<div class="pdf-page">${halves.join("")}</div>`;
    })
    .join("");
}

export async function downloadTopicSlipPdf(slips, filename, _meta = {}) {
  const host = document.createElement("div");
  host.className = "topic-slip-pdf-host";
  const pageW = 794;
  const pageH = 1123;
  host.style.cssText = `position:fixed;left:0;top:0;z-index:-1;opacity:0;pointer-events:none;width:${pageW}px;background:#fff;`;
  host.innerHTML = `<style>
    .topic-slip-pdf-host .pdf-page { width:${pageW}px;height:${pageH}px;display:flex;flex-direction:column;background:#fff; }
    .topic-slip-pdf-host .slip-half { flex:0 0 ${pageH / 2}px;height:${pageH / 2}px;overflow:hidden;border-bottom:2px solid #000;box-sizing:border-box; }
    .topic-slip-pdf-host .slip-half:last-child { border-bottom:none; }
    .topic-slip-pdf-host table.slip-inner { width:100%;height:100%;border-collapse:collapse;table-layout:fixed; }
    .topic-slip-pdf-host table.slip-inner td { border:2px solid #000;padding:14px;font:13px Georgia,"Times New Roman",serif;vertical-align:top;line-height:1.35; }
    .topic-slip-pdf-host .slip-topic { width:52%; } .topic-slip-pdf-host .slip-logo { width:18%;text-align:center; }
    .topic-slip-pdf-host .slip-meta { width:30%;font-size:11px; }
    .topic-slip-pdf-host .slip-topic .lbl { font-size:14px;margin:0 0 4px; }
    .topic-slip-pdf-host .slip-topic .val { margin:0 0 10px;font-size:13px;max-height:140px;overflow:hidden; }
    .topic-slip-pdf-host .slip-div.div-nov { color:#1b5e20; } .topic-slip-pdf-host .slip-div.div-jnr { color:#5d4037; }
    .topic-slip-pdf-host .slip-div.div-snr { color:#4527a0; }
  </style>${buildPagesInnerHtml(slips)}`;
  document.body.appendChild(host);

  try {
    const pages = host.querySelectorAll(".pdf-page");
    if (!pages.length) throw new Error("No pages to export.");

    const { jsPDF } = await import("https://esm.sh/jspdf@2.5.2");
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const html2canvas = (await import("https://esm.sh/html2canvas@1.4.1")).default;

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      page.style.width = `${pageW}px`;
      page.style.height = `${pageH}px`;
      const canvas = await html2canvas(page, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        logging: false,
        width: pageW,
        height: pageH,
        windowWidth: pageW,
        windowHeight: pageH,
      });
      const img = canvas.toDataURL("image/jpeg", 0.92);
      if (i > 0) pdf.addPage();
      pdf.addImage(img, "JPEG", 0, 0, 210, 297);
    }

    const name = filename.endsWith(".pdf") ? filename : `${filename}.pdf`;
    pdf.save(name);
  } finally {
    document.body.removeChild(host);
  }
}

/**
 * @param {import('./topicSlipData.js').TopicSlip[]} slips
 * @param {{ venueTitle?: string, roundLabel?: string }} meta
 */
export function openTopicSlipPrintWindow(slips, meta = {}) {
  const html = buildTopicSlipPrintHtml(slips, meta);
  const w = window.open("", "_blank");
  if (!w) throw new Error("Pop-up blocked — allow pop-ups to print or save PDF.");
  w.document.write(html);
  w.document.close();
}
