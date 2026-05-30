/* eslint-disable */
// ICED26 — public attendee view
// All times handled in Europe/Madrid local clock.
// The grid is built on CLUSTER columns (Auditorio, Hospedería Fonseca,
// Colegio Fonseca, Edificio I+D+i). Each cell holds one or more parallel
// sessions running in different rooms within that cluster, side-by-side.

const { useState, useEffect, useMemo, useRef, useCallback } = React;

// ─── Online presenter detection ──────────────────────────────────────────
// A session counts as "online" when any individual talk inside it is flagged
// (talk.online === true). There is no whole-session online flag — online is
// always marked per talk. Drives the teal ONLINE badge on cells, the modal
// banner, the Mi-Agenda indicator, and the admin filters/table.
function isSessionOnline(s) {
  if (!s) return false;
  // Session-level flag ("one or more presentations online") OR any per-talk flag.
  if (s.onlinePresenter) return true;
  return Array.isArray(s.talks) && s.talks.some((t) => t && t.online);
}

// ─── YouTube embed helper ─────────────────────────────────────────────────
// Accepts a bare 11-char video id, a watch URL, a youtu.be link, a /live/ or
// /embed/ URL, and returns a privacy-friendly nocookie embed URL ("" if none).
function youtubeEmbed(v) {
  if (!v) return "";
  const s = String(v).trim();
  let id = "";
  if (/^[\w-]{11}$/.test(s)) id = s;
  else {
    const m = s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/live\/)([\w-]{11})/);
    if (m) id = m[1];
  }
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : "";
}

// ─── Google Maps embed helper ─────────────────────────────────────────────
// Accepts a full Google-Maps embed/output=embed URL (used as-is) or a plain
// place/address query, and returns a keyless embeddable Maps URL ("" if none).
function mapEmbed(v) {
  if (!v) return "";
  const s = String(v).trim();
  if (/^https?:\/\/.*output=embed/i.test(s) || /\/maps\/embed/i.test(s)) return s;
  return "https://maps.google.com/maps?q=" + encodeURIComponent(s) + "&z=16&output=embed";
}
// Plain (non-embed) Maps link for the "open in Google Maps" button.
function mapLink(v) {
  if (!v) return "";
  const s = String(v).trim();
  if (/^https?:\/\//i.test(s)) return s;
  return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(s);
}

// ─── Pre-recorded video detection ─────────────────────────────────────────
// A talk can be a pre-recorded video (played in its slot instead of a live
// presentation). Marked per talk via talk.video === true, with an optional
// talk.videoUrl (YouTube link). Session counts as "has video" if any talk is.
function isSessionVideo(s) {
  if (!s) return false;
  return Array.isArray(s.talks) && s.talks.some((t) => t && t.video);
}

// ─── Global / spanning rows ───────────────────────────────────────────────
// Breaks (coffee/lunch) and any session pinned to room "*" render as a single
// full-width bar that spans every building view — the "ALL" visual. Mónica
// moved the breaks into a real room (Claustro) for logistics, but they should
// still SHOW as spanning bars (just labelled with that room), and must not
// count toward a building's session total (keeps empty buildings greyed out).
function isGlobalRow(s) {
  return !!s && (s.room === "*" || s.type === "break");
}

// ─── YouTube stream detection ────────────────────────────────────────────
// Two different "remote" channels coexist on this programme:
//   - Google Meet → interactive room. Marked by isSessionOnline + session.meet.
//   - YouTube     → one-way livestream, no interaction. Used for the Auditorio
//     Hospedería and the Sala Menor sessions. Stored in session.youtube.
// Both can coexist on the same session (a hybrid session can be retransmitted).
function hasYouTube(s) {
  return !!(s && s.youtube && String(s.youtube).trim());
}

// ─── Official / secondary title resolution ────────────────────────────────
// The generic section name (s.title, e.g. "A - Papers 2") stays the MAIN title
// everywhere — it matches the printed programme + room signage, so it's what
// people use to find their session. officialTitle() returns the extra
// descriptive line shown alongside it (in a distinct style), in priority order:
//   1) cardTitle — admin override set in the backstage
//   2) the single talk's own title (1-talk workshops, symposia, collab spaces)
//   3) description — the EasyChair session "theme" (Papers, Posters, ICED Talks)
// Returns "" when there's nothing more specific than the generic name.
function officialTitleInfo(s) {
  if (!s) return null;
  if (s.cardTitle && String(s.cardTitle).trim()) return { text: String(s.cardTitle).trim(), isTheme: false };
  if (Array.isArray(s.talks) && s.talks.length === 1 && s.talks[0] && s.talks[0].title) {
    return { text: s.talks[0].title, isTheme: false };
  }
  if (s.description && String(s.description).trim()) return { text: String(s.description).trim(), isTheme: true };
  return null;
}
function officialTitle(s) {
  const o = officialTitleInfo(s);
  return o ? o.text : "";
}
// Renders the secondary "official" line. When the text is the EasyChair session
// theme (the `description`, used by Papers/Posters), it is prefixed with a
// localized "Theme:" label so it reads as the card's theme, not a talk title.
// Single-talk titles and manual cardTitle overrides get no prefix.
function OfficialTitle({ session, className, t }) {
  const o = officialTitleInfo(session);
  if (!o) return null;
  return (
    <div className={className}>
      {o.isTheme && <span className="official-theme-label">{(t && t.themeLabel) || "Theme:"} </span>}
      {o.text}
    </div>
  );
}

// ─── Per-room livestream + link gating ────────────────────────────────────
// YouTube is a per-room livestream: a session inherits its room's stream URL
// unless it carries its own session.youtube override.
function effectiveYouTube(s, data) {
  if (!s) return "";
  // YouTube livestream is ONLY for keynotes and ICED talks. Everything else
  // (symposia, papers, workshops…) uses Meet — even in the Auditorio, where a
  // symposium does NOT inherit the room's keynote livestream.
  if (s.type !== "keynote" && s.type !== "talk") return "";
  if (s.youtube && String(s.youtube).trim()) return String(s.youtube).trim();
  const rooms = data && data.rooms;
  if (Array.isArray(rooms)) {
    const r = rooms.find((x) => x.id === s.room);
    if (r && r.youtube && String(r.youtube).trim()) return String(r.youtube).trim();
  }
  return "";
}
// True for session types streamed on YouTube (keynotes + ICED talks). Used to
// show the STREAM badge/banner even before the livestream URL is published — so
// attendees know these sessions WILL be broadcast. The actual link stays gated
// (greyed "Watch on YouTube" button until the room is opened).
function isStreamed(s) {
  return !!s && (s.type === "keynote" || s.type === "talk");
}
// Meet/YouTube buttons stay locked (greyed, not clickable) until the session's
// room is switched Active in the backstage. Closed by default before the congress.
function roomLinksActive(s, data) {
  const rooms = data && data.rooms;
  if (!Array.isArray(rooms) || !s) return false;
  const r = rooms.find((x) => x.id === s.room);
  return !!(r && r.active);
}

// ─── URL sanitization ────────────────────────────────────────────────────
// Defense in depth: when rendering <a href={…}> with values that came from
// data we don't fully control (Meet URLs, future imports, hand-edited JSON),
// pass them through safeURL so only http(s) URLs ever make it into href.
// Blocks javascript:, data:, vbscript:, etc.
function safeURL(url) {
  if (!url) return "#";
  const s = String(url).trim();
  return /^https?:\/\//i.test(s) ? s : "#";
}

// ─── Stable session ID for deep-linking ──────────────────────────────────
// Day + start time + room is unique per schedule. Strip separators for URL friendliness.
function sessionId(s) {
  return `${s.day.replace(/-/g, "")}-${s.start.replace(":", "")}-${s.room}`;
}
function findSessionById(data, id) {
  if (!id) return null;
  return data.sessions.find(s => sessionId(s) === id) || null;
}

// ─── Favorites (Mi agenda) — localStorage-backed ─────────────────────────
const FAVORITES_KEY = "iced26-favorites";
function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch { return new Set(); }
}
function saveFavorites(set) {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(Array.from(set))); } catch {}
}
function useFavorites() {
  const [favorites, setFavorites] = useState(() => loadFavorites());
  const toggle = useCallback((sId) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(sId)) next.delete(sId);
      else next.add(sId);
      saveFavorites(next);
      return next;
    });
  }, []);
  // Sync across tabs
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === FAVORITES_KEY) setFavorites(loadFavorites());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return [favorites, toggle];
}

// ─── Star button (filled when favorited) ──────────────────────────────────
function StarButton({ active, onClick, label, size = 14, className = "" }) {
  return (
    <button
      type="button"
      className={`star-btn ${active ? "is-active" : ""} ${className}`}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); onClick(); }}
      aria-label={label}
      aria-pressed={active}
      title={label}
    >
      <svg viewBox="0 0 24 24" width={size} height={size}
        fill={active ? "currentColor" : "none"}
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
      </svg>
    </button>
  );
}

