#!/usr/bin/env node
// scripts/sync-programme.js
// ─────────────────────────────────────────────────────────────────────────
// Full sync of data/programme.js from the EasyChair smart-program for
// ICED2026. Rebuilds the `sessions` array from EasyChair, preserving:
//   - meta (name, days, timezone, dayLabels)
//   - rooms catalog (your room IDs and Meet URLs)
//   - clusters catalog
//   - Meet URLs on individual sessions (matched back from current data)
//
// Usage:
//   node scripts/sync-programme.js              # dry-run (default), prints a diff
//   node scripts/sync-programme.js --apply      # write the changes
//
// Re-run any time Mónica updates EasyChair. The dry-run output tells you
// exactly what would change (added / updated / removed sessions) so you can
// review before applying.
// ─────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const APPLY = process.argv.includes("--apply");
const PROGRAMME_PATH = path.join(__dirname, "..", "data", "programme.js");
const EASYCHAIR_BASE = "https://easychair.org/smart-program/ICED2026";

// ── Load / save ───────────────────────────────────────────────────────────
function loadProgramme() {
  const src = fs.readFileSync(PROGRAMME_PATH, "utf8");
  const m = src.match(/window\.ICED26_DATA\s*=\s*([\s\S]*?);\s*$/);
  if (!m) throw new Error("Could not parse data/programme.js");
  return JSON.parse(m[1]);
}

function saveProgramme(data) {
  const stamp = new Date().toISOString().slice(0, 16);
  const out =
    `// ICED26 programme — synced from EasyChair on ${stamp}\n` +
    `// Times are Europe/Madrid local. Re-run scripts/sync-programme.js to refresh.\n\n` +
    `window.ICED26_DATA = ${JSON.stringify(data, null, 2)};\n`;
  fs.writeFileSync(PROGRAMME_PATH, out, "utf8");
}

