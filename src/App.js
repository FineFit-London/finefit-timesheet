import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

const ADMIN_PASSWORD = "finefit2024";
const DEVICE_ID = (() => {
  let id = localStorage.getItem("finefit_device_id");
  if (!id) { id = Math.random().toString(36).slice(2); localStorage.setItem("finefit_device_id", id); }
  return id;
})();

// ---------- FORTNIGHTLY PERIODS ----------
// Cycles are two weeks (Mon–Sun x2), anchored to Monday 6 July 2026.
const FORTNIGHT_ANCHOR = new Date(2026, 6, 6); // months are 0-indexed: 6 = July
FORTNIGHT_ANCHOR.setHours(0, 0, 0, 0);
const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1000;

// Build a YYYY-MM-DD key from LOCAL date parts (never UTC), so British Summer Time
// doesn't shift dates back a day. Using toISOString() here was the bug.
function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getPeriodStart(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const diff = d.getTime() - FORTNIGHT_ANCHOR.getTime();
  const periods = Math.floor(diff / FORTNIGHT_MS);
  return new Date(FORTNIGHT_ANCHOR.getTime() + periods * FORTNIGHT_MS);
}
function formatDate(date) {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function getCurrentWeekLabel() {
  const start = getPeriodStart();
  const end = new Date(start);
  end.setDate(end.getDate() + 13);
  return `${formatDate(start)} – ${formatDate(end)}`;
}
function getWeekKey() { return dateKey(getPeriodStart()); }
function toGBP(n) { return "£" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function weekEndLabel(weekKey) {
  if (!weekKey || weekKey === "all") return "";
  const start = new Date(weekKey + "T00:00:00");
  const end = new Date(start);
  end.setDate(end.getDate() + 13);
  return end.toLocaleDateString("en-GB");
}
// Short label for a fortnight, e.g. "6 Jul – 19 Jul"
function periodLabelShort(weekKey) {
  if (!weekKey || weekKey === "all") return "";
  const start = new Date(weekKey + "T00:00:00");
  const end = new Date(start);
  end.setDate(end.getDate() + 13);
  const f = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${f(start)} – ${f(end)}`;
}

// ---------- UK BANK HOLIDAYS (England & Wales) ----------
// Baked-in fallback list so overtime is always correct even without internet.
// Refreshed from GOV.UK at runtime when possible (see refreshBankHolidays).
let BANK_HOLIDAYS = new Set([
  // 2026 (England & Wales)
  "2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25",
  "2026-08-31", "2026-12-25", "2026-12-28",
  // 2027 (England & Wales)
  "2027-01-01", "2027-03-26", "2027-03-29", "2027-05-03", "2027-05-31",
  "2027-08-30", "2027-12-27", "2027-12-28",
]);

// Try to pull the official, always-up-to-date list from GOV.UK. Falls back silently.
async function refreshBankHolidays() {
  try {
    const res = await fetch("https://www.gov.uk/bank-holidays.json");
    if (!res.ok) return;
    const data = await res.json();
    const events = data?.["england-and-wales"]?.events || [];
    if (events.length) {
      const s = new Set(events.map(e => e.date));
      // Merge with baked-in list so we never lose coverage
      BANK_HOLIDAYS = new Set([...BANK_HOLIDAYS, ...s]);
    }
  } catch { /* offline or blocked — keep baked-in list */ }
}

function isBankHoliday(dateIso) {
  return !!dateIso && BANK_HOLIDAYS.has(dateIso);
}

// Areas worked for an entry, handling both the new free-text `areas` (strings)
// and legacy `tasks` (objects with a label). Returns an array of strings.
function entryAreas(en) {
  if (!en) return [];
  if (Array.isArray(en.areas) && en.areas.length) return en.areas;
  if (Array.isArray(en.tasks) && en.tasks.length) return en.tasks.map(t => (typeof t === "string" ? t : t.label)).filter(Boolean);
  return [];
}

// Receipts may be an old plain string (image data URL) or a {data,type,name} object.
function receiptSrc(r) { return !r ? null : (typeof r === "string" ? r : r.data); }
function receiptIsPdf(r) { return !!r && typeof r === "object" && r.type === "pdf"; }
function receiptName(r) { return (r && typeof r === "object" && r.name) ? r.name : "receipt"; }
function openReceipt(r) {
  const src = receiptSrc(r);
  if (!src) return;
  const w = window.open("", "_blank");
  if (!w) return;
  if (receiptIsPdf(r)) {
    w.document.write(`<iframe src="${src}" style="border:0;width:100%;height:100vh"></iframe>`);
  } else {
    w.document.write(`<img src="${src}" style="max-width:100%">`);
  }
  w.document.close();
}

// ---------- OVERTIME ----------
// Splits an entry's hours into normal vs overtime.
// Overtime = all Sat/Sun hours, all bank-holiday hours, plus weekday hours over 8.5/day.
function splitOvertime(day, hours, dateIso) {
  const h = Number(hours) || 0;
  if (day === "Saturday" || day === "Sunday" || isBankHoliday(dateIso)) return { normal: 0, overtime: h };
  const normal = Math.min(h, 8.5);
  return { normal, overtime: Math.max(0, h - 8.5) };
}

// The 14 dates of a fortnight, each with its weekday name and a short label
function getPeriodDays(periodStartKey) {
  const start = periodStartKey ? new Date(periodStartKey + "T00:00:00") : getPeriodStart();
  const out = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const dayName = d.toLocaleDateString("en-GB", { weekday: "long" });
    const iso = dateKey(d);
    const bh = isBankHoliday(iso);
    const label = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + (bh ? " — Bank Holiday" : "");
    out.push({ iso, dayName, label, week: i < 7 ? 1 : 2, bankHoliday: bh });
  }
  return out;
}

// ---------- STORAGE (Firebase) ----------
async function load(key) {
  try {
    const snap = await getDoc(doc(db, "shared", key));
    return snap.exists() ? snap.data().value : null;
  } catch { return null; }
}
async function save(key, val) {
  try { await setDoc(doc(db, "shared", key), { value: val }); } catch(e) { console.error(e); }
}
async function loadStr(key) {
  try {
    const snap = await getDoc(doc(db, "devices", DEVICE_ID));
    return snap.exists() ? (snap.data()[key] || null) : null;
  } catch { return null; }
}
async function saveStr(key, val) {
  try { await setDoc(doc(db, "devices", DEVICE_ID), { [key]: val }, { merge: true }); } catch(e) { console.error(e); }
}
async function del(key) {
  try {
    const snap = await getDoc(doc(db, "devices", DEVICE_ID));
    if (snap.exists()) {
      const data = { ...snap.data() };
      delete data[key];
      await setDoc(doc(db, "devices", DEVICE_ID), data);
    }
  } catch {}
}

// ---------- LOGO ----------
function Logo() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={{ width: 36, height: 36, background: "#C8A96E", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Playfair Display', serif", fontWeight: 700, fontSize: 18, color: "#1a1a1a" }}>F</div>
      <div>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 700, color: "#1a1a1a", lineHeight: 1 }}>FineFit</div>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#888", letterSpacing: "0.15em", textTransform: "uppercase" }}>London</div>
      </div>
    </div>
  );
}

// ---------- FITTER LOGIN ----------
// Hash a PIN (salted with the fitter's name) using the browser's crypto.
async function hashPin(name, pin) {
  const data = new TextEncoder().encode(`finefit:${name}:${pin}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function FitterLogin({ fittersList, pins, onSetPin, onLogin }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [step, setStep] = useState("name"); // "name" | "setPin" | "enterPin"
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const sorted = [...(fittersList || [])].sort((a, b) => a.localeCompare(b));

  const chooseName = () => {
    if (!name) { setError("Please select your name."); return; }
    setError("");
    // If this fitter already has a PIN, ask for it; otherwise set one up.
    if (pins && pins[name]) setStep("enterPin");
    else setStep("setPin");
  };

  const doSetPin = async () => {
    if (!/^\d{4}$/.test(pin)) { setError("Choose a 4-digit PIN (numbers only)."); return; }
    if (pin !== pin2) { setError("The two PINs don't match — try again."); return; }
    const h = await hashPin(name, pin);
    await onSetPin(name, h);
    await onLogin(name);
  };

  const doEnterPin = async () => {
    const h = await hashPin(name, pin);
    if (h !== pins[name]) { setError("That PIN isn't right. Try again, or ask Tom to reset it."); setPin(""); return; }
    await onLogin(name);
  };

  if (sorted.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "48px 20px" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>👋</div>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, marginBottom: 8, color: "#1a1a1a" }}>Welcome</h2>
        <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#888" }}>
          No fitters have been set up yet.<br />Please ask Tom to add you to the list in the Admin panel.
        </p>
      </div>
    );
  }

  // Step 2a: first-time PIN setup
  if (step === "setPin") {
    return (
      <div>
        <button onClick={() => { setStep("name"); setPin(""); setPin2(""); setError(""); }} style={{ background: "none", border: "none", color: "#aaa", fontFamily: "'DM Mono', monospace", fontSize: 12, cursor: "pointer", padding: 0, marginBottom: 16 }}>← Back</button>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, marginBottom: 6, color: "#1a1a1a" }}>Set your PIN, {name}</h2>
        <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", marginBottom: 24 }}>Choose a 4-digit PIN. You'll use it each time you log in on a new phone. It keeps your hours and pay private.</p>
        <label style={labelStyle}>Choose a 4-digit PIN</label>
        <input value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setError(""); }} type="tel" inputMode="numeric" placeholder="••••" style={{ ...inputStyle, letterSpacing: "0.4em", fontSize: 20 }} autoFocus />
        <label style={{ ...labelStyle, marginTop: 14 }}>Type it again</label>
        <input value={pin2} onChange={e => { setPin2(e.target.value.replace(/\D/g, "").slice(0, 4)); setError(""); }} type="tel" inputMode="numeric" placeholder="••••" style={{ ...inputStyle, letterSpacing: "0.4em", fontSize: 20 }} onKeyDown={e => e.key === "Enter" && doSetPin()} />
        {error && <p style={{ color: "#c0392b", fontFamily: "'DM Mono', monospace", fontSize: 12, marginTop: 8 }}>{error}</p>}
        <button onClick={doSetPin} style={{ ...btnStyle, marginTop: 20, width: "100%" }}>Save PIN &amp; Continue</button>
      </div>
    );
  }

  // Step 2b: returning fitter enters PIN
  if (step === "enterPin") {
    return (
      <div>
        <button onClick={() => { setStep("name"); setPin(""); setError(""); }} style={{ background: "none", border: "none", color: "#aaa", fontFamily: "'DM Mono', monospace", fontSize: 12, cursor: "pointer", padding: 0, marginBottom: 16 }}>← Back</button>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, marginBottom: 6, color: "#1a1a1a" }}>Hi, {name}</h2>
        <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", marginBottom: 24 }}>Enter your 4-digit PIN to log in.</p>
        <label style={labelStyle}>Your PIN</label>
        <input value={pin} onChange={e => { setPin(e.target.value.replace(/\D/g, "").slice(0, 4)); setError(""); }} type="tel" inputMode="numeric" placeholder="••••" style={{ ...inputStyle, letterSpacing: "0.4em", fontSize: 20 }} autoFocus onKeyDown={e => e.key === "Enter" && doEnterPin()} />
        {error && <p style={{ color: "#c0392b", fontFamily: "'DM Mono', monospace", fontSize: 12, marginTop: 8 }}>{error}</p>}
        <button onClick={doEnterPin} style={{ ...btnStyle, marginTop: 20, width: "100%" }}>Log In</button>
        <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#bbb", marginTop: 16, textAlign: "center" }}>Forgotten it? Ask Tom to reset your PIN.</p>
      </div>
    );
  }

  // Step 1: pick name
  return (
    <div>
      <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 24, marginBottom: 6, color: "#1a1a1a" }}>Welcome</h2>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", marginBottom: 28 }}>Select your name to get started. You'll set or enter a personal PIN next.</p>
      <label style={labelStyle}>Your Name</label>
      <select value={name} onChange={e => { setName(e.target.value); setError(""); }}
        style={{ ...selectStyle, borderColor: error ? "#c0392b" : undefined }} autoFocus>
        <option value="">— Select your name —</option>
        {sorted.map(f => <option key={f} value={f}>{f}{pins && pins[f] ? "" : "  (new)"}</option>)}
      </select>
      {error && <p style={{ color: "#c0392b", fontFamily: "'DM Mono', monospace", fontSize: 12, marginTop: 8 }}>{error}</p>}
      <button onClick={chooseName} style={{ ...btnStyle, marginTop: 20, width: "100%" }}>Continue</button>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#bbb", marginTop: 16, textAlign: "center" }}>Name not listed? Ask Tom to add you.</p>
    </div>
  );
}

