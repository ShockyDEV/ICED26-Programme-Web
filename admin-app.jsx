/* eslint-disable */
// ICED26 — Admin app
// =====================================================================
// Live editor for the programme data. Loads window.ICED26_DATA into
// React state, auto-saves a draft to localStorage, and exports a
// regenerated data/programme.js file ready to commit.
//
// SECURITY NOTE
// This is a static site. The "login" below is a SHA-256 hash comparison
// of a hardcoded password against user input. It's a barrier against
// casual access, NOT real auth — anyone with DevTools can see the hash.
// For real auth we'd need a backend (Cloudflare Worker, etc.).
// =====================================================================

// ── Credentials (CHANGE THESE) ─────────────────────────────────────────
const ADMIN_EMAIL = "enrique@usal.es";
// SHA-256 of the password. Default password is "iced26-change-me-2026".
// To set a new password, run this in any browser console:
//   (async (p) => {
//     const b = new TextEncoder().encode(p);
//     const h = await crypto.subtle.digest("SHA-256", b);
//     return Array.from(new Uint8Array(h)).map(x => x.toString(16).padStart(2, "0")).join("");
//   })("your-new-password").then(console.log)
// …and paste the resulting 64-char hex below.
const ADMIN_PASSWORD_SHA256 = "bc6cda6df7b7c822162f96e6552ef0b6c7f1ec033295de95b030cd48f458a6e3";

// ── Storage keys ────────────────────────────────────────────────────────
const SESSION_KEY = "iced26-admin-session";
const DRAFT_KEY = "iced26-admin-draft";

// ── Crypto helper ──────────────────────────────────────────────────────
async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Session types (must match styles.css --t-* tokens) ────────────────
const SESSION_TYPES = [
  { id: "keynote", label: "Conferencia / Keynote" },
  { id: "symposium", label: "Simposio" },
  { id: "paper", label: "Comunicación / Paper" },
  { id: "workshop", label: "Taller / Workshop" },
  { id: "poster", label: "Pósters" },
  { id: "collaborative", label: "Espacio colaborativo" },
  { id: "talk", label: "ICED Talks" },
  { id: "doctoral", label: "Doctoral" },
  { id: "social", label: "Social" },
  { id: "meeting", label: "Reunión" },
  { id: "break", label: "Pausa / Break" },
  { id: "other", label: "Otro" }
];

// ── Deep clone helper ──────────────────────────────────────────────────
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── HH:MM validation ───────────────────────────────────────────────────
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const URL_RE = /^https?:\/\/.+/i;

// ── Time overlap helpers ───────────────────────────────────────────────
const toMin = (hm) => {
  if (!TIME_RE.test(hm || "")) return null;
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};

// Normalize a person name for comparison (lowercase, strip diacritics, collapse spaces)
const normName = (n) => (n || "")
  .toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^\w\s'-]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

// Split a "Author A, Author B, Author C" string into a list
const splitAuthors = (s) =>
  (s || "")
    .split(/[,;]| and | y /i)
    .map((x) => x.trim())
    .filter(Boolean);