// ── HTML helpers ──────────────────────────────────────────────────────────
const HTML_ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  "&apos;": "'", "&nbsp;": " ", "&rsquo;": "’", "&lsquo;": "‘",
  "&rdquo;": "”", "&ldquo;": "“", "&hellip;": "…",
  "&mdash;": "—", "&ndash;": "–", "&middot;": "·",
  "&iquest;": "¿", "&iexcl;": "¡"
};
function decode(s) {
  if (!s) return "";
  return s
    .replace(/&[a-z]+;/gi, (m) => HTML_ENTITIES[m.toLowerCase()] || m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
const stripTags = (s) => (s || "").replace(/<[^>]+>/g, "").trim();
const collapseWs = (s) => s.replace(/\s+/g, " ").trim();

// ── Type detection from session title ─────────────────────────────────────
function detectType(title) {
  const t = title.toLowerCase();
  if (/coffee break|lunch break|\bbreak\b/.test(t)) return "break";
  if (/welcome reception|reception|gala|conference dinner/.test(t)) return "social";
  if (/closing ceremony|opening ceremony|keynote|panel|plenary/.test(t)) return "keynote";
  if (/welcome and instructions/.test(t)) return "keynote";
  if (/posters?\b/.test(t)) return "poster";
  if (/workshop/.test(t)) return "workshop";
  if (/symposium/.test(t)) return "symposium";
  if (/collaborative space|collab\b/.test(t)) return "collaborative";
  if (/iced talks?/.test(t)) return "talk";
  if (/papers?\b/.test(t)) return "paper";
  if (/doctoral/.test(t)) return "doctoral";
  if (/business meeting|\bmeeting\b/.test(t)) return "meeting";
  return "other";
}

// Strip "Session NN: " or "Session 7B: " prefix to get a clean short title
function shortTitle(fullTitle) {
  return fullTitle.replace(/^Session\s+\d+[A-Z]?\s*:\s*/i, "").trim();
}

// ── Talk parsing (per <tr class="talk">) ──────────────────────────────────
function parseTalk(block) {
  const idMatch = block.match(/<a name="talk:(\d+)"/);
  const timeMatch = block.match(/<td class="time">([^<]+)<\/td>/);
  const titleMatch = block.match(/<div class="title">([\s\S]*?)<\/div>/);
  const authorsMatch = block.match(/<div class="authors">([\s\S]*?)<\/div>/);
  const presenterMatch = block.match(/<div class="presenter">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
  const abstractMatch = block.match(/<div class="abstract">([\s\S]*?)<\/div>/);

  if (!titleMatch) return null;

  const title = collapseWs(decode(stripTags(titleMatch[1])));
  const time = timeMatch ? timeMatch[1].trim() : "";
  let authors = "";
  if (authorsMatch) {
    // Authors are <a class="person">Name</a>, "and"-joined. Extract names.
    const names = [...authorsMatch[1].matchAll(/<a[^>]*class="person"[^>]*>([^<]+)<\/a>|<a[^>]*>([^<]+)<\/a>/g)]
      .map((m) => decode(m[1] || m[2]).trim())
      .filter(Boolean);
    authors = names.join(", ").replace(/, and /g, ", ").replace(/ and /g, ", ");
  }
  const presenter = presenterMatch ? decode(stripTags(presenterMatch[1])).trim() : "";

  let abstract = "";
  if (abstractMatch) {
    const paragraphs = [];
    const pRe = /<p>([\s\S]*?)<\/p>/g;
    let pm;
    while ((pm = pRe.exec(abstractMatch[1]))) {
      const text = collapseWs(decode(stripTags(pm[1])));
      if (text) paragraphs.push(text);
    }
    const raw = paragraphs.length > 0
      ? paragraphs.join("\n\n")
      : collapseWs(decode(stripTags(abstractMatch[1])));
    abstract = raw.replace(/^ABSTRACT\.\s*/i, "").trim();
  }

  const id = idMatch ? idMatch[1] : null;
  return {
    easychair_id: id || undefined,
    time,
    title,
    authors,
    presenter,
    abstract,
    keywords: ""
  };
}

// ── Session parsing — one EasyChair day page → array of sessions ──────────
function parseDay(html, day) {
  const sessions = [];

  // 1) Anchored sessions: <a name="session:NNN"> ... talks ...
  const blocks = [...html.matchAll(/<a name="session:(\d+)">([\s\S]*?)(?=<a name="session:|<\/body>|$)/g)];
  for (const m of blocks) {
    const id = m[1];
    const block = m[2];

    const intervalMatch = block.match(/<span class="interval">([^<]+)<\/span>/);
    const titleMatch = block.match(/<span class="title">([^<]+)<\/span>/);
    const descMatch = block.match(/<div class="session_desc">([\s\S]*?)<\/div>/);
    const roomMatch = block.match(/<span class="room_name">([^<]+)<\/span>/);
    if (!intervalMatch || !titleMatch) continue;

    const interval = intervalMatch[1].trim();
    const dash = interval.split(/[-–]/).map((s) => s.trim());
    const start = dash[0];
    const end = dash[1] || dash[0];
    const fullName = collapseWs(decode(titleMatch[1]));
    const description = descMatch ? collapseWs(decode(stripTags(descMatch[1]))) : "";
    const roomName = roomMatch ? collapseWs(decode(roomMatch[1])) : null;

    const talks = [];
    const talkRe = /<tr class="talk">([\s\S]*?)<\/tr>/g;
    let tm;
    while ((tm = talkRe.exec(block))) {
      const t = parseTalk(tm[1]);
      if (t) talks.push(t);
    }

    sessions.push({
      easychair_session_id: id,
      day,
      start,
      end,
      fullName,
      title: shortTitle(fullName),
      description,
      roomName,
      type: detectType(fullName),
      talks
    });
  }

  // 2) Coffee/Lunch breaks: <div class="coffeebreak|lunchbreak"> without an anchor.
  //    These sit inside a wrapping <div class="session"> too, but have no
  //    session:NNN id and no talks.
  const breakBlocks = [...html.matchAll(/<div class="(coffeebreak|lunchbreak)">([\s\S]*?)<\/div>/g)];
  for (const m of breakBlocks) {
    const kind = m[1];
    const block = m[2];
    const intervalMatch = block.match(/<span class="interval">([^<]+)<\/span>/);
    const titleMatch = block.match(/<span class="title">([^<]+)<\/span>/);
    if (!intervalMatch || !titleMatch) continue;
    const interval = intervalMatch[1].trim();
    const dash = interval.split(/[-–]/).map((s) => s.trim());
    sessions.push({
      easychair_session_id: null, // breaks have no stable EasyChair id
      day,
      start: dash[0],
      end: dash[1] || dash[0],
      fullName: collapseWs(decode(titleMatch[1])),
      title: collapseWs(decode(titleMatch[1])),
      description: "",
      roomName: null, // breaks span all rooms
      type: "break",
      talks: []
    });
  }

  return sessions;
}

// ── Room mapping: EasyChair name → our room id + cluster ──────────────────
function buildRoomLookup(data) {
  const byName = new Map();
  for (const r of data.rooms) {
    byName.set(r.name.toLowerCase().trim(), r);
  }
  return (name) => {
    if (!name) return null;
    return byName.get(name.toLowerCase().trim()) || null;
  };
}

// ── Match existing session for Meet preservation ──────────────────────────
// Returns the INDEX into oldSessions of the best match, or -1.
// Skips already-claimed indices so each old session can only be consumed once.
function findExistingSessionIdx(oldSessions, ec, claimed) {
  const norm = (t) => (t || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  const fresh = (i) => !claimed.has(i);
  // 1) Match by easychair_session_id (most reliable on re-runs)
  if (ec.easychair_session_id) {
    const i = oldSessions.findIndex((s, i) => fresh(i) && s.easychair_session_id === ec.easychair_session_id);
    if (i >= 0) return i;
  }
  // 2) Match by (day, start, room)
  if (ec.roomId) {
    const i = oldSessions.findIndex(
      (s, i) => fresh(i) && s.day === ec.day && s.start === ec.start && s.room === ec.roomId
    );
    if (i >= 0) return i;
  }
  // 3) Match by (day, start, normalized title)
  const i = oldSessions.findIndex(
    (s, i) => fresh(i) && s.day === ec.day && s.start === ec.start && norm(s.title) === norm(ec.title)
  );
  return i;
}

// ── Fetch helper ──────────────────────────────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ICED26-sync/1.0)" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const data = loadProgramme();
  const days = data.meta.days;
  const lookupRoom = buildRoomLookup(data);

  console.log(`Loaded programme: ${data.sessions.length} sessions, ${data.rooms.length} rooms, ${days.length} days.`);
  console.log(`Mode: ${APPLY ? "APPLY (will write)" : "DRY-RUN (use --apply to write)"}\n`);

  // Fetch + parse all days
  const fetched = [];
  for (const day of days) {
    const url = `${EASYCHAIR_BASE}/${day}.html`;
    process.stdout.write(`Fetching ${day} ... `);
    const html = await fetchPage(url);
    const sessions = parseDay(html, day);
    console.log(`${sessions.length} sessions, ${sessions.reduce((n, s) => n + s.talks.length, 0)} talks`);
    fetched.push(...sessions);
  }
  console.log(`Total scraped: ${fetched.length} sessions, ${fetched.reduce((n, s) => n + s.talks.length, 0)} talks.\n`);

  // Auto-add unknown room names to the catalog before resolving.
  // Heuristic for cluster: colegio for historic spaces, iddi for "ROOM 1X.X",
  // hospederia as fallback. The user can re-assign in the admin if wrong.
  const knownRoomNames = new Set(data.rooms.map((r) => r.name.toLowerCase().trim()));
  const ecRoomNames = new Set();
  for (const ec of fetched) {
    if (ec.type === "break" || ec.type === "social") continue;
    if (ec.roomName) ecRoomNames.add(ec.roomName);
  }
  const trulyUnknown = [...ecRoomNames].filter((n) => !knownRoomNames.has(n.toLowerCase().trim()));
  if (trulyUnknown.length > 0) {
    console.log(`Adding ${trulyUnknown.length} new room(s) to the catalog:`);
    for (const name of trulyUnknown) {
      const id = name.toLowerCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-+|-+$)/g, "");
      const code = name.replace(/^ROOM\s+/i, "").trim().split(/\s+/).slice(0, 2).join(" ").toUpperCase().slice(0, 6);
      let cluster = "hospederia"; // default
      if (/sal[óo]n|capilla|claustro|pinturas|biblioteca|colegio/i.test(name)) cluster = "colegio";
      else if (/^room\s+1[12]\.|^room\s+12\.|seminario|presentaciones|i\+d\+i/i.test(name)) cluster = "iddi";
      data.rooms.push({ id, name, cluster, code, meet: "" });
      console.log(`  + ${name}  →  id="${id}", cluster=${cluster}, code="${code}"  (verify in admin)`);
    }
    console.log("");
  }

  // Rebuild lookup after auto-adding
  const lookupRoomFinal = buildRoomLookup(data);

  // Resolve rooms + flag unknowns (should be none now, but defensive)
  const unknownRooms = new Set();
  const skippedNoRoom = [];
  for (const ec of fetched) {
    if (ec.type === "break" || ec.type === "social") {
      // Breaks and social events span all rooms
      ec.roomId = "*";
      ec.cluster = "";
      ec.roomCode = "";
      ec.resolvedRoomName = "";
      continue;
    }
    if (!ec.roomName) {
      ec.roomId = "";
      ec.cluster = "";
      ec.roomCode = "";
      skippedNoRoom.push(`[${ec.day} ${ec.start}] ${ec.title}`);
      continue;
    }
    const r = lookupRoomFinal(ec.roomName);
    if (!r) {
      unknownRooms.add(ec.roomName);
      ec.roomId = "";
      ec.cluster = "";
      ec.roomCode = "";
      continue;
    }
    ec.roomId = r.id;
    ec.cluster = r.cluster;
    ec.roomCode = r.code;
    ec.resolvedRoomName = r.name;
  }

  if (unknownRooms.size > 0) {
    console.log(`⚠ Unknown rooms (not in rooms catalog): ${[...unknownRooms].join(", ")}`);
    console.log(`  Add these to data/programme.js rooms[] via the admin before they show up correctly.\n`);
  }

  // Diff against existing
  const oldSessions = data.sessions;
  const claimedOldIdx = new Set();
  // For new sessions without an old match, fall back to the room's permanent Meet.
  const roomMeetById = new Map(data.rooms.map((r) => [r.id, r.meet || ""]));

  let added = 0,
    updated = 0,
    unchanged = 0,
    meetPreserved = 0,
    meetInheritedFromRoom = 0;
  const newSessions = [];

  for (const ec of fetched) {
    const oldIdx = findExistingSessionIdx(oldSessions, ec, claimedOldIdx);
    const existing = oldIdx >= 0 ? oldSessions[oldIdx] : null;
    if (oldIdx >= 0) claimedOldIdx.add(oldIdx);

    // Resolve Meet URL with cascade:
    //   1) keep existing session's meet (if matched)
    //   2) fall back to the room's permanent Meet (if assigned)
    //   3) empty
    let meetURL = existing?.meet || "";
    if (!meetURL && ec.roomId && ec.roomId !== "*") {
      meetURL = roomMeetById.get(ec.roomId) || "";
      if (meetURL) meetInheritedFromRoom++;
    }

    // Build the new session object in our schema
    const next = {
      day: ec.day,
      start: ec.start,
      end: ec.end,
      room: ec.roomId,
      roomName: ec.resolvedRoomName || (ec.roomId === "*" ? "" : ec.roomName || ""),
      roomCode: ec.roomCode || "",
      cluster: ec.cluster,
      title: ec.title,
      fullName: ec.fullName,
      type: ec.type,
      meet: meetURL,
      talks: ec.talks,
      easychair_session_id: ec.easychair_session_id
    };
    if (ec.description) next.description = ec.description;
    // Preserve admin-set flags that EasyChair doesn't know about
    if (existing?.onlinePresenter) next.onlinePresenter = true;

    if (existing && existing.meet) meetPreserved++;

    if (!existing) {
      added++;
    } else {
      // Compare canonical fields to detect changes
      const same =
        existing.title === next.title &&
        existing.start === next.start &&
        existing.end === next.end &&
        existing.room === next.room &&
        existing.type === next.type &&
        JSON.stringify(existing.talks || []) === JSON.stringify(next.talks);
      if (same) unchanged++;
      else updated++;
    }

    newSessions.push(next);
  }

  // Sessions that existed but no longer match anything in EasyChair
  const removed = oldSessions.filter((_, i) => !claimedOldIdx.has(i));

  // Sort sessions by (day, start, room) for clean diffs
  newSessions.sort((a, b) => {
    if (a.day !== b.day) return a.day.localeCompare(b.day);
    if (a.start !== b.start) return a.start.localeCompare(b.start);
    return (a.room || "").localeCompare(b.room || "");
  });

  // Report
  console.log("─────────────────────────────────────────────────");
  console.log(` SYNC SUMMARY`);
  console.log("─────────────────────────────────────────────────");
  console.log(` ${newSessions.length} sessions total after sync (was ${oldSessions.length})`);
  console.log(`   + ${added} new sessions added`);
  console.log(`   ~ ${updated} sessions updated (title / time / talks / room changes)`);
  console.log(`   = ${unchanged} sessions unchanged`);
  console.log(`   - ${removed.length} sessions in current data not in EasyChair`);
  console.log(`   ★ ${meetPreserved} Meet URLs preserved from matched sessions`);
  if (meetInheritedFromRoom > 0) {
    console.log(`   ★ ${meetInheritedFromRoom} new sessions inherited the Meet from their room's catalog`);
  }

  if (skippedNoRoom.length > 0) {
    console.log(`\n⚠ ${skippedNoRoom.length} session(s) on EasyChair without a room — kept but room field blank:`);
    skippedNoRoom.slice(0, 10).forEach((s) => console.log(`  - ${s}`));
    if (skippedNoRoom.length > 10) console.log(`  ... ${skippedNoRoom.length - 10} more`);
  }

  if (removed.length > 0) {
    console.log(`\n⚠ Sessions in current programme.js NOT found in EasyChair (will be removed if applied):`);
    removed.slice(0, 20).forEach((s) =>
      console.log(`  - [${s.day} ${s.start}] ${s.title}${s.meet ? "  (has Meet!)" : ""}`)
    );
    if (removed.length > 20) console.log(`  ... ${removed.length - 20} more`);
    const orphanedMeets = removed.filter((s) => s.meet);
    if (orphanedMeets.length > 0) {
      console.log(`\n  ⚠ ${orphanedMeets.length} of those had a Meet URL set. If those rooms still exist,`);
      console.log(`    consider whether the URLs should be reused on the new sessions.`);
    }
  }

  // Write or stop
  if (!APPLY) {
    console.log("\nDry-run complete. Nothing was written.");
    console.log("Re-run with --apply to update data/programme.js.");
    return;
  }

  data.sessions = newSessions;
  saveProgramme(data);
  console.log(`\n✓ Written ${PROGRAMME_PATH}`);
  console.log(`  ${newSessions.length} sessions, ${newSessions.reduce((n, s) => n + s.talks.length, 0)} talks.`);
}

main().catch((e) => {
  console.error("\nERROR:", e.message);
  console.error(e.stack);
  process.exit(1);
});
