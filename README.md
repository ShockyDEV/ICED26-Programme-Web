<div align="center">

<img src=".github/banner.svg" alt="ICED26 - Live programme" width="100%" />

<br/>

<p>
  <a href="#"><img alt="Status" src="https://img.shields.io/badge/status-live-E89669?style=for-the-badge&labelColor=2B2724" /></a>
  <a href="#"><img alt="Stack" src="https://img.shields.io/badge/stack-HTML%20%2B%20React%2018-5BA9A3?style=for-the-badge&labelColor=2B2724" /></a>
  <a href="#"><img alt="Build" src="https://img.shields.io/badge/build-zero%20build-8A827C?style=for-the-badge&labelColor=2B2724" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-FDFBF7?style=for-the-badge&labelColor=2B2724" /></a>
</p>

<h3>The official live programme web app for the ICED26 conference.</h3>
<p><i>Salamanca · 23 – 26 June 2026 · <a href="https://iced26.es/">iced26.es</a></i></p>

</div>

---

## Highlights

- **Live awareness** — sessions running right now are highlighted with an animated coral marker; the same coral marker traces the perimeter of the building tab that currently has live action.
- **Building-first navigation** — Auditorio, Hospedería Fonseca, and the rest are top-level tabs; rooms appear as columns of a time-grid for the selected building.
- **Madrid clock everywhere** — every time displayed (and every "live" check) is computed in `Europe/Madrid`, regardless of the visitor's device timezone.
- **Two layouts in one** — desktop renders a column-per-room timetable; mobile collapses to a single chronological feed of cards.
- **Bilingual (EN / ES)** — single toggle in the header switches the entire UI, persisted in `localStorage`.
- **Full-text session search** — by title, speaker, room, or building.
- **Built-in admin panel** at `/admin` — password-gated editor for sessions, rooms, abstracts and Meet links, with a validation tab that flags presenter overlaps and other data-quality issues.
- **Personal agenda** — attendees star sessions to build a personal list; persists in `localStorage`, no account needed.
- **Online presenter awareness** — sessions where a speaker joins remotely are flagged in the grid, modal, and agenda so attendees know up front.
- **Share-ready** — Open Graph image and favicon ship in the box, themed to the brand.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Markup | Plain HTML5 | One entry file: `index.html` |
| UI runtime | React 18 (UMD) + Babel Standalone | Zero build step — JSX is compiled in the browser |
| Styling | Hand-written CSS (`styles.css`) + brand tokens | Sampled from the official ICED26 logo palette |
| Type | Fraunces (serif) + Inter (UI) via Google Fonts | — |
| Data | A single `data/programme.js` (sessions / rooms / clusters / days) | Editable by hand, via the admin panel, or via the EasyChair sync script |
| Deployment | Static file hosting | No server, no DB, no API |

> No `npm install`. No bundler. No CI. It's just files on a static host.

---

## Project structure

```
.
├── index.html                  Public entry point — open this in a browser
├── app.jsx                     Public attendee view (header, grid, mobile list, modals)
├── admin.html                  Password-gated editor entry point
├── admin-app.jsx               Admin editor (sessions, rooms, validation)
├── admin-styles.css            Admin-specific styles
├── styles.css                  All the public styling, sampled from the ICED26 logo
├── data/
│   └── programme.js            Source of truth: meta, clusters, rooms, sessions, talks
├── scripts/
│   ├── sync-programme.js       Refresh data/programme.js from EasyChair
│   └── import-abstracts.js     Older variant that only refreshes abstracts
├── favicon-32.png              Browser tab icon (small)
├── favicon-192.png             Browser tab icon (large / Android)
├── apple-touch-icon.png        iOS home-screen icon
├── og-image.png                1200×630 social preview (Twitter / WhatsApp / Slack)
└── .github/
    └── banner.svg              README banner
```

---

## Run locally

The app is static, so any local HTTP server works. Pick one:

```bash
# Python — built in, no install
python3 -m http.server 8080

# Node — quick one-liner
npx serve -l 8080 .

# PHP
php -S localhost:8080
```

Then open <http://localhost:8080/>.

> Do not open `index.html` with `file://` directly — Babel needs a real HTTP origin to fetch the `.jsx` files.

