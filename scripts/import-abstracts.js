#!/usr/bin/env node
// scripts/import-abstracts.js
// ─────────────────────────────────────────────────────────────────────────
// Scrapes the EasyChair smart-program day pages for ICED26 and merges the
// abstracts (plus an `easychair_id` reference) into data/programme.js by
// matching talks by normalized title.
//
// Usage:
//   node scripts/import-abstracts.js
//
// Output:
//   - data/programme.js gets `talk.abstract` and `talk.easychair_id`
//     populated wherever a match is found
//   - stdout reports matched / unmatched counts and lists mismatches
//
// Idempotent: re-running picks up new abstracts and updates existing ones.
// Run again after Mónica edits anything on EasyChair.
// ─────────────────────────────────────────────────────────────────────────

const fs = require("fs");
const path = require("path");

const PROGRAMME_PATH = path.join(__dirname, "..", "data", "programme.js");
const EASYCHAIR_BASE = "https://easychair.org/smart-program/ICED2026";

// ── Load / save programme ─────────────────────────────────────────────────
function loadProgramme() {
  const src = fs.readFileSync(PROGRAMME_PATH, "utf8");
  const m = src.match(/window\.ICED26_DATA\s*=\s*([\s\S]*?);\s*$/);
  if (!m) throw new Error("Could not parse data/programme.js");
  return JSON.parse(m[1]);
}

function saveProgramme(data) {
  const stamp = new Date().toISOString().slice(0, 16);
  const out =
    `// ICED26 programme — abstracts imported from EasyChair on ${stamp}\n` +
    `// Times are Europe/Madrid local. Re-run scripts/import-abstracts.js to refresh.\n\n` +
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

function stripTags(s) {
  return (s || "").replace(/<[^>]+>/g, "").trim();
}

function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

// ── Title normalization for matching ──────────────────────────────────────
function normalizeTitle(t) {
  return (t || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Parse a day page → array of { id, title, abstract, day } ──────────────
function parseDay(html, day) {
  const talks = [];
  const trRe = /<tr class="talk">([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html))) {
    const block = m[1];
    const idMatch = block.match(/<a name="talk:(\d+)"/);
    const titleMatch = block.match(/<div class="title">([\s\S]*?)<\/div>/);
    const abstractMatch = block.match(/<div class="abstract">([\s\S]*?)<\/div>/);
    if (!titleMatch) continue;

    const id = idMatch ? idMatch[1] : null;
    const title = collapseWhitespace(decode(stripTags(titleMatch[1])));

    let abstract = "";
    if (abstractMatch) {
      const pRe = /<p>([\s\S]*?)<\/p>/g;
      const paragraphs = [];
      let pm;
      while ((pm = pRe.exec(abstractMatch[1]))) {
        const text = collapseWhitespace(decode(stripTags(pm[1])));
        if (text) paragraphs.push(text);
      }
      // If no <p> tags, fall back to the raw abstract content
      const raw = paragraphs.length > 0
        ? paragraphs.join("\n\n")
        : collapseWhitespace(decode(stripTags(abstractMatch[1])));
      abstract = raw.replace(/^ABSTRACT\.\s*/i, "").trim();
    }

    talks.push({ id, title, abstract, day });
  }
  return talks;
}

// ── Fetch ─────────────────────────────────────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ICED26-import/1.0)" }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const data = loadProgramme();
  const days = data.meta.days;
  const totalTalks = data.sessions.reduce((n, s) => n + (s.talks || []).length, 0);

  console.log(`Programme loaded: ${data.sessions.length} sessions, ${totalTalks} talks across ${days.length} days.\n`);

  // Fetch + parse each day
  const externalByDay = {};
  const allExternal = [];
  for (const day of days) {
    const url = `${EASYCHAIR_BASE}/${day}.html`;
    process.stdout.write(`Fetching ${day} ... `);
    const html = await fetchPage(url);
    const talks = parseDay(html, day);
    console.log(`${talks.length} talks · ${talks.filter(t => t.abstract).length} with abstract`);
    externalByDay[day] = talks;
    allExternal.push(...talks);
  }

  console.log(`\nTotal EasyChair talks scraped: ${allExternal.length} (${allExternal.filter(t => t.abstract).length} with abstract).`);

  // Index external talks
  // Primary: (day + normalized title) → talk
  // Fallback: easychair_id → talk
  // Fallback: normalized title across all days → talk
  const byDayTitle = new Map();
  const byId = new Map();
  const byTitleAny = new Map();
  for (const t of allExternal) {
    if (t.id) byId.set(t.id, t);
    const norm = normalizeTitle(t.title);
    if (norm) {
      byDayTitle.set(`${t.day}::${norm}`, t);
      byTitleAny.set(norm, t);
    }
  }

  // Merge
  let matched = 0;
  let updated = 0;
  let preserved = 0;
  const unmatched = [];
  const matchedIds = new Set();

  for (const session of data.sessions) {
    if (!Array.isArray(session.talks)) continue;
    for (const talk of session.talks) {
      const norm = normalizeTitle(talk.title);
      const dayKey = `${session.day}::${norm}`;
      const ext =
        byDayTitle.get(dayKey) ||
        (talk.easychair_id ? byId.get(talk.easychair_id) : null) ||
        byTitleAny.get(norm);

      if (ext) {
        matched++;
        if (ext.id) {
          talk.easychair_id = ext.id;
          matchedIds.add(ext.id);
        }
        if (ext.abstract) {
          if (talk.abstract !== ext.abstract) {
            talk.abstract = ext.abstract;
            updated++;
          }
        } else if (talk.abstract) {
          preserved++; // external had no abstract; keep ours
        }
      } else if (talk.title) {
        unmatched.push({
          session: session.title,
          day: session.day,
          talk: talk.title
        });
      }
    }
  }

  // Find external talks that didn't match anything
  const unmatchedExternal = allExternal.filter((t) => t.id && !matchedIds.has(t.id));

  // ── Report ─────────────────────────────────────────────────────────────
  console.log("\n─────────────────────────────────────────────────");
  console.log(` MERGE SUMMARY`);
  console.log("─────────────────────────────────────────────────");
  console.log(` ✓ ${matched} talks matched`);
  console.log(`   - ${updated} abstract(s) added or updated`);
  if (preserved > 0) console.log(`   - ${preserved} existing abstract(s) preserved (EasyChair had none)`);

  if (unmatched.length > 0) {
    console.log(`\n ⚠ ${unmatched.length} talk(s) in programme.js had no match on EasyChair:`);
    unmatched.slice(0, 30).forEach((u) =>
      console.log(`   - [${u.day}] "${u.talk}"  ←  in "${u.session}"`)
    );
    if (unmatched.length > 30) console.log(`   … and ${unmatched.length - 30} more`);
  }

  if (unmatchedExternal.length > 0) {
    console.log(`\n ⚠ ${unmatchedExternal.length} talk(s) on EasyChair didn't match anything in programme.js:`);
    unmatchedExternal.slice(0, 30).forEach((t) =>
      console.log(`   - [${t.day}] talk:${t.id} "${t.title}"`)
    );
    if (unmatchedExternal.length > 30) console.log(`   … and ${unmatchedExternal.length - 30} more`);
  }

  saveProgramme(data);
  console.log(`\nWritten to ${PROGRAMME_PATH}`);
}

main().catch((e) => {
  console.error("\nERROR:", e.message);
  console.error(e.stack);
  process.exit(1);
});
