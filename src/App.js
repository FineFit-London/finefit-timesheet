{
  "name": "finefit-timesheet",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-scripts": "5.0.1",
    "firebase": "^10.7.0"
  },
  "scripts": {
    "start": "react-scripts start",
    "build": "react-scripts build"
  },
  "browserslist": {
    "production": [">0.2%", "not dead"],
    "development": ["last 1 chrome version"]
  }
}

{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}

<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#1a1a1a" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="FineFit" />
    <link rel="manifest" href="%PUBLIC_URL%/manifest.json" />
    <title>FineFit London</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>

{
  "short_name": "FineFit",
  "name": "FineFit London Timesheet",
  "start_url": ".",
  "display": "standalone",
  "theme_color": "#1a1a1a",
  "background_color": "#f5f2ed"
}

import { useState, useEffect, useRef } from "react";
import { db } from "./firebase";
import { doc, getDoc, setDoc } from "firebase/firestore";

const ADMIN_PASSWORD = "finefit2024";
const DEVICE_ID = (() => {
  let id = localStorage.getItem("finefit_device_id");
  if (!id) { id = Math.random().toString(36).slice(2); localStorage.setItem("finefit_device_id", id); }
  return id;
})();
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAYS_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function getWeekStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
function formatDate(date) {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function getCurrentWeekLabel() {
  const start = getWeekStart();
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${formatDate(start)} – ${formatDate(end)}`;
}
function getWeekKey() { return getWeekStart().toISOString().split("T")[0]; }
function toGBP(n) { return "£" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
function weekEndLabel(weekKey) {
  if (!weekKey || weekKey === "all") return "";
  const start = new Date(weekKey);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return end.toLocaleDateString("en-GB");
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
function FitterLogin({ onLogin }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const handle = async () => {
    if (!name.trim()) { setError("Please enter your name."); return; }
    await saveStr("finefit_fitter_name", name.trim());
    onLogin(name.trim());
  };
  return (
    <div>
      <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 24, marginBottom: 6, color: "#1a1a1a" }}>Welcome</h2>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", marginBottom: 28 }}>Enter your name to get started. We'll remember it on this device.</p>
      <label style={labelStyle}>Your Name</label>
      <input value={name} onChange={e => { setName(e.target.value); setError(""); }}
        onKeyDown={e => e.key === "Enter" && handle()}
        placeholder="e.g. James Hargreaves"
        style={{ ...inputStyle, borderColor: error ? "#c0392b" : undefined }} autoFocus />
      {error && <p style={{ color: "#c0392b", fontFamily: "'DM Mono', monospace", fontSize: 12, marginTop: 8 }}>{error}</p>}
      <button onClick={handle} style={{ ...btnStyle, marginTop: 20, width: "100%" }}>Continue</button>
    </div>
  );
}

// ---------- FITTER FORM ----------
function FitterForm({ fitterName, onLogout, onSubmit, sites, tasks }) {
  const emptyEntry = () => ({ day: "Monday", siteId: "", hours: "", tasks: [], expenses: [] });
  const emptyExpense = () => ({ description: "", amount: "", receipt: null });
  const [entries, setEntries] = useState([emptyEntry()]);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const fileRefs = useRef({});

  const updateEntry = (i, field, value) => {
    const updated = [...entries];
    updated[i] = { ...updated[i], [field]: value };
    setEntries(updated);
  };
  const toggleTask = (i, taskId) => {
    const current = entries[i].tasks;
    const next = current.includes(taskId) ? current.filter(t => t !== taskId) : [...current, taskId];
    updateEntry(i, "tasks", next);
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
    const reader = new FileReader();
    reader.onload = (e) => updateExpense(i, ei, "receipt", e.target.result);
    reader.readAsDataURL(file);
  };
  const removeExpense = (i, ei) => {
    const updated = [...entries];
    updated[i] = { ...updated[i], expenses: (updated[i].expenses || []).filter((_, idx) => idx !== ei) };
    setEntries(updated);
  };
  const addEntry = () => setEntries([...entries, emptyEntry()]);
  const removeEntry = (i) => setEntries(entries.filter((_, idx) => idx !== i));

  const handleSubmit = async () => {
    setError("");
    for (const e of entries) {
      if (!e.siteId) { setError("Please select a site for each entry."); return; }
      const h = parseFloat(e.hours);
      if (!e.hours || isNaN(h) || h <= 0 || h > 24) { setError("Please enter valid hours (0–24) for each entry."); return; }
      if (e.tasks.length === 0) { setError("Please select at least one task for each entry."); return; }
      for (const exp of (e.expenses || [])) {
        if (!exp.description.trim()) { setError("Please add a description for each expense."); return; }
        if (!exp.amount || isNaN(parseFloat(exp.amount)) || parseFloat(exp.amount) <= 0) { setError("Please enter a valid amount for each expense."); return; }
      }
    }
    const site = (id) => sites.find(s => s.id === id);
    const taskLabel = (id) => tasks.find(t => t.id === id)?.name || id;
    const record = {
      id: Date.now(),
      fitter: fitterName,
      weekKey: getWeekKey(),
      weekLabel: getCurrentWeekLabel(),
      submittedAt: new Date().toISOString(),
      entries: entries.map(e => ({
        day: e.day,
        siteId: e.siteId,
        siteName: site(e.siteId)?.name || e.siteId,
        client: site(e.siteId)?.client || "",
        hours: parseFloat(e.hours),
        tasks: e.tasks.map(id => ({ id, label: taskLabel(id) })),
        expenses: (e.expenses || []).map(exp => ({
          description: exp.description.trim(),
          amount: parseFloat(exp.amount),
          receipt: exp.receipt || null
        }))
      }))
    };
    await onSubmit(record);
    setSubmitted(true);
  };

  if (sites.length === 0 || tasks.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "48px 20px" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>⚙️</div>
        <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#888" }}>
          {sites.length === 0 && tasks.length === 0 ? "No sites or tasks set up yet." : sites.length === 0 ? "No sites set up yet." : "No tasks set up yet."}
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
        <button onClick={() => { setSubmitted(false); setEntries([emptyEntry()]); }} style={btnStyle}>Submit more</button>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, marginBottom: 2, color: "#1a1a1a" }}>Hi, {fitterName}</h2>
          <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", margin: 0 }}>Week: {getCurrentWeekLabel()}</p>
        </div>
        <button onClick={onLogout} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "none", border: "1px solid #e0dbd4", borderRadius: 6, padding: "5px 10px", cursor: "pointer", color: "#aaa", marginTop: 4 }}>Not you?</button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {entries.map((entry, i) => {
          const selectedSite = sites.find(s => s.id === entry.siteId);
          const expTotal = (entry.expenses || []).reduce((a, e) => a + (parseFloat(e.amount) || 0), 0);
          return (
            <div key={i} style={{ border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ background: "#f5f2ed", padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #e8e4de" }}>
                <select value={entry.day} onChange={e => updateEntry(i, "day", e.target.value)} style={{ ...selectStyle, flex: "0 0 130px" }}>
                  {DAYS.map(d => <option key={d}>{d}</option>)}
                </select>
                <div style={{ flex: 1 }} />
                {entries.length > 1 && (
                  <button onClick={() => removeEntry(i)} style={{ ...removeBtn, border: "none", fontSize: 14 }}>✕ Remove</button>
                )}
              </div>

              <div style={{ padding: "14px" }}>
                {/* Site */}
                <label style={{ ...labelStyle, marginBottom: 4 }}>Site</label>
                <select value={entry.siteId} onChange={e => updateEntry(i, "siteId", e.target.value)} style={selectStyle}>
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

                {/* Tasks */}
                <label style={{ ...labelStyle, marginTop: 14, marginBottom: 8 }}>Tasks completed</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {tasks.map(task => {
                    const checked = entry.tasks.includes(task.id);
                    return (
                      <button key={task.id} onClick={() => toggleTask(i, task.id)}
                        style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, padding: "6px 12px", borderRadius: 20,
                          border: `1px solid ${checked ? "#1a1a1a" : "#e0dbd4"}`,
                          background: checked ? "#1a1a1a" : "transparent",
                          color: checked ? "#fff" : "#888", cursor: "pointer" }}>
                        {task.name}
                      </button>
                    );
                  })}
                </div>

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
                        <input type="file" accept="image/*" capture="environment"
                          style={{ display: "none" }}
                          ref={el => { if (!fileRefs.current[`${i}-${ei}`]) fileRefs.current[`${i}-${ei}`] = el; fileRefs.current[`${i}-${ei}`] = el; }}
                          onChange={e => handleReceiptUpload(i, ei, e.target.files[0])} />
                        <button onClick={() => fileRefs.current[`${i}-${ei}`]?.click()}
                          style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "none", border: "1px dashed #e0dbd4", borderRadius: 6, padding: "5px 10px", cursor: "pointer", color: "#888", display: "flex", alignItems: "center", gap: 5 }}>
                          📷 {exp.receipt ? "Receipt attached ✓" : "Attach receipt"}
                        </button>
                        {exp.receipt && (
                          <img src={exp.receipt} alt="receipt" style={{ height: 36, width: 36, objectFit: "cover", borderRadius: 4, border: "1px solid #e0dbd4" }} />
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
      {error && <p style={{ color: "#c0392b", fontFamily: "'DM Mono', monospace", fontSize: 12, marginTop: 16 }}>{error}</p>}
      <button onClick={handleSubmit} style={{ ...btnStyle, marginTop: 20, width: "100%" }}>Submit Hours & Expenses</button>
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
function AdminDashboard({ allEntries, sites, tasks, rates, onSitesChange, onTasksChange, onRatesChange, onLogout }) {
  const [tab, setTab] = useState("submissions");
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ fontFamily: "'Playfair Display', serif", fontSize: 22, color: "#1a1a1a", margin: 0 }}>Admin</h2>
        <button onClick={onLogout} style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, background: "none", border: "1px solid #ddd", borderRadius: 6, padding: "6px 12px", cursor: "pointer", color: "#888" }}>Log out</button>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 24, background: "#f5f2ed", borderRadius: 8, padding: 4 }}>
        {[["submissions", "Timesheets"], ["report", "Invoices"], ["rates", "Rates"], ["sites", "Sites"], ["tasks", "Tasks"]].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} style={{
            flex: 1, fontFamily: "'DM Mono', monospace", fontSize: 11, padding: "8px 0",
            border: "none", borderRadius: 6, cursor: "pointer",
            background: tab === key ? "#1a1a1a" : "transparent",
            color: tab === key ? "#fff" : "#888"
          }}>{label}</button>
        ))}
      </div>
      {tab === "submissions" && <SubmissionsTab allEntries={allEntries} />}
      {tab === "report" && <InvoicesTab allEntries={allEntries} rates={rates} />}
      {tab === "rates" && <RatesTab allEntries={allEntries} rates={rates} onRatesChange={onRatesChange} />}
      {tab === "sites" && <SitesTab sites={sites} onSitesChange={onSitesChange} />}
      {tab === "tasks" && <TasksTab tasks={tasks} onTasksChange={onTasksChange} />}
    </div>
  );
}

// ---------- RATES TAB ----------
function RatesTab({ allEntries, rates, onRatesChange }) {
  // Build unique fitter+site pairs from all submissions
  const pairs = [];
  const seen = new Set();
  allEntries.forEach(record => {
    record.entries.forEach(en => {
      const key = `${record.fitter}|||${en.siteName}`;
      if (!seen.has(key)) { seen.add(key); pairs.push({ fitter: record.fitter, site: en.siteName }); }
    });
  });

  const [edits, setEdits] = useState({});
  const [saved, setSaved] = useState(false);

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

  return (
    <div>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", marginBottom: 20 }}>
        Set two rates per fitter per site: what you charge the client, and what you pay the fitter.
      </p>
      {pairs.length === 0 ? (
        <p style={{ textAlign: "center", fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#bbb", padding: "32px 0" }}>
          Rates appear here once fitters start submitting hours.
        </p>
      ) : (
        <>
          <div style={{ border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
            <div style={{ background: "#1a1a1a", padding: "10px 14px", display: "grid", gridTemplateColumns: "1fr 1fr 110px 110px", gap: 10 }}>
              {["Fitter", "Site", "Client Rate £/hr", "Fitter Rate £/hr"].map(h => (
                <span key={h} style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#C8A96E", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</span>
              ))}
            </div>
            {pairs.map(({ fitter, site }) => (
              <div key={`${fitter}|||${site}`} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 110px 110px", gap: 10, padding: "10px 14px", borderBottom: "1px solid #f5f2ed", alignItems: "center" }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#1a1a1a" }}>{fitter}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888" }}>{site}</span>
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa" }}>£</span>
                  <input value={getClientRate(fitter, site)} onChange={e => setEdit(fitter, site, "client", e.target.value)}
                    type="number" min="0" step="0.5" placeholder="0.00"
                    style={{ ...inputStyle, paddingLeft: 20, fontSize: 12 }} />
                </div>
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa" }}>£</span>
                  <input value={getFitterRate(fitter, site)} onChange={e => setEdit(fitter, site, "fitter", e.target.value)}
                    type="number" min="0" step="0.5" placeholder="0.00"
                    style={{ ...inputStyle, paddingLeft: 20, fontSize: 12 }} />
                </div>
              </div>
            ))}
          </div>
          <button onClick={saveAll} style={{ ...btnStyle, marginTop: 0, padding: "11px 24px", background: saved ? "#2ecc71" : "#1a1a1a" }}>
            {saved ? "✓ Saved!" : "Save All Rates"}
          </button>
        </>
      )}
    </div>
  );
}

// ---------- INVOICES TAB ----------
function InvoicesTab({ allEntries, rates }) {
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

  // Build aggregated fitter+site totals
  const fitterSiteTotals = {};
  filtered.forEach(record => {
    const entries = filterClient === "all" ? record.entries : record.entries.filter(en => en.client === filterClient);
    entries.forEach(en => {
      const key = `${record.fitter}|||${en.siteName}|||${en.client}`;
      if (!fitterSiteTotals[key]) fitterSiteTotals[key] = { fitter: record.fitter, site: en.siteName, client: en.client, hours: 0, expenses: [] };
      fitterSiteTotals[key].hours += (en.hours || 0);
      (en.expenses || []).forEach(exp => fitterSiteTotals[key].expenses.push(exp));
    });
  });

  const lines = Object.values(fitterSiteTotals).map(({ fitter, site, client, hours, expenses }) => {
    const rateKey = `${fitter}|||${site}`;
    const clientRate = parseFloat(rates[rateKey]?.client) || 0;
    const fitterRate = parseFloat(rates[rateKey]?.fitter) || 0;
    const expTotal = expenses.reduce((a, e) => a + (e.amount || 0), 0);
    return { fitter, site, client, hours, clientRate, fitterRate, clientCost: hours * clientRate, fitterCost: hours * fitterRate, expTotal, expenses };
  });

  const clientTotal = lines.reduce((a, l) => a + l.clientCost, 0);
  const fitterTotal = lines.reduce((a, l) => a + l.fitterCost, 0);
  const allExpenses = lines.flatMap(l => l.expenses);
  const totalExpenses = allExpenses.reduce((a, e) => a + (e.amount || 0), 0);
  const clientGrandTotal = clientTotal + totalExpenses;
  const fitterGrandTotal = fitterTotal + totalExpenses;

  const contactName = filterClient !== "all" ? filterClient : "Client";
  const we = weekEndLabel(filterWeek);

  // Print client invoice
  const printClientInvoice = () => {
    const rows = lines.map(l => `
      <tr>
        <td>${l.fitter}</td><td>${l.site}</td>
        <td style="text-align:right">${l.hours.toFixed(2)}</td>
        <td style="text-align:right">£${l.clientRate.toFixed(2)}</td>
        <td style="text-align:right"><strong>£${l.clientCost.toFixed(2)}</strong></td>
      </tr>`).join("");
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
      <div><div class="label">Bill To</div><strong>${contactName}</strong><br/>W/E ${we}</div>
      <div><div class="label">Invoice Date</div>${invoiceDate}<br/><div class="label" style="margin-top:8px">Invoice Number</div>${invoiceNum}</div>
      <div><div class="label">Fine Fit London</div>23 Odell Walk<br/>London SE13 7DP<br/><div class="label" style="margin-top:6px">VAT Number</div>310008672</div>
    </div>
    <table>
      <thead><tr><th>Fitter</th><th>Job</th><th>Hours</th><th>Rate £/hr</th><th>Cost</th></tr></thead>
      <tbody>${rows}${expRows}
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
    const win = window.open("", "_blank");
    win.document.write(html); win.document.close(); win.focus();
    setTimeout(() => win.print(), 400);
  };

  // Print Indigo payment sheet
  const printIndigoSheet = () => {
    const rows = lines.map((l, idx) => `
      <tr style="background:${idx % 2 === 0 ? "#fff" : "#f9f9f9"}">
        <td style="padding:7px 10px">${idx + 1}</td>
        <td style="padding:7px 10px"><strong>${l.fitter}</strong></td>
        <td style="padding:7px 10px;color:#888;font-size:11px;">${l.fitterRate > 0 ? `£${l.fitterRate.toFixed(2)}/hr` : "—"}</td>
        <td style="padding:7px 10px;text-align:right">${l.hours.toFixed(2)}</td>
        <td style="padding:7px 10px;text-align:right">£${l.fitterRate.toFixed(2)}</td>
        <td style="padding:7px 10px;text-align:right"><strong>£${l.fitterCost.toFixed(2)}</strong></td>
        <td style="padding:7px 10px">${l.site}</td>
      </tr>`).join("");
    const expRows = allExpenses.length > 0 ? allExpenses.map(exp => `
      <tr style="background:#fff8f0">
        <td></td>
        <td colspan="2" style="padding:6px 10px;font-size:11px;color:#888">EXPENSES: ${exp.description}</td>
        <td style="padding:6px 10px;text-align:right;font-size:11px">1.00</td>
        <td style="padding:6px 10px;text-align:right;font-size:11px">£${(exp.amount || 0).toFixed(2)}</td>
        <td style="padding:6px 10px;text-align:right;font-size:11px">£${(exp.amount || 0).toFixed(2)}</td>
        <td></td>
      </tr>`).join("") : "";
    const html = `<!DOCTYPE html><html><head><title>FineFit Payment Sheet W/E ${we}</title>
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
    <div class="meta">NAME: FineFit London &nbsp;|&nbsp; W/E: ${we}${filterClient !== "all" ? ` &nbsp;|&nbsp; ${contactName}` : ""} &nbsp;|&nbsp; Invoice: ${invoiceNum}</div>
    <table>
      <thead><tr><th>#</th><th>Fitter</th><th>Rate</th><th>Hours</th><th>£/hr</th><th>Gross</th><th>Site Ref</th></tr></thead>
      <tbody>
        ${rows}${expRows}
        <tr class="total-row"><td colspan="5">EXPENSES TOTAL</td><td>£${totalExpenses.toFixed(2)}</td><td></td></tr>
        <tr class="grand"><td colspan="5">TOTAL FITTER PAYMENT</td><td>£${fitterGrandTotal.toFixed(2)}</td><td></td></tr>
      </tbody>
    </table>
    <p style="margin-top:24px;font-size:11px;color:#888">Generated ${new Date().toLocaleDateString("en-GB")} &nbsp;|&nbsp; Fine Fit London Limited &nbsp;|&nbsp; Company No. 11244546</p>
    </body></html>`;
    const win = window.open("", "_blank");
    win.document.write(html); win.document.close(); win.focus();
    setTimeout(() => win.print(), 400);
  };

  // Xero CSV
  const downloadXeroCSV = () => {
    const headers = ["ContactName","InvoiceNumber","InvoiceDate","DueDate","Description","Quantity","UnitAmount","AccountCode","TaxType","Currency"];
    const rows = [
      ...lines.map(l => [contactName, invoiceNum, invoiceDate, dueDate, `${l.fitter} - ${l.site}`, l.hours.toFixed(2), l.clientRate.toFixed(2), "200", "RRSINPUT", "GBP"]),
      ...(totalExpenses > 0 ? [[contactName, invoiceNum, invoiceDate, dueDate, "Materials and Expenses", "1", totalExpenses.toFixed(2), "200", "RRSINPUT", "GBP"]] : [])
    ];
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${invoiceNum}_xero.csv`; a.click();
  };

  const hasRates = lines.some(l => l.clientRate > 0 || l.fitterRate > 0);

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
                  {lines.map((l, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #f5f2ed" }}>
                      <td style={tdStyle}>{l.fitter}</td>
                      <td style={{ ...tdStyle, color: "#888" }}>{l.site}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{l.hours.toFixed(2)}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{l.clientRate > 0 ? `£${l.clientRate.toFixed(2)}` : <span style={{ color: "#f39c12" }}>Set rate</span>}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{l.clientRate > 0 ? toGBP(l.clientCost) : "—"}</td>
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
            <div style={{ border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden", marginBottom: 16 }}>
              <div style={{ background: "#1a1a1a", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 16, color: "#fff", fontWeight: 700 }}>Indigo Payment Sheet</span>
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", marginLeft: 10 }}>W/E {we}</span>
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
                  {lines.map((l, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #f5f2ed" }}>
                      <td style={tdStyle}>{l.fitter}</td>
                      <td style={{ ...tdStyle, color: "#888" }}>{l.site}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{l.hours.toFixed(2)}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace" }}>{l.fitterRate > 0 ? `£${l.fitterRate.toFixed(2)}` : <span style={{ color: "#f39c12" }}>Set rate</span>}</td>
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{l.fitterRate > 0 ? toGBP(l.fitterCost) : "—"}</td>
                    </tr>
                  ))}
                  {allExpenses.map((exp, i) => (
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
                    <img src={exp.receipt} alt={exp.description} style={{ width: 80, height: 80, objectFit: "cover", borderRadius: 8, border: "1px solid #e8e4de", display: "block", cursor: "pointer" }}
                      onClick={() => window.open(exp.receipt, "_blank")} />
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#aaa", display: "block", marginTop: 4 }}>{exp.description}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

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
function SubmissionsTab({ allEntries }) {
  const [filterWeek, setFilterWeek] = useState("all");
  const [filterFitter, setFilterFitter] = useState("all");
  const [filterClient, setFilterClient] = useState("all");

  const weeks = [...new Set(allEntries.map(e => e.weekKey))].sort().reverse();
  const fitters = [...new Set(allEntries.map(e => e.fitter))].sort();
  const clients = [...new Set(allEntries.flatMap(e => e.entries.map(en => en.client)).filter(Boolean))].sort();

  const filtered = allEntries.filter(record => {
    if (filterWeek !== "all" && record.weekKey !== filterWeek) return false;
    if (filterFitter !== "all" && record.fitter !== filterFitter) return false;
    if (filterClient !== "all" && !record.entries.some(en => en.client === filterClient)) return false;
    return true;
  });

  const flatEntries = filtered.flatMap(record =>
    record.entries
      .filter(en => filterClient === "all" || en.client === filterClient)
      .map(en => ({ ...en, fitter: record.fitter }))
  );
  const totalHours = flatEntries.reduce((a, e) => a + (e.hours || 0), 0);
  const grouped = {};
  filtered.forEach(r => {
    const entries = filterClient === "all" ? r.entries : r.entries.filter(en => en.client === filterClient);
    if (entries.length === 0) return;
    if (!grouped[r.fitter]) grouped[r.fitter] = [];
    grouped[r.fitter].push({ ...r, entries });
  });

  return (
    <div>
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
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", marginBottom: 16 }}>{flatEntries.length} entr{flatEntries.length !== 1 ? "ies" : "y"} · {totalHours.toFixed(1)} hrs</p>
      {Object.keys(grouped).length === 0 ? (
        <div style={{ textAlign: "center", padding: "40px 0", color: "#bbb", fontFamily: "'DM Mono', monospace", fontSize: 13 }}>No submissions match these filters.</div>
      ) : Object.entries(grouped).map(([fitter, records]) => (
        <div key={fitter} style={{ marginBottom: 16, border: "1px solid #e8e4de", borderRadius: 10, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", background: "#f5f2ed", borderBottom: "1px solid #e8e4de", display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontFamily: "'Playfair Display', serif", fontSize: 15, fontWeight: 600, color: "#1a1a1a" }}>{fitter}</span>
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888" }}>
              {records.flatMap(r => r.entries).reduce((a, e) => a + (e.hours || 0), 0).toFixed(1)} hrs
            </span>
          </div>
          {records.flatMap(r => r.entries.map((entry, i) => (
            <div key={`${r.id}-${i}`} style={{ padding: "10px 14px", borderBottom: "1px solid #f5f2ed" }}>
              <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 1fr 50px", gap: 8, marginBottom: (entry.tasks?.length || entry.expenses?.length) ? 6 : 0 }}>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa" }}>{entry.day?.slice(0,3)}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#555" }}>{entry.siteName}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#C8A96E" }}>{entry.client}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#1a1a1a", textAlign: "right" }}>{(entry.hours || 0)}h</span>
              </div>
              {entry.tasks?.length > 0 && (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", paddingLeft: 88, marginBottom: 4 }}>
                  {entry.tasks.map(t => (
                    <span key={t.id} style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, padding: "2px 7px", background: "#f0ece6", borderRadius: 10, color: "#666" }}>{t.label}</span>
                  ))}
                </div>
              )}
              {entry.expenses?.length > 0 && (
                <div style={{ paddingLeft: 88 }}>
                  {entry.expenses.map((exp, ei) => (
                    <div key={ei} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888" }}>💰 {exp.description} — <strong>£{(exp.amount || 0).toFixed(2)}</strong></span>
                      {exp.receipt && (
                        <img src={exp.receipt} alt="" style={{ width: 28, height: 28, objectFit: "cover", borderRadius: 4, border: "1px solid #e0dbd4", cursor: "pointer" }}
                          onClick={() => window.open(exp.receipt, "_blank")} />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )))}
        </div>
      ))}
    </div>
  );
}

// ---------- SITES TAB ----------
function SitesTab({ sites, onSitesChange }) {
  const [siteName, setSiteName] = useState("");
  const [client, setClient] = useState("");
  const [error, setError] = useState("");
  const addSite = async () => {
    if (!siteName.trim()) { setError("Enter a site name."); return; }
    if (!client.trim()) { setError("Enter a client name."); return; }
    await onSitesChange([...sites, { id: Date.now().toString(), name: siteName.trim(), client: client.trim() }]);
    setSiteName(""); setClient(""); setError("");
  };
  return (
    <div>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", marginBottom: 20 }}>Add sites and link them to a client.</p>
      <div style={{ background: "#f5f2ed", borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Add Site</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
          <div><label style={labelStyle}>Site Name</label><input value={siteName} onChange={e => { setSiteName(e.target.value); setError(""); }} placeholder="e.g. Chelsea Barracks" style={inputStyle} /></div>
          <div><label style={labelStyle}>Client</label><input value={client} onChange={e => { setClient(e.target.value); setError(""); }} placeholder="e.g. Lanserring" style={inputStyle} /></div>
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
              </div>
              <button onClick={() => onSitesChange(sites.filter(x => x.id !== s.id))} style={{ background: "none", border: "1px solid #eee", borderRadius: 6, padding: "4px 10px", fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#aaa", cursor: "pointer" }}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- TASKS TAB ----------
function TasksTab({ tasks, onTasksChange }) {
  const [taskName, setTaskName] = useState("");
  const [error, setError] = useState("");
  const addTask = async () => {
    if (!taskName.trim()) { setError("Enter a task name."); return; }
    if (tasks.find(t => t.name.toLowerCase() === taskName.trim().toLowerCase())) { setError("Task already exists."); return; }
    await onTasksChange([...tasks, { id: Date.now().toString(), name: taskName.trim() }]);
    setTaskName(""); setError("");
  };
  return (
    <div>
      <p style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#888", marginBottom: 20 }}>Add task types fitters can log against each day's work.</p>
      <div style={{ background: "#f5f2ed", borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Add Task</div>
        <label style={labelStyle}>Task Name</label>
        <input value={taskName} onChange={e => { setTaskName(e.target.value); setError(""); }}
          onKeyDown={e => e.key === "Enter" && addTask()}
          placeholder="e.g. First fix, Second fix, Plastering…" style={inputStyle} />
        {error && <p style={{ color: "#c0392b", fontFamily: "'DM Mono', monospace", fontSize: 12, marginTop: 8, marginBottom: 0 }}>{error}</p>}
        <button onClick={addTask} style={{ ...btnStyle, marginTop: 12, padding: "10px 18px" }}>+ Add Task</button>
      </div>
      {tasks.length === 0 ? (
        <p style={{ textAlign: "center", fontFamily: "'DM Mono', monospace", fontSize: 13, color: "#bbb", padding: "24px 0" }}>No tasks added yet.</p>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {tasks.map(t => (
            <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: "1px solid #e8e4de", borderRadius: 20, background: "#fff" }}>
              <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: "#1a1a1a" }}>{t.name}</span>
              <button onClick={() => onTasksChange(tasks.filter(x => x.id !== t.id))} style={{ background: "none", border: "none", color: "#ccc", cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1 }}>×</button>
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
  const [tasks, setTasks] = useState([]);
  const [rates, setRates] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      load("finefit_entries"), loadStr("finefit_fitter_name"),
      load("finefit_sites"), load("finefit_tasks"), load("finefit_rates"),
    ]).then(([entries, name, savedSites, savedTasks, savedRates]) => {
      setAllEntries(entries || []);
      if (name) setFitterName(name);
      setSites(savedSites || []);
      setTasks(savedTasks || []);
      setRates(savedRates || {});
      setLoading(false);
    });
  }, []);

  const handleSitesChange = async (u) => { setSites(u); await save("finefit_sites", u); };
  const handleTasksChange = async (u) => { setTasks(u); await save("finefit_tasks", u); };
  const handleRatesChange = async (u) => { setRates(u); await save("finefit_rates", u); };
  const handleSubmit = async (record) => { const u = [...allEntries, record]; setAllEntries(u); await save("finefit_entries", u); };
  const handleFitterLogout = async () => { await del("finefit_fitter_name"); setFitterName(null); };
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
              ? <FitterForm fitterName={fitterName} onLogout={handleFitterLogout} onSubmit={handleSubmit} sites={sites} tasks={tasks} />
              : <FitterLogin onLogin={setFitterName} />
          ) : view === "adminLogin" ? (
            <AdminLogin onLogin={() => setView("admin")} />
          ) : (
            <AdminDashboard allEntries={allEntries} sites={sites} tasks={tasks} rates={rates}
              onSitesChange={handleSitesChange} onTasksChange={handleTasksChange}
              onRatesChange={handleRatesChange} onLogout={() => setView("fitter")} />
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