// ─── i18n ─────────────────────────────────────────────────────────────────
const I18N = {
  en: {
    subtitle: "Salamanca · 23–26 June 2026",
    rooms: "Rooms",
    live: "LIVE",
    now: "Now",
    past: "Ended",
    upcoming: "Upcoming",
    join: "Join Meet",
    linksClosed: "Opens on the conference day",
    today: "TODAY",
    types: {
      keynote: "Keynote", symposium: "Symposium", paper: "Paper",
      workshop: "Workshop", poster: "Posters", collaborative: "Collab. Space",
      talk: "ICED Talks", doctoral: "Doctoral Colloquium", social: "Social",
      meeting: "Meeting", break: "Break", other: "Session"
    },
    timeTravel: "Time travel",
    realNow: "Real now",
    admin: "Admin",
    everyRoom: "All rooms",
    searchPlaceholder: "Search contributions, authors, sessions (e.g. 15K)…",
    searchNoResults: "No matches",
    searchShortcut: "⌘K",
    share: "Share",
    copyLink: "Copy link",
    linkCopied: "Link copied",
    pastNote: "Past sessions remain clickable — the Meet link stays open.",
    meetLinks: "Meet links",
    parallel: "parallel sessions",
    online: "ONLINE",
    onlinePresenterTitle: "Online presenter",
    onlinePresenterDesc: "One or more presentations in this session will be online.",
    myAgenda: "My agenda",
    myAgendaTitle: "My personal agenda",
    addToAgenda: "Add to my agenda",
    removeFromAgenda: "Remove from my agenda",
    agendaEmpty: "Your agenda is empty. Tap the star on any session to add it.",
    agendaEmptyHint: "Your favorites stay on this device, no login needed.",
    abstract: "Abstract",
    keywords: "Keywords",
    nextUp: "Next up",
    showAbstract: "Show abstract",
    hideAbstract: "Hide abstract",
    yourTimezone: "Your timezone",
    salamancaTime: "Salamanca time",
    yourLocalTime: "Your local time",
    tzVsSalamanca: "vs Salamanca",
    tzSameAsSalamanca: "Same clock as Salamanca",
    startsIn: "Starts in",
    endsIn: "Ends in",
    inProgress: "In progress",
    ended: "Ended",
    streaming: "STREAM",
    streamingTitle: "Streamed on YouTube",
    streamingDesc: "This session is broadcast live on YouTube. Watch-only — no two-way interaction.",
    watchOnYouTube: "Watch on YouTube",
    themeLabel: "Theme:",
    video: "VIDEO",
    videoTitle: "Pre-recorded video",
    videoDesc: "One or more presentations in this session are pre-recorded videos, played during their time slot.",
    videoTalk: "Pre-recorded video",
    watchVideo: "Watch video",
    chairLabel: "Chair:"
  },
  es: {
    subtitle: "Salamanca · 23–26 junio 2026",
    rooms: "Salas",
    live: "EN VIVO",
    now: "Ahora",
    past: "Pasada",
    upcoming: "Próxima",
    join: "Entrar a Meet",
    linksClosed: "Disponible el día del congreso",
    today: "HOY",
    types: {
      keynote: "Conferencia", symposium: "Simposio", paper: "Comunicación",
      workshop: "Taller", poster: "Pósters", collaborative: "Espacio colab.",
      talk: "ICED Talks", doctoral: "Coloquio Doctoral", social: "Social",
      meeting: "Reunión", break: "Pausa", other: "Sesión"
    },
    timeTravel: "Viaje en el tiempo",
    realNow: "Ahora real",
    admin: "Admin",
    everyRoom: "Todas las salas",
    searchPlaceholder: "Buscar contribuciones, autores, sesiones (p. ej. 15K)…",
    searchNoResults: "Sin resultados",
    searchShortcut: "⌘K",
    share: "Compartir",
    copyLink: "Copiar enlace",
    linkCopied: "Enlace copiado",
    pastNote: "Las sesiones pasadas siguen activas — el enlace Meet sigue abierto.",
    meetLinks: "Enlaces Meet",
    parallel: "sesiones paralelas",
    online: "ONLINE",
    onlinePresenterTitle: "Ponente online",
    onlinePresenterDesc: "Una o más ponencias de esta sesión se presentarán de forma online.",
    myAgenda: "Mi agenda",
    myAgendaTitle: "Mi agenda personal",
    addToAgenda: "Añadir a mi agenda",
    removeFromAgenda: "Quitar de mi agenda",
    agendaEmpty: "Tu agenda está vacía. Pulsa la estrella en cualquier sesión para añadirla.",
    agendaEmptyHint: "Tus favoritos se guardan en este dispositivo, sin necesidad de cuenta.",
    abstract: "Resumen",
    keywords: "Palabras clave",
    nextUp: "Siguiente",
    showAbstract: "Mostrar resumen",
    hideAbstract: "Ocultar resumen",
    yourTimezone: "Tu zona horaria",
    salamancaTime: "Hora de Salamanca",
    yourLocalTime: "Tu hora local",
    tzVsSalamanca: "vs Salamanca",
    tzSameAsSalamanca: "Misma hora que Salamanca",
    startsIn: "Empieza en",
    endsIn: "Termina en",
    inProgress: "En curso",
    ended: "Terminada",
    streaming: "DIRECTO",
    streamingTitle: "Retransmisión en YouTube",
    streamingDesc: "Esta sesión se retransmite en directo por YouTube. Solo visualización — sin interacción.",
    watchOnYouTube: "Ver en YouTube",
    themeLabel: "Tema:",
    video: "VÍDEO",
    videoTitle: "Vídeo pregrabado",
    videoDesc: "Una o más ponencias de esta sesión son vídeos pregrabados, reproducidos en su franja horaria.",
    videoTalk: "Vídeo pregrabado",
    watchVideo: "Ver vídeo",
    chairLabel: "Modera:"
  }
};

// ─── Time helpers (Europe/Madrid) ─────────────────────────────────────────
function madridParts(d) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return {
    dayKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10),
    hh: parts.hour, mm: parts.minute,
    label: `${parts.hour}:${parts.minute}`
  };
}

function hmToMinutes(hm) {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToLabel(min) {
  const h = Math.floor(min / 60),m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function madridDate(dayKey, hhmm) {
  return new Date(`${dayKey}T${hhmm}:00+02:00`);
}

// ─── User-timezone helpers ────────────────────────────────────────────────
// All session times in data/programme.js are Europe/Madrid local "HH:MM"
// strings (the congress is in late June 2026 → always CEST, UTC+2). These
// helpers convert a Madrid-local moment to the attendee's own clock and
// expose the offset, so online presenters in other timezones can see when
// their slot really hits without doing mental arithmetic.

// Demo override key. Lets anyone preview the site in a different TZ from
// the browser console without touching DevTools or the system clock:
//   localStorage.setItem("iced26-tz-override", "Asia/Tokyo"); location.reload();
//   localStorage.removeItem("iced26-tz-override");           location.reload();
// Or use the friendlier helpers exposed on window.iced26 below.
const TZ_OVERRIDE_KEY = "iced26-tz-override";

function userTimezone() {
  try {
    const override = localStorage.getItem(TZ_OVERRIDE_KEY);
    if (override) {
      // Validate it's a real IANA zone — Intl will throw on garbage.
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: override });
        return override;
      } catch {}
    }
  } catch {}
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; }
  catch { return ""; }
}

// "11:00" Madrid on 2026-06-24 → e.g. "05:00" for America/New_York.
// Uses Intl with explicit timeZone so it's deterministic, not tied to the
// JS runtime's local clock (matters in Node tests / SSR; in the browser
// `userTimezone()` is the local clock anyway).
function formatInUserTZ(dayKey, hhmm) {
  const d = madridDate(dayKey, hhmm);
  const tz = userTimezone();
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz || undefined,
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(d);
}

// Offset between the user's local clock and Madrid for a specific moment.
// Positive ⇒ user is AHEAD (e.g. Tokyo = +7h vs CEST).
// Negative ⇒ user is BEHIND (e.g. New York = −6h vs CEST).
// Computed per-moment via Intl rather than `Date.getTimezoneOffset()` so
// DST in either side is honoured and the result doesn't depend on the
// JS runtime's local clock.
function userOffsetMinutesVsMadrid(dayKey, hhmm) {
  const d = madridDate(dayKey, hhmm);
  const tz = userTimezone();
  if (!tz || tz === "Europe/Madrid") return 0;
  const partsIn = (zone) => Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(d).map((p) => [p.type, p.value])
  );
  const u = partsIn(tz);
  const m = partsIn("Europe/Madrid");
  const userMin = parseInt(u.hour, 10) * 60 + parseInt(u.minute, 10);
  const madridMin = parseInt(m.hour, 10) * 60 + parseInt(m.minute, 10);
  // Handle calendar-day wrap (e.g. user in Tokyo at 02:00 sees +1 day vs Madrid).
  let dayDelta = parseInt(u.day, 10) - parseInt(m.day, 10);
  if (dayDelta > 15) dayDelta -= 30;
  else if (dayDelta < -15) dayDelta += 30;
  return (userMin - madridMin) + dayDelta * 24 * 60;
}

