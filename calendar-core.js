/* calendar-core.js — shared per-class semester-calendar engine.
 * ----------------------------------------------------------------------------
 * One source of truth for:
 *   • computing which dates a class meets (recurring weekday pattern minus
 *     no-class exceptions plus makeup dates),
 *   • rendering the on-screen month-grid preview (red-circled meeting days),
 *   • generating the branded, downloadable PDF that mirrors the printed
 *     Drama Kids "20XX <Season> CALENDAR" sheet.
 *
 * Used by BOTH the admin console (app.js, data straight from the tables) and
 * the public parent page (class-calendar.html, data from the
 * get_class_calendar RPC). Same `model` shape, same output, so the preview
 * and the PDF can never drift between admin and parent.
 *
 * No build step — exposes a single global `window.DKCalendar`. jsPDF is
 * lazy-loaded via dynamic import() only when a PDF is actually generated, so
 * it costs nothing on pages that only ever show the preview.
 *
 * The `model` shape (whether built from tables or returned by the RPC):
 *   {
 *     class:    { name, days, times, day_time, location, age_range },
 *     school:   { name, address_line1, address_line2, city, state, postal_code } | null,
 *     semester: { name, term, start_date, end_date },        // ISO date strings
 *     patterns: [{ weekday(0-6), start_time, end_time, location_name, room, teacher_name }],
 *     exceptions: [{ date(ISO), kind('no_class'|'makeup'), label }],
 *     pointers:   [{ section_title, body }],
 *     branding:   { studio_name, owner_name, phone, email, website,
 *                   facebook, instagram, address, primary_color, accent_color, logo_url }
 *   }
 */