---

## Deploy

Because everything is static, deployment is trivial. Pick whichever flavour you like.

### Option 1 — GitHub Pages (free, easiest, currently used)

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source:** _Deploy from a branch_.
3. Pick `main` / `(root)` and **Save**.
4. Wait ~30 s. Your site is live at `https://<user>.github.io/<repo>/`.

For a custom domain (e.g. `programme.iced26.es`):

1. Add a `CNAME` record at your DNS provider, pointing the subdomain to `<user>.github.io`.
2. **Settings → Pages → Custom domain**, enter the domain.
3. GitHub provisions a Let's Encrypt certificate automatically.

### Option 2 — Netlify (drag & drop, custom domain in 1 click)

1. Open <https://app.netlify.com/drop>.
2. Drag the whole project folder onto the page.
3. Site is live in ~10 s with a `*.netlify.app` URL.
4. _Domain settings → Add custom domain_ → point `programme.iced26.es` here.

Or via CLI:

```bash
npm i -g netlify-cli
netlify deploy --prod --dir=.
```

### Option 3 — Vercel

```bash
npm i -g vercel
vercel --prod
```

Vercel auto-detects a static site. No config required.

### Option 4 — Cloudflare Pages

1. <https://dash.cloudflare.com/> → **Pages → Create → Connect to Git** → select this repo.
2. Build command: _(leave empty)_ · Output directory: `/` → **Save & Deploy**.

### Option 5 — Plain old web hosting (cPanel, FTP, S3, nginx…)

Just upload the contents of the repo into the public web root. That's it.

---

## Updating the programme

Three workflows, depending on what changed.

### A. Refresh from EasyChair

When the schedule is edited upstream, sync from it:

```bash
node scripts/sync-programme.js             # dry-run, prints what would change
node scripts/sync-programme.js --apply     # writes data/programme.js
```

The script matches sessions by `easychair_session_id` first, then by `(day, start, room)`, then by normalized title. Meet URLs and `onlinePresenter` flags on existing sessions are preserved across syncs. Commit the resulting `data/programme.js` to publish.

### B. Edit in the admin panel

1. Open `/admin` and log in.
2. Add / edit / remove sessions, rooms, abstracts, Meet links. Changes auto-save as a draft in `localStorage`.
3. Click **Export programme.js** — the file downloads, ready to replace `data/programme.js`. Commit and push.

### C. Edit `data/programme.js` directly

It's a plain JS object: `meta`, `clusters`, `rooms`, `sessions`. Commit the change.

---

## Customisation

| Where | What |
|---|---|
| `styles.css` `:root { … }` | Brand palette tokens (teal / coral / cream / ink, plus per-type colour tokens). Change once, propagates everywhere. |
| `app.jsx` `I18N` constant | EN / ES copy for the public site. Add a third language by extending the object. |
| `og-image.png` & `favicon-*.png` | Replace if you change the visual identity. |
| `liveStyle` prop on `<Grid>` in `index.html` | Visual style of the "live now" marker (`halo`, `underline`, `filled`). |

---

## Security model

The admin login is a SHA-256 password check performed in the browser. The hash sits in the source code, so this is a barrier against casual access, not real authentication. The site is fully static — anyone bypassing the gate can only modify their own browser state. Publishing requires a `git push`, which is gated by GitHub's authentication.

A `Content-Security-Policy` meta tag restricts script and style origins to self, unpkg, and Google Fonts. Meet URLs are run through a `safeURL()` helper before rendering, so only `http(s)://` schemes can reach `href` attributes.

---

## Privacy

The app runs entirely in the browser. No backend, no analytics, no cookies. The only persisted state is in the visitor's `localStorage`: language preference, personal agenda favorites, and admin draft/auth state. None of it leaves the browser.

External requests on page load are limited to `unpkg.com` (React, ReactDOM, Babel — loaded with SRI hashes) and `fonts.googleapis.com` / `fonts.gstatic.com` (Inter and Fraunces). Both providers see the visitor's IP, as with any site that uses the same CDNs.

---

## License

[MIT](LICENSE) — do whatever you want; attribution appreciated.

---

<div align="center">
  <sub>Made in Salamanca for <b>ICED26</b>.</sub>
</div>
