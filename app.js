/* Drama Kids Response Console — v3 (Supabase-backed)
 *
 * All data comes from the Supabase Postgres database. Writes hit the DB
 * directly; no local persistence layer. Authentication is required;
 * unauthenticated users see the login screen.
 */

(function () {
  "use strict";

  /* ═════════════ Supabase client ═════════════ */

  if (!window.supabase || !window.DK_CONFIG) {
    alert("Config or Supabase SDK not loaded — check config.js and CDN script tag.");
    return;
  }
  const sb = window.supabase.createClient(window.DK_CONFIG.supabaseUrl, window.DK_CONFIG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
  window.__dk_supabase = sb; // expose for debugging

  /* ═════════════ In-memory state ═════════════ */

  const state = {
    session: null,
    profile: null,
    categories: [],
    templates: [],
    classes: [],
    infographics: [],
    teachers: [],
    classTeachers: [],      // rows { class_id, teacher_id, role, start_date, end_date, notes }
    classInfographics: [],  // rows { class_id, infographic_id, sort_order, notes }
    students: [],
    enrollments: [],
    attendance: [],         // attendance rows (enrollment-scoped); RLS-filtered per role
    clockIns: [],           // clock_ins rows; teacher sees own, admin sees all
    matchCandidates: [],    // unresolved student_match_candidates rows (admin-visible)
    teacherInvitations: [],
    closures: [],
    dkConfig: null,
    latestSyncLog: null,
    tState: { query: "", category: "all", filled: {} },
    igState: { query: "", tag: "all" },
    cState: { showTest: false, openClassId: null },
    // Schedule state: `anchor` is the currently-focused date (ISO); mode is
    // day/week/month; onlyMine filters to the signed-in teacher's assignments.
    sState: { mode: "day", anchor: isoDate(new Date()), onlyMine: false },
    // Reports tab state: active report id + date range (ISO). Defaults to
    // last 30 days including today.
    rptState: { active: "attendance", start: null, end: null },
    router: "home"
  };

  // Need to compute isoDate BEFORE the state initializer references it;
  // hoist via function declaration.
  function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /* ═════════════ Role + permissions (client-side UI gating) ═════════════
   *
   * These helpers mirror the SQL `has_permission(perm)` function exactly,
   * so UI gating and RLS enforcement agree. Client-side checks never grant
   * anything — they only hide UI that would fail RLS anyway. All real
   * enforcement happens server-side via RLS on Supabase.
   *
   * T1 scope: UI gating only. The RLS policies on templates/categories/
   * infographics still require is_admin() for writes, so manager +
   * viewer are effectively read-only in the console. Extending RLS for
   * manager write access is deferred to T1.5 or T6.
   */

  const PERM_BUNDLES = {
    super_admin: [
      "manage_billing","manage_super_admins","manage_admins",
      "manage_org","hard_delete","manage_users",
      "edit_classes","edit_teachers","edit_students","edit_enrollments","edit_attendance",
      "edit_templates","edit_categories","edit_infographics",
      "view_pay_rates","view_billing_status","view_parent_contact",
      "run_jackrabbit_sync","respond_to_leads",
      "reconcile_students"
    ],
    admin: [
      "manage_users",
      "edit_classes","edit_teachers","edit_students","edit_enrollments","edit_attendance",
      "edit_templates","edit_categories","edit_infographics",
      "view_pay_rates","view_billing_status","view_parent_contact",
      "run_jackrabbit_sync","respond_to_leads",
      "reconcile_students"
    ],
    manager: [
      "edit_templates","edit_categories","edit_infographics",
      "respond_to_leads",
      "view_classes_readonly","view_teachers_readonly",
      "view_students_readonly","view_enrollments_readonly"
    ],
    teacher: [
      "view_own_schedule","take_own_attendance","clock_in_out",
      "view_own_curriculum","view_own_pay_history","request_sub",
      "view_own_roster","manage_own_roster_students","manage_own_enrollments"
    ],
    viewer: [
      "view_classes_readonly","view_teachers_readonly","view_students_readonly",
      "view_enrollments_readonly","view_attendance_readonly","view_billing_status_readonly"
    ]
  };

  // Test classes are marked with is_test=true. The Classes tab has a toggle
  // (cState.showTest) to display them; this helper lets the bento + schedule
  // views honor that same toggle so flipping it once reveals them everywhere.
  function includeTestClass(c) { return !!c && (state.cState.showTest || !c.is_test); }

  function currentRole() { return state.profile ? state.profile.role : null; }
  function isRole(r) { return currentRole() === r; }
  function isSuperAdmin() { return isRole("super_admin"); }
  function isAdminOrAbove() { return isRole("super_admin") || isRole("admin"); }

  function hasPerm(perm) {
    const role = currentRole();
    if (!role) return false;
    const granted = (state.profile.granted_permissions || []);
    const revoked = (state.profile.revoked_permissions || []);
    if (revoked.includes(perm)) return false;
    if (granted.includes(perm)) return true;
    return (PERM_BUNDLES[role] || []).includes(perm);
  }

  // Which tabs each role is allowed to see. (Role Management tab doesn't
  // exist in T1 — it lands in T6.)
  const ROLE_TAB_VISIBILITY = {
    super_admin: new Set(["home","schedule","templates","classes","teachers","categories","infographics","reports"]),
    admin:       new Set(["home","schedule","templates","classes","teachers","categories","infographics","reports"]),
    manager:     new Set(["home","schedule","templates","classes","teachers","categories","infographics"]),
    teacher:     new Set(["home","schedule"]),
    viewer:      new Set(["home","schedule","templates","classes","teachers","categories","infographics"])
  };
  function canSeeTab(tab) {
    const role = currentRole();
    if (!role) return false;
    return (ROLE_TAB_VISIBILITY[role] || new Set()).has(tab);
  }

  // True for admin+super_admin: can mutate classes/teachers/templates/etc.
  // via RLS. In T1, manager and viewer can't mutate anything server-side.
  function canMutate() { return isAdminOrAbove(); }

  // Friendly role label
  function roleLabel(r) {
    return ({
      super_admin: "Super admin",
      admin: "Admin",
      manager: "Manager",
      teacher: "Teacher",
      viewer: "Viewer"
    })[r] || (r || "No role");
  }

  /* ═════════════ Helpers ═════════════ */

  const $  = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function escapeHtml(s) {
    return (s || "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]);
  }
  function slugify(s) {
    return (s || "").toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 50) || ("item-" + Date.now());
  }
  function uniqueSlug(base, existing) {
    if (!existing.has(base)) return base;
    let i = 2;
    while (existing.has(base + "-" + i)) i++;
    return base + "-" + i;
  }
  function detectVars(body) {
    const set = new Set();
    (body || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (m, n) => set.add(n));
    return Array.from(set);
  }
  function showToast(msg, kind) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast visible" + (kind ? " " + kind : "");
    setTimeout(() => t.classList.remove("visible"), 2400);
  }
  function flashCopied(btn) {
    if (!btn) return;
    const o = btn.textContent;
    btn.textContent = "Copied ✓";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = o; btn.classList.remove("copied"); }, 1300);
  }
  function showLoader(on) { $("#loader").classList.toggle("visible", !!on); }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (_) {}
      document.body.removeChild(ta);
      return true;
    }
  }
  async function copyImageBytes(src) {
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function publicUrlFor(storagePath) {
    if (!storagePath) return null;
    const { data } = sb.storage.from("infographics").getPublicUrl(storagePath);
    return data && data.publicUrl;
  }

  /* ═════════════ Auth ═════════════ */

  async function initAuth() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
      state.session = session;
      await bootApp();
    } else {
      showLogin();
    }
    sb.auth.onAuthStateChange(async (event, session) => {
      state.session = session || null;
      if (!session) {
        // Signed out
        showLogin();
        return;
      }
      // We have a session. If the login screen is still the visible one,
      // that means a session just arrived from elsewhere — likely the
      // magic-link redirect finishing its hash handoff. Boot the app.
      if ($("#loginScreen").style.display !== "none") {
        await bootApp();
      }
    });
  }

  function showLogin() {
    $("#app").style.display = "none";
    $("#loginScreen").style.display = "";
  }

  async function bootApp() {
    $("#loginScreen").style.display = "none";
    $("#app").style.display = "";
    await loadProfile();

    // If the user doesn't yet have a role, give par-identity-proxy a chance
    // to auto-promote them synchronously (it might — if this email is linked
    // to a PAR identity that owns the configured franchise org). We await
    // the refresh so the no-role screen isn't shown for a user who was just
    // about to be auto-promoted.
    if (!currentRole()) {
      try { await refreshParIdentity(); } catch (_) { /* swallow — fall through */ }
      // Re-pull profile so we see any role change the Edge Function wrote.
      try {
        const { data: refreshed } = await sb.from("profiles").select("*").eq("id", state.session.user.id).single();
        if (refreshed) state.profile = refreshed;
      } catch (_) { /* ignore */ }
    }

    if (!currentRole()) {
      showNoRoleScreen();
      return;
    }

    renderUserChip();
    await reloadAll();
    wireEvents();
    applyRoleVisibility();
    renderAll();
    // Default router may be a tab this role can't see — fall back to home.
    const startTab = canSeeTab(state.router) ? state.router : "home";
    go(startTab);
    setupRealtime();
  }

  /* No-role screen.
   *
   * Two distinct states fold into role=null:
   *   (a) Email IS linked to a PAR identity (par_person_id populated), but
   *       the PAR identity doesn't own or admin the configured franchise
   *       org. Real case: invited teachers/managers waiting for their admin
   *       to complete the promotion, or a DK profile that pre-existed the
   *       install flow. Message: "waiting for admin to assign a role."
   *   (b) Email is NOT linked to PAR at all (par_person_id is null). Most
   *       common case when someone (Sharon) signs into DK with a work email
   *       they never linked to their PAR identity. The fix: link it on PAR.
   *       Message: deep-link to PAR's linked-accounts UI.
   */
  function showNoRoleScreen() {
    $("#app").style.display = "none";
    $("#loginScreen").style.display = "none";
    $("#noRoleScreen").style.display = "";
    const user = state.session?.user;
    const parLinked = !!state.profile?.par_person_id;
    const titleEl = $("#noRoleTitle");
    const subEl   = $("#noRoleSub");
    const line    = $("#noRoleUserLine");
    const ctaEl   = $("#noRolePrimaryCta");
    const footEl  = $("#noRoleFootnote");

    if (titleEl) {
      titleEl.textContent = parLinked ? "Waiting for access" : "One more setup step";
    }
    if (subEl) {
      subEl.textContent = parLinked ? "Role not yet assigned" : "Link this email to your PAR identity";
    }
    if (line && user) {
      line.innerHTML = `Signed in as <b>${escapeHtml(user.email || "")}</b>.`;
    }
    if (footEl) {
      footEl.innerHTML = parLinked
        ? "Your account is linked to PAR, but hasn't been granted a role in this franchise yet. Ask your franchise admin to assign you a role, then refresh this page."
        : "This email isn't linked to your PAR identity yet. Open PAR's Linked Accounts settings (below), add this email there, verify the link PAR sends, then come back here and refresh.";
    }
    if (ctaEl) {
      if (parLinked) {
        ctaEl.style.display = "none";
      } else {
        ctaEl.style.display = "";
        ctaEl.href = "https://get-on-par.com/?view=settings&tab=linked-accounts";
        ctaEl.textContent = "Open PAR Linked Accounts →";
      }
    }

    const btn = $("#noRoleSignOut");
    if (btn) {
      btn.onclick = async () => {
        await sb.auth.signOut();
        state.session = null; state.profile = null;
        $("#noRoleScreen").style.display = "none";
        showLogin();
      };
    }
  }

  /* ═════════════ Realtime subscriptions ═════════════
   * Any insert/update/delete on a watched table triggers a debounced
   * reloadAll + renderAll. Covers:
   *   - user actions from this browser (instant echo, harmless)
   *   - user actions from another tab / device
   *   - Zapier webhooks creating enrollments / students
   *   - Scheduled jobs (nightly Jackrabbit sync) updating classes
   *   - par-identity-proxy caching identity on profiles
   * Debounce prevents N re-renders when a burst of events lands.
   */
  let realtimeChannel = null;
  let realtimeReloadTimer = null;

  function setupRealtime() {
    if (realtimeChannel) return;
    const tablesToWatch = [
      "profiles", "categories", "templates", "classes", "infographics",
      "teachers", "class_teachers", "class_infographics",
      "students", "enrollments", "attendance", "clock_ins", "sync_log",
      "teacher_invitations", "dk_config", "closures",
      "student_match_candidates"
    ];
    realtimeChannel = sb.channel("dk-realtime");
    tablesToWatch.forEach((table) => {
      realtimeChannel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        (_payload) => scheduleRealtimeReload()
      );
    });
    realtimeChannel.subscribe((status) => {
      if (status === "SUBSCRIBED") console.log("[realtime] subscribed to", tablesToWatch.length, "tables");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        console.warn("[realtime] connection issue:", status, "— will rely on manual reloads until next boot");
      }
    });
  }

  function scheduleRealtimeReload() {
    clearTimeout(realtimeReloadTimer);
    realtimeReloadTimer = setTimeout(async () => {
      await reloadAll();
      renderAll();
    }, 300);
  }

  async function loadProfile() {
    const { data, error } = await sb.from("profiles").select("*").eq("id", state.session.user.id).single();
    if (error) { console.warn("Profile load:", error); return; }
    state.profile = data;
    // Fire-and-forget PAR identity sync — updates profile cache on the backend
    refreshParIdentity().catch((e) => console.warn("PAR identity check failed:", e));
  }

  async function refreshParIdentity() {
    try {
      const { data, error } = await sb.functions.invoke("par-identity-proxy", { body: {} });
      if (error) throw error;
      // The Edge Function writes the cache to profiles directly; re-fetch locally.
      const { data: fresh } = await sb.from("profiles").select("*").eq("id", state.session.user.id).single();
      if (fresh) {
        state.profile = fresh;
        renderUserChip();
      }
      return data;
    } catch (e) {
      console.warn("PAR identity sync failed:", e);
      return null;
    }
  }

  function renderUserChip() {
    const chip = $("#userChip");
    if (!chip || !state.profile) return;
    const displayName = state.profile.par_display_name || state.profile.full_name || state.session?.user?.email || "";
    const parLinked = !!state.profile.par_person_id;
    chip.innerHTML = "";
    const name = document.createElement("span");
    name.textContent = displayName;
    chip.appendChild(name);
    // Role badge — visible at a glance which view the user is in
    const role = currentRole();
    if (role) {
      const rb = document.createElement("span");
      rb.className = "role-badge role-" + role;
      rb.textContent = roleLabel(role);
      rb.title = "Your role in this DK franchise";
      chip.appendChild(rb);
    }
    if (parLinked) {
      const badge = document.createElement("span");
      badge.className = "par-linked-badge";
      badge.title = "Linked to PAR identity: " + (state.profile.par_primary_email || "");
      badge.textContent = "PAR \u2713";
      chip.appendChild(badge);
    } else {
      const cta = document.createElement("a");
      cta.href = "https://get-on-par.com/?view=settings&tab=linked-accounts";
      cta.target = "_blank";
      cta.rel = "noopener";
      cta.className = "par-connect-cta";
      cta.title = "Opens PAR's Linked Accounts settings in a new tab";
      cta.textContent = "Connect to PAR \u2192";
      chip.appendChild(cta);
    }
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#loginEmail").value.trim();
    const password = $("#loginPassword").value;
    const errEl = $("#loginError");
    const magicStatusEl = $("#loginMagicStatus");
    errEl.classList.remove("visible");
    if (magicStatusEl) { magicStatusEl.textContent = ""; magicStatusEl.className = "login-magic-status"; }
    if (!password) {
      errEl.textContent = "Enter a password, or use the magic-link button below instead.";
      errEl.classList.add("visible");
      return;
    }
    showLoader(true);
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    showLoader(false);
    if (error) {
      errEl.textContent = error.message || "Sign-in failed.";
      errEl.classList.add("visible");
      return;
    }
    state.session = data.session;
    await bootApp();
  });

  // Magic-link / OTP sign-in. Works for both first-time users (auto-creates
  // the auth.users row on first click) and returning users who don't want to
  // type a password. The link email Supabase sends points back at this
  // origin; the SDK's detectSessionInUrl picks up the hash and establishes
  // a session, which onAuthStateChange routes through bootApp().
  $("#loginMagicLink").addEventListener("click", async () => {
    const email = $("#loginEmail").value.trim();
    const errEl = $("#loginError");
    const statusEl = $("#loginMagicStatus");
    errEl.classList.remove("visible");
    statusEl.textContent = "";
    statusEl.className = "login-magic-status";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errEl.textContent = "Enter your email first, then click the magic-link button.";
      errEl.classList.add("visible");
      return;
    }
    showLoader(true);
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    showLoader(false);
    if (error) {
      errEl.textContent = error.message || "Couldn't send the link. Try again in a minute.";
      errEl.classList.add("visible");
      return;
    }
    statusEl.className = "login-magic-status success";
    statusEl.innerHTML =
      "Sent. Check <b>" + escapeHtml(email) + "</b> for a link from Supabase. " +
      "Click it to finish signing in — this tab will pick up the session automatically.";
  });

  /* ═════════════ Data loading ═════════════ */

  async function reloadAll() {
    showLoader(true);
    try {
      const [cats, tpls, cls, igs, tch, ct, ci, stu, enr, invites, cfg, closures, syncLog, matches, att, clk] = await Promise.all([
        sb.from("categories").select("*").order("sort_order", { ascending: true }),
        sb.from("templates").select("*").order("created_at", { ascending: true }),
        sb.from("classes").select("*").order("name", { ascending: true }),
        sb.from("infographics").select("*").order("name", { ascending: true }),
        sb.from("teachers").select("*").order("full_name", { ascending: true }),
        sb.from("class_teachers").select("*"),
        sb.from("class_infographics").select("*"),
        sb.from("students").select("*").order("last_name", { ascending: true }),
        sb.from("enrollments").select("*").order("enrolled_at", { ascending: false }),
        sb.from("teacher_invitations").select("*").order("sent_at", { ascending: false }),
        sb.from("dk_config").select("*").eq("id", 1).maybeSingle(),
        sb.from("closures").select("*").order("date", { ascending: true }),
        sb.from("sync_log").select("*").eq("source", "jackrabbit").eq("operation", "pull_openings").order("created_at", { ascending: false }).limit(1).maybeSingle(),
        sb.from("student_match_candidates").select("*").is("resolved_at", null).order("detected_at", { ascending: false }),
        sb.from("attendance").select("*").order("session_date", { ascending: false }),
        sb.from("clock_ins").select("*").order("session_date", { ascending: false })
      ]);
      for (const r of [cats, tpls, cls, igs, tch, ct, ci, stu, enr]) if (r.error) throw r.error;
      // Non-admin roles may not have SELECT access to teacher_invitations /
      // dk_config (self-read RLS); swallow those errors so reloadAll doesn't fail.
      state.categories       = cats.data;
      state.templates        = tpls.data;
      state.classes          = cls.data;
      state.infographics     = igs.data;
      state.teachers         = tch.data;
      state.classTeachers    = ct.data;
      state.classInfographics = ci.data;
      state.students         = stu.data;
      state.enrollments      = enr.data;
      state.teacherInvitations = (invites && !invites.error) ? invites.data : [];
      state.dkConfig         = (cfg && !cfg.error) ? cfg.data : null;
      state.closures         = (closures && !closures.error) ? closures.data : [];
      state.latestSyncLog    = syncLog.data || null;
      // Non-admin roles can't SELECT student_match_candidates (admin-only RLS);
      // swallow the error and treat as empty — banners/chips just don't render.
      state.matchCandidates  = (matches && !matches.error) ? matches.data : [];
      // Attendance RLS: admins read all, teachers read their assigned classes,
      // managers/viewers read via view_attendance_readonly. Any error falls back
      // to empty — "coming soon"-style UI still renders.
      state.attendance       = (att && !att.error) ? att.data : [];
      // Clock-ins RLS: admins read all, teachers read own rows. Errors
      // (e.g. managers/viewers without perm) fall back to empty.
      state.clockIns         = (clk && !clk.error) ? clk.data : [];
    } catch (e) {
      console.error(e);
      showToast("Failed to load: " + e.message, "error");
    }
    showLoader(false);
  }

  function renderAll() {
    renderHomeTab();
    renderScheduleTab();
    renderInfographicsSidebar();
    renderCategoryChips();
    renderTemplates();
    renderClassesTab();
    renderTeachersTab();
    renderCategoriesTab();
    renderInfographicsTab();
    renderReportsTab();
  }

  /* ═════════════ HOME (Bento) ═════════════ */

  // Day-of-week abbreviations as stored in classes.days (populated by the
  // Jackrabbit sync: "Mon, Wed" style). Match regardless of order/spacing.
  const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DOW_LONG  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

  function classRunsOnDay(cls, date) {
    if (!cls) return false;
    // JR sync populates cls.days ("Mon, Wed"); the in-app class editor
    // populates cls.day_time ("Fridays, 3:00–3:45 PM"). Fall back to
    // day_time so manually-added classes also render on the schedule.
    const src = String(cls.days || cls.day_time || "").toLowerCase();
    if (!src) return false;
    const sd = cls.start_date ? new Date(cls.start_date + "T00:00:00") : null;
    const ed = cls.end_date   ? new Date(cls.end_date   + "T23:59:59") : null;
    if (sd && date < sd) return false;
    if (ed && date > ed) return false;
    const dayShort = DOW_SHORT[date.getDay()];
    const dayLong  = DOW_LONG[date.getDay()];
    return src.includes(dayShort.toLowerCase()) || src.includes(dayLong.toLowerCase());
  }

  // Parse a class's start time to a Date anchored to `onDate`. Prefers the
  // JR-synced cls.times ("3:00 PM - 3:45 PM") and falls back to cls.day_time
  // for in-app-edited classes ("Fridays, 3:00–3:45 PM").
  function classStartTimeOn(cls, onDate) {
    const src = cls?.times || cls?.day_time;
    if (!src) return null;
    const m = String(src).match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const isPm = m[3].toUpperCase() === "PM";
    if (isPm && h < 12) h += 12;
    if (!isPm && h === 12) h = 0;
    const d = new Date(onDate);
    d.setHours(h, mm, 0, 0);
    return d;
  }

  function formatRelativeTimeUntil(target) {
    const diffMs = target - new Date();
    if (diffMs <= 0) return "now";
    const min = Math.round(diffMs / 60000);
    if (min < 60) return `in ${min}m`;
    const hr = Math.floor(min / 60);
    const rem = min - hr * 60;
    if (hr < 12) return `in ${hr}h ${rem}m`;
    return `in ${hr}h`;
  }

  function formatRelativePast(date) {
    const diffMs = new Date() - date;
    if (diffMs < 0) return "just now";
    const sec = Math.round(diffMs / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    return `${day}d ago`;
  }

  function primaryTeacherOf(classId) {
    const ct = state.classTeachers.find((x) => x.class_id === classId && x.role === "primary");
    if (ct) return state.teachers.find((t) => t.id === ct.teacher_id);
    const any = state.classTeachers.find((x) => x.class_id === classId);
    return any ? state.teachers.find((t) => t.id === any.teacher_id) : null;
  }

  function renderHomeTab() {
    const grid = $("#bentoGrid");
    if (!grid) return;

    // Teachers get their own scoped bento. Admins/managers/viewers share the
    // existing admin bento; quick actions and pay-rate fields are gated
    // inside their own renderers.
    if (isRole("teacher")) {
      renderTeacherHome(grid);
      return;
    }

    const now = new Date();
    const todayClasses = state.classes
      .filter((c) => includeTestClass(c) && c.active !== false && classRunsOnDay(c, now))
      .map((c) => ({ cls: c, startAt: classStartTimeOn(c, now) }))
      .sort((a, b) => (a.startAt?.getTime() || 0) - (b.startAt?.getTime() || 0));

    const upcomingToday = todayClasses.filter((x) => x.startAt && x.startAt > now);
    const nextClass = upcomingToday[0];

    const activeClasses = state.classes.filter((c) => includeTestClass(c) && c.active !== false).length;
    const activeTeachers = state.teachers.filter((t) => t.status === "active").length;
    const activeEnrollments = state.enrollments.filter((e) => e.status === "active").length;

    grid.innerHTML = `
      <div class="bento-card bento-span-8">${renderTodayCard(nextClass, todayClasses.length, now)}</div>
      <div class="bento-card bento-span-4">${renderStatsCard(activeClasses, activeTeachers, activeEnrollments)}</div>
      <div class="bento-card bento-span-5" id="bentoSchedule">${renderScheduleCard(todayClasses, now)}</div>
      <div class="bento-card bento-span-4" id="bentoAttention">${renderAttentionCard()}</div>
      <div class="bento-card bento-span-3">${renderWeekCard(now)}</div>
      <div class="bento-card bento-span-5">${renderActivityCard()}</div>
      <div class="bento-card bento-span-4" id="bentoQuickActions">${renderQuickActionsCard()}</div>
      <div class="bento-card bento-span-3">${renderParBridgeCard()}</div>
    `;

    wireHomeCardEvents();
  }

  /* ═════════════ TEACHER HOME (bento) ═════════════
   *
   * Teacher-scoped home view. Pulls the teacher's own assignments via
   * email match (state.session.user.email → teachers.email). Once Phase
   * T2 lands, profiles will carry an explicit teacher_id link instead of
   * an email join.
   *
   * T1 cards: Welcome, Your next class, This week, Coming soon (T3+),
   * On PAR. Anything that needs attendance/clock-in/curriculum data is
   * stubbed honestly as "coming in Phase T3+" rather than faked.
   */
  function renderTeacherHome(grid) {
    const myEmail = (state.session?.user?.email || "").toLowerCase();
    const me = myEmail
      ? state.teachers.find((t) => (t.email || "").toLowerCase() === myEmail)
      : null;

    // If we can't find a teachers row for this user yet, show a "not yet
    // linked" welcome card and skip the schedule sections.
    if (!me) {
      grid.innerHTML = `
        <div class="bento-card bento-span-12">
          ${renderTeacherWelcomeCard(null)}
        </div>
        <div class="bento-card bento-span-6">
          ${renderTeacherComingSoonCard()}
        </div>
        <div class="bento-card bento-span-6">
          ${renderParBridgeCard()}
        </div>
      `;
      return;
    }

    const now = new Date();
    const myAssignments = state.classTeachers.filter((ct) => ct.teacher_id === me.id);
    const myClasses = myAssignments
      .map((ct) => state.classes.find((c) => c.id === ct.class_id))
      .filter((c) => c && includeTestClass(c) && c.active !== false);

    // Today's classes I'm assigned to
    const todayClasses = myClasses
      .filter((c) => classRunsOnDay(c, now))
      .map((c) => ({ cls: c, startAt: classStartTimeOn(c, now) }))
      .sort((a, b) => (a.startAt?.getTime() || 0) - (b.startAt?.getTime() || 0));
    const nextClass = todayClasses.find((x) => x.startAt && x.startAt > now);

    // Next 7 days I have classes
    let weekCount = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      d.setHours(0, 0, 0, 0);
      weekCount += myClasses.filter((c) => classRunsOnDay(c, d)).length;
    }

    grid.innerHTML = `
      <div class="bento-card bento-span-8">${renderTeacherTodayCard(nextClass, todayClasses.length, now)}</div>
      <div class="bento-card bento-span-4">${renderTeacherWeekStatsCard(myClasses.length, weekCount)}</div>
      <div class="bento-card bento-span-8">${renderTeacherScheduleCard(todayClasses, now)}</div>
      <div class="bento-card bento-span-4">${renderTeacherAttendanceCard(todayClasses, now)}</div>
      <div class="bento-card bento-span-12">${renderTeacherShiftsCard(me, todayClasses, now)}</div>
      <div class="bento-card bento-span-8">${renderTeacherWelcomeCard(me)}</div>
      <div class="bento-card bento-span-4">${renderParBridgeCard()}</div>
    `;

    wireHomeCardEvents();
  }

  function renderTeacherTodayCard(nextClass, todayCount, now) {
    if (!nextClass) {
      if (todayCount > 0) {
        return `
          <div class="bento-label"><span>Today</span></div>
          <div class="bento-today-headline">
            <span class="bento-today-icon">🌙</span>
            <div class="bento-today-body">
              <p class="bento-today-title">Today's classes are wrapped</p>
              <p class="bento-today-sub">${todayCount} class${todayCount === 1 ? "" : "es"} earlier today · none upcoming</p>
            </div>
          </div>
        `;
      }
      const dowLong = DOW_LONG[now.getDay()];
      return `
        <div class="bento-label"><span>Today</span></div>
        <div class="bento-today-headline">
          <span class="bento-today-icon">☀️</span>
          <div class="bento-today-body">
            <p class="bento-today-title">No classes for you on ${dowLong}</p>
            <p class="bento-today-sub">Enjoy the day off.</p>
          </div>
        </div>
      `;
    }
    const { cls, startAt } = nextClass;
    const when = formatRelativeTimeUntil(startAt);
    const timeStr = startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `
      <div class="bento-label">
        <span>Your next class</span>
        <span class="live-pill">Live</span>
      </div>
      <div class="bento-today-headline">
        <span class="bento-today-icon">🎭</span>
        <div class="bento-today-body">
          <p class="bento-today-title">${escapeHtml(cls.name)}</p>
          <p class="bento-today-sub">${timeStr} · ${when}${cls.location ? ` · ${escapeHtml(cls.location)}` : ""}</p>
        </div>
      </div>
    `;
  }

  function renderTeacherWeekStatsCard(myClassCount, weekSessionCount) {
    return `
      <div class="bento-label"><span>Your week</span></div>
      <div class="bento-stats">
        <div class="bento-stat-row">
          <span class="k"><span class="icon">🎭</span>Classes assigned</span>
          <span class="v">${myClassCount}</span>
        </div>
        <div class="bento-stat-row">
          <span class="k"><span class="icon">📅</span>Sessions this week</span>
          <span class="v">${weekSessionCount}</span>
        </div>
      </div>
    `;
  }

  function renderTeacherScheduleCard(todayClasses, now) {
    if (todayClasses.length === 0) {
      return `
        <div class="bento-label"><span>Today's schedule</span></div>
        <div class="bento-attention-empty">Nothing scheduled today.</div>
      `;
    }
    const items = todayClasses.map(({ cls, startAt }, i) => {
      const isPast = startAt && startAt < now;
      const isNext = startAt && !isPast && i === todayClasses.findIndex((x) => x.startAt > now);
      const dotClass = isNext ? "upcoming" : isPast ? "" : "active";
      const timeStr = startAt ? startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
      const showLine = i < todayClasses.length - 1;
      return `
        <div class="bento-timeline-item" ${isPast ? 'style="opacity:.55"' : ""}>
          <div class="bento-timeline-spine">
            <div class="bento-timeline-dot ${dotClass}"></div>
            ${showLine ? '<div class="bento-timeline-line"></div>' : ""}
          </div>
          <div class="bento-timeline-body">
            <div class="bento-timeline-time">${escapeHtml(timeStr)}</div>
            <div class="bento-timeline-title">${escapeHtml(cls.name)}</div>
            <div class="bento-timeline-sub">${cls.location ? escapeHtml(cls.location) : ""}</div>
          </div>
        </div>
      `;
    }).join("");
    return `
      <div class="bento-label"><span>Today's schedule</span><span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">${todayClasses.length} class${todayClasses.length === 1 ? "" : "es"}</span></div>
      <div class="bento-timeline">${items}</div>
    `;
  }

  // T3b: live attendance CTAs for today's classes. Data-driven card
  // that replaces the static "Coming soon" stub on the teacher bento.
  function renderTeacherAttendanceCard(todayClasses, now) {
    if (!todayClasses || todayClasses.length === 0) {
      return `
        <div class="bento-label"><span>Today's attendance</span></div>
        <div class="bento-attention-empty" style="text-align:left;padding:8px 0">
          <p style="margin:0;color:var(--ink-dim);font-size:12px">Nothing to take today.</p>
        </div>
      `;
    }
    const today = isoDate(new Date());
    const rows = todayClasses.map(({ cls }) => {
      const stats = attendanceStatsForSession(cls.id, today);
      const taken = stats.taken;
      const marked = stats.present + stats.absent;
      const label = taken
        ? `<span style="color:#2f7d3a">✓ ${stats.present} / ${marked} present${stats.latePickups > 0 ? ` · ${stats.latePickups} late pickup${stats.latePickups === 1 ? "" : "s"}` : ""}</span>`
        : `<span style="color:var(--ink-dim)">Not yet</span>`;
      return `
        <div style="display:flex;gap:8px;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-subtle,#eee)">
          <div style="flex:1;min-width:0">
            <div style="font-weight:500;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(cls.name)}</div>
            <div style="font-size:11px;margin-top:2px">${label}</div>
          </div>
          <button data-act="take-attendance" data-class-id="${escapeHtml(cls.id)}"
            style="flex:0 0 auto;border:1px solid var(--border);background:var(--surface);padding:4px 8px;border-radius:5px;font-size:11.5px;cursor:pointer">${taken ? "Edit" : "Take"}</button>
        </div>
      `;
    }).join("");
    return `
      <div class="bento-label"><span>Today's attendance</span></div>
      <div>${rows}</div>
    `;
  }

  // T3d: Teacher shifts (clock-in / clock-out). One row per today's class
  // showing current clock status and the action button. Clock in is idempotent
  // server-side — the RPC returns the existing open shift if you tap twice.
  function renderTeacherShiftsCard(me, todayClasses, now) {
    if (!me || !todayClasses || todayClasses.length === 0) {
      return `
        <div class="bento-label"><span>Today's shifts</span></div>
        <div class="bento-attention-empty" style="text-align:left;padding:8px 0">
          <p style="margin:0;color:var(--ink-dim);font-size:12px">No classes today — nothing to clock.</p>
        </div>
      `;
    }
    const today = isoDate(new Date());
    const rows = todayClasses.map(({ cls }) => {
      const shift = state.clockIns.find(
        (c) => c.teacher_id === me.id && c.class_id === cls.id && c.session_date === today
      );
      let status, action;
      if (!shift) {
        status = `<span style="color:var(--ink-dim)">Not clocked in</span>`;
        action = `<button data-act="clock-in" data-class-id="${escapeHtml(cls.id)}"
          class="btn primary small">Clock in</button>`;
      } else if (!shift.clocked_out_at) {
        const inTime = new Date(shift.clocked_in_at);
        const mins = Math.max(0, Math.round((now - inTime) / 60000));
        const timeStr = inTime.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        status = `<span style="color:#2f7d3a">⏱ Clocked in at ${escapeHtml(timeStr)} · ${mins} min</span>`;
        action = `<button data-act="clock-out" data-clock-id="${escapeHtml(shift.id)}"
          class="btn small">Clock out</button>`;
      } else {
        const durMin = Math.max(0, Math.round(
          (new Date(shift.clocked_out_at) - new Date(shift.clocked_in_at)) / 60000
        ));
        status = `<span style="color:var(--ink-dim)">✓ Done · ${durMin} min</span>`;
        action = ``;
      }
      return `
        <div style="display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border-subtle,#eee)">
          <div style="flex:1;min-width:0">
            <div style="font-weight:500">${escapeHtml(cls.name)}${cls.location ? ` <span style="color:var(--ink-dim);font-weight:400;font-size:12px">· ${escapeHtml(cls.location)}</span>` : ""}</div>
            <div style="font-size:12px;margin-top:2px">${status}</div>
          </div>
          <div>${action}</div>
        </div>
      `;
    }).join("");
    return `
      <div class="bento-label"><span>Today's shifts</span><span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">Tap to clock in or out</span></div>
      <div>${rows}</div>
    `;
  }

  async function doClockIn(classId) {
    showLoader(true);
    const { error } = await sb.rpc("clock_in", { p_class_id: classId });
    showLoader(false);
    if (error) { showToast("Clock in failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    showToast("Clocked in", "success");
  }

  async function doClockOut(clockInId) {
    showLoader(true);
    const { error } = await sb.rpc("clock_out", { p_clock_in_id: clockInId });
    showLoader(false);
    if (error) { showToast("Clock out failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    showToast("Clocked out", "success");
  }

  function renderTeacherComingSoonCard() {
    return `
      <div class="bento-label"><span>Coming soon</span></div>
      <div class="bento-attention-empty" style="text-align:left;padding:8px 0">
        <p style="margin:0 0 6px 0;color:var(--ink)">Attendance, clock-in/out, and shift trades land in the next build phase.</p>
        <p style="margin:0;color:var(--ink-dim);font-size:11.5px">For now, your schedule view is read-only. Contact Sharon for any sub or schedule changes.</p>
      </div>
    `;
  }

  function renderTeacherWelcomeCard(teacherRow) {
    if (!teacherRow) {
      return `
        <div class="bento-label"><span>Welcome to PAR DK</span></div>
        <div class="bento-attention-empty" style="text-align:left;padding:8px 0">
          <p style="margin:0 0 6px 0;color:var(--ink)">You're signed in as a teacher, but we couldn't find your teacher record yet.</p>
          <p style="margin:0;color:var(--ink-dim);font-size:11.5px">Ask Sharon to add your email (${escapeHtml(state.session?.user?.email || "")}) to your teacher profile.</p>
        </div>
      `;
    }
    const myAssignments = state.classTeachers.filter((ct) => ct.teacher_id === teacherRow.id);
    return `
      <div class="bento-label"><span>Welcome, ${escapeHtml(teacherRow.full_name.split(/\s+/)[0])}</span></div>
      <div class="bento-attention-empty" style="text-align:left;padding:8px 0">
        <p style="margin:0 0 6px 0;color:var(--ink)">You're assigned to ${myAssignments.length} class${myAssignments.length === 1 ? "" : "es"}.</p>
        <p style="margin:0;color:var(--ink-dim);font-size:11.5px">Status: ${escapeHtml(teacherRow.status || "active")}${teacherRow.par_person_id ? " · linked to PAR" : ""}</p>
      </div>
    `;
  }

  function renderTodayCard(nextClass, todayCount, now) {
    if (!nextClass) {
      if (todayCount > 0) {
        return `
          <div class="bento-label"><span>Today</span></div>
          <div class="bento-today-headline">
            <span class="bento-today-icon">🌙</span>
            <div class="bento-today-body">
              <p class="bento-today-title">Today's classes are wrapped</p>
              <p class="bento-today-sub">${todayCount} class${todayCount === 1 ? "" : "es"} earlier today · none upcoming</p>
            </div>
          </div>
        `;
      }
      const dowLong = DOW_LONG[now.getDay()];
      return `
        <div class="bento-label"><span>Today</span></div>
        <div class="bento-today-headline">
          <span class="bento-today-icon">☀️</span>
          <div class="bento-today-body">
            <p class="bento-today-title">No classes scheduled for ${dowLong}</p>
            <p class="bento-today-sub">Enjoy the lighter day.</p>
          </div>
        </div>
      `;
    }
    const { cls, startAt } = nextClass;
    const teacher = primaryTeacherOf(cls.id);
    const when = formatRelativeTimeUntil(startAt);
    const timeStr = startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `
      <div class="bento-label">
        <span>Next up</span>
        <span class="live-pill">Live</span>
      </div>
      <div class="bento-today-headline">
        <span class="bento-today-icon">🎭</span>
        <div class="bento-today-body">
          <p class="bento-today-title">${escapeHtml(cls.name)}</p>
          <p class="bento-today-sub">${timeStr} · ${when}${cls.location ? ` · ${escapeHtml(cls.location)}` : ""}</p>
          ${teacher
            ? `<p class="bento-today-sub" style="margin-top:2px">Teacher: <b>${escapeHtml(teacher.full_name)}</b></p>`
            : `<p class="bento-today-dim" style="margin-top:2px">No teacher assigned</p>`
          }
        </div>
      </div>
    `;
  }

  function renderStatsCard(classes, teachers, enrollments) {
    return `
      <div class="bento-label"><span>At a glance</span></div>
      <div class="bento-stats">
        <div class="bento-stat-row">
          <span class="k"><span class="icon">🎭</span>Active classes</span>
          <span class="v">${classes}</span>
        </div>
        <div class="bento-stat-row">
          <span class="k"><span class="icon">🧑‍🏫</span>Teachers</span>
          <span class="v">${teachers}</span>
        </div>
        <div class="bento-stat-row">
          <span class="k"><span class="icon">👥</span>Active enrollments</span>
          <span class="v">${enrollments}</span>
        </div>
      </div>
    `;
  }

  function renderScheduleCard(todayClasses, now) {
    if (todayClasses.length === 0) {
      return `
        <div class="bento-label"><span>Today's schedule</span></div>
        <div class="bento-attention-empty">Nothing on the books today.</div>
      `;
    }
    const items = todayClasses.map(({ cls, startAt }, i) => {
      const isPast = startAt && startAt < now;
      const isNext = startAt && !isPast && i === todayClasses.findIndex((x) => x.startAt > now);
      const dotClass = isNext ? "upcoming" : isPast ? "" : "active";
      const teacher = primaryTeacherOf(cls.id);
      const timeStr = startAt ? startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
      const showLine = i < todayClasses.length - 1;
      return `
        <div class="bento-timeline-item" data-open-class="${escapeHtml(cls.id)}" ${isPast ? 'style="opacity:.55"' : ""}>
          <div class="bento-timeline-spine">
            <div class="bento-timeline-dot ${dotClass}"></div>
            ${showLine ? '<div class="bento-timeline-line"></div>' : ""}
          </div>
          <div class="bento-timeline-body">
            <div class="bento-timeline-time">${escapeHtml(timeStr)}</div>
            <div class="bento-timeline-title">${escapeHtml(cls.name)}</div>
            <div class="bento-timeline-sub">${cls.location ? escapeHtml(cls.location) : ""}${teacher ? ` · ${escapeHtml(teacher.full_name)}` : ""}</div>
          </div>
        </div>
      `;
    }).join("");
    return `
      <div class="bento-label"><span>Today's schedule</span><span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">${todayClasses.length} class${todayClasses.length === 1 ? "" : "es"}</span></div>
      <div class="bento-timeline">${items}</div>
    `;
  }

  function renderAttentionCard() {
    const issues = [];
    // Classes without a primary teacher
    const noTeacher = state.classes.filter((c) =>
      includeTestClass(c) && c.active !== false &&
      !state.classTeachers.some((ct) => ct.class_id === c.id && ct.role === "primary")
    );
    if (noTeacher.length > 0) {
      issues.push({
        label: `${noTeacher.length} class${noTeacher.length === 1 ? "" : "es"} without a primary teacher`,
        hint: "Click to go to Classes and assign",
        go: "classes",
      });
    }
    // Classes without any linked infographics
    const noGraphics = state.classes.filter((c) =>
      includeTestClass(c) && c.active !== false &&
      !state.classInfographics.some((ci) => ci.class_id === c.id)
    );
    if (noGraphics.length > 0) {
      issues.push({
        label: `${noGraphics.length} class${noGraphics.length === 1 ? "" : "es"} missing linked graphics`,
        hint: "Link templates ↔ class images for faster responses",
        go: "classes",
      });
    }
    // Classes dropped from JR
    const dropped = state.classes.filter((c) => c.sync_state === "dropped_from_source");
    if (dropped.length > 0) {
      issues.push({
        label: `${dropped.length} class${dropped.length === 1 ? "" : "es"} dropped from Jackrabbit`,
        hint: "Review — may have ended or been removed",
        go: "classes",
      });
    }
    // Teachers with unresolved PAR
    const unresolvedTeachers = state.teachers.filter((t) => t.email && !t.par_person_id && t.status !== "inactive");
    if (unresolvedTeachers.length > 0) {
      issues.push({
        label: `${unresolvedTeachers.length} teacher${unresolvedTeachers.length === 1 ? "" : "s"} not linked to PAR`,
        hint: "Teachers tab → Refresh PAR links",
        go: "teachers",
      });
    }

    if (issues.length === 0) {
      return `
        <div class="bento-label"><span>Needs your attention</span></div>
        <div class="bento-attention-empty">All clear 🌱</div>
      `;
    }
    const items = issues.map((i) => `
      <div class="bento-attention-item" data-go-tab="${escapeHtml(i.go)}">
        <div class="label">${escapeHtml(i.label)}</div>
        <div class="hint">${escapeHtml(i.hint)}</div>
      </div>
    `).join("");
    return `
      <div class="bento-label"><span>Needs your attention</span></div>
      <div class="bento-attention-list">${items}</div>
    `;
  }

  function renderWeekCard(anchor) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(anchor);
      d.setDate(d.getDate() + i);
      d.setHours(0, 0, 0, 0);
      const count = state.classes.filter((c) => includeTestClass(c) && c.active !== false && classRunsOnDay(c, d)).length;
      const isToday = i === 0;
      days.push({ d, count, isToday, dow: DOW_SHORT[d.getDay()] });
    }
    const items = days.map((x) => `
      <div class="bento-week-day${x.isToday ? " today" : ""}">
        <div class="dow">${x.dow}</div>
        <div class="count${x.count === 0 ? " zero" : ""}">${x.count}</div>
      </div>
    `).join("");
    return `
      <div class="bento-label"><span>Next 7 days</span></div>
      <div class="bento-week">${items}</div>
    `;
  }

  function renderActivityCard() {
    // Pull the most recent sync_log-ish events we can derive locally.
    // We don't keep full sync_log in state — derive what we can from classes/profile.
    const events = [];
    if (state.latestSyncLog) {
      events.push({
        status: state.latestSyncLog.status,
        msg: `Jackrabbit sync — ${state.latestSyncLog.message}`,
        when: new Date(state.latestSyncLog.created_at),
      });
    }
    if (state.profile?.par_identity_last_synced) {
      events.push({
        status: state.profile.par_person_id ? "ok" : "skipped",
        msg: state.profile.par_person_id
          ? `PAR identity verified — linked as ${state.profile.par_display_name || "(no name)"}`
          : "PAR identity checked — no match yet",
        when: new Date(state.profile.par_identity_last_synced),
      });
    }
    // Recent class changes (proxy: classes with last_synced_at)
    state.classes
      .filter((c) => c.last_synced_at)
      .sort((a, b) => new Date(b.last_synced_at) - new Date(a.last_synced_at))
      .slice(0, 3)
      .forEach((c) => {
        events.push({
          status: "ok",
          msg: `${escapeHtml(c.name)} last synced from Jackrabbit`,
          when: new Date(c.last_synced_at),
        });
      });

    events.sort((a, b) => b.when - a.when);
    const top = events.slice(0, 6);

    if (top.length === 0) {
      return `
        <div class="bento-label"><span>Recent activity</span></div>
        <div class="bento-attention-empty">No activity yet.</div>
      `;
    }
    const items = top.map((e) => `
      <div class="bento-activity-item status-${escapeHtml(e.status || "ok")}">
        <span class="msg">${e.msg}</span>
        <span class="when">${formatRelativePast(e.when)}</span>
      </div>
    `).join("");
    return `
      <div class="bento-label"><span>Recent activity</span></div>
      <div class="bento-activity-list">${items}</div>
    `;
  }

  function renderQuickActionsCard() {
    // Only show actions the current role can actually perform server-side.
    const actions = [];
    if (hasPerm("edit_templates")     && canMutate()) actions.push({ key: "new-template",  icon: "＋",   label: "New template" });
    if (hasPerm("run_jackrabbit_sync") && canMutate()) actions.push({ key: "sync-jr",      icon: "⟳",   label: "Sync Jackrabbit" });
    if (hasPerm("edit_teachers")      && canMutate()) actions.push({ key: "new-teacher",   icon: "🧑‍🏫", label: "New teacher" });
    if (hasPerm("edit_teachers")      && canMutate()) actions.push({ key: "refresh-par",   icon: "↻",   label: "Refresh PAR links" });

    if (actions.length === 0) {
      return `
        <div class="bento-label"><span>Quick actions</span></div>
        <div class="bento-attention-empty">No quick actions available for your role.</div>
      `;
    }
    return `
      <div class="bento-label"><span>Quick actions</span></div>
      <div class="bento-qa-grid">
        ${actions.map((a) => `
          <button class="bento-qa-btn" data-qa="${a.key}"><span class="qa-icon">${a.icon}</span>${a.label}</button>
        `).join("")}
      </div>
    `;
  }

  function renderParBridgeCard() {
    const linked = !!state.profile?.par_person_id;
    const body = linked
      ? `
        <a class="par-user" href="https://get-on-par.com/" target="_blank" rel="noopener" title="Open PAR in a new tab">
          <span>👤</span>
          <span class="par-name">${escapeHtml(state.profile.par_display_name || state.profile.par_primary_email || "Open PAR")}</span>
          <span class="par-arrow">→</span>
        </a>
      `
      : `
        <a class="par-user" href="https://get-on-par.com/?view=settings&tab=linked-accounts" target="_blank" rel="noopener" title="Link this email on PAR to connect">
          <span>🔗</span>
          <span class="par-name">Connect to PAR</span>
          <span class="par-arrow">→</span>
        </a>
      `;
    return `
      <div class="bento-label"><span>On PAR</span></div>
      <div class="bento-par-bridge">${body}</div>
    `;
  }

  function wireHomeCardEvents() {
    // Clicking a timeline item opens that class detail in the Classes tab
    $$("[data-open-class]", $("#bentoGrid")).forEach((el) => {
      el.onclick = () => {
        const classId = el.dataset.openClass;
        state.cState.openClassId = classId;
        go("classes");
      };
    });
    // Clicking an attention card jumps to the relevant tab
    $$("[data-go-tab]", $("#bentoGrid")).forEach((el) => {
      el.onclick = () => go(el.dataset.goTab);
    });
    // Quick actions
    $$("[data-qa]", $("#bentoGrid")).forEach((btn) => {
      btn.onclick = () => {
        const qa = btn.dataset.qa;
        if (qa === "new-template")   { go("templates"); openTemplateEditor(null); }
        else if (qa === "sync-jr")   { go("classes"); syncJackrabbit(); }
        else if (qa === "new-teacher"){ go("teachers"); openTeacherEditor(null); }
        else if (qa === "refresh-par"){ go("teachers"); refreshAllTeacherParLinks(); }
      };
    });
    // T3b: take-attendance CTAs on the teacher bento
    $$('[data-act="take-attendance"]', $("#bentoGrid")).forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const cls = state.classes.find((c) => c.id === btn.dataset.classId);
        if (cls) openAttendanceModal(cls, isoDate(new Date()));
      };
    });
    // T3d: clock-in / clock-out CTAs on the teacher bento
    $$('[data-act="clock-in"]', $("#bentoGrid")).forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); doClockIn(btn.dataset.classId); };
    });
    $$('[data-act="clock-out"]', $("#bentoGrid")).forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); doClockOut(btn.dataset.clockId); };
    });
  }

  /* ═════════════ Router ═════════════ */

  // Sidebar visibility: only on the two tabs where infographic access is useful
  const SIDEBAR_TABS = new Set(["templates", "infographics"]);

  function go(tab) {
    // Route guard: if the role can't see this tab, fall back to home.
    if (!canSeeTab(tab)) tab = "home";
    state.router = tab;
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    $$(".tab-panel").forEach((p) => p.style.display = p.dataset.tab === tab ? "" : "none");
    $("#subBarTemplates").classList.toggle("hidden", tab !== "templates");
    const layout = document.querySelector(".layout");
    const sidebar = document.querySelector("aside.sidebar");
    const show = SIDEBAR_TABS.has(tab);
    if (layout)  layout.classList.toggle("no-sidebar", !show);
    if (sidebar) sidebar.style.display = show ? "" : "none";
  }

  /* ═════════════ Role visibility ═════════════
   * Apply role-based visibility to tabs and the top header buttons. Called
   * once on boot. Re-render of tab/page content lives in renderAll().
   */
  function applyRoleVisibility() {
    // Tab buttons
    $$(".tab").forEach((t) => {
      t.style.display = canSeeTab(t.dataset.tab) ? "" : "none";
    });

    // Top-right "New template" header button — only when we can actually edit
    const newTplBtn = $("#newTemplateBtn");
    if (newTplBtn) newTplBtn.style.display = hasPerm("edit_templates") && canMutate() ? "" : "none";

    // Per-tab header action buttons
    const newClassBtn      = $("#newClassBtn");
    const syncJrBtn        = $("#syncJackrabbitBtn");
    const newTeacherBtn    = $("#newTeacherBtn");
    const refreshParBtn    = $("#refreshParLinksBtn");
    const newCategoryBtn   = $("#newCategoryBtn");
    const newInfographicBtn = $("#newInfographicBtn");

    if (newClassBtn)       newClassBtn.style.display       = hasPerm("edit_classes")      && canMutate() ? "" : "none";
    if (syncJrBtn)         syncJrBtn.style.display         = hasPerm("run_jackrabbit_sync") && canMutate() ? "" : "none";
    if (newTeacherBtn)     newTeacherBtn.style.display     = hasPerm("edit_teachers")     && canMutate() ? "" : "none";
    if (refreshParBtn)     refreshParBtn.style.display     = hasPerm("edit_teachers")     && canMutate() ? "" : "none";
    if (newCategoryBtn)    newCategoryBtn.style.display    = hasPerm("edit_categories")   && canMutate() ? "" : "none";
    if (newInfographicBtn) newInfographicBtn.style.display = hasPerm("edit_infographics") && canMutate() ? "" : "none";

    // "Invite user" is admin+ only (manager/viewer/teacher never see it)
    const inviteUserBtn = $("#inviteUserBtn");
    if (inviteUserBtn) inviteUserBtn.style.display = canMutate() ? "" : "none";

    // Closures are admin+ only (manager/viewer can see the Schedule view but
    // can't manage closures — only add/remove via the modal)
    const schedManageClosures = $("#schedManageClosures");
    if (schedManageClosures) schedManageClosures.style.display = canMutate() ? "" : "none";
  }

  /* ═════════════ SCHEDULE (Day / Week / Month) ═════════════
   *
   * Dedicated tab with a mode toggle. Renders classes + teacher overlays +
   * closures across Day, Week, and Month projections.
   *
   * - Admin+ sees everything; teacher sees only classes they're assigned to.
   * - "Only my classes" toggle lets admins filter to their own assignments too.
   * - Teacher color assignment is a deterministic hash of teacher.id -> hue.
   * - Closures overlay visually mute a day; don't remove class blocks (we want
   *   admins to see what was supposed to run so they can communicate cancellation).
   */

  const SCHED_HOUR_START = 8;    // earliest rendered hour on week view
  const SCHED_HOUR_END   = 21;   // latest (exclusive — renders up to 20:xx)
  const SCHED_HOUR_PX    = 42;   // pixels per hour on week view

  function isoDateFromString(s) {
    // s is "YYYY-MM-DD" — return a Date at local midnight
    const [y, m, d] = s.split("-").map((x) => parseInt(x, 10));
    return new Date(y, m - 1, d);
  }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
  function startOfWeek(d) {
    // Sunday-start week
    const r = new Date(d); r.setHours(0,0,0,0);
    r.setDate(r.getDate() - r.getDay());
    return r;
  }
  function startOfMonth(d) {
    const r = new Date(d); r.setHours(0,0,0,0); r.setDate(1); return r;
  }
  function endOfMonth(d) {
    const r = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    r.setHours(23,59,59,999); return r;
  }

  // Deterministic hue-per-teacher from teacher_id. Produces HSL colors
  // spread evenly-ish across the wheel, at constant saturation/luma so
  // overlays read consistently on a dark background.
  function teacherHue(teacherId) {
    if (!teacherId) return 210;
    let h = 0;
    for (let i = 0; i < teacherId.length; i++) h = (h * 31 + teacherId.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function teacherColor(teacherId, alpha) {
    const hue = teacherHue(teacherId);
    return `hsla(${hue}, 62%, 58%, ${alpha == null ? 1 : alpha})`;
  }

  // Return the teacher row (or null) primary-assigned to a class.
  function primaryTeacherObj(classId) {
    const ct = state.classTeachers.find((x) => x.class_id === classId && x.role === "primary");
    if (ct) return state.teachers.find((t) => t.id === ct.teacher_id);
    const any = state.classTeachers.find((x) => x.class_id === classId);
    return any ? state.teachers.find((t) => t.id === any.teacher_id) : null;
  }

  // Two-letter initials from a teacher row. First+last for 2+ word names,
  // first two letters otherwise. Empty string if no name.
  function teacherInitials(teacher) {
    const name = (teacher?.full_name || "").trim();
    if (!name) return "";
    const parts = name.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  // All teachers assigned to a class, primary first then subs/others.
  function teachersForClass(classId) {
    const assignments = state.classTeachers
      .filter((x) => x.class_id === classId)
      .sort((a, b) => (a.role === "primary" ? -1 : b.role === "primary" ? 1 : 0));
    return assignments
      .map((a) => state.teachers.find((t) => t.id === a.teacher_id))
      .filter(Boolean);
  }

  // "JL" for a primary-only class; "JL/MS" when a sub is also assigned.
  function classInitialsString(classId) {
    return teachersForClass(classId).map(teacherInitials).filter(Boolean).join("/");
  }

  // Return classes that should appear on a given date after applying
  // filters: test-excluded, active-only, onlyMine filter, teacher role
  // always filters to their own assignments.
  function classesForDate(date) {
    const role = currentRole();
    const isTeacher = role === "teacher";
    const email = (state.session?.user?.email || "").toLowerCase();
    const me = isTeacher && email
      ? state.teachers.find((t) => (t.email || "").toLowerCase() === email)
      : null;
    const myId = me?.id || null;

    const onlyMine = state.sState.onlyMine || isTeacher;
    const myAssignedClassIds = onlyMine
      ? new Set(state.classTeachers.filter((ct) => ct.teacher_id === myId).map((ct) => ct.class_id))
      : null;

    return state.classes.filter((c) => {
      if (c.is_test && !state.cState.showTest) return false;
      if (c.active === false) return false;
      if (!classRunsOnDay(c, date)) return false;
      if (myAssignedClassIds && !myAssignedClassIds.has(c.id)) return false;
      return true;
    });
  }

  function closuresForDate(date) {
    const iso = isoDate(date);
    return state.closures.filter((c) => c.date === iso);
  }

  function renderScheduleTab() {
    const view = $("#schedView");
    const label = $("#schedLabel");
    if (!view || !label) return;

    const anchor = isoDateFromString(state.sState.anchor);
    const mode = state.sState.mode;

    // Mode toggle active state
    $$(".sched-mode").forEach((b) => {
      b.classList.toggle("active", b.dataset.schedMode === mode);
    });

    // Only-mine toggle: reflect current state; force-on and disable for teachers
    const onlyMineEl = $("#schedOnlyMine");
    if (onlyMineEl) {
      if (isRole("teacher")) {
        onlyMineEl.checked = true;
        onlyMineEl.disabled = true;
      } else {
        onlyMineEl.checked = !!state.sState.onlyMine;
        onlyMineEl.disabled = false;
      }
    }

    // Header label + body rendering
    if (mode === "day") {
      label.textContent = anchor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
      renderScheduleDayView(view, anchor);
    } else if (mode === "week") {
      const weekStart = startOfWeek(anchor);
      const weekEnd   = addDays(weekStart, 6);
      label.textContent = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${weekEnd.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
      renderScheduleWeekView(view, weekStart);
    } else if (mode === "month") {
      label.textContent = anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
      renderScheduleMonthView(view, anchor);
    }
  }

  function renderScheduleDayView(view, date) {
    const classes = classesForDate(date)
      .map((c) => ({ cls: c, startAt: classStartTimeOn(c, date), teacher: primaryTeacherObj(c.id) }))
      .sort((a, b) => (a.startAt?.getTime() || 0) - (b.startAt?.getTime() || 0));
    const closures = closuresForDate(date);

    if (!classes.length && !closures.length) {
      view.innerHTML = `
        <div class="sched-empty">
          <p>Nothing scheduled on ${escapeHtml(date.toLocaleDateString(undefined, { weekday: "long" }))}.</p>
          <p class="sched-empty-sub">Use the navigation arrows to browse other days.</p>
        </div>
      `;
      return;
    }

    const closureHtml = closures.map((cl) => `
      <div class="sched-closure-card">
        <div class="sched-closure-label">🗓 ${escapeHtml(cl.label)}</div>
        ${cl.note ? `<div class="sched-closure-note">${escapeHtml(cl.note)}</div>` : ""}
      </div>
    `).join("");

    const now = new Date();
    const isToday = isoDate(date) === isoDate(now);
    const itemsHtml = classes.map(({ cls, startAt, teacher }, i) => {
      const isPast = isToday && startAt && startAt < now;
      const isNext = isToday && startAt && !isPast && i === classes.findIndex((x) => x.startAt && x.startAt > now);
      const dotClass = isNext ? "upcoming" : isPast ? "" : "active";
      const timeStr = startAt ? startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : (cls.times || "—");
      const showLine = i < classes.length - 1;
      const hue = teacher ? teacherHue(teacher.id) : 210;
      return `
        <div class="sched-day-item" data-open-class="${escapeHtml(cls.id)}" ${isPast ? 'style="opacity:.55"' : ""}>
          <div class="sched-day-spine">
            <div class="sched-day-dot ${dotClass}" style="background:hsl(${hue}, 62%, 58%)"></div>
            ${showLine ? '<div class="sched-day-line"></div>' : ""}
          </div>
          <div class="sched-day-body" style="border-left:3px solid hsla(${hue}, 62%, 58%, .55)">
            <div class="sched-day-time">${escapeHtml(timeStr)}</div>
            <div class="sched-day-title">${escapeHtml(cls.name)}</div>
            <div class="sched-day-sub">
              ${cls.location ? escapeHtml(cls.location) : ""}
              ${teacher ? `${cls.location ? " · " : ""}<span style="color:hsl(${hue}, 62%, 68%)">${escapeHtml(teacher.full_name)}</span>` : ""}
            </div>
          </div>
        </div>
      `;
    }).join("");

    view.innerHTML = `
      ${closureHtml}
      <div class="sched-day-list">${itemsHtml}</div>
    `;
    wireScheduleClassClicks();
  }

  function renderScheduleWeekView(view, weekStart) {
    // Build a 7-day slice; for each day, gather class+time+teacher tuples.
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const classes = classesForDate(d)
        .map((c) => ({ cls: c, startAt: classStartTimeOn(c, d), teacher: primaryTeacherObj(c.id) }))
        .filter((x) => x.startAt)  // drop classes with unparseable times
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
      days.push({ date: d, classes, closures: closuresForDate(d) });
    }

    const hourRows = [];
    for (let h = SCHED_HOUR_START; h < SCHED_HOUR_END; h++) {
      const label = h === 12 ? "12 PM" : h < 12 ? `${h} AM` : `${h - 12} PM`;
      hourRows.push(`<div class="sched-week-hour"><span>${label}</span></div>`);
    }

    const dowHeaders = [];
    const todayIso = isoDate(new Date());
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      const iso = isoDate(d);
      const isToday = iso === todayIso;
      const dow = d.toLocaleDateString(undefined, { weekday: "short" });
      const dn  = d.getDate();
      dowHeaders.push(`
        <div class="sched-week-daycol-head${isToday ? " today" : ""}" data-open-day="${iso}">
          <span class="dow">${escapeHtml(dow)}</span>
          <span class="dn">${dn}</span>
        </div>
      `);
    }

    const dayColumns = days.map((d) => {
      const iso = isoDate(d.date);
      const isToday = iso === todayIso;
      const isClosed = d.closures.length > 0;
      const closureLabel = isClosed
        ? `<div class="sched-week-closure-pill" title="${escapeHtml(d.closures.map(c => c.label).join(" · "))}">🗓 ${escapeHtml(d.closures[0].label)}${d.closures.length > 1 ? ` +${d.closures.length - 1}` : ""}</div>`
        : "";

      const totalHeight = (SCHED_HOUR_END - SCHED_HOUR_START) * SCHED_HOUR_PX;
      const blocks = d.classes.map(({ cls, startAt, teacher }) => {
        const hoursFromStart = startAt.getHours() + startAt.getMinutes() / 60 - SCHED_HOUR_START;
        if (hoursFromStart < 0 || hoursFromStart >= (SCHED_HOUR_END - SCHED_HOUR_START)) return "";
        const topPx = Math.max(0, hoursFromStart * SCHED_HOUR_PX);
        const durationMin = parseClassDurationMinutes(cls);
        const heightPx = Math.max(24, (durationMin / 60) * SCHED_HOUR_PX);
        const hue = teacher ? teacherHue(teacher.id) : 210;
        const timeStr = startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        return `
          <div class="sched-week-block" data-open-class="${escapeHtml(cls.id)}"
               style="top:${topPx}px;height:${heightPx}px;
                      background:hsla(${hue},62%,58%,.22);
                      border-left:3px solid hsl(${hue},62%,58%);">
            <div class="sched-week-block-time">${escapeHtml(timeStr)}</div>
            <div class="sched-week-block-title">${escapeHtml(cls.name)}</div>
            ${teacher ? `<div class="sched-week-block-sub">${escapeHtml(teacher.full_name.split(/\s+/)[0])}</div>` : ""}
          </div>
        `;
      }).join("");

      return `
        <div class="sched-week-daycol${isToday ? " today" : ""}${isClosed ? " closed" : ""}"
             style="height:${totalHeight}px">
          ${closureLabel}
          ${blocks}
        </div>
      `;
    }).join("");

    view.innerHTML = `
      <div class="sched-week">
        <div class="sched-week-headrow">
          <div class="sched-week-timecol-head"></div>
          ${dowHeaders.join("")}
        </div>
        <div class="sched-week-body">
          <div class="sched-week-timecol">${hourRows.join("")}</div>
          <div class="sched-week-grid">${dayColumns}</div>
        </div>
      </div>
    `;
    wireScheduleClassClicks();
  }

  // Parse a class's duration (in minutes) from the `times` field like
  // "3:00 PM - 3:45 PM". Falls back to 60 min.
  function parseClassDurationMinutes(cls) {
    const src = cls?.times || cls?.day_time;
    if (!src) return 60;
    const m = String(src).match(/(\d{1,2}):(\d{2})\s*([AP]M)\s*[-–]\s*(\d{1,2}):(\d{2})\s*([AP]M)/i);
    if (!m) return 60;
    const toMin = (h, mm, ap) => {
      let hh = parseInt(h, 10) % 12;
      if (ap.toUpperCase() === "PM") hh += 12;
      return hh * 60 + parseInt(mm, 10);
    };
    const s = toMin(m[1], m[2], m[3]);
    const e = toMin(m[4], m[5], m[6]);
    return Math.max(15, e - s);
  }

  function renderScheduleMonthView(view, anchor) {
    const monthStart = startOfMonth(anchor);
    const monthEnd   = endOfMonth(anchor);
    // Grid starts on the Sunday on-or-before the 1st
    const gridStart = startOfWeek(monthStart);
    // Always render 6 rows of 7 cells = 42 cells for a stable layout.
    const todayIso = isoDate(new Date());

    const dowHeaders = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(
      (d) => `<div class="sched-month-dow">${d}</div>`
    ).join("");

    const cells = [];
    const MAX_ROWS = 3;
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      const iso = isoDate(d);
      const inMonth = d.getMonth() === anchor.getMonth();
      const isToday = iso === todayIso;
      const closures = closuresForDate(d);
      const classes = classesForDate(d)
        .map((c) => ({ cls: c, startAt: classStartTimeOn(c, d), teacher: primaryTeacherObj(c.id) }))
        .sort((a, b) => (a.startAt?.getTime() || 0) - (b.startAt?.getTime() || 0));

      const visible = classes.slice(0, MAX_ROWS);
      const overflow = Math.max(0, classes.length - MAX_ROWS);

      const rowsHtml = visible.map(({ cls, startAt, teacher }) => {
        const hue = teacher ? teacherHue(teacher.id) : 210;
        const timeStr = startAt
          ? startAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(" ", "")
          : "";
        const initials = classInitialsString(cls.id);
        const titleTxt = [
          cls.name,
          initials ? "— " + initials : "",
          timeStr ? "at " + timeStr : "",
        ].filter(Boolean).join(" ");
        return `
          <div class="sched-month-row" data-open-class="${escapeHtml(cls.id)}"
               style="border-left-color:hsl(${hue}, 62%, 58%)"
               title="${escapeHtml(titleTxt)}">
            ${timeStr ? `<span class="sched-month-row-time">${escapeHtml(timeStr)}</span>` : ""}
            <span class="sched-month-row-name">${escapeHtml(cls.name)}</span>
            ${initials ? `<span class="sched-month-row-initials">${escapeHtml(initials)}</span>` : ""}
          </div>
        `;
      }).join("");

      const overflowHtml = overflow > 0
        ? `<div class="sched-month-row-more">+${overflow} more</div>`
        : "";

      // Closure treatment: red for full-day closures. When the academic-
      // calendar schema adds a short-day type, emit `closed-short` instead
      // of `closed-full` to get the yellow hatch.
      const closureClass = closures.length ? " closed-full" : "";
      const closureHtml = closures.length
        ? `<div class="sched-month-closure" title="${escapeHtml(closures.map(c => c.label).join(" · "))}">${escapeHtml(closures[0].label)}</div>`
        : "";

      cells.push(`
        <div class="sched-month-cell${inMonth ? "" : " off"}${isToday ? " today" : ""}${closureClass}"
             data-open-day="${iso}">
          <div class="sched-month-head">
            <div class="sched-month-dn">${d.getDate()}</div>
            ${classes.length ? `<div class="sched-month-count">${classes.length}</div>` : ""}
          </div>
          ${closureHtml}
          <div class="sched-month-rows">
            ${rowsHtml}
            ${overflowHtml}
          </div>
        </div>
      `);
    }

    view.innerHTML = `
      <div class="sched-month">
        <div class="sched-month-dows">${dowHeaders}</div>
        <div class="sched-month-grid">${cells.join("")}</div>
        <div class="sched-month-legend">
          Tap a class to open it, or tap a day to see its full schedule. The colored stripe on each row is the primary teacher.
        </div>
      </div>
    `;
    wireScheduleClassClicks();
  }

  /* ═════════════ Closures management ═════════════ */

  function openClosuresModal() {
    renderClosuresList();
    // Default date to the current anchor for convenience
    const d = $("#closureDate");
    if (d && !d.value) d.value = state.sState.anchor;
    $("#closuresOverlay").classList.add("open");
    setTimeout(() => $("#closureLabel").focus(), 40);
  }
  function closeClosuresModal() { $("#closuresOverlay").classList.remove("open"); }

  function renderClosuresList() {
    const wrap = $("#closureList");
    if (!wrap) return;
    if (!state.closures.length) {
      wrap.innerHTML = `<div class="closure-empty">No closures yet.</div>`;
      return;
    }
    wrap.innerHTML = state.closures
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((c) => `
        <div class="closure-row" data-id="${escapeHtml(c.id)}">
          <div class="closure-row-date">${escapeHtml(c.date)}</div>
          <div class="closure-row-label">${escapeHtml(c.label)}</div>
          <button class="btn ghost small" data-act="del-closure" data-id="${escapeHtml(c.id)}" title="Remove">✕</button>
        </div>
      `).join("");
    $$('[data-act="del-closure"]', wrap).forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.id;
        const { error } = await sb.from("closures").delete().eq("id", id);
        if (error) return showToast(error.message, "error");
        await reloadAll(); renderAll(); renderClosuresList();
        showToast("Closure removed", "success");
      };
    });
  }

  async function addClosure() {
    const date = $("#closureDate").value;
    const label = $("#closureLabel").value.trim();
    if (!date || !label) { showToast("Date and label are required", "error"); return; }
    const { error } = await sb.from("closures").insert({ date, label });
    if (error) { showToast(error.message, "error"); return; }
    $("#closureLabel").value = "";
    await reloadAll(); renderAll(); renderClosuresList();
    showToast("Closure added", "success");
  }

  /* ═════════════ Schedule nav + wiring ═════════════ */

  function schedNav(offset) {
    const d = isoDateFromString(state.sState.anchor);
    if (state.sState.mode === "day") state.sState.anchor = isoDate(addDays(d, offset));
    else if (state.sState.mode === "week") state.sState.anchor = isoDate(addDays(d, offset * 7));
    else if (state.sState.mode === "month") {
      const r = new Date(d.getFullYear(), d.getMonth() + offset, 1);
      state.sState.anchor = isoDate(r);
    }
    renderScheduleTab();
  }

  function wireScheduleClassClicks() {
    $$("[data-open-class]", $("#schedView")).forEach((el) => {
      el.onclick = (e) => {
        // Month cells carry data-open-day and class rows sit inside them;
        // stop propagation so the cell handler doesn't also fire.
        e.stopPropagation();
        const id = el.dataset.openClass;
        state.cState.openClassId = id;
        go("classes");
      };
    });
    $$("[data-open-day]", $("#schedView")).forEach((el) => {
      el.onclick = () => {
        state.sState.anchor = el.dataset.openDay;
        state.sState.mode = "day";
        renderScheduleTab();
      };
    });
  }

  /* ═════════════ TEMPLATES ═════════════ */

  function renderCategoryChips() {
    const wrap = $("#categoryChips");
    wrap.innerHTML = "";
    [{ id: "all", label: "All" }].concat(state.categories).forEach((cat) => {
      const chip = document.createElement("button");
      chip.className = "chip" + (state.tState.category === cat.id ? " active" : "");
      chip.textContent = cat.label;
      chip.onclick = () => { state.tState.category = cat.id; renderCategoryChips(); renderTemplates(); };
      wrap.appendChild(chip);
    });
  }

  function matchesQuery(t, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return (
      (t.title || "").toLowerCase().includes(q) ||
      (t.body  || "").toLowerCase().includes(q) ||
      (t.tags  || []).some((tag) => tag.toLowerCase().includes(q)) ||
      (t.notes || "").toLowerCase().includes(q)
    );
  }

  function renderTemplates() {
    const cardsEl = $("#cards");
    const metaEl  = $("#resultsMeta");
    const filtered = state.templates.filter((t) => {
      if (state.tState.category !== "all" && t.category_id !== state.tState.category) return false;
      return matchesQuery(t, state.tState.query);
    });
    metaEl.textContent = filtered.length + (filtered.length === 1 ? " template" : " templates");
    cardsEl.innerHTML = "";
    if (filtered.length === 0) {
      cardsEl.innerHTML = '<div class="empty">No templates match. Clear the search or pick a different category — or click <b>＋ New template</b> to add one.</div>';
      return;
    }
    filtered.forEach((tpl) => cardsEl.appendChild(renderCard(tpl)));
  }

  function renderCard(tpl) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = tpl.id;

    const categoryLabel = (state.categories.find((c) => c.id === tpl.category_id) || {}).label || "—";
    const tagLine = (tpl.tags || []).slice(0, 4).map((t) => "#" + t).join(" ");

    const showEditBtns = hasPerm("edit_templates") && canMutate();
    card.innerHTML = `
      <div class="card-head">
        <div style="flex:1">
          <h3 class="card-title"></h3>
          <div class="card-meta">
            <span class="badge"></span>
            <span class="tag-line"></span>
          </div>
        </div>
        <div class="card-actions-head">
          ${showEditBtns ? `
            <button class="btn small ghost" data-act="edit" title="Edit template">✎</button>
            <button class="btn small ghost" data-act="dup" title="Duplicate template">⎘</button>
          ` : ""}
          <div class="expand-arrow">▸</div>
        </div>
      </div>
      <div class="card-body"></div>
    `;
    $(".card-title", card).textContent = tpl.title;
    $(".badge", card).textContent = categoryLabel;
    $(".tag-line", card).textContent = tagLine;

    if (showEditBtns) {
      $('[data-act="edit"]', card).onclick = (e) => { e.stopPropagation(); openTemplateEditor(tpl.id); };
      $('[data-act="dup"]',  card).onclick = (e) => { e.stopPropagation(); duplicateTemplate(tpl.id); };
    }
    $(".card-head", card).onclick = () => {
      const willOpen = !card.classList.contains("open");
      card.classList.toggle("open");
      if (willOpen) renderBody(card, tpl);
    };
    return card;
  }

  function renderBody(card, tpl) {
    const bodyEl = $(".card-body", card);
    bodyEl.innerHTML = "";
    const vars = (tpl.variables && tpl.variables.length) ? tpl.variables : detectVars(tpl.body);
    const filled = state.tState.filled[tpl.id] || {};

    /* Class picker */
    const classBound = ["class_name", "day_time", "location", "registration_link"];
    const usesClass = vars.some((v) => classBound.includes(v));
    if (usesClass && state.classes.length) {
      const panel = document.createElement("div");
      panel.className = "panel";
      panel.innerHTML = `
        <div class="panel-label">Which class? <span style="font-weight:400;text-transform:none;color:var(--ink-dim)">(auto-fills class_name, day_time, location, registration_link)</span></div>
        <div class="class-picker">
          <select><option value="">— none —</option></select>
          <button class="btn small" data-act="clear-class">Clear</button>
        </div>
      `;
      const sel = $("select", panel);
      state.classes.filter((c) => c.active !== false).forEach((c) => {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.name + " · " + (c.day_time || "—");
        sel.appendChild(opt);
      });
      sel.value = filled.__class || "";
      sel.onchange = () => {
        state.tState.filled[tpl.id] = state.tState.filled[tpl.id] || {};
        state.tState.filled[tpl.id].__class = sel.value;
        const c = state.classes.find((x) => x.id === sel.value);
        if (c) {
          if (vars.includes("class_name"))        state.tState.filled[tpl.id].class_name = c.name;
          if (vars.includes("day_time"))          state.tState.filled[tpl.id].day_time = c.day_time;
          if (vars.includes("location"))          state.tState.filled[tpl.id].location = c.location;
          if (vars.includes("registration_link")) state.tState.filled[tpl.id].registration_link = c.registration_link;
        }
        renderBody(card, tpl);
      };
      $('[data-act="clear-class"]', panel).onclick = () => {
        delete (state.tState.filled[tpl.id] || {}).__class;
        classBound.forEach((k) => { if (state.tState.filled[tpl.id]) delete state.tState.filled[tpl.id][k]; });
        renderBody(card, tpl);
      };
      bodyEl.appendChild(panel);

      // Suggested infographics for the currently-picked class
      const pickedClassId = (state.tState.filled[tpl.id] || {}).__class;
      if (pickedClassId) {
        const linkedIgIds = state.classInfographics
          .filter((ci) => ci.class_id === pickedClassId)
          .map((ci) => ci.infographic_id);
        const linkedIgs = linkedIgIds
          .map((id) => state.infographics.find((ig) => ig.id === id))
          .filter(Boolean);
        if (linkedIgs.length) {
          const row = document.createElement("div");
          row.innerHTML = `
            <div class="panel-label" style="margin-bottom:6px;margin-top:-4px">Suggested for this class</div>
            <div class="suggested-ig-row"></div>
          `;
          const igRow = $(".suggested-ig-row", row);
          linkedIgs.forEach((ig) => {
            const chip = document.createElement("button");
            chip.className = "ig-suggestion";
            chip.type = "button";
            chip.innerHTML = `🖼 ${escapeHtml(ig.name)}`;
            chip.onclick = async () => {
              await handleInfographicClick(ig, chip);
              chip.classList.add("copied");
              setTimeout(() => chip.classList.remove("copied"), 1500);
            };
            igRow.appendChild(chip);
          });
          bodyEl.appendChild(row);
        }
      }
    }

    /* Variables */
    if (vars.length) {
      const panel = document.createElement("div");
      panel.className = "panel";
      panel.innerHTML = `<div class="panel-label">Personalize (optional)</div><div class="variable-grid"></div>`;
      const grid = $(".variable-grid", panel);
      vars.forEach((v) => {
        const row = document.createElement("div");
        row.className = "variable-row";
        row.innerHTML = `<label>{${v}}</label><input type="text" placeholder="leave blank to keep {${v}}" />`;
        const input = $("input", row);
        input.value = filled[v] || "";
        input.addEventListener("input", () => {
          state.tState.filled[tpl.id] = state.tState.filled[tpl.id] || {};
          state.tState.filled[tpl.id][v] = input.value;
          refresh();
        });
        grid.appendChild(row);
      });
      bodyEl.appendChild(panel);
    }

    /* Preview */
    const preview = document.createElement("div");
    preview.className = "body-preview";
    bodyEl.appendChild(preview);

    /* Actions */
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.innerHTML = `
      <button class="btn primary" data-act="copy">Copy to clipboard</button>
      <button class="btn" data-act="copy-raw">Copy raw (keep {variables})</button>
      <button class="btn ghost small" data-act="reset">Reset fields</button>
    `;
    bodyEl.appendChild(actions);

    /* Images */
    if ((tpl.images || []).length) {
      const imgs = document.createElement("div");
      imgs.className = "images-section";
      imgs.innerHTML = `<div class="panel-label">Attachments / images</div><div class="image-links"></div>`;
      const row = $(".image-links", imgs);
      tpl.images.forEach((img) => {
        const missing = !img.url || img.url.indexOf("PASTE_") === 0;
        const a = document.createElement("a");
        a.className = "image-link" + (missing ? " missing" : "");
        a.textContent = "🖼 " + img.label + (missing ? " (needs link)" : "");
        a.href = missing ? "#" : img.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        if (missing) a.onclick = (e) => { e.preventDefault(); showToast("Edit this template to add the image URL"); };
        row.appendChild(a);
      });
      bodyEl.appendChild(imgs);
    }

    /* Notes */
    if (tpl.notes) {
      const notes = document.createElement("div");
      notes.className = "notes";
      notes.textContent = tpl.notes;
      bodyEl.appendChild(notes);
    }

    $('[data-act="copy"]', actions).onclick = async () => {
      const txt = substitute(tpl.body, state.tState.filled[tpl.id] || {});
      await copyText(txt);
      flashCopied($('[data-act="copy"]', actions));
    };
    $('[data-act="copy-raw"]', actions).onclick = async () => {
      await copyText(tpl.body);
      flashCopied($('[data-act="copy-raw"]', actions));
    };
    $('[data-act="reset"]', actions).onclick = () => {
      delete state.tState.filled[tpl.id];
      renderBody(card, tpl);
    };

    refresh();
    function refresh() {
      preview.innerHTML = highlighted(tpl.body, state.tState.filled[tpl.id] || {});
    }
  }

  function highlighted(body, filled) {
    return escapeHtml(body).replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name) => {
      const val = filled[name];
      if (val && String(val).trim()) return `<span class="var-token filled">${escapeHtml(val)}</span>`;
      return `<span class="var-token">{${name}}</span>`;
    });
  }
  function substitute(body, filled) {
    return body.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name) => {
      const val = filled[name];
      return (val && String(val).trim()) ? val : m;
    });
  }

  /* ═════════════ Template editor ═════════════ */

  let editingTemplateId = null;

  function openTemplateEditor(id) {
    editingTemplateId = id || null;
    const tpl = id ? state.templates.find((t) => t.id === id) : null;
    $("#templateModalTitle").textContent = tpl ? "Edit template" : "New template";
    $("#f_title").value = tpl ? tpl.title : "";
    $("#f_body").value  = tpl ? tpl.body  : "";
    $("#f_tags").value  = tpl ? (tpl.tags || []).join(", ") : "";
    $("#f_notes").value = tpl ? (tpl.notes || "") : "";
    populateCategorySelect("#f_category", tpl ? tpl.category_id : (state.categories[0]?.id));
    renderImageRows(tpl ? tpl.images : []);
    updateDetectedVars();
    $("#deleteTemplateBtn").style.display = tpl ? "" : "none";
    $("#templateModalOverlay").classList.add("open");
    setTimeout(() => $("#f_title").focus(), 50);
  }
  function closeTemplateEditor() { $("#templateModalOverlay").classList.remove("open"); editingTemplateId = null; }

  function populateCategorySelect(sel, current) {
    const el = $(sel);
    el.innerHTML = "";
    state.categories.forEach((c) => {
      const o = document.createElement("option");
      o.value = c.id; o.textContent = c.label;
      if (c.id === current) o.selected = true;
      el.appendChild(o);
    });
  }

  function renderImageRows(images) {
    const wrap = $("#f_images");
    wrap.innerHTML = "";
    (images || []).forEach((img) => addImageRow(img.label, img.url));
  }
  function addImageRow(label, url) {
    const wrap = $("#f_images");
    const row = document.createElement("div");
    row.className = "image-row";
    row.innerHTML = `
      <input type="text" placeholder="Label (e.g. Pricing flyer)" />
      <input type="text" placeholder="URL (Drive / Dropbox / web)" />
      <button type="button" class="btn ghost small">✕</button>
    `;
    const [ia, ib, rm] = row.children;
    ia.value = label || ""; ib.value = url || "";
    rm.onclick = () => row.remove();
    wrap.appendChild(row);
  }
  function updateDetectedVars() {
    const vars = detectVars($("#f_body").value);
    $("#detectedVars").textContent = vars.length ? vars.map((v) => "{" + v + "}").join(" · ") : "—";
  }

  async function saveTemplate() {
    const title = $("#f_title").value.trim();
    const body  = $("#f_body").value;
    if (!title) { showToast("Title is required", "error"); return; }
    if (!body.trim()) { showToast("Body is required", "error"); return; }
    const payload = {
      title,
      body,
      category_id: $("#f_category").value || null,
      tags: $("#f_tags").value.split(",").map((s) => s.trim()).filter(Boolean),
      notes: $("#f_notes").value || null,
      variables: detectVars(body),
      images: $$("#f_images .image-row").map((r) => ({
        label: r.children[0].value.trim(),
        url: r.children[1].value.trim()
      })).filter((i) => i.label || i.url)
    };

    showLoader(true);
    let resp;
    if (editingTemplateId) {
      resp = await sb.from("templates").update(payload).eq("id", editingTemplateId).select().single();
    } else {
      const existingSlugs = new Set(state.templates.map((t) => t.slug));
      payload.slug = uniqueSlug(slugify(title), existingSlugs);
      resp = await sb.from("templates").insert(payload).select().single();
    }
    showLoader(false);
    if (resp.error) { showToast(resp.error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeTemplateEditor();
    showToast(editingTemplateId ? "Template updated" : "Template created", "success");
  }

  async function deleteTemplate() {
    if (!editingTemplateId) return;
    if (!confirm("Delete this template? This cannot be undone.")) return;
    showLoader(true);
    const { error } = await sb.from("templates").delete().eq("id", editingTemplateId);
    showLoader(false);
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeTemplateEditor();
    showToast("Template deleted", "success");
  }

  async function duplicateTemplate(id) {
    const src = state.templates.find((t) => t.id === id);
    if (!src) return;
    const existingSlugs = new Set(state.templates.map((t) => t.slug));
    const payload = {
      slug: uniqueSlug(src.slug + "-copy", existingSlugs),
      category_id: src.category_id,
      title: src.title + " (copy)",
      body: src.body,
      variables: src.variables || [],
      notes: src.notes,
      tags: src.tags || [],
      images: src.images || []
    };
    showLoader(true);
    const { error } = await sb.from("templates").insert(payload);
    showLoader(false);
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll();
    renderAll();
    showToast("Duplicated — open the copy to edit", "success");
  }

  /* ═════════════ CLASSES ═════════════ */

  let editingClassId = null;

  function renderClassesTab() {
    renderSyncStatus();

    const showTest = !!state.cState.showTest;
    const visible = state.classes.filter((c) => showTest || !c.is_test);
    const totalCount = state.classes.length;
    const testCount  = state.classes.filter((c) => c.is_test).length;
    const el = $("#classTable");
    $("#classMeta").innerHTML = visible.length + (visible.length === 1 ? " class" : " classes") +
      (testCount > 0 ? ` <span style="color:var(--ink-dim)">· ${testCount} test class${testCount === 1 ? "" : "es"} hidden</span>`.replace("hidden", showTest ? "shown" : "hidden") : "");

    const showClassEdit = hasPerm("edit_classes") && canMutate();
    const typeLabel = { weekly: "Weekly", camp: "Camp", workshop: "Workshop", contracted: "Contracted" };
    const fmtSync = (ts) => {
      if (!ts) return '<span style="color:var(--ink-dim);font-size:11px">—</span>';
      const d = new Date(ts);
      const now = new Date();
      const diffMin = Math.round((now - d) / 60000);
      if (diffMin < 2) return '<span style="font-size:11px;color:var(--success)">just now</span>';
      if (diffMin < 60) return `<span style="font-size:11px">${diffMin}m ago</span>`;
      if (diffMin < 1440) return `<span style="font-size:11px">${Math.round(diffMin/60)}h ago</span>`;
      return `<span style="font-size:11px">${Math.round(diffMin/1440)}d ago</span>`;
    };

    const rows = visible.map((c) => {
      const sourceBadge = c.is_test
        ? '<span class="source-badge source-test">TEST</span>'
        : c.source === "jackrabbit"
          ? '<span class="source-badge source-jackrabbit">JR</span>'
          : '<span class="source-badge source-local">local</span>';
      const stateTag = c.sync_state === "dropped_from_source"
        ? ' <span class="sync-state-dropped_from_source">dropped from JR</span>'
        : "";
      const isOpen = state.cState.openClassId === c.id;
      const classTeacherRows = state.classTeachers.filter((ct) => ct.class_id === c.id)
        .map((ct) => ({ ...ct, teacher: state.teachers.find((t) => t.id === ct.teacher_id) }))
        .filter((x) => x.teacher);
      const primary = classTeacherRows.find((x) => x.role === "primary");
      const subs    = classTeacherRows.filter((x) => x.role !== "primary");
      const teacherCount = classTeacherRows.length;
      const igCount = state.classInfographics.filter((ci) => ci.class_id === c.id).length;
      const activeEnrollments = state.enrollments.filter((e) => e.class_id === c.id && e.status === "active").length;

      const teacherCell = (() => {
        if (!classTeacherRows.length) {
          return '<span style="font-size:11.5px;color:var(--ink-mute);font-style:italic">unassigned</span>';
        }
        const parts = [];
        if (primary) parts.push(`<span style="font-size:12.5px;color:var(--ink)"><b>${escapeHtml(primary.teacher.full_name)}</b></span>`);
        if (subs.length) {
          parts.push(`<div style="font-size:11px;color:var(--ink-dim)">+ ${subs.length} ${subs.length === 1 ? "other" : "others"}</div>`);
        }
        if (!primary && classTeacherRows[0]) {
          parts.push(`<span style="font-size:12.5px;color:var(--ink)">${escapeHtml(classTeacherRows[0].teacher.full_name)} <span style="font-size:10px;color:var(--ink-dim)">(${escapeHtml(classTeacherRows[0].role)})</span></span>`);
        }
        return parts.join("");
      })();

      const enrichSummary = (teacherCount || igCount || activeEnrollments)
        ? ` <span style="font-size:10.5px;color:var(--ink-dim)">· ${activeEnrollments} enrolled · ${teacherCount} teacher${teacherCount === 1 ? "" : "s"} · ${igCount} graphic${igCount === 1 ? "" : "s"}</span>`
        : ' <span style="font-size:10.5px;color:var(--ink-dim)">· no enrichment yet</span>';
      const mainRow = `
        <tr class="class-row${isOpen ? " open" : ""}" data-id="${escapeHtml(c.id)}"${c.is_test ? ' style="opacity:.6"' : ""}>
          <td><b>${escapeHtml(c.name)}</b>${sourceBadge}${stateTag}${enrichSummary}${c.age_range ? `<div style="font-size:11.5px;color:var(--ink-dim)">Ages ${escapeHtml(c.age_range)}</div>` : ""}</td>
          <td>${escapeHtml(c.day_time || "")}</td>
          <td>${escapeHtml(c.location || "")}</td>
          <td>${teacherCell}</td>
          <td><span class="type-badge type-${escapeHtml(c.type || "weekly")}">${typeLabel[c.type] || c.type || "—"}</span>${c.active === false ? ' <span style="color:var(--ink-dim);font-size:11px">(inactive)</span>' : ""}</td>
          <td>${c.registration_link ? `<a href="${escapeHtml(c.registration_link)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--accent);" onclick="event.stopPropagation()">Link ↗</a>` : '<span style="color:var(--ink-dim);font-size:12px">—</span>'}</td>
          <td>${fmtSync(c.last_synced_at)}</td>
          ${showClassEdit ? `<td class="row-actions"><button class="btn small ghost" data-act="edit-class" data-id="${escapeHtml(c.id)}">Edit</button></td>` : ""}
        </tr>
        <tr class="class-detail${isOpen ? " open" : ""}" data-detail-for="${escapeHtml(c.id)}">
          <td colspan="${showClassEdit ? 8 : 7}"><div class="class-detail-body" data-class-id="${escapeHtml(c.id)}"></div></td>
        </tr>
      `;
      return mainRow;
    }).join("");
    const colSpan = showClassEdit ? 8 : 7;
    el.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Day / Time</th><th>Location</th><th>Teacher</th><th>Type</th><th>Reg. link</th><th>Synced</th>${showClassEdit ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${colSpan}" style="text-align:center;color:var(--ink-dim);padding:24px">No classes to show.${showClassEdit ? " Click <b>⟳ Sync now</b> to pull from Jackrabbit, or <b>＋ New class</b>." : ""}</td></tr>`}</tbody>
      </table>
    `;
    if (showClassEdit) {
      $$('[data-act="edit-class"]', el).forEach((btn) => {
        btn.onclick = (e) => { e.stopPropagation(); openClassEditor(btn.dataset.id); };
      });
    }
    $$(".class-row", el).forEach((row) => {
      row.onclick = () => {
        const id = row.dataset.id;
        state.cState.openClassId = (state.cState.openClassId === id) ? null : id;
        renderClassesTab();
      };
    });
    // Render detail body for the open class
    if (state.cState.openClassId) {
      const cls = state.classes.find((c) => c.id === state.cState.openClassId);
      if (cls) {
        const body = $(`.class-detail-body[data-class-id="${state.cState.openClassId}"]`, el);
        if (body) renderClassDetail(body, cls);
      }
    }
  }

  /* Class detail panel rendering — teacher assignments + infographic links + JR meta + enrollments */
  function renderClassDetail(rootEl, cls) {
    const teachers = state.classTeachers.filter((ct) => ct.class_id === cls.id)
      .map((ct) => ({ ...ct, teacher: state.teachers.find((t) => t.id === ct.teacher_id) }))
      .filter((x) => x.teacher);
    const linkedIgIds = new Set(state.classInfographics.filter((ci) => ci.class_id === cls.id).map((ci) => ci.infographic_id));
    const classEnrollments = state.enrollments.filter((e) => e.class_id === cls.id)
      .map((e) => ({ ...e, student: state.students.find((s) => s.id === e.student_id) }))
      .filter((x) => x.student);

    rootEl.innerHTML = `
      <div class="panels-grid">
        <div>
          <div class="section-title">Teachers</div>
          <div class="teacher-list"></div>
          <div class="add-assign">
            <select class="select-teacher"><option value="">— Add teacher —</option></select>
            <select class="select-role">
              <option value="primary">Primary</option>
              <option value="substitute">Substitute</option>
              <option value="assistant">Assistant</option>
              <option value="co-teacher">Co-teacher</option>
            </select>
            <button class="btn primary small" data-act="add-teacher">Add</button>
          </div>
        </div>
        <div>
          <div class="section-title">Linked infographics <span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">(click to toggle)</span></div>
          <div class="ig-chip-grid"></div>
        </div>
      </div>
      <div style="margin-top:16px">
        <div class="section-title">Enrollments <span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">(${classEnrollments.filter(e => e.status === 'active').length} active${classEnrollments.length > classEnrollments.filter(e => e.status === 'active').length ? ' · ' + (classEnrollments.length - classEnrollments.filter(e => e.status === 'active').length) + ' inactive' : ''})</span></div>
        <div class="reconcile-banner"></div>
        <div class="enrollments-list"></div>
        <div class="add-student-row" style="margin-top:8px"></div>
      </div>
      <div style="margin-top:16px">
        <div class="section-title">Attendance</div>
        <div class="attendance-section"></div>
      </div>
      <div style="margin-top:16px">
        <div class="section-title">Class details (from Jackrabbit)</div>
        <div class="panels-grid">
          <div>
            <div class="info-pair"><span class="k">JR ID</span><span class="v">${escapeHtml(cls.jackrabbit_class_id || "—")}</span></div>
            <div class="info-pair"><span class="k">Session</span><span class="v">${escapeHtml(cls.session || "—")}</span></div>
            <div class="info-pair"><span class="k">Tuition</span><span class="v">${escapeHtml(cls.tuition || "—")}</span></div>
            <div class="info-pair"><span class="k">Openings</span><span class="v">${cls.openings == null ? "—" : cls.openings}</span></div>
            <div class="info-pair"><span class="k">Dates</span><span class="v">${escapeHtml(cls.start_date || "—")} → ${escapeHtml(cls.end_date || "—")}</span></div>
          </div>
          <div>
            <div class="info-pair"><span class="k">Cat 1</span><span class="v">${escapeHtml(cls.cat1 || "—")}</span></div>
            <div class="info-pair"><span class="k">Cat 2</span><span class="v">${escapeHtml(cls.cat2 || "—")}</span></div>
            <div class="info-pair"><span class="k">Cat 3</span><span class="v">${escapeHtml(cls.cat3 || "—")}</span></div>
            <div class="info-pair"><span class="k">Room</span><span class="v">${escapeHtml(cls.room || "—")}</span></div>
            <div class="info-pair"><span class="k">JR instructors</span><span class="v">${escapeHtml(cls.instructors || "—")}</span></div>
          </div>
        </div>
        ${cls.description ? `<div class="jr-description" style="margin-top:8px">${escapeHtml(cls.description)}</div>` : ""}
      </div>
    `;

    // Teacher list
    const tlist = $(".teacher-list", rootEl);
    if (teachers.length === 0) {
      tlist.innerHTML = '<div style="font-size:12.5px;color:var(--ink-dim);padding:8px 0">No teachers assigned yet.</div>';
    } else {
      teachers.forEach(({ teacher, role, class_id }) => {
        const row = document.createElement("div");
        row.className = "assign-row";
        row.innerHTML = `
          <span class="teacher-name">${escapeHtml(teacher.full_name)}${teacher.status !== 'active' ? ` <span style="font-size:11px;color:var(--ink-dim)">(${escapeHtml(teacher.status)})</span>` : ""}</span>
          <span class="role-tag role-${escapeHtml(role)}">${escapeHtml(role)}</span>
          <button class="btn small ghost danger" data-act="remove-teacher" data-teacher="${escapeHtml(teacher.id)}" data-role="${escapeHtml(role)}">✕</button>
        `;
        $('[data-act="remove-teacher"]', row).onclick = async (e) => {
          e.stopPropagation();
          const { error } = await sb.from("class_teachers").delete()
            .eq("class_id", class_id).eq("teacher_id", teacher.id).eq("role", role);
          if (error) { showToast(error.message, "error"); return; }
          await reloadAll(); renderAll();
          showToast("Teacher removed", "success");
        };
        tlist.appendChild(row);
      });
    }
    // Populate teacher select with active teachers not already in the same role
    const sel = $(".select-teacher", rootEl);
    const assignedTeacherIds = new Set(teachers.map((x) => x.teacher.id + ":" + x.role));
    state.teachers.filter((t) => t.status !== 'inactive').forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.full_name;
      sel.appendChild(opt);
    });
    $('[data-act="add-teacher"]', rootEl).onclick = async (e) => {
      e.stopPropagation();
      const teacherId = sel.value;
      const role = $(".select-role", rootEl).value;
      if (!teacherId) { showToast("Pick a teacher first", "error"); return; }
      if (assignedTeacherIds.has(teacherId + ":" + role)) { showToast("Already assigned in that role", "error"); return; }
      const { error } = await sb.from("class_teachers").insert({ class_id: cls.id, teacher_id: teacherId, role });
      if (error) { showToast(error.message, "error"); return; }
      await reloadAll(); renderAll();
      showToast("Teacher assigned", "success");
    };

    // Enrollments list
    const enrollList = $(".enrollments-list", rootEl);
    if (enrollList) {
      if (classEnrollments.length === 0) {
        enrollList.innerHTML = '<div style="font-size:12.5px;color:var(--ink-dim);padding:8px 0">No enrollments yet. They\'ll appear here when Zapier sends them from Jackrabbit.</div>';
      } else {
        enrollList.innerHTML = "";
        const activeFirst = [...classEnrollments].sort((a, b) => {
          const aActive = a.status === "active" ? 0 : 1;
          const bActive = b.status === "active" ? 0 : 1;
          if (aActive !== bActive) return aActive - bActive;
          return (a.student.last_name || "").localeCompare(b.student.last_name || "");
        });
        activeFirst.forEach(({ student, status, drop_reason, dropped_at, enrolled_at }) => {
          const row = document.createElement("div");
          row.className = "assign-row";
          const statusClass = status === "active" ? "role-primary" : status === "waitlist" ? "role-substitute" : status === "dropped" ? "role-co-teacher" : "role-assistant";
          const localBadge = student.source === "dk_local"
            ? ' <span class="source-badge source-local" title="Added directly in DK — not from Jackrabbit">local</span>'
            : "";
          row.innerHTML = `
            <span class="teacher-name">${escapeHtml(student.first_name || "")} ${escapeHtml(student.last_name || "")}${localBadge}${student.dob ? ` <span style="font-size:11px;color:var(--ink-dim);font-weight:400">· DoB ${escapeHtml(student.dob)}</span>` : ""}</span>
            <span class="role-tag ${statusClass}">${escapeHtml(status)}</span>
            ${drop_reason ? `<span style="font-size:11px;color:var(--ink-dim)">· ${escapeHtml(drop_reason)}</span>` : ""}
          `;
          enrollList.appendChild(row);
        });
      }
    }

    // Match-candidate banner: shown when admins view a class whose roster
    // has any unresolved duplicate flag. Teachers can't SELECT the candidate
    // table (RLS) so state.matchCandidates is empty for them.
    const banner = $(".reconcile-banner", rootEl);
    if (banner) {
      banner.innerHTML = "";
      if (hasPerm("reconcile_students")) {
        const enrolledStudentIds = new Set(classEnrollments.map(e => e.student.id));
        const relevant = state.matchCandidates.filter(c =>
          enrolledStudentIds.has(c.dk_student_id) || enrolledStudentIds.has(c.jr_student_id)
        );
        if (relevant.length > 0) {
          const b = document.createElement("div");
          b.style.cssText = "padding:8px 12px;background:#fff7e6;border:1px solid #f0d88a;border-radius:8px;font-size:12.5px;margin:6px 0 8px;color:#7a5b00;display:flex;align-items:center;gap:8px;justify-content:space-between";
          b.innerHTML = `<span><b>${relevant.length}</b> possible duplicate${relevant.length > 1 ? "s" : ""} in this roster</span><button class="btn small" data-act="open-reconcile">Review</button>`;
          $('[data-act="open-reconcile"]', b).onclick = (e) => {
            e.stopPropagation();
            openReconcileModal(relevant[0].id);
          };
          banner.appendChild(b);
        }
      }
    }

    // "+ Add student" row: visible to admins always, and to teachers who
    // are assigned to THIS class (their perm mirrors the RLS scope).
    const addRow = $(".add-student-row", rootEl);
    if (addRow) {
      addRow.innerHTML = "";
      const canAddAsAdmin = hasPerm("edit_students");
      const canAddAsTeacher = hasPerm("manage_own_roster_students") &&
        teachers.some(t => t.teacher && (t.teacher.email || "").toLowerCase() ===
          (state.session?.user?.email || "").toLowerCase());
      if (canAddAsAdmin || canAddAsTeacher) {
        const btn = document.createElement("button");
        btn.className = "btn small";
        btn.textContent = "+ Add student";
        btn.onclick = (e) => { e.stopPropagation(); openAddStudentModal(cls); };
        addRow.appendChild(btn);
      }
    }

    // Attendance section: session history + "Take attendance for today" CTA.
    // Visible if the user can see any attendance data (RLS already filters
    // state.attendance — if the list is empty for this class, we still show
    // the take-attendance CTA so teachers can start fresh).
    const attSection = $(".attendance-section", rootEl);
    if (attSection) {
      attSection.innerHTML = "";
      const today = isoDate(new Date());
      const todayIsClassDay = classRunsOnDay(cls, new Date());
      // Admins can take/edit attendance any day (date picker handles
      // off-day sessions like make-ups or test classes with no schedule).
      // Teachers only see the button when canTakeAttendanceFor passes
      // (assignment + 2-day grace window).
      const canTake = isAdminOrAbove() || canTakeAttendanceFor(cls, today);

      // Row containing the two primary actions: Take attendance + Clock in/out.
      const actionRow = document.createElement("div");
      actionRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;align-items:center";

      if (canTake) {
        const btn = document.createElement("button");
        btn.className = "btn primary small";
        const todayStats = attendanceStatsForSession(cls.id, today);
        if (todayStats.taken) {
          btn.textContent = "Edit today's attendance";
        } else if (todayIsClassDay) {
          btn.textContent = "Take attendance for today";
        } else {
          btn.textContent = "Take attendance";
        }
        btn.onclick = (e) => { e.stopPropagation(); openAttendanceModal(cls, today); };
        actionRow.appendChild(btn);
      } else if (todayIsClassDay) {
        const note = document.createElement("div");
        note.style.cssText = "font-size:12.5px;color:var(--ink-dim)";
        note.textContent = "Today is a class day — but you're outside the window to take attendance for it.";
        actionRow.appendChild(note);
      }

      // Clock-in / Clock-out button (T3d). Resolves the signed-in user's
      // teachers row by email; shows clocked-in time if already clocked in.
      // Admins without a teachers row will see an error toast on click —
      // that's fine for v1 (tells them they need a teachers entry).
      const myEmail = (state.session?.user?.email || "").toLowerCase();
      const myTeacher = myEmail
        ? state.teachers.find((t) => (t.email || "").toLowerCase() === myEmail)
        : null;
      if (myTeacher) {
        const shift = state.clockIns.find(
          (c) => c.teacher_id === myTeacher.id && c.class_id === cls.id && c.session_date === today
        );
        if (!shift) {
          const btn = document.createElement("button");
          btn.className = "btn small";
          btn.textContent = "Clock in";
          btn.onclick = (e) => { e.stopPropagation(); doClockIn(cls.id); };
          actionRow.appendChild(btn);
        } else if (!shift.clocked_out_at) {
          const mins = Math.max(0, Math.round((new Date() - new Date(shift.clocked_in_at)) / 60000));
          const label = document.createElement("span");
          label.style.cssText = "font-size:12.5px;color:#2f7d3a";
          label.textContent = `⏱ Clocked in · ${mins} min`;
          const btn = document.createElement("button");
          btn.className = "btn small";
          btn.textContent = "Clock out";
          btn.onclick = (e) => { e.stopPropagation(); doClockOut(shift.id); };
          actionRow.appendChild(label);
          actionRow.appendChild(btn);
        } else {
          const durMin = Math.max(0, Math.round(
            (new Date(shift.clocked_out_at) - new Date(shift.clocked_in_at)) / 60000
          ));
          const label = document.createElement("span");
          label.style.cssText = "font-size:12.5px;color:var(--ink-dim)";
          label.textContent = `✓ Shift done · ${durMin} min`;
          actionRow.appendChild(label);
        }
      }

      if (actionRow.children.length > 0) {
        attSection.appendChild(actionRow);
      }

      // Session history table (most recent 8)
      const sessionDates = recentSessionDatesForClass(cls.id, 8);
      if (sessionDates.length === 0) {
        const empty = document.createElement("div");
        empty.style.cssText = "font-size:12.5px;color:var(--ink-dim);padding:4px 0";
        empty.textContent = "No attendance recorded yet for this class.";
        attSection.appendChild(empty);
      } else {
        const list = document.createElement("div");
        list.style.cssText = "display:flex;flex-direction:column;gap:4px;margin-top:4px";
        sessionDates.forEach((d) => {
          const stats = attendanceStatsForSession(cls.id, d);
          const canEdit = canTakeAttendanceFor(cls, d);
          const row = document.createElement("div");
          row.className = "assign-row";
          row.style.cssText = "display:flex;gap:8px;align-items:center;padding:6px 8px;background:var(--surface,#fff);border:1px solid var(--border);border-radius:6px";
          const dateLabel = new Date(d + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
          const lateBit = stats.latePickups > 0
            ? ` · <span style="color:#a36a00">${stats.latePickups} late pickup${stats.latePickups === 1 ? "" : "s"} (${stats.lateMinutes} min)</span>`
            : "";
          row.innerHTML = `
            <span style="flex:0 0 140px;font-weight:500">${escapeHtml(dateLabel)}</span>
            <span style="font-size:12px;color:var(--ink-dim);flex:1">
              ${stats.present} present · ${stats.absent} absent${lateBit}
            </span>
          `;
          if (canEdit) {
            const editBtn = document.createElement("button");
            editBtn.className = "btn small";
            editBtn.textContent = "Edit";
            editBtn.onclick = (e) => { e.stopPropagation(); openAttendanceModal(cls, d); };
            row.appendChild(editBtn);
          }
          list.appendChild(row);
        });
        attSection.appendChild(list);
      }
    }

    // Infographic chip grid
    const grid = $(".ig-chip-grid", rootEl);
    if (state.infographics.length === 0) {
      grid.innerHTML = '<div style="font-size:12.5px;color:var(--ink-dim);padding:8px 0">No infographics yet. Add some on the Infographics tab.</div>';
    } else {
      state.infographics.forEach((ig) => {
        const isLinked = linkedIgIds.has(ig.id);
        const chip = document.createElement("div");
        chip.className = "ig-chip" + (isLinked ? " linked" : "");
        chip.innerHTML = `<span class="check">${isLinked ? "✓" : "+"}</span><span>${escapeHtml(ig.name)}</span>`;
        chip.onclick = async (e) => {
          e.stopPropagation();
          if (isLinked) {
            const { error } = await sb.from("class_infographics").delete()
              .eq("class_id", cls.id).eq("infographic_id", ig.id);
            if (error) { showToast(error.message, "error"); return; }
          } else {
            const { error } = await sb.from("class_infographics").insert({ class_id: cls.id, infographic_id: ig.id });
            if (error) { showToast(error.message, "error"); return; }
          }
          await reloadAll(); renderAll();
        };
        grid.appendChild(chip);
      });
    }
  }

  /* ═════════════ T3a: Add-student + Reconcile modals ═════════════
   * Teacher/admin adds a DK-local student to a class (contracted classes
   * or late adds to JR classes). The student INSERT fires a server-side
   * trigger that auto-flags match candidates against JR records; admins
   * resolve them from the class-panel banner via reconcile_students RPC.
   */
  let addStudentTargetClassId = null;
  let reconcileCandidateId = null;

  function openAddStudentModal(cls) {
    addStudentTargetClassId = cls.id;
    $("#addStudentClassBanner").innerHTML =
      `Adding a student to <b>${escapeHtml(cls.name || "this class")}</b>` +
      (cls.location ? ` <span style="color:var(--ink-dim)">· ${escapeHtml(cls.location)}</span>` : "");
    $("#addStudentSourceWarn").style.display = cls.source === "jackrabbit" ? "" : "none";
    $("#as_first_name").value = "";
    $("#as_last_name").value = "";
    $("#as_dob").value = "";
    $("#addStudentModalOverlay").classList.add("open");
    setTimeout(() => $("#as_first_name").focus(), 50);
  }

  function closeAddStudentModal() {
    $("#addStudentModalOverlay").classList.remove("open");
    addStudentTargetClassId = null;
  }

  async function saveAddStudent() {
    const classId = addStudentTargetClassId;
    if (!classId) { showToast("No class selected", "error"); return; }
    const first = $("#as_first_name").value.trim();
    const last  = $("#as_last_name").value.trim();
    const dob   = $("#as_dob").value || null;
    if (!first || !last) { showToast("First and last name are required", "error"); return; }

    showLoader(true);
    // Generate the student id client-side so we can chain the enrollment
    // insert without needing SELECT visibility back on the just-inserted
    // student row (teachers can't SELECT a student until an enrollment
    // links them to a class the teacher is assigned to).
    const newStudentId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : null;
    if (!newStudentId) { showLoader(false); showToast("This browser lacks crypto.randomUUID", "error"); return; }
    const studentPayload = {
      id: newStudentId,
      first_name: first,
      last_name: last,
      dob,
      source: "dk_local",
      jackrabbit_student_id: null,
      created_by: state.session?.user?.id || null,
    };
    const stuResp = await sb.from("students").insert(studentPayload);
    if (stuResp.error) {
      showLoader(false);
      showToast("Add student failed: " + stuResp.error.message, "error");
      return;
    }
    const enrollPayload = {
      student_id: newStudentId,
      class_id: classId,
      status: "active",
      source: "dk_local",
      enrolled_at: new Date().toISOString(),
      created_by: state.session?.user?.id || null,
    };
    const enrResp = await sb.from("enrollments").insert(enrollPayload);
    showLoader(false);
    if (enrResp.error) {
      showToast("Student created but enrollment failed: " + enrResp.error.message, "error");
      await reloadAll(); renderAll();
      return;
    }
    await reloadAll(); renderAll();
    closeAddStudentModal();
    showToast(`${first} ${last} added to class`, "success");
  }

  function openReconcileModal(candidateId) {
    const cand = state.matchCandidates.find((c) => c.id === candidateId);
    if (!cand) { showToast("Match candidate not found", "error"); return; }
    reconcileCandidateId = candidateId;
    const dk = state.students.find((s) => s.id === cand.dk_student_id);
    const jr = state.students.find((s) => s.id === cand.jr_student_id);
    const reasonLabel = cand.match_reason === "name_dob" ? "Exact name + date of birth"
      : cand.match_reason === "name_phonetic_dob" ? "Phonetic surname + date of birth"
      : cand.match_reason === "family_id" ? "Same Jackrabbit family + first name"
      : cand.match_reason;
    $("#reconcileReason").innerHTML = `<b>Match reason:</b> ${escapeHtml(reasonLabel)}`;

    const card = (s, label) => {
      if (!s) return `<div style="padding:12px;border:1px solid var(--border);border-radius:8px">${label}: <i>row missing</i></div>`;
      const enrollCount = state.enrollments.filter((e) => e.student_id === s.id).length;
      return `
        <div style="padding:12px;border:1px solid var(--border);border-radius:8px">
          <div style="font-size:11px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.5px">${label}</div>
          <div style="font-weight:600;margin-top:4px">${escapeHtml(s.first_name || "")} ${escapeHtml(s.last_name || "")}</div>
          <div style="font-size:12.5px;color:var(--ink-dim);margin-top:4px">
            Source: <b>${escapeHtml(s.source || "?")}</b><br/>
            DoB: ${escapeHtml(s.dob || "—")}<br/>
            JR ID: ${escapeHtml(s.jackrabbit_student_id || "—")}<br/>
            Family ID: ${escapeHtml(s.family_id || "—")}<br/>
            Enrollments: ${enrollCount}
          </div>
        </div>`;
    };
    $("#reconcileCompare").innerHTML = card(dk, "DK-local row") + card(jr, "Jackrabbit row");
    $("#reconcileModalOverlay").classList.add("open");
  }

  function closeReconcileModal() {
    $("#reconcileModalOverlay").classList.remove("open");
    reconcileCandidateId = null;
  }

  async function resolveReconcile(action) {
    const candId = reconcileCandidateId;
    if (!candId) return;
    const cand = state.matchCandidates.find((c) => c.id === candId);
    if (!cand) { showToast("Candidate not found", "error"); return; }
    showLoader(true);
    try {
      if (action === "link") {
        const { error } = await sb.rpc("reconcile_students", { p_candidate_id: candId });
        if (error) throw error;
        showToast("Linked — DK row archived, enrollments moved to JR record", "success");
      } else if (action === "keep") {
        const { error } = await sb.from("student_match_candidates")
          .update({
            resolved_at: new Date().toISOString(),
            resolved_by: state.session?.user?.id || null,
            resolution: "kept_separate",
          })
          .eq("id", candId);
        if (error) throw error;
        showToast("Kept separate", "success");
      } else if (action === "delete") {
        // Delete the DK-local row (cascade removes its enrollments), then
        // mark the candidate resolved as dk_deleted.
        const { error: delErr } = await sb.from("students").delete().eq("id", cand.dk_student_id);
        if (delErr) throw delErr;
        await sb.from("student_match_candidates")
          .update({
            resolved_at: new Date().toISOString(),
            resolved_by: state.session?.user?.id || null,
            resolution: "dk_deleted",
          })
          .eq("id", candId);
        showToast("DK-local row deleted", "success");
      }
      await reloadAll(); renderAll();
      closeReconcileModal();
    } catch (e) {
      showToast(e.message || "Reconcile failed", "error");
    } finally {
      showLoader(false);
    }
  }

  /* ═════════════ T3b: Attendance capture ═════════════
   * Attendance is enrollment-scoped: one row per (enrollment, session_date).
   * The modal loads the current session's marks, lets the user toggle per
   * student between Present/Late/Absent/Excused (unset = "unknown" = no row
   * sent), and bulk-upserts via the take_attendance RPC.
   *
   * Teachers can only take/edit within the 2-day RLS grace window on
   * classes they're assigned to; admins have no window. Date picker's
   * `min` and `max` reflect this.
   */
  // Status is now simplified to Present / Absent. Late pickup is tracked
  // independently via late_pickup_minutes (separate from status because a
  // student can be present AND late-pickup, and franchises may bill late-
  // pickup fees separately). 'late' and 'excused' remain valid DB values
  // for historical rows and future UIs, but the v1 roster only emits P/A.
  const ATT_STATUSES = ["present","absent"];
  let attendanceModalClassId = null;
  let attendanceModalSessionDate = null;
  // per-enrollment status overrides during an open modal session:
  // { [enrollment_id]: "present"|"absent"|"unknown" }
  let attendancePendingMarks = {};
  // per-enrollment notes overrides during an open modal session
  let attendancePendingNotes = {};
  // per-enrollment late_pickup_minutes overrides during an open modal session.
  // Value is a number, 0, or null. null = clear; 0 = explicitly "no late pickup".
  let attendancePendingLateMinutes = {};

  // Build a (enrollment_id -> attendance row) map for a class+date session.
  function attendanceMapForSession(classId, sessionDate) {
    const classEnrollmentIds = new Set(
      state.enrollments.filter((e) => e.class_id === classId).map((e) => e.id)
    );
    const out = new Map();
    for (const a of state.attendance) {
      if (!classEnrollmentIds.has(a.enrollment_id)) continue;
      if (a.session_date !== sessionDate) continue;
      out.set(a.enrollment_id, a);
    }
    return out;
  }

  // Aggregate counts for a class's session. `taken` = at least one non-unknown
  // row. latePickups counts rows where late_pickup_minutes > 0 (independent
  // of status). Historical rows with status='late'/'excused' are still
  // counted — 'late' folds into present for display, 'excused' into absent —
  // so stats remain readable across schema versions.
  function attendanceStatsForSession(classId, sessionDate) {
    const map = attendanceMapForSession(classId, sessionDate);
    const stats = { present: 0, absent: 0, latePickups: 0, lateMinutes: 0, unknown: 0, taken: false };
    for (const a of map.values()) {
      if (a.status === "present" || a.status === "late") stats.present++;
      else if (a.status === "absent" || a.status === "excused") stats.absent++;
      else stats.unknown++;
      if (a.status && a.status !== "unknown") stats.taken = true;
      if (a.late_pickup_minutes && a.late_pickup_minutes > 0) {
        stats.latePickups++;
        stats.lateMinutes += a.late_pickup_minutes;
      }
    }
    return stats;
  }

  // List recent session_dates for a class (descending) with row coverage.
  function recentSessionDatesForClass(classId, limit) {
    const classEnrollmentIds = new Set(
      state.enrollments.filter((e) => e.class_id === classId).map((e) => e.id)
    );
    const dates = new Set();
    for (const a of state.attendance) {
      if (classEnrollmentIds.has(a.enrollment_id)) dates.add(a.session_date);
    }
    return [...dates].sort((a, b) => (a < b ? 1 : -1)).slice(0, limit || 8);
  }

  function openAttendanceModal(cls, sessionDate) {
    attendanceModalClassId = cls.id;
    attendanceModalSessionDate = sessionDate || isoDate(new Date());
    attendancePendingMarks = {};
    attendancePendingNotes = {};
    attendancePendingLateMinutes = {};

    $("#attendanceClassBanner").innerHTML =
      `Taking attendance for <b>${escapeHtml(cls.name || "this class")}</b>` +
      (cls.location ? ` <span style="color:var(--ink-dim)">· ${escapeHtml(cls.location)}</span>` : "");

    const picker = $("#att_session_date");
    picker.value = attendanceModalSessionDate;
    // Admins: unconstrained (can edit history). Teachers: 2-day window, no future.
    const note = $("#attendanceWindowNote");
    if (isAdminOrAbove()) {
      picker.removeAttribute("min");
      picker.removeAttribute("max");
      note.style.display = "none";
    } else {
      const today = new Date();
      const earliest = new Date(today); earliest.setDate(earliest.getDate() - 2);
      picker.min = isoDate(earliest);
      picker.max = isoDate(today);
      note.style.display = "";
      note.textContent = "Teachers can take or edit attendance within a 2-day grace window.";
    }
    picker.onchange = () => {
      attendanceModalSessionDate = picker.value;
      attendancePendingMarks = {};
      attendancePendingNotes = {};
      attendancePendingLateMinutes = {};
      renderAttendanceRoster();
    };

    renderAttendanceRoster();
    $("#attendanceModalOverlay").classList.add("open");
  }

  function closeAttendanceModal() {
    $("#attendanceModalOverlay").classList.remove("open");
    attendanceModalClassId = null;
    attendanceModalSessionDate = null;
    attendancePendingMarks = {};
    attendancePendingNotes = {};
    attendancePendingLateMinutes = {};
  }

  // Re-render the student list in the modal based on current state.
  function renderAttendanceRoster() {
    const host = $("#attendanceRoster");
    if (!host) return;
    const cls = state.classes.find((c) => c.id === attendanceModalClassId);
    if (!cls) { host.innerHTML = ""; return; }
    const enrollments = state.enrollments
      .filter((e) => e.class_id === cls.id && e.status === "active")
      .map((e) => ({ ...e, student: state.students.find((s) => s.id === e.student_id) }))
      .filter((x) => x.student && !x.student.archived_at)
      .sort((a, b) => (a.student.last_name || "").localeCompare(b.student.last_name || ""));

    if (enrollments.length === 0) {
      host.innerHTML = '<div style="font-size:12.5px;color:var(--ink-dim);padding:12px 0">No active enrollments for this class.</div>';
      return;
    }

    const existing = attendanceMapForSession(cls.id, attendanceModalSessionDate);
    const rowsHtml = enrollments.map(({ id, student }) => {
      const existingRow = existing.get(id);
      // Normalize legacy status values so P/A buttons still reflect them.
      const existingStatus = (() => {
        const s = existingRow?.status;
        if (s === "late") return "present";
        if (s === "excused") return "absent";
        return s || "unknown";
      })();
      const pending = attendancePendingMarks[id];
      const currentStatus = pending !== undefined ? pending : existingStatus;
      const existingNotes = existingRow?.notes || "";
      const currentNotes = attendancePendingNotes[id] !== undefined ? attendancePendingNotes[id] : existingNotes;
      const existingLateMin = existingRow?.late_pickup_minutes ?? null;
      const currentLateMin = attendancePendingLateMinutes[id] !== undefined
        ? attendancePendingLateMinutes[id]
        : existingLateMin;
      const lateVal = (currentLateMin != null && currentLateMin > 0) ? String(currentLateMin) : "";

      const btns = ATT_STATUSES.map((s) => {
        const active = currentStatus === s;
        const label = s === "present" ? "Present" : "Absent";
        const color = active
          ? (s === "present" ? "#2f7d3a" : "#b3341c")
          : "transparent";
        return `<button data-att-btn data-enr="${escapeHtml(id)}" data-status="${s}" title="${s}"
          style="border:1px solid var(--border);background:${active ? color : "var(--surface)"};color:${active ? "#fff" : "var(--ink)"};border-radius:6px;padding:4px 12px;font-size:12px;font-weight:600;cursor:pointer">${label}</button>`;
      }).join(" ");

      return `
        <div class="att-row" style="display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border-subtle,#eee)">
          <div>
            <div style="font-weight:500">${escapeHtml(student.first_name || "")} ${escapeHtml(student.last_name || "")}</div>
            <div style="display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap">
              <input type="text" data-att-notes data-enr="${escapeHtml(id)}" placeholder="Notes (optional)" value="${escapeHtml(currentNotes)}"
                style="flex:1;min-width:140px;max-width:260px;font-size:11.5px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;color:var(--ink-dim);background:transparent" />
              <label style="display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--ink-dim)">
                <span>Late pickup</span>
                <input type="number" min="0" step="1" data-att-late data-enr="${escapeHtml(id)}" value="${lateVal}" placeholder="min"
                  ${currentStatus === "absent" ? "disabled" : ""}
                  style="width:60px;font-size:11.5px;padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:transparent" />
              </label>
            </div>
          </div>
          <div style="display:flex;gap:6px">${btns}</div>
        </div>`;
    }).join("");

    host.innerHTML = rowsHtml;

    // Wire status buttons — click toggles; clicking the active status clears to 'unknown'.
    // Marking a student Absent also clears their late-pickup minutes (can't be late picked-up if not present).
    host.querySelectorAll("[data-att-btn]").forEach((b) => {
      b.onclick = () => {
        const enr = b.dataset.enr;
        const status = b.dataset.status;
        const existingRow = existing.get(enr);
        const existingStatus = (() => {
          const s = existingRow?.status;
          if (s === "late") return "present";
          if (s === "excused") return "absent";
          return s || "unknown";
        })();
        const pending = attendancePendingMarks[enr];
        const current = pending !== undefined ? pending : existingStatus;
        if (current === status) {
          attendancePendingMarks[enr] = "unknown";
        } else {
          attendancePendingMarks[enr] = status;
          if (status === "absent") attendancePendingLateMinutes[enr] = null;
        }
        renderAttendanceRoster();
      };
    });
    host.querySelectorAll("[data-att-notes]").forEach((inp) => {
      inp.oninput = () => { attendancePendingNotes[inp.dataset.enr] = inp.value; };
    });
    host.querySelectorAll("[data-att-late]").forEach((inp) => {
      inp.oninput = () => {
        const v = inp.value.trim();
        attendancePendingLateMinutes[inp.dataset.enr] = v === "" ? null : Math.max(0, parseInt(v, 10) || 0);
      };
    });
  }

  async function markAllPresent() {
    const cls = state.classes.find((c) => c.id === attendanceModalClassId);
    if (!cls) return;
    const enrollments = state.enrollments
      .filter((e) => e.class_id === cls.id && e.status === "active");
    for (const e of enrollments) attendancePendingMarks[e.id] = "present";
    renderAttendanceRoster();
  }

  async function saveAttendance() {
    const classId = attendanceModalClassId;
    const sessionDate = attendanceModalSessionDate;
    if (!classId || !sessionDate) { showToast("No session loaded", "error"); return; }

    // Build entries array. Merge pending marks with existing rows so notes or
    // late-pickup-only changes still get persisted. Skip entries where the
    // effective status is 'unknown', there's no late pickup, AND there was
    // no existing row (nothing to record).
    const existing = attendanceMapForSession(classId, sessionDate);
    const activeEnrollments = state.enrollments
      .filter((e) => e.class_id === classId && e.status === "active");
    const entries = [];
    for (const e of activeEnrollments) {
      const prior = existing.get(e.id);
      const priorStatus = prior?.status || "unknown";
      const priorNotes  = prior?.notes || "";
      const priorLate   = prior?.late_pickup_minutes ?? null;
      const status = attendancePendingMarks[e.id] !== undefined ? attendancePendingMarks[e.id] : priorStatus;
      const notes  = attendancePendingNotes[e.id] !== undefined ? attendancePendingNotes[e.id] : priorNotes;
      const lateMin = attendancePendingLateMinutes[e.id] !== undefined
        ? attendancePendingLateMinutes[e.id]
        : priorLate;
      // Absent students can't have a late pickup; null it.
      const effectiveLate = status === "absent" ? null : lateMin;
      if (status === "unknown" && !effectiveLate && !prior) continue;
      entries.push({
        enrollment_id: e.id,
        status,
        notes: notes || null,
        late_pickup_minutes: effectiveLate != null && effectiveLate > 0 ? effectiveLate : null,
      });
    }

    if (entries.length === 0) {
      showToast("Mark at least one student before saving", "error");
      return;
    }

    showLoader(true);
    const { error } = await sb.rpc("take_attendance", {
      p_class_id: classId,
      p_session_date: sessionDate,
      p_entries: entries,
    });
    showLoader(false);
    if (error) { showToast("Save failed: " + error.message, "error"); return; }
    await reloadAll(); renderAll();
    closeAttendanceModal();
    showToast(`Attendance saved (${entries.length})`, "success");
  }

  /* ═════════════ Reports tab ═════════════
   * Admin-only aggregation views that sit alongside the operational tabs.
   * Registered reports:
   *   - attendance: overall summary + per-class breakdown + late-pickup log
   * Adding a new report:
   *   1. Add to REPORTS list (id, label, render fn)
   *   2. Implement the render fn — it receives state.rptState and the
   *      #reportContent DOM node.
   */
  const REPORTS = [
    { id: "attendance", label: "Attendance", render: renderAttendanceReport },
    { id: "teacher_hours", label: "Teacher hours", render: renderTeacherHoursReport },
  ];

  function ensureReportDateDefaults() {
    if (state.rptState.start && state.rptState.end) return;
    const today = new Date();
    const start = new Date(today); start.setDate(start.getDate() - 29);
    state.rptState.start = isoDate(start);
    state.rptState.end   = isoDate(today);
  }

  function renderReportsTab() {
    const panel = document.querySelector('.tab-panel[data-tab="reports"]');
    if (!panel) return;
    // Gate: only render when the user is allowed on this tab.
    if (!canSeeTab("reports")) return;
    ensureReportDateDefaults();

    // Sub-nav
    const subNav = $("#reportSubNav");
    if (subNav) {
      subNav.innerHTML = REPORTS.map((r) => {
        const active = r.id === state.rptState.active;
        return `<button data-report="${escapeHtml(r.id)}" class="btn small"
          style="${active ? "background:var(--accent,#2d2d2d);color:#fff;border-color:var(--accent,#2d2d2d)" : ""}">${escapeHtml(r.label)}</button>`;
      }).join(" ");
      subNav.querySelectorAll("[data-report]").forEach((b) => {
        b.onclick = () => {
          state.rptState.active = b.dataset.report;
          renderReportsTab();
        };
      });
    }

    const content = $("#reportContent");
    if (!content) return;
    const active = REPORTS.find((r) => r.id === state.rptState.active) || REPORTS[0];
    active.render(content);
  }

  // Filter state.attendance by [start, end] inclusive (ISO dates).
  function attendanceInRange(start, end) {
    return state.attendance.filter((a) => a.session_date >= start && a.session_date <= end);
  }

  function renderAttendanceReport(host) {
    const s = state.rptState;
    const rows = attendanceInRange(s.start, s.end);

    // Aggregate: total sessions = distinct (class_id, session_date) pairs.
    const sessionKeys = new Set();
    let totPresent = 0, totAbsent = 0, totLate = 0, totMin = 0;
    for (const a of rows) {
      const enr = state.enrollments.find((e) => e.id === a.enrollment_id);
      if (!enr) continue;
      sessionKeys.add(enr.class_id + "|" + a.session_date);
      if (a.status === "present" || a.status === "late") totPresent++;
      else if (a.status === "absent" || a.status === "excused") totAbsent++;
      if (a.late_pickup_minutes && a.late_pickup_minutes > 0) {
        totLate++;
        totMin += a.late_pickup_minutes;
      }
    }

    // Per-class stats
    const byClass = new Map(); // class_id -> {sessions:Set, present, absent, late, minutes}
    for (const a of rows) {
      const enr = state.enrollments.find((e) => e.id === a.enrollment_id);
      if (!enr) continue;
      let s2 = byClass.get(enr.class_id);
      if (!s2) { s2 = { sessions: new Set(), present: 0, absent: 0, late: 0, minutes: 0 }; byClass.set(enr.class_id, s2); }
      s2.sessions.add(a.session_date);
      if (a.status === "present" || a.status === "late") s2.present++;
      else if (a.status === "absent" || a.status === "excused") s2.absent++;
      if (a.late_pickup_minutes && a.late_pickup_minutes > 0) {
        s2.late++;
        s2.minutes += a.late_pickup_minutes;
      }
    }
    const classRows = [...byClass.entries()]
      .map(([cid, st]) => {
        const cls = state.classes.find((c) => c.id === cid);
        return {
          className: cls ? (cls.name || "—") : "(unknown class)",
          sessions: st.sessions.size,
          present: st.present,
          absent: st.absent,
          late: st.late,
          minutes: st.minutes,
        };
      })
      .sort((a, b) => a.className.localeCompare(b.className));

    // Late-pickup itemized list
    const latePickups = rows
      .filter((a) => a.late_pickup_minutes && a.late_pickup_minutes > 0)
      .map((a) => {
        const enr = state.enrollments.find((e) => e.id === a.enrollment_id);
        const stu = enr ? state.students.find((st) => st.id === enr.student_id) : null;
        const cls = enr ? state.classes.find((c) => c.id === enr.class_id) : null;
        return {
          date: a.session_date,
          student: stu ? `${stu.first_name || ""} ${stu.last_name || ""}`.trim() : "(unknown)",
          className: cls ? (cls.name || "—") : "(unknown)",
          minutes: a.late_pickup_minutes,
          notes: a.notes || "",
        };
      })
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const presetBtn = (label, days) =>
      `<button data-rpt-preset="${days}" class="btn small">${escapeHtml(label)}</button>`;

    host.innerHTML = `
      <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;padding:12px 0 16px;border-bottom:1px solid var(--border-subtle,#eee)">
        <div class="field" style="flex:0 0 160px">
          <label>From</label>
          <input type="date" id="rpt_start" value="${escapeHtml(s.start)}" />
        </div>
        <div class="field" style="flex:0 0 160px">
          <label>To</label>
          <input type="date" id="rpt_end" value="${escapeHtml(s.end)}" />
        </div>
        <div style="display:flex;gap:4px">
          ${presetBtn("Last 7d", 7)}
          ${presetBtn("Last 30d", 30)}
          ${presetBtn("Last 90d", 90)}
        </div>
        <div style="flex:1"></div>
        <button class="btn small" id="rpt_export_csv">Export CSV (late pickups)</button>
      </div>

      <div style="margin-top:16px">
        <div class="section-title">Summary</div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px;padding:12px 0">
          ${[
            ["Sessions", sessionKeys.size, ""],
            ["Present", totPresent, ""],
            ["Absent", totAbsent, ""],
            ["Late pickups", totLate, totLate > 0 ? "#a36a00" : ""],
            ["Late minutes", totMin, totMin > 0 ? "#a36a00" : ""],
          ].map(([k, v, col]) => `
            <div style="padding:10px 12px;background:var(--surface-alt,#f5f4ef);border-radius:8px">
              <div style="font-size:11px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.5px">${escapeHtml(k)}</div>
              <div style="font-size:22px;font-weight:600;margin-top:2px;${col ? `color:${col}` : ""}">${v}</div>
            </div>
          `).join("")}
        </div>
      </div>

      <div style="margin-top:16px">
        <div class="section-title">By class</div>
        ${classRows.length === 0 ? '<div style="padding:12px 0;color:var(--ink-dim);font-size:12.5px">No attendance recorded in this range.</div>' : `
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="text-align:left;color:var(--ink-dim);border-bottom:1px solid var(--border)">
                <th style="padding:6px 8px;font-weight:600">Class</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Sessions</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Present</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Absent</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Late pickups</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Late min</th>
              </tr>
            </thead>
            <tbody>
              ${classRows.map((r) => `
                <tr style="border-bottom:1px solid var(--border-subtle,#eee)">
                  <td style="padding:6px 8px">${escapeHtml(r.className)}</td>
                  <td style="padding:6px 8px;text-align:right">${r.sessions}</td>
                  <td style="padding:6px 8px;text-align:right">${r.present}</td>
                  <td style="padding:6px 8px;text-align:right">${r.absent}</td>
                  <td style="padding:6px 8px;text-align:right${r.late > 0 ? ';color:#a36a00;font-weight:600' : ''}">${r.late}</td>
                  <td style="padding:6px 8px;text-align:right${r.minutes > 0 ? ';color:#a36a00;font-weight:600' : ''}">${r.minutes}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>

      <div style="margin-top:16px">
        <div class="section-title">Late pickups <span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">(billing candidates)</span></div>
        ${latePickups.length === 0 ? '<div style="padding:12px 0;color:var(--ink-dim);font-size:12.5px">No late pickups in this range.</div>' : `
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="text-align:left;color:var(--ink-dim);border-bottom:1px solid var(--border)">
                <th style="padding:6px 8px;font-weight:600">Date</th>
                <th style="padding:6px 8px;font-weight:600">Student</th>
                <th style="padding:6px 8px;font-weight:600">Class</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Minutes</th>
                <th style="padding:6px 8px;font-weight:600">Notes</th>
              </tr>
            </thead>
            <tbody>
              ${latePickups.map((r) => `
                <tr style="border-bottom:1px solid var(--border-subtle,#eee)">
                  <td style="padding:6px 8px;white-space:nowrap">${escapeHtml(new Date(r.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))}</td>
                  <td style="padding:6px 8px">${escapeHtml(r.student)}</td>
                  <td style="padding:6px 8px">${escapeHtml(r.className)}</td>
                  <td style="padding:6px 8px;text-align:right;color:#a36a00;font-weight:600">${r.minutes}</td>
                  <td style="padding:6px 8px;color:var(--ink-dim)">${escapeHtml(r.notes)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>
    `;

    // Wire controls
    $("#rpt_start").onchange = (e) => { state.rptState.start = e.target.value; renderReportsTab(); };
    $("#rpt_end").onchange   = (e) => { state.rptState.end   = e.target.value; renderReportsTab(); };
    host.querySelectorAll("[data-rpt-preset]").forEach((b) => {
      b.onclick = () => {
        const days = parseInt(b.dataset.rptPreset, 10);
        const today = new Date();
        const start = new Date(today); start.setDate(start.getDate() - (days - 1));
        state.rptState.start = isoDate(start);
        state.rptState.end   = isoDate(today);
        renderReportsTab();
      };
    });
    $("#rpt_export_csv").onclick = () => downloadLatePickupCsv(latePickups, s.start, s.end);
  }

  // T3d: Teacher hours report — per-teacher payroll roll-up + itemized log.
  // Aggregates state.clockIns in [start, end]. Shifts without clocked_out_at
  // are shown but excluded from totals (open shifts — not yet billable).
  function renderTeacherHoursReport(host) {
    const s = state.rptState;
    const rows = state.clockIns.filter((c) => c.session_date >= s.start && c.session_date <= s.end);

    const byTeacher = new Map(); // teacher_id -> { shifts, minutes, openShifts }
    const byClass = new Map();
    let totalShifts = 0, totalMinutes = 0, openShifts = 0;

    for (const c of rows) {
      totalShifts++;
      if (!c.clocked_out_at) { openShifts++; continue; }
      const mins = Math.max(0, Math.round((new Date(c.clocked_out_at) - new Date(c.clocked_in_at)) / 60000));
      totalMinutes += mins;
      let t = byTeacher.get(c.teacher_id);
      if (!t) { t = { shifts: 0, minutes: 0 }; byTeacher.set(c.teacher_id, t); }
      t.shifts++; t.minutes += mins;
      if (c.class_id) {
        let k = byClass.get(c.class_id);
        if (!k) { k = { shifts: 0, minutes: 0 }; byClass.set(c.class_id, k); }
        k.shifts++; k.minutes += mins;
      }
    }

    const fmtHours = (mins) => {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    };

    const teacherRows = [...byTeacher.entries()]
      .map(([tid, st]) => {
        const t = state.teachers.find((x) => x.id === tid);
        return { name: t ? t.full_name : "(unknown)", shifts: st.shifts, minutes: st.minutes };
      })
      .sort((a, b) => b.minutes - a.minutes);

    const classRows = [...byClass.entries()]
      .map(([cid, st]) => {
        const c = state.classes.find((x) => x.id === cid);
        return { name: c ? c.name : "(unknown class)", shifts: st.shifts, minutes: st.minutes };
      })
      .sort((a, b) => b.minutes - a.minutes);

    // Itemized log (desc by date, then teacher)
    const log = rows.map((c) => {
      const t = state.teachers.find((x) => x.id === c.teacher_id);
      const cls = c.class_id ? state.classes.find((x) => x.id === c.class_id) : null;
      const dur = c.clocked_out_at
        ? Math.max(0, Math.round((new Date(c.clocked_out_at) - new Date(c.clocked_in_at)) / 60000))
        : null;
      return {
        date: c.session_date,
        teacher: t ? t.full_name : "(unknown)",
        className: cls ? cls.name : "(no class)",
        clockedInAt: c.clocked_in_at,
        clockedOutAt: c.clocked_out_at,
        minutes: dur,
      };
    }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.teacher.localeCompare(b.teacher)));

    const presetBtn = (label, days) =>
      `<button data-rpt-preset="${days}" class="btn small">${escapeHtml(label)}</button>`;

    host.innerHTML = `
      <div style="display:flex;gap:8px;align-items:end;flex-wrap:wrap;padding:12px 0 16px;border-bottom:1px solid var(--border-subtle,#eee)">
        <div class="field" style="flex:0 0 160px">
          <label>From</label>
          <input type="date" id="rpt_start" value="${escapeHtml(s.start)}" />
        </div>
        <div class="field" style="flex:0 0 160px">
          <label>To</label>
          <input type="date" id="rpt_end" value="${escapeHtml(s.end)}" />
        </div>
        <div style="display:flex;gap:4px">
          ${presetBtn("Last 7d", 7)}
          ${presetBtn("Last 30d", 30)}
          ${presetBtn("Last 90d", 90)}
        </div>
        <div style="flex:1"></div>
        <button class="btn small" id="rpt_export_hours_csv">Export CSV (itemized)</button>
      </div>

      <div style="margin-top:16px">
        <div class="section-title">Summary</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:12px 0">
          ${[
            ["Shifts", totalShifts, ""],
            ["Total hours", fmtHours(totalMinutes), ""],
            ["Teachers", teacherRows.length, ""],
            ["Open shifts", openShifts, openShifts > 0 ? "#a36a00" : ""],
          ].map(([k, v, col]) => `
            <div style="padding:10px 12px;background:var(--surface-alt,#f5f4ef);border-radius:8px">
              <div style="font-size:11px;color:var(--ink-dim);text-transform:uppercase;letter-spacing:.5px">${escapeHtml(k)}</div>
              <div style="font-size:22px;font-weight:600;margin-top:2px;${col ? `color:${col}` : ""}">${v}</div>
            </div>
          `).join("")}
        </div>
      </div>

      <div style="margin-top:16px">
        <div class="section-title">By teacher <span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">(payroll roll-up)</span></div>
        ${teacherRows.length === 0 ? '<div style="padding:12px 0;color:var(--ink-dim);font-size:12.5px">No completed shifts in this range.</div>' : `
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="text-align:left;color:var(--ink-dim);border-bottom:1px solid var(--border)">
                <th style="padding:6px 8px;font-weight:600">Teacher</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Shifts</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Hours</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Minutes</th>
              </tr>
            </thead>
            <tbody>
              ${teacherRows.map((r) => `
                <tr style="border-bottom:1px solid var(--border-subtle,#eee)">
                  <td style="padding:6px 8px">${escapeHtml(r.name)}</td>
                  <td style="padding:6px 8px;text-align:right">${r.shifts}</td>
                  <td style="padding:6px 8px;text-align:right">${escapeHtml(fmtHours(r.minutes))}</td>
                  <td style="padding:6px 8px;text-align:right">${r.minutes}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>

      <div style="margin-top:16px">
        <div class="section-title">By class</div>
        ${classRows.length === 0 ? '<div style="padding:12px 0;color:var(--ink-dim);font-size:12.5px">No completed shifts tied to a class.</div>' : `
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="text-align:left;color:var(--ink-dim);border-bottom:1px solid var(--border)">
                <th style="padding:6px 8px;font-weight:600">Class</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Shifts</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Hours</th>
              </tr>
            </thead>
            <tbody>
              ${classRows.map((r) => `
                <tr style="border-bottom:1px solid var(--border-subtle,#eee)">
                  <td style="padding:6px 8px">${escapeHtml(r.name)}</td>
                  <td style="padding:6px 8px;text-align:right">${r.shifts}</td>
                  <td style="padding:6px 8px;text-align:right">${escapeHtml(fmtHours(r.minutes))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>

      <div style="margin-top:16px">
        <div class="section-title">Shift log <span style="font-weight:400;color:var(--ink-dim);text-transform:none;letter-spacing:0">(${log.length} shifts)</span></div>
        ${log.length === 0 ? '<div style="padding:12px 0;color:var(--ink-dim);font-size:12.5px">No shifts in this range.</div>' : `
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="text-align:left;color:var(--ink-dim);border-bottom:1px solid var(--border)">
                <th style="padding:6px 8px;font-weight:600">Date</th>
                <th style="padding:6px 8px;font-weight:600">Teacher</th>
                <th style="padding:6px 8px;font-weight:600">Class</th>
                <th style="padding:6px 8px;font-weight:600">In</th>
                <th style="padding:6px 8px;font-weight:600">Out</th>
                <th style="padding:6px 8px;font-weight:600;text-align:right">Duration</th>
              </tr>
            </thead>
            <tbody>
              ${log.map((r) => `
                <tr style="border-bottom:1px solid var(--border-subtle,#eee)">
                  <td style="padding:6px 8px;white-space:nowrap">${escapeHtml(new Date(r.date + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))}</td>
                  <td style="padding:6px 8px">${escapeHtml(r.teacher)}</td>
                  <td style="padding:6px 8px">${escapeHtml(r.className)}</td>
                  <td style="padding:6px 8px;white-space:nowrap">${escapeHtml(new Date(r.clockedInAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</td>
                  <td style="padding:6px 8px;white-space:nowrap">${r.clockedOutAt ? escapeHtml(new Date(r.clockedOutAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })) : '<span style="color:#a36a00">open</span>'}</td>
                  <td style="padding:6px 8px;text-align:right;${r.minutes == null ? 'color:#a36a00' : ''}">${r.minutes == null ? "—" : escapeHtml(fmtHours(r.minutes))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `}
      </div>
    `;

    $("#rpt_start").onchange = (e) => { state.rptState.start = e.target.value; renderReportsTab(); };
    $("#rpt_end").onchange   = (e) => { state.rptState.end   = e.target.value; renderReportsTab(); };
    host.querySelectorAll("[data-rpt-preset]").forEach((b) => {
      b.onclick = () => {
        const days = parseInt(b.dataset.rptPreset, 10);
        const today = new Date();
        const start = new Date(today); start.setDate(start.getDate() - (days - 1));
        state.rptState.start = isoDate(start);
        state.rptState.end   = isoDate(today);
        renderReportsTab();
      };
    });
    $("#rpt_export_hours_csv").onclick = () => downloadTeacherHoursCsv(log, s.start, s.end);
  }

  function downloadTeacherHoursCsv(rows, start, end) {
    const esc = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Date","Teacher","Class","ClockedInAt","ClockedOutAt","Minutes"].join(",");
    const body = rows.map((r) => [
      r.date, r.teacher, r.className, r.clockedInAt, r.clockedOutAt || "", r.minutes == null ? "" : r.minutes
    ].map(esc).join(",")).join("\n");
    const csv = header + "\n" + body + "\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `teacher-hours-${start}-to-${end}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadLatePickupCsv(rows, start, end) {
    const esc = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["Date","Student","Class","Minutes","Notes"].join(",");
    const body = rows.map((r) => [r.date, r.student, r.className, r.minutes, r.notes].map(esc).join(",")).join("\n");
    const csv = header + "\n" + body + "\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `late-pickups-${start}-to-${end}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Permission helper: can THIS user take attendance for THIS class on this date?
  function canTakeAttendanceFor(cls, dateIso) {
    if (isAdminOrAbove()) return true;
    if (!hasPerm("take_own_attendance")) return false;
    // Teacher must be assigned to the class
    const myEmail = (state.session?.user?.email || "").toLowerCase();
    const me = state.teachers.find((t) => (t.email || "").toLowerCase() === myEmail);
    if (!me) return false;
    const assigned = state.classTeachers.some((ct) => ct.class_id === cls.id && ct.teacher_id === me.id);
    if (!assigned) return false;
    // Date must be in the 2-day grace window
    const today = isoDate(new Date());
    const d = new Date(dateIso + "T00:00:00");
    const t = new Date(today + "T00:00:00");
    const diffDays = Math.round((t - d) / (1000 * 60 * 60 * 24));
    return diffDays >= 0 && diffDays <= 2;
  }

  function renderSyncStatus() {
    const el = $("#syncStatus");
    const log = state.latestSyncLog;
    if (!log) {
      el.className = "sync-status";
      el.innerHTML = "";
      return;
    }
    const when = new Date(log.created_at);
    const statusClass = log.status === "ok" ? "ok" : (log.status === "partial" ? "partial" : log.status === "error" ? "error" : "");
    el.className = "sync-status visible " + statusClass;
    el.innerHTML = `
      <div><b>Last Jackrabbit sync:</b> ${escapeHtml(log.message || "")}</div>
      <div class="timestamp">${escapeHtml(when.toLocaleString())}</div>
    `;
  }

  async function syncJackrabbit() {
    showLoader(true);
    const t0 = Date.now();
    try {
      const { data, error } = await sb.functions.invoke("jackrabbit-sync", { body: {} });
      if (error) throw error;
      const ms = Date.now() - t0;
      if (data && data.status === "skipped") {
        showToast(`Sync skipped — ${data.reason || "not configured"}`, "error");
      } else if (data && data.status === "ok") {
        showToast(`Sync complete in ${ms}ms · pulled ${data.pulled} (+${data.inserted} new, ${data.updated} updated)`, "success");
      } else if (data && data.status === "partial") {
        showToast(`Sync partial — some errors. See sync log.`, "error");
      } else {
        showToast(`Sync returned: ${JSON.stringify(data).slice(0, 100)}`);
      }
    } catch (e) {
      showToast("Sync failed: " + e.message, "error");
    }
    await reloadAll();
    renderAll();
    showLoader(false);
  }

  function openClassEditor(id) {
    editingClassId = id || null;
    const c = id ? state.classes.find((x) => x.id === id) : null;
    $("#classModalTitle").textContent = c ? "Edit class" : "New class";
    $("#c_name").value              = c ? c.name : "";
    $("#c_day_time").value          = c ? (c.day_time || "") : "";
    $("#c_location").value          = c ? (c.location || "") : "";
    $("#c_registration_link").value = c ? (c.registration_link || "") : "";
    $("#c_age_range").value         = c ? (c.age_range || "") : "";
    $("#c_type").value              = c ? (c.type || "weekly") : "weekly";
    $("#c_active").value            = (c && c.active === false) ? "false" : "true";
    $("#c_notes").value             = c ? (c.notes || "") : "";
    $("#deleteClassBtn").style.display = c ? "" : "none";
    $("#classModalOverlay").classList.add("open");
    setTimeout(() => $("#c_name").focus(), 50);
  }
  function closeClassEditor() { $("#classModalOverlay").classList.remove("open"); editingClassId = null; }

  async function saveClass() {
    const name = $("#c_name").value.trim();
    if (!name) { showToast("Class name is required", "error"); return; }
    const payload = {
      name,
      day_time: $("#c_day_time").value.trim() || null,
      location: $("#c_location").value.trim() || null,
      registration_link: $("#c_registration_link").value.trim() || null,
      age_range: $("#c_age_range").value.trim() || null,
      type: $("#c_type").value,
      active: $("#c_active").value !== "false",
      notes: $("#c_notes").value || null
    };
    showLoader(true);
    let resp;
    if (editingClassId) {
      resp = await sb.from("classes").update(payload).eq("id", editingClassId).select().single();
    } else {
      const slugs = new Set(state.classes.map((c) => c.slug));
      payload.slug = uniqueSlug(slugify(name), slugs);
      resp = await sb.from("classes").insert(payload).select().single();
    }
    showLoader(false);
    if (resp.error) { showToast(resp.error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeClassEditor();
    showToast(editingClassId ? "Class updated" : "Class added", "success");
  }

  async function deleteClass() {
    if (!editingClassId) return;
    if (!confirm("Delete this class?")) return;
    showLoader(true);
    const { error } = await sb.from("classes").delete().eq("id", editingClassId);
    showLoader(false);
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeClassEditor();
    showToast("Class deleted", "success");
  }

  /* ═════════════ TEACHERS ═════════════ */

  let editingTeacherId = null;
  let inviteEditorTeacherId = null;

  function renderTeachersTab() {
    const el = $("#teacherTable");
    const active = state.teachers.filter((t) => t.status === 'active').length;
    const parLinked = state.teachers.filter((t) => t.par_person_id).length;
    const resolvable = state.teachers.filter((t) => t.email && !t.par_person_id).length;
    $("#teacherMeta").innerHTML = state.teachers.length + (state.teachers.length === 1 ? " teacher" : " teachers") +
      (state.teachers.length ? ` <span style="color:var(--ink-dim)">· ${active} active${parLinked ? ` · ${parLinked} PAR-linked` : ""}${resolvable ? ` · ${resolvable} pending PAR check` : ""}</span>` : "");

    const showPay    = hasPerm("view_pay_rates");
    const showEdit   = hasPerm("edit_teachers") && canMutate();
    const showInvite = canMutate();
    const colCount = 4 + (showPay ? 1 : 0) + (showEdit || showInvite ? 1 : 0);

    const rows = state.teachers.map((t) => {
      const classCount = state.classTeachers.filter((ct) => ct.teacher_id === t.id).length;
      const statusLabel = { active: "Active", on_leave: "On leave", inactive: "Inactive" };
      const parBadge = t.par_person_id
        ? ` <span class="par-linked-badge" title="Linked to PAR person ${escapeHtml(t.par_person_id)}">PAR \u2713</span>`
        : (t.email ? ` <span class="par-pending-badge" title="Email on file but not yet resolved against PAR">unresolved</span>` : "");

      // Most-recent invitation for this teacher's email (if any)
      const myEmail = (t.email || "").toLowerCase();
      const latestInvite = myEmail
        ? state.teacherInvitations.find((inv) => (inv.email || "").toLowerCase() === myEmail)
        : null;
      const inviteBadge = renderInviteBadge(latestInvite);

      // Action cell — Invite + Edit depending on state
      const actions = [];
      if (showInvite && t.email && !t.par_person_id) {
        const label = latestInvite && !latestInvite.accepted_at && isInviteExpired(latestInvite) ? "Re-invite"
                     : latestInvite && !latestInvite.accepted_at ? "Copy link"
                     : "Invite";
        actions.push(`<button class="btn small ${label === "Invite" || label === "Re-invite" ? "primary" : ""}" data-act="invite-teacher" data-id="${escapeHtml(t.id)}" data-email="${escapeHtml(t.email)}">${label}</button>`);
      }
      if (showEdit) {
        actions.push(`<button class="btn small ghost" data-act="edit-teacher" data-id="${escapeHtml(t.id)}">Edit</button>`);
      }
      const actionCell = (showEdit || showInvite) ? `<td class="row-actions" style="white-space:nowrap">${actions.join(" ")}</td>` : "";

      return `
        <tr>
          <td><b>${escapeHtml(t.full_name)}</b>${parBadge}${inviteBadge}${t.email ? `<div style="font-size:11.5px;color:var(--ink-dim)">${escapeHtml(t.email)}</div>` : `<div style="font-size:11.5px;color:var(--ink-mute);font-style:italic">no email \u2014 can't resolve PAR</div>`}</td>
          <td>${escapeHtml(t.phone || "")}</td>
          ${showPay  ? `<td>${escapeHtml(t.pay_rate || "")}</td>` : ""}
          <td><span class="type-badge status-badge-${escapeHtml(t.status)}">${statusLabel[t.status] || t.status}</span></td>
          <td style="font-size:12px">${classCount} class${classCount === 1 ? "" : "es"}</td>
          ${actionCell}
        </tr>
      `;
    }).join("");
    el.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Phone</th>${showPay ? "<th>Pay rate</th>" : ""}<th>Status</th><th>Assigned</th>${showEdit || showInvite ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${colCount}" style="text-align:center;color:var(--ink-dim);padding:24px">No teachers yet${showEdit ? " — click <b>＋ New teacher</b>." : "."}</td></tr>`}</tbody>
      </table>
    `;
    if (showEdit) {
      $$('[data-act="edit-teacher"]', el).forEach((btn) => btn.onclick = () => openTeacherEditor(btn.dataset.id));
    }
    if (showInvite) {
      $$('[data-act="invite-teacher"]', el).forEach((btn) => btn.onclick = () => onInviteTeacherClick(btn.dataset.id, btn.dataset.email));
    }
  }

  /* Invitation status badge + helpers */
  function isInviteExpired(inv) {
    return !!(inv && inv.expires_at && new Date(inv.expires_at) < new Date());
  }
  function renderInviteBadge(inv) {
    if (!inv) return "";
    if (inv.accepted_at) {
      return ` <span class="invite-badge accepted" title="Accepted ${new Date(inv.accepted_at).toLocaleDateString()}">accepted</span>`;
    }
    if (isInviteExpired(inv)) {
      return ` <span class="invite-badge expired" title="Expired on ${new Date(inv.expires_at).toLocaleDateString()} — re-send">expired</span>`;
    }
    const label = inv.email_status === "sent" ? "invited"
                 : inv.email_status === "failed" ? "link ready"
                 : inv.email_status === "skipped" ? "link ready"
                 : "invited";
    return ` <span class="invite-badge pending" title="Invitation sent ${new Date(inv.sent_at).toLocaleDateString()}${inv.expires_at ? " · expires " + new Date(inv.expires_at).toLocaleDateString() : ""}">${label}</span>`;
  }

  /* On-click handler for a per-row Invite button: either re-show an
   * existing pending invite's result modal, or open the editor pre-filled
   * with the teacher's email + role=teacher. */
  function onInviteTeacherClick(teacherId, email) {
    if (!email) { showToast("Teacher has no email to invite", "error"); return; }
    const existing = state.teacherInvitations.find(
      (inv) => (inv.email || "").toLowerCase() === email.toLowerCase()
               && !inv.accepted_at
               && !isInviteExpired(inv)
    );
    if (existing) {
      openInviteResultModal({
        accept_url: existing.par_accept_url,
        expires_at: existing.expires_at,
        email_sent: existing.email_status === "sent",
        email_error: existing.email_error,
        email,
        reused: true,
      });
      return;
    }
    openInviteEditor({ email, teacher_id: teacherId, dk_role: "teacher" });
  }

  /* Open the invite editor, optionally with prefilled fields. */
  function openInviteEditor(prefill) {
    const p = prefill || {};
    inviteEditorTeacherId = p.teacher_id || null;
    $("#invEmail").value = p.email || "";
    $("#invRole").value  = p.dk_role || "teacher";
    $("#invNotes").value = p.notes || "";
    $("#invEmailHint").textContent = p.teacher_id
      ? "Inviting this existing teacher — they'll be linked to their teacher row on acceptance."
      : "This email will be invited as a standalone DK user. If you also want them in the teachers list, add them first via + New teacher.";
    updateInviteRoleMapHint();
    $("#inviteEditorOverlay").classList.add("open");
    setTimeout(() => $("#invEmail").focus(), 40);
  }

  function closeInviteEditor() {
    $("#inviteEditorOverlay").classList.remove("open");
    inviteEditorTeacherId = null;
  }

  /* Updates the "PAR-side role" hint below the role select so it's clear
   * what happens in PAR when this invitation is created. */
  function updateInviteRoleMapHint() {
    const dkRole = $("#invRole").value;
    const parMap = {
      super_admin: "owner", admin: "admin", manager: "member",
      teacher: "member", viewer: "member"
    };
    const parRole = parMap[dkRole] || "member";
    $("#invRoleMapHint").innerHTML =
      `In PAR they'll be an <b>${escapeHtml(parRole)}</b> of the franchise org. ` +
      (dkRole === "super_admin"
        ? "Use this for the franchise owner."
        : dkRole === "admin"
          ? "Full console access; can invite teachers and managers but not other admins."
          : dkRole === "manager"
            ? "Can respond to leads and edit templates; read-only on structural data."
            : dkRole === "teacher"
              ? "Sees only their own schedule and home bento. Full teacher features land in Phase T3."
              : "Read-only across every tab.");
  }

  /* Send the invitation from the editor form. */
  async function submitInviteEditor() {
    const email = $("#invEmail").value.trim().toLowerCase();
    const dkRole = $("#invRole").value;
    const notes = $("#invNotes").value.trim() || null;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast("Enter a valid email address", "error"); return;
    }
    // Reuse existing pending invitation if one exists for this email
    const existing = state.teacherInvitations.find(
      (inv) => (inv.email || "").toLowerCase() === email
               && !inv.accepted_at
               && !isInviteExpired(inv)
    );
    if (existing) {
      closeInviteEditor();
      openInviteResultModal({
        accept_url: existing.par_accept_url,
        expires_at: existing.expires_at,
        email_sent: existing.email_status === "sent",
        email_error: existing.email_error,
        email,
        reused: true,
      });
      return;
    }
    const payload = {
      email,
      dk_role: dkRole,
      teacher_id: inviteEditorTeacherId || undefined,
      notes,
    };
    closeInviteEditor();
    await fireInvite(payload);
  }

  async function fireInvite(payload) {
    showLoader(true);
    try {
      const { data, error } = await sb.functions.invoke("dk-invite-teacher", { body: payload });
      if (error) {
        showToast(`Invite failed: ${error.message || String(error)}`, "error");
        return;
      }
      if (data?.error) {
        showToast(`Invite failed: ${data.error}`, "error");
        return;
      }
      await reloadAll();
      renderAll();
      openInviteResultModal({ ...data, email: payload.email, reused: false });
    } finally {
      showLoader(false);
    }
  }

  function openInviteResultModal(result) {
    const overlay = $("#inviteResultOverlay");
    if (!overlay) return;
    const { accept_url, expires_at, email_sent, email_error, email, reused } = result;
    $("#inviteResultSub").innerHTML = reused
      ? `Pending invitation for <b>${escapeHtml(email)}</b> — reusing the existing link.`
      : `Invitation created for <b>${escapeHtml(email)}</b>.`;
    $("#inviteResultEmailStatus").innerHTML = email_sent
      ? `<span class="invite-badge accepted">Email sent via Resend</span>`
      : `<span class="invite-badge pending">Email not sent (${escapeHtml(email_error || "—")})</span> &middot; copy the link below and send it manually.`;
    $("#inviteResultUrl").value = accept_url || "";
    $("#inviteResultExpires").textContent = expires_at
      ? `Expires ${new Date(expires_at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`
      : "";
    overlay.classList.add("open");
  }
  function closeInviteResultModal() {
    $("#inviteResultOverlay").classList.remove("open");
  }

  function openTeacherEditor(id) {
    editingTeacherId = id || null;
    const t = id ? state.teachers.find((x) => x.id === id) : null;
    $("#teacherModalTitle").textContent = t ? "Edit teacher" : "New teacher";
    $("#t_name").value      = t ? t.full_name : "";
    $("#t_email").value     = t ? (t.email || "") : "";
    $("#t_phone").value     = t ? (t.phone || "") : "";
    $("#t_pay_rate").value  = t ? (t.pay_rate || "") : "";
    $("#t_status").value    = t ? (t.status || "active") : "active";
    $("#t_hire_date").value = t ? (t.hire_date || "") : "";
    $("#t_notes").value     = t ? (t.notes || "") : "";
    $("#deleteTeacherBtn").style.display = t ? "" : "none";
    $("#teacherModalOverlay").classList.add("open");
    setTimeout(() => $("#t_name").focus(), 50);
  }
  function closeTeacherEditor() { $("#teacherModalOverlay").classList.remove("open"); editingTeacherId = null; }

  async function saveTeacher() {
    const name = $("#t_name").value.trim();
    if (!name) { showToast("Name is required", "error"); return; }
    const payload = {
      full_name: name,
      email: $("#t_email").value.trim() || null,
      phone: $("#t_phone").value.trim() || null,
      pay_rate: $("#t_pay_rate").value.trim() || null,
      status: $("#t_status").value,
      hire_date: $("#t_hire_date").value || null,
      notes: $("#t_notes").value || null,
    };
    showLoader(true);
    let resp;
    if (editingTeacherId) {
      resp = await sb.from("teachers").update(payload).eq("id", editingTeacherId).select().single();
    } else {
      const slugs = new Set(state.teachers.map((t) => t.slug));
      payload.slug = uniqueSlug(slugify(name), slugs);
      resp = await sb.from("teachers").insert(payload).select().single();
    }
    showLoader(false);
    if (resp.error) { showToast(resp.error.message, "error"); return; }
    const savedTeacher = resp.data;

    // Phase 3 — try to resolve this teacher's PAR identity if they have an email
    if (savedTeacher?.email) {
      resolveTeacherParIdentity(savedTeacher).catch((e) => console.warn("PAR teacher resolve:", e));
    }

    await reloadAll();
    renderAll();
    closeTeacherEditor();
    showToast(editingTeacherId ? "Teacher updated" : "Teacher added", "success");
  }

  /* Resolve a single teacher's PAR identity via par-identity-proxy; cache on the teacher row. */
  async function resolveTeacherParIdentity(teacher) {
    if (!teacher?.email) return { resolved: false, reason: "no_email" };
    try {
      const { data, error } = await sb.functions.invoke("par-identity-proxy", {
        body: { email: teacher.email },
      });
      if (error) return { resolved: false, reason: error.message };
      if (!data || data.found !== true) return { resolved: false, reason: "not_found" };

      const patch = {
        par_person_id: data.person_id ?? null,
      };
      // Only update if it changed
      if (patch.par_person_id && patch.par_person_id !== teacher.par_person_id) {
        const { error: upErr } = await sb.from("teachers").update(patch).eq("id", teacher.id);
        if (upErr) return { resolved: false, reason: upErr.message };
        // Silently refresh state so the badge appears
        await reloadAll();
        renderAll();
      }
      return { resolved: true, person_id: data.person_id, display_name: data.display_name };
    } catch (e) {
      return { resolved: false, reason: (e instanceof Error ? e.message : String(e)) };
    }
  }

  /* Bulk resolver — walks all teachers with an email and no par_person_id yet. */
  async function refreshAllTeacherParLinks() {
    const candidates = state.teachers.filter((t) => t.email && !t.par_person_id);
    if (candidates.length === 0) {
      showToast("All teachers with emails are already PAR-linked", "success");
      return;
    }
    showLoader(true);
    let linked = 0, not_found = 0, errors = 0;
    for (const t of candidates) {
      const r = await resolveTeacherParIdentity(t);
      if (r.resolved) linked++;
      else if (r.reason === "not_found") not_found++;
      else errors++;
    }
    showLoader(false);
    await reloadAll();
    renderAll();
    showToast(`PAR links: ${linked} linked · ${not_found} not on PAR${errors ? ` · ${errors} errors` : ""}`, linked > 0 ? "success" : "");
  }

  async function deleteTeacher() {
    if (!editingTeacherId) return;
    const t = state.teachers.find((x) => x.id === editingTeacherId);
    const assignments = state.classTeachers.filter((ct) => ct.teacher_id === editingTeacherId).length;
    const confirmMsg = assignments > 0
      ? `${t?.full_name || "This teacher"} is assigned to ${assignments} class${assignments === 1 ? "" : "es"}. Deleting will remove those assignments. Continue?`
      : "Delete this teacher?";
    if (!confirm(confirmMsg)) return;
    showLoader(true);
    const { error } = await sb.from("teachers").delete().eq("id", editingTeacherId);
    showLoader(false);
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeTeacherEditor();
    showToast("Teacher deleted", "success");
  }

  /* ═════════════ CATEGORIES ═════════════ */

  function renderCategoriesTab() {
    const wrap = $("#categoryList");
    wrap.innerHTML = "";
    const showEdit = hasPerm("edit_categories") && canMutate();
    state.categories.forEach((cat) => {
      const used = state.templates.filter((t) => t.category_id === cat.id).length;
      const row = document.createElement("div");
      row.className = "category-item";
      row.innerHTML = `
        <input class="label-input" type="text" value="${escapeHtml(cat.label)}" ${showEdit ? "" : "readonly"} />
        <span class="cat-id">${escapeHtml(cat.slug)}</span>
        <span class="use-count">${used} used</span>
        ${showEdit ? `<button class="btn small danger" ${used > 0 ? "disabled title=\"In use — reassign templates first\"" : ""}>Delete</button>` : ""}
      `;
      const input = row.querySelector(".label-input");
      const del   = row.querySelector("button");
      if (showEdit) {
        input.onchange = async () => {
          const newLabel = input.value.trim();
          if (!newLabel || newLabel === cat.label) return;
          const { error } = await sb.from("categories").update({ label: newLabel }).eq("id", cat.id);
          if (error) { showToast(error.message, "error"); return; }
          await reloadAll(); renderAll();
          showToast("Category renamed", "success");
        };
        if (del) del.onclick = async () => {
          if (used > 0) return;
          if (!confirm("Delete this category?")) return;
          const { error } = await sb.from("categories").delete().eq("id", cat.id);
          if (error) { showToast(error.message, "error"); return; }
          await reloadAll(); renderAll();
          showToast("Category deleted", "success");
        };
      }
      wrap.appendChild(row);
    });
  }

  async function newCategory() {
    const label = prompt("New category label:");
    if (!label) return;
    const slugs = new Set(state.categories.map((c) => c.slug));
    const slug = uniqueSlug(slugify(label), slugs);
    const maxSort = state.categories.reduce((m, c) => Math.max(m, c.sort_order || 0), 0);
    const { error } = await sb.from("categories").insert({ slug, label: label.trim(), sort_order: maxSort + 1 });
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll(); renderAll();
    showToast("Category added", "success");
  }

  /* ═════════════ INFOGRAPHICS sidebar ═════════════ */

  function renderInfographicsSidebar() {
    $("#igCount").textContent = state.infographics.length;

    const allTags = new Set();
    state.infographics.forEach((i) => (i.tags || []).forEach((t) => allTags.add(t)));
    const tagRow = $("#igTagRow");
    tagRow.innerHTML = "";
    [{ k: "all", label: "All" }].concat([...allTags].sort().map((t) => ({ k: t, label: "#" + t }))).forEach((t) => {
      const chip = document.createElement("button");
      chip.className = "chip" + (state.igState.tag === t.k ? " active" : "");
      chip.textContent = t.label;
      chip.onclick = () => { state.igState.tag = t.k; renderInfographicsSidebar(); };
      tagRow.appendChild(chip);
    });

    const q = state.igState.query.toLowerCase();
    const filtered = state.infographics.filter((i) => {
      if (state.igState.tag !== "all" && !(i.tags || []).includes(state.igState.tag)) return false;
      if (!q) return true;
      return (i.name || "").toLowerCase().includes(q) || (i.tags || []).some((t) => t.toLowerCase().includes(q));
    });

    const grid = $("#igGrid");
    grid.innerHTML = "";
    if (filtered.length === 0) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1;padding:20px 8px">No images. Go to the <b>Infographics</b> tab and click <b>＋ Upload / add image</b>.</div>';
      return;
    }
    filtered.forEach((i) => grid.appendChild(renderInfographicCard(i)));
  }

  function renderInfographicCard(ig) {
    const el = document.createElement("div");
    el.className = "infographic";
    const isExternal = !ig.storage_path && !!ig.external_url;
    const src = ig.storage_path ? publicUrlFor(ig.storage_path) : ig.external_url;
    el.title = isExternal
      ? "Click to copy URL and open image"
      : (ig.storage_path ? "Click to copy image to clipboard" : "No image set");
    el.innerHTML = `
      <div class="thumb ${isExternal ? "external" : ""}">
        ${src ? `<img src="${escapeHtml(src)}" onerror="this.remove()" alt="" />` : "🖼"}
      </div>
      <div class="meta">
        <div class="name">${escapeHtml(ig.name)}</div>
        <div class="tag-list">${(ig.tags || []).map((t) => "#" + t).join(" ")}</div>
      </div>
    `;
    el.onclick = () => handleInfographicClick(ig, el);
    return el;
  }

  async function handleInfographicClick(ig, el) {
    if (ig.storage_path) {
      const url = publicUrlFor(ig.storage_path);
      const r = await copyImageBytes(url);
      if (r.ok) {
        el.classList.add("copied");
        setTimeout(() => el.classList.remove("copied"), 1500);
        showToast("Image copied — paste into your message", "success");
      } else {
        showToast("Couldn't copy image bytes — opening in new tab instead.", "error");
        window.open(url, "_blank", "noopener");
      }
    } else if (ig.external_url) {
      await copyText(ig.external_url);
      window.open(ig.external_url, "_blank", "noopener");
      el.classList.add("copied");
      setTimeout(() => el.classList.remove("copied"), 1500);
      showToast("URL copied · image opened in new tab", "success");
    } else {
      showToast("No image source set. Edit it in the Infographics tab.", "error");
    }
  }

  /* ═════════════ INFOGRAPHICS tab (admin) ═════════════ */

  let editingIgId = null;
  let igSourceMode = "upload"; // or "external"
  let pendingUploadFile = null;

  function renderInfographicsTab() {
    const el = $("#infographicsTable");
    $("#igManageMeta").textContent = state.infographics.length + " image" + (state.infographics.length === 1 ? "" : "s");
    const showEdit = hasPerm("edit_infographics") && canMutate();
    const colCount = 4 + (showEdit ? 1 : 0);
    const rows = state.infographics.map((i) => {
      const src = i.storage_path ? publicUrlFor(i.storage_path) : i.external_url;
      const srcType = i.storage_path ? "Uploaded" : (i.external_url ? "External" : "—");
      return `
        <tr>
          <td class="thumb-cell">${src ? `<img src="${escapeHtml(src)}" alt="" />` : '<div class="no-thumb">🖼</div>'}</td>
          <td><b>${escapeHtml(i.name)}</b>${i.notes ? `<div style="font-size:11.5px;color:var(--ink-dim)">${escapeHtml(i.notes)}</div>` : ""}</td>
          <td>${(i.tags || []).map((t) => `<span class="type-badge type-workshop">#${escapeHtml(t)}</span>`).join(" ")}</td>
          <td>${srcType}</td>
          ${showEdit ? `<td class="row-actions"><button class="btn small ghost" data-act="edit-ig" data-id="${escapeHtml(i.id)}">Edit</button></td>` : ""}
        </tr>
      `;
    }).join("");
    el.innerHTML = `
      <table>
        <thead><tr><th>Preview</th><th>Name</th><th>Tags</th><th>Source</th>${showEdit ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${colCount}" style="text-align:center;color:var(--ink-dim);padding:24px">No images yet${showEdit ? " — click <b>＋ Upload / add image</b>." : "."}</td></tr>`}</tbody>
      </table>
    `;
    if (showEdit) {
      $$('[data-act="edit-ig"]', el).forEach((btn) => btn.onclick = () => openIgEditor(btn.dataset.id));
    }
  }

  function openIgEditor(id) {
    editingIgId = id || null;
    const ig = id ? state.infographics.find((x) => x.id === id) : null;
    $("#igModalTitle").textContent = ig ? "Edit image" : "Upload / add image";
    $("#i_name").value  = ig ? ig.name : "";
    $("#i_tags").value  = ig ? (ig.tags || []).join(", ") : "";
    $("#i_url").value   = ig ? (ig.external_url || "") : "";
    $("#i_notes").value = ig ? (ig.notes || "") : "";
    $("#i_file").value  = "";
    pendingUploadFile = null;
    $("#currentFileLabel").textContent = ig && ig.storage_path ? "Current uploaded file: " + ig.storage_path : "";
    $("#imagePreview").style.display = "none";
    $("#deleteIgBtn").style.display = ig ? "" : "none";
    // Choose initial source mode
    igSourceMode = (ig && ig.external_url && !ig.storage_path) ? "external" : "upload";
    updateIgSourceToggle();
    $("#igModalOverlay").classList.add("open");
    setTimeout(() => $("#i_name").focus(), 50);
  }
  function closeIgEditor() { $("#igModalOverlay").classList.remove("open"); editingIgId = null; }

  function updateIgSourceToggle() {
    $$(".toggle-btn").forEach((b) => b.classList.toggle("active", b.dataset.src === igSourceMode));
    $("#uploadField").style.display   = igSourceMode === "upload" ? "" : "none";
    $("#externalField").style.display = igSourceMode === "external" ? "" : "none";
  }

  async function saveInfographic() {
    const name = $("#i_name").value.trim();
    if (!name) { showToast("Name is required", "error"); return; }
    const tags = $("#i_tags").value.split(",").map((s) => s.trim()).filter(Boolean);
    const notes = $("#i_notes").value || null;

    let payload = { name, tags, notes };

    if (igSourceMode === "upload") {
      if (pendingUploadFile) {
        // Upload file
        const ext = pendingUploadFile.name.split(".").pop();
        const slugBase = slugify(name);
        const existingSlugs = new Set(state.infographics.map((i) => i.slug));
        const slug = editingIgId
          ? (state.infographics.find((i) => i.id === editingIgId)?.slug || uniqueSlug(slugBase, existingSlugs))
          : uniqueSlug(slugBase, existingSlugs);
        const path = slug + "-" + Date.now() + "." + ext;
        showLoader(true);
        const { error: upErr } = await sb.storage.from("infographics").upload(path, pendingUploadFile, {
          contentType: pendingUploadFile.type,
          upsert: false
        });
        showLoader(false);
        if (upErr) { showToast("Upload failed: " + upErr.message, "error"); return; }
        payload.storage_path = path;
        payload.external_url = null;
        if (!editingIgId) payload.slug = slug;
      } else if (!editingIgId) {
        showToast("Pick a file to upload", "error"); return;
      }
      // If editing and no new file chosen, leave storage_path as-is (don't touch it)
    } else {
      // external URL mode
      const url = $("#i_url").value.trim();
      if (!url) { showToast("URL is required for external images", "error"); return; }
      payload.external_url = url;
      payload.storage_path = null;
      if (!editingIgId) {
        const existingSlugs = new Set(state.infographics.map((i) => i.slug));
        payload.slug = uniqueSlug(slugify(name), existingSlugs);
      }
    }

    showLoader(true);
    let resp;
    if (editingIgId) {
      resp = await sb.from("infographics").update(payload).eq("id", editingIgId).select().single();
    } else {
      resp = await sb.from("infographics").insert(payload).select().single();
    }
    showLoader(false);
    if (resp.error) { showToast(resp.error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeIgEditor();
    showToast(editingIgId ? "Image updated" : "Image added", "success");
  }

  async function deleteInfographic() {
    if (!editingIgId) return;
    if (!confirm("Delete this image? (The uploaded file will also be removed from storage.)")) return;
    const ig = state.infographics.find((i) => i.id === editingIgId);
    showLoader(true);
    if (ig && ig.storage_path) {
      await sb.storage.from("infographics").remove([ig.storage_path]);
    }
    const { error } = await sb.from("infographics").delete().eq("id", editingIgId);
    showLoader(false);
    if (error) { showToast(error.message, "error"); return; }
    await reloadAll();
    renderAll();
    closeIgEditor();
    showToast("Image deleted", "success");
  }

  /* ═════════════ Event wiring ═════════════ */

  function wireEvents() {
    // Tabs
    $$(".tab").forEach((t) => t.onclick = () => go(t.dataset.tab));

    // Search
    $("#search").addEventListener("input", (e) => { state.tState.query = e.target.value.trim(); renderTemplates(); });
    $("#igSearch").addEventListener("input", (e) => { state.igState.query = e.target.value.trim(); renderInfographicsSidebar(); });

    // Sign out
    $("#signOutBtn").onclick = async () => {
      if (realtimeChannel) {
        try { await sb.removeChannel(realtimeChannel); } catch (_) { /* ignore */ }
        realtimeChannel = null;
      }
      await sb.auth.signOut();
      state.session = null; state.profile = null;
      showLogin();
    };

    // New buttons
    $("#newTemplateBtn").onclick   = () => openTemplateEditor(null);
    $("#newClassBtn").onclick      = () => openClassEditor(null);
    $("#newCategoryBtn").onclick   = newCategory;
    $("#newInfographicBtn").onclick = () => openIgEditor(null);
    $("#newTeacherBtn").onclick    = () => openTeacherEditor(null);
    const refreshParBtn = $("#refreshParLinksBtn");
    if (refreshParBtn) refreshParBtn.onclick = refreshAllTeacherParLinks;

    // Teacher modal
    $("#teacherCancel").onclick    = closeTeacherEditor;
    $("#teacherModalClose").onclick = closeTeacherEditor;
    $("#teacherModalOverlay").onclick = (e) => { if (e.target.id === "teacherModalOverlay") closeTeacherEditor(); };
    $("#teacherSave").onclick      = saveTeacher;
    $("#deleteTeacherBtn").onclick = deleteTeacher;

    // Jackrabbit sync + test toggle
    const syncBtn = $("#syncJackrabbitBtn");
    if (syncBtn) syncBtn.onclick = syncJackrabbit;
    const testToggle = $("#showTestClasses");
    if (testToggle) testToggle.onchange = (e) => { state.cState.showTest = e.target.checked; renderAll(); };

    // Template modal
    $("#addImageRow").onclick      = () => addImageRow("", "");
    $("#f_body").addEventListener("input", updateDetectedVars);
    $("#templateCancel").onclick   = closeTemplateEditor;
    $("#templateModalClose").onclick = closeTemplateEditor;
    $("#templateModalOverlay").onclick = (e) => { if (e.target.id === "templateModalOverlay") closeTemplateEditor(); };
    $("#templateSave").onclick     = saveTemplate;
    $("#deleteTemplateBtn").onclick = deleteTemplate;

    // Class modal
    $("#classCancel").onclick      = closeClassEditor;
    $("#classModalClose").onclick  = closeClassEditor;
    $("#classModalOverlay").onclick = (e) => { if (e.target.id === "classModalOverlay") closeClassEditor(); };
    $("#classSave").onclick        = saveClass;
    $("#deleteClassBtn").onclick   = deleteClass;

    // Schedule toolbar
    $$(".sched-mode").forEach((b) => {
      b.onclick = () => {
        state.sState.mode = b.dataset.schedMode;
        renderScheduleTab();
      };
    });
    const schedPrev = $("#schedPrev");
    const schedNext = $("#schedNext");
    const schedToday = $("#schedToday");
    const schedOnlyMine = $("#schedOnlyMine");
    const schedManageClosures = $("#schedManageClosures");
    if (schedPrev)  schedPrev.onclick  = () => schedNav(-1);
    if (schedNext)  schedNext.onclick  = () => schedNav(+1);
    if (schedToday) schedToday.onclick = () => { state.sState.anchor = isoDate(new Date()); renderScheduleTab(); };
    if (schedOnlyMine) schedOnlyMine.onchange = (e) => { state.sState.onlyMine = !!e.target.checked; renderScheduleTab(); };
    if (schedManageClosures) schedManageClosures.onclick = openClosuresModal;

    // Closures modal
    const cloClose = $("#closuresClose");
    const cloAdd   = $("#closureAdd");
    const cloOverlay = $("#closuresOverlay");
    if (cloClose) cloClose.onclick = closeClosuresModal;
    if (cloAdd)   cloAdd.onclick   = addClosure;
    if (cloOverlay) cloOverlay.onclick = (e) => { if (e.target.id === "closuresOverlay") closeClosuresModal(); };

    // Invitation editor modal
    const inviteUserBtn = $("#inviteUserBtn");
    if (inviteUserBtn) inviteUserBtn.onclick = () => openInviteEditor({});
    $("#invCancel").onclick         = closeInviteEditor;
    $("#inviteEditorClose").onclick = closeInviteEditor;
    $("#inviteEditorOverlay").onclick = (e) => { if (e.target.id === "inviteEditorOverlay") closeInviteEditor(); };
    $("#invRole").addEventListener("change", updateInviteRoleMapHint);
    $("#invSend").onclick           = submitInviteEditor;

    // Add-student modal (teacher/admin adds a DK-local student to a class)
    $("#addStudentCancel").onclick     = closeAddStudentModal;
    $("#addStudentModalClose").onclick = closeAddStudentModal;
    $("#addStudentModalOverlay").onclick = (e) => { if (e.target.id === "addStudentModalOverlay") closeAddStudentModal(); };
    $("#addStudentSave").onclick       = saveAddStudent;

    // Attendance modal (T3b: take or edit a session's attendance)
    $("#attendanceCancel").onclick       = closeAttendanceModal;
    $("#attendanceModalClose").onclick   = closeAttendanceModal;
    $("#attendanceModalOverlay").onclick = (e) => { if (e.target.id === "attendanceModalOverlay") closeAttendanceModal(); };
    $("#attendanceSave").onclick         = saveAttendance;
    $("#att_mark_all_present").onclick   = markAllPresent;

    // Reconcile modal (admin resolves a student_match_candidate)
    $("#reconcileModalClose").onclick = closeReconcileModal;
    $("#reconcileModalOverlay").onclick = (e) => { if (e.target.id === "reconcileModalOverlay") closeReconcileModal(); };
    $("#reconcileLink").onclick       = () => resolveReconcile("link");
    $("#reconcileKeep").onclick       = () => resolveReconcile("keep");
    $("#reconcileDelete").onclick     = () => resolveReconcile("delete");

    // Invitation result modal
    $("#inviteResultClose").onclick = closeInviteResultModal;
    $("#inviteResultDone").onclick  = closeInviteResultModal;
    $("#inviteResultOverlay").onclick = (e) => { if (e.target.id === "inviteResultOverlay") closeInviteResultModal(); };
    $("#inviteResultCopy").onclick  = async () => {
      const url = $("#inviteResultUrl").value;
      if (!url) return;
      const ok = await copyText(url);
      if (ok) flashCopied($("#inviteResultCopy"));
    };

    // Infographic modal
    $("#igCancel").onclick         = closeIgEditor;
    $("#igModalClose").onclick     = closeIgEditor;
    $("#igModalOverlay").onclick   = (e) => { if (e.target.id === "igModalOverlay") closeIgEditor(); };
    $("#igSave").onclick           = saveInfographic;
    $("#deleteIgBtn").onclick      = deleteInfographic;
    $$(".toggle-btn").forEach((b) => b.onclick = () => { igSourceMode = b.dataset.src; updateIgSourceToggle(); });
    $("#i_file").addEventListener("change", (e) => {
      const f = e.target.files[0];
      pendingUploadFile = f || null;
      const preview = $("#imagePreview");
      if (f) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          preview.innerHTML = `<img src="${ev.target.result}" alt="" />`;
          preview.style.display = "";
        };
        reader.readAsDataURL(f);
      } else {
        preview.style.display = "none";
        preview.innerHTML = "";
      }
    });
  }

  /* ═════════════ Boot ═════════════ */
  initAuth();
})();