(function () {
  "use strict";

  const WEEKDAY_LONG  = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const WEEKDAY_PLURAL = ["Sundays","Mondays","Tuesdays","Wednesdays","Thursdays","Fridays","Saturdays"];
  const WEEKDAY_INIT  = ["S","M","T","W","T","F","S"];
  const MONTH_LONG = ["January","February","March","April","May","June",
                      "July","August","September","October","November","December"];

  const BRAND_DEFAULTS = {
    studio_name:   "Drama Kids",
    owner_name:    "",
    phone:         "",
    email:         "",
    website:       "",
    facebook:      "",
    instagram:     "",
    address:       "",
    primary_color: "#0b1638",   // navy — header / footer ink
    accent_color:  "#d12027",   // red  — meeting-day circle
    logo_url:      "/logo.png"
  };

  const TERM_SEASON = {
    fall: "Fall", winter_spring: "Winter/Spring", summer: "Summer", custom: ""
  };

  /* ─── i18n: fixed labels + Spanish calendar terms ─── */
  const I18N = {
    en: {
      monthLong: MONTH_LONG,
      weekdayInit: WEEKDAY_INIT,
      weekdayPlural: WEEKDAY_PLURAL,
      classMeets: "Class Meets",
      makeupClass: "Makeup Class",
      parentPointers: "Parent Pointers",
      ages: "Ages",
      noPattern: "This calendar has no meeting pattern yet — add one in the Schedule Manager.",
    },
    es: {
      monthLong: ["enero","febrero","marzo","abril","mayo","junio",
                  "julio","agosto","septiembre","octubre","noviembre","diciembre"],
      // Spanish calendar column initials (X = miércoles to avoid the M clash).
      weekdayInit: ["D","L","M","X","J","V","S"],
      weekdayPlural: ["domingos","lunes","martes","miércoles","jueves","viernes","sábados"],
      classMeets: "Días de clase",
      makeupClass: "Clase de recuperación",
      parentPointers: "Notas para padres",
      ages: "Edades",
      noPattern: "Este calendario aún no tiene un horario — agrégalo en el administrador de horarios.",
    },
  };
  function t(model) { return I18N[(model && model.lang) || "en"] || I18N.en; }
  function capFirst(s) { s = String(s || ""); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

  /* ─── machine translation (used only for Sharon-typed pointer text) ─────
   * Free MyMemory endpoint (no key). Results are cached in localStorage so a
   * given string is fetched at most once per device; long text is chunked to
   * stay under the per-request limit; any failure falls back to the English
   * original so the calendar always renders. */
  const _trMem = {};
  function _chunk(text, max) {
    const parts = [];
    let s = String(text);
    while (s.length > max) {
      let cut = s.lastIndexOf(". ", max);
      if (cut < max * 0.5) cut = s.lastIndexOf(" ", max);
      if (cut < max * 0.5) cut = max;
      parts.push(s.slice(0, cut + 1));
      s = s.slice(cut + 1);
    }
    if (s) parts.push(s);
    return parts;
  }
  async function translateText(text, lang) {
    if (!text || !String(text).trim() || !lang || lang === "en") return text;
    const key = lang + "::" + text;
    if (_trMem[key] != null) return _trMem[key];
    try { const ls = localStorage.getItem("dkc_tr:" + key); if (ls != null) { _trMem[key] = ls; return ls; } } catch (_) {}
    try {
      const chunks = _chunk(text, 450);
      const outs = [];
      for (const c of chunks) {
        const url = "https://api.mymemory.translated.net/get?q=" + encodeURIComponent(c) + "&langpair=en|" + encodeURIComponent(lang);
        const r = await fetch(url);
        const j = await r.json();
        const tr = j && j.responseData && j.responseData.translatedText;
        outs.push(tr && !/MYMEMORY WARNING|QUERY LENGTH/i.test(tr) ? tr : c);
      }
      const out = outs.join("");
      _trMem[key] = out;
      try { localStorage.setItem("dkc_tr:" + key, out); } catch (_) {}
      return out;
    } catch (e) { return text; }
  }

  // Async: return a copy of the model with pointer text machine-translated into
  // `lang` and the lang flag set (fixed labels are handled at render time from
  // the dictionary above). Class name / proper nouns are left untouched.
  async function localizeModel(model, lang) {
    if (!model) return model;
    if (!lang || lang === "en") return Object.assign({}, model, { lang: "en" });
    const pts = model.pointers || [];
    const outPts = [];
    for (const p of pts) {
      outPts.push({
        section_title: await translateText(p.section_title, lang),
        body: await translateText(p.body, lang),
      });
    }
    return Object.assign({}, model, { pointers: outPts, lang });
  }

  /* ─── date helpers (all timezone-safe: build local dates from ISO) ─── */
  function parseISO(iso) {
    if (!iso) return null;
    if (iso instanceof Date) return new Date(iso.getFullYear(), iso.getMonth(), iso.getDate());
    const m = String(iso).slice(0, 10).split("-");
    return new Date(+m[0], (+m[1]) - 1, +m[2]);
  }
  function isoLocal(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
  function fmtTime(t) {
    // Accepts "HH:MM[:SS]" (Postgres time) → "3:45 PM". Passthrough otherwise.
    if (!t) return "";
    const m = String(t).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return String(t);
    let h = +m[1]; const min = +m[2];
    const mer = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return min ? `${h}:${String(min).padStart(2,"0")} ${mer}` : `${h}:00 ${mer}`;
  }
  function hexToRgb(hex) {
    const h = String(hex || "").replace("#", "");
    if (h.length === 3) return [parseInt(h[0]+h[0],16), parseInt(h[1]+h[1],16), parseInt(h[2]+h[2],16)];
    if (h.length >= 6)  return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
    return [11, 22, 56];
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
  }

  /* ─── derived model helpers ─── */
  function resolveBranding(b) {
    const out = Object.assign({}, BRAND_DEFAULTS);
    if (b) for (const k in BRAND_DEFAULTS) if (b[k]) out[k] = b[k];
    return out;
  }

  function seasonTitle(model) {
    const sem = model.semester || {};
    // Prefer the explicit semester name ("2025 Fall"); else build from term+year.
    if (sem.name) return `${sem.name} Calendar`.replace(/calendar calendar/i, "Calendar");
    const yr = parseISO(sem.start_date)?.getFullYear() || "";
    const season = TERM_SEASON[sem.term] || "";
    return `${yr} ${season} Calendar`.trim();
  }

  // "Wednesdays 3:45 PM - 4:45 PM - Cario Cafeteria"
  function scheduleLine(model) {
    const patterns = (model.patterns || []).slice().sort((a, b) => a.weekday - b.weekday);
    const cls = model.class || {};
    let dayPart = "";
    let timePart = "";
    let locPart = locationName(model);
    if (patterns.length) {
      dayPart = patterns.map((p) => t(model).weekdayPlural[p.weekday]).join(" & ");
      const p0 = patterns[0];
      if (p0.start_time) {
        timePart = fmtTime(p0.start_time) + (p0.end_time ? ` - ${fmtTime(p0.end_time)}` : "");
      }
      if (p0.location_name) locPart = p0.location_name;
    }
    if (!dayPart) dayPart = cls.days || "";
    if (!timePart) timePart = cls.times || cls.day_time || "";
    return [dayPart, timePart, locPart].filter(Boolean).join(timePart && dayPart ? "  " : " ")
      .replace(/\s{2,}/g, "  ").trim();
  }

  function locationName(model) {
    const p = (model.patterns || []).find((x) => x.location_name);
    if (p) return p.location_name;
    if (model.school && model.school.name) return model.school.name;
    return (model.class && model.class.location) || "";
  }

  function fullAddress(model) {
    const b = model.school;
    if (b) {
      const line1 = [b.address_line1, b.address_line2].filter(Boolean).join(", ");
      const line2 = [b.city, b.state].filter(Boolean).join(", ");
      const cityState = [line2, b.postal_code].filter(Boolean).join(" ");
      return [line1, cityState].filter(Boolean).join(" · ");
    }
    return (model.branding && model.branding.address) || "";
  }

  // Returns { meeting:Set<ISO>, makeup:Set<ISO>, noClass:Set<ISO> }.
  function computeMeetingSets(model) {
    const sem = model.semester || {};
    const start = parseISO(sem.start_date);
    const end = parseISO(sem.end_date);
    const weekdays = new Set((model.patterns || []).map((p) => p.weekday));
    const noClass = new Set();
    const makeup = new Set();
    (model.exceptions || []).forEach((x) => {
      const iso = String(x.date).slice(0, 10);
      if (x.kind === "makeup") makeup.add(iso);
      else noClass.add(iso);
    });
    const meeting = new Set();
    if (start && end) {
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const iso = isoLocal(d);
        if (weekdays.has(d.getDay()) && !noClass.has(iso)) meeting.add(iso);
      }
    }
    makeup.forEach((iso) => meeting.add(iso));
    return { meeting, makeup, noClass };
  }

  // Inclusive list of {year, month(0-11)} spanned by the semester.
  function monthsBetween(model) {
    const sem = model.semester || {};
    const start = parseISO(sem.start_date);
    const end = parseISO(sem.end_date);
    const out = [];
    if (!start || !end) return out;
    let y = start.getFullYear(), m = start.getMonth();
    const ey = end.getFullYear(), em = end.getMonth();
    while (y < ey || (y === ey && m <= em)) {
      out.push({ year: y, month: m });
      m++; if (m > 11) { m = 0; y++; }
    }
    return out;
  }

  /* ════════════════════ HTML preview ════════════════════ */
  function monthGridHTML(year, month, sets, brand, tt) {
    tt = tt || I18N.en;
    const first = new Date(year, month, 1);
    const startPad = first.getDay();
    const daysIn = new Date(year, month + 1, 0).getDate();
    let cells = "";
    for (let i = 0; i < startPad; i++) cells += `<td class="dkc-empty"></td>`;
    for (let day = 1; day <= daysIn; day++) {
      const iso = isoLocal(new Date(year, month, day));
      const meets = sets.meeting.has(iso);
      const isMakeup = sets.makeup.has(iso);
      const cls = meets ? `dkc-meet${isMakeup ? " dkc-makeup" : ""}` : "";
      cells += `<td class="${cls}"><span>${day}</span></td>`;
      if ((startPad + day) % 7 === 0) cells += `</tr><tr>`;
    }
    return `
      <div class="dkc-month">
        <div class="dkc-month-title">${esc(capFirst(tt.monthLong[month]))} ${year}</div>
        <table class="dkc-grid"><thead><tr>
          ${tt.weekdayInit.map((w) => `<th>${w}</th>`).join("")}
        </tr></thead><tbody><tr>${cells}</tr></tbody></table>
      </div>`;
  }

  function pointersHTML(model) {
    const pts = model.pointers || [];
    if (!pts.length) return "";
    return `
      <div class="dkc-pointers">
        <div class="dkc-pointers-title">${esc(t(model).parentPointers)}</div>
        <div class="dkc-pointers-grid">
          ${pts.map((p) => `
            <div class="dkc-pointer">
              <div class="dkc-pointer-h">${esc(p.section_title)}</div>
              <div class="dkc-pointer-b">${esc(p.body)}</div>
            </div>`).join("")}
        </div>
      </div>`;
  }

  // Full light-paper preview that mirrors the PDF. Scoped under `.dkc-paper`.
  function renderPreviewHTML(model) {
    const brand = resolveBranding(model.branding);
    const sets = computeMeetingSets(model);
    const months = monthsBetween(model);
    const cls = model.class || {};
    const sched = scheduleLine(model);
    const addr = fullAddress(model);
    const tt = t(model);
    const ageBit = cls.age_range ? `<span class="dkc-age">${esc(tt.ages)} ${esc(cls.age_range)}</span>` : "";
    const monthsHTML = months.length
      ? months.map((m) => monthGridHTML(m.year, m.month, sets, brand, tt)).join("")
      : `<div class="dkc-empty-note">${esc(tt.noPattern)}</div>`;

    return `
      <div class="dkc-paper" style="--dkc-primary:${esc(brand.primary_color)};--dkc-accent:${esc(brand.accent_color)}">
        <div class="dkc-head">
          <img class="dkc-logo" src="${esc(brand.logo_url)}" alt="" onerror="this.style.display='none'" />
          <div class="dkc-head-text">
            <div class="dkc-class-name">${esc(cls.name || "Class")} ${ageBit}</div>
            <div class="dkc-sched">${esc(sched)}</div>
            ${addr ? `<div class="dkc-addr">${esc(addr)}</div>` : ""}
          </div>
        </div>
        <div class="dkc-legend"><span class="dkc-legend-dot"></span> ${esc(tt.classMeets)}
          ${sets.makeup.size ? `<span class="dkc-legend-dot dkc-legend-makeup"></span> ${esc(tt.makeupClass)}` : ""}
        </div>
        <div class="dkc-months">${monthsHTML}</div>
        ${pointersHTML(model)}
        <div class="dkc-foot">
          <div class="dkc-foot-studio">${esc(brand.studio_name)}${brand.owner_name ? " · " + esc(brand.owner_name) : ""}</div>
          <div class="dkc-foot-contact">
            ${[brand.phone, brand.email, brand.website].filter(Boolean).map(esc).join(" · ")}
          </div>
          ${(brand.facebook || brand.instagram) ? `<div class="dkc-foot-social">${[
            brand.facebook ? "f " + esc(brand.facebook) : "",
            brand.instagram ? "ig " + esc(brand.instagram) : ""
          ].filter(Boolean).join("   ")}</div>` : ""}
        </div>
      </div>`;
  }

  /* ════════════════════ PDF generation (jsPDF) ════════════════════ */
  let _jspdf = null;
  async function loadJsPDF() {
    if (_jspdf) return _jspdf;
    const mod = await import("https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm");
    _jspdf = mod.jsPDF || (mod.default && mod.default.jsPDF) || mod.default;
    return _jspdf;
  }
  function loadImageData(url) {
    return new Promise((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          // Downscale to keep the embedded logo (and thus the PDF) small —
          // logos are often 1024²+; ~220px is plenty at print resolution.
          const MAX = 220;
          const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * scale));
          const h = Math.max(1, Math.round(img.naturalHeight * scale));
          const c = document.createElement("canvas");
          c.width = w; c.height = h;
          c.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve({ dataUrl: c.toDataURL("image/png"), w: img.naturalWidth, h: img.naturalHeight });
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  // Letter portrait, points. Lays out month grids 2-per-row and paginates;
  // Parent Pointers start on a fresh page at the end.
  async function generatePDF(model, opts) {
    opts = opts || {};
    // Translate content into the requested language (pointers machine-translated,
    // labels from the dictionary) before laying out the PDF.
    if (opts.lang && opts.lang !== "en" && (!model || model.lang !== opts.lang)) {
      model = await localizeModel(model, opts.lang);
    }
    const tt = t(model);
    const jsPDF = await loadJsPDF();
    const brand = resolveBranding(model.branding);
    const sets = computeMeetingSets(model);
    const months = monthsBetween(model);
    const cls = model.class || {};
    const primary = hexToRgb(brand.primary_color);
    const accent = hexToRgb(brand.accent_color);
    const logo = await loadImageData(brand.logo_url);

    const doc = new jsPDF({ unit: "pt", format: "letter" });
    const PW = doc.internal.pageSize.getWidth();
    const PH = doc.internal.pageSize.getHeight();
    const M = 42;                       // page margin
    const footerH = 46;

    const drawFooter = () => {
      const y = PH - footerH + 8;
      doc.setDrawColor(220); doc.setLineWidth(0.6);
      doc.line(M, y - 8, PW - M, y - 8);
      doc.setTextColor(primary[0], primary[1], primary[2]);
      doc.setFont("helvetica", "bold"); doc.setFontSize(9);
      const studioLine = brand.studio_name + (brand.owner_name ? "  ·  " + brand.owner_name : "");
      doc.text(studioLine, PW / 2, y + 2, { align: "center" });
      doc.setFont("helvetica", "normal"); doc.setFontSize(8);
      doc.setTextColor(90, 90, 90);
      const contact = [brand.phone, brand.email, brand.website].filter(Boolean).join("   ·   ");
      if (contact) doc.text(contact, PW / 2, y + 14, { align: "center" });
      const social = [brand.facebook ? "f " + brand.facebook : "", brand.instagram ? "ig " + brand.instagram : ""].filter(Boolean).join("    ");
      if (social) doc.text(social, PW / 2, y + 25, { align: "center" });
    };

    // ── Header (first page) ──
    let cursorY = M;
    let logoW = 0;
    if (logo) {
      // Fit within a box, preserving aspect ratio — works for square OR wide
      // (landscape) logos like the Drama Kids wordmark.
      const maxH = 50, maxW = 160;
      let lw = maxW, lh = logo.h ? (logo.h / logo.w) * lw : maxH;
      if (lh > maxH) { lh = maxH; lw = logo.w ? (logo.w / logo.h) * lh : maxW; }
      try { doc.addImage(logo.dataUrl, "PNG", M, cursorY, lw, lh); logoW = lw; } catch (e) {}
    }
    const tx = M + (logoW ? logoW + 14 : 0);
    doc.setTextColor(primary[0], primary[1], primary[2]);
    doc.setFont("helvetica", "bold"); doc.setFontSize(18);
    doc.text(cls.name || "Class", tx, cursorY + 16);
    doc.setFont("helvetica", "normal"); doc.setFontSize(11);
    doc.setTextColor(50, 50, 50);
    const sched = scheduleLine(model);
    if (sched) doc.text(sched, tx, cursorY + 33);
    const addr = fullAddress(model);
    doc.setFontSize(9); doc.setTextColor(110, 110, 110);
    if (addr) doc.text(addr, tx, cursorY + 47);
    cursorY += 64;

    // (Season / calendar-name title intentionally omitted — the class name is
    // the header; keeps the printed calendar clean.)
    cursorY += 6;

    // Legend
    doc.setDrawColor(accent[0], accent[1], accent[2]); doc.setLineWidth(1.4);
    doc.circle(M + 6, cursorY + 4, 5, "S");
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    doc.setTextColor(60, 60, 60);
    doc.text(tt.classMeets, M + 18, cursorY + 7);
    if (sets.makeup.size) {
      doc.setFillColor(accent[0], accent[1], accent[2]);
      doc.circle(M + 110, cursorY + 4, 5, "F");
      doc.text(tt.makeupClass, M + 122, cursorY + 7);
    }
    cursorY += 24;

    // ── Month grids: 2 columns ──
    const gap = 20;
    const colW = (PW - M * 2 - gap) / 2;
    const cellW = colW / 7;
    const cellH = 17;
    const gridHeaderH = 30;       // month title + weekday row
    const monthBlockH = gridHeaderH + cellH * 6 + 12;

    const drawMonth = (x, y, year, month) => {
      doc.setTextColor(primary[0], primary[1], primary[2]);
      doc.setFont("helvetica", "bold"); doc.setFontSize(11);
      doc.text(`${capFirst(tt.monthLong[month])} ${year}`, x + colW / 2, y + 10, { align: "center" });
      // weekday header
      doc.setFontSize(7.5); doc.setTextColor(120, 120, 120);
      for (let i = 0; i < 7; i++) {
        doc.text(tt.weekdayInit[i], x + cellW * i + cellW / 2, y + 24, { align: "center" });
      }
      // day cells
      const gridTop = y + 30;
      const first = new Date(year, month, 1);
      const startPad = first.getDay();
      const daysIn = new Date(year, month + 1, 0).getDate();
      doc.setFont("helvetica", "normal");
      for (let day = 1; day <= daysIn; day++) {
        const idx = startPad + day - 1;
        const row = Math.floor(idx / 7);
        const col = idx % 7;
        const cx = x + cellW * col + cellW / 2;
        const cy = gridTop + cellH * row + cellH / 2;
        const iso = isoLocal(new Date(year, month, day));
        if (sets.meeting.has(iso)) {
          doc.setDrawColor(accent[0], accent[1], accent[2]);
          doc.setLineWidth(1.2);
          doc.circle(cx, cy - 2.5, 7.6, "S");
          doc.setTextColor(accent[0], accent[1], accent[2]);
          doc.setFont("helvetica", "bold");
        } else {
          doc.setTextColor(70, 70, 70);
          doc.setFont("helvetica", "normal");
        }
        doc.setFontSize(8.5);
        doc.text(String(day), cx, cy, { align: "center" });
      }
      // light grid border
      doc.setDrawColor(232); doc.setLineWidth(0.5);
      const rows = Math.ceil((startPad + daysIn) / 7);
      doc.rect(x, gridTop - 2, colW, cellH * rows + 2, "S");
    };

    let col = 0;
    let rowY = cursorY;
    for (let i = 0; i < months.length; i++) {
      if (rowY + monthBlockH > PH - footerH - 6) {
        drawFooter(); doc.addPage(); rowY = M; col = 0;
      }
      const x = M + col * (colW + gap);
      drawMonth(x, rowY, months[i].year, months[i].month);
      col++;
      if (col === 2) { col = 0; rowY += monthBlockH; }
    }
    drawFooter();

    // ── Parent Pointers page ──
    const pts = model.pointers || [];
    if (pts.length) {
      doc.addPage();
      let py = M;
      doc.setTextColor(primary[0], primary[1], primary[2]);
      doc.setFont("helvetica", "bold"); doc.setFontSize(18);
      doc.text(tt.parentPointers, PW / 2, py + 10, { align: "center" });
      py += 22;
      doc.setDrawColor(accent[0], accent[1], accent[2]); doc.setLineWidth(1.2);
      doc.line(PW / 2 - 40, py, PW / 2 + 40, py);
      py += 22;
      const textW = PW - M * 2;
      for (const p of pts) {
        // estimate height; new page if needed
        doc.setFont("helvetica", "normal"); doc.setFontSize(10);
        const bodyLines = doc.splitTextToSize(p.body || "", textW);
        const blockH = 16 + bodyLines.length * 12 + 10;
        if (py + blockH > PH - footerH - 6) { drawFooter(); doc.addPage(); py = M; }
        doc.setFont("helvetica", "bold"); doc.setFontSize(11.5);
        doc.setTextColor(primary[0], primary[1], primary[2]);
        doc.text(p.section_title || "", M, py);
        py += 15;
        doc.setFont("helvetica", "normal"); doc.setFontSize(10);
        doc.setTextColor(55, 55, 55);
        doc.text(bodyLines, M, py);
        py += bodyLines.length * 12 + 12;
      }
      drawFooter();
    }

    // Page numbers
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFont("helvetica", "normal"); doc.setFontSize(7.5);
      doc.setTextColor(160, 160, 160);
      doc.text(`${i} / ${pageCount}`, PW - M, PH - 12, { align: "right" });
    }

    const fname = (opts.filename || `${(cls.name || "class")}-${(model.semester && model.semester.name) || "calendar"}`)
      .replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-") + ".pdf";
    if (opts.returnBlob) return doc.output("blob");
    doc.save(fname);
    return true;
  }

  window.DKCalendar = {
    WEEKDAY_LONG, WEEKDAY_PLURAL, WEEKDAY_INIT, MONTH_LONG, TERM_SEASON,
    BRAND_DEFAULTS,
    parseISO, isoLocal, fmtTime, esc,
    resolveBranding, seasonTitle, scheduleLine, locationName, fullAddress,
    computeMeetingSets, monthsBetween,
    renderPreviewHTML, monthGridHTML, pointersHTML,
    generatePDF,
    localizeModel, translateText, I18N
  };
})();