// "+5h30" / "−6h" / "±0"
function formatOffsetLabel(minutes) {
  if (!minutes) return "±0";
  const sign = minutes > 0 ? "+" : "−";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h${String(m).padStart(2, "0")}`;
}

// True if the attendee is NOT in Madrid's clock right now (any DST quirks
// included). Used as the "show TZ chip & extra modal row" gate.
function userIsInDifferentTZ(dayKey, hhmm) {
  return userOffsetMinutesVsMadrid(dayKey, hhmm) !== 0;
}

// "2 h 14 min" / "35 min" for countdown chips. Direction (starts / ends /
// ended) is added by the caller from the i18n bundle.
function formatDurationApprox(deltaMs, lang) {
  const total = Math.max(0, Math.round(deltaMs / 60000));
  if (total < 1) return lang === "es" ? "menos de 1 min" : "less than 1 min";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

function sessionState(s, now) {
  const { dayKey, minutes } = madridParts(now);
  if (s.day !== dayKey) {
    if (s.day < dayKey) return "past";
    return "future";
  }
  const sm = hmToMinutes(s.start),em = hmToMinutes(s.end);
  if (minutes < sm) return "future";
  if (minutes >= em) return "past";
  return "live";
}

// ─── Icons ────────────────────────────────────────────────────────────────
const Icon = ({ name, ...p }) => {
  const paths = {
    camera: <><path d="M2 6h11l3-2v12l-3-2H2z" /><circle cx="7.5" cy="10" r="1.5" fill="currentColor" /></>,
    chevron: <polyline points="6,8 10,12 14,8" />,
    chevronR: <polyline points="8,6 12,10 8,14" />,
    globe: <><circle cx="10" cy="10" r="8" /><ellipse cx="10" cy="10" rx="3.5" ry="8" /><line x1="2" y1="10" x2="18" y2="10" /></>,
    settings: <><circle cx="10" cy="10" r="3" /><path d="M10 1v3M10 16v3M19 10h-3M4 10H1M16.4 3.6l-2.1 2.1M5.7 14.3l-2.1 2.1M16.4 16.4l-2.1-2.1M5.7 5.7L3.6 3.6" /></>
  };
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
      {paths[name]}
    </svg>);

};

// ─── Cluster Meet menu (dropdown) ─────────────────────────────────────────
function ClusterMeetMenu({ cluster, rooms, liveByRoom, t, lang }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const liveCount = rooms.filter((r) => liveByRoom[r.id]).length;

  useEffect(() => {
    const onDoc = (e) => {if (ref.current && !ref.current.contains(e.target)) setOpen(false);};
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className={`cluster-menu ${open ? "is-open" : ""} ${liveCount ? "has-live" : ""}`} ref={ref}>
      <button
        className="cluster-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${cluster.name} — ${rooms.length} ${t.rooms}${liveCount ? `, ${liveCount} ${t.live}` : ""}`}>
        
        <Icon name="camera" className="room-icon" />
        <span className="cluster-name">{cluster.short}</span>
        <span className="cluster-count">{rooms.length}</span>
        {liveCount > 0 && <span className="live-dot" aria-hidden="true"></span>}
        <Icon name="chevron" width="11" height="11" className="chev" />
      </button>
      {open &&
      <div className="cluster-dropdown" role="menu">
          <div className="cluster-dropdown-head">
            <strong>{cluster.name}</strong>
            <span className="muted">{cluster.subtitle}</span>
          </div>
          {rooms.map((r) => {
          const live = liveByRoom[r.id];
          // Effective link: prefer the live session's Meet, else the room's
          // YouTube stream. Greyed + non-clickable unless the room is Active.
          const url = live ? (live.meet || ((live.type === "keynote" || live.type === "talk") ? (r.youtube || "") : "")) : "";
          const clickable = !!(live && r.active && url);
          return (
            <a
              key={r.id}
              href={clickable ? safeURL(url) : "#"}
              target="_blank"
              rel="noopener noreferrer"
              className={`cluster-room ${live ? "is-live" : "is-idle"} ${live && !r.active ? "is-locked" : ""}`}
              onClick={(e) => {if (!clickable) e.preventDefault();}}
              role="menuitem">

                <span className="cr-name">{r.name}</span>
                {live
                ? (r.active
                  ? <span className="cr-live"><span className="live-dot" aria-hidden="true"></span>{live.title}</span>
                  : <span className="cr-idle">{lang === "es" ? "cerrado" : "closed"}</span>)
                : <span className="cr-idle">{lang === "es" ? "sin sesión activa" : "no live session"}</span>
              }
              </a>);

        })}
        </div>
      }
    </div>);

}

