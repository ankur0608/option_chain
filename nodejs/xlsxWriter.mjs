/**
 * Zero-dependency Excel (.xlsx) and CSV writers for Node.js.
 * Builds a standard Office Open XML .xlsx archive using built-in node:zlib.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const COLUMNS = [
  { key: "ce_vol", title: "VOLUME", kind: "int" },
  { key: "ce_iv", title: "IV", kind: "dec" },
  { key: "strike", title: "STRIKE", kind: "strike" },
  { key: "diff_oi", title: "DIFF OF OI", kind: "int" },
  { key: "pe_iv", title: "IV", kind: "dec" },
  { key: "pe_vol", title: "VOLUME", kind: "int" },
];

const COL_WIDTHS = [
  12, 8,
  13, 14,
  8, 12,
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const rawBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const compressed = zlib.deflateRawSync(rawBuf);
    const crc = crc32(rawBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function colLetter(idx) {
  let n = idx;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function cellRef(row, col) {
  return `${colLetter(col)}${row}`;
}

function xmlStrCell(row, col, value, style) {
  return `<c r="${cellRef(row, col)}" t="inlineStr" s="${style}"><is><t>${escapeXml(value)}</t></is></c>`;
}

function xmlNumCell(row, col, value, style) {
  const ref = cellRef(row, col);
  if (value === null || value === undefined) {
    return `<c r="${ref}" t="inlineStr" s="${style}"><is><t>-</t></is></c>`;
  }
  return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
}

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="3">
    <numFmt numFmtId="164" formatCode="#,##0"/>
    <numFmt numFmtId="165" formatCode="#,##0.00"/>
    <numFmt numFmtId="166" formatCode="0.00"/>
  </numFmts>
  <fonts count="3">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FF1F3864"/><name val="Calibri"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD9E1F2"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFD9D9D9"/></left>
      <right style="thin"><color rgb="FFD9D9D9"/></right>
      <top style="thin"><color rgb="FFD9D9D9"/></top>
      <bottom style="thin"><color rgb="FFD9D9D9"/></bottom>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="12">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="165" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="164" fontId="2" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="2" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="2" fillId="4" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="165" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="164" fontId="2" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
  </cellXfs>
</styleSheet>`;
}

function buildSheetXml(snapshot, updatedAt) {
  const rowsXml = [];

  const r1 = [
    xmlStrCell(1, 1, "Symbol", 2),
    xmlStrCell(1, 2, snapshot.symbol, 9),
    xmlStrCell(1, 3, "Expiry", 2),
    xmlStrCell(1, 4, snapshot.expiry, 9),
    xmlStrCell(1, 5, "Spot Price", 2),
    xmlNumCell(1, 6, snapshot.underlyingValue, 10),
    xmlStrCell(1, 7, "NSE Time", 2),
    xmlStrCell(1, 8, snapshot.timestamp || "-", 9),
    xmlStrCell(1, 10, "Last Sync", 2),
    xmlStrCell(1, 11, updatedAt, 9),
  ];
  rowsXml.push(`<row r="1" ht="20" customHeight="1">${r1.join("")}</row>`);

  const r2 = [
    xmlStrCell(2, 1, "Total CE OI", 2),
    xmlNumCell(2, 2, snapshot.totalCeOi, 11),
    xmlStrCell(2, 3, "Total PE OI", 2),
    xmlNumCell(2, 4, snapshot.totalPeOi, 11),
    xmlStrCell(2, 5, "PCR (PE/CE)", 2),
    xmlNumCell(2, 6, snapshot.pcr, 10),
    xmlStrCell(2, 7, "Total CE Vol", 2),
    xmlNumCell(2, 8, snapshot.totalCeVol, 11),
    xmlStrCell(2, 9, "Total PE Vol", 2),
    xmlNumCell(2, 10, snapshot.totalPeVol, 11),
  ];
  rowsXml.push(`<row r="2" ht="20" customHeight="1">${r2.join("")}</row>`);

  const r4 = [];
  for (let c = 1; c <= 2; c += 1) {
    r4.push(xmlStrCell(4, c, c === 1 ? "CALLS" : "", 1));
  }
  r4.push(xmlStrCell(4, 3, "STRIKE", 1));
  r4.push(xmlStrCell(4, 4, "DIFF OF OI", 1));
  for (let c = 5; c <= 6; c += 1) {
    r4.push(xmlStrCell(4, c, c === 5 ? "PUTS" : "", 1));
  }
  rowsXml.push(`<row r="4" ht="22" customHeight="1">${r4.join("")}</row>`);

  const r5 = COLUMNS.map((col, idx) => xmlStrCell(5, idx + 1, col.title, 1));
  rowsXml.push(`<row r="5" ht="22" customHeight="1">${r5.join("")}</row>`);

  let atmStrike = snapshot.closestStrike ?? null;
  if (atmStrike === null && snapshot.underlyingValue !== null && snapshot.rows.length > 0) {
    let bestDiff = Infinity;
    for (const row of snapshot.rows) {
      const diff = Math.abs(Number(row.strike) - Number(snapshot.underlyingValue));
      if (diff < bestDiff) {
        bestDiff = diff;
        atmStrike = Number(row.strike);
      }
    }
  }

  snapshot.rows.forEach((rowData, idx) => {
    const excelRow = idx + 6;
    const strikeNum = Number(rowData.strike);
    const isAtm = atmStrike !== null && strikeNum === atmStrike;
    const isCeItm = atmStrike !== null && strikeNum <= atmStrike;
    const isPeItm = atmStrike !== null && strikeNum > atmStrike;
    const cells = COLUMNS.map((col, colIdx) => {
      const shaded =
        (colIdx < 2 && isCeItm) || (colIdx > 3 && isPeItm) || (col.kind === "strike" && isAtm);
      let style = 5;
      if (col.kind === "strike") style = shaded ? 8 : 3;
      else if (col.kind === "int") style = shaded ? 6 : 4;
      else style = shaded ? 7 : 5;
      return xmlNumCell(excelRow, colIdx + 1, rowData[col.key], style);
    });
    rowsXml.push(`<row r="${excelRow}">${cells.join("")}</row>`);
  });

  const colsXml = COL_WIDTHS.map(
    (w, idx) => `<col min="${idx + 1}" max="${idx + 1}" width="${w}" customWidth="1"/>`
  ).join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView workbookViewId="0">
      <pane ySplit="5" topLeftCell="A6" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${colsXml}</cols>
  <sheetData>${rowsXml.join("")}</sheetData>
  <mergeCells count="3">
    <mergeCell ref="A4:B4"/>
    <mergeCell ref="E4:F4"/>
    <mergeCell ref="H1:I1"/>
  </mergeCells>
</worksheet>`;
}

export function buildXlsxBuffer(snapshot) {
  const updatedAt = new Date().toLocaleString("en-IN", { hour12: false });

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Option Chain" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return buildZip([
    { name: "[Content_Types].xml", content: contentTypes },
    { name: "_rels/.rels", content: rootRels },
    { name: "xl/workbook.xml", content: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRels },
    { name: "xl/styles.xml", content: buildStylesXml() },
    { name: "xl/worksheets/sheet1.xml", content: buildSheetXml(snapshot, updatedAt) },
  ]);
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

export function buildCsvString(snapshot) {
  const lines = [];
  lines.push(
    [
      "Symbol",
      snapshot.symbol,
      "Expiry",
      snapshot.expiry,
      "Spot",
      snapshot.underlyingValue,
      "NSE Timestamp",
      snapshot.timestamp,
      "PCR",
      snapshot.pcr,
    ]
      .map(csvEscape)
      .join(",")
  );
  const headers = COLUMNS.map((col, idx) =>
    idx < 2 ? `CE_${col.title}` : idx === 2 ? "STRIKE" : idx === 3 ? col.title : `PE_${col.title}`
  );
  lines.push(headers.map(csvEscape).join(","));
  for (const row of snapshot.rows) {
    lines.push(COLUMNS.map((col) => csvEscape(row[col.key])).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function atomicWrite(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(tmpPath, data, { mode: 0o644 });
  fs.renameSync(tmpPath, targetPath);
}

export function writeXlsx(snapshot, outputPath) {
  atomicWrite(outputPath, buildXlsxBuffer(snapshot));
}

export function writeCsv(snapshot, outputPath) {
  atomicWrite(outputPath, buildCsvString(snapshot));
}
