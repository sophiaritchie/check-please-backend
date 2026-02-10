import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verify, decode } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const secret = Deno.env.get("DIALPAD_WEBHOOK_SECRET");

// Higher number = more terminal. Only allow forward movement.
const STATUS_PRECEDENCE: Record<string, number> = {
  sending: 0,
  pending: 1,
  sent: 2,
  delivered: 3,
  failed: 3,
  undelivered: 3,
};

function shouldUpdateStatus(currentStatus: string, newStatus: string): boolean {
  const current = STATUS_PRECEDENCE[currentStatus] ?? -1;
  const next = STATUS_PRECEDENCE[newStatus] ?? -1;
  return next > current;
}

async function verifyJwt(token: string): Promise<Record<string, unknown>> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  const payload = await verify(token, key);
  return payload as Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await req.text();
  console.log("Received body length:", body.length);
  console.log("Body preview:", body.substring(0, 200));
  console.log("Secret configured:", !!secret);

  // If no secret is configured, try parsing as plain JSON
  if (!secret) {
    console.log("No DIALPAD_WEBHOOK_SECRET set — treating body as plain JSON");
    try {
      const payload = JSON.parse(body);
      console.log("Parsed payload:", JSON.stringify(payload));
      return await handlePayload(payload);
    } catch (e) {
      console.error("Failed to parse as JSON:", (e as Error).message);
      return new Response(JSON.stringify({ error: "No secret configured and body is not valid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Try JWT verification
  try {
    // Log decoded (unverified) payload for debugging
    try {
      const [header, unverifiedPayload] = decode(body);
      console.log("JWT header:", JSON.stringify(header));
      console.log("JWT payload (unverified):", JSON.stringify(unverifiedPayload));
    } catch (decodeErr) {
      console.error("Failed to decode JWT:", (decodeErr as Error).message);
      console.log("Body does not look like a JWT. Trying plain JSON...");
      try {
        const payload = JSON.parse(body);
        console.log("Parsed as plain JSON:", JSON.stringify(payload));
        return await handlePayload(payload);
      } catch {
        return new Response(JSON.stringify({ error: "Body is neither valid JWT nor JSON" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    const payload = await verifyJwt(body);
    console.log("JWT verified successfully");
    return await handlePayload(payload);
  } catch (err) {
    console.error("JWT verification failed:", (err as Error).message);
    return new Response(JSON.stringify({ error: "JWT verification failed", detail: (err as Error).message }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
});

async function handlePayload(payload: Record<string, unknown>): Promise<Response> {
  const dialpadId = String(payload.id ?? "");
  const messageStatus = payload.message_status as string | undefined;
  const deliveryResult = payload.message_delivery_result as string | undefined;

  console.log("Processing:", { dialpadId, messageStatus, deliveryResult });

  if (!dialpadId) {
    console.error("Missing message id in payload");
    return new Response(JSON.stringify({ error: "Missing message id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: attempt } = await supabase
    .from("send_attempts")
    .select("id, message_id, attempt_number, status")
    .eq("dialpad_id", dialpadId)
    .limit(1)
    .maybeSingle();

  if (attempt) {
    return await handleSendAttemptUpdate(attempt, messageStatus, deliveryResult);
  }

  console.log("No send_attempt found for dialpad_id:", dialpadId);
  return new Response(JSON.stringify({ error: "No matching send_attempt found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleSendAttemptUpdate(
  attempt: { id: string; message_id: string; attempt_number: number; status: string },
  messageStatus: string | undefined,
  deliveryResult: string | undefined,
): Promise<Response> {
  const now = new Date().toISOString();

  // Check precedence — don't go backwards
  if (messageStatus && !shouldUpdateStatus(attempt.status, messageStatus)) {
    console.log(`Ignoring status regression: ${attempt.status} → ${messageStatus}`);
    return new Response(
      JSON.stringify({ ok: true, skipped: true, reason: "status regression", current: attempt.status, incoming: messageStatus }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  // Update send_attempts row
  const attemptUpdate: Record<string, string> = { updated_at: now };
  if (messageStatus) attemptUpdate.status = messageStatus;
  if (deliveryResult) attemptUpdate.delivery_result = deliveryResult;

  const { error: attemptErr } = await supabase
    .from("send_attempts")
    .update(attemptUpdate)
    .eq("id", attempt.id);

  if (attemptErr) {
    console.error("send_attempts update error:", attemptErr);
  }

  // Check if this is the latest attempt for the parent message
  const { data: latestAttempt } = await supabase
    .from("send_attempts")
    .select("id")
    .eq("message_id", attempt.message_id)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .single();

  if (latestAttempt && latestAttempt.id === attempt.id) {
    // This is the latest attempt — propagate status to messages table
    // (SF update is handled automatically by DB trigger on status change)
    if (messageStatus) {
      const { error: msgErr } = await supabase
        .from("messages")
        .update({ message_status: messageStatus })
        .eq("id", attempt.message_id);

      if (msgErr) {
        console.error("messages update error:", msgErr);
      }
    }
  } else {
    console.log("Webhook for non-latest attempt, skipping message status propagation");
  }

  console.log("Updated send_attempt and message:", {
    attempt_id: attempt.id,
    message_id: attempt.message_id,
    messageStatus,
    deliveryResult,
  });

  return new Response(
    JSON.stringify({ ok: true, attempt_id: attempt.id, message_id: attempt.message_id }),
    { headers: { "Content-Type": "application/json" } },
  );
}