// ─── Header ───────────────────────────────────────────────────────────────
function Header({ data, now, lang, setLang, t, favorites, onOpenAgenda }) {
  const liveByRoom = useMemo(() => {
    const map = {};
    for (const s of data.sessions) {
      if (isGlobalRow(s)) continue;
      if (sessionState(s, now) === "live") map[s.room] = s;
    }
    return map;
  }, [data, now]);

  const roomsByCluster = useMemo(() => {
    const map = {};
    for (const r of data.rooms) {
      (map[r.cluster] ||= []).push(r);
    }
    return map;
  }, [data]);

  return (
    <header className="header">
      <div className="header-inner">
        <a className="brand" href="https://iced26.es/" target="_blank" rel="noopener noreferrer" aria-label="ICED26 home">
          <div className="brand-mark" aria-hidden="true">
            <span className="c1">I</span><span className="c2">C</span><span className="c1">ED</span><span className="c3">26</span>
          </div>
          <div className="brand-meta">
            <div className="brand-sub">{t.subtitle}</div>
          </div>
        </a>

        <nav className="rooms-bar" aria-label={t.meetLinks}>
          <span className="rooms-bar-label" aria-hidden="true">
            <Icon name="camera" width="12" height="12" />
            {t.meetLinks}
          </span>
          {data.clusters.map((c) =>
          <ClusterMeetMenu
            key={c.id}
            cluster={c}
            rooms={roomsByCluster[c.id] || []}
            liveByRoom={liveByRoom}
            t={t}
            lang={lang} />

          )}
        </nav>

        {onOpenAgenda && (
          <button
            className={`agenda-btn ${favorites && favorites.size > 0 ? "has-items" : ""}`}
            onClick={onOpenAgenda}
            aria-label={t.myAgenda}
            title={t.myAgenda}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill={favorites && favorites.size > 0 ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            <span className="agenda-btn-label">{t.myAgenda}</span>
            {favorites && favorites.size > 0 && (
              <span className="agenda-btn-count">{favorites.size}</span>
            )}
          </button>
        )}

        {(() => {
          // TZ chip: shown only if the attendee's clock differs from Madrid.
          // We anchor to the first conference day at midday to compute the
          // offset; all four days are CEST so any one works.
          const anchorDay = data.meta.days[0] || "2026-06-23";
          const tzMin = userOffsetMinutesVsMadrid(anchorDay, "12:00");
          const tz = userTimezone();
          if (!tz || tzMin === 0) return null;
          const offsetLabel = formatOffsetLabel(tzMin);
          // City part of "Region/City" reads more naturally than the full
          // IANA name (Europe/London → London).
          const tzShort = tz.includes("/") ? tz.split("/").pop().replace(/_/g, " ") : tz;
          return (
            <div className="tz-chip" title={`${t.yourTimezone}: ${tz} (${offsetLabel} ${t.tzVsSalamanca})`}>
              <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="10" cy="10" r="7.5" />
                <path d="M2.5 10h15M10 2.5c2.6 2.6 2.6 12.4 0 15M10 2.5c-2.6 2.6-2.6 12.4 0 15" />
              </svg>
              <span className="tz-chip-tz">{tzShort}</span>
              <span className="tz-chip-offset">{offsetLabel}</span>
            </div>
          );
        })()}

        <button className="lang-toggle" onClick={() => setLang(lang === "en" ? "es" : "en")} aria-label="Toggle language">
          <Icon name="globe" width="13" height="13" />
          {lang.toUpperCase()}
        </button>
      </div>
    </header>);

}

// ─── Day tabs ─────────────────────────────────────────────────────────────
function DayTabs({ data, dayIdx, setDayIdx, now, lang, t, children }) {
  const todayKey = madridParts(now).dayKey;
  return (
    <div className="day-tabs" role="tablist" aria-label={lang === "es" ? "Días del congreso" : "Conference days"}>
      <div className="day-tabs-label" aria-hidden="true">
        <span className="day-tabs-kicker">{lang === "es" ? "Programa" : "Programme"}</span>
      </div>
      {children && <div className="day-tabs-aside">{children}</div>}
      {data.meta.days.map((d, i) => {
        const labels = data.meta.dayLabels[d];
        const label = labels ? labels[lang] : d;
        const [head, ...tail] = label.split(" · ");
        const isToday = d === todayKey;
        return (
          <button
            key={d}
            role="tab"
            aria-selected={dayIdx === i}
            className={`day-tab ${dayIdx === i ? "active" : ""} ${isToday ? "is-today" : ""}`}
            onClick={() => setDayIdx(i)}>
            
            <span className="day-name">{head}</span>
            {tail.length > 0 && <span className="day-date">{tail.join(" · ")}{isToday && " · " + t.today}</span>}
            {tail.length === 0 && isToday && <span className="day-date">{t.today}</span>}
          </button>);

      })}
    </div>);

}

// ─── Building tabs ────────────────────────────────────────────────────────
// User picks ONE building; the grid below shows that building's rooms as columns.
function BuildingTabs({ data, buildingId, setBuildingId, dayIdx, now, lang, t }) {
  const dayKey = data.meta.days[dayIdx];

  // Per-building stats: total sessions today, live count today
  const stats = useMemo(() => {
    const m = {};
    for (const c of data.clusters) m[c.id] = { total: 0, live: 0, rooms: 0 };
    for (const r of data.rooms) {
      if (m[r.cluster]) m[r.cluster].rooms += 1;
    }
    for (const s of data.sessions) {
      if (s.day !== dayKey) continue;
      if (isGlobalRow(s)) continue;
      if (!m[s.cluster]) continue;
      m[s.cluster].total += 1;
      if (sessionState(s, now) === "live") m[s.cluster].live += 1;
    }
    return m;
  }, [data, dayKey, now]);

  // If the selected building has no sessions on this day, jump to the first one
  // that does — so you never land on an empty (greyed-out) building.
  useEffect(() => {
    if (stats[buildingId] && stats[buildingId].total === 0) {
      const firstWithSessions = data.clusters.find((c) => stats[c.id] && stats[c.id].total > 0);
      if (firstWithSessions && firstWithSessions.id !== buildingId) setBuildingId(firstWithSessions.id);
    }
  }, [buildingId, dayKey]);

  return (
    <div className="building-tabs" role="tablist" aria-label={lang === "es" ? "Edificios" : "Buildings"}>
      {data.clusters.map((c) => {
        const st = stats[c.id] || { total: 0, live: 0, rooms: 0 };
        const active = c.id === buildingId;
        const empty = st.total === 0;
        return (
          <button
            key={c.id}
            role="tab"
            aria-selected={active}
            aria-disabled={empty || undefined}
            disabled={empty}
            title={empty ? (lang === "es" ? "Sin sesiones este día" : "No sessions this day") : undefined}
            className={`building-tab ${active ? "active" : ""} ${st.live > 0 ? "has-live" : ""} ${empty ? "is-empty" : ""}`}
            onClick={() => { if (!empty) setBuildingId(c.id); }}>

            {active && st.live > 0 && (
              <svg className="bt-comet" preserveAspectRatio="none" aria-hidden="true">
                <rect x="1.5" y="1.5" rx="11" ry="11" pathLength="100" />
              </svg>
            )}
            <span className="bt-name">{c.name}</span>
            <span className="bt-meta">
              <span className="bt-rooms">{st.rooms} {st.rooms === 1 ? lang === "es" ? "sala" : "room" : lang === "es" ? "salas" : "rooms"}</span>
              <span className="bt-sep">·</span>
              {empty
                ? <span className="bt-empty">{lang === "es" ? "sin sesiones" : "no sessions"}</span>
                : <span className="bt-sessions">{st.total} {lang === "es" ? "sesiones" : "sessions"}</span>}
              {st.live > 0 && <span className="bt-live"><span className="dot"></span>{st.live} {t.live}</span>}
            </span>
          </button>);

      })}
    </div>);

}

// ─── Grid ─────────────────────────────────────────────────────────────────
// Renders the schedule for ONE building (selected via BuildingTabs).
// Columns = individual rooms within that building. Global breaks span all
// columns. Auditorio (single-room building) renders as one wide column.
function Grid({ data, dayIdx, buildingId, now, liveStyle, lang, t, onSessionClick, favorites, onToggleFavorite }) {
  const dayKey = data.meta.days[dayIdx];
  const cluster = data.clusters.find((c) => c.id === buildingId) || data.clusters[0];
  const buildingRooms = data.rooms.filter((r) => r.cluster === cluster.id);
  const roomIds = new Set(buildingRooms.map((r) => r.id));

  const daySessions = data.sessions.filter((s) =>
  s.day === dayKey && (isGlobalRow(s) || roomIds.has(s.room))
  );
  if (daySessions.length === 0) {
    return <div className="muted desktop-only" style={{ padding: 24 }}>{lang === "es" ? "No hay sesiones en este edificio hoy." : "No sessions in this building today."}</div>;
  }

  const minStart = Math.min(...daySessions.map((s) => hmToMinutes(s.start)));
  const maxEnd = Math.max(...daySessions.map((s) => hmToMinutes(s.end)));
  const gridStart = Math.floor(minStart / 30) * 30;
  const gridEnd = Math.ceil(maxEnd / 30) * 30;
  const slots = (gridEnd - gridStart) / 30;
  const SLOT_PX = 64;

  const minToY = (m) => (m - gridStart) / 30 * SLOT_PX;

  // Group sessions by room
  const byRoom = {};
  const globalRows = [];
  for (const s of daySessions) {
    if (isGlobalRow(s)) globalRows.push(s);else
    (byRoom[s.room] ||= []).push(s);
  }

  const nowParts = madridParts(now);
  const showNow = nowParts.dayKey === dayKey && nowParts.minutes >= gridStart && nowParts.minutes <= gridEnd;
  const nowY = showNow ? minToY(nowParts.minutes) : null;

  const gridStyle = {
    "--cols": buildingRooms.length,
    "--slots": slots,
    "--slot-h": SLOT_PX + "px"
  };

  return (
    <div className="grid-wrap desktop-only" data-building={cluster.id}>
      <div className="grid-headers" style={gridStyle}>
        <div className="col-time-header"></div>
        {buildingRooms.map((r) =>
        <div className="col-cluster-header" key={r.id}>
            <span className="cluster-h-name">{r.name}</span>
            <span className="cluster-h-sub">{r.code}</span>
          </div>
        )}
      </div>

      <div className="grid" style={gridStyle} role="table" aria-label={lang === "es" ? "Programa del día" : "Day programme"}>
        {/* Time column */}
        <div className="time-col">
          {Array.from({ length: slots }).map((_, i) => {
            const m = gridStart + i * 30;
            const isHour = m % 60 === 0;
            return (
              <div key={i} className={`time-tick ${isHour ? "hour" : "half"}`} data-time={minutesToLabel(m)}>
                {isHour ? minutesToLabel(m) : ""}
              </div>);

          })}
        </div>

        {/* Room columns */}
        {buildingRooms.map((room) => {
          const sessions = byRoom[room.id] || [];
          // Lay out overlapping sessions side-by-side within the column.
          // Algorithm: greedy column-packing — each session goes in the leftmost
          // sub-column whose last cell ends before this one starts.
          const sorted = [...sessions].map((s, idx) => ({ s, idx, sm: hmToMinutes(s.start), em: hmToMinutes(s.end) }))
            .sort((a, b) => a.sm - b.sm || b.em - b.sm - (a.em - a.sm));
          const subCols = []; // each entry: array of placed items
          for (const item of sorted) {
            let placed = false;
            for (let c = 0; c < subCols.length; c++) {
              const last = subCols[c][subCols[c].length - 1];
              if (last.em <= item.sm) {
                subCols[c].push(item);
                item.col = c;
                placed = true;
                break;
              }
            }
            if (!placed) {
              item.col = subCols.length;
              subCols.push([item]);
            }
          }
          const totalCols = Math.max(1, subCols.length);
          // For each item, find max overlap span it participates in
          for (const item of sorted) {
            let maxSpan = totalCols;
            // Count actual concurrent items for this one to decide its width
            const concurrent = sorted.filter(o => o.sm < item.em && o.em > item.sm);
            const usedCols = new Set(concurrent.map(o => o.col));
            maxSpan = Math.max(...usedCols) + 1;
            item.span = maxSpan;
          }
          return (
            <div key={room.id} className="cluster-col" role="cell">
              {sorted.map((item) => {
                const s = item.s;
                const top = minToY(item.sm);
                const height = minToY(item.em) - top - 4;
                const dur = item.em - item.sm;
                const si = item.idx;
                const state = sessionState(s, now);
                const typeColor = `var(--t-${s.type})`;
                const widthPct = 100 / item.span;
                const leftPct = item.col * widthPct;
                // Shorter sessions get higher z-index so they're always on top.
                const durZ = Math.max(1, Math.round((240 - dur) / 30));
                const zIndex = state === "live" ? durZ + 20 : durZ;
                return (
                  <div
                    key={item.idx}
                    role="button"
                    tabIndex="0"
                    className={`cell is-${state} ${dur <= 60 ? "is-short" : ""} ${item.span > 1 ? `sub-of-${item.span}` : "sub-of-1"} ${isSessionOnline(s) ? "is-online-presenter" : ""}`}
                    data-live-style={liveStyle}
                    onClick={() => { if (onSessionClick) onSessionClick(s); }}
                    onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && onSessionClick) { e.preventDefault(); onSessionClick(s); } }}
                    style={{
                      top: `${top}px`,
                      height: `${Math.max(height, 50)}px`,
                      left: `calc(${leftPct}% + 2px)`,
                      width: `calc(${widthPct}% - 4px)`,
                      right: "auto",
                      "--type-color": typeColor,
                      zIndex
                    }}
                    aria-label={`${t.types[s.type] || s.type}: ${s.title}, ${s.roomName}, ${s.start} to ${s.end}, ${state === "live" ? t.live : state === "past" ? t.past : t.upcoming}`}>
                    
                    <div className="cell-topbar">
                      {state === "live" &&
                      <span className="live-badge"><span className="dot"></span>{t.live}</span>
                      }
                      {isSessionOnline(s) && (
                        <span className="online-badge" title={t.onlinePresenterTitle}>
                          <svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <circle cx="8" cy="8" r="6.5"/>
                            <path d="M1.5 8h13M8 1.5c2.2 2 2.2 11 0 13M8 1.5c-2.2 2-2.2 11 0 13"/>
                          </svg>
                          {t.online}
                        </span>
                      )}
                      {isStreamed(s) && (
                        <span className="stream-badge" title={t.streamingTitle}>
                          <svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor" aria-hidden="true">
                            <path d="M3 3.2c0-.66.54-1.2 1.2-1.2h7.6c.66 0 1.2.54 1.2 1.2v9.6c0 .66-.54 1.2-1.2 1.2H4.2A1.2 1.2 0 0 1 3 12.8V3.2zM6.6 5v6l4.4-3-4.4-3z"/>
                          </svg>
                          {t.streaming}
                        </span>
                      )}
                      {isSessionVideo(s) && (
                        <span className="video-badge" title={t.videoTitle}>
                          <svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor" aria-hidden="true">
                            <path d="M2 4.5C2 3.67 2.67 3 3.5 3h6c.83 0 1.5.67 1.5 1.5v1.2l2.6-1.7c.4-.26.9.03.9.5v6.9c0 .47-.5.76-.9.5L11 10.3v1.2c0 .83-.67 1.5-1.5 1.5h-6A1.5 1.5 0 0 1 2 11.5v-7z"/>
                          </svg>
                          {t.video}
                        </span>
                      )}
                      {onToggleFavorite && (
                        <StarButton
                          active={favorites?.has(sessionId(s))}
                          onClick={() => onToggleFavorite(sessionId(s))}
                          label={favorites?.has(sessionId(s)) ? t.removeFromAgenda : t.addToAgenda}
                          className="cell-star"
                        />
                      )}
                    </div>
                    <div className="c-room">
                      <span className="c-time">{s.start}–{s.end}</span>
                    </div>
                    <div className="c-title">{s.title}</div>
                    <OfficialTitle session={s} className="c-official" t={t} />
                    <div className="c-foot">
                      {s.chair && (
                        <div className="c-chair"><span className="c-chair-label">{t.chairLabel}</span> {s.chair}</div>
                      )}
                      {dur > 60 && s.talks && s.talks.length > 0 &&
                      <div className="c-talks-count">{s.talks.length} {lang === "es" ? "contribuciones" : "contributions"}</div>
                      }
                      <div className="c-type" style={{ color: typeColor }}>{t.types[s.type] || s.type}</div>
                    </div>
                  </div>);

              })}
            </div>);

        })}

        {/* Global breaks / spanning sessions */}
        {globalRows.map((s, i) => {
          const state = sessionState(s, now);
          const top = minToY(hmToMinutes(s.start));
          const height = minToY(hmToMinutes(s.end)) - top - 4;
          // A spanning bar opens its modal when it carries detail (media block,
          // talks, a Meet/stream link, or it's a social/other event). Plain
          // coffee/lunch breaks have nothing to show, so they stay static.
          const clickable = !!onSessionClick && (
            !!s.media ||
            (Array.isArray(s.talks) && s.talks.length > 0) ||
            !!s.meet || !!effectiveYouTube(s, data) ||
            s.type === "social" || s.type === "other"
          );
          return (
            <div
              key={`brk-${i}`}
              className={`break-row is-${state} type-${s.type} ${clickable ? "is-clickable" : ""}`}
              style={{
                top: `${top}px`,
                height: `${Math.max(height, 32)}px`
              }}
              role={clickable ? "button" : "cell"}
              tabIndex={clickable ? 0 : undefined}
              onClick={clickable ? () => onSessionClick(s) : undefined}
              onKeyDown={clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSessionClick(s); } } : undefined}
              aria-label={`${s.title || t.types[s.type]}, ${s.start} to ${s.end}, ${s.room === "*" ? t.everyRoom : s.roomName}`}>

              <span className="b-time">{s.start}–{s.end}</span>
              <span className="b-title">{s.title || t.types[s.type]}</span>
              <span className="b-tag">{s.room === "*" ? t.everyRoom : s.roomName}</span>
            </div>);

        })}

        {/* Now line */}
        {showNow &&
        <div className="now-line" style={{ top: `${nowY}px` }} aria-hidden="true">
            <span className="now-label">{t.now} · {nowParts.label}</span>
          </div>
        }
      </div>

    </div>);

}

