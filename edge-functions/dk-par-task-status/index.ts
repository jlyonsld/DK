// DK Edge Function: dk-par-task-status
//
// T17c — Receives task status-change callbacks FROM PAR (the reverse of
// dk-create-par-task). When a federated task is completed / reopened in PAR,
// PAR POSTs here and DK flips the matching local task's status. The DK row is
// found by `external_ref` = the DK tasks.id that dk-create-par-task sent PAR.
// The service-role UPDATE is picked up by DK's realtime subscription, so the
// console ticks the task off without a refresh.
//
// Deploy with verify_jwt: FALSE — PAR is not a Supabase user; auth is the HMAC
// signature below.
//
// Auth (contract agreed with PAR 2026-07-07):
//   Headers:
//     X-Spoke-Timestamp: <unix seconds>
//     X-Spoke-Signature: sha256=<lowercase hex of HMAC_SHA256(secret, "{ts}.{rawBody}")>
//   Reject if |now - ts| > 300s (replay window). Secret = SPOKE_TASK_CALLBACK_SECRET,
//   the same value set on PAR's edge secrets and on DK's.
//
// Body (PAR sends; DK treats `completed`/`status` as canonical, ignores extras):
//   {
//     "event": "task.status_changed",
//     "spoke_slug": "dk",
//     "external_ref": "<DK task uuid>",
//     "par_task_id": "<PAR task uuid>",
//     "status": "open" | "done",
//     "par_status_raw": "<free text | null>",
//     "completed": true | false,
//     "updated_at": "<ISO8601>"
//   }
//
// Responses:
//   200 — processed (incl. no-op, unknown external_ref) so PAR never retry-storms
//   401 — bad/missing signature or stale timestamp
//   405 — non-POST
//
// Status mapping (PAR has no status enum — `completed` is the source of truth):
//   completed=true            → DK 'done'
//   completed=false + DK was 'done'  → DK 'open' (reopened in PAR)
//   completed=false + DK open/in_progress → left unchanged (don't clobber
//                                            DK's own in_progress state)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SKEW_SECONDS = 300;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Constant-time hex compare.
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json(200, { ok: true });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const secret = Deno.env.get("SPOKE_TASK_CALLBACK_SECRET");
  if (!secret) return json(500, { error: "callback_secret_not_configured" });

  // Read the RAW body first — the signature is over the exact bytes.
  const rawBody = await req.text();

  const sigHeader = (req.headers.get("X-Spoke-Signature") || "").replace(/^sha256=/i, "").trim().toLowerCase();
  const tsHeader = (req.headers.get("X-Spoke-Timestamp") || "").trim();
  if (!sigHeader || !tsHeader) return json(401, { error: "missing_signature" });

  const ts = parseInt(tsHeader, 10);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > SKEW_SECONDS) {
    return json(401, { error: "stale_or_invalid_timestamp" });
  }

  const expected = await hmacHex(secret, `${ts}.${rawBody}`);
  if (!timingSafeEqualHex(expected, sigHeader)) {
    return json(401, { error: "bad_signature" });
  }

  // Signature verified — parse and apply.
  let body: Record<string, unknown>;
  try { body = JSON.parse(rawBody); } catch { return json(200, { ok: true, ignored: "unparseable_body" }); }

  const externalRef = String(body.external_ref || "").trim();
  if (!externalRef) return json(200, { ok: true, ignored: "no_external_ref" });

  const completed = body.completed === true || body.status === "done";

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: task, error: lookupErr } = await db
    .from("tasks").select("id, status").eq("id", externalRef).maybeSingle();
  if (lookupErr) return json(200, { ok: true, warning: "lookup_failed", detail: lookupErr.message });
  if (!task) return json(200, { ok: true, ignored: "unknown_task" });

  // Decide the new DK status.
  let newStatus: string | null = null;
  if (completed) {
    if (task.status !== "done") newStatus = "done";
  } else {
    // Not completed in PAR. Only "reopen" if DK currently shows done; never
    // downgrade an in_progress/open task PAR simply isn't done with.
    if (task.status === "done") newStatus = "open";
  }

  if (!newStatus) return json(200, { ok: true, noop: true, status: task.status });

  const { error: updErr } = await db.from("tasks").update({ status: newStatus }).eq("id", externalRef);
  if (updErr) return json(200, { ok: true, warning: "update_failed", detail: updErr.message });

  return json(200, { ok: true, updated: true, status: newStatus });
});
