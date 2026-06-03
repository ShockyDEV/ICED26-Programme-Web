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

// ── Credentials ────────────────────────────────────────────────────────
// We use PBKDF2 (SHA-256, 600 000 iterations, 16-byte random salt) instead
// of bare SHA-256. Bare SHA-256 is fast — a GPU can hash ~10⁹ candidates per
// second offline against a leaked hash. PBKDF2 slows each attempt down by
// ~600 000× (industry-standard for password storage; same as 1Password,
// Bitwarden, etc.) so brute-forcing a 24-char random password is centuries
// of compute. The salt + hash + iteration count being public is fine — that
// is by design, the security comes from the cost factor + password entropy.
//
// To set a new password, run this in Node:
//   const c = require('crypto');
//   const password = 'your-new-password';
//   const saltBytes = c.randomBytes(16);
//   const salt = saltBytes.toString('hex');
//   const iterations = 600000;
//   const hash = c.pbkdf2Sync(password, saltBytes, iterations, 32, 'sha256').toString('hex');
//   console.log({ salt, hash });
const ADMIN_EMAIL = "enrique@usal.es";
const ADMIN_PBKDF2_SALT = "ddfc5bb3f3078d599dc2d82a6abb603c";
const ADMIN_PBKDF2_HASH = "a9b5d562a1744e03662c0b0f1fdf872c71aeb9af0d3bbee3a43d8d695c330d91";
const ADMIN_PBKDF2_ITERATIONS = 600000;

// ── Storage keys ────────────────────────────────────────────────────────
const SESSION_KEY = "iced26-admin-session";
const DRAFT_KEY = "iced26-admin-draft";

// ── GitHub direct-publish config ──────────────────────────────────────────
// The admin can push changes straight to data/programme.js via the GitHub
// Contents API instead of the export+commit+push dance. The token is a
// Personal Access Token (fine-grained) with Contents:read-write on this
// repo only, stored in localStorage on the admin's browser.
const GITHUB_REPO = "ShockyDEV/ICED26-Programme-Web";
const GITHUB_PATH = "data/programme.js";
const GITHUB_BRANCH = "main";
const GITHUB_TOKEN_KEY = "iced26-github-token";

// Build the exact programme.js content (used by both the download-Exportar
// path and the GitHub direct-publish path so they stay byte-identical).
// Strip the "Some Online Presentations" / "Some Presentations Online" note
// that EasyChair appends to some Paper themes — online is shown via the
// per-talk icon, never as text in the theme. Kept out of the published JSON.
const THEME_ONLINE_NOTE = /\s*Some\s+(?:Online\s+Presentations?|Presentations?\s+Online)\s*$/i;

function buildProgrammeJS(data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  // Clone (don't mutate live state) and clean session themes on the way out so
  // every publish/export is consistent, even if a draft still carries the note.
  const clean = {
    ...data,
    sessions: data.sessions.map((s) =>
      s.description && THEME_ONLINE_NOTE.test(s.description)
        ? { ...s, description: s.description.replace(THEME_ONLINE_NOTE, "").trim() }
        : s
    )
  };
  return (
    "// ICED26 programme — generated from admin panel " + stamp + "\n" +
    "// Times are Europe/Madrid local. Do not hand-edit; regenerate from admin panel.\n" +
    "\n" +
    "window.ICED26_DATA = " + JSON.stringify(clean, null, 2) + ";\n"
  );
}

// UTF-8-safe base64 encoder (btoa alone breaks on non-ASCII chars like
// acentos / non-Latin scripts that appear in titles).
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Commit + push a new programme.js to GitHub. Returns the new commit SHA.
// Throws a human-readable Error on any failure (caller shows it in the UI).
async function githubPublish(jsContent, commitMessage, token) {
  const apiUrl = "https://api.github.com/repos/" + GITHUB_REPO + "/contents/" + GITHUB_PATH;
  // 1) Fetch the current file to get its SHA (required by the PUT API).
  const getRes = await fetch(apiUrl + "?ref=" + GITHUB_BRANCH + "&_=" + Date.now(), {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json"
    },
    cache: "no-store"
  });
  if (!getRes.ok) {
    const err = await getRes.json().catch(() => ({}));
    if (getRes.status === 401) {
      throw new Error("Token rechazado por GitHub. Comprueba que es válido y no ha caducado.");
    }
    if (getRes.status === 404) {
      throw new Error("No se encontró el archivo en el repo. ¿Permisos del token sobre " + GITHUB_REPO + "?");
    }
    throw new Error("GET falló (HTTP " + getRes.status + "): " + (err.message || ""));
  }
  const current = await getRes.json();
  const sha = current.sha;
  // 2) PUT the new content with the existing SHA so GitHub detects conflicts.
  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: commitMessage,
      content: utf8ToBase64(jsContent),
      sha,
      branch: GITHUB_BRANCH
    })
  });
  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    if (putRes.status === 409) {
      throw new Error("Conflicto: otro cambio se aplicó primero. Recarga el admin (Ctrl+Shift+R) y reintenta.");
    }
    if (putRes.status === 403) {
      throw new Error("Permiso denegado. El token necesita Contents:read-write sobre " + GITHUB_REPO + ".");
    }
    throw new Error("PUT falló (HTTP " + putRes.status + "): " + (err.message || ""));
  }
  const result = await putRes.json();
  return (result.commit && result.commit.sha) || "";
}
const RATELIMIT_KEY = "iced26-admin-ratelimit";

