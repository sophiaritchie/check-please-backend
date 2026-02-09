import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verify, decode } from "https://deno.land/x/djwt@v3.0.2/mod.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const secret = Deno.env.get("DIALPAD_WEBHOOK_SECRET");

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

  const update: Record<string, string> = {};
  if (messageStatus) update.message_status = messageStatus;
  if (deliveryResult) update.message_delivery_result = deliveryResult;

  if (Object.keys(update).length === 0) {
    console.log("No status fields to update");
    return new Response(JSON.stringify({ ok: true, updated: false }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const { error } = await supabase
    .from("messages")
    .update(update)
    .eq("dialpad_id", dialpadId);

  if (error) {
    console.error("Supabase update error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log("Updated successfully:", { dialpadId, ...update });
  return new Response(JSON.stringify({ ok: true, dialpad_id: dialpadId, ...update }), {
    headers: { "Content-Type": "application/json" },
  });
}
