/**
 * A CSV reader that handles quoting.
 *
 * The temptation with a data file is to split on commas and move on. These
 * files carry player names, and player names carry commas and quotes -- a
 * naive split silently shifts every column after the first "Smith, Jr." and
 * produces a table that looks fine and is wrong.
 */

export type Row = Record<string, string>;

export function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows;
  if (!header) return [];
  return body
    .filter((r) => r.length > 1)
    .map((r) => {
      const obj: Row = {};
      header.forEach((key, i) => (obj[key] = r[i] ?? ""));
      return obj;
    });
}

/** Numeric cell, treating nflverse's "NA" and empty strings as absent. */
export function num(value: string | undefined): number | undefined {
  if (value === undefined || value === "" || value === "NA" || value === "null") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