// ── Conflict detector ──────────────────────────────────────────────────
// Returns an array of issues. Each issue has { kind, severity, title, detail,
// sessionRefs: [{ idx, label }] } so the UI can render them and jump-to-edit.
function detectIssues(data) {
  const issues = [];

  // 1) PRESENTER OVERLAPS — same person, same day, time ranges intersect.
  //    We use SESSION-level start/end (talk-level end isn't recorded).
  //    Same-session multi-talk by one person is fine; we de-dup that.
  const presences = []; // { sessionIdx, name, displayName, day, sm, em }
  data.sessions.forEach((s, sIdx) => {
    const sm = toMin(s.start);
    const em = toMin(s.end);
    if (sm == null || em == null) return;
    // Collect names from talks (presenters + authors) and from session-level speakers field if any
    const names = new Set();
    const displayNames = {};
    (s.talks || []).forEach((t) => {
      [t.presenter, ...splitAuthors(t.authors)].filter(Boolean).forEach((raw) => {
        const k = normName(raw);
        if (!k) return;
        names.add(k);
        if (!displayNames[k]) displayNames[k] = raw.trim();
      });
    });
    names.forEach((name) => {
      presences.push({
        sessionIdx: sIdx,
        name,
        displayName: displayNames[name],
        day: s.day,
        sm,
        em
      });
    });
  });

  const byName = {};
  presences.forEach((p) => (byName[p.name] ||= []).push(p));

  Object.values(byName).forEach((arr) => {
    if (arr.length < 2) return;
    // Group per day
    const byDay = {};
    arr.forEach((p) => (byDay[p.day] ||= []).push(p));
    Object.values(byDay).forEach((items) => {
      if (items.length < 2) return;
      items.sort((a, b) => a.sm - b.sm);
      const reported = new Set();
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          // Same session → not a conflict (multiple talks in one session)
          if (items[i].sessionIdx === items[j].sessionIdx) continue;
          const a = items[i],
            b = items[j];
          if (b.sm < a.em) {
            const key = [a.sessionIdx, b.sessionIdx].sort((x, y) => x - y).join("-");
            if (reported.has(key)) continue;
            reported.add(key);
            const sA = data.sessions[a.sessionIdx];
            const sB = data.sessions[b.sessionIdx];
            issues.push({
              kind: "presenter-overlap",
              severity: "error",
              title: `Solapamiento: ${a.displayName}`,
              detail: `Aparece en dos sesiones simultáneas el ${a.day}.`,
              sessionRefs: [
                { idx: a.sessionIdx, label: `${sA.start}–${sA.end} · ${sA.roomName || sA.room} · ${sA.title}` },
                { idx: b.sessionIdx, label: `${sB.start}–${sB.end} · ${sB.roomName || sB.room} · ${sB.title}` }
              ]
            });
          }
        }
      }
    });
  });

  // 2) ROOM OVERLAPS — two sessions in the same room with overlapping times.
  const byRoom = {};
  data.sessions.forEach((s, idx) => {
    if (s.room === "*" || !s.room) return;
    const sm = toMin(s.start);
    const em = toMin(s.end);
    if (sm == null || em == null) return;
    const key = `${s.day}|${s.room}`;
    (byRoom[key] ||= []).push({ idx, sm, em, s });
  });
  Object.entries(byRoom).forEach(([key, arr]) => {
    if (arr.length < 2) return;
    arr.sort((a, b) => a.sm - b.sm);
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i],
        b = arr[i + 1];
      if (b.sm < a.em) {
        issues.push({
          kind: "room-overlap",
          severity: "error",
          title: `Solapamiento de sala: ${a.s.roomName || a.s.room}`,
          detail: `Dos sesiones simultáneas en la misma sala el ${a.s.day}.`,
          sessionRefs: [
            { idx: a.idx, label: `${a.s.start}–${a.s.end} · ${a.s.title}` },
            { idx: b.idx, label: `${b.s.start}–${b.s.end} · ${b.s.title}` }
          ]
        });
      }
    }
  });

  // 3) MALFORMED SESSIONS — bad time, end <= start, missing title, bad room ref
  const roomIds = new Set(data.rooms.map((r) => r.id));
  data.sessions.forEach((s, idx) => {
    if (!TIME_RE.test(s.start || "")) {
      issues.push({
        kind: "bad-time",
        severity: "error",
        title: "Hora de inicio inválida",
        detail: `«${s.start}» no es HH:MM en «${s.title || "(sin título)"}».`,
        sessionRefs: [{ idx, label: s.title || "(sin título)" }]
      });
    }
    if (!TIME_RE.test(s.end || "")) {
      issues.push({
        kind: "bad-time",
        severity: "error",
        title: "Hora de fin inválida",
        detail: `«${s.end}» no es HH:MM en «${s.title || "(sin título)"}».`,
        sessionRefs: [{ idx, label: s.title || "(sin título)" }]
      });
    }
    const sm = toMin(s.start),
      em = toMin(s.end);
    if (sm != null && em != null && em <= sm) {
      issues.push({
        kind: "bad-time",
        severity: "error",
        title: "Hora de fin ≤ inicio",
        detail: `${s.start}–${s.end} en «${s.title || "(sin título)"}» — el fin debe ser posterior al inicio.`,
        sessionRefs: [{ idx, label: s.title || "(sin título)" }]
      });
    }
    if (!s.title || !s.title.trim()) {
      issues.push({
        kind: "missing-title",
        severity: "warning",
        title: "Sesión sin título",
        detail: `Día ${s.day}, ${s.start}–${s.end}.`,
        sessionRefs: [{ idx, label: `${s.start}–${s.end} · sin título` }]
      });
    }
    if (s.room && s.room !== "*" && !roomIds.has(s.room)) {
      issues.push({
        kind: "unknown-room",
        severity: "error",
        title: "Sala desconocida",
        detail: `«${s.room}» no existe en el catálogo de salas. Sesión «${s.title}».`,
        sessionRefs: [{ idx, label: s.title || "(sin título)" }]
      });
    }
  });

  // 4) MEET COVERAGE — sessions without a Meet that also can't inherit one (room has no meet)
  const roomMeet = {};
  data.rooms.forEach((r) => (roomMeet[r.id] = r.meet || ""));
  data.sessions.forEach((s, idx) => {
    if (s.meet) return;
    if (s.room === "*" || !s.room) return;
    if (s.type === "break") return; // breaks don't need meet
    const inherited = roomMeet[s.room];
    if (!inherited) {
      issues.push({
        kind: "missing-meet",
        severity: "warning",
        title: "Sin enlace Meet",
        detail: `Ni la sesión ni la sala «${s.roomName || s.room}» tienen un enlace Meet. Los asistentes no podrán entrar.`,
        sessionRefs: [{ idx, label: `${s.start}–${s.end} · ${s.title}` }]
      });
    }
  });

  return issues;
}

