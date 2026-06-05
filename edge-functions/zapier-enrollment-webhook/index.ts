import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-zap-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const startMs = Date.now();
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ZAP_SECRET = Deno.env.get("ZAP_SECRET");

  if (!ZAP_SECRET) return json({ error: "ZAP_SECRET not configured" }, 503);
  const provided = req.headers.get("X-Zap-Secret") ?? req.headers.get("x-zap-secret") ?? "";
  if (provided !== ZAP_SECRET) return json({ error: "Forbidden — bad or missing X-Zap-Secret" }, 403);

  const service = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let rawBody = "";
  let payload: Record<string, unknown> = {};
  try {
    rawBody = await req.text();
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch (e) {
    await service.from("sync_log").insert({
      source: "zapier", operation: "enrollment_webhook",
      status: "error", message: `Bad JSON: ${(e as Error).message}`,
      payload: { raw_preview: rawBody.slice(0, 800) },
      duration_ms: Date.now() - startMs,
    });
    return json({ error: "Invalid JSON", detail: (e as Error).message }, 400);
  }

  if (isZapierEmptyKeyWrap(payload)) {
    try { payload = JSON.parse(payload[""] as string); } catch (_) {}
  }
  for (const nestedKey of ["student", "enrollment", "family"]) {
    const v = payload[nestedKey];
    if (typeof v === "string" && v.trim().startsWith("{")) {
      try { payload[nestedKey] = JSON.parse(v); } catch (_) {}
    }
  }

  const eventType = firstDefined(payload.event_type, payload.eventType, payload.type) as string | undefined;
  if (!eventType) {
    await service.from("sync_log").insert({
      source: "zapier", operation: "enrollment_webhook",
      status: "error", message: "Missing event_type",
      payload: { received: payload, raw_preview: rawBody.slice(0, 600) },
      duration_ms: Date.now() - startMs,
    });
    return json({ error: "Missing event_type", received_keys: Object.keys(payload) }, 400);
  }

  try {
    const result = await route(service, eventType, payload);
    await service.from("sync_log").insert({
      source: "zapier", operation: `enrollment_webhook:${eventType}`,
      status: result.status, message: result.message,
      external_id: result.external_id ?? null,
      local_id: result.local_id ?? null,
      payload: { event_type: eventType, raw: payload, actions: result.actions },
      duration_ms: Date.now() - startMs,
    });
    return json(result, 200);
  } catch (e) {
    await service.from("sync_log").insert({
      source: "zapier", operation: `enrollment_webhook:${eventType}`,
      status: "error", message: (e as Error).message,
      payload: { event_type: eventType, raw: payload },
      duration_ms: Date.now() - startMs,
    });
    return json({ error: (e as Error).message }, 500);
  }
});

function isZapierEmptyKeyWrap(p: Record<string, unknown>): boolean {
  const keys = Object.keys(p);
  return keys.length === 1 && keys[0] === "" && typeof p[""] === "string" && (p[""] as string).trim().startsWith("{");
}

type RouteResult = { status: "ok" | "partial" | "error" | "skipped"; message: string; actions?: string[]; external_id?: string; local_id?: string };

async function route(svc: any, eventType: string, p: Record<string, unknown>): Promise<RouteResult> {
  switch (eventType) {
    case "enrollment.new":             return await handleEnrollmentNew(svc, p);
    case "enrollment.dropped":         return await handleEnrollmentDropped(svc, p);
    case "enrollment.reason_changed":  return await handleEnrollmentReasonChanged(svc, p);
    case "student.updated":            return await handleStudentUpdated(svc, p);
    case "student.inactive":           return await handleStudentInactive(svc, p);
    default:
      return { status: "skipped", message: `Unknown event_type: ${eventType}` };
  }
}

