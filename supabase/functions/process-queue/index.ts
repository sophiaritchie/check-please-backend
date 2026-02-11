import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const DIALPAD_API_URL = Deno.env.get("DIALPAD_API_URL")!;
const DIALPAD_API_KEY = Deno.env.get("DIALPAD_API_KEY")!;
const DIALPAD_FROM_NUMBER = Deno.env.get("DIALPAD_FROM_NUMBER")!;

const MAX_ATTEMPTS = 7;

interface Message {
  id: string;
  from_number: string;
  to_numbers: string[];
  text: string;
  attempt_count: number;
  message_status: string;
}

Deno.serve(async (_req) => {
  try {
    const message = await findNextMessage();
    if (!message) {
      return jsonResponse({ ok: true, message: "Queue empty" });
    }

    const claimed = await claimMessage(message.id, message.message_status);
    if (!claimed) {
      return jsonResponse({ ok: true, message: "Message claimed by another processor" });
    }

    return await processMessage(message);
  } catch (err) {
    console.error("Unexpected error:", err);
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});

async function findNextMessage(): Promise<Message | null> {
  // Priority a) Stuck pending messages (no webhook update in 10 min)
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { data: stuck } = await supabase
    .from("messages")
    .select("id, from_number, to_numbers, text, attempt_count, message_status")
    .eq("message_status", "pending")
    .lt("last_attempted_at", tenMinAgo)
    .lt("attempt_count", MAX_ATTEMPTS)
    .order("priority", { ascending: false })
    .order("queued_at", { ascending: true })
    .limit(1);

  if (stuck && stuck.length > 0) {
    console.log("Found stuck pending message:", stuck[0].id);
    return stuck[0] as Message;
  }

  // Priority b) Webhook-reported failures eligible for retry
  const { data: failed } = await supabase
    .from("messages")
    .select("id, from_number, to_numbers, text, attempt_count, message_status")
    .in("message_status", ["failed", "undelivered"])
    .lt("attempt_count", MAX_ATTEMPTS)
    .order("priority", { ascending: false })
    .order("queued_at", { ascending: true })
    .limit(1);

  if (failed && failed.length > 0) {
    console.log("Found failed/undelivered message for retry:", failed[0].id);
    return failed[0] as Message;
  }

  // Priority c) New queued messages
  const { data: queued } = await supabase
    .from("messages")
    .select("id, from_number, to_numbers, text, attempt_count, message_status")
    .eq("message_status", "queued")
    .order("priority", { ascending: false })
    .order("queued_at", { ascending: true })
    .limit(1);

  if (queued && queued.length > 0) {
    console.log("Found queued message:", queued[0].id);
    return queued[0] as Message;
  }

  return null;
}

async function claimMessage(id: string, currentStatus: string): Promise<boolean> {
  // Optimistic lock: only update if status hasn't changed
  const { data, error } = await supabase
    .from("messages")
    .update({ message_status: "sending", last_attempted_at: new Date().toISOString() })
    .eq("id", id)
    .eq("message_status", currentStatus)
    .select("id");

  if (error) {
    console.error("Claim error:", error);
    return false;
  }

  return data !== null && data.length > 0;
}

async function processMessage(message: Message): Promise<Response> {
  const attemptNumber = message.attempt_count + 1;
  const now = new Date().toISOString();

  try {
    // Call Dialpad API
    const dialpadUrl = `${DIALPAD_API_URL}sms?apikey=${DIALPAD_API_KEY}`;
    const dialpadResponse = await fetch(dialpadUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        from_number: message.from_number || DIALPAD_FROM_NUMBER,
        infer_country_code: false,
        text: message.text,
        to_numbers: message.to_numbers,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!dialpadResponse.ok) {
      const errorText = await dialpadResponse.text();
      console.error("Dialpad API error:", dialpadResponse.status, errorText);
      return await handleFailure(message, attemptNumber, `HTTP ${dialpadResponse.status}: ${errorText}`);
    }

    const res = await dialpadResponse.json();
    console.log("Dialpad response:", JSON.stringify(res));

    // Insert send_attempt record
    await supabase.from("send_attempts").insert({
      message_id: message.id,
      attempt_number: attemptNumber,
      dialpad_id: res.id,
      status: res.message_status || "sent",
      dialpad_contact_id: res.contact_id,
      dialpad_created_date: res.created_date,
      device_type: res.device_type,
      target_id: res.target_id,
      target_type: res.target_type,
    });

    const responseStatus = res.message_status || "sent";

    // Update messages table (SF update handled by DB trigger)
    await supabase
      .from("messages")
      .update({
        message_status: responseStatus,
        attempt_count: attemptNumber,
        last_attempted_at: now,
      })
      .eq("id", message.id);

    return jsonResponse({
      ok: true,
      message_id: message.id,
      status: responseStatus,
      attempt: attemptNumber,
    });
  } catch (err) {
    console.error("Error calling Dialpad:", err);
    return await handleFailure(message, attemptNumber, (err as Error).message);
  }
}

async function handleFailure(message: Message, attemptNumber: number, errorDetail: string): Promise<Response> {
  const now = new Date().toISOString();

  // Insert failed send_attempt
  await supabase.from("send_attempts").insert({
    message_id: message.id,
    attempt_number: attemptNumber,
    status: "failed",
    error_detail: errorDetail,
  });

  if (attemptNumber >= MAX_ATTEMPTS) {
    // Max retries exhausted
    await supabase
      .from("messages")
      .update({
        message_status: "failed",
        attempt_count: attemptNumber,
        last_attempted_at: now,
        failed_at: now,
      })
      .eq("id", message.id);

    console.log(`Message ${message.id} permanently failed after ${attemptNumber} attempts`);
  } else {
    // Re-queue for retry
    await supabase
      .from("messages")
      .update({
        message_status: "queued",
        attempt_count: attemptNumber,
        last_attempted_at: now,
      })
      .eq("id", message.id);

    console.log(`Message ${message.id} re-queued (attempt ${attemptNumber}/${MAX_ATTEMPTS})`);
  }

  return jsonResponse({
    ok: false,
    message_id: message.id,
    error: errorDetail,
    attempt: attemptNumber,
    will_retry: attemptNumber < MAX_ATTEMPTS,
  });
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
