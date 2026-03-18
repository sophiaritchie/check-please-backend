import csv
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from supabase import create_client
from dotenv import load_dotenv

load_dotenv()

supabase = create_client(
    os.getenv("SUPABASE_URL", ""),
    os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""),
)


DATE_PATTERN = r'\b(\d{1,2}-[A-Za-z]{3}-\d{2})\b'
MELB_TZ = ZoneInfo("Australia/Melbourne")


def advance_date_in_text(text):
    """Find a date like '11-Mar-26' in the text and replace it with the next day."""
    match = re.search(DATE_PATTERN, text)
    if not match:
        return text
    original = match.group(1)
    try:
        dt = datetime.strptime(original, "%d-%b-%y")
        nd = dt + timedelta(days=1)
        next_day_str = f"{nd.day}-{nd.strftime('%b-%y')}"
        return text.replace(original, next_day_str, 1)
    except ValueError:
        return text


def mt_send_after(text):
    """Return send_after UTC ISO string: next day after the date in the text, 12pm Melbourne time."""
    match = re.search(DATE_PATTERN, text)
    if not match:
        return None
    try:
        dt = datetime.strptime(match.group(1), "%d-%b-%y")
        nd = dt + timedelta(days=1)
        melb_noon = datetime(nd.year, nd.month, nd.day, 12, 0, 0, tzinfo=MELB_TZ)
        return melb_noon.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def determine_priority(sf_type, text):
    """Priority: 2=Contact, 1=Lead full text, 0=Lead with 'market taster'."""
    if sf_type.strip().lower() == "contact":
        return 2
    if "market taster" in text.lower():
        return 0
    return 1



def normalize_phone(phone_number):
    """Strip non-digits, remove leading 0 / +61 / 61 prefix, add country code."""
    phone_number = re.sub("[^0-9]", "", phone_number)
    if phone_number == "0":
        return None
    if phone_number.startswith("0"):
        phone_number = phone_number[1:]
    if phone_number.startswith("61"):
        phone_number = phone_number[2:]
    return os.getenv("COUNTRY_CODE", "") + phone_number


def main():
    if len(sys.argv) < 2:
        print("Usage: python weekly-texts-script.py ./macey.csv")
        sys.exit(1)

    csv_path = sys.argv[1]
    messages_to_insert = []
    errors = []

    with open(csv_path, newline="") as csvfile:
        texts = csv.reader(csvfile, delimiter=",")
        text_string = ""
        phone_number = ""
        sf_id = ""
        sf_type = ""

        for row in texts:
            try:
                if phone_number == "":
                    phone_number = row[1]
                    sf_id = row[2]
                    sf_type = row[3]
            except Exception:
                pass

            if row[0].find("------") == -1:
                text_string += row[0] + "\n"
            else:
                if text_string and text_string[0] == "\n":
                    text_string = text_string[1 : (len(text_string) - 1)]

                normalized = normalize_phone(phone_number)
                if normalized is None:
                    text_string = ""
                    phone_number = ""
                    sf_id = ""
                    sf_type = ""
                    continue

                if normalized == os.getenv("COUNTRY_CODE", "") + "11123123123":
                    normalized = os.getenv("TEST_NUMBER", "")

                if text_string.count("Commodity Market Update") > 1:
                    errors.append(
                        f"Separator missing, multiple texts in one for {phone_number}"
                    )
                    text_string = ""
                    phone_number = ""
                    sf_id = ""
                    sf_type = ""
                    continue

                is_mt = sf_type.strip().lower() == "lead" and "market taster" in text_string.lower()
                if is_mt:
                    send_after = mt_send_after(text_string) or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                    text_string = advance_date_in_text(text_string)
                else:
                    send_after = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

                priority = determine_priority(sf_type, text_string)

                messages_to_insert.append(
                    {
                        "from_number": os.getenv("DIALPAD_FROM_NUMBER", ""),
                        "to_numbers": [normalized],
                        "text": text_string,
                        "message_status": "queued",
                        "sf_id": sf_id.strip(),
                        "sf_type": sf_type.strip(),
                        "priority": priority,
                        "send_after": send_after,
                    }
                )

                text_string = ""
                phone_number = ""
                sf_id = ""
                sf_type = ""

    if not messages_to_insert:
        print("No messages to queue.")
        return

    result = supabase.table("messages").insert(messages_to_insert).execute()
    print(f"Queued {len(messages_to_insert)} messages.")

    if errors:
        print("Errors encountered:")
        for err in errors:
            print(f"  - {err}")


if __name__ == "__main__":
    main()