// ---------- FITTER FORM ----------
function FitterForm({ fitterName, onLogout, onSubmit, sites, allEntries, lockedWeeks, rates, onDeleteRecord, onUpdateRecord }) {
  const periodDays = getPeriodDays();
  // Days this fitter has already submitted this fortnight, so we can default to the next one
  const submittedIsos = new Set(
    (allEntries || [])
      .filter(r => r.fitter === fitterName && r.weekKey === getWeekKey())
      .flatMap(r => (r.entries || []).map(e => e.date))
  );
  const firstFreeDay = periodDays.find(d => !submittedIsos.has(d.iso)) || periodDays[0];
  const emptyEntry = (day) => { const d = day || firstFreeDay; return { date: d.iso, day: d.dayName, siteId: "", hours: "", areas: [], areaDraft: "", expenses: [] }; };
  const emptyExpense = () => ({ description: "", amount: "", receipt: null });
  const draftKey = `finefit_draft_${fitterName}`;

  // Restore any saved draft for this fitter on this device
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [entries, setEntries] = useState(() => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const d = JSON.parse(raw);
        // Only treat as a real draft if something meaningful was entered
        if (Array.isArray(d) && d.some(e => e.siteId || e.hours)) return d;
      }
    } catch {}
    return [emptyEntry()];
  });
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [confirmData, setConfirmData] = useState(null); // holds { record, warnings } when confirming
  const [confirmedCorrect, setConfirmedCorrect] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileRefs = useRef({});

  // Flag a restored draft once, on first load
  useEffect(() => {
    if (entries.some(e => e.siteId || e.hours)) setRestoredDraft(true);
  }, []);

  // Auto-save draft whenever entries change (skip once submitted)
  useEffect(() => {
    if (submitted) return;
    try { localStorage.setItem(draftKey, JSON.stringify(entries)); } catch {}
  }, [entries, submitted, draftKey]);

  const clearDraft = () => { try { localStorage.removeItem(draftKey); } catch {} };

  const updateEntry = (i, field, value) => {
    const updated = [...entries];
    updated[i] = { ...updated[i], [field]: value };
    setEntries(updated);
  };
  // Add the typed area (or a tapped suggestion) to this day's list of areas
  const addArea = (i, value) => {
    const name = (value ?? entries[i].areaDraft ?? "").trim();
    if (!name) return;
    const updated = [...entries];
    const existing = updated[i].areas || [];
    // avoid duplicates (case-insensitive)
    if (!existing.some(a => a.toLowerCase() === name.toLowerCase())) {
      updated[i] = { ...updated[i], areas: [...existing, name], areaDraft: "" };
    } else {
      updated[i] = { ...updated[i], areaDraft: "" };
    }
    setEntries(updated);
  };
  const removeArea = (i, name) => {
    const updated = [...entries];
    updated[i] = { ...updated[i], areas: (updated[i].areas || []).filter(a => a !== name) };
    setEntries(updated);
  };
  // Areas typed before for this site (mined from past submissions) → offered as tap-suggestions
  const areaSuggestions = (siteId) => {
    if (!siteId) return [];
    const set = new Set();
    (allEntries || []).forEach(r => (r.entries || []).forEach(en => {
      if (en.siteId === siteId) {
        (en.areas || []).forEach(a => set.add(a));
        // include legacy task labels too, so old data still offers suggestions
        (en.tasks || []).forEach(t => { if (t.label) set.add(t.label); });
      }
    }));
    return [...set].sort((a, b) => a.localeCompare(b));
  };
  const addExpense = (i) => {
    const updated = [...entries];
    updated[i] = { ...updated[i], expenses: [...(updated[i].expenses || []), emptyExpense()] };
    setEntries(updated);
  };
  const updateExpense = (i, ei, field, value) => {
    const updated = [...entries];
    const exps = [...(updated[i].expenses || [])];
    exps[ei] = { ...exps[ei], [field]: value };
    updated[i] = { ...updated[i], expenses: exps };
    setEntries(updated);
  };
  const handleReceiptUpload = (i, ei, file) => {
    if (!file) return;
    // Firestore documents have a ~1MB limit; receipts are stored inline, so cap the file size.
    const maxBytes = 900 * 1024;
    if (file.size > maxBytes) {
      alert("That file is a bit large (over ~0.9MB). Please use a smaller photo or PDF — most phone cameras let you send a smaller size, or you can take a fresh photo.");
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
      updateExpense(i, ei, "receipt", { data: e.target.result, type: isPdf ? "pdf" : "image", name: file.name || "receipt" });
    };
    reader.readAsDataURL(file);
  };
  const removeExpense = (i, ei) => {
    const updated = [...entries];
    updated[i] = { ...updated[i], expenses: (updated[i].expenses || []).filter((_, idx) => idx !== ei) };
    setEntries(updated);
  };
  const addEntry = () => {
    // Start the new day on the one after the latest day already added,
    // skipping any the fitter has already submitted this fortnight.
    const latest = entries.reduce((acc, e) => (e.date && e.date > acc ? e.date : acc), "");
    const from = periodDays.findIndex(d => d.iso === latest);
    const used = new Set([...submittedIsos, ...entries.map(e => e.date)]);
    const next = periodDays.slice(from + 1).find(d => !used.has(d.iso))
      || periodDays.find(d => !used.has(d.iso))
      || periodDays[Math.min(from + 1, periodDays.length - 1)]
      || periodDays[0];
    setEntries([...entries, emptyEntry(next)]);
  };
  const removeEntry = (i) => setEntries(entries.filter((_, idx) => idx !== i));

  // Hours already submitted by this fitter this week (for running total)
  const thisWeekKey = getWeekKey();
  const alreadyThisWeek = (allEntries || [])
    .filter(r => r.fitter === fitterName && r.weekKey === thisWeekKey)
    .flatMap(r => r.entries);
  const submittedHours = alreadyThisWeek.reduce((a, e) => a + (e.hours || 0), 0);
  const draftHours = entries.reduce((a, e) => a + (parseFloat(e.hours) || 0), 0);
  const runningTotal = submittedHours + draftHours;

  // Build the record + collect any soft warnings, then show confirmation
  const buildAndConfirm = () => {
    setError("");
    for (const e of entries) {
      if (!e.siteId) { setError("Please select a site for each entry."); return; }
      const h = parseFloat(e.hours);
      const dayLabel = e.day ? `${e.day}${e.date ? " (" + e.date + ")" : ""}` : "one of your days";
      if (e.hours === "" || e.hours === undefined || e.hours === null) { setError(`You haven't entered any hours for ${dayLabel}. Add the hours, or remove that day.`); return; }
      if (isNaN(h) || h <= 0) { setError(`Hours for ${dayLabel} must be a number greater than 0.`); return; }
      if (h > 24) { setError(`Hours for ${dayLabel} can't be more than 24 in a day.`); return; }
      // Pull in any area still typed but not yet "added"
      const draftedAreas = [...(e.areas || [])];
      if ((e.areaDraft || "").trim() && !draftedAreas.some(a => a.toLowerCase() === e.areaDraft.trim().toLowerCase())) draftedAreas.push(e.areaDraft.trim());
      if (draftedAreas.length === 0) { setError(`Please add at least one area worked for ${dayLabel}.`); return; }
      e._areas = draftedAreas;
      for (const exp of (e.expenses || [])) {
        if (!exp.description.trim()) { setError("Please add a description for each expense."); return; }
        if (!exp.amount || isNaN(parseFloat(exp.amount)) || parseFloat(exp.amount) <= 0) { setError("Please enter a valid amount for each expense."); return; }
      }
    }
    const site = (id) => sites.find(s => s.id === id);

    const builtEntries = entries.map(e => {
      const h = parseFloat(e.hours);
      const ot = splitOvertime(e.day, h, e.date);
      return {
        date: e.date,
        day: e.day,
        siteId: e.siteId,
        siteName: site(e.siteId)?.name || e.siteId,
        client: site(e.siteId)?.client || "",
        hours: h,
        normalHours: ot.normal,
        overtimeHours: ot.overtime,
        areas: e._areas || e.areas || [],
        expenses: (e.expenses || []).map(exp => ({ description: exp.description.trim(), amount: parseFloat(exp.amount), receipt: exp.receipt || null }))
      };
    });

    // ---- Soft warnings ----
    const warnings = [];

    // Duplicate date+site already submitted this fortnight
    alreadyThisWeek.forEach(prev => {
      builtEntries.forEach(ne => {
        if (prev.date === ne.date && prev.siteName === ne.siteName) {
          warnings.push(`You already submitted ${ne.day} (${ne.date}) at ${ne.siteName} this fortnight — this would be a second entry.`);
        }
      });
    });

    // Duplicate date+site within this same form
    builtEntries.forEach((a, ai) => builtEntries.forEach((b, bi) => {
      if (ai < bi && a.date === b.date && a.siteId === b.siteId) {
        warnings.push(`You've entered ${a.day} (${a.date}) at ${a.siteName} twice in this submission.`);
      }
    }));

    // Overtime notice (so they know it'll be paid at the higher rate)
    builtEntries.forEach(ne => {
      if (ne.overtimeHours > 0) {
        const why = isBankHoliday(ne.date) ? "bank holiday" : (ne.day === "Saturday" || ne.day === "Sunday") ? "weekend" : "over 8.5 hrs";
        warnings.push(`${ne.day}: ${ne.overtimeHours} hr(s) counted as overtime (${why}).`);
      }
    });

    // High single-day hours
    builtEntries.forEach(ne => {
      if (ne.hours > 12) warnings.push(`${ne.day}: ${ne.hours} hours is a long day — please check it's right.`);
    });

    // High weekly total
    if (runningTotal > 120) warnings.push(`Your total for the fortnight would be ${runningTotal.toFixed(1)} hours — please check that's correct.`);

    // Expense without a receipt attached
    builtEntries.forEach(ne => {
      (ne.expenses || []).forEach(x => {
        if (!x.receipt) warnings.push(`${ne.day}: expense "${x.description}" has no receipt attached — add a photo or file so Tom can claim it back.`);
      });
    });

    const record = {
      id: Date.now(),
      fitter: fitterName,
      deviceId: DEVICE_ID,
      weekKey: getWeekKey(),
      weekLabel: getCurrentWeekLabel(),
      submittedAt: new Date().toISOString(),
      entries: builtEntries
    };
    setConfirmData({ record, warnings: [...new Set(warnings)] });
    setConfirmedCorrect(false);
  };

  const confirmSubmit = async () => {
    if (submitting) return; // guard against double-tap while the save is in progress
    setSubmitting(true);
    try {
      await onSubmit(confirmData.record);
      clearDraft();
      setRestoredDraft(false);
      setConfirmData(null);
      setConfirmedCorrect(false);
      setSubmitted(true);
    } catch (err) {
      alert("Sorry — that didn't save. Please check your signal and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (sites.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "48px 20px" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>⚙️</div>
        <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#888" }}>
          No sites set up yet.
          <br />Please ask Tom to add them via the Admin panel.
        </p>
      </div>
    );
  }

  if (submitted) {
    return (
      <div style={{ textAlign: "center", padding: "60px 20px" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✓</div>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, marginBottom: 8, color: "#1a1a1a" }}>Submitted!</h2>
        <p style={{ color: "#666", fontFamily: "'DM Mono', monospace", fontSize: 13 }}>Hours and expenses logged. Thanks {fitterName}.</p>
        <button onClick={() => { setSubmitted(false); setRestoredDraft(false); setEntries([emptyEntry()]); }} style={btnStyle}>Submit more</button>
      </div>
    );
  }

  // Confirmation summary screen
  if (confirmData) {
    const { record, warnings } = confirmData;
    const recTotal = record.entries.reduce((a, e) => a + (e.hours || 0), 0);
    const expTotalAll = record.entries.flatMap(e => e.expenses || []).reduce((a, x) => a + (x.amount || 0), 0);
    return (
      <div>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, marginBottom: 4, color: "#1a1a1a" }}>Check before submitting</h2>
        <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", marginBottom: 20 }}>Have a quick look — is everything right, {fitterName}?</p>

        {warnings.length > 0 && (
          <div style={{ background: "#fff8e8", border: "1px solid #f39c12", borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#b7860b", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>⚠️ Please double-check</div>
            {warnings.map((w, i) => (
              <p key={i} style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#8a6d3b", margin: "4px 0" }}>• {w}</p>
            ))}
          </div>
        )}

        <div style={{ border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
          {record.entries.map((e, i) => (
            <div key={i} style={{ padding: "12px 14px", borderBottom: "1px solid #f5f2ed" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#1a1a1a", fontWeight: 500 }}>{e.day}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#C8A96E", fontWeight: 700 }}>{e.hours} hrs</span>
              </div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#555" }}>{e.siteName} <span style={{ color: "#aaa" }}>·</span> {e.client}</div>
              {entryAreas(e).length > 0 && <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", marginTop: 4 }}>{entryAreas(e).join(", ")}</div>}
              {(e.expenses || []).length > 0 && e.expenses.map((x, xi) => (
                <div key={xi} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", marginTop: 2 }}>💰 {x.description} — £{(x.amount || 0).toFixed(2)}</div>
              ))}
            </div>
          ))}
          <div style={{ padding: "10px 14px", background: "#1a1a1a", display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#fff" }}>Total{expTotalAll > 0 ? " (+ £" + expTotalAll.toFixed(2) + " expenses)" : ""}</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 14, color: "#C8A96E", fontWeight: 700 }}>{recTotal.toFixed(1)} hrs</span>
          </div>
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", border: `1px solid ${confirmedCorrect ? "#5a9" : "#e0dbd4"}`, borderRadius: 10, marginBottom: 14, cursor: "pointer", background: confirmedCorrect ? "#f2f9f5" : "#fff" }}>
          <input type="checkbox" checked={confirmedCorrect} onChange={e => setConfirmedCorrect(e.target.checked)} style={{ width: 20, height: 20, marginTop: 1, flex: "0 0 auto", accentColor: "#1a1a1a", cursor: "pointer" }} />
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#444", lineHeight: 1.5 }}>I confirm these hours are correct and match the days I actually worked.</span>
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <button onClick={() => { if (!submitting) { setConfirmData(null); setConfirmedCorrect(false); } }} disabled={submitting} style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, background: "none", border: "1px solid #e0dbd4", borderRadius: 8, padding: "12px", cursor: submitting ? "not-allowed" : "pointer", color: "#888", opacity: submitting ? 0.4 : 1 }}>Go back &amp; edit</button>
          <button onClick={confirmSubmit} disabled={!confirmedCorrect || submitting} style={{ ...btnStyle, marginTop: 0, opacity: (confirmedCorrect && !submitting) ? 1 : 0.5, cursor: (confirmedCorrect && !submitting) ? "pointer" : "not-allowed" }}>
            {submitting ? "Submitting…" : "Confirm & submit"}
          </button>
        </div>
        {submitting && <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#C8A96E", textAlign: "center", marginTop: 8 }}>Saving your hours — please wait, don't tap again.</p>}
        {!confirmedCorrect && !submitting && <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#bbb", textAlign: "center", marginTop: 8 }}>Tick the box above to submit.</p>}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, marginBottom: 2, color: "#1a1a1a" }}>Hi, {fitterName}</h2>
        </div>
        <button onClick={onLogout} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "none", border: "1px solid #e0dbd4", borderRadius: 6, padding: "5px 10px", cursor: "pointer", color: "#aaa", marginTop: 4 }}>Not you?</button>
      </div>

      {/* Prominent week banner */}
      <div style={{ background: "#1a1a1a", borderRadius: 10, padding: "12px 16px", marginBottom: 16, textAlign: "center" }}>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 3 }}>You are logging hours for</div>
        <div style={{ fontFamily: "'Playfair Display', serif", fontSize: 17, color: "#C8A96E", fontWeight: 600 }}>{getCurrentWeekLabel()}</div>
      </div>

      {/* Period-closing reminder */}
      {(() => {
        const start = getPeriodStart();
        const end = new Date(start); end.setDate(end.getDate() + 13); end.setHours(23, 59, 59, 999);
        const today = new Date();
        const daysLeft = Math.ceil((end - today) / (24 * 60 * 60 * 1000));
        if (daysLeft > 3 || daysLeft < 0) return null;
        const msg = daysLeft === 0 ? "This fortnight closes today — please get all your hours in." : daysLeft === 1 ? "This fortnight closes tomorrow — please get your hours in." : `This fortnight closes in ${daysLeft} days — don't leave your hours to the last minute.`;
        return (
          <div style={{ background: "#fdf0e8", border: "1px solid #e08a5a", borderRadius: 10, padding: "10px 14px", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>⏰</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#b5561f" }}>{msg}</span>
          </div>
        );
      })()}

      {/* Unsaved hours nudge */}
      {restoredDraft && (
        <div style={{ background: "#fff8e8", border: "1px solid #f39c12", borderRadius: 10, padding: "10px 14px", marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>📝</span>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#8a6d3b" }}>You have hours here you haven't submitted yet — don't forget to hit Review &amp; Submit when you're done.</span>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {entries.map((entry, i) => {
          const selectedSite = sites.find(s => s.id === entry.siteId);
          const expTotal = (entry.expenses || []).reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
          return (
            <div key={i} style={{ border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ background: "#f5f2ed", padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #e8e4de" }}>
                <select value={entry.date} onChange={e => {
                  const picked = periodDays.find(d => d.iso === e.target.value);
                  const updated = [...entries];
                  updated[i] = { ...updated[i], date: picked.iso, day: picked.dayName };
                  setEntries(updated);
                }} style={{ ...selectStyle, flex: "1 1 auto" }}>
                  <optgroup label="Week 1">
                    {periodDays.filter(d => d.week === 1).map(d => <option key={d.iso} value={d.iso}>{d.label}</option>)}
                  </optgroup>
                  <optgroup label="Week 2">
                    {periodDays.filter(d => d.week === 2).map(d => <option key={d.iso} value={d.iso}>{d.label}</option>)}
                  </optgroup>
                </select>
                <div style={{ flex: 1 }} />
                {entries.length > 1 && (
                  <button onClick={() => removeEntry(i)} style={{ ...removeBtn, border: "none", fontSize: 14 }}>✕ Remove</button>
                )}
              </div>

              <div style={{ padding: "14px" }}>
                {/* Site */}
                <label style={{ ...labelStyle, marginBottom: 4 }}>Site</label>
                <select value={entry.siteId} onChange={e => { const u = [...entries]; u[i] = { ...u[i], siteId: e.target.value, areas: [], areaDraft: "" }; setEntries(u); }} style={selectStyle}>
                  <option value="">— Select site —</option>
                  {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                {selectedSite && (
                  <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.08em" }}>Client:</span>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#C8A96E", fontWeight: 500 }}>{selectedSite.client}</span>
                  </div>
                )}

                {/* Hours */}
                <label style={{ ...labelStyle, marginTop: 14, marginBottom: 4 }}>Hours worked</label>
                <input value={entry.hours} onChange={e => updateEntry(i, "hours", e.target.value)}
                  placeholder="e.g. 7.5" type="number" min="0" max="24" step="0.5"
                  style={{ ...inputStyle, width: 120 }} />

                {/* Areas worked — free text, remembers what's been typed for this site */}
                <label style={{ ...labelStyle, marginTop: 14, marginBottom: 8 }}>Areas worked</label>
                {!entry.siteId ? (
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#bbb" }}>Pick a site first.</span>
                ) : (
                  <div>
                    {/* Already-added areas for this day */}
                    {(entry.areas || []).length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                        {entry.areas.map(a => (
                          <span key={a} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "6px 10px", borderRadius: 20, background: "#1a1a1a", color: "#fff" }}>
                            {a}
                            <button onClick={() => removeArea(i, a)} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1, opacity: 0.7 }}>×</button>
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Type an area + Add */}
                    <div style={{ display: "flex", gap: 8 }}>
                      <input value={entry.areaDraft || ""} onChange={e => updateEntry(i, "areaDraft", e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addArea(i); } }}
                        placeholder="e.g. Formal living, Entrance gallery…"
                        style={{ ...inputStyle, flex: 1, marginBottom: 0 }} />
                      <button onClick={() => addArea(i)} style={{ ...btnStyle, marginTop: 0, padding: "10px 16px", whiteSpace: "nowrap" }}>+ Add</button>
                    </div>
                    {/* Tap-suggestions from previous work at this site */}
                    {(() => {
                      const sugg = areaSuggestions(entry.siteId).filter(s => !(entry.areas || []).some(a => a.toLowerCase() === s.toLowerCase()));
                      if (sugg.length === 0) return null;
                      return (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#aaa", marginBottom: 6 }}>Used before on this job — tap to add:</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {sugg.map(s => (
                              <button key={s} onClick={() => addArea(i, s)}
                                style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "6px 12px", borderRadius: 20, border: "1px dashed #c9b896", background: "transparent", color: "#8a7a55", cursor: "pointer" }}>
                                + {s}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Expenses */}
                <div style={{ marginTop: 16, borderTop: "1px dashed #e8e4de", paddingTop: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                      Expenses {expTotal > 0 && <span style={{ color: "#C8A96E" }}>· £{expTotal.toFixed(2)}</span>}
                    </span>
                    <button onClick={() => addExpense(i)} style={{ ...addRowBtn, padding: "3px 10px", fontSize: 11 }}>+ Add</button>
                  </div>
                  {(entry.expenses || []).length === 0 && (
                    <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#bbb", margin: 0 }}>No expenses — tap above to add materials, travel, etc.</p>
                  )}
                  {(entry.expenses || []).map((exp, ei) => (
                    <div key={ei} style={{ marginBottom: 12, background: "#fafaf8", border: "1px solid #f0ece6", borderRadius: 8, padding: 10 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 28px", gap: 6, marginBottom: 8, alignItems: "center" }}>
                        <input value={exp.description} onChange={e => updateExpense(i, ei, "description", e.target.value)}
                          placeholder="e.g. Materials, Travel" style={{ ...inputStyle, fontSize: 12 }} />
                        <div style={{ position: "relative" }}>
                          <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#aaa" }}>£</span>
                          <input value={exp.amount} onChange={e => updateExpense(i, ei, "amount", e.target.value)}
                            placeholder="0.00" type="number" min="0" step="0.01"
                            style={{ ...inputStyle, fontSize: 12, paddingLeft: 22 }} />
                        </div>
                        <button onClick={() => removeExpense(i, ei)} style={{ background: "none", border: "1px solid #eee", borderRadius: 6, color: "#ccc", cursor: "pointer", fontSize: 14, height: 38, display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
                      </div>
                      {/* Receipt upload */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input type="file" accept="image/*,application/pdf,.pdf"
                          style={{ display: "none" }}
                          ref={el => { if (!fileRefs.current[`${i}-${ei}`]) fileRefs.current[`${i}-${ei}`] = el; fileRefs.current[`${i}-${ei}`] = el; }}
                          onChange={e => handleReceiptUpload(i, ei, e.target.files[0])} />
                        <button onClick={() => fileRefs.current[`${i}-${ei}`]?.click()}
                          style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "none", border: "1px dashed #e0dbd4", borderRadius: 6, padding: "5px 10px", cursor: "pointer", color: "#888", display: "flex", alignItems: "center", gap: 5 }}>
                          📎 {exp.receipt ? "Receipt attached ✓" : "Attach receipt (photo or file)"}
                        </button>
                        {exp.receipt && (
                          receiptIsPdf(exp.receipt)
                            ? <span onClick={() => openReceipt(exp.receipt)} title={receiptName(exp.receipt)} style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#888", border: "1px solid #e0dbd4", borderRadius: 4, padding: "6px 8px", cursor: "pointer" }}>📄 PDF</span>
                            : <img src={receiptSrc(exp.receipt)} alt="receipt" onClick={() => openReceipt(exp.receipt)} style={{ height: 36, width: 36, objectFit: "cover", borderRadius: 4, border: "1px solid #e0dbd4", cursor: "pointer" }} />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <button onClick={addEntry} style={{ ...addRowBtn, marginTop: 12, display: "block" }}>+ Add another day</button>

      {/* Running weekly total */}
      <div style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center", background: "#faf6ef", border: "1px solid #e8e4de", borderRadius: 8, padding: "10px 14px" }}>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.08em" }}>This fortnight so far</span>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 15, color: "#C8A96E", fontWeight: 700 }}>{runningTotal.toFixed(1)} hrs</span>
      </div>
      {submittedHours > 0 && (
        <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#aaa", marginTop: 6, marginBottom: 0, textAlign: "right" }}>
          {submittedHours.toFixed(1)} already submitted + {draftHours.toFixed(1)} below
        </p>
      )}

      {error && <p style={{ color: "#c0392b", fontFamily: "'DM Mono', monospace", fontSize: 12, marginTop: 16 }}>{error}</p>}
      <button onClick={buildAndConfirm} style={{ ...btnStyle, marginTop: 16, width: "100%" }}>Review & Submit</button>

      <MyPaySummary fitterName={fitterName} allEntries={allEntries || []} sites={sites} rates={rates || {}} />

      <MyWeekSubmissions
        fitterName={fitterName}
        allEntries={allEntries || []}
        lockedWeeks={lockedWeeks || []}
        sites={sites}
        onDeleteRecord={onDeleteRecord}
        onUpdateRecord={onUpdateRecord}
      />
    </div>
  );
}

// ---------- MY PAY (private to the logged-in fitter) ----------
function MyPaySummary({ fitterName, allEntries, sites, rates }) {
  const [show, setShow] = useState(false);
  const thisPeriod = getWeekKey();
  const siteMult = (siteName) => { const s = (sites || []).find(x => x.name === siteName); return s?.otMultiplier ?? 1.5; };

  // This fitter's entries for the current fortnight, grouped by site
  const mine = allEntries.filter(r => r.fitter === fitterName && r.weekKey === thisPeriod).flatMap(r => r.entries);
  if (mine.length === 0) return null;

  const bySite = {};
  mine.forEach(en => {
    let nh = en.normalHours, oh = en.overtimeHours;
    if (nh === undefined || oh === undefined) { const s = splitOvertime(en.day, en.hours || 0, en.date); nh = s.normal; oh = s.overtime; }
    if (!bySite[en.siteName]) bySite[en.siteName] = { site: en.siteName, normalHours: 0, overtimeHours: 0 };
    bySite[en.siteName].normalHours += (nh || 0);
    bySite[en.siteName].overtimeHours += (oh || 0);
  });

  let anyRate = false;
  const rows = Object.values(bySite).map(s => {
    const rk = `${fitterName}|||${s.site}`;
    const rate = parseFloat(rates[rk]?.fitter) || 0;
    if (rate > 0) anyRate = true;
    const mult = siteMult(s.site);
    const pay = s.normalHours * rate + s.overtimeHours * rate * mult;
    return { ...s, rate, mult, pay };
  });
  const totalPay = rows.reduce((a, r) => a + r.pay, 0);
  const totalHours = rows.reduce((a, r) => a + r.normalHours + r.overtimeHours, 0);

  return (
    <div style={{ marginTop: 28 }}>
      <button onClick={() => setShow(s => !s)} style={{ width: "100%", fontFamily: "'DM Mono', monospace", fontSize: 12, background: "#1a1a1a", border: "none", borderRadius: 8, padding: "12px 14px", cursor: "pointer", color: "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>{show ? "▲ Hide" : "▼ Show"} my pay this fortnight</span>
        <span style={{ color: "#C8A96E", fontWeight: 700 }}>{anyRate ? toGBP(totalPay) : `${totalHours.toFixed(1)} hrs`}</span>
      </button>
      {show && (
        <div style={{ marginTop: 10, border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden" }}>
          {!anyRate && (
            <div style={{ padding: "10px 14px", background: "#fff8e8", borderBottom: "1px solid #f1e2c0" }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#b7860b" }}>Your pay rate hasn't been set by Tom yet — showing hours only for now.</span>
            </div>
          )}
          {rows.map((r, i) => (
            <div key={i} style={{ padding: "10px 14px", borderBottom: "1px solid #f5f2ed" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#1a1a1a" }}>{r.site}</span>
                {anyRate && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#1a1a1a", fontWeight: 700 }}>{toGBP(r.pay)}</span>}
              </div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888" }}>
                {r.normalHours > 0 && <span>{r.normalHours.toFixed(1)} hrs normal{r.rate > 0 ? ` @ £${r.rate.toFixed(2)}` : ""}</span>}
                {r.overtimeHours > 0 && <span>{r.normalHours > 0 ? "  ·  " : ""}<span style={{ color: "#b7860b" }}>{r.overtimeHours.toFixed(1)} hrs OT {r.mult}×{r.rate > 0 ? ` @ £${(r.rate * r.mult).toFixed(2)}` : ""}</span></span>}
              </div>
            </div>
          ))}
          <div style={{ padding: "10px 14px", background: "#faf6ef", display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888" }}>Total ({totalHours.toFixed(1)} hrs)</span>
            {anyRate && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 14, color: "#C8A96E", fontWeight: 700 }}>{toGBP(totalPay)}</span>}
          </div>
          <div style={{ padding: "8px 14px", background: "#fff" }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#bbb" }}>Estimate based on submitted hours. Final pay is confirmed by Tom.</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- MY WEEK SUBMISSIONS (fitter self-service) ----------
function MyWeekSubmissions({ fitterName, allEntries, lockedWeeks, sites, onDeleteRecord, onUpdateRecord }) {
  const [editingId, setEditingId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const thisWeek = getWeekKey();
  const locked = lockedWeeks.includes(thisWeek);

  // Match by name so it works across devices and cache clears
  const allMine = allEntries.filter(r => r.fitter === fitterName);
  const mine = allMine.filter(r => r.weekKey === thisWeek);
  const past = allMine.filter(r => r.weekKey !== thisWeek).sort((a, b) => b.weekKey.localeCompare(a.weekKey));

  if (allMine.length === 0) return null;

  // Group past records by week for the read-only history
  const pastByWeek = {};
  past.forEach(r => { if (!pastByWeek[r.weekKey]) pastByWeek[r.weekKey] = { label: r.weekLabel, records: [] }; pastByWeek[r.weekKey].records.push(r); });

  return (
    <div style={{ marginTop: 32, borderTop: "1px solid #e8e4de", paddingTop: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 18, color: "#1a1a1a", margin: 0 }}>My submissions this fortnight</h3>
      </div>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", marginTop: 4, marginBottom: 16 }}>
        {mine.length === 0 ? "You haven't submitted anything this fortnight yet." : locked ? "This fortnight has been invoiced and can no longer be changed. Speak to Tom if something's wrong." : "You can fix or remove anything you submitted this fortnight, until Tom invoices it."}
      </p>

      {mine.map(record => (
        editingId === record.id ? (
          <EditSubmission
            key={record.id}
            record={record}
            sites={sites}
            allEntries={allEntries}
            onSave={async (updated) => { await onUpdateRecord(record.id, updated); setEditingId(null); }}
            onCancel={() => setEditingId(null)}
          />
        ) : (
          <div key={record.id} style={{ marginBottom: 12, border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden" }}>
            <div style={{ padding: "10px 14px", background: "#f5f2ed", borderBottom: "1px solid #e8e4de", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888" }}>Submitted {new Date(record.submittedAt).toLocaleDateString("en-GB")} · {record.entries.reduce((a,e)=>a+(e.hours||0),0).toFixed(1)} hrs</span>
              {locked ? (
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, background: "#f0ece6", color: "#999", borderRadius: 6, padding: "4px 10px" }}>🔒 Invoiced</span>
              ) : (
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setEditingId(record.id)} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "none", border: "1px solid #e0dbd4", borderRadius: 6, padding: "4px 10px", cursor: "pointer", color: "#888" }}>Edit</button>
                  <button onClick={() => setConfirmDeleteId(record.id)} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "none", border: "1px solid #f5c6cb", borderRadius: 6, padding: "4px 10px", cursor: "pointer", color: "#c0392b" }}>Delete</button>
                </div>
              )}
            </div>
            {confirmDeleteId === record.id && (
              <div style={{ padding: "12px 14px", background: "#fff5f5", borderBottom: "1px solid #f5c6cb", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#c0392b" }}>Delete this submission?</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setConfirmDeleteId(null)} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "none", border: "1px solid #ddd", borderRadius: 6, padding: "5px 12px", cursor: "pointer", color: "#888" }}>Cancel</button>
                  <button onClick={async () => { await onDeleteRecord(record.id); setConfirmDeleteId(null); }} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "#c0392b", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", color: "#fff" }}>Yes, delete</button>
                </div>
              </div>
            )}
            {record.entries.map((entry, i) => (
              <div key={i} style={{ padding: "9px 14px", borderBottom: "1px solid #f5f2ed", display: "grid", gridTemplateColumns: "70px 1fr 50px", gap: 8 }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa" }}>{entry.day?.slice(0,3)}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#555" }}>{entry.siteName}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#1a1a1a", textAlign: "right" }}>{entry.hours}h</span>
              </div>
            ))}
          </div>
        )
      ))}

      {/* Read-only past history */}
      {Object.keys(pastByWeek).length > 0 && (
        <div style={{ marginTop: 20 }}>
          <button onClick={() => setShowHistory(h => !h)} style={{ width: "100%", fontFamily: "'DM Mono', monospace", fontSize: 12, background: "none", border: "1px solid #e0dbd4", borderRadius: 8, padding: "10px 14px", cursor: "pointer", color: "#888", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{showHistory ? "▲ Hide" : "▼ Show"} my past weeks ({Object.keys(pastByWeek).length})</span>
            <span style={{ color: "#bbb" }}>read-only</span>
          </button>
          {showHistory && (
            <div style={{ marginTop: 12 }}>
              {Object.entries(pastByWeek).map(([wk, data]) => {
                const weekHours = data.records.flatMap(r => r.entries).reduce((a, e) => a + (e.hours || 0), 0);
                return (
                  <div key={wk} style={{ marginBottom: 12, border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ padding: "9px 14px", background: "#fafaf8", borderBottom: "1px solid #e8e4de", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888" }}>{data.label}</span>
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#C8A96E", fontWeight: 700 }}>{weekHours.toFixed(1)} hrs</span>
                    </div>
                    {data.records.flatMap(r => r.entries.map((entry, i) => (
                      <div key={`${r.id}-${i}`} style={{ padding: "8px 14px", borderBottom: "1px solid #f5f2ed", display: "grid", gridTemplateColumns: "70px 1fr 1fr 45px", gap: 8 }}>
                        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa" }}>{entry.day?.slice(0,3)}</span>
                        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#555" }}>{entry.siteName}</span>
                        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#C8A96E" }}>{entry.client}</span>
                        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#1a1a1a", textAlign: "right" }}>{entry.hours}h</span>
                      </div>
                    )))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- ADMIN LOGIN ----------
function AdminLogin({ onLogin }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const attempt = () => pw === ADMIN_PASSWORD ? onLogin() : setErr(true);
  return (
    <div>
      <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, marginBottom: 24, color: "#1a1a1a" }}>Admin Login</h2>
      <label style={labelStyle}>Password</label>
      <input type="password" value={pw} onChange={e => { setPw(e.target.value); setErr(false); }}
        onKeyDown={e => e.key === "Enter" && attempt()}
        placeholder="Enter password"
        style={{ ...inputStyle, borderColor: err ? "#c0392b" : undefined }} />
      {err && <p style={{ color: "#c0392b", fontFamily: "'DM Mono', monospace", fontSize: 12, marginTop: 8 }}>Incorrect password.</p>}
      <button onClick={attempt} style={{ ...btnStyle, marginTop: 20 }}>Log In</button>
    </div>
  );
}

// ---------- ADMIN DASHBOARD ----------
function AdminDashboard({ allEntries, sites, rates, lockedWeeks, fittersList, pins, noIndigo, billedJobs, onToggleBilledJob, extraDays, onToggleExtraDay, onSitesChange, onRatesChange, onDeleteRecord, onUpdateRecord, onToggleLock, onFittersChange, onResetPin, onToggleIndigo, onLogout }) {
  const [tab, setTab] = useState("submissions");
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, color: "#1a1a1a", margin: 0 }}>Admin</h2>
        <button onClick={onLogout} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "none", border: "1px solid #ddd", borderRadius: 6, padding: "6px 12px", cursor: "pointer", color: "#888" }}>Log out</button>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 24, background: "#f5f2ed", borderRadius: 8, padding: 4 }}>
        {[["submissions", "Timesheets"], ["report", "Invoices"], ["earnings", "Earnings"], ["rates", "Rates"], ["fitters", "Fitters"], ["sites", "Sites"]].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            flex: 1, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "8px 0",
            border: "none", borderRadius: 6, cursor: "pointer",
            background: tab === key ? "#1a1a1a" : "transparent",
            color: tab === key ? "#fff" : "#888"
          }}>{label}</button>
        ))}
      </div>
      {tab === "submissions" && <SubmissionsTab allEntries={allEntries} sites={sites} lockedWeeks={lockedWeeks} fittersList={fittersList} onDeleteRecord={onDeleteRecord} onUpdateRecord={onUpdateRecord} />}
      {tab === "report" && <InvoicesTab allEntries={allEntries} rates={rates} sites={sites} lockedWeeks={lockedWeeks} noIndigo={noIndigo} billedJobs={billedJobs} onToggleBilledJob={onToggleBilledJob} extraDays={extraDays} onToggleExtraDay={onToggleExtraDay} onToggleLock={onToggleLock} />}
      {tab === "earnings" && <EarningsTab allEntries={allEntries} rates={rates} sites={sites} noIndigo={noIndigo} billedJobs={billedJobs} extraDays={extraDays} />}
      {tab === "rates" && <RatesTab allEntries={allEntries} rates={rates} fittersList={fittersList} sites={sites} onRatesChange={onRatesChange} />}
      {tab === "fitters" && <FittersTab fittersList={fittersList} allEntries={allEntries} pins={pins} noIndigo={noIndigo} onFittersChange={onFittersChange} onResetPin={onResetPin} onToggleIndigo={onToggleIndigo} />}
      {tab === "sites" && <SitesTab sites={sites} onSitesChange={onSitesChange} />}
    </div>
  );
}

// ---------- FITTERS TAB ----------
function FittersTab({ fittersList, allEntries, pins, noIndigo, onFittersChange, onResetPin, onToggleIndigo }) {
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");

  const list = [...(fittersList || [])].sort((a, b) => a.localeCompare(b));
  // Names that appear in submissions but aren't on the list (e.g. from before this feature)
  const submittedNames = [...new Set(allEntries.map(e => e.fitter).filter(Boolean))];
  const unlisted = submittedNames.filter(n => !(fittersList || []).includes(n)).sort((a, b) => a.localeCompare(b));

  const addFitter = async (name) => {
    const n = (name || "").trim();
    if (!n) { setError("Enter a name."); return; }
    if ((fittersList || []).some(f => f.toLowerCase() === n.toLowerCase())) { setError("That name is already on the list."); return; }
    await onFittersChange([...(fittersList || []), n]);
    setNewName(""); setError("");
  };
  const removeFitter = async (name) => {
    await onFittersChange((fittersList || []).filter(f => f !== name));
  };

  return (
    <div>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", marginBottom: 20 }}>
        Add each fitter here. They'll pick their name from this list when they open the app, so there are no typos and their hours always stay under one name.
      </p>

      <div style={{ background: "#f5f2ed", borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Add Fitter</div>
        <label style={labelStyle}>Full Name</label>
        <input value={newName} onChange={e => { setNewName(e.target.value); setError(""); }}
          onKeyDown={e => e.key === "Enter" && addFitter(newName)}
          placeholder="e.g. Daniel Frost" style={inputStyle} />
        {error && <p style={{ color: "#c0392b", fontFamily: "'DM Mono', monospace", fontSize: 12, marginTop: 8, marginBottom: 0 }}>{error}</p>}
        <button onClick={() => addFitter(newName)} style={{ ...btnStyle, marginTop: 12, padding: "10px 18px" }}>+ Add Fitter</button>
      </div>

      {unlisted.length > 0 && (
        <div style={{ background: "#fff8e8", border: "1px solid #f39c12", borderRadius: 10, padding: 14, marginBottom: 20 }}>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#b7860b", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Names already in timesheets, not on the list</div>
          <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#8a6d3b", marginTop: 0, marginBottom: 12 }}>These names have submitted before. Tap to add them to the list so they can log in and keep their history.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {unlisted.map(n => (
              <button key={n} onClick={() => addFitter(n)} style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, background: "#fff", border: "1px solid #f39c12", borderRadius: 20, padding: "6px 12px", cursor: "pointer", color: "#b7860b" }}>+ {n}</button>
            ))}
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <p style={{ textAlign: "center", fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#bbb", padding: "24px 0" }}>No fitters added yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map(f => (
            <div key={f} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", border: "1px solid #e8e4de", borderRadius: 8, background: "#fff" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#1a1a1a" }}>{f}</span>
                {pins && pins[f]
                  ? <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#5a9", background: "#eef7f2", borderRadius: 5, padding: "2px 7px" }}>🔒 PIN set</span>
                  : <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#b7860b", background: "#fff8e8", borderRadius: 5, padding: "2px 7px" }}>no PIN yet</span>}
                <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }} title="Tick if this person is not paid through Indigo (e.g. Tom). Their hours still appear on the client invoice.">
                  <input type="checkbox" checked={(noIndigo || []).includes(f)} onChange={() => onToggleIndigo(f)} style={{ width: 15, height: 15, accentColor: "#1a1a1a", cursor: "pointer" }} />
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: (noIndigo || []).includes(f) ? "#1a1a1a" : "#bbb" }}>Not paid via Indigo</span>
                </label>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {pins && pins[f] && (
                  <button onClick={() => { if (confirm(`Reset ${f}'s PIN? They'll set a new one next time they log in.`)) onResetPin(f); }} style={{ background: "none", border: "1px solid #e0dbd4", borderRadius: 6, padding: "4px 10px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", cursor: "pointer" }}>Reset PIN</button>
                )}
                <button onClick={() => removeFitter(f)} style={{ background: "none", border: "1px solid #eee", borderRadius: 6, padding: "4px 10px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa", cursor: "pointer" }}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- RATES TAB ----------
function RatesTab({ allEntries, rates, fittersList, sites, onRatesChange }) {
  const [edits, setEdits] = useState({});
  const [saved, setSaved] = useState(false);
  const [addFitter, setAddFitter] = useState("");
  const [addSite, setAddSite] = useState("");
  const [manualPairs, setManualPairs] = useState([]); // pairs added this session via picker
  const [pickError, setPickError] = useState("");

  // Which fitters have actually submitted hours (so we never lose rates needed by old invoices)
  const fittersWithHistory = new Set(allEntries.map(r => r.fitter));
  const roster = new Set(fittersList || []);

  // Build the pairs to show
  const pairs = [];
  const seen = new Set();
  const addPair = (fitter, site) => {
    const key = `${fitter}|||${site}`;
    if (seen.has(key)) return;
    // Hide pairings for fitters who've been removed AND never submitted anything
    if (!roster.has(fitter) && !fittersWithHistory.has(fitter)) return;
    seen.add(key);
    pairs.push({ fitter, site, former: !roster.has(fitter) });
  };
  // From submissions
  allEntries.forEach(record => {
    record.entries.forEach(en => addPair(record.fitter, en.siteName));
  });
  // From saved rates (so pre-set ones persist after refresh)
  Object.keys(rates || {}).forEach(key => {
    const [fitter, site] = key.split("|||");
    if (fitter && site) addPair(fitter, site);
  });
  // Added this session via the picker
  manualPairs.forEach(({ fitter, site }) => addPair(fitter, site));

  // Clean up any saved rates belonging to removed fitters with no history
  const staleKeys = Object.keys(rates || {}).filter(key => {
    const [fitter] = key.split("|||");
    return fitter && !roster.has(fitter) && !fittersWithHistory.has(fitter);
  });
  useEffect(() => {
    if (staleKeys.length === 0) return;
    const cleaned = { ...rates };
    staleKeys.forEach(k => delete cleaned[k]);
    onRatesChange(cleaned);
  }, [staleKeys.join("|")]);

  const removeRate = async (fitter, site) => {
    const key = `${fitter}|||${site}`;
    const cleaned = { ...rates };
    delete cleaned[key];
    setManualPairs(prev => prev.filter(p => !(p.fitter === fitter && p.site === site)));
    await onRatesChange(cleaned);
  };

  // Sort for a tidy table
  pairs.sort((a, b) => a.fitter.localeCompare(b.fitter) || a.site.localeCompare(b.site));

  const getClientRate = (fitter, site) => {
    const key = `${fitter}|||${site}`;
    if (edits[key]?.client !== undefined) return edits[key].client;
    return rates[key]?.client ?? "";
  };
  const getFitterRate = (fitter, site) => {
    const key = `${fitter}|||${site}`;
    if (edits[key]?.fitter !== undefined) return edits[key].fitter;
    return rates[key]?.fitter ?? "";
  };
  const setEdit = (fitter, site, field, val) => {
    const key = `${fitter}|||${site}`;
    setEdits(prev => ({ ...prev, [key]: { ...(prev[key] || {}), [field]: val } }));
    setSaved(false);
  };
  const saveAll = async () => {
    const merged = { ...rates };
    Object.entries(edits).forEach(([key, vals]) => {
      merged[key] = {
        client: parseFloat(vals.client ?? rates[key]?.client ?? 0) || 0,
        fitter: parseFloat(vals.fitter ?? rates[key]?.fitter ?? 0) || 0,
      };
    });
    await onRatesChange(merged);
    setEdits({});
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const addManualPair = () => {
    setPickError("");
    if (!addFitter || !addSite) { setPickError("Pick both a fitter and a site."); return; }
    const key = `${addFitter}|||${addSite}`;
    if (seen.has(key)) { setPickError("That fitter + site already has a row below."); return; }
    setManualPairs(prev => [...prev, { fitter: addFitter, site: addSite }]);
    setAddFitter(""); setAddSite("");
  };

  const fitterOptions = [...(fittersList || [])].sort((a, b) => a.localeCompare(b));
  const siteOptions = [...(sites || [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", marginBottom: 16 }}>
        Set two rates per fitter per site: what you charge the client, and what you pay the fitter. You can set these up front — before a fitter has logged any hours.
      </p>

      {/* Add / pre-set a rate row */}
      <div style={{ background: "#f5f2ed", borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Add a rate</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "end" }}>
          <div>
            <label style={labelStyle}>Fitter</label>
            <select value={addFitter} onChange={e => { setAddFitter(e.target.value); setPickError(""); }} style={selectStyle}>
              <option value="">— Select —</option>
              {fitterOptions.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Site</label>
            <select value={addSite} onChange={e => { setAddSite(e.target.value); setPickError(""); }} style={selectStyle}>
              <option value="">— Select —</option>
              {siteOptions.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
            </select>
          </div>
          <button onClick={addManualPair} style={{ ...btnStyle, marginTop: 0, padding: "10px 16px", whiteSpace: "nowrap" }}>+ Add</button>
        </div>
        {pickError && <p style={{ color: "#c0392b", fontFamily: "'DM Mono', monospace", fontSize: 12, marginTop: 8, marginBottom: 0 }}>{pickError}</p>}
        {(fitterOptions.length === 0 || siteOptions.length === 0) && (
          <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#b7860b", marginTop: 8, marginBottom: 0 }}>
            {fitterOptions.length === 0 ? "Add fitters in the Fitters tab first. " : ""}{siteOptions.length === 0 ? "Add sites in the Sites tab first." : ""}
          </p>
        )}
      </div>

      {pairs.length === 0 ? (
        <p style={{ textAlign: "center", fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#bbb", padding: "24px 0" }}>
          No rates yet. Use “Add a rate” above to set one up.
        </p>
      ) : (
        <>
          <div style={{ border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ background: "#1a1a1a", padding: "10px 14px", display: "grid", gridTemplateColumns: "1fr 1fr 100px 100px 32px", gap: 10 }}>
              {["Fitter", "Site", "Client Rate £/hr", "Fitter Rate £/hr", ""].map((h, i) => (
                <span key={i} style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#C8A96E", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</span>
              ))}
            </div>
            {pairs.map(({ fitter, site, former }) => (
              <div key={`${fitter}|||${site}`} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 100px 100px 32px", gap: 10, padding: "10px 14px", borderBottom: "1px solid #f5f2ed", alignItems: "center", background: former ? "#fafaf8" : "transparent" }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: former ? "#999" : "#1a1a1a" }}>
                  {fitter}
                  {former && <span style={{ fontSize: 9, color: "#b7860b", background: "#fff8e8", borderRadius: 4, padding: "1px 5px", marginLeft: 6 }}>former</span>}
                </span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888" }}>{site}</span>
                {(sites || []).find(s => s.name === site)?.pricing === "fixed" ? (
                  <span title="This job is billed at a fixed price, so there's no hourly client rate."
                    style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#1a6f4b", background: "#eaf6f0", borderRadius: 5, padding: "5px 6px", textAlign: "center" }}>Fixed price</span>
                ) : (
                  <div style={{ position: "relative" }}>
                    <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa" }}>£</span>
                    <input value={getClientRate(fitter, site)} onChange={e => setEdit(fitter, site, "client", e.target.value)}
                      type="number" min="0" step="0.5" placeholder="0.00"
                      style={{ ...inputStyle, paddingLeft: 20, fontSize: 12 }} />
                  </div>
                )}
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa" }}>£</span>
                  <input value={getFitterRate(fitter, site)} onChange={e => setEdit(fitter, site, "fitter", e.target.value)}
                    type="number" min="0" step="0.5" placeholder="0.00"
                    style={{ ...inputStyle, paddingLeft: 20, fontSize: 12 }} />
                </div>
                <button
                  onClick={() => { if (window.confirm(`Remove the rate for ${fitter} at ${site}?`)) removeRate(fitter, site); }}
                  title="Remove this rate"
                  style={{ background: "none", border: "1px solid #eee", borderRadius: 6, color: "#ccc", cursor: "pointer", fontSize: 15, lineHeight: 1, height: 32, width: 32 }}>×</button>
              </div>
            ))}
          </div>
          {pairs.some(p => p.former) && (
            <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#b7860b", marginTop: 0, marginBottom: 12 }}>
              “Former” fitters have been removed from the Fitters list but still have submitted hours. Their rates are kept so past invoices stay correct.
            </p>
          )}
          <button onClick={saveAll} style={{ ...btnStyle, marginTop: 0, padding: "11px 24px", background: saved ? "#2ecc71" : "#1a1a1a" }}>
            {saved ? "✓ Saved!" : "Save All Rates"}
          </button>
        </>
      )}
    </div>
  );
}

// ---------- EARNINGS TAB ----------
function EarningsTab({ allEntries, rates, sites, noIndigo, billedJobs, extraDays }) {
  const [view, setView] = useState("period"); // "period" | "client" | "fitter"

  const siteMult = (siteName) => { const s = (sites || []).find(x => x.name === siteName); return s?.otMultiplier ?? 1.5; };
  const siteByName = (name) => (sites || []).find(x => x.name === name);
  const isFixedSite = (name) => siteByName(name)?.pricing === "fixed";
  const excluded = new Set(noIndigo || []);

  // Build one profit line per fitter+site+period from every submission
  const rows = [];
  allEntries.forEach(record => {
    const period = record.weekKey;
    record.entries.forEach(en => {
      let nh = en.normalHours, oh = en.overtimeHours;
      if (nh === undefined || oh === undefined) { const s = splitOvertime(en.day, en.hours || 0, en.date); nh = s.normal; oh = s.overtime; }
      const rk = `${record.fitter}|||${en.siteName}`;
      const fixed = isFixedSite(en.siteName);
      const dayKey = `${record.id}::${en.date}::${en.siteId}`;
      const isExtra = fixed && !!(extraDays || {})[dayKey];
      // Hourly job → charge hourly. Fixed job → charge only flagged extra days hourly (fixed price added separately).
      const cr = (!fixed || isExtra) ? (parseFloat(rates[rk]?.client) || 0) : 0;
      const fr = parseFloat(rates[rk]?.fitter) || 0;
      const mult = siteMult(en.siteName);
      const charged = nh * cr + oh * cr * mult;
      // Tom (excluded from Indigo) has no payout, so all his charged time is margin
      const paid = excluded.has(record.fitter) ? 0 : (nh * fr + oh * fr * mult);
      rows.push({ period, fitter: record.fitter, client: en.client, site: en.siteName, charged, paid, profit: charged - paid, hours: nh + oh });
    });
  });

  // Fixed-price revenue lands in the period it was billed. Not attributable to a fitter.
  const billed = billedJobs || {};
  (sites || []).filter(s => s.pricing === "fixed").forEach(s => {
    const period = billed[s.id];
    if (!period) return; // not billed yet — no revenue counted
    const price = s.jobPrice || 0;
    rows.push({ period, fitter: "Fixed price job", client: s.client, site: s.name, charged: price, paid: 0, profit: price, hours: 0 });
  });
  const hasFixed = (sites || []).some(s => s.pricing === "fixed");

  const sum = (arr, key) => arr.reduce((a, r) => a + (r[key] || 0), 0);
  const totalCharged = sum(rows, "charged");
  const totalPaid = sum(rows, "paid");
  const totalProfit = totalCharged - totalPaid;

  // This calendar month
  const now = new Date();
  const monthRows = rows.filter(r => { const d = new Date(r.period + "T00:00:00"); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
  const monthProfit = sum(monthRows, "charged") - sum(monthRows, "paid");

  // Group helper
  const groupBy = (key) => {
    const g = {};
    rows.forEach(r => {
      const k = r[key] || "—";
      if (!g[k]) g[k] = { key: k, charged: 0, paid: 0, profit: 0, hours: 0 };
      g[k].charged += r.charged; g[k].paid += r.paid; g[k].profit += r.profit; g[k].hours += r.hours;
    });
    return Object.values(g);
  };

  let grouped;
  if (view === "period") grouped = groupBy("period").sort((a, b) => b.key.localeCompare(a.key));
  else if (view === "client") grouped = groupBy("client").sort((a, b) => b.profit - a.profit);
  else grouped = groupBy("fitter").sort((a, b) => b.profit - a.profit);

  const labelFor = (k) => view === "period" ? periodLabel(k) : k;
  function periodLabel(wk) {
    if (!wk) return "—";
    const start = new Date(wk + "T00:00:00"); const end = new Date(start); end.setDate(end.getDate() + 13);
    return `${start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${end.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
  }

  if (rows.length === 0) {
    return <p style={{ textAlign: "center", fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#bbb", padding: "40px 0" }}>No earnings to show yet — they'll appear once fitters submit hours and rates are set.</p>;
  }

  const money = (n) => (n < 0 ? "-" : "") + "£" + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return (
    <div>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", marginBottom: 16 }}>
        Your margin = what clients are charged minus what fitters are paid via Indigo. Expenses are pass-through and not counted. Estimates based on submitted hours and current rates.
      </p>
      {hasFixed && (
        <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#b7860b", background: "#fff8e8", border: "1px solid #f0e0b8", borderRadius: 8, padding: "9px 12px", marginTop: -6, marginBottom: 16 }}>
          Fixed-price jobs: the job price counts in the fortnight you billed it, while the fitters&apos; hours cost you every fortnight they work. So a single period can look unusually high or low — the all-time figure is the true picture. Fixed-price revenue isn&apos;t tied to a fitter, so it appears as &ldquo;Fixed price job&rdquo; in the By fitter view.
        </p>
      )}

      {/* Headline cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        <div style={{ background: "#1a1a1a", borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Profit — all time</div>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 22, color: "#C8A96E", fontWeight: 700 }}>{money(totalProfit)}</div>
        </div>
        <div style={{ background: "#faf6ef", border: "1px solid #e8e4de", borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>Profit — this month</div>
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 22, color: "#1a1a1a", fontWeight: 700 }}>{money(monthProfit)}</div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 18, padding: "10px 14px", background: "#f5f2ed", borderRadius: 8, marginBottom: 18 }}>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888" }}>Charged: <strong style={{ color: "#1a1a1a" }}>{money(totalCharged)}</strong></span>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888" }}>Paid out: <strong style={{ color: "#1a1a1a" }}>{money(totalPaid)}</strong></span>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888" }}>Margin: <strong style={{ color: "#5a9" }}>{totalCharged > 0 ? Math.round((totalProfit / totalCharged) * 100) : 0}%</strong></span>
      </div>

      {/* View toggle */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {[["period", "By period"], ["client", "By client"], ["fitter", "By fitter"]].map(([k, lbl]) => (
          <button key={k} onClick={() => setView(k)} style={{
            fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "7px 12px", borderRadius: 7, cursor: "pointer",
            border: `1px solid ${view === k ? "#1a1a1a" : "#e0dbd4"}`, background: view === k ? "#1a1a1a" : "transparent",
            color: view === k ? "#fff" : "#888" }}>{lbl}</button>
        ))}
      </div>

      {/* Breakdown table */}
      <div style={{ border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden" }}>
        <div style={{ background: "#1a1a1a", padding: "9px 14px", display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", gap: 8 }}>
          {[view === "period" ? "Period" : view === "client" ? "Client" : "Fitter", "Charged", "Paid", "Profit"].map((h, i) => (
            <span key={i} style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#C8A96E", textTransform: "uppercase", letterSpacing: "0.06em", textAlign: i === 0 ? "left" : "right" }}>{h}</span>
          ))}
        </div>
        {grouped.map((g, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", gap: 8, padding: "10px 14px", borderBottom: "1px solid #f5f2ed", alignItems: "center" }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#1a1a1a" }}>{labelFor(g.key)}</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", textAlign: "right" }}>{money(g.charged)}</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", textAlign: "right" }}>{money(g.paid)}</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: g.profit >= 0 ? "#1a9c5a" : "#c0392b", textAlign: "right", fontWeight: 700 }}>{money(g.profit)}</span>
          </div>
        ))}
      </div>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#bbb", marginTop: 10 }}>
        Where a rate hasn't been set, that line counts as £0 — set rates in the Rates tab for an accurate figure.
      </p>
    </div>
  );
}

// ---------- INVOICES TAB ----------
function InvoicesTab({ allEntries, rates, sites, lockedWeeks, noIndigo, billedJobs, onToggleBilledJob, extraDays, onToggleExtraDay, onToggleLock }) {
  const weeks = [...new Set(allEntries.map(e => e.weekKey))].sort().reverse();
  const clients = [...new Set(allEntries.flatMap(e => e.entries.map(en => en.client)).filter(Boolean))].sort();
  const [filterWeek, setFilterWeek] = useState(weeks[0] || "all");
  const [filterClient, setFilterClient] = useState("all");
  const [invoiceNum, setInvoiceNum] = useState("FFL001");
  const [invoiceDate, setInvoiceDate] = useState(new Date().toLocaleDateString("en-GB"));
  const [dueDate, setDueDate] = useState(() => { const d = new Date(); d.setDate(d.getDate() + 7); return d.toLocaleDateString("en-GB"); });
  const [activeDoc, setActiveDoc] = useState("client"); // "client" | "indigo"

  const filtered = allEntries.filter(record => {
    if (filterWeek !== "all" && record.weekKey !== filterWeek) return false;
    if (filterClient !== "all" && !record.entries.some(en => en.client === filterClient)) return false;
    return true;
  });

  // Build aggregated fitter+site totals, splitting normal vs overtime hours
  const siteMult = (siteName) => {
    const s = (sites || []).find(x => x.name === siteName);
    return s?.otMultiplier ?? 1.5;
  };
  const fitterSiteTotals = {};
  filtered.forEach(record => {
    const entries = filterClient === "all" ? record.entries : record.entries.filter(en => en.client === filterClient);
    entries.forEach(en => {
      const key = `${record.fitter}|||${en.siteName}|||${en.client}`;
      if (!fitterSiteTotals[key]) fitterSiteTotals[key] = { fitter: record.fitter, site: en.siteName, client: en.client, normalHours: 0, overtimeHours: 0, expenses: [] };
      // Use stored split if present, else derive from day (back-compat with old entries)
      let nh = en.normalHours, oh = en.overtimeHours;
      if (nh === undefined || oh === undefined) {
        const s = splitOvertime(en.day, en.hours || 0, en.date); nh = s.normal; oh = s.overtime;
      }
      fitterSiteTotals[key].normalHours += (nh || 0);
      fitterSiteTotals[key].overtimeHours += (oh || 0);
      (en.expenses || []).forEach(exp => fitterSiteTotals[key].expenses.push(exp));
    });
  });

  const siteByName = (name) => (sites || []).find(x => x.name === name);
  const isFixedSite = (name) => siteByName(name)?.pricing === "fixed";

  const lines = Object.values(fitterSiteTotals).map(({ fitter, site, client, normalHours, overtimeHours, expenses }) => {
    const rateKey = `${fitter}|||${site}`;
    const fixed = isFixedSite(site);
    // On fixed-price jobs the client isn't charged per hour — but fitters are still paid hourly.
    const clientRate = fixed ? 0 : (parseFloat(rates[rateKey]?.client) || 0);
    const fitterRate = parseFloat(rates[rateKey]?.fitter) || 0;
    const mult = siteMult(site);
    const otClientRate = clientRate * mult;
    const otFitterRate = fitterRate * mult;
    const hours = normalHours + overtimeHours;
    const expTotal = expenses.reduce((a, e) => a + (e.amount || 0), 0);
    const clientCost = fixed ? 0 : (normalHours * clientRate + overtimeHours * otClientRate);
    const fitterCost = normalHours * fitterRate + overtimeHours * otFitterRate;
    return { fitter, site, client, hours, normalHours, overtimeHours, mult, clientRate, fitterRate, otClientRate, otFitterRate, clientCost, fitterCost, expTotal, expenses, fixed };
  });

  // Hourly lines only appear on the client invoice; fixed-price jobs are billed as one line.
  const hourlyLines = lines.filter(l => !l.fixed);

  // Fixed-price jobs relevant to this invoice: this client's fixed sites that either have
  // work logged in this period, or were already marked as billed in this period.
  const fixedJobs = (sites || [])
    .filter(s => s.pricing === "fixed")
    .filter(s => filterClient === "all" || s.client === filterClient)
    .map(s => {
      const workedThisPeriod = allEntries.some(r => r.weekKey === filterWeek && r.entries.some(en => en.siteId === s.id));
      const billedIn = (billedJobs || {})[s.id] || null;
      return { site: s, workedThisPeriod, billedIn, billedHere: billedIn === filterWeek };
    })
    .filter(j => j.workedThisPeriod || j.billedHere);

  const billedFixedTotal = fixedJobs.filter(j => j.billedHere).reduce((a, j) => a + (j.site.jobPrice || 0), 0);

  // EXTRAS on fixed-price jobs: individual days Tom flags as chargeable (variations/extra works).
  // These are billed hourly ON TOP of the fixed price, and appear on the client timesheet.
  const dayKeyOf = (recordId, en) => `${recordId}::${en.date}::${en.siteId}`;
  const extraLines = [];
  filtered.forEach(record => {
    const entries = filterClient === "all" ? record.entries : record.entries.filter(en => en.client === filterClient);
    entries.forEach(en => {
      if (!isFixedSite(en.siteName)) return;              // only fixed jobs have "extras"
      if (!(extraDays || {})[dayKeyOf(record.id, en)]) return; // only days Tom flagged
      let nh = en.normalHours, oh = en.overtimeHours;
      if (nh === undefined || oh === undefined) { const s = splitOvertime(en.day, en.hours || 0, en.date); nh = s.normal; oh = s.overtime; }
      const rateKey = `${record.fitter}|||${en.siteName}`;
      const cr = parseFloat(rates[rateKey]?.client) || 0;
      const mult = siteMult(en.siteName);
      const cost = nh * cr + oh * cr * mult;
      extraLines.push({ fitter: record.fitter, site: en.siteName, client: en.client, date: en.date, day: en.day,
        normalHours: nh, overtimeHours: oh, mult, clientRate: cr, otClientRate: cr * mult, cost,
        areas: entryAreas(en) });
    });
  });
  const extrasTotal = extraLines.reduce((a, l) => a + l.cost, 0);

  // Clients with work that belongs on a client timesheet this period
  // (all hourly-site days, plus any fixed-site days flagged as extras)
  const timesheetClients = filterWeek === "all" ? [] : [...new Set(
    allEntries.filter(r => r.weekKey === filterWeek).flatMap(r =>
      r.entries
        .filter(en => !isFixedSite(en.siteName) || !!(extraDays || {})[`${r.id}::${en.date}::${en.siteId}`])
        .map(en => en.client)
    ).filter(Boolean)
  )].sort();

  const clientTotal = hourlyLines.reduce((a, l) => a + l.clientCost, 0) + billedFixedTotal + extrasTotal;
  const allExpenses = lines.flatMap(l => l.expenses);
  const totalExpenses = allExpenses.reduce((a, e) => a + (e.amount || 0), 0);
  const clientGrandTotal = clientTotal + totalExpenses;

  // Indigo pays only fitters not marked "not paid via Indigo" (e.g. Tom).
  // Their hours still appear on the client invoice above.
  const excluded = new Set(noIndigo || []);
  const indigoLines = lines.filter(l => !excluded.has(l.fitter));
  const indigoExpenses = indigoLines.flatMap(l => l.expenses);
  const indigoExpTotal = indigoExpenses.reduce((a, e) => a + (e.amount || 0), 0);
  const fitterTotal = indigoLines.reduce((a, l) => a + l.fitterCost, 0);
  const fitterGrandTotal = fitterTotal + indigoExpTotal;
  const excludedOnSheet = lines.filter(l => excluded.has(l.fitter)).map(l => l.fitter);

  const contactName = filterClient !== "all" ? filterClient : "Client";
  const we = weekEndLabel(filterWeek);

  // Print client invoice
  // Opens generated HTML in a new window with a visible Back/Print bar so the user is never trapped.
  const openDoc = (html) => {
    const toolbar = `
      <div class="ff-bar">
        <button onclick="ffClose()" class="ff-btn ff-back">← Close</button>
        <button onclick="window.print()" class="ff-btn ff-print">🖨️ Print / Save PDF</button>
      </div>
      <script>
        function ffClose(){
          window.close();
          // Some phone browsers block window.close(); fall back to going back, then show a hint.
          setTimeout(function(){
            if(!window.closed){
              if(history.length > 1){ history.back(); }
              else { document.getElementById('ff-hint').style.display = 'block'; }
            }
          }, 150);
        }
      <\/script>
      <div id="ff-hint" style="display:none;background:#fff8e8;border:1px solid #f39c12;color:#8a6d3b;
        padding:10px 14px;margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:13px;border-radius:6px;">
        Close this tab to go back to FineFit.
      </div>
      <style>
        .ff-bar{position:sticky;top:0;display:flex;gap:10px;justify-content:space-between;
          background:#1a1a1a;padding:10px 14px;margin:-40px -40px 24px -40px;z-index:99;}
        .ff-btn{font-family:Arial,sans-serif;font-size:14px;padding:10px 16px;border-radius:6px;
          border:none;cursor:pointer;}
        .ff-back{background:#fff;color:#1a1a1a;}
        .ff-print{background:#C8A96E;color:#1a1a1a;font-weight:bold;}
        @media print{.ff-bar,#ff-hint{display:none !important;}}
      </style>`;
    const win = window.open("", "_blank");
    if (!win) { alert("Please allow pop-ups for this site so the invoice can open."); return; }
    // Inject the toolbar right after <body>
    const withBar = html.replace(/<body>/, "<body>" + toolbar);
    win.document.write(withBar);
    win.document.close();
    win.focus();
  };

  const printClientInvoice = () => {
    const rows = hourlyLines.map(l => {
      const normalRow = l.normalHours > 0 ? `
      <tr>
        <td>${l.fitter}</td><td>${l.site}</td>
        <td style="text-align:right">${l.normalHours.toFixed(2)}</td>
        <td style="text-align:right">£${l.clientRate.toFixed(2)}</td>
        <td style="text-align:right"><strong>£${(l.normalHours * l.clientRate).toFixed(2)}</strong></td>
      </tr>` : "";
      const otRow = l.overtimeHours > 0 ? `
      <tr>
        <td>${l.fitter}</td><td>${l.site} <span style="color:#888">(overtime ${l.mult}\u00D7)</span></td>
        <td style="text-align:right">${l.overtimeHours.toFixed(2)}</td>
        <td style="text-align:right">£${l.otClientRate.toFixed(2)}</td>
        <td style="text-align:right"><strong>£${(l.overtimeHours * l.otClientRate).toFixed(2)}</strong></td>
      </tr>` : "";
      return normalRow + otRow;
    }).join("");
    // Fixed-price jobs billed on this invoice: one line each, no hours shown
    const fixedRows = fixedJobs.filter(j => j.billedHere).map(j => `
      <tr>
        <td>&mdash;</td><td>${j.site.name} <span style="color:#888">(fixed price for the job)</span></td>
        <td style="text-align:right">1</td>
        <td style="text-align:right">£${(j.site.jobPrice || 0).toFixed(2)}</td>
        <td style="text-align:right"><strong>£${(j.site.jobPrice || 0).toFixed(2)}</strong></td>
      </tr>`).join("");
    // Extra / variation days on fixed jobs, billed hourly on top
    const extraRows = extraLines.map(l => {
      const label = `${l.site} <span style="color:#888">(extra work \u2014 ${l.day} ${l.date}${l.overtimeHours > 0 ? `, incl. OT ${l.mult}\u00D7` : ""})</span>`;
      const hrs = (l.normalHours + l.overtimeHours).toFixed(2);
      return `<tr>
        <td>${l.fitter}</td><td>${label}</td>
        <td style="text-align:right">${hrs}</td>
        <td style="text-align:right">£${l.clientRate.toFixed(2)}</td>
        <td style="text-align:right"><strong>£${l.cost.toFixed(2)}</strong></td>
      </tr>`;
    }).join("");
    const expRows = allExpenses.length > 0 ? `
      <tr><td colspan="4" style="padding-top:8px;color:#888;font-size:12px;">Materials &amp; Expenses</td><td style="text-align:right"><strong>£${totalExpenses.toFixed(2)}</strong></td></tr>` : "";
    const html = `<!DOCTYPE html><html><head><title>Invoice ${invoiceNum}</title>
    <style>body{font-family:Arial,sans-serif;margin:40px;color:#1a1a1a;font-size:13px;}
    h1{font-size:28px;letter-spacing:2px;margin:0;border-bottom:1px solid #aaa;padding-bottom:4px;display:inline-block;}
    .sub{font-size:11px;letter-spacing:3px;color:#888;}
    .grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin:28px 0;}
    .label{font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:3px;}
    table{width:100%;border-collapse:collapse;margin-top:24px;}
    thead tr{background:#1a1a1a;color:white;}
    thead th{padding:8px 10px;text-align:left;font-size:11px;letter-spacing:0.05em;}
    thead th:nth-child(n+3){text-align:right;}
    tbody tr{border-bottom:1px solid #eee;}
    tbody td{padding:8px 10px;}
    .tot{margin-top:16px;text-align:right;font-size:18px;font-weight:bold;}
    .footer{margin-top:40px;font-size:11px;color:#888;border-top:1px solid #eee;padding-top:16px;}
    @media print{body{margin:20px;}}</style></head><body>
    <h1>FINE<span style="font-weight:300">FIT</span></h1><span class="sub">.LONDON</span>
    <p style="float:right;margin-top:-40px;font-size:20px;font-weight:bold;color:#888">TAX INVOICE</p>
    <div style="clear:both"></div>
    <div class="grid">
      <div><div class="label">Bill To</div><strong>${contactName}</strong><br/>Period ending ${we}</div>
      <div><div class="label">Invoice Date</div>${invoiceDate}<br/><div class="label" style="margin-top:8px">Invoice Number</div>${invoiceNum}</div>
      <div><div class="label">Fine Fit London</div>23 Odell Walk<br/>London SE13 7DP<br/><div class="label" style="margin-top:6px">VAT Number</div>310008672</div>
    </div>
    <table>
      <thead><tr><th>Fitter</th><th>Job</th><th>Hours</th><th>Rate £/hr</th><th>Cost</th></tr></thead>
      <tbody>${rows}${extraRows}${fixedRows}${expRows}
        <tr style="background:#f5f5f5"><td colspan="4" style="padding:10px;font-weight:bold">Subtotal</td><td style="padding:10px;text-align:right;font-weight:bold">£${clientGrandTotal.toFixed(2)}</td></tr>
        <tr><td colspan="4" style="padding:6px 10px;font-size:11px;color:#888">Domestic Reverse Charge @ 20%</td><td style="padding:6px 10px;text-align:right;color:#888">0.00</td></tr>
        <tr style="background:#1a1a1a;color:white"><td colspan="4" style="padding:10px;font-weight:bold">Invoice Total</td><td style="padding:10px;text-align:right;font-weight:bold;font-size:16px">£${clientGrandTotal.toFixed(2)}</td></tr>
      </tbody>
    </table>
    <p style="margin-top:20px;font-size:11px;text-align:center;color:#888"><em>The customer is to account to HMRC for the reverse charge output tax on the VAT exclusive price of the invoice at the standard VAT rates.</em></p>
    <div class="footer">
      <strong>Due Date: ${dueDate}</strong><br/>Bank: HSBC &nbsp;|&nbsp; Sort code: 40 04 15 &nbsp;|&nbsp; Account number: 42229196<br/><br/>
      Fine Fit London Limited. Company Number 11244546. Registered in England.<br/>
      Registered Office: Studio 133 Canalot Studios, 222 Kensal Road, London, W10 5BN.
    </div></body></html>`;
    openDoc(html);
  };

  // Print Indigo payment sheet
  const printIndigoSheet = () => {
    let rowNum = 0;
    const rows = indigoLines.map((l) => {
      const normalRow = l.normalHours > 0 ? `
      <tr style="background:${(++rowNum) % 2 === 0 ? "#fff" : "#f9f9f9"}">
        <td style="padding:7px 10px">${rowNum}</td>
        <td style="padding:7px 10px"><strong>${l.fitter}</strong></td>
        <td style="padding:7px 10px;color:#888;font-size:11px;">normal</td>
        <td style="padding:7px 10px;text-align:right">${l.normalHours.toFixed(2)}</td>
        <td style="padding:7px 10px;text-align:right">£${l.fitterRate.toFixed(2)}</td>
        <td style="padding:7px 10px;text-align:right"><strong>£${(l.normalHours * l.fitterRate).toFixed(2)}</strong></td>
        <td style="padding:7px 10px">${l.site}</td>
      </tr>` : "";
      const otRow = l.overtimeHours > 0 ? `
      <tr style="background:#fff8f0">
        <td style="padding:7px 10px">${++rowNum}</td>
        <td style="padding:7px 10px"><strong>${l.fitter}</strong></td>
        <td style="padding:7px 10px;color:#b7860b;font-size:11px;">overtime ${l.mult}\u00D7</td>
        <td style="padding:7px 10px;text-align:right">${l.overtimeHours.toFixed(2)}</td>
        <td style="padding:7px 10px;text-align:right">£${l.otFitterRate.toFixed(2)}</td>
        <td style="padding:7px 10px;text-align:right"><strong>£${(l.overtimeHours * l.otFitterRate).toFixed(2)}</strong></td>
        <td style="padding:7px 10px">${l.site}</td>
      </tr>` : "";
      return normalRow + otRow;
    }).join("");
    const expRows = indigoExpenses.length > 0 ? indigoExpenses.map(exp => `
      <tr style="background:#fff8f0">
        <td></td>
        <td colspan="2" style="padding:6px 10px;font-size:11px;color:#888">EXPENSES: ${exp.description}</td>
        <td style="padding:6px 10px;text-align:right;font-size:11px">1.00</td>
        <td style="padding:6px 10px;text-align:right;font-size:11px">£${(exp.amount || 0).toFixed(2)}</td>
        <td style="padding:6px 10px;text-align:right;font-size:11px">£${(exp.amount || 0).toFixed(2)}</td>
        <td></td>
      </tr>`).join("") : "";
    const html = `<!DOCTYPE html><html><head><title>FineFit Payment Sheet — Period ending ${we}</title>
    <style>body{font-family:Arial,sans-serif;margin:40px;color:#1a1a1a;font-size:13px;}
    h2{margin:0 0 4px;} .meta{color:#888;font-size:12px;margin-bottom:24px;}
    table{width:100%;border-collapse:collapse;}
    thead tr{background:#1a1a1a;color:white;}
    thead th{padding:8px 10px;text-align:left;font-size:11px;letter-spacing:0.05em;}
    thead th:nth-child(n+4){text-align:right;}
    .total-row td{padding:10px;font-weight:bold;background:#f0f0f0;}
    .grand td{padding:10px;font-weight:bold;background:#1a1a1a;color:white;}
    @media print{body{margin:16px;}}</style></head><body>
    <h2>FineFit London — Fitter Payment Sheet</h2>
    <div class="meta">NAME: FineFit London &nbsp;|&nbsp; Period ending: ${we}${filterClient !== "all" ? ` &nbsp;|&nbsp; ${contactName}` : ""} &nbsp;|&nbsp; Invoice: ${invoiceNum}</div>
    <table>
      <thead><tr><th>#</th><th>Fitter</th><th>Rate</th><th>Hours</th><th>£/hr</th><th>Gross</th><th>Site Ref</th></tr></thead>
      <tbody>
        ${rows}${expRows}
        <tr class="total-row"><td colspan="5">EXPENSES TOTAL</td><td>£${indigoExpTotal.toFixed(2)}</td><td></td></tr>
        <tr class="grand"><td colspan="5">TOTAL FITTER PAYMENT</td><td>£${fitterGrandTotal.toFixed(2)}</td><td></td></tr>
      </tbody>
    </table>
    <p style="margin-top:24px;font-size:11px;color:#888">Generated ${new Date().toLocaleDateString("en-GB")} &nbsp;|&nbsp; Fine Fit London Limited &nbsp;|&nbsp; Company No. 11244546</p>
    </body></html>`;
    openDoc(html);
  };

  // Xero CSV
  const downloadXeroCSV = () => {
    const headers = ["ContactName","InvoiceNumber","InvoiceDate","DueDate","Description","Quantity","UnitAmount","AccountCode","TaxType","Currency"];
    const rows = [
      ...hourlyLines.flatMap(l => {
        const out = [];
        if (l.normalHours > 0) out.push([contactName, invoiceNum, invoiceDate, dueDate, `${l.fitter} - ${l.site}`, l.normalHours.toFixed(2), l.clientRate.toFixed(2), "200", "RRSINPUT", "GBP"]);
        if (l.overtimeHours > 0) out.push([contactName, invoiceNum, invoiceDate, dueDate, `${l.fitter} - ${l.site} (overtime ${l.mult}x)`, l.overtimeHours.toFixed(2), l.otClientRate.toFixed(2), "200", "RRSINPUT", "GBP"]);
        return out;
      }),
      ...fixedJobs.filter(j => j.billedHere).map(j => [contactName, invoiceNum, invoiceDate, dueDate, `${j.site.name} - fixed price for the job`, "1", (j.site.jobPrice || 0).toFixed(2), "200", "RRSINPUT", "GBP"]),
      ...extraLines.map(l => [contactName, invoiceNum, invoiceDate, dueDate, `${l.fitter} - ${l.site} extra work ${l.date}`, (l.normalHours + l.overtimeHours).toFixed(2), l.clientRate.toFixed(2), "200", "RRSINPUT", "GBP"]),
      ...(totalExpenses > 0 ? [[contactName, invoiceNum, invoiceDate, dueDate, "Materials and Expenses", "1", totalExpenses.toFixed(2), "200", "RRSINPUT", "GBP"]] : [])
    ];
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${invoiceNum}_xero.csv`; a.click();
  };

  const hasRates = lines.some(l => l.clientRate > 0 || l.fitterRate > 0);

  // Client timesheet — proof-of-work sheet per company, matching Tom's existing weekly format.
  const printClientTimesheet = (onlyClient = null) => {
    if (filterWeek === "all") { alert("Please pick a specific fortnight above first."); return; }
    const periodDays = getPeriodDays(filterWeek); // 14 days, each { iso, dayName, label, week }

    // A day appears on the client timesheet if it's an hourly-site day,
    // OR a fixed-site day Tom has flagged as a chargeable extra.
    const dayKeyOf = (recordId, en) => `${recordId}::${en.date}::${en.siteId}`;
    const showsOnTimesheet = (r, en) => !isFixedSite(en.siteName) || !!(extraDays || {})[dayKeyOf(r.id, en)];

    // Which clients to include
    const clientsInPeriod = [...new Set(
      allEntries.filter(r => r.weekKey === filterWeek)
        .flatMap(r => r.entries.filter(en => showsOnTimesheet(r, en)).map(en => en.client)).filter(Boolean)
    )].sort();
    const targetClients = (onlyClient ? [onlyClient] : (filterClient === "all" ? clientsInPeriod : [filterClient])).filter(c => clientsInPeriod.includes(c));
    if (targetClients.length === 0) { alert("No chargeable work found for this period. (Fixed-price hours only show here once you mark them as extras on the invoice.)"); return; }

    const dayAbbr = { Monday: "MON", Tuesday: "TUE", Wednesday: "WED", Thursday: "THUR", Friday: "FRI", Saturday: "SAT", Sunday: "SUN" };
    const fmt = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB");

    // Work out which of the 14 days an entry belongs to.
    // Entries submitted before the timezone fix stored a date one day out, but their
    // weekday name is correct — so if the date is within a day and the weekday matches,
    // place it on that day rather than dropping it.
    const dayDiff = (isoA, isoB) => Math.round(Math.abs(new Date(isoA + "T00:00:00") - new Date(isoB + "T00:00:00")) / 86400000);
    const placeEntry = (en) => {
      if (!en.date) return null;
      const exact = periodDays.find(pd => pd.iso === en.date);
      // Only trust an exact date match if the recorded weekday agrees with it.
      if (exact && (!en.day || exact.dayName === en.day)) return exact;
      if (en.day) {
        const near = periodDays.find(pd => pd.dayName === en.day && dayDiff(pd.iso, en.date) <= 1);
        if (near) return near;
      }
      return null;
    };

    // Anything that still can't be placed must not disappear silently — collect it and warn.
    const unplaced = [];
    allEntries.filter(r => r.weekKey === filterWeek).forEach(r => r.entries.forEach(en => {
      if (targetClients.includes(en.client) && showsOnTimesheet(r, en) && !placeEntry(en)) {
        unplaced.push(`${r.fitter}: ${en.day || "?"} ${en.date || "(no date)"} — ${en.hours || 0}h at ${en.siteName}`);
      }
    }));

    // Build one weekly sheet (week = 1 or 2) for a client
    const weekSheet = (client, weekNo) => {
      const days = periodDays.filter(d => d.week === weekNo);
      const weekEnding = fmt(days[days.length - 1].iso);
      let weekTotal = 0;
      const dayBlocks = days.map(d => {
        // entries for this client on this date
        const rows = [];
        allEntries.filter(r => r.weekKey === filterWeek).forEach(r => {
          r.entries.forEach(en => {
            if (en.client === client && showsOnTimesheet(r, en) && placeEntry(en)?.iso === d.iso) {
              const hrs = en.hours || 0; weekTotal += hrs;
              const extra = isFixedSite(en.siteName);
              const desc = entryAreas(en).join(", ") + (extra ? " (extra work)" : "");
              rows.push(`<tr>
                <td class="dcell"></td>
                <td>${r.fitter}</td>
                <td>${en.siteName}</td>
                <td>${desc}</td>
                <td class="num">${hrs.toFixed(2)}</td>
              </tr>`);
            }
          });
        });
        // a couple of blank rows to mirror his template look
        const blanks = Array(Math.max(0, 3 - rows.length)).fill('<tr><td class="dcell"></td><td></td><td></td><td></td><td class="num"></td></tr>').join("");
        return `<tr class="dayhead">
            <td>${dayAbbr[days.find(x => x.iso === d.iso).dayName]}</td>
            <td>FITTER</td><td>PROJECT</td><td>DESCRIPTION OF HOLD-UPS OR EXTRA WORKS</td><td class="num">WORKING</td>
          </tr>${rows.join("")}${blanks}`;
      }).join("");

      return `
        <div class="sheet">
          <table class="hdr">
            <tr><td class="k">NAME:</td><td class="v">FineFit</td><td class="tot" rowspan="2"><div>TOTAL HOURS<br/>PER WEEK</div><div class="totn">${weekTotal.toFixed(2)}</div></td></tr>
            <tr><td class="k">W/E:</td><td class="v">${weekEnding}</td></tr>
            <tr><td class="k">CLIENT:</td><td class="v">${client}</td></tr>
          </table>
          <table class="grid">${dayBlocks}</table>
        </div>`;
    };

    const body = targetClients.map(client =>
      [1, 2].map(wk => weekSheet(client, wk)).join("")
    ).join("");

    const docTitle = `FineFit Timesheet - ${targetClients.length === 1 ? targetClients[0] : "All clients"} - ${periodLabelShort(filterWeek)}`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${docTitle}</title>
      <style>
        *{box-sizing:border-box;} body{font-family:Arial,Helvetica,sans-serif;color:#111;padding:40px;font-size:12px;}
        .sheet{page-break-after:always;margin-bottom:30px;}
        table{border-collapse:collapse;width:100%;}
        .hdr{margin-bottom:6px;width:100%;}
        .hdr td{padding:3px 6px;vertical-align:top;}
        .hdr .k{font-weight:bold;width:70px;border:1px solid #000;}
        .hdr .v{border:1px solid #000;font-weight:bold;}
        .hdr .tot{width:110px;text-align:center;border:2px solid #000;font-weight:bold;font-size:10px;}
        .hdr .totn{font-size:16px;margin-top:4px;}
        .grid td{border:1px solid #999;padding:4px 6px;height:20px;}
        .grid .dayhead td{background:#000;color:#fff;font-weight:bold;font-size:11px;border:1px solid #000;}
        .grid .num{text-align:right;width:70px;}
        .grid .dcell{width:44px;font-weight:bold;}
        @media print{ body{padding:12px;} }
      </style></head><body>${body}</body></html>`;

    openDoc(html);

    if (unplaced.length > 0) {
      alert(
        `Heads up \u2014 ${unplaced.length} entr${unplaced.length === 1 ? "y is" : "ies are"} missing from this timesheet because the date doesn't fall in this fortnight:\n\n` +
        unplaced.join("\n") +
        `\n\nOpen the Timesheets tab, edit those entries and pick the correct date, then generate this again.`
      );
    }
  };

  return (
    <div>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", marginBottom: 16 }}>
        Generate the client invoice and fitter payment sheet for Indigo. Set rates under the Rates tab first.
      </p>

      {/* Filters + invoice details */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        <div><label style={labelStyle}>Week</label>
          <select value={filterWeek} onChange={e => setFilterWeek(e.target.value)} style={selectStyle}>
            <option value="all">All weeks</option>
            {weeks.map(w => { const r = allEntries.find(e => e.weekKey === w); return <option key={w} value={w}>{r?.weekLabel || w}</option>; })}
          </select>
        </div>
        <div><label style={labelStyle}>Client</label>
          <select value={filterClient} onChange={e => setFilterClient(e.target.value)} style={{ ...selectStyle, borderColor: filterClient !== "all" ? "#C8A96E" : undefined }}>
            <option value="all">All clients</option>
            {clients.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div><label style={labelStyle}>Invoice No.</label><input value={invoiceNum} onChange={e => setInvoiceNum(e.target.value)} style={{ ...inputStyle, fontSize: 12 }} /></div>
        <div><label style={labelStyle}>Invoice Date</label><input value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} style={{ ...inputStyle, fontSize: 12 }} /></div>
        <div><label style={labelStyle}>Due Date</label><input value={dueDate} onChange={e => setDueDate(e.target.value)} style={{ ...inputStyle, fontSize: 12 }} /></div>
      </div>

      {/* Lock / mark invoiced control */}
      {filterWeek !== "all" && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: (lockedWeeks || []).includes(filterWeek) ? "#f0ece6" : "#faf6ef", border: "1px solid #e8e4de", borderRadius: 8, padding: "10px 14px", marginBottom: 16 }}>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: (lockedWeeks || []).includes(filterWeek) ? "#999" : "#8a6d3b" }}>
            {(lockedWeeks || []).includes(filterWeek) ? "🔒 This fortnight is invoiced and locked. Nobody can edit it." : "Once you've generated and sent the invoice, lock this fortnight to prevent further changes."}
          </span>
          <button onClick={() => onToggleLock(filterWeek)} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: (lockedWeeks || []).includes(filterWeek) ? "#fff" : "#1a1a1a", color: (lockedWeeks || []).includes(filterWeek) ? "#1a1a1a" : "#fff", border: (lockedWeeks || []).includes(filterWeek) ? "1px solid #ddd" : "none", borderRadius: 6, padding: "7px 14px", cursor: "pointer", whiteSpace: "nowrap", marginLeft: 12 }}>
            {(lockedWeeks || []).includes(filterWeek) ? "Unlock week" : "🔒 Lock (mark invoiced)"}
          </button>
        </div>
      )}
      {filterWeek === "all" && (
        <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#bbb", marginBottom: 16 }}>Select a specific week above to lock it once invoiced.</p>
      )}

      {lines.length === 0 ? (
        <div style={{ textAlign: "center", padding: "32px 0", color: "#bbb", fontFamily: "'DM Mono', monospace", fontSize: 13 }}>No submissions for this selection.</div>
      ) : (
        <>
          {/* Toggle between doc previews */}
          <div style={{ display: "flex", gap: 4, marginBottom: 16, background: "#f5f2ed", borderRadius: 8, padding: 4 }}>
            {[["client", "Client Invoice"], ["indigo", "Indigo Payment Sheet"]].map(([key, label]) => (
              <button key={key} onClick={() => setActiveDoc(key)} style={{
                flex: 1, fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "8px 0",
                border: "none", borderRadius: 6, cursor: "pointer",
                background: activeDoc === key ? "#1a1a1a" : "transparent",
                color: activeDoc === key ? "#fff" : "#888"
              }}>{label}</button>
            ))}
          </div>

          {/* CLIENT INVOICE PREVIEW */}
          {activeDoc === "client" && (
            <div style={{ border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
              <div style={{ background: "#1a1a1a", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, color: "#fff", fontWeight: 700 }}>TAX INVOICE · {invoiceNum}</span>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", marginLeft: 10 }}>{contactName}</span>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 18, color: "#C8A96E", fontWeight: 700 }}>{toGBP(clientGrandTotal)}</div>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#666" }}>Invoice Total</div>
                </div>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f5f2ed", borderBottom: "1px solid #e8e4de" }}>
                    {["Fitter", "Job", "Hours", "Rate", "Cost"].map((h, i) => (
                      <th key={h} style={{ padding: "8px 10px", textAlign: i >= 2 ? "right" : "left", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {hourlyLines.flatMap((l, i) => {
                    const rowsOut = [];
                    if (l.normalHours > 0) rowsOut.push(
                      <tr key={`${i}-n`} style={{ borderBottom: "1px solid #f5f2ed" }}>
                        <td style={tdStyle}>{l.fitter}</td>
                        <td style={{ ...tdStyle, color: "#888" }}>{l.site}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{l.normalHours.toFixed(2)}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{l.clientRate > 0 ? `£${l.clientRate.toFixed(2)}` : <span style={{ color: "#f39c12" }}>Set rate</span>}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{l.clientRate > 0 ? toGBP(l.normalHours * l.clientRate) : "—"}</td>
                      </tr>
                    );
                    if (l.overtimeHours > 0) rowsOut.push(
                      <tr key={`${i}-o`} style={{ borderBottom: "1px solid #f5f2ed", background: "#fffaf0" }}>
                        <td style={tdStyle}>{l.fitter}</td>
                        <td style={{ ...tdStyle, color: "#b7860b" }}>{l.site} · OT {l.mult}×</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{l.overtimeHours.toFixed(2)}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{l.clientRate > 0 ? `£${l.otClientRate.toFixed(2)}` : "—"}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{l.clientRate > 0 ? toGBP(l.overtimeHours * l.otClientRate) : "—"}</td>
                      </tr>
                    );
                    return rowsOut;
                  })}
                  {fixedJobs.filter(j => j.billedHere).map(j => (
                    <tr key={`fx-${j.site.id}`} style={{ borderBottom: "1px solid #f5f2ed", background: "#f2faf6" }}>
                      <td style={tdStyle}>—</td>
                      <td style={{ ...tdStyle, color: "#1a6f4b" }}>{j.site.name} · fixed price</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>1</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{toGBP(j.site.jobPrice || 0)}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{toGBP(j.site.jobPrice || 0)}</td>
                    </tr>
                  ))}
                  {extraLines.map((l, xi) => (
                    <tr key={`ex-${xi}`} style={{ borderBottom: "1px solid #f5f2ed", background: "#fff6f0" }}>
                      <td style={tdStyle}>{l.fitter}</td>
                      <td style={{ ...tdStyle, color: "#b5561f" }}>{l.site} · extra ({l.day?.slice(0,3)} {l.date})</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{(l.normalHours + l.overtimeHours).toFixed(2)}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{l.clientRate > 0 ? `£${l.clientRate.toFixed(2)}` : <span style={{ color: "#f39c12" }}>Set rate</span>}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{toGBP(l.cost)}</td>
                    </tr>
                  ))}
                  {totalExpenses > 0 && (
                    <tr style={{ borderBottom: "1px solid #f5f2ed", background: "#fafaf8" }}>
                      <td style={{ ...tdStyle, color: "#888", fontStyle: "italic" }} colSpan={2}>Materials &amp; Expenses</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>1.00</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{toGBP(totalExpenses)}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{toGBP(totalExpenses)}</td>
                    </tr>
                  )}
                  <tr style={{ background: "#1a1a1a" }}>
                    <td colSpan={4} style={{ ...tdStyle, color: "#fff", fontWeight: 700, fontSize: 12 }}>Invoice Total</td>
                    <td style={{ ...tdStyle, textAlign: "right", color: "#C8A96E", fontWeight: 700, fontSize: 15, fontFamily: "'DM Mono', monospace" }}>{toGBP(clientGrandTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* INDIGO PAYMENT SHEET PREVIEW */}
          {activeDoc === "indigo" && (
            <div>
            {excludedOnSheet.length > 0 && (
              <div style={{ background: "#fff8e8", border: "1px solid #f39c12", borderRadius: 8, padding: "9px 12px", marginBottom: 12 }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#8a6d3b" }}>
                  Not on this sheet (not paid via Indigo): <strong>{[...new Set(excludedOnSheet)].join(", ")}</strong>. Their hours are still charged on the client invoice.
                </span>
              </div>
            )}
            <div style={{ border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
              <div style={{ background: "#1a1a1a", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, color: "#fff", fontWeight: 700 }}>Indigo Payment Sheet</span>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", marginLeft: 10 }}>Period ending {we}</span>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 18, color: "#C8A96E", fontWeight: 700 }}>{toGBP(fitterGrandTotal)}</div>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#666" }}>Total to Pay</div>
                </div>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "#f5f2ed", borderBottom: "1px solid #e8e4de" }}>
                    {["Fitter", "Site", "Hours", "Rate", "Gross"].map((h, i) => (
                      <th key={h} style={{ padding: "8px 10px", textAlign: i >= 2 ? "right" : "left", fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {indigoLines.flatMap((l, i) => {
                    const rowsOut = [];
                    if (l.normalHours > 0) rowsOut.push(
                      <tr key={`${i}-n`} style={{ borderBottom: "1px solid #f5f2ed" }}>
                        <td style={tdStyle}>{l.fitter}</td>
                        <td style={{ ...tdStyle, color: "#888" }}>{l.site}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{l.normalHours.toFixed(2)}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{l.fitterRate > 0 ? `£${l.fitterRate.toFixed(2)}` : <span style={{ color: "#f39c12" }}>Set rate</span>}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{l.fitterRate > 0 ? toGBP(l.normalHours * l.fitterRate) : "—"}</td>
                      </tr>
                    );
                    if (l.overtimeHours > 0) rowsOut.push(
                      <tr key={`${i}-o`} style={{ borderBottom: "1px solid #f5f2ed", background: "#fffaf0" }}>
                        <td style={tdStyle}>{l.fitter}</td>
                        <td style={{ ...tdStyle, color: "#b7860b" }}>{l.site} · OT {l.mult}×</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{l.overtimeHours.toFixed(2)}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{l.fitterRate > 0 ? `£${l.otFitterRate.toFixed(2)}` : "—"}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{l.fitterRate > 0 ? toGBP(l.overtimeHours * l.otFitterRate) : "—"}</td>
                      </tr>
                    );
                    return rowsOut;
                  })}
                  {indigoExpenses.map((exp, i) => (
                    <tr key={`exp-${i}`} style={{ borderBottom: "1px solid #f5f2ed", background: "#fafaf8" }}>
                      <td style={{ ...tdStyle, color: "#888", fontStyle: "italic", fontSize: 11 }} colSpan={2}>EXPENSES: {exp.description}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>1.00</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace", fontSize: 11 }}>{toGBP(exp.amount || 0)}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{toGBP(exp.amount || 0)}</td>
                    </tr>
                  ))}
                  <tr style={{ background: "#1a1a1a" }}>
                    <td colSpan={4} style={{ ...tdStyle, color: "#fff", fontWeight: 700, fontSize: 12 }}>Total Fitter Payment</td>
                    <td style={{ ...tdStyle, textAlign: "right", color: "#C8A96E", fontWeight: 700, fontSize: 15, fontFamily: "'DM Mono', monospace" }}>{toGBP(fitterGrandTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            </div>
          )}

          {!hasRates && (
            <div style={{ background: "#fff8e8", border: "1px solid #f39c12", borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
              <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#b7860b", margin: 0 }}>⚠️ No rates set yet — go to the Rates tab to add client and fitter rates so totals can be calculated.</p>
            </div>
          )}

          {/* Receipts viewer */}
          {allExpenses.some(e => e.receipt) && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>Expense Receipts</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {allExpenses.filter(e => e.receipt).map((exp, i) => (
                  <div key={i} style={{ textAlign: "center" }}>
                    {receiptIsPdf(exp.receipt)
                      ? <div onClick={() => openReceipt(exp.receipt)} style={{ width: 80, height: 80, borderRadius: 8, border: "1px solid #e8e4de", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", cursor: "pointer", background: "#faf9f7" }}>
                          <span style={{ fontSize: 22 }}>📄</span>
                          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#888" }}>PDF</span>
                        </div>
                      : <img src={receiptSrc(exp.receipt)} alt={exp.description} style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 8, border: "1px solid #e8e4de", display: "block", cursor: "pointer" }}
                          onClick={() => openReceipt(exp.receipt)} />}
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#aaa", display: "block", marginTop: 4 }}>{exp.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Fixed-price jobs — Tom ticks to bill the job price on this invoice (once only) */}
          {fixedJobs.length > 0 && filterWeek !== "all" && (
            <div style={{ border: "1px solid #cfe6da", background: "#f2faf6", borderRadius: 10, padding: 14, marginBottom: 12 }}>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#1a6f4b", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Fixed-price jobs</div>
              {fixedJobs.map(j => {
                const billedElsewhere = j.billedIn && j.billedIn !== filterWeek;
                // Days worked on this fixed job in this period (for flagging extras)
                const jobDays = [];
                filtered.forEach(r => r.entries.forEach(en => {
                  if (en.siteId === j.site.id) jobDays.push({ recordId: r.id, key: `${r.id}::${en.date}::${en.siteId}`, fitter: r.fitter, date: en.date, day: en.day, hours: en.hours || 0, areas: entryAreas(en) });
                }));
                jobDays.sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.fitter.localeCompare(b.fitter));
                return (
                  <div key={j.site.id} style={{ padding: "7px 0", borderBottom: "1px solid #e3f0e9" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: billedElsewhere ? "not-allowed" : "pointer", opacity: billedElsewhere ? 0.55 : 1 }}>
                        <input type="checkbox" checked={!!j.billedHere} disabled={billedElsewhere}
                          onChange={() => onToggleBilledJob(j.site.id, filterWeek)}
                          style={{ width: 17, height: 17, accentColor: "#1a6f4b", cursor: billedElsewhere ? "not-allowed" : "pointer" }} />
                        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#1a1a1a" }}>
                          {j.site.name} <span style={{ color: "#1a6f4b", fontWeight: 700 }}>{toGBP(j.site.jobPrice || 0)}</span>
                        </span>
                      </label>
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: billedElsewhere ? "#b7860b" : "#888", textAlign: "right" }}>
                        {billedElsewhere ? `Already billed ${periodLabelShort(j.billedIn)}` : j.billedHere ? "Price on this invoice" : "Price not billed yet"}
                      </span>
                    </div>
                    {/* Flag individual days as chargeable extras (billed hourly on top) */}
                    {jobDays.length > 0 && (
                      <div style={{ marginLeft: 26, marginTop: 6 }}>
                        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#7a8f85", marginBottom: 4 }}>Tick any days that were extras / variations (billed hourly on top):</div>
                        {jobDays.map(d => {
                          const on = !!(extraDays || {})[d.key];
                          return (
                            <label key={d.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" }}>
                              <input type="checkbox" checked={on} onChange={() => onToggleExtraDay(d.key)}
                                style={{ width: 15, height: 15, accentColor: "#b5561f", cursor: "pointer" }} />
                              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: on ? "#b5561f" : "#888" }}>
                                {d.day?.slice(0,3)} {d.date} · {d.fitter} · {d.hours}h{d.areas.length ? ` · ${d.areas.join(", ")}` : ""}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#7a8f85", margin: "8px 0 0 0" }}>
                Tick a job to bill its fixed price on this invoice. Fitters&apos; hours are always paid via Indigo. Days you don&apos;t mark as extras stay inside the fixed price and aren&apos;t charged again or shown to the client.
              </p>
            </div>
          )}

          {/* Client timesheets — one PDF per company */}
          <div style={{ border: "1px solid #e8e4de", borderRadius: 10, padding: 14, marginBottom: 12 }}>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Client timesheets</div>
            <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#aaa", margin: "0 0 10px 0" }}>
              Proof of work to send each company. Generate one, then use Print / Save as PDF.
            </p>
            {filterWeek === "all" ? (
              <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#b7860b", margin: 0 }}>Pick a specific fortnight above to generate timesheets.</p>
            ) : timesheetClients.length === 0 ? (
              <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#bbb", margin: 0 }}>No chargeable work this fortnight.</p>
            ) : (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {timesheetClients.map(c => (
                    <button key={c} onClick={() => printClientTimesheet(c)}
                      style={{ ...btnStyle, marginTop: 0, padding: "11px 12px", fontSize: 12, textAlign: "left", width: "100%", background: "#1a1a1a" }}>
                      📄 {c} — timesheet
                    </button>
                  ))}
                </div>
                {timesheetClients.length > 1 && (
                  <button onClick={() => printClientTimesheet()}
                    style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "none", border: "1px solid #e0dbd4", borderRadius: 8, padding: "9px 12px", cursor: "pointer", color: "#888", width: "100%", marginTop: 8 }}>
                    All clients in one document
                  </button>
                )}
              </>
            )}
          </div>

          {/* Action buttons */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            <button onClick={printClientInvoice} style={{ ...btnStyle, marginTop: 0, padding: "12px 8px", fontSize: 12, textAlign: "center" }}>🖨️ Client Invoice</button>
            <button onClick={printIndigoSheet} style={{ ...btnStyle, marginTop: 0, padding: "12px 8px", fontSize: 12, textAlign: "center", background: "#2c3e50" }}>📋 Indigo Sheet</button>
            <button onClick={downloadXeroCSV} style={{ ...btnStyle, marginTop: 0, padding: "12px 8px", fontSize: 12, textAlign: "center", background: "#0078D7" }}>⬇ Xero CSV</button>
          </div>
          <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#aaa", textAlign: "center", marginTop: 8 }}>
            Xero: Business → Invoices → Import → upload CSV
          </p>
        </>
      )}
    </div>
  );
}

// ---------- SUBMISSIONS TAB ----------
function SubmissionsTab({ allEntries, sites, lockedWeeks, fittersList, onDeleteRecord, onUpdateRecord }) {
  const [filterWeek, setFilterWeek] = useState("all");
  const [filterFitter, setFilterFitter] = useState("all");
  const [filterClient, setFilterClient] = useState("all");
  const [editingId, setEditingId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const weeks = [...new Set(allEntries.map(e => e.weekKey))].sort().reverse();
  const fitters = [...new Set(allEntries.map(e => e.fitter))].sort();
  const clients = [...new Set(allEntries.flatMap(e => e.entries.map(en => en.client)).filter(Boolean))].sort();

  // Who's submitted vs outstanding for the CURRENT fortnight
  const thisPeriod = getWeekKey();
  const submittedThisPeriod = [...new Set(allEntries.filter(r => r.weekKey === thisPeriod).map(r => r.fitter))];
  const roster = [...(fittersList || [])];
  const outstanding = roster.filter(f => !submittedThisPeriod.includes(f)).sort((a, b) => a.localeCompare(b));
  const periodHours = allEntries.filter(r => r.weekKey === thisPeriod).flatMap(r => r.entries).reduce((a, e) => a + (e.hours || 0), 0);

  const filtered = allEntries.filter(record => {
    if (filterWeek !== "all" && record.weekKey !== filterWeek) return false;
    if (filterFitter !== "all" && record.fitter !== filterFitter) return false;
    if (filterClient !== "all" && !record.entries.some(en => en.client === filterClient)) return false;
    return true;
  });

  const totalHours = filtered.flatMap(r => r.entries).reduce((a, e) => a + (e.hours || 0), 0);

  return (
    <div>
      {/* Current period status */}
      {roster.length > 0 && (
        <div style={{ border: "1px solid #e8e4de", borderRadius: 10, padding: 14, marginBottom: 16, background: "#faf9f7" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.08em" }}>This fortnight</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888" }}>{getCurrentWeekLabel()}</span>
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: outstanding.length ? 10 : 0 }}>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#1a1a1a" }}><strong style={{ color: "#5a9" }}>{submittedThisPeriod.length}</strong> of {roster.length} submitted</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#1a1a1a" }}><strong style={{ color: "#C8A96E" }}>{periodHours.toFixed(1)}</strong> hrs so far</span>
          </div>
          {outstanding.length > 0 && (
            <div>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#b5561f" }}>Still waiting on: </span>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#b5561f", fontWeight: 700 }}>{outstanding.join(", ")}</span>
            </div>
          )}
          {outstanding.length === 0 && (
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#5a9" }}>✓ Everyone's in for this fortnight.</span>
          )}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
        <select value={filterWeek} onChange={e => setFilterWeek(e.target.value)} style={selectStyle}>
          <option value="all">All weeks</option>
          {weeks.map(w => { const r = allEntries.find(e => e.weekKey === w); return <option key={w} value={w}>{r?.weekLabel || w}</option>; })}
        </select>
        <select value={filterFitter} onChange={e => setFilterFitter(e.target.value)} style={selectStyle}>
          <option value="all">All fitters</option>
          {fitters.map(f => <option key={f}>{f}</option>)}
        </select>
        <select value={filterClient} onChange={e => setFilterClient(e.target.value)} style={{ ...selectStyle, borderColor: filterClient !== "all" ? "#C8A96E" : undefined }}>
          <option value="all">All clients</option>
          {clients.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", marginBottom: 16 }}>{filtered.length} submission{filtered.length !== 1 ? "s" : ""} · {totalHours.toFixed(1)} hrs</p>

      {filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 0", color: "#bbb", fontFamily: "'DM Mono', monospace", fontSize: 13 }}>No submissions match these filters.</div>
      ) : (() => {
        // Group filtered submissions by fitter + fortnight so multiple submissions show as one tidy card
        const groups = {};
        filtered.forEach(record => {
          const gkey = `${record.fitter}|||${record.weekKey}`;
          if (!groups[gkey]) groups[gkey] = { fitter: record.fitter, weekKey: record.weekKey, weekLabel: record.weekLabel, records: [] };
          groups[gkey].records.push(record);
        });
        // Sort groups: newest period first, then fitter name
        const groupList = Object.values(groups).sort((a, b) => b.weekKey.localeCompare(a.weekKey) || a.fitter.localeCompare(b.fitter));

        return groupList.map(group => {
          const locked = (lockedWeeks || []).includes(group.weekKey);
          const groupHours = group.records.flatMap(r => r.entries).reduce((a, e) => a + (e.hours || 0), 0);
          return (
            <div key={`${group.fitter}|||${group.weekKey}`} style={{ marginBottom: 16, border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ padding: "10px 14px", background: "#f5f2ed", borderBottom: "1px solid #e8e4de", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 15, fontWeight: 600, color: "#1a1a1a" }}>{group.fitter}</span>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#aaa", marginLeft: 8 }}>{group.weekLabel}</span>
                  {group.records.length > 1 && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#aaa", marginLeft: 6, background: "#e8e4de", borderRadius: 4, padding: "1px 5px" }}>{group.records.length} submissions</span>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#1a1a1a", fontWeight: 700 }}>{groupHours.toFixed(1)} hrs</span>
                  {locked && <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, background: "#f0ece6", color: "#999", borderRadius: 6, padding: "4px 10px" }}>🔒 Invoiced</span>}
                </div>
              </div>

              {group.records.map(record => (
                editingId === record.id ? (
                  <div key={record.id} style={{ padding: 10, background: "#faf6ef" }}>
                    <EditSubmission
                      record={record}
                      sites={sites}
                      allEntries={allEntries}
                      onSave={async (updated) => { await onUpdateRecord(record.id, updated); setEditingId(null); }}
                      onCancel={() => setEditingId(null)}
                    />
                  </div>
                ) : (
                  <div key={record.id}>
                    {typeof confirmDeleteId === "string" && confirmDeleteId.startsWith(record.id + "::") && (() => {
                      const di = parseInt(confirmDeleteId.split("::")[1], 10);
                      const dEntry = record.entries[di];
                      const lastOne = record.entries.length === 1;
                      return (
                        <div style={{ padding: "12px 14px", background: "#fff5f5", borderBottom: "1px solid #f5c6cb", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#c0392b" }}>
                            Delete {dEntry?.day?.slice(0,3)} {dEntry?.date} ({dEntry?.hours || 0}h at {dEntry?.siteName})? Can&apos;t be undone.
                          </span>
                          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                            <button onClick={() => setConfirmDeleteId(null)} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "none", border: "1px solid #ddd", borderRadius: 6, padding: "5px 12px", cursor: "pointer", color: "#888" }}>Cancel</button>
                            <button onClick={async () => {
                              if (lastOne) await onDeleteRecord(record.id);
                              else await onUpdateRecord(record.id, { ...record, entries: record.entries.filter((_, idx) => idx !== di) });
                              setConfirmDeleteId(null);
                            }} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "#c0392b", border: "none", borderRadius: 6, padding: "5px 12px", cursor: "pointer", color: "#fff" }}>Yes, delete</button>
                          </div>
                        </div>
                      );
                    })()}
                    {record.entries.map((entry, i) => (
                      <div key={i} style={{ padding: "10px 14px", borderBottom: "1px solid #f5f2ed", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "grid", gridTemplateColumns: "56px 1fr 1fr 46px", gap: 8, marginBottom: (entryAreas(entry).length || entry.expenses?.length) ? 6 : 0 }}>
                            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa" }}>{entry.day?.slice(0,3)}</span>
                            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#555" }}>{entry.siteName}</span>
                            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#C8A96E" }}>{entry.client}</span>
                            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#1a1a1a", textAlign: "right" }}>{(entry.hours || 0)}h</span>
                          </div>
                          {entryAreas(entry).length > 0 && (
                            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", paddingLeft: 64, marginBottom: 4 }}>
                              {entryAreas(entry).map((a, ai) => (
                                <span key={ai} style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "2px 7px", background: "#f0ece6", borderRadius: 10, color: "#666" }}>{a}</span>
                              ))}
                            </div>
                          )}
                          {entry.expenses?.length > 0 && (
                            <div style={{ paddingLeft: 64 }}>
                              {entry.expenses.map((exp, ei) => (
                                <div key={ei} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888" }}>💰 {exp.description} — <strong>£{(exp.amount || 0).toFixed(2)}</strong></span>
                                  {exp.receipt && (
                                    receiptIsPdf(exp.receipt)
                                      ? <span onClick={() => openReceipt(exp.receipt)} style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: "#888", border: "1px solid #e0dbd4", borderRadius: 4, padding: "3px 6px", cursor: "pointer" }}>📄</span>
                                      : <img src={receiptSrc(exp.receipt)} alt="" style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4, border: "1px solid #e0dbd4", cursor: "pointer" }}
                                          onClick={() => openReceipt(exp.receipt)} />
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        {/* Edit opens the whole submission; Del removes just this day */}
                        {!locked && (
                          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                            <button onClick={() => setEditingId(record.id)} style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, background: "none", border: "1px solid #e0dbd4", borderRadius: 6, padding: "3px 8px", cursor: "pointer", color: "#888" }}>Edit</button>
                            <button onClick={() => setConfirmDeleteId(`${record.id}::${i}`)} style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, background: "none", border: "1px solid #f5c6cb", borderRadius: 6, padding: "3px 8px", cursor: "pointer", color: "#c0392b" }}>Del</button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )
              ))}
            </div>
          );
        });
      })()}
    </div>
  );
}

// ---------- EDIT SUBMISSION ----------
function EditSubmission({ record, sites, allEntries, onSave, onCancel }) {
  const [entries, setEntries] = useState(record.entries.map(e => ({
    ...e,
    hours: String(e.hours ?? ""),
    areas: entryAreas(e),
    areaDraft: "",
    expenses: (e.expenses || []).map(x => ({ ...x, amount: String(x.amount ?? "") }))
  })));
  const [error, setError] = useState("");

  const updateEntry = (i, field, value) => {
    const u = [...entries]; u[i] = { ...u[i], [field]: value }; setEntries(u);
  };
  const addArea = (i, value) => {
    const name = (value ?? entries[i].areaDraft ?? "").trim();
    if (!name) return;
    const u = [...entries];
    const existing = u[i].areas || [];
    if (!existing.some(a => a.toLowerCase() === name.toLowerCase())) u[i] = { ...u[i], areas: [...existing, name], areaDraft: "" };
    else u[i] = { ...u[i], areaDraft: "" };
    setEntries(u);
  };
  const removeArea = (i, name) => {
    const u = [...entries];
    u[i] = { ...u[i], areas: (u[i].areas || []).filter(a => a !== name) };
    setEntries(u);
  };
  const areaSuggestions = (siteId) => {
    if (!siteId) return [];
    const set = new Set();
    (allEntries || []).forEach(r => (r.entries || []).forEach(en => {
      if (en.siteId === siteId) { entryAreas(en).forEach(a => set.add(a)); }
    }));
    return [...set].sort((a, b) => a.localeCompare(b));
  };
  const updateExpense = (i, ei, field, value) => {
    const u = [...entries];
    const exps = [...(u[i].expenses || [])];
    exps[ei] = { ...exps[ei], [field]: value };
    u[i] = { ...u[i], expenses: exps };
    setEntries(u);
  };
  const removeExpense = (i, ei) => {
    const u = [...entries];
    u[i] = { ...u[i], expenses: (u[i].expenses || []).filter((_, idx) => idx !== ei) };
    setEntries(u);
  };
  const removeEntry = (i) => setEntries(entries.filter((_, idx) => idx !== i));

  const save = () => {
    setError("");
    if (entries.length === 0) { setError("A submission needs at least one day."); return; }
    for (const e of entries) {
      const h = parseFloat(e.hours);
      if (!e.hours || isNaN(h) || h <= 0 || h > 24) { setError("Please enter valid hours (0–24) for each day."); return; }
    }
    const site = (id) => sites.find(s => s.id === id);
    const updated = {
      ...record,
      entries: entries.map(e => {
        const s = site(e.siteId);
        const h = parseFloat(e.hours);
        const ot = splitOvertime(e.day, h, e.date);
        // include any un-added draft
        const areas = [...(e.areas || [])];
        if ((e.areaDraft || "").trim() && !areas.some(a => a.toLowerCase() === e.areaDraft.trim().toLowerCase())) areas.push(e.areaDraft.trim());
        return {
          date: e.date,
          day: e.day,
          siteId: e.siteId,
          siteName: s?.name || e.siteName || e.siteId,
          client: s?.client || e.client || "",
          hours: h,
          normalHours: ot.normal,
          overtimeHours: ot.overtime,
          areas,
          expenses: (e.expenses || []).map(x => ({ description: x.description, amount: parseFloat(x.amount) || 0, receipt: x.receipt || null }))
        };
      })
    };
    onSave(updated);
  };

  return (
    <div style={{ marginBottom: 16, border: "2px solid #C8A96E", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", background: "#faf6ef", borderBottom: "1px solid #e8e4de" }}>
        <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 15, fontWeight: 600, color: "#1a1a1a" }}>Editing: {record.fitter}</span>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#aaa", marginLeft: 8 }}>{record.weekLabel}</span>
      </div>

      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
        {entries.map((entry, i) => {
          const selectedSite = sites.find(s => s.id === entry.siteId);
          return (
            <div key={i} style={{ border: "1px solid #e8e4de", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                <select value={entry.date || ""} onChange={e => {
                  const pd = getPeriodDays(record.weekKey);
                  const picked = pd.find(d => d.iso === e.target.value);
                  const u = [...entries];
                  u[i] = { ...u[i], date: picked.iso, day: picked.dayName };
                  setEntries(u);
                }} style={{ ...selectStyle, flex: "1 1 auto", fontSize: 12 }}>
                  {(() => {
                    const pd = getPeriodDays(record.weekKey);
                    // If the stored date isn't in this period (old data), show current day as fallback
                    return (
                      <>
                        <optgroup label="Week 1">
                          {pd.filter(d => d.week === 1).map(d => <option key={d.iso} value={d.iso}>{d.label}</option>)}
                        </optgroup>
                        <optgroup label="Week 2">
                          {pd.filter(d => d.week === 2).map(d => <option key={d.iso} value={d.iso}>{d.label}</option>)}
                        </optgroup>
                      </>
                    );
                  })()}
                </select>
                <div style={{ flex: 1 }} />
                {entries.length > 1 && (
                  <button onClick={() => removeEntry(i)} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "none", border: "1px solid #f5c6cb", borderRadius: 6, padding: "4px 10px", cursor: "pointer", color: "#c0392b" }}>Remove day</button>
                )}
              </div>

              <label style={{ ...labelStyle, marginBottom: 4 }}>Site</label>
              <select value={entry.siteId} onChange={e => { const u = [...entries]; u[i] = { ...u[i], siteId: e.target.value, areas: [], areaDraft: "" }; setEntries(u); }} style={{ ...selectStyle, fontSize: 12 }}>
                <option value="">— Select site —</option>
                {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {selectedSite && (
                <div style={{ marginTop: 6, fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#C8A96E" }}>Client: {selectedSite.client}</div>
              )}

              <label style={{ ...labelStyle, marginTop: 12, marginBottom: 4 }}>Hours</label>
              <input value={entry.hours} onChange={e => updateEntry(i, "hours", e.target.value)} type="number" min="0" max="24" step="0.5" style={{ ...inputStyle, width: 100, fontSize: 12 }} />

              <label style={{ ...labelStyle, marginTop: 12, marginBottom: 6 }}>Areas worked</label>
              {!entry.siteId ? (
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#bbb" }}>Pick a site first.</span>
              ) : (
                <div>
                  {(entry.areas || []).length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                      {entry.areas.map(a => (
                        <span key={a} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "5px 9px", borderRadius: 16, background: "#1a1a1a", color: "#fff" }}>
                          {a}
                          <button onClick={() => removeArea(i, a)} style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 12, padding: 0, lineHeight: 1, opacity: 0.7 }}>×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 6 }}>
                    <input value={entry.areaDraft || ""} onChange={e => updateEntry(i, "areaDraft", e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addArea(i); } }}
                      placeholder="Type an area…" style={{ ...inputStyle, flex: 1, marginBottom: 0, fontSize: 12 }} />
                    <button onClick={() => addArea(i)} style={{ ...btnStyle, marginTop: 0, padding: "8px 14px", fontSize: 12, whiteSpace: "nowrap" }}>+ Add</button>
                  </div>
                  {(() => {
                    const sugg = areaSuggestions(entry.siteId).filter(s => !(entry.areas || []).some(a => a.toLowerCase() === s.toLowerCase()));
                    if (sugg.length === 0) return null;
                    return (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                        {sugg.map(s => (
                          <button key={s} onClick={() => addArea(i, s)} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "5px 10px", borderRadius: 16, border: "1px dashed #c9b896", background: "transparent", color: "#8a7a55", cursor: "pointer" }}>+ {s}</button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              )}

              {(entry.expenses || []).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <label style={{ ...labelStyle, marginBottom: 6 }}>Expenses</label>
                  {entry.expenses.map((exp, ei) => (
                    <div key={ei} style={{ display: "grid", gridTemplateColumns: "1fr 90px 28px", gap: 6, marginBottom: 6, alignItems: "center" }}>
                      <input value={exp.description} onChange={e => updateExpense(i, ei, "description", e.target.value)} style={{ ...inputStyle, fontSize: 12 }} />
                      <input value={exp.amount} onChange={e => updateExpense(i, ei, "amount", e.target.value)} type="number" min="0" step="0.01" style={{ ...inputStyle, fontSize: 12 }} />
                      <button onClick={() => removeExpense(i, ei)} style={{ background: "none", border: "1px solid #eee", borderRadius: 6, color: "#ccc", cursor: "pointer", fontSize: 14, height: 38 }}>×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error && <p style={{ color: "#c0392b", fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "0 14px" }}>{error}</p>}

      <div style={{ padding: 14, display: "flex", gap: 8, justifyContent: "flex-end", borderTop: "1px solid #e8e4de" }}>
        <button onClick={onCancel} style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, background: "none", border: "1px solid #ddd", borderRadius: 6, padding: "8px 16px", cursor: "pointer", color: "#888" }}>Cancel</button>
        <button onClick={save} style={{ ...btnStyle, marginTop: 0, padding: "8px 20px" }}>Save Changes</button>
      </div>
    </div>
  );
}

// ---------- SITES TAB ----------
function SitesTab({ sites, onSitesChange }) {
  const [siteName, setSiteName] = useState("");
  const [client, setClient] = useState("");
  const [otMult, setOtMult] = useState("1.5");
  const [pricing, setPricing] = useState("hourly");
  const [jobPrice, setJobPrice] = useState("");
  const [error, setError] = useState("");
  const addSite = async () => {
    if (!siteName.trim()) { setError("Enter a site name."); return; }
    if (!client.trim()) { setError("Enter a client name."); return; }
    const m = parseFloat(otMult);
    if (isNaN(m) || m < 1) { setError("Overtime multiplier must be 1 or higher (e.g. 1.25 or 1.5)."); return; }
    const p = parseFloat(jobPrice);
    if (pricing === "fixed" && (isNaN(p) || p <= 0)) { setError("Enter the fixed price for this job."); return; }
    await onSitesChange([...sites, {
      id: Date.now().toString(), name: siteName.trim(), client: client.trim(), otMultiplier: m,
      pricing, jobPrice: pricing === "fixed" ? p : null,
    }]);
    setSiteName(""); setClient(""); setOtMult("1.5"); setPricing("hourly"); setJobPrice(""); setError("");
  };
  return (
    <div>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", marginBottom: 20 }}>Add sites, link them to a client, choose how the job is priced, and set the overtime rate.</p>
      <div style={{ background: "#f5f2ed", borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Add Site</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div><label style={labelStyle}>Site Name</label><input value={siteName} onChange={e => { setSiteName(e.target.value); setError(""); }} placeholder="e.g. Chelsea Barracks" style={inputStyle} /></div>
          <div><label style={labelStyle}>Client</label><input value={client} onChange={e => { setClient(e.target.value); setError(""); }} placeholder="e.g. Lanserring" style={inputStyle} /></div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>How is this job priced?</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <select value={pricing} onChange={e => { setPricing(e.target.value); setError(""); }} style={{ ...selectStyle, width: 170 }}>
              <option value="hourly">Hourly (charge per hour)</option>
              <option value="fixed">Fixed price for the job</option>
            </select>
            {pricing === "fixed" && (
              <div style={{ position: "relative" }}>
                <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#aaa" }}>£</span>
                <input value={jobPrice} onChange={e => { setJobPrice(e.target.value); setError(""); }} type="number" min="0" step="50" placeholder="0.00"
                  style={{ ...inputStyle, width: 140, paddingLeft: 22, marginBottom: 0 }} />
              </div>
            )}
          </div>
          <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa" }}>
            {pricing === "fixed"
              ? "Client is billed this price once. Fitters still log hours and are paid hourly as normal."
              : "Client is charged for the hours logged, at the rates you set."}
          </span>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Overtime multiplier</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <select value={otMult} onChange={e => { setOtMult(e.target.value); setError(""); }} style={{ ...selectStyle, width: 120 }}>
              <option value="1.25">1.25×</option>
              <option value="1.5">1.5×</option>
              <option value="1">None (1×)</option>
              <option value="2">2×</option>
            </select>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa" }}>applied to weekend hours &amp; anything over 8.5 hrs/day</span>
          </div>
        </div>
        {error && <p style={{ color: "#c0392b", fontFamily: "'DM Mono', monospace", fontSize: 12, marginBottom: 8 }}>{error}</p>}
        <button onClick={addSite} style={{ ...btnStyle, marginTop: 4, padding: "10px 18px" }}>+ Add Site</button>
      </div>
      {sites.length === 0 ? (
        <p style={{ textAlign: "center", fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#bbb", padding: "24px 0" }}>No sites added yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sites.map(s => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", border: "1px solid #e8e4de", borderRadius: 8, background: "#fff" }}>
              <div>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#1a1a1a" }}>{s.name}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#C8A96E", marginLeft: 10 }}>→ {s.client}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", marginLeft: 10 }}>OT {s.otMultiplier ?? 1.5}×</span>
                {s.pricing === "fixed"
                  ? <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#1a6f4b", background: "#eaf6f0", borderRadius: 5, padding: "2px 7px", marginLeft: 10 }}>Fixed {toGBP(s.jobPrice || 0)}</span>
                  : <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#888", background: "#f2efeb", borderRadius: 5, padding: "2px 7px", marginLeft: 10 }}>Hourly</span>}
              </div>
              <button onClick={() => onSitesChange(sites.filter(x => x.id !== s.id))} style={{ background: "none", border: "1px solid #eee", borderRadius: 6, padding: "4px 10px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa", cursor: "pointer" }}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- MAIN ----------
export default function App() {
  const [view, setView] = useState("fitter");
  const [fitterName, setFitterName] = useState(null);
  const [allEntries, setAllEntries] = useState([]);
  const [sites, setSites] = useState([]);
  const [rates, setRates] = useState({});
  const [lockedWeeks, setLockedWeeks] = useState([]);
  const [fittersList, setFittersList] = useState([]);
  const [pins, setPins] = useState({});
  const [noIndigo, setNoIndigo] = useState([]); // fitters excluded from the Indigo payment sheet
  const [billedJobs, setBilledJobs] = useState({}); // fixed-price jobs already billed: { siteId: weekKey }
  const [extraDays, setExtraDays] = useState({}); // on fixed jobs, days Tom marks as chargeable extras: { dayKey: true }
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    refreshBankHolidays(); // update UK bank-holiday dates from GOV.UK (falls back silently)
    Promise.all([
      load("finefit_entries"), loadStr("finefit_fitter_name"),
      load("finefit_sites"), load("finefit_tasks"), load("finefit_rates"),
      load("finefit_locked_weeks"), load("finefit_fitters"), load("finefit_pins"), load("finefit_no_indigo"), load("finefit_billed_jobs"), load("finefit_extra_days"),
    ]).then(([entries, name, savedSites, _savedTasks, savedRates, savedLocks, savedFitters, savedPins, savedNoIndigo, savedBilled, savedExtra]) => {
      setAllEntries(entries || []);
      if (name) setFitterName(name);
      setSites(savedSites || []);
      setRates(savedRates || {});
      setLockedWeeks(savedLocks || []);
      setFittersList(savedFitters || []);
      setPins(savedPins || {});
      setNoIndigo(savedNoIndigo || []);
      setBilledJobs(savedBilled || {});
      setExtraDays(savedExtra || {});
      setLoading(false);
    });
  }, []);

  const handleSitesChange = async (u) => { setSites(u); await save("finefit_sites", u); };
  const handleRatesChange = async (u) => { setRates(u); await save("finefit_rates", u); };
  const handleSubmit = async (record) => { const u = [...allEntries, record]; setAllEntries(u); await save("finefit_entries", u); };
  const handleDeleteRecord = async (recordId) => { const u = allEntries.filter(r => r.id !== recordId); setAllEntries(u); await save("finefit_entries", u); };
  const handleUpdateRecord = async (recordId, updatedRecord) => { const u = allEntries.map(r => r.id === recordId ? updatedRecord : r); setAllEntries(u); await save("finefit_entries", u); };
  const handleFitterLogout = async () => { await del("finefit_fitter_name"); setFitterName(null); };
  const handleToggleLock = async (weekKey) => {
    const u = lockedWeeks.includes(weekKey) ? lockedWeeks.filter(w => w !== weekKey) : [...lockedWeeks, weekKey];
    setLockedWeeks(u); await save("finefit_locked_weeks", u);
  };
  const handleFittersChange = async (u) => { setFittersList(u); await save("finefit_fitters", u); };
  const handleSetPin = async (name, hash) => { const u = { ...pins, [name]: hash }; setPins(u); await save("finefit_pins", u); };
  const handleResetPin = async (name) => { const u = { ...pins }; delete u[name]; setPins(u); await save("finefit_pins", u); };
  const handleToggleExtraDay = async (dayKey) => {
    const u = { ...extraDays };
    if (u[dayKey]) delete u[dayKey]; else u[dayKey] = true;
    setExtraDays(u); await save("finefit_extra_days", u);
  };
  const handleToggleBilledJob = async (siteId, weekKey) => {
    const u = { ...billedJobs };
    if (u[siteId] === weekKey) delete u[siteId]; else u[siteId] = weekKey;
    setBilledJobs(u); await save("finefit_billed_jobs", u);
  };
  const handleToggleIndigo = async (name) => {
    const u = noIndigo.includes(name) ? noIndigo.filter(n => n !== name) : [...noIndigo, name];
    setNoIndigo(u); await save("finefit_no_indigo", u);
  };
  const isFitter = view === "fitter";

  return (
    <div style={{ minHeight: "100vh", background: "#f5f2ed" }}>
      <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      <header style={{ background: "#fff", borderBottom: "1px solid #e8e4de", padding: "14px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 10 }}>
        <Logo />
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setView("fitter")} style={{ ...tabBtn, background: isFitter ? "#1a1a1a" : "transparent", color: isFitter ? "#fff" : "#888" }}>Fitter</button>
          <button onClick={() => setView(view === "admin" ? "fitter" : "adminLogin")} style={{ ...tabBtn, background: !isFitter ? "#1a1a1a" : "transparent", color: !isFitter ? "#fff" : "#888" }}>Admin</button>
        </div>
      </header>
      <main style={{ maxWidth: 700, margin: "0 auto", padding: "32px 20px" }}>
        <div style={{ background: "#fff", borderRadius: 14, padding: "32px 28px", boxShadow: "0 2px 20px rgba(0,0,0,0.06)", border: "1px solid #e8e4de" }}>
          {loading ? (
            <p style={{ textAlign: "center", fontFamily: "'DM Mono', monospace", color: "#aaa" }}>Loading…</p>
          ) : view === "fitter" ? (
            fitterName
              ? <FitterForm fitterName={fitterName} onLogout={handleFitterLogout} onSubmit={handleSubmit} sites={sites}
                  allEntries={allEntries} lockedWeeks={lockedWeeks} rates={rates} onDeleteRecord={handleDeleteRecord} onUpdateRecord={handleUpdateRecord} />
              : <FitterLogin fittersList={fittersList} pins={pins} onSetPin={handleSetPin} onLogin={async (n) => { await saveStr("finefit_fitter_name", n); setFitterName(n); }} />
          ) : view === "adminLogin" ? (
            <AdminLogin onLogin={() => setView("admin")} />
          ) : (
            <AdminDashboard allEntries={allEntries} sites={sites} rates={rates}
              lockedWeeks={lockedWeeks} fittersList={fittersList} pins={pins} noIndigo={noIndigo} billedJobs={billedJobs} onToggleBilledJob={handleToggleBilledJob} extraDays={extraDays} onToggleExtraDay={handleToggleExtraDay} onSitesChange={handleSitesChange}
              onRatesChange={handleRatesChange} onDeleteRecord={handleDeleteRecord} onFittersChange={handleFittersChange} onResetPin={handleResetPin} onToggleIndigo={handleToggleIndigo}
              onUpdateRecord={handleUpdateRecord} onToggleLock={handleToggleLock} onLogout={() => setView("fitter")} />
          )}
        </div>
      </main>
    </div>
  );
}

// ---------- STYLES ----------
const inputStyle = { width: "100%", boxSizing: "border-box", padding: "10px 12px", border: "1px solid #e0dbd4", borderRadius: 8, fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#1a1a1a", background: "#fafaf8", outline: "none" };
const selectStyle = { ...inputStyle, cursor: "pointer" };
const labelStyle = { display: "block", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 };
const btnStyle = { background: "#1a1a1a", color: "#fff", border: "none", borderRadius: 8, padding: "12px 22px", fontFamily: "'DM Mono', monospace", fontSize: 13, cursor: "pointer", marginTop: 12 };
const addRowBtn = { background: "transparent", border: "1px dashed #C8A96E", color: "#C8A96E", borderRadius: 6, padding: "6px 14px", fontFamily: "'DM Mono', monospace", fontSize: 12, cursor: "pointer" };
const removeBtn = { background: "transparent", border: "none", color: "#bbb", borderRadius: 6, padding: "4px 10px", fontFamily: "'DM Mono', monospace", fontSize: 11, cursor: "pointer" };
const tabBtn = { border: "none", borderRadius: 6, padding: "6px 14px", fontFamily: "'DM Mono', monospace", fontSize: 11, cursor: "pointer", letterSpacing: "0.05em" };
const tdStyle = { padding: "9px 10px", fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#444" };