// ─── Mobile list ──────────────────────────────────────────────────────────
function MobileList({ data, dayIdx, buildingId, now, lang, t, onSessionClick, favorites, onToggleFavorite }) {
  const dayKey = data.meta.days[dayIdx];
  const cluster = data.clusters.find((c) => c.id === buildingId) || data.clusters[0];
  const sessions = data.sessions.filter((s) =>
  s.day === dayKey && (s.cluster === cluster.id || isGlobalRow(s))
  );
  const byHour = {};
  for (const s of sessions) {
    const h = s.start.slice(0, 2) + ":00";
    (byHour[h] ||= []).push(s);
  }
  const hours = Object.keys(byHour).sort();

  return (
    <>
      <div className="mobile-list">
        {hours.map((h) =>
        <div className="mobile-hour-group" key={h}>
            <div className="mobile-hour-label">{h}</div>
            {byHour[h].map((s, i) => {
            const state = sessionState(s, now);
            return (
              <a
                key={i}
                href={safeURL(s.meet)}
                target="_blank"
                rel="noopener noreferrer"
                className={`mobile-cell is-${state} ${isSessionOnline(s) ? "is-online-presenter" : ""}`}
                style={{ "--type-color": `var(--t-${s.type})` }}
                onClick={(e) => { e.preventDefault(); if (onSessionClick) onSessionClick(s); }}
                aria-label={`${t.types[s.type] || s.type}: ${s.title}, ${s.room === "*" ? t.everyRoom : s.roomName}, ${s.start}–${s.end}${isSessionOnline(s) ? ", " + t.onlinePresenterTitle : ""}`}>

                  <div className="m-room">
                    {s.room === "*" ? t.everyRoom : s.roomName}
                    {state === "live" && <span className="live-badge" style={{ position: "static", marginLeft: 8 }}><span className="dot"></span>{t.live}</span>}
                    {state === "past" && <span style={{ marginLeft: 8, color: "var(--ink-mute)" }}>✓ {t.past}</span>}
                    {isSessionOnline(s) && (
                      <span className="online-chip-inline" title={t.onlinePresenterTitle}>🌐 {t.online}</span>
                    )}
                    {isStreamed(s) && (
                      <span className="stream-chip-inline" title={t.streamingTitle}>▶ {t.streaming}</span>
                    )}
                    {isSessionVideo(s) && (
                      <span className="video-chip-inline" title={t.videoTitle}>🎬 {t.video}</span>
                    )}
                  </div>
                  <div className="m-title">{s.title}</div>
                  <OfficialTitle session={s} className="m-official" t={t} />
                  {s.chair && <div className="m-chair"><span className="c-chair-label">{t.chairLabel}</span> {s.chair}</div>}
                  <div className="m-meta">
                    {s.start}–{s.end}
                    {s.talks && s.talks.length > 0 && ` · ${s.talks.length} ${lang === "es" ? "contribuciones" : "contributions"}`}
                  </div>
                  {onToggleFavorite && (
                    <StarButton
                      active={favorites?.has(sessionId(s))}
                      onClick={() => onToggleFavorite(sessionId(s))}
                      label={favorites?.has(sessionId(s)) ? t.removeFromAgenda : t.addToAgenda}
                      className="mobile-cell-star"
                      size={16}
                    />
                  )}
                </a>);

          })}
          </div>
        )}
      </div>
    </>);

}

// ─── Time-travel scrubber ─────────────────────────────────────────────────
function Scrubber({ now, setNow, onGoLive, isLive, data, t, lang }) {
  const start = madridDate(data.meta.days[0], "06:00").getTime();
  const end = madridDate(data.meta.days[data.meta.days.length - 1], "23:00").getTime();
  const value = Math.max(start, Math.min(end, now.getTime()));

  const fmt = new Intl.DateTimeFormat(lang === "es" ? "es-ES" : "en-GB", {
    timeZone: "Europe/Madrid",
    weekday: "short", day: "2-digit", month: "short",
    hour: "2-digit", minute: "2-digit", hour12: false
  });

  return (
    <div className="scrubber" role="region" aria-label={t.timeTravel}>
      <span className="scrubber-label">⏱ {t.timeTravel}</span>
      <span className="scrubber-now">{fmt.format(now)}</span>
      <input
        type="range"
        min={start}
        max={end}
        step={5 * 60 * 1000}
        value={value}
        onChange={(e) => setNow(new Date(parseInt(e.target.value, 10)))}
        aria-label={t.timeTravel} />
      
      <button className={`scrubber-real ${isLive ? "is-live" : ""}`} onClick={onGoLive} title={t.realNow}>
        {isLive ? "● " : ""}{t.realNow}
      </button>
    </div>);

}