async function handleEnrollmentNew(svc: any, p: Record<string, unknown>): Promise<RouteResult> {
  const actions: string[] = [];
  const studentInfo = extractStudent(p);
  const enrollInfo = extractEnrollment(p);

  const student = await upsertStudent(svc, studentInfo, p);
  actions.push(`student ${student.action}: ${student.id}`);

  const classRow = enrollInfo.jackrabbit_class_id ? await svc.from("classes")
    .select("id").eq("jackrabbit_class_id", enrollInfo.jackrabbit_class_id).maybeSingle() : { data: null };
  const classId = classRow.data?.id ?? null;
  if (!classId && enrollInfo.jackrabbit_class_id) {
    actions.push(`class not yet synced: ${enrollInfo.jackrabbit_class_id}`);
  }

  let existing: { id: string } | null = null;
  if (enrollInfo.jackrabbit_enrollment_id) {
    const found = await svc.from("enrollments").select("id")
      .eq("jackrabbit_enrollment_id", enrollInfo.jackrabbit_enrollment_id).maybeSingle();
    existing = found.data;
  }
  if (!existing && classId) {
    // Tertiary: match active/backfilled enrollment for this student+class
    const found = await svc.from("enrollments").select("id")
      .eq("class_id", classId).eq("student_id", student.id).in("status", ["active", "waitlist", "trial"]).maybeSingle();
    existing = found.data;
  }

  const row = {
    jackrabbit_enrollment_id: enrollInfo.jackrabbit_enrollment_id,
    class_id: classId,
    student_id: student.id,
    status: normalizeEnrollStatus(enrollInfo.status) || "active",
    notes: enrollInfo.notes ?? null,
    last_pulled_fields: p,
  };

  if (existing) {
    const { error } = await svc.from("enrollments").update(row).eq("id", existing.id);
    if (error) return { status: "error", message: `Update enrollment failed: ${error.message}`, actions };
    actions.push(`enrollment updated (backfilled JR id if new): ${existing.id}`);
    return { status: "ok", message: "Enrollment updated", actions, local_id: existing.id, external_id: enrollInfo.jackrabbit_enrollment_id };
  }

  if (!classId) {
    return { status: "partial", message: "Class not synced; enrollment not inserted yet.", actions, external_id: enrollInfo.jackrabbit_class_id };
  }
  const { data: inserted, error } = await svc.from("enrollments").insert({ ...row, class_id: classId }).select("id").single();
  if (error) return { status: "error", message: `Insert enrollment failed: ${error.message}`, actions };
  actions.push(`enrollment inserted: ${inserted.id}`);
  return { status: "ok", message: "Enrollment created", actions, local_id: inserted.id, external_id: enrollInfo.jackrabbit_enrollment_id };
}

async function handleEnrollmentDropped(svc: any, p: Record<string, unknown>): Promise<RouteResult> {
  const actions: string[] = [];
  const enrollInfo = extractEnrollment(p);
  const studentInfo = extractStudent(p);
  const student = await upsertStudent(svc, studentInfo, p);

  let existing: { id: string } | null = null;
  if (enrollInfo.jackrabbit_enrollment_id) {
    const found = await svc.from("enrollments").select("id")
      .eq("jackrabbit_enrollment_id", enrollInfo.jackrabbit_enrollment_id).maybeSingle();
    existing = found.data;
  }
  if (!existing) {
    const classRow = enrollInfo.jackrabbit_class_id ? await svc.from("classes")
      .select("id").eq("jackrabbit_class_id", enrollInfo.jackrabbit_class_id).maybeSingle() : { data: null };
    if (classRow.data?.id) {
      const found = await svc.from("enrollments").select("id")
        .eq("class_id", classRow.data.id).eq("student_id", student.id).in("status", ["active", "waitlist", "trial"]).maybeSingle();
      existing = found.data;
    }
  }
  if (!existing) return { status: "skipped", message: "No matching active enrollment to drop", actions };

  const { error } = await svc.from("enrollments").update({
    status: "dropped",
    dropped_at: new Date().toISOString(),
    drop_reason: enrollInfo.reason ?? null,
    jackrabbit_enrollment_id: enrollInfo.jackrabbit_enrollment_id ?? undefined,
    last_pulled_fields: p,
  }).eq("id", existing.id);
  if (error) return { status: "error", message: `Drop failed: ${error.message}`, actions };
  return { status: "ok", message: "Enrollment dropped", actions: [...actions, `dropped: ${existing.id}`], local_id: existing.id };
}

