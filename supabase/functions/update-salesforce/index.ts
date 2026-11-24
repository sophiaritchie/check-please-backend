// NOTE: kept the "update-salesforce" name so the existing Postgres trigger
// (trg_salesforce_update -> /functions/v1/update-salesforce) keeps working without
// a DB migration. Salesforce is retired; this now stamps the first-text date onto
// the "farmers db" Google Sheet (the CRM system of record behind AppSheet).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const GOOGLE_SERVICE_ACCOUNT_JSON = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
const FARMERS_DB_ID = Deno.env.get("FARMERS_DB_ID");

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { message_id } = await req.json();

  if (!message_id) {
    return jsonResponse({ error: "Missing message_id" }, 400);
  }

  const { data: msg, error } = await supabase
    .from("messages")
    .select("sf_type, sf_id")
    .eq("id", message_id)
    .single();

  if (error || !msg) {
    console.error("Failed to fetch message:", error);
    return jsonResponse({ error: "Message not found" }, 404);
  }

  if (!msg.sf_type || !msg.sf_id) {
    console.log("No CRM fields on message, skipping");
    return jsonResponse({ ok: true, skipped: true });
  }

  await updateSheetFirstTextDate(msg.sf_type, msg.sf_id);
  return jsonResponse({ ok: true, sf_id: msg.sf_id, sf_type: msg.sf_type });
});

// --- Google Sheets auth ---------------------------------------------------

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function getGoogleAccessToken(): Promise<string | null> {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.log("Skipping update — missing GOOGLE_SERVICE_ACCOUNT_JSON");
    return null;
  }

  const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const key = await importPrivateKey(sa.private_key);

  const assertion = await create(
    { alg: "RS256", typ: "JWT" },
    {
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    },
    key,
  );

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!resp.ok) {
    console.error("Google token exchange failed:", await resp.text());
    return null;
  }
  const data = await resp.json();
  return data.access_token ?? null;
}

// --- Sheet write ----------------------------------------------------------

