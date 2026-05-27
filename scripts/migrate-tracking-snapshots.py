#!/usr/bin/env python3
# =============================================================================
#  migrate-tracking-snapshots.py
#  One-shot helper for importing the source project's tracking_link_snapshots
#  data into the destination VoltrisAi project's Test Account agency.
#
#  Input:  the CSV file Supabase produced when you ran the "Export as JSON"
#          query (lives in ~/Downloads by default).
#  Output: a single SQL block printed to stdout. Copy that block into the
#          destination Supabase SQL Editor and run it.
#
#  Why this script exists:
#  The Supabase CSV export wraps the JSON column in CSV quoting, which
#  doubles every `"` to `""` and wraps the whole array in an outer `"..."`.
#  Cleaning that by hand on 682 rows is annoying; this script does it
#  losslessly in a couple of lines.
# =============================================================================

import glob
import json
import os
import sys

# Hardcoded — this is your destination Test Account agency. If you ever
# import to a different agency, change this one constant and re-run.
AGENCY_ID = "d7eba5ff-8ddb-4ab3-b9a1-95c01180dc24"

# Default location for the CSV. Override by passing a path on the CLI.
DEFAULT_GLOB = os.path.expanduser(
    "~/Downloads/Supabase Snippet Export tracking_link_snapshots as JSON*.csv"
)


def find_csv() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1]
    matches = sorted(glob.glob(DEFAULT_GLOB), key=os.path.getmtime, reverse=True)
    if not matches:
        print(
            "ERROR: Could not find the snapshot export CSV.\n"
            f"Looked for: {DEFAULT_GLOB}\n"
            "Pass the path explicitly: python3 migrate-tracking-snapshots.py /path/to/file.csv",
            file=sys.stderr,
        )
        sys.exit(1)
    return matches[0]


def extract_json(csv_path: str) -> list:
    with open(csv_path, encoding="utf-8") as f:
        text = f.read()

    # The CSV is: `data\n"<json with "" escapes>"`. Drop the header line,
    # strip the wrapping double quotes around the cell, and undo the
    # CSV-style "" -> " escape. What remains is valid JSON.
    lines = text.split("\n", 1)
    if len(lines) < 2:
        print("ERROR: CSV file looks malformed (no data row).", file=sys.stderr)
        sys.exit(1)
    cell = lines[1].strip()
    if cell.startswith('"') and cell.endswith('"'):
        cell = cell[1:-1]
    cleaned = cell.replace('""', '"')

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"ERROR: Cleaned JSON failed to parse: {e}", file=sys.stderr)
        sys.exit(1)


def build_sql(rows: list) -> str:
    # Re-serialize as compact JSON so the SQL stays as small as possible.
    # Postgres's json_to_recordset will expand it back into typed rows.
    payload = json.dumps(rows, separators=(",", ":"))

    return f"""-- ============================================================
-- Import {len(rows)} tracking_link_snapshots rows into Test Account
-- ============================================================
INSERT INTO tracking_link_snapshots (
  id, agency_id, link_id, recorded_at, clicks, subs, fans_who_spent,
  subscription_cvr, spending_cvr, promo_cost_cents, earnings_cents,
  profit_cents, cpc, epc, cps, aeps, roi, source_csv_uploaded_at
)
SELECT
  x.id,
  '{AGENCY_ID}'::uuid AS agency_id,
  x.link_id,
  x.recorded_at,
  x.clicks,
  x.subs,
  x.fans_who_spent,
  x.subscription_cvr,
  x.spending_cvr,
  x.promo_cost_cents,
  x.earnings_cents,
  x.profit_cents,
  x.cpc,
  x.epc,
  x.cps,
  x.aeps,
  x.roi,
  x.source_csv_uploaded_at
FROM json_to_recordset($JSON${payload}$JSON$) AS x(
  id uuid,
  link_id uuid,
  recorded_at timestamptz,
  clicks integer,
  subs integer,
  fans_who_spent integer,
  subscription_cvr numeric,
  spending_cvr numeric,
  promo_cost_cents integer,
  earnings_cents integer,
  profit_cents integer,
  cpc numeric,
  epc numeric,
  cps numeric,
  aeps numeric,
  roi numeric,
  source_csv_uploaded_at timestamptz
)
ON CONFLICT (id) DO NOTHING;
"""


def main() -> None:
    csv_path = find_csv()
    print(f"# Reading: {csv_path}", file=sys.stderr)
    rows = extract_json(csv_path)
    print(f"# Found {len(rows)} rows", file=sys.stderr)

    out_path = os.path.join(os.path.dirname(__file__), "migrate-snapshots.sql")
    sql = build_sql(rows)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(sql)

    print(f"# Wrote SQL to: {out_path}", file=sys.stderr)
    print(f"# Open it, copy all, paste into Supabase SQL Editor, run.", file=sys.stderr)


if __name__ == "__main__":
    main()
