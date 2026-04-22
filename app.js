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
    latestSyncLog: null,
    tState: { query: "", category: "all", filled: {} },
    igState: { query: "", tag: "all" },
    cState: { showTest: false, openClassId: null },
    router: "templates"
  };

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
    sb.auth.onAuthStateChange((event, session) => {
      state.session = session || null;
      if (!session) {
        // Signed out
        showLogin();
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
    renderUserChip();
    await reloadAll();
    wireEvents();
    renderAll();
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
    if (parLinked) {
      const badge = document.createElement("span");
      badge.className = "par-linked-badge";
      badge.title = "Linked to PAR identity: " + (state.profile.par_primary_email || "");
      badge.textContent = "PAR \u2713";
      chip.appendChild(badge);
    } else {
      const cta = document.createElement("a");
      cta.href = "https://get-on-par.app/";
      cta.target = "_blank";
      cta.rel = "noopener";
      cta.className = "par-connect-cta";
      cta.title = "Opens PAR in a new tab. Go to Settings \u2192 Linked Accounts to connect this email.";
      cta.textContent = "Connect to PAR";
      cta.onclick = () => {
        setTimeout(() => showToast("In PAR, open Settings \u2192 Linked Accounts to connect this email"), 300);
      };
      chip.appendChild(cta);
    }
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#loginEmail").value.trim();
    const password = $("#loginPassword").value;
    const errEl = $("#loginError");
    errEl.classList.remove("visible");
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

  /* ═════════════ Data loading ═════════════ */

  async function reloadAll() {
    showLoader(true);
    try {
      const [cats, tpls, cls, igs, tch, ct, ci, stu, enr, syncLog] = await Promise.all([
        sb.from("categories").select("*").order("sort_order", { ascending: true }),
        sb.from("templates").select("*").order("created_at", { ascending: true }),
        sb.from("classes").select("*").order("name", { ascending: true }),
        sb.from("infographics").select("*").order("name", { ascending: true }),
        sb.from("teachers").select("*").order("full_name", { ascending: true }),
        sb.from("class_teachers").select("*"),
        sb.from("class_infographics").select("*"),
        sb.from("students").select("*").order("last_name", { ascending: true }),
        sb.from("enrollments").select("*").order("enrolled_at", { ascending: false }),
        sb.from("sync_log").select("*").eq("source", "jackrabbit").eq("operation", "pull_openings").order("created_at", { ascending: false }).limit(1).maybeSingle()
      ]);
      for (const r of [cats, tpls, cls, igs, tch, ct, ci, stu, enr]) if (r.error) throw r.error;
      state.categories       = cats.data;
      state.templates        = tpls.data;
      state.classes          = cls.data;
      state.infographics     = igs.data;
      state.teachers         = tch.data;
      state.classTeachers    = ct.data;
      state.classInfographics = ci.data;
      state.students         = stu.data;
      state.enrollments      = enr.data;
      state.latestSyncLog    = syncLog.data || null;
    } catch (e) {
      console.error(e);
      showToast("Failed to load: " + e.message, "error");
    }
    showLoader(false);
  }

  function renderAll() {
    renderInfographicsSidebar();
    renderCategoryChips();
    renderTemplates();
    renderClassesTab();
    renderTeachersTab();
    renderCategoriesTab();
    renderInfographicsTab();
  }

  /* ═════════════ Router ═════════════ */

  function go(tab) {
    state.router = tab;
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    $$(".tab-panel").forEach((p) => p.style.display = p.dataset.tab === tab ? "" : "none");
    $("#subBarTemplates").classList.toggle("hidden", tab !== "templates");
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
          <button class="btn small ghost" data-act="edit" title="Edit template">✎</button>
          <button class="btn small ghost" data-act="dup" title="Duplicate template">⎘</button>
          <div class="expand-arrow">▸</div>
        </div>
      </div>
      <div class="card-body"></div>
    `;
    $(".card-title", card).textContent = tpl.title;
    $(".badge", card).textContent = categoryLabel;
    $(".tag-line", card).textContent = tagLine;

    $('[data-act="edit"]', card).onclick = (e) => { e.stopPropagation(); openTemplateEditor(tpl.id); };
    $('[data-act="dup"]',  card).onclick = (e) => { e.stopPropagation(); duplicateTemplate(tpl.id); };
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
      const teacherCount = state.classTeachers.filter((ct) => ct.class_id === c.id).length;
      const igCount = state.classInfographics.filter((ci) => ci.class_id === c.id).length;
      const activeEnrollments = state.enrollments.filter((e) => e.class_id === c.id && e.status === "active").length;
      const enrichSummary = (teacherCount || igCount || activeEnrollments)
        ? ` <span style="font-size:10.5px;color:var(--ink-dim)">· ${activeEnrollments} enrolled · ${teacherCount} teacher${teacherCount === 1 ? "" : "s"} · ${igCount} graphic${igCount === 1 ? "" : "s"}</span>`
        : ' <span style="font-size:10.5px;color:var(--ink-dim)">· no enrichment yet</span>';
      const mainRow = `
        <tr class="class-row${isOpen ? " open" : ""}" data-id="${escapeHtml(c.id)}"${c.is_test ? ' style="opacity:.6"' : ""}>
          <td><b>${escapeHtml(c.name)}</b>${sourceBadge}${stateTag}${enrichSummary}${c.age_range ? `<div style="font-size:11.5px;color:var(--ink-dim)">Ages ${escapeHtml(c.age_range)}</div>` : ""}</td>
          <td>${escapeHtml(c.day_time || "")}</td>
          <td>${escapeHtml(c.location || "")}</td>
          <td><span class="type-badge type-${escapeHtml(c.type || "weekly")}">${typeLabel[c.type] || c.type || "—"}</span>${c.active === false ? ' <span style="color:var(--ink-dim);font-size:11px">(inactive)</span>' : ""}</td>
          <td>${c.registration_link ? `<a href="${escapeHtml(c.registration_link)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--accent);" onclick="event.stopPropagation()">Link ↗</a>` : '<span style="color:var(--ink-dim);font-size:12px">—</span>'}</td>
          <td>${fmtSync(c.last_synced_at)}</td>
          <td class="row-actions"><button class="btn small ghost" data-act="edit-class" data-id="${escapeHtml(c.id)}">Edit</button></td>
        </tr>
        <tr class="class-detail${isOpen ? " open" : ""}" data-detail-for="${escapeHtml(c.id)}">
          <td colspan="7"><div class="class-detail-body" data-class-id="${escapeHtml(c.id)}"></div></td>
        </tr>
      `;
      return mainRow;
    }).join("");
    el.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Day / Time</th><th>Location</th><th>Type</th><th>Reg. link</th><th>Synced</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:var(--ink-dim);padding:24px">No classes to show. Click <b>⟳ Sync now</b> to pull from Jackrabbit, or <b>＋ New class</b>.</td></tr>'}</tbody>
      </table>
    `;
    $$('[data-act="edit-class"]', el).forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); openClassEditor(btn.dataset.id); };
    });
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
        <div class="enrollments-list"></div>
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
          await reloadAll(); renderClassesTab();
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
      await reloadAll(); renderClassesTab();
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
          row.innerHTML = `
            <span class="teacher-name">${escapeHtml(student.first_name || "")} ${escapeHtml(student.last_name || "")}${student.dob ? ` <span style="font-size:11px;color:var(--ink-dim);font-weight:400">· DoB ${escapeHtml(student.dob)}</span>` : ""}</span>
            <span class="role-tag ${statusClass}">${escapeHtml(status)}</span>
            ${drop_reason ? `<span style="font-size:11px;color:var(--ink-dim)">· ${escapeHtml(drop_reason)}</span>` : ""}
          `;
          enrollList.appendChild(row);
        });
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
          await reloadAll(); renderClassesTab();
        };
        grid.appendChild(chip);
      });
    }
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

  function renderTeachersTab() {
    const el = $("#teacherTable");
    const active = state.teachers.filter((t) => t.status === 'active').length;
    $("#teacherMeta").innerHTML = state.teachers.length + (state.teachers.length === 1 ? " teacher" : " teachers") +
      (state.teachers.length ? ` <span style="color:var(--ink-dim)">· ${active} active</span>` : "");
    const rows = state.teachers.map((t) => {
      const classCount = state.classTeachers.filter((ct) => ct.teacher_id === t.id).length;
      const statusLabel = { active: "Active", on_leave: "On leave", inactive: "Inactive" };
      return `
        <tr>
          <td><b>${escapeHtml(t.full_name)}</b>${t.email ? `<div style="font-size:11.5px;color:var(--ink-dim)">${escapeHtml(t.email)}</div>` : ""}</td>
          <td>${escapeHtml(t.phone || "")}</td>
          <td>${escapeHtml(t.pay_rate || "")}</td>
          <td><span class="type-badge status-badge-${escapeHtml(t.status)}">${statusLabel[t.status] || t.status}</span></td>
          <td style="font-size:12px">${classCount} class${classCount === 1 ? "" : "es"}</td>
          <td class="row-actions"><button class="btn small ghost" data-act="edit-teacher" data-id="${escapeHtml(t.id)}">Edit</button></td>
        </tr>
      `;
    }).join("");
    el.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Phone</th><th>Pay rate</th><th>Status</th><th>Assigned</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" style="text-align:center;color:var(--ink-dim);padding:24px">No teachers yet — click <b>＋ New teacher</b>.</td></tr>'}</tbody>
      </table>
    `;
    $$('[data-act="edit-teacher"]', el).forEach((btn) => btn.onclick = () => openTeacherEditor(btn.dataset.id));
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
    await reloadAll();
    renderAll();
    closeTeacherEditor();
    showToast(editingTeacherId ? "Teacher updated" : "Teacher added", "success");
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
    state.categories.forEach((cat) => {
      const used = state.templates.filter((t) => t.category_id === cat.id).length;
      const row = document.createElement("div");
      row.className = "category-item";
      row.innerHTML = `
        <input class="label-input" type="text" value="${escapeHtml(cat.label)}" />
        <span class="cat-id">${escapeHtml(cat.slug)}</span>
        <span class="use-count">${used} used</span>
        <button class="btn small danger" ${used > 0 ? "disabled title=\"In use — reassign templates first\"" : ""}>Delete</button>
      `;
      const [input, , , del] = row.children;
      input.onchange = async () => {
        const newLabel = input.value.trim();
        if (!newLabel || newLabel === cat.label) return;
        const { error } = await sb.from("categories").update({ label: newLabel }).eq("id", cat.id);
        if (error) { showToast(error.message, "error"); return; }
        await reloadAll(); renderAll();
        showToast("Category renamed", "success");
      };
      del.onclick = async () => {
        if (used > 0) return;
        if (!confirm("Delete this category?")) return;
        const { error } = await sb.from("categories").delete().eq("id", cat.id);
        if (error) { showToast(error.message, "error"); return; }
        await reloadAll(); renderAll();
        showToast("Category deleted", "success");
      };
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
    const rows = state.infographics.map((i) => {
      const src = i.storage_path ? publicUrlFor(i.storage_path) : i.external_url;
      const srcType = i.storage_path ? "Uploaded" : (i.external_url ? "External" : "—");
      return `
        <tr>
          <td class="thumb-cell">${src ? `<img src="${escapeHtml(src)}" alt="" />` : '<div class="no-thumb">🖼</div>'}</td>
          <td><b>${escapeHtml(i.name)}</b>${i.notes ? `<div style="font-size:11.5px;color:var(--ink-dim)">${escapeHtml(i.notes)}</div>` : ""}</td>
          <td>${(i.tags || []).map((t) => `<span class="type-badge type-workshop">#${escapeHtml(t)}</span>`).join(" ")}</td>
          <td>${srcType}</td>
          <td class="row-actions"><button class="btn small ghost" data-act="edit-ig" data-id="${escapeHtml(i.id)}">Edit</button></td>
        </tr>
      `;
    }).join("");
    el.innerHTML = `
      <table>
        <thead><tr><th>Preview</th><th>Name</th><th>Tags</th><th>Source</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:var(--ink-dim);padding:24px">No images yet — click <b>＋ Upload / add image</b>.</td></tr>'}</tbody>
      </table>
    `;
    $$('[data-act="edit-ig"]', el).forEach((btn) => btn.onclick = () => openIgEditor(btn.dataset.id));
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
    if (testToggle) testToggle.onchange = (e) => { state.cState.showTest = e.target.checked; renderClassesTab(); };

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
