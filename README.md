# Final Bites Till

A lean, end-to-end bookkeeping + point-of-sale app for a small campus snack/fast-food
counter. Five files, no build framework, no ORM.

```
index.html   the POS UI (Sell / Buy inventory / Reports tabs)
style.css    theme
app.ts       frontend logic — search suggestions, ticket, purchase form, reports
server.ts    backend — Express + MongoDB Atlas + Google OAuth, write API + read API
README.md    this file
```

## How the data model captures "flow of value and funds"

Everything is built on **four collections**, and every write touches at most two of
them, so history is always traceable end to end:

| Collection    | What it records                                              |
|---------------|----------------------------------------------------------------|
| `ingredients` | current stock + running **weighted-average cost** per ingredient |
| `items`       | menu items, each with a **recipe**: `[{ ingredientId, qty }]`   |
| `purchases`   | every inventory buy-in: qty, unit cost, supplier, timestamp     |
| `sales`       | every sale: item, qty, price, **cost** (derived from recipe), profit, timestamp |
| `ledger`      | one row per purchase or sale — the unified cash + stock-value trail |

**Purchase → inventory → sale, traced automatically:**

1. **Buy inventory** (`POST /api/write/purchase`) — stock goes up, average cost is
   recalculated, cash goes out. A `ledger` row is written: `cashDelta: -total`,
   `stockValueDelta: +total`.
2. **Sell an item** (`POST /api/write/sale`) — the item's `recipe` says exactly which
   ingredients and how much of each it consumes. Those quantities are deducted from
   `ingredients.stock` at their current average cost, giving you a real **cost of
   goods sold** per sale (not a guess). Revenue comes in. A `ledger` row is written:
   `cashDelta: +total`, `stockValueDelta: -cost`.

Because both cash movements and stock-value movements are logged on the *same* ledger
row, you can always answer "where did the money go" and "where did the stock go" from
one collection, filtered by date — no joins needed for a basic P&L.

Sum `ledger.cashDelta` over a range = net cash flow. Sum `sales.profit` over a range =
gross margin. `ingredients.stock * ingredients.avgCost` at any moment = inventory
value on the books.

## APIs

Two routers, both behind Google-OAuth-issued JWTs:

- `POST /api/write/*` — `item`, `ingredient`, `purchase`, `sale`. Anything that
  changes state goes here.
- `GET /api/read/*` — `items`, `ingredients`, `sales`, `purchases`, `ledger`,
  `summary` (today's revenue/cost/profit + low-stock list), `export` (CSV download
  of `sales` / `purchases` / `ledger` for Excel or a BI tool such as Power BI,
  Metabase, or Google Sheets' "Import CSV").

Splitting write vs. read (rather than one CRUD router) keeps the POS UI's hot path
(ringing up a sale) obviously separate from reporting, and makes it trivial to later
put the read API behind a cache or a read replica without touching the write path.

## Live deployment guide (Vercel)

This repo is set up for a free Vercel deployment that serves both the static UI and the API from the same project.

### 1. Set the production API base
The frontend now uses a safe production default:

- local development: `http://localhost:8787`
- production: the current site origin, so API calls use the same domain under `/api`

This is handled in `ui/app.ts` with a fallback chain:

```ts
const API_BASE = ((window as any).API_BASE ||
  (location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost:8787"
    : location.origin
  )).replace(/\/$/, "");
```

If you ever want to force a different production API URL, set `window.API_BASE` before the app initializes or add a build-time variable in your deployment environment.

### 2. Configure the Vercel project
1. Push this repo to GitHub.
2. Import the repo into Vercel.
3. In Project Settings → Environment Variables, add:

```env
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net
DB_NAME=final_bites
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
JWT_SECRET=replace-with-a-long-random-secret
ALLOWED_EMAILS=owner@example.com,manager@example.com
PORT=8787
```

4. Deploy the project.

### 3. Route behavior
The Vercel config in `vercel.json` is set up so:

- `/api/*` is routed to the Express API server
- `/` loads the app entry page at `ui/index.html`
- other frontend paths fall through to the static files in `ui/`

### 4. Google OAuth setup for production
In Google Cloud Console, add your live Vercel domain to the OAuth allowlist:

- Authorized JavaScript origins
- Authorized redirect URIs if your flow requires them

### 5. Post-deploy checks
After the first deploy:

```bash
curl https://your-project.vercel.app/api/read/summary
```

If the app loads and the API responds, the deployment is working. If it does not, check:

- MongoDB Atlas allowlist and connection string
- Vercel env variables
- Google OAuth authorized origins
- `ALLOWED_EMAILS` contains the signer email

### 6. Local development
```bash
npm install
npm run dev
```

This runs the Express API locally with tsx.

---

## Setup

### 1. MongoDB Atlas (free M0 tier)
1. Create a free cluster at https://www.mongodb.com/cloud/atlas.
2. Create a database user and allow-list your server's IP (or `0.0.0.0/0` for a
   quick start — tighten later).
3. Copy the connection string into `MONGODB_URI`.