// ── PBKDF2 via the native Web Crypto API ───────────────────────────────
async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const saltBytes = new Uint8Array(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    key,
    256
  );
  return Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time string compare so we don't leak info via timing.
function constantTimeEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── Rate limiting (localStorage, per-browser) ──────────────────────────
// Won't stop a determined attacker (they would brute-force the hash offline
// and not via this form), but does kick out:
//   - automated scanners hitting /admin, /wp-admin, /panel, etc. with
//     default-creds dictionaries (the entry path is /backstage, which is
//     not on common scanner wordlists, but they still hit /admin anyway)
//   - casual "let me try a few passwords" curiosity
//
// Rules:
//   - 5 failed attempts in a 30-min window → 30-min cooldown
//   - 20+ failed attempts in the same window → 1-week ban
//   - any successful login clears the counter
//
// The counter is per-browser, so an attacker can defeat it by clearing
// localStorage or opening incognito. That's a known limitation of any
// client-side rate limit on a static site.
const RL_WINDOW_MS = 30 * 60 * 1000;        // 30 min
const RL_BAN_MS = 7 * 24 * 60 * 60 * 1000;   // 1 week
const RL_COOLDOWN_THRESHOLD = 5;
const RL_BAN_THRESHOLD = 20;

function loadRateLimit() {
  try {
    const raw = localStorage.getItem(RATELIMIT_KEY);
    if (!raw) return { failures: [], banUntil: 0 };
    const s = JSON.parse(raw);
    return { failures: Array.isArray(s.failures) ? s.failures : [], banUntil: s.banUntil || 0 };
  } catch { return { failures: [], banUntil: 0 }; }
}
function saveRateLimit(state) {
  try { localStorage.setItem(RATELIMIT_KEY, JSON.stringify(state)); } catch {}
}
function clearRateLimit() {
  try { localStorage.removeItem(RATELIMIT_KEY); } catch {}
}

// Returns current status: either { ok: true, attemptsRemaining } or
// { ok: false, kind: 'cooldown'|'ban', until }.
function rateLimitStatus() {
  const state = loadRateLimit();
  const now = Date.now();
  state.failures = state.failures.filter((t) => now - t < RL_WINDOW_MS);
  if (state.banUntil > now) {
    return { ok: false, kind: "ban", until: state.banUntil };
  }
  if (state.failures.length >= RL_COOLDOWN_THRESHOLD) {
    const oldest = state.failures[0];
    return { ok: false, kind: "cooldown", until: oldest + RL_WINDOW_MS };
  }
  return { ok: true, attemptsRemaining: RL_COOLDOWN_THRESHOLD - state.failures.length };
}