async function handleEnrollmentReasonChanged(svc: any, p: Record<string, unknown>): Promise<RouteResult> {
  const enrollInfo = extractEnrollment(p);
  if (!enrollInfo.jackrabbit_enrollment_id) return { status: "error", message: "Missing jackrabbit_enrollment_id" };
  const { data: found } = await svc.from("enrollments").select("id")
    .eq("jackrabbit_enrollment_id", enrollInfo.jackrabbit_enrollment_id).maybeSingle();
  if (!found) return { status: "skipped", message: "No matching enrollment" };
  const { error } = await svc.from("enrollments").update({
    drop_reason: enrollInfo.reason ?? null,
    status: normalizeEnrollStatus(enrollInfo.status) || undefined,
    last_pulled_fields: p,
  }).eq("id", found.id);
  if (error) return { status: "error", message: `Update failed: ${error.message}` };
  return { status: "ok", message: "Reason/status updated", local_id: found.id };
}

async function handleStudentUpdated(svc: any, p: Record<string, unknown>): Promise<RouteResult> {
  const info = extractStudent(p);
  const student = await upsertStudent(svc, info, p);
  return { status: "ok", message: `Student ${student.action}`, local_id: student.id, external_id: info.jackrabbit_student_id };
}

async function handleStudentInactive(svc: any, p: Record<string, unknown>): Promise<RouteResult> {
  const info = extractStudent(p);
  const student = await upsertStudent(svc, info, p);
  const { error } = await svc.from("students").update({ status: "inactive", last_pulled_fields: p }).eq("id", student.id);
  if (error) return { status: "error", message: `Update failed: ${error.message}` };
  return { status: "ok", message: "Student marked inactive", local_id: student.id };
}

interface StudentInfo {
  jackrabbit_student_id?: string;
  first_name?: string;
  last_name?: string;
  dob?: string;
  gender?: string;
  family_id?: string;
  parent_emails: string[];
  parent_names: string[];
  parent_phones: string[];
  status?: string;
  notes?: string;
}

interface EnrollmentInfo {
  jackrabbit_enrollment_id?: string;
  jackrabbit_class_id?: string;
  status?: string;
  reason?: string;
  notes?: string;
}

function extractStudent(p: Record<string, unknown>): StudentInfo {
  const s = (p.student ?? p.Student ?? {}) as Record<string, unknown>;
  const f = (p.family ?? p.Family ?? {}) as Record<string, unknown>;
  const jrId = firstDefined(
    p.jackrabbit_student_id, p.student_id, p.StudentID, p.studentId,
    s.ID, s.StudentID, s.id
  );
  return {
    jackrabbit_student_id: jrId != null && String(jrId) !== "" ? String(jrId) : undefined,
    first_name: firstString(s.FirstName, s.first_name, s.firstName),
    last_name: firstString(s.LastName, s.last_name, s.lastName),
    dob: firstString(s.DoB, s.DOB, s.DateOfBirth, s.dob, s.date_of_birth),
    gender: firstString(s.Gender, s.gender),
    family_id: firstString(p.family_id, p.FamilyID, s.FamilyID, s.family_id, f.ID, f.id),
    // Jackrabbit's family feed sometimes packs both parent addresses into ONE
    // field comma-joined ("a@x.com,b@y.com"), or repeats the same address. Split
    // on comma/semicolon so each address lands as its own array element — a
    // comma-joined string is not a valid email and breaks the Mailchimp drain.
    parent_emails: collectEmails([f.PrimaryEmail, f.SecondaryEmail, f.Email, f.primary_email, f.secondary_email, p.parent_email, p.ParentEmail]),
    parent_names:  collectStrings([f.PrimaryName, f.SecondaryName, f.PrimaryContactName, p.parent_name]),
    parent_phones: collectStrings([f.PrimaryPhone, f.SecondaryPhone, f.Phone, p.parent_phone]),
    status: firstString(s.Status, s.status),
    notes: firstString(s.Notes, s.notes),
  };
}

function extractEnrollment(p: Record<string, unknown>): EnrollmentInfo {
  const e = (p.enrollment ?? p.Enrollment ?? {}) as Record<string, unknown>;
  return {
    jackrabbit_enrollment_id: firstString(
      p.jackrabbit_enrollment_id, p.enrollment_id, p.EnrollmentID, e.ID, e.EnrollmentID, e.id
    ),
    jackrabbit_class_id: firstString(
      p.jackrabbit_class_id, p.class_id, p.ClassID, e.ClassID, e.class_id
    ),
    status: firstString(e.Status, e.status, p.status),
    reason: firstString(e.Reason, e.reason, p.reason, e.DropReason, e.EnrollReason),
    notes: firstString(e.Notes, e.notes),
  };
}

