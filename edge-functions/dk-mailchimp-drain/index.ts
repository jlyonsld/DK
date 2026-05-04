// DK Edge Function: dk-mailchimp-drain
//
// Triggered every 60s by pg_cron (job: dk-mailchimp-drain). Reads up to 50
// pending rows from mailchimp_sync_outbox and upserts each parent into the
// configured Mailchimp audience with allow-listed merge fields + tags.
//
// Auth: X-Cron-Secret header must match the vault-stored cron secret.
// verify_jwt is false because pg_cron has no user JWT.
//
// No-ops gracefully if dk_config.mailchimp_api_key is null (returns
// { skipped: 'not_configured' }) so the schema can ship before Sharon
// pastes credentials.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto as stdCrypto } from "https://deno.land/std@0.224.0/crypto/mod.ts";

const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;

// Allow-list of fields that can ever go to Mailchimp. Anything sensitive
// (allergies, medical_notes, payment_details, waivers, documents, etc.)
// is intentionally not selected anywhere in this file.
const MC_ALLOWED_MERGE_FIELDS = ["FNAME", "LNAME", "STUDENT", "CLASS", "SCHOOL", "STATUS"] as const;

type SyncRow = {
  id: string;
  student_id: string | null;
  parent_email: string;
  op: string;
  attempts: number;
};

