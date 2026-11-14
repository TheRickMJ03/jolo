# Trends and insights

The data scraper's two jobs, and where they show in the app.

| Side | What it suggests | Where it shows |
|---|---|---|
| Owner | Drinks to add, feature or bring back, from: their current menu, drinks gaining popularity at other shops, what people ask for nearby, and web trends | **Insights** tab, the owner's one place for analytics |
| Customer | Drinks to try, from: their previous searches, and trends in the area | **Social** tab: "Trending near you" and "Picked for you" |

## How it fits together

```
 café blogs (blog-finder)  ─┐
 Reddit (Scraper_test)      ├─▶ recommend job ─▶ Firestore ─▶ app
 TikTok (off: no key)      ─┘   (Python, off     niches/{slug}               (reads only)
 menus, versions, events ──────▶ the phone)      cafes/{id}/analytics/current
                                                 areas/union-county-nj
                                                 users/{uid}/recommendations/current
```

Scraping is slow and must never run on the phone, so `python -m recommend.job --analytics` does it and writes finished documents. The app only reads them. Analytics that need no scraper (menu counts, prices, items to check, customer asks) are computed in the app from the live menu, so they are always current, and shown on the same screen.

Scraped text never becomes a price or a café. A trend reaches a customer only when a café near them serves a drink it matches, at the menu's price.

## Owner: the Insights tab

Sections, top to bottom:

| Section | Source | Needs the scraper |
|---|---|---|
| Suggestions | All of the below, joined against the live menu | Partly |
| Your menu: items, drinks, drink price range, items to check, sold out, price changes in 30 days | Current menu and versions | No |
| Customer asks: this week vs last, most asked about, summary, past weeks | `cafes/{id}/insights/{week}` (agent backend) | No |
| Other shops: drinks other cafés added this month, or that several serve | Every café's menu versions | No |
| Asked about in {town}: drink and extra searches, drink taps at cafés in town | `users/*/events`, counts only | No |
| On the web: drink trends, rising or steady, with sources and an example post | Café blogs and Reddit | Yes |

Suggestion kinds:

- **Add**: trending or added elsewhere, not on this menu.
- **Feature**: on this menu and trending or asked about.
- **Bring back**: sold out but people still search for it.
- **Check**: items the menu reader wasn't sure of.

Each suggestion lists its evidence ("Rising on Reddit · Added at 2 other shops this month"). Suggestions are built in the app (`jolo-app/lib/owner-insights.js`), so adding the drink to the menu removes the suggestion at once.

The line under the title says when the job last ran and which sources worked: `Updated today · Café blogs · Reddit: nothing found · TikTok off`.

## Customer: the Social tab

- **Trending near you** (`areas/union-county-nj`): drinks on local menus with at least one signal. The signals are matching a web trend, being newly added at that café, or being asked about on JOLO. Each card shows the café, the menu price, and the signals. With the person's location (inside the service area), cards are grouped nearest first, walkable (1.5 mi), then 5 mi, then 15 mi, keeping the job's ranking within each group, and show the distance ("& Grain · 1.0 mi").
- **Picked for you** (`users/{uid}/recommendations/current`): from the person's own searches, the existing recommend matcher. Submitting a search in Finder records it.

The Community feed is still placeholder content.

## Firestore

| Path | Written by | Read by |
|---|---|---|
| `niches/{slug}` | Job | Nobody (worker cache) |
| `cafes/{id}/analytics/current` | Job | That café's owner |
| `areas/{areaId}` | Job | Anyone signed in |
| `users/{uid}/events/{id}` | That person | That person; the job (counts only) |

The rules are in `jolo-app/firestore.rules`, with tests.

## Sources

