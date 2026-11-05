"""Fill blank X1st_Text_Date__c (and Original_1st_Text_Date__c) in the Farmer DB sheet.

For every Leads/Contacts row whose Id has a delivered message in Supabase but whose
X1st_Text_Date__c is empty, writes the date of that person's earliest delivered text
(Melbourne date). Original_1st_Text_Date__c is only filled when it is also empty.
Existing dates are never overwritten.

People whose earliest delivered text falls on the first day the messages table has data
were probably texted before it existed, so their true first date is unknown. They are
listed but skipped unless --include-unknown is passed.

Dry run by default; pass --apply to write.

Usage:
    python backfill-first-text-dates.py            # preview
    python backfill-first-text-dates.py --apply    # write to the sheet
    python backfill-first-text-dates.py --apply --include-unknown
"""
import argparse
import os
from datetime import datetime
from zoneinfo import ZoneInfo

import pygsheets
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

FARMERS_DB_ID = os.getenv("FARMERS_DB_ID", "1bnFmL2qIP69KudRMbOS5PNXFCaAjeO2gnmgG-tHkCA0")
SERVICE_ACCOUNT_FILE = os.getenv(
    "GOOGLE_SERVICE_ACCOUNT_FILE",
    os.path.expanduser("~/dev/check-please-python-scripts/check-please-vba-project-0888a4d71b4a.json"),
)
TABS = ["Leads", "Contacts"]
MELB_TZ = ZoneInfo("Australia/Melbourne")


def first_delivered_dates():
    """Return {sf_id: 'YYYY-MM-DD'} of each person's earliest delivered text."""
    supabase = create_client(
        os.getenv("SUPABASE_URL", ""),
        os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
    )
    earliest = {}
    page, offset = 1000, 0
    while True:
        rows = (
            supabase.table("messages")
            .select("sf_id, queued_at, last_attempted_at")
            .eq("message_status", "delivered")
            .not_.is_("sf_id", "null")
            .order("queued_at")
            .range(offset, offset + page - 1)
            .execute()
            .data
        )
        for r in rows:
            sf_id = (r["sf_id"] or "").strip()
            sent = r["last_attempted_at"] or r["queued_at"]
            if sf_id and (sf_id not in earliest or sent < earliest[sf_id]):
                earliest[sf_id] = sent
        if len(rows) < page:
            break
        offset += page

    return {
        sf_id: datetime.fromisoformat(ts).astimezone(MELB_TZ).strftime("%Y-%m-%d")
        for sf_id, ts in earliest.items()
    }


def col_letter(index0):
    """0-based column index -> A1 column letters (0 -> A, 26 -> AA)."""
    n, s = index0 + 1, ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        s = chr(65 + rem) + s
    return s


def find_col(header, name):
    wanted = name.strip().lower()
    for i, h in enumerate(header):
        if h.strip().lower() == wanted:
            return i
    return -1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="write to the sheet (default: preview only)")
    parser.add_argument(
        "--include-unknown",
        action="store_true",
        help="also fill people first seen on the first day of message history",
    )
    args = parser.parse_args()

    dates = first_delivered_dates()
    history_start = min(dates.values())
    print(f"{len(dates)} people have a delivered text in Supabase (history starts {history_start}).")

    gc = pygsheets.authorize(service_file=SERVICE_ACCOUNT_FILE)
    sh = gc.open_by_key(FARMERS_DB_ID)

    updates = []
    unknown = []
    for tab in TABS:
        values = sh.worksheet_by_title(tab).get_all_values(
            include_tailing_empty=False, include_tailing_empty_rows=False
        )
        header = values[0]
        id_col = find_col(header, "Id")
        x1st_col = find_col(header, "X1st_Text_Date__c")
        orig_col = find_col(header, "Original_1st_Text_Date__c")
        first_col = find_col(header, "FirstName")
        last_col = find_col(header, "LastName")
        if id_col == -1 or x1st_col == -1:
            raise SystemExit(f"'{tab}' is missing an Id or X1st_Text_Date__c column")

        for sheet_row, row in enumerate(values[1:], start=2):
            get = lambda c: row[c].strip() if 0 <= c < len(row) else ""
            sf_id = get(id_col)
            if sf_id not in dates or get(x1st_col):
                continue
            name = f"{get(first_col)} {get(last_col)}".strip()
            date = dates[sf_id]
            if date == history_start and not args.include_unknown:
                unknown.append(f"  {tab:<8} row {sheet_row:<4} {sf_id:<18} {name}")
                continue
            updates.append({"range": f"{tab}!{col_letter(x1st_col)}{sheet_row}", "values": [[date]]})
            also_orig = orig_col != -1 and not get(orig_col)
            if also_orig:
                updates.append({"range": f"{tab}!{col_letter(orig_col)}{sheet_row}", "values": [[date]]})
            print(f"  {tab:<8} row {sheet_row:<4} {sf_id:<18} {name:<28} {date}{'  (+ Original)' if also_orig else ''}")

    if unknown:
        print(f"\nSkipped {len(unknown)} first seen on {history_start}, when history starts (true first date unknown, see --include-unknown):")
        print("\n".join(unknown))

    if not updates:
        print("Nothing to fill.")
        return

    if not args.apply:
        print("\nPreview only. Re-run with --apply to write these dates.")
        return

    # USER_ENTERED so '2026-08-26' lands as a real date, like the existing values.
    gc.sheet.service.spreadsheets().values().batchUpdate(
        spreadsheetId=FARMERS_DB_ID,
        body={"valueInputOption": "USER_ENTERED", "data": updates},
    ).execute()
    print(f"\nWrote {len(updates)} cells.")


if __name__ == "__main__":
    main()
