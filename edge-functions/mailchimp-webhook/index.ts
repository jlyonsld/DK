// DK Edge Function: mailchimp-webhook
//
// Receives Mailchimp's audience webhooks and updates students.marketing_status.
// Auth: ?secret=<token> query param compared constant-time against
// dk_config.mailchimp_webhook_secret. verify_jwt is false because MC
// has no Supabase session.
//
// Mailchimp validates the URL with a GET request when first added; we must
// return 200 to that. Real webhook events arrive as form-encoded POST
// bodies. Always return 200 (even on lookup miss) so MC doesn't retry-storm
// against a parent who isn't in DK yet.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function getConfiguredSecret(admin: ReturnType<typeof createClient>): Promise<string | null> {
  const { data } = await admin
    .from("dk_config")
    .select("mailchimp_webhook_secret")
    .eq("id", 1)
    .maybeSingle();
  return (data as { mailchimp_webhook_secret: string | null } | null)?.mailchimp_webhook_secret || null;
}

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const url = new URL(req.url);
  const querySecret = url.searchParams.get("secret") || "";

  const configuredSecret = await getConfiguredSecret(admin);
  if (!configuredSecret) {
    return jsonResponse(503, { error: "Mailchimp webhook not configured" });
  }
  if (!constantTimeEqual(querySecret, configuredSecret)) {
    return jsonResponse(401, { error: "Invalid secret" });
  }

  // MC sends GET to validate URL on add. Return 200.
  if (req.method === "GET") {
    return new Response("ok", { status: 200 });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "POST only" });
  }

  // MC POSTs application/x-www-form-urlencoded with type=...&data[email]=...&...
  let formText: string;
  try {
    formText = await req.text();
  } catch {
    return jsonResponse(200, { ok: true, note: "no body" });
  }
  const params = new URLSearchParams(formText);
  const eventType = params.get("type") || "";
  const dataEmail = (params.get("data[email]") || "").trim().toLowerCase();
  const dataNewEmail = (params.get("data[new_email]") || "").trim().toLowerCase();
  const dataOldEmail = (params.get("data[old_email]") || "").trim().toLowerCase();

  let newStatus: "subscribed" | "unsubscribed" | "cleaned" | null = null;
  if (eventType === "subscribe") newStatus = "subscribed";
  else if (eventType === "unsubscribe") newStatus = "unsubscribed";
  else if (eventType === "cleaned") newStatus = "cleaned";

  let lookupEmail = dataEmail;
  let logEvent = eventType || "unknown";
  let logError: string | null = null;

  try {
    if (eventType === "upemail" && dataOldEmail && dataNewEmail) {
      // Replace old_email with new_email in students.parent_emails arrays.
      const { data: matches } = await admin
        .from("students")
        .select("id, parent_emails")
        .contains("parent_emails", [dataOldEmail]);

      if (matches && matches.length > 0) {
        for (const s of matches as { id: string; parent_emails: string[] }[]) {
          const updated = (s.parent_emails || []).map((e) =>
            (e || "").trim().toLowerCase() === dataOldEmail ? dataNewEmail : e
          );
          await admin
            .from("students")
            .update({ parent_emails: updated, marketing_status_updated_at: new Date().toISOString() })
            .eq("id", s.id);
          // Trigger will enqueue an upsert for the new email automatically.
        }
      }
      lookupEmail = dataNewEmail;
    } else if (newStatus) {
      // subscribe / unsubscribe / cleaned — flip status on every matching student.
      const { error: updErr } = await admin
        .from("students")
        .update({
          marketing_status: newStatus,
          marketing_status_updated_at: new Date().toISOString(),
        })
        .contains("parent_emails", [lookupEmail]);
      if (updErr) logError = updErr.message;
    } else if (eventType === "profile") {
      await admin
        .from("students")
        .update({ marketing_status_updated_at: new Date().toISOString() })
        .contains("parent_emails", [lookupEmail]);
    } else {
      logEvent = `ignored_${eventType || "empty"}`;
    }
  } catch (e) {
    logError = e instanceof Error ? e.message : String(e);
  }

  await admin.from("mailchimp_sync_log").insert({
    direction: "inbound",
    event: logEvent,
    parent_email: lookupEmail || null,
    student_id: null,
    status: 200,
    payload: Object.fromEntries(params.entries()),
    error: logError,
  });

  // Always 200 — MC retries on non-2xx and we don't want stuck queues for
  // parents not yet in DK.
  return new Response("ok", { status: 200 });
});