| Source | Status | Needs |
|---|---|---|
| Café blogs | On | Nothing; DuckDuckGo search, through `~/Scraper_test/blog-finder` (`BLOG_FINDER_PATH`) |
| Reddit | On, but **blocked from this network** at the time of writing ("You've been blocked by network security") | `~/Scraper_test` (`SCRAPER_TEST_PATH`) and a camofox-browser server on `localhost:9377` |
| TikTok | Off | `SCRAPFLY_KEY` (paid) |
| Instagram | Not built | Scraper_test has no topic search |

One source failing never stops the others; it shows in the sources line.

## Run it

From the repo root, with the emulators running:

```bash
python3 -m venv .venv
.venv/bin/pip install firebase-admin pydantic pyyaml requests beautifulsoup4 feedparser ddgs python-dotenv anthropic httpx loguru jmespath nested-lookup scrapfly-sdk
```

Demo data (local emulator only):

```bash
cd jolo-app && FIRESTORE_EMULATOR_HOST=127.0.0.1:18180 npm run seed:cafes
```

```bash
cd jolo-app && FIRESTORE_EMULATOR_HOST=127.0.0.1:18180 OWNER_CAFE_ID=owner-19085905037 npm run seed:trends-demo
```

Live scrape (blogs plus Reddit; start camofox first with `CAMOFOX_BIND_HOST=127.0.0.1 npm start` in its folder):

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:18180 .venv/bin/python -m recommend.job --analytics --scrape
```

Or with no network, from built-in sample trends (labelled "Sample data" in the app):

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:18180 .venv/bin/python -m recommend.job --analytics --demo-trends
```

A niche scraped in the last 7 days is reused, so running the job again is cheap.

## Run it on a schedule, against the real project

The job keeps itself running with `--every HOURS`. A failed run is logged and the next one still happens. It reads only the last 90 days of events and the latest 12 menu versions per café, so a run stays small as history grows.

Against the real project it needs a Firebase Admin key (Firebase console → Project settings → Service accounts), passed as `--service-account` or `JOLO_SERVICE_ACCOUNT`. Without one it uses Application Default Credentials, so on a Google Cloud server its own identity works. Never commit the key.

The container (`recommend/Dockerfile`) runs blogs plus Reddit once every 24 hours:

```bash
docker build -f recommend/Dockerfile -t jolo-trends .
```

```bash
docker run -d --restart unless-stopped --name jolo-trends -v ~/Scraper_test:/scrapers:ro -v /path/to/key.json:/secrets/key.json:ro -e JOLO_SERVICE_ACCOUNT=/secrets/key.json -e CAMOFOX_BASE_URL=http://host.docker.internal:9377 jolo-trends
```

Before the first run against the real project:

1. **Deploy the indexes and rules** from `jolo-app` (`npx firebase deploy --only firestore`). The job's event query needs the collection-group index on `events.createdAt` in `firestore.indexes.json`. The project is shared with the original JOLO app, so the rules deploy replaces its rules too (they're included).
2. **Run Reddit from a network Reddit allows**, with camofox-browser beside the job. Blogs need nothing.

## Café sign-up over iMessage

The bridge writes `cafes/owner-{digits}` when an owner gives their name, business and location (`spectrum-archive-app/src/jolo/link-cafe.ts`). It updates those fields and keeps everything else: signing up again never resets the menu pointer.

| Where | How it writes | Set |
|---|---|---|
| Local demo | The emulator's REST API | `FIRESTORE_EMULATOR_HOST` |
| Real project | Firebase Admin SDK | `JOLO_SERVICE_ACCOUNT` (key file) or Application Default Credentials; leave `FIRESTORE_EMULATOR_HOST` blank |

## Not done

These belong to other parts of the project:

- **Menus from photos** (the agent and the reader). Until then, owners add menus in the app.
- **Weekly customer-ask insights** (`insights/{week}`) are written by the agent's backend, so "Customer asks" stays empty for real cafés until it exists.
- **iMessage questions as asks.** The agent would log them as events in the same shape.

Still open on this side:

- **One area.** Everything is "Union County". A café outside it, like cafe g in Princeton, sees county-wide asks.
- **TikTok** needs a ScrapFly key.
