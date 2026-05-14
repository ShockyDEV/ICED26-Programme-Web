# ICED26 - Live programme

Live programme web app for the [ICED26 conference](https://iced26.es/), Salamanca, 23-26 June 2026.

Static React 18 app served from GitHub Pages. JSX is compiled in the browser by Babel Standalone, so there is no build step and no Node toolchain to maintain.

## Run locally

```bash
# Python
python3 -m http.server 8080

# Node
npx serve -l 8080 .
```

Open <http://localhost:8080/>. Do not open `index.html` via `file://` — Babel needs a real HTTP origin to fetch the `.jsx` files.

## Project structure

```
.
├── index.html                  Public entry point
├── app.jsx                     Public attendee view
├── admin.html                  Admin entry, password-gated
├── admin-app.jsx               Admin editor (sessions, rooms, validation)
├── admin-styles.css            Admin-specific styles
├── styles.css                  Public styles
├── data/
│   └── programme.js            Schedule data: meta, clusters, rooms, sessions, talks
├── scripts/
│   ├── sync-programme.js       Pull the latest schedule from EasyChair
│   └── import-abstracts.js     Older variant that only refreshes abstracts
├── favicon-32.png              Browser tab icon
├── favicon-192.png             Browser tab icon (large)
├── apple-touch-icon.png        iOS home-screen icon
├── og-image.png                Social preview (1200x630)
└── .github/banner.svg          Banner asset
```

## Updating the programme

Three workflows, depending on what changed.

**Refresh from EasyChair** — when the schedule is edited upstream:

```bash
node scripts/sync-programme.js             # dry-run, prints the diff
node scripts/sync-programme.js --apply     # write data/programme.js
```

The script matches sessions by `easychair_session_id` first, then by `(day, start, room)`, then by normalized title. Meet URLs and `onlinePresenter` flags on existing sessions are preserved across syncs.

**Edit in the admin panel** — open `/admin`, log in, edit. The panel auto-saves a draft to `localStorage` while you work. When done, click _Export programme.js_; the file downloads ready to replace `data/programme.js`. Commit and push.

**Edit `data/programme.js` directly** — it is a plain JavaScript object with `meta`, `clusters`, `rooms`, `sessions`. Commit the change.

## Deploy

Currently deployed on GitHub Pages. Any push to `main` republishes the site within ~30 seconds.

To set up from scratch on a fork:

1. Push the repo to GitHub.
2. Settings → Pages → Source: _Deploy from a branch_, Branch: `main` / `(root)`. Save.
3. Wait ~30 seconds. The site is live at `https://<user>.github.io/<repo>/`.

For a custom domain (e.g. `programme.iced26.es`):

1. Add a `CNAME` record at the DNS provider pointing the subdomain to `<user>.github.io`.
2. Settings → Pages → Custom domain, enter the domain.
3. GitHub provisions a Let's Encrypt certificate automatically.

The site is fully static and will run on any other plain HTTP host (Netlify, Vercel, Cloudflare Pages, S3, nginx) without changes.

## Tech stack

| Layer | Choice |
|---|---|
| Markup | HTML5 |
| UI runtime | React 18 UMD + Babel Standalone, compiled in browser |
| Styling | Hand-written CSS, palette sampled from the ICED26 logo |
| Fonts | Fraunces (display) + Inter (UI), Google Fonts |
| Data | Single `data/programme.js` loaded as a `<script>` |
| Hosting | GitHub Pages, or any static HTTP host |

No `npm install`, no bundler, no CI.

## Customisation

| Where | What |
|---|---|
| `styles.css` `:root { … }` | Brand palette tokens (teal, coral, cream, ink, plus type-color tokens). |
| `app.jsx` `I18N` constant | EN / ES strings for the public site. Extend the object to add languages. |
| `og-image.png`, `favicon-*.png` | Replace to change the visual identity. |
| `liveStyle` prop on `<Grid>` in `index.html` | Style of the "live now" marker: `halo`, `underline`, `filled`. |

## Security model

The admin login is a SHA-256 password check performed in the browser. The hash is in the source code, so this is a barrier against casual access, not real authentication. The site is fully static — anyone bypassing the gate can only modify their local browser state. Publishing requires a `git push`, which is gated by GitHub's authentication.

A `Content-Security-Policy` meta tag restricts script and style origins to self, unpkg, and Google Fonts. Meet URLs are run through a `safeURL()` helper before rendering so only `http(s)://` schemes can reach `href` attributes.

## Privacy

No backend, no analytics, no cookies. The app stores three things in the visitor's `localStorage`: language preference, personal agenda favorites, and admin draft/auth state. None of it leaves the browser.

External requests on page load are limited to `unpkg.com` (React, ReactDOM, Babel — loaded with SRI hashes) and `fonts.googleapis.com` / `fonts.gstatic.com` (Inter and Fraunces). Those providers see the visitor's IP, as with any site that uses the same CDNs.

## License

[MIT](LICENSE).