// Upsert with FOUR tiered matching strategies so bulk-imported students (without
// JR IDs) get their IDs backfilled when the first Zap fires for them:
//   1. Match by jackrabbit_student_id (best — stable JR id)
//   2. Match by (family_id, first_name, last_name) (good — family-scoped)
//   3. Match by (first_name, last_name, dob) (backfill path — catches imports)
//   4. Match by (first_name, last_name) alone (last-resort, only if dob unknown)
async function upsertStudent(svc: any, info: StudentInfo, raw: Record<string, unknown>): Promise<{ id: string; action: "inserted" | "updated" | "matched" }> {
  let existingId: string | null = null;

  if (info.jackrabbit_student_id) {
    const { data } = await svc.from("students").select("id")
      .eq("jackrabbit_student_id", info.jackrabbit_student_id).maybeSingle();
    existingId = data?.id ?? null;
  }
  if (!existingId && info.family_id && info.first_name && info.last_name) {
    const { data } = await svc.from("students").select("id")
      .eq("family_id", info.family_id)
      .eq("first_name", info.first_name)
      .eq("last_name", info.last_name).maybeSingle();
    existingId = data?.id ?? null;
  }
  if (!existingId && info.first_name && info.last_name && info.dob) {
    const { data } = await svc.from("students").select("id")
      .eq("first_name", info.first_name)
      .eq("last_name", info.last_name)
      .eq("dob", parseDate(info.dob)).maybeSingle();
    existingId = data?.id ?? null;
  }
  if (!existingId && info.first_name && info.last_name) {
    // Last resort: name-only match. Only safe for uncommon names; we take the first result.
    const { data } = await svc.from("students").select("id")
      .eq("first_name", info.first_name)
      .eq("last_name", info.last_name).maybeSingle();
    existingId = data?.id ?? null;
  }

  const row: Record<string, unknown> = {
    jackrabbit_student_id: info.jackrabbit_student_id,
    first_name: info.first_name,
    last_name: info.last_name,
    dob: parseDate(info.dob),
    gender: info.gender,
    family_id: info.family_id,
    parent_emails: info.parent_emails,
    parent_names:  info.parent_names,
    parent_phones: info.parent_phones,
    last_pulled_fields: raw,
  };
  Object.keys(row).forEach((k) => { if (row[k] === undefined) delete row[k]; });

  if (existingId) {
    await svc.from("students").update(row).eq("id", existingId);
    return { id: existingId, action: "updated" };
  }
  const { data: inserted, error } = await svc.from("students").insert({ ...row, status: "active" }).select("id").single();
  if (error) throw new Error(`Student insert failed: ${error.message}`);
  return { id: inserted.id, action: "inserted" };
}

function normalizeEnrollStatus(s?: string): string | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (/active|enrolled/.test(t)) return "active";
  if (/wait/.test(t)) return "waitlist";
  if (/drop|unenroll/.test(t)) return "dropped";
  if (/complet/.test(t)) return "completed";
  if (/trial/.test(t)) return "trial";
  return null;
}

function firstDefined(...vals: unknown[]): unknown {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}
function firstString(...vals: unknown[]): string | undefined {
  const v = firstDefined(...vals);
  return v == null ? undefined : String(v);
}
function collectStrings(vals: unknown[]): string[] {
  const out = new Set<string>();
  for (const v of vals) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => { if (x != null && x !== "") out.add(String(x)); });
    else out.add(String(v));
  }
  return [...out];
}
// Like collectStrings but for email fields: each incoming value may itself be a
// comma/semicolon-joined list of addresses. Split, trim, lowercase, drop empties,
// dedupe — so parent_emails is always one valid address per array element. Mirrors
// the DB-side dk_normalize_emails() helper (defense-in-depth on both layers).
function collectEmails(vals: unknown[]): string[] {
  const out = new Set<string>();
  for (const v of vals) {
    if (v == null || v === "") continue;
    const pieces = Array.isArray(v) ? v.map((x) => String(x)) : [String(v)];
    for (const piece of pieces) {
      for (const e of piece.split(/[,;]/)) {
        const cleaned = e.trim().toLowerCase();
        if (cleaned) out.add(cleaned);
      }
    }
  }
  return [...out];
}
function parseDate(s?: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
