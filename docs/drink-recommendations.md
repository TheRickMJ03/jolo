# User-side drink recommendations

One side of JOLO. Owners already publish a live menu. This side records what a person searches and orders, turns that into the niche blog-finder queries, and returns drinks that are on a menu today.

A recommendation names a drink on a café menu JOLO already stores, with the price and the "updated today" line taken from Firestore. The scraper supplies the reason: this drink is what people with that taste are writing about right now. Scraped pages never become a price.

| | |
|---|---|
| Unit of a recommendation | A menu item |
| How often we scrape | Once per taste, shared across users |
| How long a niche scrape stays fresh | 7 days |
| Where search and scrape run | Off the phone, in a worker |

```
Events → Taste → Niche → blog-finder → Match → For you
search,   weighted  1–3 drink   sites, then   live café   an orderable
save,     facets    queries     trends        drinks      card
order
```

## What has to be true for this to matter

blog-finder already does discovery: it searches a niche, scores sites, scrapes recent posts, and reports rising phrases. JOLO already does the catalog: `cafes/{id}/menuVersions` holds drinks with prices, and `menuUpdatedAt` says how fresh they are. The new work is the join. A trending phrase with no nearby menu hit is dropped. A drink the person already ordered is dropped. What remains is something they have not had, that fits their taste, that a café is serving.

### Owner side, already built

Photo to menu. The owner app edits items, keeps version history, and reads weekly insights. Customers who text JOLO get today's items and prices. That catalog is the only list this side is allowed to recommend from.

Reads: item name, category `drink`, `available`, prices, section, tags, `menuUpdatedAt`. Writes none of them.

### User side, this work

A signed-in person with no café linked to their phone lands on For you, Saved, and Account. The owner tabs stay as they are. iMessage stays the owner update path. Recommendations live in the app, where a card can name the café, the price, and why.

Today every signed-in session opens `app/owner`, and a reply of "user" is turned away at onboarding.

### One person, end to end

Illustrative walk-through of the join. Prices below are the shape of a card, taken from the menu contract, not from a scrape.

| Step | What the system keeps | What it throws out |
|---|---|---|
| History | Searches "oat milk latte" and "something less sweet". Orders a Cortado at Barbara's. | Food items and modifiers. They are context, not the thing we recommend. |
| Taste | Espresso and oat milk, high weight. A penalty on sweet. | The cortado itself. Recommending the last order is a receipt, not a suggestion. |
| Query | Niche string: "oat milk espresso drinks". Sent through blog-finder with drink templates. | Outreach, forums, and association queries. They find sites, not orderable drinks. |
| Trends | Lavender oat latte is rising across recent posts. | Brown sugar drinks, because they fight "less sweet". Cortado, because it is already ordered. |
| Match | Barbara's current menu has Lavender Oat Latte, available, $5.75, menu updated today. | The same phrase at a café whose menu does not list it. |
| Card | "You keep coming back to oat espresso. Lavender oat lattes are showing up in recent café writing, and Barbara's has one for $5.75." | Any sentence that invents a price or a café. |

### Control the scraper has to beat

Owner insights already store `topItems`: which drinks customers ask about. That list, limited to nearby cafés with a fresh menu, is the baseline For you shows before anyone has a taste profile. Personal cards earn their place when people open, save, and mark ordered more often than they do on that popular list.

## Where it lives

Firestore stays the source of truth, same project the owner app already uses. The phone writes events. A worker writes taste and cards. Scraped HTML stays on the worker. The client reads drink names we extracted and menu fields the owner published.

| Path | Who writes | What it holds |
|---|---|---|
| `users/{uid}/events/{id}` | The signed-in user | `search`, `save`, `unsave`, `purchase`, `dismiss`, `open`. Optional `cafeId`, `itemId`, `itemName`, `text`. |
| `users/{uid}/taste/current` | Recommend job | Facets with weights, the niches chosen, `updatedAt`. Rebuilt from the last 90 days. |
| `niches/{slug}` | Recommend job | Shared cache. Query, `scrapedAt`, drink candidates with momentum. Reused for 7 days. |
| `users/{uid}/recommendations/current` | Recommend job | The cards. Each card points at `cafeId` + `itemId`. `why` is one sentence. `score` is stored. |
| `cafes/{id}/menuVersions/{n}` | Owner app and agent | Unchanged. `category`, `available`, `prices`, `item`. This side only reads the current version. |

### App routes

`app/_layout.jsx` currently sends every signed-in user to the owner tabs. Split on whether `useOwnerCafe` finds a café for that phone.

| Route | Who | Tabs |
|---|---|---|
| `app/owner` | Phone matches `ownerPhone` | Menu, History, Insights, Account |
| `app/user` | Signed in, no café linked | For you, Saved, Account |
| `app/(login)` | Signed out | Phone, then email |

### New modules

| File | Job |
|---|---|
| `jolo-app/lib/events.js` | Append one event. No Firebase in the tests. |
| `jolo-app/lib/recommendations.js` | Cold start, card copy, save state. |
| `jolo-app/app/user/` | For you, Saved, Account. |
| `recommend/profile.py` | Events to facets to niche strings. |
| `recommend/queries.py` | Drink templates for blog-finder. |
| `recommend/extract.py` | Trend phrases to drink names. |
| `recommend/match.py` | Drinks × menus × taste to cards. |
| `recommend/job.py` | Read Firestore, fill the niche cache, write cards. |