// ─── Session search (combobox) ───────────────────────────────────────────
// Builds a flat searchable index over sessions + talks + authors.
// Selecting a result jumps to the right day/building and opens the modal.
function SessionSearch({ data, t, lang, onSelect }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);

  // Build index once
  const index = useMemo(() => {
    const out = [];
    for (const s of data.sessions) {
      const sId = sessionId(s);
      // EasyChair session code, e.g. "Session 15K: \u2026" \u2192 "15k". Printed on the
      // card; people search by it ("15k", "21m"), so index it as a token.
      const codeMatch = (s.fullName || "").match(/session\s+([0-9]+[a-z]?)/i);
      const code = codeMatch ? codeMatch[1].toLowerCase() : "";
      // Session-level entry (always)
      out.push({
        kind: "session",
        sId,
        session: s,
        code,
        primary: s.title,
        secondary: officialTitle(s) || (s.fullName && s.fullName !== s.title ? s.fullName : ""),
        haystack: [s.title, officialTitle(s), s.fullName, s.roomName, s.roomCode].filter(Boolean).join(" \u00b7 ").toLowerCase()
      });
      // Talk-level entries \u2014 also carry the session code/fullName so a code
      // search surfaces the contributions inside that session too.
      for (const talk of (s.talks || [])) {
        out.push({
          kind: "talk",
          sId,
          session: s,
          talk,
          code,
          primary: talk.title || "",
          secondary: talk.authors || "",
          haystack: [talk.title, talk.authors, talk.presenter, s.title, s.fullName].filter(Boolean).join(" \u00b7 ").toLowerCase()
        });
      }
    }
    return out;
  }, [data]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return [];
    const tokens = query.split(/\s+/).filter(Boolean);
    const codeQuery = query.replace(/[\s-]+/g, ""); // "15 k" / "15-k" → "15k"
    const matches = [];
    for (const item of index) {
      let score = 0;
      let allMatch = true;
      for (const tok of tokens) {
        const idx = item.haystack.indexOf(tok);
        if (idx < 0) { allMatch = false; break; }
        // Earlier match = higher score; talk title hits weighted higher
        score += 100 - Math.min(idx, 99);
        if (item.primary.toLowerCase().includes(tok)) score += 50;
      }
      // Direct EasyChair-code hit ("15k", "21m") — strong boost so the matching
      // session (and then its contributions) jumps to the top, even if the raw
      // token scan was weak.
      if (item.code && codeQuery && item.code === codeQuery) {
        allMatch = true;
        score += item.kind === "session" ? 1000 : 600;
      } else if (item.code && codeQuery && codeQuery.length >= 2 && item.code.startsWith(codeQuery)) {
        allMatch = true;
        score += item.kind === "session" ? 400 : 250;
      }
      if (allMatch) matches.push({ ...item, score });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, 10);
  }, [q, index]);

  // Reset active when results change
  useEffect(() => { setActiveIdx(0); }, [q]);

  // Click outside closes
  useEffect(() => {
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Cmd/Ctrl+K to focus
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const choose = (item) => {
    setOpen(false);
    setQ("");
    inputRef.current?.blur();
    onSelect(item.session);
  };

  const onKeyDown = (e) => {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (results[activeIdx]) choose(results[activeIdx]); }
    else if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); }
  };

  // Highlight matched substring(s)
  const renderHighlighted = (text) => {
    const query = q.trim().toLowerCase();
    if (!query || !text) return text;
    const tokens = query.split(/\s+/).filter(Boolean);
    const lower = text.toLowerCase();
    const ranges = [];
    for (const tok of tokens) {
      let from = 0;
      while (from < lower.length) {
        const i = lower.indexOf(tok, from);
        if (i < 0) break;
        ranges.push([i, i + tok.length]);
        from = i + tok.length;
      }
    }
    if (!ranges.length) return text;
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    const parts = [];
    let cursor = 0;
    merged.forEach(([a, b], i) => {
      if (a > cursor) parts.push(text.slice(cursor, a));
      parts.push(<mark key={i}>{text.slice(a, b)}</mark>);
      cursor = b;
    });
    if (cursor < text.length) parts.push(text.slice(cursor));
    return parts;
  };

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");

  return (
    <div className="session-search" ref={wrapRef}>
      <div className={`ss-input-wrap ${open ? "is-open" : ""}`}>
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="ss-icon"><circle cx="9" cy="9" r="5.5" /><path d="M13 13l4 4" /></svg>
        <input
          ref={inputRef}
          type="search"
          className="ss-input"
          placeholder={t.searchPlaceholder}
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          aria-label={t.searchPlaceholder}
          role="combobox"
          aria-expanded={open && !!q.trim() && results.length > 0}
          aria-controls="ss-listbox"
          aria-autocomplete="list"
          aria-activedescendant={open && results[activeIdx] ? `ss-opt-${activeIdx}` : undefined}
          autoComplete="off" />
        {q && (
          <button className="ss-clear" onClick={() => { setQ(""); inputRef.current?.focus(); }} aria-label="Clear">
            <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 5l10 10M15 5L5 15" /></svg>
          </button>
        )}
        {!q && <span className="ss-shortcut" aria-hidden="true">{isMac ? "\u2318K" : "Ctrl K"}</span>}
      </div>
      {open && q.trim() && (
        <div className="ss-dropdown" role="listbox" id="ss-listbox">
          {results.length === 0 && <div className="ss-empty">{t.searchNoResults}</div>}
          {results.map((r, i) => {
            const typeColor = `var(--t-${r.session.type})`;
            const dayLabel = data.meta.dayLabels[r.session.day]?.[lang]?.split(" \u00b7 ")[0] || r.session.day;
            return (
              <button
                key={r.kind + "-" + i}
                id={`ss-opt-${i}`}
                role="option"
                aria-selected={i === activeIdx}
                className={`ss-result ${i === activeIdx ? "active" : ""}`}
                onMouseEnter={() => setActiveIdx(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(r); }}>
                <span className="ss-result-dot" style={{ background: typeColor }} aria-hidden="true"></span>
                <span className="ss-result-body">
                  <span className="ss-result-primary">{renderHighlighted(r.primary)}</span>
                  {r.secondary && <span className="ss-result-secondary">{renderHighlighted(r.secondary)}</span>}
                  <span className="ss-result-meta">
                    <span>{dayLabel}</span>
                    <span aria-hidden="true">·</span>
                    <span>{r.session.start}–{r.session.end}</span>
                    <span aria-hidden="true">·</span>
                    <span>{r.session.roomName || r.session.room}</span>
                    {r.kind === "talk" && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="ss-result-in">{lang === "es" ? "en" : "in"} {r.session.title}</span>
                      </>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Toast (link-copied feedback) ────────────────────────────────────────
function showToast(message) {
  const el = document.createElement("div");
  el.className = "iced-toast";
  el.textContent = message;
  document.body.appendChild(el);
  // Fade in
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 1800);
}

// ─── Clipboard helper ────────────────────────────────────────────────────
function copyToClipboard(text) {
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(fallback);
  } else { fallback(); }
}

// ─── Share popover ───────────────────────────────────────────────────────
// Lets the user choose between sharing the Meet link, the programme deep-link,
// or downloading an .ics calendar entry.
function SharePopover({ session, t, lang, onClose, data }) {
  const wrapRef = useRef(null);
  useEffect(() => {
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose();
    };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const programmeUrl = (() => {
    const url = new URL(window.location.href);
    url.searchParams.set("session", sessionId(session));
    url.hash = "";
    return url.toString();
  })();

  // Meet sharing is gated the same way as the Join Meet button: while the
  // session's room is closed, the link isn't shareable yet (shown greyed).
  const linksActive = roomLinksActive(session, data);
  const items = [
    {
      key: "programme",
      label: lang === "es" ? "Enlace al programa" : "Programme link",
      sub: lang === "es" ? "Abre esta sesión en la web" : "Opens this session on the site",
      icon: <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11.5L11.5 9M9 11.5L7 13.5a2.5 2.5 0 01-3.5-3.5L5.5 8M11 8.5l2-2a2.5 2.5 0 013.5 3.5L14.5 12" /></svg>,
      action: () => { copyToClipboard(programmeUrl); showToast(lang === "es" ? "Enlace copiado" : "Link copied"); onClose(); }
    },
    session.meet && {
      key: "meet",
      label: lang === "es" ? "Enlace de Meet" : "Meet link",
      sub: linksActive ? (lang === "es" ? "Para entrar directo a la sala" : "Direct join URL") : t.linksClosed,
      icon: <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></svg>,
      disabled: !linksActive,
      action: () => { copyToClipboard(session.meet); showToast(lang === "es" ? "Meet copiado" : "Meet copied"); onClose(); }
    }
  ].filter(Boolean);

  return (
    <div className="share-popover" ref={wrapRef} role="menu">
      {items.map(item => (
        <button key={item.key} className={`share-item ${item.disabled ? "is-disabled" : ""}`} role="menuitem"
          onClick={item.disabled ? undefined : item.action}
          aria-disabled={item.disabled || undefined}
          title={item.disabled ? t.linksClosed : undefined}>
          <span className="share-item-icon">{item.icon}</span>
          <span className="share-item-body">
            <span className="share-item-label">{item.label}</span>
            <span className="share-item-sub">{item.sub}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

// ─── Session detail modal ────────────────────────────────────────────────
function SessionModal({ session, t, lang, now, onClose, favorites, onToggleFavorite, data }) {
  const [shareOpen, setShareOpen] = useState(false);
  const [expandedTalk, setExpandedTalk] = useState(null);
  // Close on Esc
  useEffect(() => {
    if (!session) return;
    const onKey = (e) => { if (e.key === "Escape" && !shareOpen) onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [session, onClose, shareOpen]);
  // Close share popover + collapse abstracts when session changes
  useEffect(() => { setShareOpen(false); setExpandedTalk(null); }, [session]);

  if (!session) return null;
  const dur = hmToMinutes(session.end) - hmToMinutes(session.start);
  const state = now ? sessionState(session, now) : null;
  const isLive = state === "live";
  const typeLabel = t.types[session.type] || session.type;
  const typeColor = `var(--t-${session.type})`;
  const dayLabel = (() => {
    try {
      const d = madridDate(session.day, session.start);
      return new Intl.DateTimeFormat(lang === "es" ? "es-ES" : "en-GB", {
        timeZone: "Europe/Madrid",
        weekday: "long", day: "2-digit", month: "long"
      }).format(d);
    } catch { return session.day; }
  })();

  const talks = session.talks || [];

  // Resolve the building name from the clusters catalog so the modal can
  // show "ROOM 2.1 · 2.1 · Edificio I+D+i". Skip for global (room "*")
  // sessions since they don't belong to a specific building.
  const buildingName = (() => {
    if (!data || !session.cluster || session.room === "*") return "";
    const c = data.clusters.find((x) => x.id === session.cluster);
    return c ? c.name : "";
  })();

  return (
    <div className="session-modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={session.title}>
      <div className={`session-modal ${isLive ? "is-live" : ""}`} onClick={(e) => e.stopPropagation()} style={{ "--type-color": typeColor }}>
        <div className="sm-topbar">
          {onToggleFavorite && (
            <StarButton
              active={favorites?.has(sessionId(session))}
              onClick={() => onToggleFavorite(sessionId(session))}
              label={favorites?.has(sessionId(session)) ? t.removeFromAgenda : t.addToAgenda}
              className="sm-star"
              size={18}
            />
          )}
          <button className="sm-close" onClick={onClose} aria-label={lang === "es" ? "Cerrar" : "Close"}>
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 5l10 10M15 5L5 15" /></svg>
          </button>
        </div>
        <div className="sm-head">
          <div className="sm-type" style={{ color: typeColor }}>{typeLabel}</div>
          <h2 className="sm-title">{session.title}</h2>
          <OfficialTitle session={session} className="sm-official" t={t} />
          {session.fullName && session.fullName !== session.title && (
            <div className="sm-fullname">{session.fullName}</div>
          )}
        </div>

        {isSessionOnline(session) && (
          <div className="sm-online-banner" role="note">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10"/>
              <path d="M2 12h20M12 2c3 3 3 17 0 20M12 2c-3 3-3 17 0 20"/>
            </svg>
            <div>
              <strong>{t.onlinePresenterTitle}</strong>
              <span>{t.onlinePresenterDesc}</span>
            </div>
          </div>
        )}

        {isStreamed(session) && (
          <div className="sm-stream-banner" role="note">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
              <path d="M4 5.5C4 4.67 4.67 4 5.5 4h13c.83 0 1.5.67 1.5 1.5v13c0 .83-.67 1.5-1.5 1.5h-13C4.67 20 4 19.33 4 18.5v-13zM10 8v8l6-4-6-4z"/>
            </svg>
            <div>
              <strong>{t.streamingTitle}</strong>
              <span>{t.streamingDesc}</span>
            </div>
          </div>
        )}

        {isSessionVideo(session) && (
          <div className="sm-video-banner" role="note">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
              <path d="M3 6.5C3 5.67 3.67 5 4.5 5h10c.83 0 1.5.67 1.5 1.5v2l4-2.6c.5-.32 1.1.04 1.1.64v10.9c0 .6-.6.96-1.1.64L16 15.5v2c0 .83-.67 1.5-1.5 1.5h-10A1.5 1.5 0 0 1 3 17.5v-11z"/>
            </svg>
            <div>
              <strong>{t.videoTitle}</strong>
              <span>{t.videoDesc}</span>
            </div>
          </div>
        )}

        <div className="sm-meta">
          <div className="sm-meta-row">
            <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.5 2.5" /></svg>
            <span><strong>{session.start}–{session.end}</strong> · {dayLabel} · {Math.round(dur)} min</span>
          </div>
          {(() => {
            // Show the attendee's local-clock equivalent of this session,
            // but only if their TZ actually differs from Madrid. Otherwise
            // this row is redundant noise.
            const tz = userTimezone();
            const offMin = userOffsetMinutesVsMadrid(session.day, session.start);
            if (!tz || offMin === 0) return null;
            const tzShort = tz.includes("/") ? tz.split("/").pop().replace(/_/g, " ") : tz;
            return (
              <div className="sm-meta-row sm-meta-tz">
                <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="10" cy="10" r="7.5" />
                  <path d="M2.5 10h15M10 2.5c2.6 2.6 2.6 12.4 0 15M10 2.5c-2.6 2.6-2.6 12.4 0 15" />
                </svg>
                <span>
                  <strong>{formatInUserTZ(session.day, session.start)}–{formatInUserTZ(session.day, session.end)}</strong>
                  <span className="muted"> · {t.yourLocalTime} · {tzShort} ({formatOffsetLabel(offMin)} {t.tzVsSalamanca})</span>
                </span>
              </div>
            );
          })()}
          <div className="sm-meta-row">
            <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l7-6 7 6v8a1 1 0 0 1-1 1h-3v-5H7v5H4a1 1 0 0 1-1-1z" /></svg>
            <span>
              {session.roomName || (session.room === "*" ? t.everyRoom : session.room)}
              {buildingName && <span className="sm-building"> · {buildingName}</span>}
            </span>
          </div>
          {session.chair && (
            <div className="sm-meta-row">
              <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="10" cy="6.5" r="3" /><path d="M4 16c0-3 2.7-5 6-5s6 2 6 5" /></svg>
              <span><span className="muted">{t.chairLabel}</span> <strong>{session.chair}</strong></span>
            </div>
          )}
        </div>

        {(() => {
          // Countdown pill — handy especially for online presenters checking
          // "when does my slot hit my clock". Hidden once the session ends.
          if (!now) return null;
          const startMs = madridDate(session.day, session.start).getTime();
          const endMs = madridDate(session.day, session.end).getTime();
          const nowMs = now.getTime();
          if (nowMs >= endMs) return null; // ended → don't clutter
          if (nowMs < startMs) {
            return (
              <div className="sm-countdown sm-countdown-future">
                <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="10" cy="10" r="7.5" />
                  <path d="M10 5v5l3 2" />
                </svg>
                <span><strong>{t.startsIn}</strong> {formatDurationApprox(startMs - nowMs, lang)}</span>
              </div>
            );
          }
          return (
            <div className="sm-countdown sm-countdown-live">
              <span className="sm-countdown-dot" aria-hidden="true" />
              <span><strong>{t.inProgress}</strong> · {t.endsIn} {formatDurationApprox(endMs - nowMs, lang)}</span>
            </div>
          );
        })()}

        {/* Actions are placed BEFORE the talks list so the Join Meet button is
            visible without scrolling — last-minute attendees won't always scroll
            past a 5-talk list to find it. */}
        <div className="sm-actions">
          {(() => {
            // Meet/YouTube buttons. They render greyed + locked (not clickable)
            // until the session's room is switched Active in the backstage.
            const linksActive = roomLinksActive(session, data);
            const yt = effectiveYouTube(session, data);
            const meetIcon = <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7" /><rect x="1" y="5" width="15" height="14" rx="2" ry="2" /></svg>;
            const ytIcon = <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M21.6 6.6c-.2-.9-.9-1.6-1.8-1.8C18.2 4.4 12 4.4 12 4.4s-6.2 0-7.8.4c-.9.2-1.6.9-1.8 1.8C2 8.2 2 12 2 12s0 3.8.4 5.4c.2.9.9 1.6 1.8 1.8 1.6.4 7.8.4 7.8.4s6.2 0 7.8-.4c.9-.2 1.6-.9 1.8-1.8.4-1.6.4-5.4.4-5.4s0-3.8-.4-5.4zM10 15.5v-7l6 3.5-6 3.5z"/></svg>;
            const arrow = <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M7 13l6-6M9 7h4v4" /></svg>;
            const lock = <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="9" width="12" height="8.5" rx="1.5" /><path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9" /></svg>;
            const meetLabel = lang === "es" ? "Enlace a Meet" : "Join Meet";
            // Remote-access channel depends on the session type:
            //  • keynote / talk      → YouTube live (recorded + streamed)
            //  • workshop            → no remote access at all (in-person)
            //  • break/social/other  → not a content session, no remote row
            //  • everything else (paper, symposium, collaborative, poster,
            //    doctoral)           → Google Meet
            const isStreamType = session.type === "keynote" || session.type === "talk";
            const noRemoteType = session.type === "workshop";
            const noRowType = session.type === "break" || session.type === "social" || session.type === "other";
            const showMeet = !isStreamType && !noRemoteType && !noRowType;
            const meetLive = session.meet && linksActive;
            const ytLive = yt && linksActive;
            return (
              <>
                {/* Meet — a real link only when the room is Active AND a link is
                    set; otherwise a greyed placeholder ("opens on the day"). */}
                {showMeet && (meetLive
                  ? <a href={safeURL(session.meet)} target="_blank" rel="noopener noreferrer" className="sm-meet-btn">{meetIcon}<span>{meetLabel}</span>{arrow}</a>
                  : <span className="sm-meet-btn is-locked" title={t.linksClosed} aria-disabled="true">{meetIcon}<span>{meetLabel}</span>{lock}</span>
                )}
                {/* YouTube live — keynotes + ICED talks. Greyed until published. */}
                {isStreamType && (ytLive
                  ? <a href={safeURL(yt)} target="_blank" rel="noopener noreferrer" className="sm-youtube-btn">{ytIcon}<span>{t.watchOnYouTube}</span>{arrow}</a>
                  : <span className="sm-youtube-btn is-locked" title={t.linksClosed} aria-disabled="true">{ytIcon}<span>{t.watchOnYouTube}</span>{lock}</span>
                )}
                {/* Workshops are the only sessions with no remote access. */}
                {noRemoteType && (
                  <span className="sm-no-meet muted">{lang === "es" ? "Sin acceso remoto" : "No remote access"}</span>
                )}
                {/* Note shown when a real link exists but the room is still closed. */}
                {!linksActive && ((showMeet && session.meet) || (isStreamType && yt)) && (
                  <span className="sm-locked-note muted">{t.linksClosed}</span>
                )}
              </>
            );
          })()}
          <div className="sm-share-wrap">
            <button className="sm-share-btn" onClick={() => setShareOpen(o => !o)} aria-label={t.share} aria-expanded={shareOpen} aria-haspopup="menu">
              <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="10" r="2.2" /><circle cx="15" cy="5" r="2.2" /><circle cx="15" cy="15" r="2.2" /><path d="M7 9l6-3M7 11l6 3" /></svg>
              <span>{t.share}</span>
              <svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}><path d="M5 8l5 5 5-5" /></svg>
            </button>
            {shareOpen && <SharePopover session={session} t={t} lang={lang} onClose={() => setShareOpen(false)} data={data} />}
          </div>
        </div>

        {session.media && (() => {
          const m = session.media;
          const embed = youtubeEmbed(m.video);
          const intro = (lang === "es" ? m.textEs : m.text) || m.text || "";
          const lyricsEs = (lang === "es" && m.lyricsEs) ? m.lyricsEs : "";
          return (
            <div className="sm-media">
              {m.heading && <h3 className="sm-media-heading">{m.heading}</h3>}
              {intro && <p className="sm-media-text">{intro}</p>}
              {embed && (
                <div className="sm-media-video">
                  <iframe
                    src={embed}
                    title={m.heading || "Video"}
                    loading="lazy"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    referrerPolicy="strict-origin-when-cross-origin"
                    allowFullScreen
                  />
                </div>
              )}
              {(m.lyrics || lyricsEs) && (
                <div className="sm-media-lyrics">
                  <div className="sm-detail-label">{t.lyricsLabel}</div>
                  <div className="sm-lyrics-cols">
                    {m.lyrics && <pre className="sm-lyrics-text">{m.lyrics}</pre>}
                    {lyricsEs && <pre className="sm-lyrics-text sm-lyrics-trans">{lyricsEs}</pre>}
                  </div>
                </div>
              )}
              {m.image && (
                <a className="sm-media-image-link" href={safeURL(m.image)} target="_blank" rel="noopener noreferrer">
                  <img src={m.image} alt={m.heading ? `${m.heading} — ${t.lyricsLabel}` : t.lyricsLabel} className="sm-media-image" loading="lazy" />
                  <span className="sm-media-image-cap">{t.openImage}</span>
                </a>
              )}
              {m.map && (
                <div className="sm-media-map">
                  <iframe
                    src={mapEmbed(m.map)}
                    title={m.heading || "Map"}
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    allowFullScreen
                  />
                </div>
              )}
              {(m.website || m.map) && (
                <div className="sm-media-links">
                  {m.website && (
                    <a className="sm-media-link" href={safeURL(m.website)} target="_blank" rel="noopener noreferrer">
                      <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M2.5 10h15M10 2.5c2.5 2.6 2.5 12.4 0 15M10 2.5c-2.5 2.6-2.5 12.4 0 15"/></svg>
                      <span>{t.visitWebsite}</span>
                    </a>
                  )}
                  {m.map && (
                    <a className="sm-media-link" href={mapLink(m.map)} target="_blank" rel="noopener noreferrer">
                      <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 18s6-5.3 6-10A6 6 0 0 0 4 8c0 4.7 6 10 6 10z"/><circle cx="10" cy="8" r="2.2"/></svg>
                      <span>{t.getDirections}</span>
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {talks.length > 0 && (
          <div className="sm-talks">
            <div className="sm-section-label">
              {talks.length} {lang === "es" ? (talks.length === 1 ? "contribución" : "contribuciones") : (talks.length === 1 ? "contribution" : "contributions")}
              {talks.some(tk => tk.abstract || tk.keywords) && (
                <span className="sm-section-hint">
                  · {lang === "es" ? "Pulsa para ver el resumen" : "Click for the abstract"}
                </span>
              )}
            </div>
            <ol className="sm-talks-list">
              {talks.map((talk, i) => {
                const hasDetail = !!(talk.abstract && talk.abstract.trim()) ||
                                  !!(talk.keywords && talk.keywords.trim()) ||
                                  !!(talk.video && talk.videoUrl);
                const isOpen = expandedTalk === i;
                const keywords = (talk.keywords || "")
                  .split(/[,;]/).map(k => k.trim()).filter(Boolean);
                return (
                  <li key={i} className={`sm-talk ${isOpen ? "is-open" : ""} ${hasDetail ? "has-detail" : ""}`}>
                    <div
                      className="sm-talk-row"
                      role={hasDetail ? "button" : undefined}
                      tabIndex={hasDetail ? 0 : undefined}
                      aria-expanded={hasDetail ? isOpen : undefined}
                      onClick={hasDetail ? () => setExpandedTalk(isOpen ? null : i) : undefined}
                      onKeyDown={hasDetail ? (e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setExpandedTalk(isOpen ? null : i);
                        }
                      } : undefined}
                    >
                      <div className="sm-talk-time">{talk.time || ""}</div>
                      <div className="sm-talk-body">
                        <div className="sm-talk-title">
                          {talk.title}
                          {talk.online && (
                            <span className="sm-talk-online" title={t.onlinePresenterTitle}>
                              <svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <circle cx="8" cy="8" r="6.5"/>
                                <path d="M1.5 8h13M8 1.5c2.2 2 2.2 11 0 13M8 1.5c-2.2 2-2.2 11 0 13"/>
                              </svg>
                              {t.online}
                            </span>
                          )}
                          {talk.video && (
                            <span className="sm-talk-video" title={t.videoTitle}>
                              <svg viewBox="0 0 16 16" width="9" height="9" fill="currentColor" aria-hidden="true">
                                <path d="M2 4.5C2 3.67 2.67 3 3.5 3h6c.83 0 1.5.67 1.5 1.5v1.2l2.6-1.7c.4-.26.9.03.9.5v6.9c0 .47-.5.76-.9.5L11 10.3v1.2c0 .83-.67 1.5-1.5 1.5h-6A1.5 1.5 0 0 1 2 11.5v-7z"/>
                              </svg>
                              {t.videoTalk}
                            </span>
                          )}
                          {hasDetail && (
                            <span className="sm-talk-chev" aria-hidden="true">
                              {isOpen ? "▾" : "▸"}
                            </span>
                          )}
                        </div>
                        {talk.authors && (
                          <div className="sm-talk-authors">
                            {talk.presenter && (
                              <span className="sm-talk-presenter">{talk.presenter}</span>
                            )}
                            {talk.presenter && talk.authors !== talk.presenter && " · "}
                            <span className="sm-talk-coauthors">
                              {talk.presenter ? talk.authors.replace(talk.presenter, "").replace(/^,\s*|,\s*$/g, "").replace(/,\s*,/g, ",") : talk.authors}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                    {isOpen && hasDetail && (
                      <div className="sm-talk-detail">
                        {talk.video && talk.videoUrl && (
                          <a className="sm-talk-video-link" href={safeURL(talk.videoUrl)} target="_blank" rel="noopener noreferrer">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                              <path d="M3 6.5C3 5.67 3.67 5 4.5 5h10c.83 0 1.5.67 1.5 1.5v2l4-2.6c.5-.32 1.1.04 1.1.64v10.9c0 .6-.6.96-1.1.64L16 15.5v2c0 .83-.67 1.5-1.5 1.5h-10A1.5 1.5 0 0 1 3 17.5v-11z"/>
                            </svg>
                            <span>{t.watchVideo}</span>
                          </a>
                        )}
                        {talk.abstract && (
                          <div className="sm-talk-abstract">
                            <div className="sm-detail-label">{t.abstract}</div>
                            <p>{talk.abstract}</p>
                          </div>
                        )}
                        {keywords.length > 0 && (
                          <div className="sm-talk-keywords">
                            <div className="sm-detail-label">{t.keywords}</div>
                            <ul className="sm-kw-chips">
                              {keywords.map((kw, j) => (
                                <li key={j} className="sm-kw-chip">{kw}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        )}

      </div>
    </div>
  );
}

// ─── My Agenda modal ─────────────────────────────────────────────────────
// Shows favorited sessions grouped by day with a "next up" highlight.
function AgendaModal({ open, onClose, favorites, data, t, lang, now, onSessionClick, onToggleFavorite }) {
  // ESC closes + lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  // Resolve favorite IDs to session objects (skip stale IDs that no longer exist)
  const items = useMemo(() => {
    if (!favorites || favorites.size === 0) return [];
    return data.sessions
      .filter((s) => favorites.has(sessionId(s)))
      .map((s) => ({
        s,
        id: sessionId(s),
        state: sessionState(s, now),
        sm: hmToMinutes(s.start)
      }))
      .sort((a, b) => {
        if (a.s.day !== b.s.day) return a.s.day.localeCompare(b.s.day);
        return a.sm - b.sm;
      });
  }, [favorites, data, now]);

  // Group by day
  const byDay = useMemo(() => {
    const g = {};
    items.forEach((it) => (g[it.s.day] ||= []).push(it));
    return g;
  }, [items]);

  // The first live or upcoming item is "next up"
  const nextItem = items.find((it) => it.state === "live") ||
                   items.find((it) => it.state === "future");

  if (!open) return null;

  return (
    <div className="agenda-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={t.myAgendaTitle}>
      <div className="agenda-modal" onClick={(e) => e.stopPropagation()}>
        <header className="agenda-head">
          <div className="agenda-head-titles">
            <h2>{t.myAgendaTitle}</h2>
            <div className="agenda-head-sub muted">
              {items.length === 0
                ? t.agendaEmptyHint
                : `${items.length} ${lang === "es" ? (items.length === 1 ? "sesión guardada" : "sesiones guardadas") : (items.length === 1 ? "saved session" : "saved sessions")}`}
            </div>
          </div>
          <button className="agenda-close" onClick={onClose} aria-label={lang === "es" ? "Cerrar" : "Close"}>
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>
          </button>
        </header>

        {items.length === 0 ? (
          <div className="agenda-empty">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            <h3>{t.agendaEmpty}</h3>
            <p className="muted">{t.agendaEmptyHint}</p>
          </div>
        ) : (
          <div className="agenda-body">
            {Object.entries(byDay).map(([day, dayItems]) => {
              const dayLabel = data.meta.dayLabels[day]?.[lang] || day;
              return (
                <section className="agenda-day" key={day}>
                  <header className="agenda-day-head">
                    <h3>{dayLabel}</h3>
                    <span className="muted">{dayItems.length}</span>
                  </header>
                  <ul className="agenda-list">
                    {dayItems.map((it) => {
                      const { s, state } = it;
                      const isNext = nextItem && it.id === nextItem.id;
                      const typeColor = `var(--t-${s.type})`;
                      return (
                        <li
                          key={it.id}
                          className={`agenda-item is-${state} ${isNext ? "is-next" : ""}`}
                          style={{ "--type-color": typeColor }}
                        >
                          {isNext && <span className="agenda-next-pill">{t.nextUp}</span>}
                          <button
                            type="button"
                            className="agenda-item-main"
                            onClick={() => { onSessionClick(s); onClose(); }}
                          >
                            <div className="agenda-item-time">
                              <span className="ai-time">{s.start}–{s.end}</span>
                              {state === "live" && <span className="ai-live">{t.live}</span>}
                              {state === "past" && <span className="ai-past">{t.past}</span>}
                            </div>
                            <div className="agenda-item-body">
                              <div className="agenda-item-title">
                                {isSessionOnline(s) && (
                                  <span className="ai-online" title={t.onlinePresenterTitle} aria-hidden="true">🌐</span>
                                )}
                                {s.title}
                              </div>
                              <OfficialTitle session={s} className="agenda-item-official" t={t} />
                              <div className="agenda-item-meta">
                                <span className="ai-type" style={{ color: typeColor }}>
                                  {t.types[s.type] || s.type}
                                </span>
                                {" · "}
                                <span>{s.roomName || s.room}</span>
                                {(() => {
                                  if (!s.cluster || s.room === "*") return null;
                                  const c = data.clusters.find((x) => x.id === s.cluster);
                                  return c ? <span className="muted"> · {c.name}</span> : null;
                                })()}
                                {isSessionOnline(s) && (
                                  <>
                                    {" · "}
                                    <span className="ai-online-text">{t.onlinePresenterTitle}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </button>
                          <div className="agenda-item-actions">
                            {s.meet && (
                              <a
                                href={safeURL(s.meet)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="agenda-meet-btn"
                                title={t.join}
                              >
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
                                Meet
                              </a>
                            )}
                            <StarButton
                              active={true}
                              onClick={() => onToggleFavorite(it.id)}
                              label={t.removeFromAgenda}
                              size={16}
                              className="agenda-item-star"
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

window.ICED26App = { Header, DayTabs, BuildingTabs, Grid, MobileList, Scrubber, SessionModal, SessionSearch, AgendaModal, I18N, madridParts, madridDate, sessionState, sessionId, findSessionById, useFavorites, StarButton, isSessionOnline };

// ─── Demo helpers: timezone preview from the console ──────────────────────
// Lets anyone (incl. Mónica) preview the site in any timezone without
// opening DevTools Sensors. Open the browser console (F12 → Console) and:
//   iced26.setTZ("Asia/Tokyo")  // pin override + reminds you to reload
//   iced26.clearTZ()             // remove override
//   iced26.tz                    // currently effective TZ (getter)
window.iced26 = window.iced26 || {};
window.iced26.setTZ = function (tz) {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch (_) {
    console.error("[iced26] Invalid IANA timezone:", tz, "— try e.g. 'Asia/Tokyo', 'America/New_York', 'Europe/London'.");
    return false;
  }
  try { localStorage.setItem(TZ_OVERRIDE_KEY, tz); } catch (_) {}
  console.log("%c[iced26] Timezone override set → " + tz + ". Reload (F5) to apply.", "color:#5BA9A3;font-weight:bold");
  return true;
};
window.iced26.clearTZ = function () {
  try { localStorage.removeItem(TZ_OVERRIDE_KEY); } catch (_) {}
  console.log("%c[iced26] Timezone override cleared. Reload (F5) to revert to your real timezone.", "color:#5BA9A3;font-weight:bold");
};
Object.defineProperty(window.iced26, "tz", {
  configurable: true,
  get: function () { return userTimezone(); }
});