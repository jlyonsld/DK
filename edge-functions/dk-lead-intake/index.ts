// DK Edge Function: dk-lead-intake
//
// Bridge: Google Sheet (Meta Lead Ads -> Sheet) -> DK `leads` table + Mailchimp.
// Each Meta submission is kept as its OWN lead row (deduped on meta_lead_id),
// so re-inquiries resurface as new touchpoints and every inquiry's details
// (campaign/form/platform/area + original date) are preserved. The console
// groups rows by email into one contact card. New leads push to Mailchimp
// immediately (tag dk-lead, STATUS=lead), email-keyed so MC can't duplicate.
//
// Auth: X-Lead-Secret header vs vault secret `lead_intake_secret`
// (get_lead_intake_secret() RPC). verify_jwt is false.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto as stdCrypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-lead-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function md5Hex(input: string): Promise<string> {
  const buf = await stdCrypto.subtle.digest("MD5", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function tagSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

// First valid-looking email from a possibly comma/semicolon-joined string.
function firstEmail(raw: unknown): string | null {
  if (raw == null) return null;
  for (const piece of String(raw).split(/[,;]/)) {
    const e = piece.trim().toLowerCase();
    if (e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return e;
  }
  return null;
}

function clean(raw: unknown): string | null {
  if (raw == null) return null;
  // Meta's sheet export prefixes phones with "p:" and ids with "l:". Strip a
  // leading single-letter prefix like "p:" / "l:" if present.
  let s = String(raw).trim();
  s = s.replace(/^[a-z]:/i, "");
  return s.trim() === "" ? null : s.trim();
}

function parseTs(raw: unknown): string | null {
  if (raw == null || String(raw).trim() === "") return null;
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseDob(raw: unknown): string | null {
  const s = clean(raw);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function splitName(full: string | null): { first: string; last: string } {
  if (!full) return { first: "", last: "" };
  const parts = full.trim().split(/\s+/);
  return { first: parts[0] ?? "", last: parts.length > 1 ? parts.slice(1).join(" ") : "" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // --- Auth ---
  const provided = req.headers.get("X-Lead-Secret") ?? req.headers.get("x-lead-secret") ?? "";
  const { data: expected } = await admin.rpc("get_lead_intake_secret");
  if (!expected || !safeEqual(provided, String(expected))) {
    return json(401, { error: "Invalid or missing X-Lead-Secret" });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch (_) {
    return json(400, { error: "Invalid JSON" });
  }

  // --- Normalize ---
  const parentName = clean(body.parent_name) ?? clean(body.full_name) ?? clean(body.name);
  const parentEmail = firstEmail(body.parent_email) ?? firstEmail(body.email);
  const parentPhone = clean(body.parent_phone) ?? clean(body.phone) ?? clean(body.phone_number);
  const childName = clean(body.child_name);
  const childDob = parseDob(body.child_dob);
  const school = clean(body.school_of_interest) ?? clean(body.area);
  const platform = clean(body.platform);
  const formName = clean(body.form_name);
  const campaignName = clean(body.campaign_name) ?? clean(body.ad_name);
  const receivedAt = parseTs(body.created_time);

  // Per-inquiry note so the grouped contact card shows what each submission was.
  const noteParts: string[] = [];
  if (campaignName) noteParts.push(`Ad: ${campaignName}`);
  if (formName) noteParts.push(`Form: ${formName}`);
  if (platform) noteParts.push(platform.toUpperCase());
  if (school) noteParts.push(`Area: ${school}`);
  const extraNote = clean(body.inquiry_note);
  if (extraNote) noteParts.push(extraNote);
  const notesText = noteParts.length ? noteParts.join(" · ") : null;

  // Dedupe key: Meta's lead id (one row per submission). Fall back to a content
  // hash only if no id is supplied.
  let dedupeKey = clean(body.dedupe_key) ?? clean(body.meta_lead_id);
  if (!dedupeKey) {
    dedupeKey = "sheet:" + (await md5Hex([parentEmail, parentPhone, childName, school, receivedAt].join("|")));
  }

  if (!parentEmail && !parentPhone) {
    return json(422, { error: "Lead has neither email nor phone", dedupe_key: dedupeKey });
  }

  // --- Idempotent insert (one row per submission) ---
  const { data: existing } = await admin
    .from("leads").select("id, status").eq("meta_lead_id", dedupeKey).maybeSingle();

  let leadId: string;
  let inserted = false;
  if (existing) {
    leadId = existing.id;
  } else {
    const row: Record<string, unknown> = {
      parent_name: parentName,
      parent_email: parentEmail,
      parent_phone: parentPhone,
      child_name: childName,
      child_dob: childDob,
      school_of_interest: school,
      meta_lead_id: dedupeKey,
      meta_form_id: clean(body.meta_form_id),
      meta_page_id: clean(body.meta_page_id),
      meta_ad_id: clean(body.meta_ad_id),
      raw_meta_payload: body.raw ?? body,
      source: "sheet_bridge",
      status: "new",
      notes: notesText,
    };
    if (receivedAt) row.received_at = receivedAt;

    const { data: ins, error: insErr } = await admin.from("leads").insert(row).select("id").single();
    if (insErr) {
      if (insErr.code === "23505") {
        const { data: again } = await admin
          .from("leads").select("id").eq("meta_lead_id", dedupeKey).maybeSingle();
        leadId = again?.id ?? "";
      } else {
        return json(500, { error: "Lead insert failed", detail: insErr.message });
      }
    } else {
      leadId = ins.id;
      inserted = true;
    }
  }

  // --- Best-effort Mailchimp nurture upsert (never blocks the lead) ---
  let mc: Record<string, unknown> = { attempted: false };
  if (inserted && parentEmail) {
    try {
      const { data: cfg } = await admin
        .from("dk_config")
        .select("mailchimp_api_key, mailchimp_server_prefix, mailchimp_audience_id, mailchimp_double_opt_in")
        .eq("id", 1)
        .maybeSingle();

      if (cfg?.mailchimp_api_key && cfg.mailchimp_server_prefix && cfg.mailchimp_audience_id) {
        const base = `https://${cfg.mailchimp_server_prefix}.api.mailchimp.com/3.0`;
        const auth = "Basic " + btoa(`anystring:${cfg.mailchimp_api_key}`);
        const statusIfNew = cfg.mailchimp_double_opt_in === false ? "subscribed" : "pending";
        const { first, last } = splitName(parentName);
        const hash = await md5Hex(parentEmail);

        const upsertResp = await fetch(`${base}/lists/${cfg.mailchimp_audience_id}/members/${hash}`, {
          method: "PUT",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            email_address: parentEmail,
            status_if_new: statusIfNew,
            merge_fields: { FNAME: first, LNAME: last, STUDENT: childName ?? "", SCHOOL: school ?? "", STATUS: "lead" },
          }),
        });
        const upsertStatus = upsertResp.status;

        if (upsertResp.ok) {
          const tags: { name: string; status: "active" }[] = [{ name: "dk-lead", status: "active" }];
          if (school) tags.push({ name: `area:${tagSlug(school)}`, status: "active" });
          await fetch(`${base}/lists/${cfg.mailchimp_audience_id}/members/${hash}/tags`, {
            method: "POST",
            headers: { Authorization: auth, "Content-Type": "application/json" },
            body: JSON.stringify({ tags }),
          });
        }
        mc = { attempted: true, status: upsertStatus, ok: upsertResp.ok };

        await admin.from("mailchimp_sync_log").insert({
          direction: "outbound",
          event: upsertResp.ok ? "lead_upsert" : "lead_upsert_failure",
          parent_email: parentEmail,
          student_id: null,
          status: upsertStatus,
          payload: { source: "sheet_bridge", lead_id: leadId },
          error: upsertResp.ok ? null : (await upsertResp.text()).slice(0, 240),
        });
      } else {
        mc = { attempted: false, skipped: "mc_not_configured" };
      }
    } catch (e) {
      mc = { attempted: true, error: (e instanceof Error ? e.message : String(e)).slice(0, 240) };
    }
  }

  return json(200, {
    ok: true,
    lead_id: leadId,
    inserted,
    deduped: !inserted,
    dedupe_key: dedupeKey,
    mailchimp: mc,
  });
});