type Config = {
  mailchimp_api_key: string | null;
  mailchimp_server_prefix: string | null;
  mailchimp_audience_id: string | null;
  mailchimp_double_opt_in: boolean | null;
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function md5Hex(input: string): Promise<string> {
  const buf = await stdCrypto.subtle.digest("MD5", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function tagSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function pickFirstName(parentNames: string[] | null, parentEmail: string): string {
  if (parentNames && parentNames.length > 0) {
    const n = (parentNames[0] || "").trim();
    if (n) return n.split(/\s+/)[0];
  }
  return parentEmail.split("@")[0];
}

function pickLastName(parentNames: string[] | null): string {
  if (parentNames && parentNames.length > 0) {
    const n = (parentNames[0] || "").trim();
    if (n) {
      const parts = n.split(/\s+/);
      if (parts.length > 1) return parts.slice(1).join(" ");
    }
  }
  return "";
}

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Cron secret check — read via the get_mailchimp_drain_cron_secret RPC
  // (service-role-only) at request time so we don't need to set an Edge
  // Function env var out-of-band. The pg_cron job sends the same vault
  // value as X-Cron-Secret.
  const headerSecret = req.headers.get("X-Cron-Secret") || "";
  const { data: expectedSecret } = await admin.rpc("get_mailchimp_drain_cron_secret");
  if (!expectedSecret || headerSecret !== expectedSecret) {
    return jsonResponse(401, { error: "Invalid cron secret" });
  }

  // Load config — bail early if MC isn't configured
  const { data: cfg } = await admin
    .from("dk_config")
    .select("mailchimp_api_key, mailchimp_server_prefix, mailchimp_audience_id, mailchimp_double_opt_in")
    .eq("id", 1)
    .maybeSingle<Config>();

  if (!cfg?.mailchimp_api_key || !cfg.mailchimp_server_prefix || !cfg.mailchimp_audience_id) {
    return jsonResponse(200, { skipped: "not_configured" });
  }

  const mcBase = `https://${cfg.mailchimp_server_prefix}.api.mailchimp.com/3.0`;
  const mcAuth = "Basic " + btoa(`anystring:${cfg.mailchimp_api_key}`);
  const audienceId = cfg.mailchimp_audience_id;
  const statusIfNew = cfg.mailchimp_double_opt_in === false ? "subscribed" : "pending";

  // Pull batch
  const { data: rows, error: rowsErr } = await admin
    .from("mailchimp_sync_outbox")
    .select("id, student_id, parent_email, op, attempts")
    .is("completed_at", null)
    .lt("attempts", MAX_ATTEMPTS)
    .order("enqueued_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (rowsErr) {
    return jsonResponse(500, { error: "Failed to read outbox", detail: rowsErr.message });
  }
  if (!rows || rows.length === 0) {
    return jsonResponse(200, { processed: 0, ok: 0, failed: 0 });
  }

  let ok = 0;
  let failed = 0;

  for (const row of rows as SyncRow[]) {
    // Stamp attempt counter even on failure so we don't loop forever
    await admin
      .from("mailchimp_sync_outbox")
      .update({ attempted_at: new Date().toISOString(), attempts: row.attempts + 1 })
      .eq("id", row.id);

    try {
      if (row.op === "archive") {
        const memberHash = await md5Hex(row.parent_email);
        const resp = await fetch(`${mcBase}/lists/${audienceId}/members/${memberHash}`, {
          method: "DELETE",
          headers: { Authorization: mcAuth },
        });
        if (!resp.ok && resp.status !== 404) {
          throw new Error(`MC archive ${resp.status}: ${(await resp.text()).slice(0, 240)}`);
        }
        await admin
          .from("mailchimp_sync_outbox")
          .update({ completed_at: new Date().toISOString(), last_error: null })
          .eq("id", row.id);
        await admin.from("mailchimp_sync_log").insert({
          direction: "outbound",
          event: "archive",
          parent_email: row.parent_email,
          student_id: row.student_id,
          status: resp.status,
          payload: null,
          error: null,
        });
        ok += 1;
        continue;
      }

      // op === 'upsert'
      if (!row.student_id) throw new Error("Missing student_id on upsert row");

      // Resolve student + most-recent enrollment + class + school
      const { data: student, error: stErr } = await admin
        .from("students")
        .select("id, first_name, last_name, parent_emails, parent_names, marketing_status")
        .eq("id", row.student_id)
        .maybeSingle();
      if (stErr) throw stErr;
      if (!student) {
        // Student was deleted — mark complete and move on
        await admin
          .from("mailchimp_sync_outbox")
          .update({ completed_at: new Date().toISOString(), last_error: "student_deleted" })
          .eq("id", row.id);
        ok += 1;
        continue;
      }

      // Skip API call if parent has unsubscribed (MC would honor it anyway)
      if (student.marketing_status === "unsubscribed" || student.marketing_status === "cleaned") {
        await admin
          .from("mailchimp_sync_outbox")
          .update({ completed_at: new Date().toISOString(), last_error: `skipped_${student.marketing_status}` })
          .eq("id", row.id);
        await admin.from("mailchimp_sync_log").insert({
          direction: "outbound",
          event: "skip",
          parent_email: row.parent_email,
          student_id: row.student_id,
          status: 0,
          payload: null,
          error: `skipped_${student.marketing_status}`,
        });
        ok += 1;
        continue;
      }

      // Find this parent's index so we can pick the matching name
      const lowered = (student.parent_emails || []).map((e: string) => (e || "").trim().toLowerCase());
      const parentIdx = lowered.indexOf(row.parent_email);
      const parentName = parentIdx >= 0 && student.parent_names ? student.parent_names[parentIdx] : null;
      const fname = pickFirstName(parentName ? [parentName] : student.parent_names, row.parent_email);
      const lname = pickLastName(parentName ? [parentName] : student.parent_names);

      // Most recent enrollment (active wins over dropped/etc; tiebreak by enrolled_at desc)
      const { data: enrollments } = await admin
        .from("enrollments")
        .select("id, status, class_id, enrolled_at")
        .eq("student_id", student.id)
        .order("enrolled_at", { ascending: false })
        .limit(5);

      const activeEnrollment = (enrollments || []).find((e) => e.status === "active") || (enrollments || [])[0] || null;

      let className = "";
      let schoolName = "";
      if (activeEnrollment?.class_id) {
        const { data: cls } = await admin
          .from("classes")
          .select("id, name, location, school_id")
          .eq("id", activeEnrollment.class_id)
          .maybeSingle();
        if (cls) {
          className = cls.name || "";
          if (cls.school_id) {
            const { data: sch } = await admin
              .from("schools")
              .select("name")
              .eq("id", cls.school_id)
              .maybeSingle();
            schoolName = sch?.name || cls.location || "";
          } else {
            schoolName = cls.location || "";
          }
        }
      }

      const status = activeEnrollment?.status || "lead";

      // Strict allow-list payload — never inline a sensitive field here.
      const mergeFields: Record<string, string> = {
        FNAME: fname || "",
        LNAME: lname || "",
        STUDENT: student.first_name || "",
        CLASS: className,
        SCHOOL: schoolName,
        STATUS: status,
      };
      // Defensive: strip any merge field name not in the allow-list.
      for (const k of Object.keys(mergeFields)) {
        if (!MC_ALLOWED_MERGE_FIELDS.includes(k as typeof MC_ALLOWED_MERGE_FIELDS[number])) {
          delete mergeFields[k];
        }
      }

      const memberHash = await md5Hex(row.parent_email);
      const upsertBody = {
        email_address: row.parent_email,
        status_if_new: statusIfNew,
        merge_fields: mergeFields,
      };

      const upsertResp = await fetch(`${mcBase}/lists/${audienceId}/members/${memberHash}`, {
        method: "PUT",
        headers: { Authorization: mcAuth, "Content-Type": "application/json" },
        body: JSON.stringify(upsertBody),
      });

      if (!upsertResp.ok) {
        throw new Error(`MC upsert ${upsertResp.status}: ${(await upsertResp.text()).slice(0, 240)}`);
      }

      // Apply tags (active = present). MC retains tags not listed; that's
      // acceptable for v1 — class/school tags accumulate harmlessly until
      // someone manually prunes. Cleanup pass is a future enhancement.
      const tags: { name: string; status: "active" | "inactive" }[] = [];
      tags.push({ name: `dk-${tagSlug(status)}`, status: "active" });
      if (className) tags.push({ name: `class:${tagSlug(className)}`, status: "active" });
      if (schoolName) tags.push({ name: `school:${tagSlug(schoolName)}`, status: "active" });

      const tagsResp = await fetch(`${mcBase}/lists/${audienceId}/members/${memberHash}/tags`, {
        method: "POST",
        headers: { Authorization: mcAuth, "Content-Type": "application/json" },
        body: JSON.stringify({ tags }),
      });
      if (!tagsResp.ok && tagsResp.status !== 204) {
        // Non-fatal — we logged the upsert success. Surface in audit.
        const errBody = (await tagsResp.text()).slice(0, 240);
        await admin.from("mailchimp_sync_log").insert({
          direction: "outbound",
          event: "tag_failure",
          parent_email: row.parent_email,
          student_id: row.student_id,
          status: tagsResp.status,
          payload: { tags },
          error: errBody,
        });
      }

      await admin
        .from("mailchimp_sync_outbox")
        .update({ completed_at: new Date().toISOString(), last_error: null })
        .eq("id", row.id);

      await admin.from("mailchimp_sync_log").insert({
        direction: "outbound",
        event: "upsert",
        parent_email: row.parent_email,
        student_id: row.student_id,
        status: upsertResp.status,
        payload: { merge_fields: mergeFields, tags: tags.map((t) => t.name) },
        error: null,
      });

      ok += 1;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await admin
        .from("mailchimp_sync_outbox")
        .update({ last_error: errMsg.slice(0, 1000) })
        .eq("id", row.id);
      await admin.from("mailchimp_sync_log").insert({
        direction: "outbound",
        event: "failure",
        parent_email: row.parent_email,
        student_id: row.student_id,
        status: 0,
        payload: null,
        error: errMsg.slice(0, 1000),
      });
      failed += 1;
    }
  }

  return jsonResponse(200, { processed: rows.length, ok, failed });
});