function colLetter(index0: number): string {
  // 0-based column index -> A1 column letters (0 -> A, 26 -> AA)
  let n = index0 + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function updateSheetFirstTextDate(sfType: string, sfId: string): Promise<void> {
  try {
    if (!FARMERS_DB_ID) {
      console.log("Skipping update — missing FARMERS_DB_ID");
      return;
    }

    const token = await getGoogleAccessToken();
    if (!token) return;

    const tab = sfType.trim().toLowerCase() === "contact" ? "Contacts" : "Leads";
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${FARMERS_DB_ID}`;

    // Read the whole tab (header row + data).
    const getResp = await fetch(
      `${base}/values/${encodeURIComponent(tab)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!getResp.ok) {
      console.error("Sheet read failed:", await getResp.text());
      return;
    }

    const { values } = await getResp.json();
    if (!values || values.length === 0) {
      console.error(`Sheet tab '${tab}' is empty`);
      return;
    }

    const header: string[] = values[0];
    const idCol = header.indexOf("Id");
    const x1stCol = header.indexOf("X1st_Text_Date__c");
    const origCol = header.indexOf("Original_1st_Text_Date__c");
    const subResultCol = header.indexOf("Subscribe_Result__c");
    if (idCol === -1 || x1stCol === -1) {
      console.error("Required columns (Id / X1st_Text_Date__c) not found in header");
      return;
    }

    let rowIndex = -1; // 0-based index into `values` (row 0 is the header)
    for (let i = 1; i < values.length; i++) {
      if ((values[i][idCol] ?? "") === sfId) {
        rowIndex = i;
        break;
      }
    }
    if (rowIndex === -1) {
      console.log(`No sheet row for ${tab} Id ${sfId}`);
      return;
    }

    const row = values[rowIndex];
    const sheetRow = rowIndex + 1; // 1-based sheet row number

    // Stamp the first-text date on the first delivery only. On later deliveries this
    // is a no-op, but we must NOT early-return here: the Market Taster check below
    // has to re-run on deliveries #2..#5+ to promote the lead on their 5th text.
    if (!row[x1stCol]) {
      // Date only, in Melbourne time, matching the sheet's yyyy-mm-dd date columns.
      const now = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });

      // Only set Original_1st_Text_Date__c if it too is empty (matches old guard).
      const data: { range: string; values: string[][] }[] = [
        { range: `${tab}!${colLetter(x1stCol)}${sheetRow}`, values: [[now]] },
      ];
      if (origCol !== -1 && !row[origCol]) {
        data.push({ range: `${tab}!${colLetter(origCol)}${sheetRow}`, values: [[now]] });
      }

      const patchResp = await fetch(`${base}/values:batchUpdate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        // USER_ENTERED so the string is parsed into a real date, like the existing values.
        body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
      });

      if (!patchResp.ok) {
        console.error("Sheet update failed:", await patchResp.text());
      } else {
        console.log(`${tab} ${sfId} first text date written to sheet`);
      }
    } else {
      console.log(`${tab} ${sfId} already has a first text date`);
    }

    // Leads only: promote Trial -> Market Taster once the lead has received their
    // 5th weekly text. Contacts use Subscription_Type__c and are never touched here.
    if (tab === "Leads") {
      await maybePromoteToMarketTaster(base, token, tab, sheetRow, subResultCol, row, sfId);
    }
  } catch (err) {
    console.error("Sheet update error:", err);
  }
}

// --- Trial -> Market Taster promotion -------------------------------------
//
// A new lead gets a free trial of 4 weekly texts while Subscribe_Result__c = "Trial".
// From the 5th weekly text onward they become "Market Taster" (the free ongoing taster
// tier). The boundary is strict: the 4th text must NOT flip; the 5th must.
//
// Counting signal: this function is invoked by the Postgres trigger once per message
// that reaches `delivered`, and every weekly text to a lead is a `messages` row carrying
// that lead's sf_id — the same event that stamps X1st_Text_Date__c on delivery #1. So the
// number of delivered `messages` rows for this sf_id IS the number of weekly texts the lead
// has received. We flip when that count reaches 5. This exact per-lead count is preferred
// over counting Wednesdays from X1st_Text_Date__c, which overcounts if a weekly send was
// ever skipped and would then flip a lead early.
async function maybePromoteToMarketTaster(
  base: string,
  token: string,
  tab: string,
  sheetRow: number,
  subResultCol: number,
  row: string[],
  sfId: string,
): Promise<void> {
  if (subResultCol === -1) {
    console.log("Subscribe_Result__c column not found — skipping Market Taster check");
    return;
  }

  // Idempotent + safe: only ever promote a row whose current status is exactly "Trial"
  // (case/space-insensitive). Never touch "Opted Out", "Paused", blank, or already
  // "Market Taster".
  const current = (row[subResultCol] ?? "").trim().toLowerCase();
  if (current !== "trial") {
    return;
  }

  // Count weekly texts delivered to this lead (one delivered message per weekly text).
  const { count, error } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("sf_id", sfId)
    .eq("message_status", "delivered");

  if (error) {
    // Safe default: never promote on uncertain data.
    console.error(`Failed to count delivered texts for ${sfId}:`, error);
    return;
  }

  const textsReceived = count ?? 0;
  // First 4 weekly texts stay "Trial"; promote from the 5th onward.
  if (textsReceived < 5) {
    console.log(`Lead ${sfId} has received ${textsReceived} text(s) — staying Trial`);
    return;
  }

  const patchResp = await fetch(`${base}/values:batchUpdate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data: [
        { range: `${tab}!${colLetter(subResultCol)}${sheetRow}`, values: [["Market Taster"]] },
      ],
    }),
  });

  if (!patchResp.ok) {
    console.error("Market Taster update failed:", await patchResp.text());
  } else {
    console.log(`Lead ${sfId} promoted to Market Taster on text #${textsReceived}`);
  }
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