// ─────────────────────────────────────────────────────────────────────
// AdminApp — top-level gate
// ─────────────────────────────────────────────────────────────────────
function AdminApp() {
  const [authed, setAuthed] = React.useState(
    () => sessionStorage.getItem(SESSION_KEY) === "1"
  );
  if (!authed) return <LoginGate onSuccess={() => setAuthed(true)} />;
  return (
    <AdminEditor
      onLogout={() => {
        sessionStorage.removeItem(SESSION_KEY);
        setAuthed(false);
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// LoginGate
// ─────────────────────────────────────────────────────────────────────
function LoginGate({ onSuccess }) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Constant-ish delay to slow brute-force attempts
      const [hash] = await Promise.all([
        sha256(password),
        new Promise((r) => setTimeout(r, 400))
      ]);
      if (
        email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase() &&
        hash === ADMIN_PASSWORD_SHA256
      ) {
        sessionStorage.setItem(SESSION_KEY, "1");
        onSuccess();
        return;
      }
      setError("Email o contraseña incorrectos.");
    } catch (err) {
      setError("Error: " + (err.message || err));
    }
    setBusy(false);
  };

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand" aria-hidden="true">
          <span className="c1">I</span>
          <span className="c2">C</span>
          <span className="c1">ED</span>
          <span className="c3">26</span>
        </div>
        <h1>Panel de administración</h1>
        <p className="login-sub">Acceso solo organizadores</p>

        <label className="login-field">
          <span>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
            autoComplete="username"
            placeholder="tu@usal.es"
          />
        </label>
        <label className="login-field">
          <span>Contraseña</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            placeholder="••••••••••"
          />
        </label>

        {error && <div className="login-error" role="alert">{error}</div>}

        <button type="submit" className="login-submit" disabled={busy}>
          {busy ? "Comprobando…" : "Entrar"}
        </button>

        <a href="/" className="login-back">← Volver al programa público</a>

        <p className="login-disclaimer">
          La sesión se cierra al cerrar la pestaña.
          <br />
          Esta web es estática — la autenticación es una barrera ligera, no seguridad fuerte.
        </p>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// AdminEditor — main shell with tabs + draft management
// ─────────────────────────────────────────────────────────────────────
function AdminEditor({ onLogout }) {
  const original = React.useRef(clone(window.ICED26_DATA));

  const [data, setData] = React.useState(() => {
    const draft = localStorage.getItem(DRAFT_KEY);
    if (draft) {
      try {
        const parsed = JSON.parse(draft);
        // Sanity check: must look like our schema
        if (parsed && parsed.meta && parsed.sessions && parsed.rooms) {
          return parsed;
        }
      } catch {}
    }
    return clone(window.ICED26_DATA);
  });

  const [tab, setTab] = React.useState("sessions");
  const [editingSessionIdx, setEditingSessionIdx] = React.useState(null);

  // Jump from any tab into the session editor (used by ValidationTab)
  const goEditSession = React.useCallback((idx) => {
    setTab("sessions");
    setEditingSessionIdx(idx);
  }, []);

  // Auto-save draft on every change (debounced via microtask)
  const isDirty = React.useMemo(
    () => JSON.stringify(data) !== JSON.stringify(original.current),
    [data]
  );

  React.useEffect(() => {
    if (isDirty) {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    } else {
      localStorage.removeItem(DRAFT_KEY);
    }
  }, [data, isDirty]);

  // Warn on unload if there are unsaved (un-exported) changes
  React.useEffect(() => {
    const handler = (e) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const discardDraft = () => {
    if (!confirm("¿Descartar TODOS los cambios y volver a la versión guardada en el repo?")) return;
    localStorage.removeItem(DRAFT_KEY);
    setData(clone(original.current));
  };

  const exportData = () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
    const js =
`// ICED26 programme — generated from admin panel ${stamp}
// Times are Europe/Madrid local. Do not hand-edit; regenerate from admin panel.

window.ICED26_DATA = ${JSON.stringify(data, null, 2)};
`;
    const blob = new Blob([js], { type: "application/javascript;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "programme.js";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Stats for the topbar
  const stats = React.useMemo(() => ({
    sessions: data.sessions.length,
    rooms: data.rooms.length,
    buildings: data.clusters.length,
    days: data.meta.days.length,
    meetCovered: data.rooms.filter((r) => r.meet).length,
    sessionsWithMeet: data.sessions.filter((s) => s.meet).length
  }), [data]);

  // Validation issues — computed live so the badge updates as you edit
  const issues = React.useMemo(() => detectIssues(data), [data]);
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return (
    <div className="admin-app">
      <header className="admin-topbar">
        <div className="admin-brand">
          <span className="brand-mark" aria-hidden="true">
            <span className="c1">I</span><span className="c2">C</span>
            <span className="c1">ED</span><span className="c3">26</span>
          </span>
          <span className="admin-tagline">Admin</span>
        </div>

        <nav className="admin-tabs" role="tablist">
          {[
            { id: "sessions", label: "Sesiones", count: stats.sessions },
            { id: "rooms", label: "Salas & Meet", count: stats.rooms },
            { id: "buildings", label: "Edificios", count: stats.buildings },
            { id: "meta", label: "Configuración" },
            {
              id: "validation",
              label: "Validación",
              count: errorCount + warningCount || null,
              tone: errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "ok"
            }
          ].map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`atab ${tab === t.id ? "active" : ""} ${t.tone ? `tone-${t.tone}` : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.count != null && <span className="atab-count">{t.count}</span>}
            </button>
          ))}
        </nav>

        <div className="admin-actions">
          {isDirty && (
            <span className="dirty-pill" title="Hay cambios no exportados">
              <span className="dot" /> Cambios sin exportar
            </span>
          )}
          {isDirty && (
            <button className="btn-ghost" onClick={discardDraft} title="Descartar borrador">
              Descartar
            </button>
          )}
          <button
            className="btn-primary"
            onClick={exportData}
            title="Descargar programme.js para commitear al repositorio"
            disabled={!isDirty}
          >
            ↓ Exportar programme.js
          </button>
          <a className="btn-ghost" href="/" target="_blank" rel="noopener noreferrer" title="Abrir web pública">
            Ver web ↗
          </a>
          <button className="btn-ghost" onClick={onLogout} title="Cerrar sesión">
            Salir
          </button>
        </div>
      </header>

      <main className="admin-main">
        {tab === "sessions" && (
          <SessionsTab
            data={data}
            setData={setData}
            editingIdx={editingSessionIdx}
            setEditingIdx={setEditingSessionIdx}
          />
        )}
        {tab === "rooms" && <RoomsTab data={data} setData={setData} stats={stats} />}
        {tab === "buildings" && <BuildingsTab data={data} setData={setData} />}
        {tab === "meta" && <MetaTab data={data} setData={setData} />}
        {tab === "validation" && (
          <ValidationTab data={data} issues={issues} onEditSession={goEditSession} />
        )}
      </main>

      {isDirty && (
        <div className="export-banner">
          <strong>Para publicar:</strong> pulsa <em>Exportar programme.js</em>,
          reemplaza el archivo <code>data/programme.js</code> en el repositorio y haz commit + push.
          GitHub Pages publica el cambio en ~30 segundos.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SessionsTab
// ─────────────────────────────────────────────────────────────────────
function SessionsTab({ data, setData, editingIdx, setEditingIdx }) {
  const [filter, setFilter] = React.useState({ day: "", building: "", type: "", q: "" });
  // editingIdx is lifted up so the Validation tab can jump-to-edit

  const filtered = React.useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    return data.sessions
      .map((s, idx) => ({ ...s, _idx: idx }))
      .filter((s) => {
        if (filter.day && s.day !== filter.day) return false;
        if (filter.building && s.cluster !== filter.building) return false;
        if (filter.type && s.type !== filter.type) return false;
        if (q) {
          const hay = [s.title, s.fullName, s.roomName, s.roomCode].filter(Boolean).join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (a.day !== b.day) return a.day.localeCompare(b.day);
        return a.start.localeCompare(b.start);
      });
  }, [data.sessions, filter]);

  const saveSession = (idx, next) => {
    setData((d) => {
      const sessions = [...d.sessions];
      if (idx === "new") sessions.push(next);
      else sessions[idx] = next;
      return { ...d, sessions };
    });
    setEditingIdx(null);
  };

  const deleteSession = (idx) => {
    if (!confirm("¿Eliminar esta sesión? Esta acción no se puede deshacer (salvo descartando el borrador).")) return;
    setData((d) => ({ ...d, sessions: d.sessions.filter((_, i) => i !== idx) }));
    setEditingIdx(null);
  };

  const duplicateSession = (idx) => {
    setData((d) => {
      const copy = clone(d.sessions[idx]);
      copy.title = copy.title + " (copia)";
      return { ...d, sessions: [...d.sessions, copy] };
    });
  };

  const startNew = () => {
    setEditingIdx("new");
  };

  const editingSession =
    editingIdx === "new"
      ? {
          day: data.meta.days[0] || "",
          start: "09:00",
          end: "10:00",
          room: data.rooms[0]?.id || "",
          roomName: data.rooms[0]?.name || "",
          roomCode: data.rooms[0]?.code || "",
          cluster: data.rooms[0]?.cluster || "",
          title: "",
          fullName: "",
          type: "other",
          meet: "",
          talks: []
        }
      : editingIdx != null
      ? data.sessions[editingIdx]
      : null;

  return (
    <div className="sessions-tab">
      <div className="filter-bar">
        <input
          type="search"
          placeholder="Buscar por título, sala, código…"
          value={filter.q}
          onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
          className="filter-q"
        />
        <select value={filter.day} onChange={(e) => setFilter((f) => ({ ...f, day: e.target.value }))}>
          <option value="">Todos los días</option>
          {data.meta.days.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <select
          value={filter.building}
          onChange={(e) => setFilter((f) => ({ ...f, building: e.target.value }))}
        >
          <option value="">Todos los edificios</option>
          {data.clusters.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <select value={filter.type} onChange={(e) => setFilter((f) => ({ ...f, type: e.target.value }))}>
          <option value="">Todos los tipos</option>
          {SESSION_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
        <span className="filter-count">{filtered.length} de {data.sessions.length}</span>
        <button className="btn-primary" onClick={startNew}>+ Nueva sesión</button>
      </div>

      <div className="sessions-table-wrap">
        <table className="sessions-table">
          <thead>
            <tr>
              <th>Día</th>
              <th>Hora</th>
              <th>Sala</th>
              <th>Tipo</th>
              <th>Título</th>
              <th>Ponencias</th>
              <th>Meet</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s._idx} className="srow">
                <td className="td-day">{s.day.slice(5)}</td>
                <td className="td-time">{s.start}–{s.end}</td>
                <td className="td-room">
                  {s.room === "*" ? <em>Todas</em> : s.roomName || s.room}
                  {s.roomCode && <span className="muted"> · {s.roomCode}</span>}
                </td>
                <td className="td-type">
                  <span className="type-pill" style={{ "--type-color": `var(--t-${s.type})` }}>
                    {SESSION_TYPES.find((t) => t.id === s.type)?.label || s.type}
                  </span>
                </td>
                <td className="td-title">
                  <div className="t-title">{s.title || <em className="muted">(sin título)</em>}</div>
                  {s.fullName && s.fullName !== s.title && (
                    <div className="t-fullname muted">{s.fullName}</div>
                  )}
                </td>
                <td className="td-talks">{(s.talks || []).length || ""}</td>
                <td className="td-meet">
                  {s.meet ? (
                    <a href={s.meet} target="_blank" rel="noopener noreferrer" title={s.meet}>✓</a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="td-actions">
                  <button className="btn-mini" onClick={() => setEditingIdx(s._idx)}>Editar</button>
                  <button className="btn-mini" onClick={() => duplicateSession(s._idx)}>Duplicar</button>
                  <button className="btn-mini danger" onClick={() => deleteSession(s._idx)}>✕</button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan="8" className="muted" style={{ textAlign: "center", padding: 32 }}>
                  Ninguna sesión coincide con el filtro.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editingSession && (
        <SessionEditor
          session={editingSession}
          isNew={editingIdx === "new"}
          rooms={data.rooms}
          clusters={data.clusters}
          days={data.meta.days}
          onSave={(next) => saveSession(editingIdx, next)}
          onCancel={() => setEditingIdx(null)}
          onDelete={editingIdx !== "new" ? () => deleteSession(editingIdx) : null}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SessionEditor — modal
// ─────────────────────────────────────────────────────────────────────
function SessionEditor({ session, isNew, rooms, clusters, days, onSave, onCancel, onDelete }) {
  const [s, setS] = React.useState(() => clone(session));
  const [errors, setErrors] = React.useState({});

  // ESC closes
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onCancel]);

  const setField = (k, v) => setS((prev) => ({ ...prev, [k]: v }));

  // When room changes, sync the denormalized fields (roomName, roomCode, cluster)
  const onRoomChange = (roomId) => {
    if (roomId === "*") {
      setS((prev) => ({ ...prev, room: "*", roomName: "", roomCode: "", cluster: prev.cluster }));
      return;
    }
    const r = rooms.find((x) => x.id === roomId);
    if (!r) return;
    setS((prev) => ({
      ...prev,
      room: r.id,
      roomName: r.name,
      roomCode: r.code,
      cluster: r.cluster
    }));
  };

  const validate = () => {
    const e = {};
    if (!s.day || !days.includes(s.day)) e.day = "Día inválido";
    if (!TIME_RE.test(s.start)) e.start = "Formato HH:MM";
    if (!TIME_RE.test(s.end)) e.end = "Formato HH:MM";
    if (TIME_RE.test(s.start) && TIME_RE.test(s.end) && s.start >= s.end) e.end = "Debe ser posterior al inicio";
    if (!s.title || !s.title.trim()) e.title = "Obligatorio";
    if (!s.room) e.room = "Selecciona sala (o «Todas»)";
    if (s.meet && !URL_RE.test(s.meet)) e.meet = "URL inválida";
    if (s.room !== "*" && !s.cluster) e.cluster = "Falta edificio";
    return e;
  };

  const submit = (e) => {
    e.preventDefault();
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    // Normalize: clean talks (drop empty rows), trim strings
    const cleaned = {
      ...s,
      title: s.title.trim(),
      fullName: (s.fullName || "").trim(),
      meet: (s.meet || "").trim(),
      talks: (s.talks || [])
        .filter((t) => t.title || t.authors || t.presenter || t.abstract)
        .map((t) => ({
          time: (t.time || "").trim(),
          title: (t.title || "").trim(),
          authors: (t.authors || "").trim(),
          presenter: (t.presenter || "").trim(),
          abstract: (t.abstract || "").trim(),
          keywords: (t.keywords || "").trim()
        }))
    };
    onSave(cleaned);
  };

  return (
    <div className="modal-overlay" onClick={onCancel} role="dialog" aria-modal="true">
      <form className="modal session-modal-edit" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="modal-head">
          <h2>{isNew ? "Nueva sesión" : "Editar sesión"}</h2>
          <button type="button" className="modal-close" onClick={onCancel} aria-label="Cerrar">✕</button>
        </header>

        <div className="modal-body">
          <div className="form-row two">
            <Field label="Día" error={errors.day}>
              <select value={s.day} onChange={(e) => setField("day", e.target.value)}>
                {days.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
            <Field label="Tipo" error={errors.type}>
              <select value={s.type} onChange={(e) => setField("type", e.target.value)}>
                {SESSION_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </Field>
          </div>

          <div className="form-row two">
            <Field label="Hora inicio" error={errors.start}>
              <input type="text" inputMode="numeric" pattern="[0-9:]*" placeholder="09:00"
                value={s.start} onChange={(e) => setField("start", e.target.value)} />
            </Field>
            <Field label="Hora fin" error={errors.end}>
              <input type="text" inputMode="numeric" pattern="[0-9:]*" placeholder="10:30"
                value={s.end} onChange={(e) => setField("end", e.target.value)} />
            </Field>
          </div>

          <Field label="Sala" error={errors.room}>
            <select value={s.room} onChange={(e) => onRoomChange(e.target.value)}>
              <option value="*">⋆ Todas las salas (sesión global / pausa)</option>
              {clusters.map((c) => (
                <optgroup key={c.id} label={c.name}>
                  {rooms.filter((r) => r.cluster === c.id).map((r) => (
                    <option key={r.id} value={r.id}>{r.name} ({r.code})</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>

          <Field label="Título" error={errors.title}>
            <input type="text" value={s.title} onChange={(e) => setField("title", e.target.value)}
              placeholder="P. ej. Keynote: Ruth Graham" />
          </Field>

          <Field label="Nombre completo (opcional)" hint="P. ej. «Session 4: Keynote with Ruth Graham». Solo se usa en búsqueda.">
            <input type="text" value={s.fullName || ""} onChange={(e) => setField("fullName", e.target.value)} />
          </Field>

          <Field label="Enlace Meet (opcional)" error={errors.meet}
            hint="Si está vacío, la sesión hereda el Meet de su sala (ver pestaña «Salas & Meet»).">
            <input type="url" value={s.meet || ""} onChange={(e) => setField("meet", e.target.value)}
              placeholder="https://meet.google.com/abc-defg-hij" />
          </Field>

          <TalksEditor
            talks={s.talks || []}
            onChange={(talks) => setField("talks", talks)}
          />
        </div>

        <footer className="modal-foot">
          {onDelete && (
            <button type="button" className="btn-danger" onClick={onDelete}>
              Eliminar sesión
            </button>
          )}
          <div className="modal-foot-right">
            <button type="button" className="btn-ghost" onClick={onCancel}>Cancelar</button>
            <button type="submit" className="btn-primary">
              {isNew ? "Crear sesión" : "Guardar cambios"}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// TalksEditor
// ─────────────────────────────────────────────────────────────────────
function TalksEditor({ talks, onChange }) {
  const update = (i, patch) => onChange(talks.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  const add = () =>
    onChange([
      ...talks,
      { time: "", title: "", authors: "", presenter: "", abstract: "", keywords: "" }
    ]);
  const remove = (i) => onChange(talks.filter((_, idx) => idx !== i));
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= talks.length) return;
    const arr = [...talks];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onChange(arr);
  };

  const [expanded, setExpanded] = React.useState(new Set());
  const toggle = (i) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="talks-editor">
      <div className="talks-head">
        <h3>Ponencias / Talks {talks.length > 0 && <span className="muted">({talks.length})</span>}</h3>
        <button type="button" className="btn-ghost" onClick={add}>+ Añadir ponencia</button>
      </div>

      {talks.length === 0 && (
        <p className="muted talks-empty">
          Sin ponencias. Workshops, keynotes y pausas no suelen llevar. Comunicaciones agrupadas en simposio sí.
        </p>
      )}

      {talks.map((t, i) => {
        const isOpen = expanded.has(i);
        const hasDetail = (t.abstract || "").trim().length > 0 || (t.keywords || "").trim().length > 0;
        return (
          <div className={`talk-row ${isOpen ? "is-open" : ""}`} key={i}>
            <div className="talk-controls">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Subir">↑</button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === talks.length - 1} title="Bajar">↓</button>
              <button type="button" onClick={() => remove(i)} className="danger" title="Eliminar">✕</button>
            </div>
            <div className="talk-fields">
              <input
                type="text"
                placeholder="HH:MM"
                value={t.time || ""}
                onChange={(e) => update(i, { time: e.target.value })}
                className="talk-time"
              />
              <input
                type="text"
                placeholder="Título de la ponencia"
                value={t.title || ""}
                onChange={(e) => update(i, { title: e.target.value })}
                className="talk-title"
              />
              <input
                type="text"
                placeholder="Autor/a/es (coma)"
                value={t.authors || ""}
                onChange={(e) => update(i, { authors: e.target.value })}
                className="talk-authors"
              />
              <input
                type="text"
                placeholder="Presenter"
                value={t.presenter || ""}
                onChange={(e) => update(i, { presenter: e.target.value })}
                className="talk-presenter"
              />

              <button
                type="button"
                className={`talk-detail-toggle ${hasDetail ? "has-detail" : ""}`}
                onClick={() => toggle(i)}
                aria-expanded={isOpen}
              >
                {isOpen ? "▾ Ocultar abstract & keywords" : "▸ Abstract & keywords"}
                {hasDetail && !isOpen && <span className="td-pill">●</span>}
              </button>

              {isOpen && (
                <>
                  <textarea
                    placeholder="Abstract — resumen de la ponencia"
                    value={t.abstract || ""}
                    onChange={(e) => update(i, { abstract: e.target.value })}
                    className="talk-abstract"
                    rows={5}
                  />
                  <input
                    type="text"
                    placeholder="Keywords (separadas por comas: agency, faculty development, …)"
                    value={t.keywords || ""}
                    onChange={(e) => update(i, { keywords: e.target.value })}
                    className="talk-keywords"
                  />
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// RoomsTab — most-used tab: assign permanent Meet URLs per room
// ─────────────────────────────────────────────────────────────────────
function RoomsTab({ data, setData, stats }) {
  const [editingId, setEditingId] = React.useState(null);

  const updateRoom = (id, patch) => {
    setData((d) => ({
      ...d,
      rooms: d.rooms.map((r) => (r.id === id ? { ...r, ...patch } : r))
    }));
    // Also propagate the new meet to sessions that don't have their own meet?
    // → No, sessions keep their own meet override; the public site uses session.meet directly.
  };

  const updateRoomId = (oldId, newId) => {
    if (!newId || newId === oldId) return;
    if (data.rooms.some((r) => r.id === newId)) {
      alert("Ya existe una sala con ese ID.");
      return;
    }
    setData((d) => ({
      ...d,
      rooms: d.rooms.map((r) => (r.id === oldId ? { ...r, id: newId } : r)),
      // Update sessions that reference the old room id
      sessions: d.sessions.map((s) => (s.room === oldId ? { ...s, room: newId } : s))
    }));
  };

  const addRoom = (clusterId) => {
    const c = data.clusters.find((x) => x.id === clusterId);
    const stub = {
      id: `room-${Date.now()}`,
      name: "Nueva sala",
      cluster: clusterId,
      code: "?",
      meet: ""
    };
    setData((d) => ({ ...d, rooms: [...d.rooms, stub] }));
    setEditingId(stub.id);
  };

  const deleteRoom = (id) => {
    const usedBy = data.sessions.filter((s) => s.room === id).length;
    if (usedBy > 0) {
      alert(`No se puede eliminar: ${usedBy} sesión(es) usan esta sala. Reasigna o elimina esas sesiones primero.`);
      return;
    }
    if (!confirm("¿Eliminar esta sala?")) return;
    setData((d) => ({ ...d, rooms: d.rooms.filter((r) => r.id !== id) }));
  };

  const byCluster = React.useMemo(() => {
    const map = {};
    for (const r of data.rooms) (map[r.cluster] ||= []).push(r);
    return map;
  }, [data.rooms]);

  return (
    <div className="rooms-tab">
      <div className="rooms-head">
        <h2>Salas y enlaces Meet</h2>
        <p className="muted">
          El enlace Meet de cada sala se asigna aquí. Si una sesión concreta necesita otro Meet,
          se sobreescribe desde la pestaña <em>Sesiones</em>.
          <br />
          <strong>{stats.meetCovered} de {stats.rooms}</strong> salas tienen Meet asignado.
          <strong> {stats.sessionsWithMeet} de {stats.sessions}</strong> sesiones tienen Meet propio.
        </p>
      </div>

      {data.clusters.map((c) => (
        <section className="rooms-cluster" key={c.id}>
          <header className="rooms-cluster-head">
            <h3>{c.name}</h3>
            <span className="muted">{(byCluster[c.id] || []).length} salas</span>
            <button className="btn-ghost btn-mini" onClick={() => addRoom(c.id)}>+ Añadir sala</button>
          </header>

          <div className="rooms-list">
            {(byCluster[c.id] || []).map((r) => (
              <div className="room-row" key={r.id}>
                <div className="rr-info">
                  {editingId === r.id ? (
                    <>
                      <input
                        type="text"
                        className="rr-name-input"
                        value={r.name}
                        onChange={(e) => updateRoom(r.id, { name: e.target.value })}
                        placeholder="Nombre de la sala"
                      />
                      <input
                        type="text"
                        className="rr-code-input"
                        value={r.code}
                        onChange={(e) => updateRoom(r.id, { code: e.target.value })}
                        placeholder="Código (ej. 1.1)"
                      />
                    </>
                  ) : (
                    <>
                      <div className="rr-name">{r.name}</div>
                      <div className="rr-code muted">{r.code}</div>
                    </>
                  )}
                </div>

                <input
                  type="url"
                  className="rr-meet"
                  placeholder="https://meet.google.com/abc-defg-hij"
                  value={r.meet || ""}
                  onChange={(e) => updateRoom(r.id, { meet: e.target.value })}
                />

                <span className={`rr-status ${r.meet ? "ok" : "empty"}`}>
                  {r.meet ? "✓" : "—"}
                </span>

                <div className="rr-actions">
                  <button
                    type="button"
                    className="btn-mini"
                    onClick={() => setEditingId(editingId === r.id ? null : r.id)}
                  >
                    {editingId === r.id ? "Cerrar" : "Editar"}
                  </button>
                  <button
                    type="button"
                    className="btn-mini danger"
                    onClick={() => deleteRoom(r.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// BuildingsTab
// ─────────────────────────────────────────────────────────────────────
function BuildingsTab({ data, setData }) {
  const updateCluster = (id, patch) => {
    setData((d) => ({
      ...d,
      clusters: d.clusters.map((c) => (c.id === id ? { ...c, ...patch } : c))
    }));
  };

  const addCluster = () => {
    const stub = {
      id: `building-${Date.now()}`,
      name: "Nuevo edificio",
      short: "Nuevo",
      subtitle: ""
    };
    setData((d) => ({ ...d, clusters: [...d.clusters, stub] }));
  };

  const deleteCluster = (id) => {
    const usedRooms = data.rooms.filter((r) => r.cluster === id).length;
    const usedSessions = data.sessions.filter((s) => s.cluster === id).length;
    if (usedRooms > 0 || usedSessions > 0) {
      alert(`No se puede eliminar: ${usedRooms} salas y ${usedSessions} sesiones referencian este edificio.`);
      return;
    }
    if (!confirm("¿Eliminar este edificio?")) return;
    setData((d) => ({ ...d, clusters: d.clusters.filter((c) => c.id !== id) }));
  };

  return (
    <div className="buildings-tab">
      <div className="rooms-head">
        <h2>Edificios</h2>
        <p className="muted">
          Pestañas principales de la navegación pública. Cada sala se asigna a un edificio.
        </p>
      </div>

      {data.clusters.map((c) => {
        const roomCount = data.rooms.filter((r) => r.cluster === c.id).length;
        const sessionCount = data.sessions.filter((s) => s.cluster === c.id).length;
        return (
          <section className="building-card" key={c.id}>
            <div className="building-fields">
              <Field label="Nombre completo">
                <input type="text" value={c.name} onChange={(e) => updateCluster(c.id, { name: e.target.value })} />
              </Field>
              <Field label="Nombre corto (pestaña)">
                <input type="text" value={c.short} onChange={(e) => updateCluster(c.id, { short: e.target.value })} />
              </Field>
              <Field label="Subtítulo (descripción de salas)">
                <input type="text" value={c.subtitle} onChange={(e) => updateCluster(c.id, { subtitle: e.target.value })} />
              </Field>
              <Field label="ID interno" hint="Identificador técnico. Cambiarlo rompe referencias en sesiones.">
                <input type="text" value={c.id} disabled />
              </Field>
            </div>
            <div className="building-meta">
              <span><strong>{roomCount}</strong> salas</span>
              <span><strong>{sessionCount}</strong> sesiones</span>
              <button className="btn-mini danger" onClick={() => deleteCluster(c.id)}>Eliminar</button>
            </div>
          </section>
        );
      })}

      <button className="btn-primary" onClick={addCluster}>+ Añadir edificio</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// MetaTab
// ─────────────────────────────────────────────────────────────────────
function MetaTab({ data, setData }) {
  const updateMeta = (patch) => setData((d) => ({ ...d, meta: { ...d.meta, ...patch } }));
  const updateDayLabel = (day, lang, value) => {
    setData((d) => ({
      ...d,
      meta: {
        ...d.meta,
        dayLabels: {
          ...d.meta.dayLabels,
          [day]: { ...(d.meta.dayLabels[day] || {}), [lang]: value }
        }
      }
    }));
  };

  return (
    <div className="meta-tab">
      <div className="rooms-head">
        <h2>Configuración general</h2>
        <p className="muted">Metadatos del congreso, días, etiquetas y zona horaria.</p>
      </div>

      <section className="meta-section">
        <h3>Identidad</h3>
        <Field label="Nombre del congreso">
          <input type="text" value={data.meta.name} onChange={(e) => updateMeta({ name: e.target.value })} />
        </Field>
        <Field label="Subtítulo">
          <input type="text" value={data.meta.subtitle} onChange={(e) => updateMeta({ subtitle: e.target.value })} />
        </Field>
        <Field label="Zona horaria" hint="No cambies salvo que sepas lo que haces. Toda la lógica de «en vivo» depende de esto.">
          <input type="text" value={data.meta.timezone} onChange={(e) => updateMeta({ timezone: e.target.value })} />
        </Field>
      </section>

      <section className="meta-section">
        <h3>Días del congreso</h3>
        <p className="muted">Formato <code>AAAA-MM-DD</code>. Las etiquetas (ES/EN) son las que se muestran en las pestañas.</p>
        <table className="meta-days-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Etiqueta (ES)</th>
              <th>Etiqueta (EN)</th>
            </tr>
          </thead>
          <tbody>
            {data.meta.days.map((d) => (
              <tr key={d}>
                <td><code>{d}</code></td>
                <td>
                  <input
                    type="text"
                    value={data.meta.dayLabels[d]?.es || ""}
                    onChange={(e) => updateDayLabel(d, "es", e.target.value)}
                    placeholder="Mié 24"
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={data.meta.dayLabels[d]?.en || ""}
                    onChange={(e) => updateDayLabel(d, "en", e.target.value)}
                    placeholder="Wed 24"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: 12 }}>
          Para añadir o quitar días, edita el array <code>meta.days</code> directamente en el JSON exportado (de momento).
        </p>
      </section>

      <section className="meta-section">
        <h3>Resumen</h3>
        <div className="meta-stats">
          <div><strong>{data.sessions.length}</strong> sesiones</div>
          <div><strong>{data.rooms.length}</strong> salas</div>
          <div><strong>{data.clusters.length}</strong> edificios</div>
          <div><strong>{data.meta.days.length}</strong> días</div>
        </div>
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// ValidationTab — quality checks (overlaps, missing data, etc.)
// ─────────────────────────────────────────────────────────────────────
function ValidationTab({ data, issues, onEditSession }) {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  // Group issues by kind for cleaner display
  const grouped = React.useMemo(() => {
    const g = {};
    issues.forEach((i) => (g[i.kind] ||= []).push(i));
    return g;
  }, [issues]);

  const groupOrder = [
    ["presenter-overlap", "Solapamientos de ponente", "Una misma persona aparece en dos sesiones simultáneas."],
    ["room-overlap", "Solapamientos de sala", "Dos sesiones programadas a la vez en la misma sala."],
    ["bad-time", "Horas inválidas", "Formato HH:MM incorrecto o fin ≤ inicio."],
    ["unknown-room", "Salas desconocidas", "La sesión referencia una sala que no existe en el catálogo."],
    ["missing-title", "Sesiones sin título", "Toda sesión debería tener un título."],
    ["missing-meet", "Sin enlace Meet", "La sesión no tiene Meet propio y la sala tampoco."]
  ];

  return (
    <div className="validation-tab">
      <div className="rooms-head">
        <h2>Validación del programa</h2>
        <p className="muted">
          Detección automática de problemas: solapamientos de ponentes, conflictos de salas, datos incompletos.
          Pulsa <em>Editar</em> en cualquier conflicto para arreglarlo. La lista se recalcula en vivo.
        </p>
      </div>

      <div className="validation-summary">
        <div className={`vsum-card ${errors.length > 0 ? "tone-error" : "tone-ok"}`}>
          <div className="vsum-number">{errors.length}</div>
          <div className="vsum-label">Errores</div>
        </div>
        <div className={`vsum-card ${warnings.length > 0 ? "tone-warning" : "tone-ok"}`}>
          <div className="vsum-number">{warnings.length}</div>
          <div className="vsum-label">Avisos</div>
        </div>
        <div className="vsum-card tone-ok">
          <div className="vsum-number">{data.sessions.length}</div>
          <div className="vsum-label">Sesiones revisadas</div>
        </div>
      </div>

      {issues.length === 0 && (
        <div className="validation-empty">
          <div className="ve-icon">✓</div>
          <h3>Todo limpio</h3>
          <p className="muted">No hay solapamientos ni problemas detectados. Listo para publicar.</p>
        </div>
      )}

      {groupOrder.map(([kind, title, desc]) => {
        const list = grouped[kind];
        if (!list || list.length === 0) return null;
        const tone = list[0].severity;
        return (
          <section className="validation-group" key={kind}>
            <header className={`vg-head tone-${tone}`}>
              <h3>
                <span className="vg-icon">{tone === "error" ? "⚠" : "ⓘ"}</span>
                {title}
                <span className="vg-count">{list.length}</span>
              </h3>
              <p className="muted">{desc}</p>
            </header>
            <div className="vg-list">
              {list.map((issue, i) => (
                <div className={`vissue tone-${issue.severity}`} key={i}>
                  <div className="vi-main">
                    <div className="vi-title">{issue.title}</div>
                    <div className="vi-detail">{issue.detail}</div>
                  </div>
                  <div className="vi-refs">
                    {issue.sessionRefs.map((ref, j) => (
                      <button
                        key={j}
                        className="btn-mini"
                        onClick={() => onEditSession(ref.idx)}
                        title="Editar esta sesión"
                      >
                        ✎ {ref.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Field — reusable labeled input wrapper
// ─────────────────────────────────────────────────────────────────────
function Field({ label, error, hint, children }) {
  return (
    <label className={`field ${error ? "has-error" : ""}`}>
      <span className="field-label">
        {label}
        {error && <span className="field-error"> · {error}</span>}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────
window.ICED26AdminApp = { AdminApp };