### 2. Google OAuth
1. In Google Cloud Console, create an OAuth 2.0 **Web application** client ID.
2. Add your frontend origin (e.g. `http://localhost:5500`) under *Authorized
   JavaScript origins*.
3. Put the client ID in `app.ts` (`GOOGLE_CLIENT_ID`) and in the backend's
   `.env` (`GOOGLE_CLIENT_ID`).
4. Only emails listed in `ALLOWED_EMAILS` (comma-separated) can sign in — that's
   your entire access control, on purpose, for a one-counter shop.

### 3. Backend
```bash
npm init -y
npm install express cors dotenv mongodb google-auth-library jsonwebtoken
npm install -D typescript ts-node @types/express @types/node @types/cors @types/jsonwebtoken

cat > .env <<EOF
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net
DB_NAME=final_bites
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
JWT_SECRET=replace-with-a-long-random-string
ALLOWED_EMAILS=owner@finalbites.ng,manager@finalbites.ng
PORT=8787
EOF

npx ts-node server.ts
```

### 4. Frontend
```bash
npx tsc app.ts --target ES2020 --module ES2020
```
This produces `app.js`, which `index.html` already loads. Serve the three static
files (`index.html`, `style.css`, `app.js`) with any static host (Netlify, GitHub
Pages, `npx serve`, etc.) — no bundler needed. If the API is hosted on a different
origin, set `API_BASE` at the top of `app.ts` before compiling.

### 5. Seed your menu
Before the till is useful, load your ingredients and recipes once (Postman, curl,
or a tiny script) via `POST /api/write/ingredient` and `POST /api/write/item`.
Example:
```bash
curl -X POST $API/api/write/ingredient -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Burger bun","unit":"pcs","initialStock":100,"reorderLevel":20}'

curl -X POST $API/api/write/item -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Veg Burger","price":60,"category":"burgers",
       "recipe":[{"ingredientId":"<bun-id>","qty":1},{"ingredientId":"<patty-id>","qty":1}]}'
```

## Demo mode (view the UI with no backend)

`app.ts` ships with an optional, self-contained demo path so you can see the
Sell / Buy / Reports screens without standing up Atlas or a Google Cloud
project first. It's gated by one flag near the top of `app.ts`:

```ts
const DEMO_MODE_ENABLED = true;   // ALLOW: ?demo=1 works
const DEMO_MODE_ENABLED = false;  // DISALLOW: ?demo=1 is inert
```

**To allow it:** leave the flag `true`, compile (`npx tsc app.ts --target ES2020
--module ES2020 --outFile app.js`), and open `index.html?demo=1`. Sign-in is
skipped, and the Sell/Buy/Reports tabs run against an in-memory fixture
(`DEMO_ITEMS`, `DEMO_INGREDIENTS`, `demoLedger`) instead of the real API — every
`apiGet`/`apiPost` call is routed to `demoGet`/`demoPost` first, which never
touch `fetch` at all. Nothing you do in demo mode reaches Mongo or requires a
token, and nothing persists past a page refresh.

**To disallow it (do this before a real deployment):** flip `DEMO_MODE_ENABLED`
to `false` and recompile. `isDemoMode()` then always returns `false`, so
`?demo=1` has no effect regardless of who appends it to the URL, and every
visitor goes through the normal Google sign-in + allow-list check. No backend
or `.env` change is needed either way — demo mode is a frontend-only concern,
since it was built to never issue a real write in the first place.

## Using the till

- **Sell** — type in the search box (autocomplete filters as you type) or tap a
  quick-tile, adjust quantity, "Complete sale." Stock is deducted per-recipe in
  real time; the sale timestamp is server-side (`soldAt`), not client-side, so it's
  trustworthy even if a phone's clock is wrong.
- **Buy inventory** — search the ingredient, enter quantity + unit cost + optional
  supplier, "Log purchase." Average cost updates immediately.
- **Reports** — today's revenue/cost/profit, low-stock alerts, recent ledger
  activity, and one-click CSV export per collection for deeper analysis in Excel,
  Power BI, Metabase, or Google Sheets.

## Why this stays lean

- No ORM — the native MongoDB driver is enough for four collections.
- No frontend framework — vanilla TS + the DOM is enough for a three-tab POS.
- No separate auth service — Google ID token verification + a short-lived JWT is
  the whole auth system.
- No message queue / event bus — a sale and a purchase are each a single
  transaction-shaped function that touches two collections; that's the entire
  "flow of value" model.
- Reporting stays in the app only as much as a cashier needs (today's numbers,
  low stock). Anything deeper is a CSV export away from real BI tooling — this
  app is bookkeeping and POS, not a data warehouse.

## Extending later (not built in, on purpose)
- Multiple tills/registers: add a `registerId` to sales/purchases, nothing else changes.
- Refunds/voids: a `sale` with negative `qty` plus a matching stock-reversal, or a
  `voids` collection with its own ledger entries.
- Multi-day cost lag (e.g. FIFO instead of weighted-average): swap the `avgCost`
  calculation in `/api/write/purchase` and `/api/write/sale` — the schema doesn't change.
