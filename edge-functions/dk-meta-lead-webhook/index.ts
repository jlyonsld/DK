// DK Edge Function: dk-meta-lead-webhook
//
// Receives Meta Lead Ads webhooks and inserts a row into `leads`.
//
// Meta's flow has two distinct request shapes:
//
//   1. SUBSCRIPTION VERIFICATION (one-time, when adding the webhook in
//      Meta App Dashboard): GET ?hub.mode=subscribe&hub.challenge=...
//      &hub.verify_token=<our shared token>. We must echo the challenge
//      verbatim if the verify_token matches META_VERIFY_TOKEN.
//
//   2. LEAD EVENT (per submission): POST signed with X-Hub-Signature-256
//      = "sha256=" + hmac_sha256(META_APP_SECRET, body). Body is JSON:
//        { "object":"page", "entry":[{ "id":<page_id>, "time":...,
//          "changes":[{ "field":"leadgen", "value":{
//            "ad_id":"...", "form_id":"...", "leadgen_id":"...",
//            "created_time":..., "page_id":"..." }}]}]}
//      The webhook does NOT carry the field values — we must GET
//      /{leadgen_id}?access_token={META_PAGE_ACCESS_TOKEN} to fetch
//      `field_data: [{name, values}, ...]`.
//
// verify_jwt: false. Auth IS the HMAC signature on POST + the verify
// token on GET. Mirrors `dk-install-callback` and `mailchimp-webhook`.
//
// Env vars (set via Supabase dashboard for the DK project):
//   META_APP_SECRET          — Meta app secret, used for HMAC verification
//   META_VERIFY_TOKEN        — arbitrary shared token for the GET handshake
//   META_PAGE_ACCESS_TOKEN   — page access token to fetch lead field_data
//                              (optional — if unset, leads land with only
//                              the leadgen_id + last_fetch_error)
//
// Always returns 200 on POST to prevent Meta retry storms (same pattern
// as mailchimp-webhook). Errors land in leads.last_fetch_error.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) return new Uint8Array();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Meta's field_data is shaped like:
//   [{ name: "full_name", values: ["Jane Doe"] }, ...]
// Names vary per form; we map common ones case-insensitively. Anything
// unrecognized stays in raw_meta_payload.
type MetaField = { name: string; values: string[] };

function pickField(fields: MetaField[], ...candidates: string[]): string | null {
  const lc = candidates.map((c) => c.toLowerCase());
  for (const f of fields) {
    if (lc.includes((f.name || "").toLowerCase())) {
      const v = (f.values && f.values[0]) || "";
      if (v) return v;
    }
  }
  return null;
}