JOLO stores no orders. A purchase is the user marking "I ordered this" on a card or a menu item. Until that tap exists, taste is built from searches, saves, and menu asks. iMessage questions can be logged later by the agent as the same event shape. The app does not need that to ship the first cards.

## User data becomes the niche

blog-finder's `collect_rounds`, `analyze_site`, scraper, and `analyze_trends` stay as they are. The niche argument stops being a hobby someone typed into the Flask form. `profile.py` builds it from events, and `queries.py` replaces the discovery templates with ones that look for drinks.

### Facets, then one to three niches

| Facet | Taken from | Weight |
|---|---|---|
| Base | espresso, matcha, tea, cold brew in the item or the search | Highest when it repeats |
| Milk and extras | oat, almond, decaf, iced, and other modifiers | High on an order, lower on a search |
| Avoid | "less sweet", a dismiss, a drink they never reopen | A penalty, not a niche by itself |
| Place | Café on the event, when we have one | Used at match time, not in the web query |

Decay over 90 days. An order outweighs a search. A search outweighs a glance. The niche string is the base plus the strongest extra, for example "oat milk espresso drinks". A second niche carries the constraint, for example "unsweetened oat espresso". Cap at three so one person cannot fan out into a crawl.

### Drink templates passed to `build_queries`

| Template | Why it is here |
|---|---|
| `{niche}` | The plain name, same as today's first template. |
| `{niche} recipe` | Ingredient lists that name the drink. |
| `best {niche}` | Roundups the existing expand step already mines. |
| `{niche} café menu` | Pulls language cafés actually print. |
| `{niche} trend` | Recent writing, paired with `--since-days 30`. |
| `how to order {niche}` | The words a customer would say at the counter. |

Run with `--since-days 30`, `--min-score 4`, and a small `--scrape`. Skip outreach. Cache by the slug of the niche. If `niches/{slug}` is under seven days old, the job reuses it and only rematches menus.

### From a phrase to a drink name

`analyze_trends` returns phrases, rising terms, and an optional summary. `extract.py` keeps a phrase when it contains a drink word: latte, cortado, espresso, americano, cappuccino, mocha, matcha, chai, tea, cold brew, tonic, spritz. Rising terms rank above steady ones. The summary may add names when the model is available. The phrase list is enough when it is not.

### Proposed score

A design weight, not a measured result. Tune it once saves and order marks exist. Each part is 0 to 1.

| Part | Share | How it is computed |
|---|---|---|
| Name match | 0.30 | Overlap between the candidate phrase and the menu item name. |
| Taste overlap | 0.30 | Shared base and extras with the profile. Avoid facets subtract. |
| Trend | 0.20 | Rising phrase scores higher than a phrase that is only common. |
| Fresh menu | 0.20 | `menuUpdatedAt` within a day scores full. Older menus fall off. |

Hard drops, applied before the score: item unavailable, category is not drink, reader confidence under the app's check line when the owner has not confirmed it, the person already ordered that item, the phrase hits an avoid facet. Sort what remains. Show a handful. Every open, save, dismiss, and order mark is an event, so the next run moves.

## Ship the loop before the crawl

The first version can recommend from menus and from `topItems` with no web request at all. That gives For you a baseline and a place to record events. The scraper is the second step, once those events exist to query from. Ranking against the baseline is the third.

| Step | Done when | Depends on |
|---|---|---|
| 1. User home | A phone with no `ownerPhone` opens For you. Popular drinks from fresh nearby menus show up. Taps write events. | Owner menus already in Firestore. No scraper. |
| 2. Taste file | A handful of real searches and "I ordered this" marks produce a niche string a person can read. | Step 1 events. |
| 3. One offline scrape | Five fixed niches run through blog-finder. `extract.py` emits drink names. `match.py` attaches them to seeded menus, including Barbara's. | blog-finder as a library. The Flask UI stays a demo. |
| 4. The job | Taste picks a cached niche or runs a scrape. `recommendations/current` updates. For you renders those cards with the menu price. | Steps 2 and 3. Worker off the iMessage turn. |
| 5. The comparison | Half of sessions see the popular list, half see personal cards. Opens, saves, and order marks decide whether the scraper stays. | Step 4, and enough events to count. |

### Keep

Search, site scoring, feed scrape, and trend stats. The subprocess scraper. The rule that scraped text is untrusted. Menu item field names. Owner tabs, rules, and insights.

### Add

User routes. Event log. Taste, niche cache, and recommendation docs. Drink query templates. Phrase-to-drink extraction. The menu matcher. The "I ordered this" tap.

### Leave for the other side

Menu writes, photo reading, and the agent turn. Logging an iMessage question as an event is a later contract with the agent. It uses the same event shape. It is not required for the app to recommend.

### Boundary with the owner product

Weekly insights stay aggregates. A person's searches and orders are readable by that person. Owners keep seeing counts and top items, never a customer's taste profile. Deploying Firestore rules still touches the shared project, so user paths get added beside the owner rules rather than replacing them.