// Record one failed attempt. If the window count crosses the ban threshold,
// escalate to a 1-week ban.
function recordRateLimitFailure() {
  const state = loadRateLimit();
  const now = Date.now();
  state.failures = state.failures.filter((t) => now - t < RL_WINDOW_MS);
  state.failures.push(now);
  if (state.failures.length >= RL_BAN_THRESHOLD && state.banUntil < now + RL_BAN_MS) {
    state.banUntil = now + RL_BAN_MS;
  }
  saveRateLimit(state);
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

// Normalize a session.media object on save: trim strings, drop empty fields,
// and return undefined when nothing is set (keeps the JSON tidy).
function cleanMedia(media) {
  if (!media || typeof media !== "object") return undefined;
  const out = {};
  ["type", "heading", "text", "textEs", "video", "image", "lyrics", "lyricsEs", "map", "website"].forEach((k) => {
    const v = (media[k] || "").toString().trim();
    if (v) out[k] = v;
  });
  return Object.keys(out).length ? out : undefined;
}

// ── HH:MM validation ───────────────────────────────────────────────────
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const URL_RE = /^https?:\/\/.+/i;

// ── safeURL — only allow http(s) URLs into href, block javascript:/data: ──
function safeURL(url) {
  if (!url) return "#";
  const s = String(url).trim();
  return /^https?:\/\//i.test(s) ? s : "#";
}

// ── Online presenter detection — mirror of app.jsx isSessionOnline ───────
function isSessionOnline(s) {
  if (!s) return false;
  // Session-level flag ("one or more presentations online") OR any per-talk flag.
  if (s.onlinePresenter) return true;
  return Array.isArray(s.talks) && s.talks.some((t) => t && t.online);
}

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
  //    Counts ONLY the explicit `talk.presenter` (NOT coauthors). A coauthor who
  //    isn't presenting can legitimately appear in other sessions at the same
  //    time, so including them produces a flood of false positives.
  //    Talks without an explicit presenter are SKIPPED (conservative fallback:
  //    prefer a missed conflict over a fake one — Mónica's call, 2026-05-21).
  //    Online presenters are excluded too: overlap is a physical-room concern,
  //    and a remote presenter doesn't tie up a room or compete for the same
  //    person's physical presence between aulas.
  //    Same-session multi-talk by one person is fine; we de-dup that.
  const presences = []; // { sessionIdx, name, displayName, day, sm, em }
  data.sessions.forEach((s, sIdx) => {
    const sm = toMin(s.start);
    const em = toMin(s.end);
    if (sm == null || em == null) return;
    const names = new Set();
    const displayNames = {};
    (s.talks || []).forEach((t) => {
      const raw = (t.presenter || "").trim();
      if (!raw) return; // no explicit presenter → skip (conservative)
      if (s.onlinePresenter || t.online) return; // online presenter → not a physical-room conflict
      const k = normName(raw);
      if (!k) return;
      names.add(k);
      if (!displayNames[k]) displayNames[k] = raw;
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

  // 4) REMOTE-ACCESS COVERAGE — sesiones sin Meet ni YouTube. Una sesión
  //    necesita AL MENOS UNO de los dos canales remotos. Keynotes se
  //    excluyen aquí porque el check específico de abajo (5) ya cubre
  //    su caso particular (solo YouTube, nunca Meet).
  const roomMeet = {};
  const roomYT = {};
  data.rooms.forEach((r) => { roomMeet[r.id] = r.meet || ""; roomYT[r.id] = (r.youtube || "").trim(); });
  data.sessions.forEach((s, idx) => {
    // Keynotes & ICED talks are YouTube-only (covered by check 5); the
    // pre-conference (2026-06-23) is in-person by design; breaks need nothing.
    if (s.type === "keynote" || s.type === "talk") return;
    if (s.day === "2026-06-23") return;
    if (s.type === "break") return;
    if (s.meet) return;
    if (s.youtube && String(s.youtube).trim()) return;
    if (s.room === "*" || !s.room) return;
    if (roomYT[s.room]) return; // inherits the room's YouTube livestream
    const inherited = roomMeet[s.room];
    if (!inherited) {
      issues.push({
        kind: "missing-meet",
        severity: "warning",
        title: "Sin canal remoto",
        detail: `«${s.title}» (${s.day} ${s.start}–${s.end}, ${s.roomName || s.room}) no tiene Meet ni YouTube. Los asistentes online no podrán acceder.`,
        sessionRefs: [{ idx, label: `${s.start}–${s.end} · ${s.title}` }]
      });
    }
  });

  // 5) KEYNOTES WITHOUT YOUTUBE STREAM — keynotes are the typical streamed
  //    sessions; flag any keynote that still lacks a `session.youtube` so
  //    Mónica doesn't forget one. Warning, not error — some keynotes may
  //    intentionally not be streamed (e.g. pre-conference instructions).
  data.sessions.forEach((s, idx) => {
    if (s.type !== "keynote") return; // ICED talks don't require a livestream
    if (s.day === "2026-06-23") return; // pre-conf welcome/instructions: in-person
    if (s.youtube && String(s.youtube).trim()) return;
    if (roomYT[s.room]) return; // inherits the room's YouTube livestream
    issues.push({
      kind: "keynote-no-youtube",
      severity: "warning",
      title: "Keynote sin retransmisión",
      detail: `«${s.title}» (${s.day} ${s.start}–${s.end}, ${s.roomName || s.room}) es una keynote sin URL de YouTube (ni propia ni heredada de la sala). Pega el livestream en la sala (Auditorio) o en la sesión si va a retransmitirse.`,
      sessionRefs: [{ idx, label: `${s.start}–${s.end} · ${s.title}` }]
    });
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
function formatCountdown(until) {
  const sec = Math.max(0, Math.ceil((until - Date.now()) / 1000));
  if (sec >= 24 * 3600) {
    const d = Math.floor(sec / (24 * 3600));
    const h = Math.floor((sec % (24 * 3600)) / 3600);
    return `${d}d ${h}h`;
  }
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  return `${sec}s`;
}

function LoginGate({ onSuccess }) {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [rl, setRl] = React.useState(() => rateLimitStatus());

  // Live countdown while locked out
  React.useEffect(() => {
    if (rl.ok) return undefined;
    const id = setInterval(() => setRl(rateLimitStatus()), 1000);
    return () => clearInterval(id);
  }, [rl.ok]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    // If already locked out: count the attempt (so persistent bots escalate
    // to the 1-week ban) but don't actually check anything.
    const before = rateLimitStatus();
    if (!before.ok) {
      recordRateLimitFailure();
      setRl(rateLimitStatus());
      return;
    }

    setBusy(true);
    try {
      // PBKDF2 is intentionally slow (~250-400 ms on a normal CPU). That
      // already throttles online attempts; the rate limit is on top.
      const hash = await pbkdf2(password, ADMIN_PBKDF2_SALT, ADMIN_PBKDF2_ITERATIONS);
      const emailOK = email.trim().toLowerCase() === ADMIN_EMAIL.toLowerCase();
      const hashOK = constantTimeEq(hash, ADMIN_PBKDF2_HASH);
      if (emailOK && hashOK) {
        clearRateLimit();
        sessionStorage.setItem(SESSION_KEY, "1");
        onSuccess();
        return;
      }
      recordRateLimitFailure();
      const after = rateLimitStatus();
      setRl(after);
      if (after.ok) {
        setError(`Email o contraseña incorrectos. ${after.attemptsRemaining} intento(s) antes del bloqueo.`);
      }
    } catch (err) {
      setError("Error: " + (err.message || err));
    }
    setBusy(false);
  };

  const locked = !rl.ok;
  const lockMsg = !rl.ok
    ? rl.kind === "ban"
      ? `Bloqueado por demasiados intentos fallidos. Inténtalo de nuevo en ${formatCountdown(rl.until)}.`
      : `Demasiados intentos. Espera ${formatCountdown(rl.until)} antes de volver a probar.`
    : null;

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand" aria-hidden="true">
          <span className="c1">I</span>
          <span className="c2">C</span>
          <span className="c1">ED</span>
          <span className="c3">26</span>
        </div>
        <h1>Acceso</h1>
        <p className="login-sub">Identifícate para continuar</p>

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
            disabled={locked}
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
            disabled={locked}
          />
        </label>

        {error && <div className="login-error" role="alert">{error}</div>}

        {locked && (
          <div className={`login-cooldown tone-${rl.kind}`} role="alert">
            <strong>{rl.kind === "ban" ? "Acceso bloqueado" : "Demasiados intentos"}</strong>
            <span>{lockMsg}</span>
          </div>
        )}

        <button type="submit" className="login-submit" disabled={busy || locked}>
          {busy ? "Comprobando…" : "Entrar"}
        </button>

        <a href="/" className="login-back">← Volver al programa</a>

        <p className="login-disclaimer">
          La sesión se cierra al cerrar la pestaña.
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
    const js = buildProgrammeJS(data);
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

  // ── Direct publish to GitHub (no export-commit-push dance) ────────────
  const [publishing, setPublishing] = React.useState(false);
  const [publishStatus, setPublishStatus] = React.useState(null);
  const [showTokenModal, setShowTokenModal] = React.useState(false);

  // Auto-dismiss success toast after 8s; errors stay until next attempt.
  React.useEffect(() => {
    if (!publishStatus || publishStatus.kind !== "ok") return;
    const id = setTimeout(() => setPublishStatus(null), 8000);
    return () => clearTimeout(id);
  }, [publishStatus]);

  const publishToGitHub = async () => {
    const token = (() => {
      try { return localStorage.getItem(GITHUB_TOKEN_KEY) || ""; }
      catch (_) { return ""; }
    })();
    if (!token) {
      setShowTokenModal(true);
      return;
    }
    const defaultMsg = "Update programme via admin panel";
    const commitMessage = window.prompt(
      "Mensaje de commit (corto, descriptivo). Cancela para no publicar.",
      defaultMsg
    );
    if (commitMessage == null) return; // user cancelled
    const msg = commitMessage.trim() || defaultMsg;
    setPublishing(true);
    setPublishStatus(null);
    try {
      const sha = await githubPublish(buildProgrammeJS(data), msg, token);
      // Treat the published state as the new baseline. isDirty is a useMemo
      // derived from data vs. original.current — to flip it back to false we
      // both reset the baseline AND replace `data` with a fresh clone, which
      // makes React re-run the useMemo (JSON-equal so isDirty becomes false).
      original.current = clone(data);
      try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
      setData((d) => clone(d));
      setPublishStatus({
        kind: "ok",
        message: "Publicado en GitHub (commit " + (sha ? sha.slice(0, 7) : "?") + "). GH Pages republica en ~30 s. Recarga la pública con Ctrl+Shift+R para verlo."
      });
    } catch (err) {
      setPublishStatus({ kind: "error", message: err.message || String(err) });
    } finally {
      setPublishing(false);
    }
  };

  // Stats for the topbar
  const stats = React.useMemo(() => ({
    sessions: data.sessions.length,
    rooms: data.rooms.length,
    buildings: data.clusters.length,
    days: data.meta.days.length,
    meetCovered: data.rooms.filter((r) => r.meet).length,
    sessionsWithMeet: data.sessions.filter((s) => s.meet).length,
    sessionsWithYoutube: data.sessions.filter((s) => s.youtube).length
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
            <span className="dirty-pill" title="Hay cambios sin publicar">
              <span className="dot" /> Cambios sin publicar
            </span>
          )}
          {isDirty && (
            <button className="btn-ghost" onClick={discardDraft} title="Descartar borrador">
              Descartar
            </button>
          )}
          <button
            className="btn-primary btn-publish"
            onClick={publishToGitHub}
            disabled={!isDirty || publishing}
            title="Hacer commit + push directo al repo (GH Pages republica en ~30s)"
          >
            {publishing ? "Publicando…" : "↑ Publicar"}
          </button>
          <button
            className="btn-ghost btn-mini btn-token-cfg"
            onClick={() => setShowTokenModal(true)}
            title="Configurar token de GitHub"
            aria-label="Configurar token de GitHub"
          >
            ⚙
          </button>
          <button
            className="btn-ghost"
            onClick={exportData}
            title="Descargar programme.js (modo fallback, sin tocar GitHub)"
            disabled={!isDirty}
          >
            ↓ Exportar
          </button>
          <a className="btn-ghost" href="/" target="_blank" rel="noopener noreferrer" title="Abrir web pública">
            Ver web ↗
          </a>
          <button className="btn-ghost" onClick={onLogout} title="Cerrar sesión">
            Salir
          </button>
        </div>
      </header>

      {publishStatus && (
        <div className={"publish-status publish-" + publishStatus.kind} role="status">
          <span>{publishStatus.message}</span>
          <button className="publish-dismiss" onClick={() => setPublishStatus(null)} aria-label="Cerrar">✕</button>
        </div>
      )}

      {showTokenModal && (
        <PublishConfigModal onClose={() => setShowTokenModal(false)} />
      )}

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
          <strong>Para publicar:</strong> pulsa <em>↑ Publicar</em> (commit directo a GitHub).
          La primera vez te pedirá un token (botón <em>⚙</em>). Como alternativa offline,
          <em> ↓ Exportar</em> descarga el <code>programme.js</code> para commitearlo a mano.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// PublishConfigModal — paste-the-token modal for first-time setup
// ─────────────────────────────────────────────────────────────────────
function PublishConfigModal({ onClose }) {
  const [token, setToken] = React.useState(() => {
    try { return localStorage.getItem(GITHUB_TOKEN_KEY) || ""; }
    catch (_) { return ""; }
  });
  const [reveal, setReveal] = React.useState(false);
  const save = () => {
    const v = token.trim();
    try {
      if (v) localStorage.setItem(GITHUB_TOKEN_KEY, v);
      else localStorage.removeItem(GITHUB_TOKEN_KEY);
    } catch (_) {}
    onClose();
  };
  const remove = () => {
    setToken("");
    try { localStorage.removeItem(GITHUB_TOKEN_KEY); } catch (_) {}
  };
  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal modal-publish" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Configuración de publicación</h2>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar">✕</button>
        </header>
        <div className="modal-body">
          <p>
            Para publicar cambios directamente desde el admin necesitas un{" "}
            <strong>Personal Access Token de GitHub</strong> con permiso de
            escritura sobre <code>{GITHUB_REPO}</code>.
          </p>
          <details className="token-howto">
            <summary>Cómo generarlo (paso a paso)</summary>
            <ol>
              <li>
                Abre <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">
                  github.com/settings/personal-access-tokens/new
                </a>{" "}(fine-grained, recomendado).
              </li>
              <li>Token name: <code>ICED26 admin publish</code>.</li>
              <li>Expiration: lo que prefieras (1 julio 2026 cubre todo el congreso).</li>
              <li>Repository access → <em>Only select repositories</em> → <code>{GITHUB_REPO}</code>.</li>
              <li>
                Repository permissions → <strong>Contents: Read and write</strong>{" "}
                (eso es lo único que necesita; deja todo lo demás como está).
              </li>
              <li>Generate token → cópialo (empieza por <code>github_pat_</code>) y pégalo aquí abajo.</li>
            </ol>
          </details>
          <label className="token-label">
            <span>Token</span>
            <input
              type={reveal ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="github_pat_… o ghp_…"
              className="token-input"
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              className="btn-mini btn-reveal"
              onClick={() => setReveal((r) => !r)}
              title={reveal ? "Ocultar" : "Mostrar"}
            >
              {reveal ? "Ocultar" : "Ver"}
            </button>
          </label>
          <p className="muted token-warn">
            El token se guarda <strong>solo en tu navegador</strong> (<code>localStorage</code>). No se envía a ningún
            servidor que no sea <code>api.github.com</code>. Si compartes este equipo, usa <em>Borrar</em> antes de irte.
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={remove} title="Quitar el token guardado">
            Borrar
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn-primary" onClick={save} disabled={!token.trim()}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// SessionsTab
// ─────────────────────────────────────────────────────────────────────
function SessionsTab({ data, setData, editingIdx, setEditingIdx }) {
  const [filter, setFilter] = React.useState({ day: "", building: "", type: "", q: "", online: false });
  // editingIdx is lifted up so the Validation tab can jump-to-edit

  const filtered = React.useMemo(() => {
    const q = filter.q.trim().toLowerCase();
    return data.sessions
      .map((s, idx) => ({ ...s, _idx: idx }))
      .filter((s) => {
        if (filter.day && s.day !== filter.day) return false;
        if (filter.building && s.cluster !== filter.building) return false;
        if (filter.type && s.type !== filter.type) return false;
        if (filter.online && !isSessionOnline(s)) return false;
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
        <label className="filter-online">
          <input
            type="checkbox"
            checked={filter.online}
            onChange={(e) => setFilter((f) => ({ ...f, online: e.target.checked }))}
          />
          <span>🌐 Solo online</span>
        </label>
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
                  <div className="t-title">
                    {isSessionOnline(s) && <span className="online-tag" title="Sesión con ponente online">🌐</span>}
                    {s.title || <em className="muted">(sin título)</em>}
                  </div>
                  {s.fullName && s.fullName !== s.title && (
                    <div className="t-fullname muted">{s.fullName}</div>
                  )}
                </td>
                <td className="td-talks">{(s.talks || []).length || ""}</td>
                <td className="td-meet">
                  {s.meet ? (
                    <a href={safeURL(s.meet)} target="_blank" rel="noopener noreferrer" title={s.meet}>✓</a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                  {s.youtube && (
                    <a href={safeURL(s.youtube)} target="_blank" rel="noopener noreferrer" title={s.youtube} className="yt-tag" aria-label="YouTube">▶</a>
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

  // Lock background scroll while the editor is open. The editor intentionally
  // does NOT close on Esc or on a backdrop click — only the ✕ / Cancelar /
  // Guardar buttons close it, so in-progress edits can't be lost by accident.
  React.useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

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
    if (s.youtube && !URL_RE.test(s.youtube)) e.youtube = "URL inválida";
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
      cardTitle: (s.cardTitle || "").trim(),
      chair: (s.chair || "").trim(),
      media: cleanMedia(s.media),
      onlinePresenter: !!s.onlinePresenter,
      // Keynotes & ICED talks are YouTube-only — never persist a Meet for them.
      meet: (s.type === "keynote" || s.type === "talk") ? "" : (s.meet || "").trim(),
      // Symposia/papers/workshops use Meet, not YouTube — keep youtube only for keynote/talk.
      youtube: (s.type === "keynote" || s.type === "talk") ? (s.youtube || "").trim() : "",
      talks: (s.talks || [])
        .filter((t) => t.title || t.authors || t.presenter || t.abstract)
        .map((t) => {
          const out = {
            time: (t.time || "").trim(),
            title: (t.title || "").trim(),
            authors: (t.authors || "").trim(),
            presenter: (t.presenter || "").trim(),
            abstract: (t.abstract || "").trim(),
            keywords: (t.keywords || "").trim()
          };
          // Only include the online flag when truthy, to keep the JSON tidy.
          if (t.online) out.online = true;
          // Pre-recorded video flag + optional link (kept tidy: only when set).
          if (t.video) {
            out.video = true;
            const vu = (t.videoUrl || "").trim();
            if (vu) out.videoUrl = vu;
          }
          return out;
        })
    };
    onSave(cleaned);
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <form className="modal session-modal-edit" onSubmit={submit}>
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

          <Field label="Título card (opcional)"
            hint="Sobreescribe lo que se ve en la card pública. Vacío = automático: 1 charla → título de la charla; Papers/Pósters → su «theme» (description); el resto → el Título de arriba.">
            <input type="text" value={s.cardTitle || ""} onChange={(e) => setField("cardTitle", e.target.value)}
              placeholder="Vacío = automático" />
          </Field>

          <Field label="Nombre completo (opcional)" hint="P. ej. «Session 4: Keynote with Ruth Graham». Solo se usa en búsqueda.">
            <input type="text" value={s.fullName || ""} onChange={(e) => setField("fullName", e.target.value)} />
          </Field>

          <Field label="Chair / Moderador/a (opcional)"
            hint="Modera la sesión. Se muestra en la card y en el detalle. Talleres y espacios colaborativos no llevan chair.">
            <input type="text" value={s.chair || ""} onChange={(e) => setField("chair", e.target.value)}
              placeholder="P. ej. Ariane Dumont" />
          </Field>

          {s.type === "keynote" || s.type === "talk" ? (
            <>
              <div className="form-note">
                Las <strong>keynotes</strong> e <strong>ICED Talks</strong> son solo YouTube (sin Meet).
                El livestream se hereda de la sala (Auditorio / Sala Menor); puedes sobreescribirlo a nivel de sesión aquí.
              </div>
              <Field label="Enlace YouTube (opcional)" error={errors.youtube}
                hint="Retransmisión en directo (solo visualización). Normalmente se hereda de la sala (Auditorio / Sala Menor); este campo lo sobreescribe a nivel de sesión.">
                <input type="url" value={s.youtube || ""} onChange={(e) => setField("youtube", e.target.value)}
                  placeholder="https://www.youtube.com/live/XXXXXXXXXXX" />
              </Field>
            </>
          ) : (
            <Field label="Enlace Meet (opcional)" error={errors.meet}
              hint="Sesión interactiva en Google Meet. Vacío = sin Meet (solo presencial). Los simposios, papers, talleres… usan Meet, no YouTube.">
              <input type="url" value={s.meet || ""} onChange={(e) => setField("meet", e.target.value)}
                placeholder="https://meet.google.com/abc-defg-hij" />
            </Field>
          )}

          <Field label="Ponencias online (general)"
            hint="Marca esto si la sesión tendrá una o más ponencias online, sin señalar cuál — muestra el indicador «online» en la sesión. Si conoces la ponencia concreta, márcala individualmente abajo (entonces no hace falta esto).">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={!!s.onlinePresenter}
                onChange={(e) => setField("onlinePresenter", e.target.checked)}
              />
              <span>Una o más ponencias serán online</span>
            </label>
          </Field>

          {(() => {
            const media = s.media || {};
            const setMedia = (patch) => {
              const next = { ...media, ...patch };
              const hasAny = Object.values(next).some((v) => (v || "").toString().trim());
              setField("media", hasAny ? next : undefined);
            };
            return (
              <details className="media-editor" open={!!(media.video || media.heading || media.lyrics || media.image || media.map || media.website)}>
                <summary>Media especial (vídeo / imagen / letra)</summary>
                <p className="form-note">
                  Bloque destacado dentro de la sesión (p. ej. el vídeo + letra del himno en la Clausura).
                  Deja todo vacío si no aplica.
                </p>
                <Field label="Título del bloque" hint="P. ej. «Gaudeamus Igitur».">
                  <input type="text" value={media.heading || ""} onChange={(e) => setMedia({ heading: e.target.value })}
                    placeholder="Vacío = sin bloque" />
                </Field>
                <Field label="Enlace del vídeo (YouTube)" hint="Se incrusta el reproductor. Acepta enlace de YouTube, youtu.be o el ID.">
                  <input type="url" value={media.video || ""} onChange={(e) => setMedia({ video: e.target.value })}
                    placeholder="https://www.youtube.com/watch?v=XXXXXXXXXXX" />
                </Field>
                <Field label="Texto introductorio (EN)">
                  <textarea rows={6} value={media.text || ""} onChange={(e) => setMedia({ text: e.target.value })} />
                </Field>
                <Field label="Texto introductorio (ES)">
                  <textarea rows={6} value={media.textEs || ""} onChange={(e) => setMedia({ textEs: e.target.value })} />
                </Field>
                <Field label="Letra (original)" hint="Se muestra respetando los saltos de línea.">
                  <textarea rows={6} value={media.lyrics || ""} onChange={(e) => setMedia({ lyrics: e.target.value })} />
                </Field>
                <Field label="Letra (traducción ES)" hint="Opcional: se muestra junto a la original cuando el idioma es español.">
                  <textarea rows={6} value={media.lyricsEs || ""} onChange={(e) => setMedia({ lyricsEs: e.target.value })} />
                </Field>
                <Field label="Imagen (ruta en el repo)" hint="P. ej. «assets/gaudeamus-igitur.jpg». Súbela al repo en /assets.">
                  <input type="text" value={media.image || ""} onChange={(e) => setMedia({ image: e.target.value })}
                    placeholder="assets/archivo.jpg" />
                </Field>
                <Field label="Mapa (lugar o dirección)" hint="Se incrusta un mapa de Google. Escribe el nombre/dirección (p. ej. «Casino de Salamanca, Calle Zamora 15, Salamanca») o pega una URL de Google Maps embed.">
                  <input type="text" value={media.map || ""} onChange={(e) => setMedia({ map: e.target.value })}
                    placeholder="Casino de Salamanca, Calle Zamora 15, Salamanca" />
                </Field>
                <Field label="Sitio web (enlace)" hint="Enlace externo mostrado como botón «Visitar web».">
                  <input type="url" value={media.website || ""} onChange={(e) => setMedia({ website: e.target.value })}
                    placeholder="https://www.casinodesalamanca.es" />
                </Field>
              </details>
            );
          })()}

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
      { time: "", title: "", authors: "", presenter: "", abstract: "", keywords: "", online: false, video: false, videoUrl: "" }
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
          <div className={`talk-row ${isOpen ? "is-open" : ""} ${t.online ? "is-online" : ""} ${t.video ? "is-video" : ""}`} key={i}>
            <div className="talk-controls">
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} title="Subir">↑</button>
              <button type="button" onClick={() => move(i, 1)} disabled={i === talks.length - 1} title="Bajar">↓</button>
              <button type="button" onClick={() => remove(i)} className="danger" title="Eliminar">✕</button>
              <label
                className={`talk-online-toggle ${t.online ? "is-on" : ""}`}
                title={t.online ? "Presenter online — pulsa para quitar" : "Marcar como presenter online"}
              >
                <input
                  type="checkbox"
                  checked={!!t.online}
                  onChange={(e) => update(i, { online: e.target.checked })}
                />
                <span aria-hidden="true">🌐</span>
              </label>
              <label
                className={`talk-video-toggle ${t.video ? "is-on" : ""}`}
                title={t.video ? "Vídeo pregrabado — pulsa para quitar" : "Marcar como vídeo pregrabado"}
              >
                <input
                  type="checkbox"
                  checked={!!t.video}
                  onChange={(e) => update(i, { video: e.target.checked })}
                />
                <span aria-hidden="true">🎬</span>
              </label>
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
              {t.video && (
                <input
                  type="url"
                  placeholder="Enlace al vídeo (YouTube) — se reproduce en su franja"
                  value={t.videoUrl || ""}
                  onChange={(e) => update(i, { videoUrl: e.target.value })}
                  className="talk-videourl"
                />
              )}

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

  // Bulk-propagate this room's Meet to all its sessions, OVERWRITING their
  // per-session meet. Useful because a Calendar Meet recurring on the same
  // room shares one URL across the 4 days. YouTube does NOT go here — each
  // YouTube livestream has a unique URL per session, edited from SessionEditor.
  const propagateMeetToSessions = (room) => {
    const sessionsForRoom = data.sessions.filter((s) => s.room === room.id);
    if (sessionsForRoom.length === 0) {
      alert("Esta sala no tiene sesiones asignadas todavía.");
      return;
    }
    const meetVal = (room.meet || "").trim();
    if (!meetVal) {
      alert("Esta sala no tiene Meet. Pega la URL antes de propagar.");
      return;
    }
    const ok = confirm(
      `Se asignará el Meet a las ${sessionsForRoom.length} sesiones de «${room.name}»:\n\n${meetVal}\n\nEsto sobrescribe cualquier Meet previo en esas sesiones. ¿Continuar?`
    );
    if (!ok) return;
    setData((d) => ({
      ...d,
      sessions: d.sessions.map((s) =>
        s.room === room.id ? { ...s, meet: meetVal } : s
      )
    }));
  };

  return (
    <div className="rooms-tab">
      <div className="rooms-head">
        <h2>Salas y Meet</h2>
        <p className="muted">
          El <strong>Meet</strong> (interactivo) y el <strong>YouTube</strong> (livestream) son por sala.
          Las keynotes e ICED Talks heredan el YouTube de su sala. Pulsa <em>Aplicar</em> para volcar el
          Meet a las sesiones de la sala.
          <br />
          El interruptor <strong>Activo / Cerrado</strong> decide si los botones Meet/YouTube se ven en la
          web: en <em>Cerrado</em> salen en gris (deshabilitados) hasta el día del congreso.
          <br />
          <strong>{data.rooms.filter((r) => r.active).length} de {stats.rooms}</strong> salas activas ·
          <strong> {stats.meetCovered} de {stats.rooms}</strong> con Meet ·
          <strong> {data.rooms.filter((r) => (r.youtube || "").trim()).length}</strong> con YouTube
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

                <div className="rr-links">
                  <input
                    type="url"
                    className="rr-meet"
                    placeholder="Meet de la sala — https://meet.google.com/abc-defg-hij"
                    value={r.meet || ""}
                    onChange={(e) => updateRoom(r.id, { meet: e.target.value })}
                  />
                  <input
                    type="url"
                    className="rr-yt"
                    placeholder="YouTube livestream de la sala (opcional)"
                    value={r.youtube || ""}
                    onChange={(e) => updateRoom(r.id, { youtube: e.target.value })}
                  />
                </div>

                <button
                  type="button"
                  className={`rr-toggle ${r.active ? "is-active" : "is-inactive"}`}
                  onClick={() => updateRoom(r.id, { active: !r.active })}
                  aria-pressed={r.active}
                  title={r.active
                    ? "Enlaces ACTIVOS: los botones Meet/YouTube de esta sala se ven en la web."
                    : "Enlaces CERRADOS: los botones Meet/YouTube de esta sala salen en gris hasta que la actives."}>
                  <span className="rr-toggle-dot" aria-hidden="true"></span>
                  {r.active ? "Activo" : "Cerrado"}
                </button>

                <span className={`rr-status ${r.meet || r.youtube ? "ok" : "empty"}`}>
                  {r.meet || r.youtube ? "✓" : "—"}
                </span>

                <div className="rr-actions">
                  <button
                    type="button"
                    className="btn-mini btn-apply"
                    onClick={() => propagateMeetToSessions(r)}
                    title="Aplicar el Meet de la sala a todas sus sesiones (sobrescribe)"
                  >
                    Aplicar
                  </button>
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
    ["missing-meet", "Sin canal remoto", "La sesión no tiene Meet ni YouTube — los asistentes online no podrán entrar."],
    ["keynote-no-youtube", "Keynote sin YouTube", "Una keynote no tiene URL de retransmisión asignada."]
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