function splitName(full: string): { first: string | null; last: string | null } {
  const trimmed = (full || "").trim();
  if (!trimmed) return { first: null, last: null };
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

async function fetchLeadFieldData(
  leadgenId: string,
  pageToken: string,
): Promise<{ field_data: MetaField[] } | { error: string }> {
  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(leadgenId)}?access_token=${encodeURIComponent(pageToken)}`;
  try {
    const resp = await fetch(url);
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { error: `Meta GET ${resp.status}: ${JSON.stringify(body).slice(0, 500)}` };
    }
    return { field_data: (body.field_data || []) as MetaField[] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const verifyToken = Deno.env.get("META_VERIFY_TOKEN") || "";
  const appSecret = Deno.env.get("META_APP_SECRET") || "";
  const pageToken = Deno.env.get("META_PAGE_ACCESS_TOKEN") || "";

  // Subscription handshake.
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const challenge = url.searchParams.get("hub.challenge");
    const token = url.searchParams.get("hub.verify_token");
    if (mode === "subscribe" && verifyToken && token === verifyToken && challenge) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return jsonResponse(403, { error: "verify_token mismatch" });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "POST only" });
  }

  if (!appSecret) {
    return jsonResponse(503, { error: "META_APP_SECRET not configured" });
  }

  const rawBody = await req.text();

  // HMAC verification. Header is "sha256=<hex>".
  const sigHeader = req.headers.get("x-hub-signature-256") || "";
  const expected = await hmacSha256Hex(appSecret, rawBody);
  const got = sigHeader.replace(/^sha256=/, "");
  if (!constantTimeEqual(hexToBytes(got), hexToBytes(expected))) {
    return jsonResponse(401, { error: "Invalid signature" });
  }

  let payload: any = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse(200, { ok: true, note: "non-json body" });
  }

  if (payload?.object !== "page" || !Array.isArray(payload?.entry)) {
    return jsonResponse(200, { ok: true, note: "ignored non-page object" });
  }

  let inserted = 0;
  let skipped = 0;
  let errors: string[] = [];

  for (const entry of payload.entry) {
    const pageId = entry?.id || null;
    for (const change of entry?.changes || []) {
      if (change?.field !== "leadgen") continue;
      const v = change.value || {};
      const leadgenId: string | null = v.leadgen_id || null;
      if (!leadgenId) {
        skipped += 1;
        continue;
      }

      // Fetch field_data from Meta. If the page token is unset, persist
      // the leadgen pointer + an explanatory error so the row is visible
      // and admin can re-trigger the fetch later.
      let fieldData: MetaField[] = [];
      let fetchError: string | null = null;

      if (pageToken) {
        const fetched = await fetchLeadFieldData(leadgenId, pageToken);
        if ("error" in fetched) {
          fetchError = fetched.error;
        } else {
          fieldData = fetched.field_data;
        }
      } else {
        fetchError = "META_PAGE_ACCESS_TOKEN not configured";
      }

      const fullName = pickField(fieldData, "full_name", "name");
      const firstNameField = pickField(fieldData, "first_name");
      const lastNameField = pickField(fieldData, "last_name");
      const email = pickField(fieldData, "email");
      const phone = pickField(fieldData, "phone_number", "phone");
      const childName = pickField(fieldData, "child_name", "child_first_name", "student_name");
      const childDobRaw = pickField(fieldData, "child_dob", "date_of_birth", "child_date_of_birth");
      const school = pickField(fieldData, "school", "school_of_interest", "school_name", "preferred_school");

      let parentName: string | null = null;
      if (firstNameField || lastNameField) {
        parentName = [firstNameField, lastNameField].filter(Boolean).join(" ");
      } else if (fullName) {
        parentName = fullName;
      }

      // Validate child_dob — Meta may send "MM/DD/YYYY", "YYYY-MM-DD", or
      // empty. Postgres `date` will reject anything else; we feed null
      // when uncertain rather than failing the whole insert.
      let childDob: string | null = null;
      if (childDobRaw) {
        const t = childDobRaw.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
          childDob = t;
        } else {
          const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
          if (m) childDob = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
        }
      }

      const row = {
        parent_name: parentName,
        parent_email: email ? email.toLowerCase().trim() : null,
        parent_phone: phone || null,
        child_name: childName || null,
        child_dob: childDob,
        school_of_interest: school || null,
        meta_lead_id: leadgenId,
        meta_form_id: v.form_id || null,
        meta_page_id: pageId || v.page_id || null,
        meta_ad_id: v.ad_id || null,
        raw_meta_payload: { webhook: change, field_data: fieldData },
        last_fetch_error: fetchError,
      };

      // Idempotent: meta_lead_id is unique. ON CONFLICT DO NOTHING means
      // a Meta retry won't double-insert. If you ever need to refresh
      // field_data on retry, change to ON CONFLICT (meta_lead_id) DO
      // UPDATE — but ONLY if status is still 'new', or you'll clobber
      // an admin's notes.
      const { error } = await admin
        .from("leads")
        .insert(row);

      if (error) {
        if ((error as any).code === "23505") {
          skipped += 1; // duplicate meta_lead_id — Meta retry, ignore
        } else {
          errors.push(error.message);
        }
      } else {
        inserted += 1;
      }
    }
  }

  // Always 200. Meta retries on non-2xx for hours.
  return jsonResponse(200, { ok: true, inserted, skipped, errors });
});
