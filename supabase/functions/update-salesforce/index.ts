import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SF_USERNAME = Deno.env.get("SALESFORCE_USERNAME");
const SF_PASSWORD = Deno.env.get("SALESFORCE_PASSWORD");
const SF_SEC_TOKEN = Deno.env.get("SALESFORCE_SEC_TOKEN");

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
    console.log("No SF fields on message, skipping");
    return jsonResponse({ ok: true, skipped: true });
  }

  await updateSalesforceFirstTextDate(msg.sf_type, msg.sf_id);
  return jsonResponse({ ok: true, sf_id: msg.sf_id, sf_type: msg.sf_type });
});

async function updateSalesforceFirstTextDate(sfType: string, sfId: string): Promise<void> {
  if (!SF_USERNAME || !SF_PASSWORD || !SF_SEC_TOKEN) {
    console.log("Skipping SF update — missing credentials");
    return;
  }

  try {
    const loginResponse = await fetch("https://login.salesforce.com/services/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: Deno.env.get("SALESFORCE_CLIENT_ID") || "",
        client_secret: Deno.env.get("SALESFORCE_CLIENT_SECRET") || "",
        username: SF_USERNAME,
        password: SF_PASSWORD + SF_SEC_TOKEN,
      }),
    });

    if (!loginResponse.ok) {
      console.error("SF login failed:", await loginResponse.text());
      return;
    }

    const loginData = await loginResponse.json();
    const instanceUrl = loginData.instance_url;
    const accessToken = loginData.access_token;

    const objectType = sfType.trim().toLowerCase() === "contact" ? "Contact" : "Lead";

    const recordResponse = await fetch(
      `${instanceUrl}/services/data/v59.0/sobjects/${objectType}/${sfId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!recordResponse.ok) {
      console.error("SF record fetch failed:", await recordResponse.text());
      return;
    }

    const record = await recordResponse.json();
    const now = new Date().toISOString();
    const updates: Record<string, string> = {};

    if (record.X1st_Text_Date__c == null) {
      updates.X1st_Text_Date__c = now;
    }
    if (record.Original_1st_Text_Date__c == null) {
      updates.Original_1st_Text_Date__c = now;
    }

    if (Object.keys(updates).length > 0) {
      const patchResponse = await fetch(
        `${instanceUrl}/services/data/v59.0/sobjects/${objectType}/${sfId}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(updates),
        },
      );

      if (!patchResponse.ok) {
        console.error("SF update failed:", await patchResponse.text());
      } else {
        console.log(`SF ${objectType} ${sfId} updated:`, Object.keys(updates));
      }
    } else {
      console.log(`SF ${objectType} ${sfId} already has text dates set`);
    }
  } catch (err) {
    console.error("SF update error:", err);
  }
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
