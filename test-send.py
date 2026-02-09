import json
import os
import requests
from supabase import create_client
from dotenv import load_dotenv
load_dotenv()

supabase = create_client(os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SERVICE_ROLE_KEY", ""))

url = os.getenv("DIALPAD_API_URL", "") + "sms?apikey=" + os.getenv("DIALPAD_API_KEY", "")

payload = json.dumps({
    "from_number": os.getenv("DIALPAD_FROM_NUMBER", ""),
    "infer_country_code": False,
    "text": "Webhook test - please ignore",
    "to_numbers": [os.getenv("TEST_NUMBER", "")],
})

response = requests.post(url, headers={"Content-Type": "application/json", "Accept": "application/json"}, data=payload, timeout=10)
res = response.json()
print("Dialpad response:", json.dumps(res, indent=2))

supabase.table("messages").insert({
    "dialpad_id": res["id"],
    "contact_id": res["contact_id"],
    "created_date": res["created_date"],
    "device_type": res.get("device_type"),
    "direction": res["direction"],
    "from_number": res["from_number"],
    "message_status": res["message_status"],
    "target_id": res.get("target_id"),
    "target_type": res.get("target_type"),
    "text": res.get("text"),
    "to_numbers": res["to_numbers"],
}).execute()

print("Inserted into Supabase. Waiting for webhook to update status...")
