// csv.ts — Deterministic CSV parser. No LLM dependency.
//
// Handles RFC 4180 basics: quoted fields, embedded commas, embedded newlines
// in quoted fields. Returns an array of objects keyed by header names.

/**
 * Parse a CSV string into an array of row objects keyed by header names.
 * All values are strings — the caller is responsible for type coercion.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const rows = splitCsvRows(trimmed);
  if (rows.length < 2) return []; // header only or empty

  // rows.length >= 2 is guaranteed above, and the loop indices below are bounded by
  // their array lengths — so these accesses are always present (noUncheckedIndexedAccess
  // types them as possibly-undefined).
  const headers = splitCsvFields(rows[0]!).map(h => h.trim());
  const result: Record<string, string>[] = [];

  for (let i = 1; i < rows.length; i++) {
    const fields = splitCsvFields(rows[i]!);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]!] = (fields[j] ?? '').trim();
    }
    result.push(row);
  }

  return result;
}

/** Split CSV text into rows, respecting quoted fields that span newlines. */
function splitCsvRows(text: string): string[] {
  const rows: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      // Skip \r\n as a single newline
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (current.trim()) rows.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) rows.push(current);

  return rows;
}

/** Split a single CSV row into field values, unquoting as needed. */
function splitCsvFields(row: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') {
        // Escaped quote
        current += '"';
        i++;
      } else {
        // Toggles quote mode. Per RFC 4180, quotes mid-field on unquoted values
        // are non-conformant input — we accept them permissively rather than error.
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);

  return fields;
}
