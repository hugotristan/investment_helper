# Investment Helper backend

The frontend is plain HTML, CSS and JavaScript. A Cloudflare Worker serves it through OpenAI Sites and fetches public stock histories and currency rates. Cloudflare D1 stores the private portfolio ledger and watchlist. GitHub stores the source code; a Site deployment keeps running independently of your computer.

## Access and storage

The Site is owner-private. Sites handles ChatGPT sign-in and supplies the trusted `oai-authenticated-user-id` header. The app uses this stable identity as the primary key for separate portfolio and watchlist records. It does not create an additional password or OAuth system. A top-level sign-out link uses Sites' sign-out route.

Every storage read and write is authorized server-side. D1 statements bind the authenticated identity and supplied values rather than interpolating them. Personal API responses are `private, no-store`. Mutations require JSON, the same origin, an expected native account identity and an expected record revision. Requests are streamed within a 1 MiB limit.

A save uses one conditional SQL statement: create only if the record is absent, or update only if its revision matches. When another phone or tab already saved, the stale writer receives a conflict and must reload. A timed-out save can have reached the server, so the app requires a read before retrying rather than assuming nothing changed. Changed or expired sign-in blocks private controls and hides the previous account's data.

Portfolio books retain the existing settings, opening holdings, transactions and original source text. Cloud validation uses the same ledger model as browser storage. The cloud book is limited to 1 MiB and the watchlist to 90 unique symbols. Research-pick journals, scan results and view preferences remain browser-local in this first backend version.

## Moving the existing portfolio

1. Open the GitHub Pages app in the browser containing your transactions.
2. Under **Portfolio → Backup and restore**, choose **Export backup**.
3. Open the private Sites app and sign in with the owner account.
4. Choose that backup in **Backup and restore**, review the preview, then restore it.
5. Open the same Sites address on your phone and sign in. It loads the saved cloud ledger.

An existing cloud book is never replaced by an automatic browser upload. An explicit upload button is available only when the current Site origin has an old IndexedDB book and the cloud portfolio is empty. Since GitHub Pages and Sites have different origins, the backup route is normally needed. The original local book is retained. Transfer a custom watchlist separately by copying its symbols into **Watchlist → Edit as text**.

Confirmed cloud books also keep an owner-scoped IndexedDB recovery copy. Cloud requests never silently switch to local writes during an outage. Exported JSON backups remain available for recovery. Reload cloud data refreshes both records; the app checks for changes when returning to the page without resetting an open editor.

## Market data

The hosted frontend sends only a ticker to `GET /api/market/history`. The Worker requests a fixed Yahoo Finance chart URL and validates its identity, currency, dated daily prices and splits. Public results are cached briefly and concurrent requests for the same ticker share one request. Yahoo failures can use the latest real GitHub-published snapshot for covered symbols. Missing history stays unavailable. Market data never invents prices or changes the observation date during a retry.

`GET /api/exchange-rate` loads the dated ECB USD-to-EUR reference rate through Frankfurter. `GET /api/portfolio-fx` supplies five years of historical reference rates for the existing supported currencies. These references value holdings; manually recorded EUR settlements remain authoritative. News research, financial snapshots and ticker suggestions keep their existing sources. The backend does not place trades.

## Schema and deployment

`.openai/hosting.json` links the source to its Site and declares the logical D1 binding `DB`. Sites provisions storage and applies the generated schema-only migrations before publishing. `db/schema.ts`, `drizzle.config.ts` and the append-only `drizzle/` files define those migrations. Production requests never create tables.

Run `npm install` once for development tools, `npm test` for checks, and `npm run db:generate` after schema changes. `npm run dev` starts a loopback preview with a synthetic local identity and a separate SQLite database in ignored `.sites-runtime/`. It cannot authenticate a hosted visitor. Local previews and tests apply the same SQL as D1.

`npm run build` bundles the Worker and an explicit allowlist of public browser assets into `dist/server/index.js`. Large assets use gzip to keep the Worker small. Only the Sites build enables cloud storage in the embedded HTML; the tracked frontend and GitHub Pages remain browser-local. Server files, secrets, local SQLite databases and Git metadata are not served as browser assets. Build output and runtime state are ignored by Git.

The Sites source workflow pushes the exact Git state and packages the matching build before a private deployment. GitHub Pages' existing scheduled publisher still refreshes public market snapshots; it publishes only the frontend assets prepared by `scripts/build-github.mjs`.
