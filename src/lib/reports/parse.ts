// =============================================================================
//  Stage 1: parse — bytes in, RawTable[] out.
//
//  This stage is deliberately dumb. It answers exactly one question: what grids
//  of text were in the files the user dropped? Every cell stays a raw string,
//  because the moment parsing guesses ("$1,928.00" is a number, "-" is zero)
//  the original is gone and no later stage can recover it. coerce.ts owns
//  meaning; this file owns fidelity.
//
//  Three input shapes, one output shape:
//    .xlsx           → one RawTable per non-empty sheet (sheetName = sheet)
//    flat .csv       → one RawTable (sheetName = null)
//    Infloww .csv    → one RawTable per section, e.g.
//                        Ember 🔥(2365406295883784): Table 1
//                        Tracking link,Date created,Clicks,...
//                        <data rows>
//                      (sheetName = the model name, so grouping survives)
//
//  CSV text goes through tracking.ts's parseCsv — the quoted-field handling
//  there is already load-bearing (the "Creators" column is a quoted, comma-
//  separated list), and a second CSV parser would be a second set of bugs.
// =============================================================================

import * as XLSX from 'xlsx';
import { parseCsv, isSectionHeader, extractModelName } from '../tracking';
import type { RawTable } from './types';

// The formats this pipeline can actually read. Everything else must be
// rejected BEFORE parsing: the file picker filters to these, but drag-and-drop
// bypasses the picker, and a PDF fed through the CSV path becomes rows of
// binary garbage whose profile is large enough to kill the AI request in
// flight. That is a real failure mode observed in production, not paranoia.
export function isSupportedUpload(name: string): boolean {
  return /\.(xlsx?|csv)$/i.test(name);
}

export async function parseUpload(
  files: { name: string; bytes: ArrayBuffer }[],
): Promise<RawTable[]> {
  const out: RawTable[] = [];
  // Ids must be unique across the whole upload, and two dropped files can
  // share a name (same export pulled from two folders). Disambiguate the
  // basename once, so every table from a file keeps a consistent prefix.
  const usedBases = new Set<string>();

  for (const file of files) {
    if (!isSupportedUpload(file.name)) {
      throw new Error(
        `"${file.name}" is not a spreadsheet. This report reads Excel (.xlsx) and ` +
        `CSV exports — remove this file, or re-export the data from Infloww as Excel.`,
      );
    }

    const raw = basename(file.name);
    let base = raw;
    for (let n = 2; usedBases.has(base); n++) base = `${raw} (${n})`;
    usedBases.add(base);

    const blocks = /\.xlsx?$/i.test(file.name)
      ? readWorkbook(file.bytes)
      : readCsv(file.bytes);

    let index = 0;
    for (const block of blocks) {
      const table = toRawTable(block.grid);
      if (!table) continue; // fully-empty sheet / section
      out.push({
        id: `${base}#${index++}`,
        sourceFile: file.name,
        sheetName: block.sheetName,
        ...table,
      });
    }
  }

  return out;
}

// A grid plus where it came from, before empty-trimming decides if it survives.
type Block = { sheetName: string | null; grid: string[][] };

// =============================================================================
//  Readers
// =============================================================================

function readWorkbook(bytes: ArrayBuffer): Block[] {
  const wb = XLSX.read(new Uint8Array(bytes), { type: 'array' });
  return wb.SheetNames.map((sheetName) => {
    const ws = wb.Sheets[sheetName];
    if (!ws) return { sheetName, grid: [] };
    // raw:false gives the cell as displayed ("$1,928.00", "41.67%"), which is
    // the same text the CSV export carries — so downstream sees one dialect.
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: true,
    });
    return {
      sheetName,
      grid: grid.map((row) => row.map((cell) => (cell == null ? '' : String(cell)))),
    };
  });
}

function readCsv(bytes: ArrayBuffer): Block[] {
  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const grid = parseCsv(text);

  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const row of grid) {
    if (isSectionHeader(row)) {
      current = { sheetName: extractModelName(row[0] ?? ''), grid: [] };
      blocks.push(current);
      continue;
    }
    if (!current) {
      // Rows before any section header — a flat CSV, or a preamble.
      current = { sheetName: null, grid: [] };
      blocks.push(current);
    }
    current.grid.push(row);
  }
  return blocks;
}

// =============================================================================
//  Trimming — a grid becomes a table, or nothing at all
// =============================================================================

function toRawTable(grid: string[][]): Pick<RawTable, 'headers' | 'rows'> | null {
  const rows = trimEmptyRows(grid);
  if (rows.length === 0) return null;

  // Width = the last column anyone actually filled in, so trailing empty
  // columns disappear. Rows are then padded to that width; a ragged grid
  // would make every downstream index lookup conditional.
  const width = Math.max(...rows.map(lastFilled));
  if (width === 0) return null;
  const rect = rows.map((row) =>
    Array.from({ length: width }, (_, i) => row[i] ?? ''),
  );

  // Values are left exactly as they were read. Headers are labels, not data,
  // so those get trimmed.
  const headerRow = rect[0]!;
  return {
    // A blank header cell is a real column with a missing label, not a column
    // to drop — its values still matter, so give it a positional name.
    headers: headerRow.map((h, i) => h.trim() || `Column ${i + 1}`),
    rows: rect.slice(1),
  };
}

// Leading empties too: xlsx sheets often start below A1, and a blank first
// row would otherwise be read as the header and rename every column.
function trimEmptyRows(grid: string[][]): string[][] {
  let start = 0;
  let end = grid.length;
  while (start < end && isEmptyRow(grid[start]!)) start++;
  while (end > start && isEmptyRow(grid[end - 1]!)) end--;
  return grid.slice(start, end);
}

function isEmptyRow(row: string[]): boolean {
  return row.every((c) => (c ?? '').trim() === '');
}

// One past the index of the last non-empty cell.
function lastFilled(row: string[]): number {
  for (let i = row.length - 1; i >= 0; i--) {
    if ((row[i] ?? '').trim() !== '') return i + 1;
  }
  return 0;
}

function basename(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? path;
  return file.replace(/\.[^.]+$/, '');
}
