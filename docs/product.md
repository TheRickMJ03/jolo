# Product

## The problem

Small cafés change their menus constantly: a new seasonal drink, a price bump, a sold-out pastry. Keeping the website, Google, delivery apps and printed menus in sync is a chore that owners skip, so customers find stale prices online.

JOLO makes the update one text message: **snap a photo of the menu board and text it to JOLO.** Customers ask JOLO by text, and they always get today's menu.

## Users

| Who | What they need | Where they meet JOLO |
|---|---|---|
| **Café owner** (1–3 locations, no IT staff) | Update the menu in seconds, without logging into anything | iMessage first; the JOLO app to review, edit, and see insights |
| **Customer** | Know what's on the menu and what it costs before going | iMessage |

## User stories

Each is tagged by who builds it: **I** = Isaiah, **B** = Bhavesh, **R** = Ricardo.

### Owner
1. As an owner, I text JOLO a photo of my menu board, and it tells me what changed before saving anything. *(I, B, R)*
2. As an owner, I can say the photo is only part of my menu, so items it doesn't show aren't deleted. *(I, B)*
3. As an owner, I confirm the changes with one word ("yes"), and the menu is live right away. *(I, B)*
4. As an owner, I sign in to the JOLO app with my café's phone number. No password to remember. *(I)*
5. As an owner, I see my current menu in the app, and it updates live when I text a new photo. *(I)*
6. As an owner, I can fix a price, rename an item, add or remove an item, or mark it sold out in the app. Each save becomes a new version. *(I)*
7. As an owner, I can see past versions and what changed in each one. *(I)*
8. As an owner, I get a weekly summary of how many customers asked about my menu, and which items. *(B writes it, I show it)*

### Customer
9. As a customer, I text "What's on the menu at Barbara's?" and get the current items and prices. *(I, B)*
10. As a customer, I can tell how fresh the answer is ("updated today"). *(B)*

### Anyone new
11. As a first-time texter, JOLO asks my name and whether I'm an owner or a customer, then explains what it can do. *(I)*

## Business model (draft)

| | Free | **JOLO Plus**, ~$15/month per location |
|---|---|---|
| Menu updates by text | ✓ | ✓ |
| Customers can ask about your menu | ✓ | ✓ |
| JOLO app: menu, edits, version history | ✓ | ✓ |
| Weekly insights + LLM summary | last week only | full history, trends |
| Publish the menu to your website / Google Business Profile | – | ✓ |
| Several locations under one owner | – | ✓ |

- **Why owners pay:** each stale price is a lost sale or an awkward conversation, and insights show what customers actually ask about. $15 is below what a café spends on one printed menu run.
- **Cost to serve:** about one vision call per update (a few per month), plus cheap text answers. The models run on our own AWS GPU (see the architecture), so cost per café stays in cents.
- **Go to market:** walk in to independent cafés in Union County, NJ. The JOLO app already has ~70 cafés seeded from OpenStreetMap. Onboarding is one text.
- **Later:** the anonymised question data ("people near you ask for oat milk") as a paid report for roasters and suppliers.

## Sponsor prizes

| Sponsor | Track | Fit | Status |
|---|---|---|---|
| **Photon** | Agents in iMessage | The whole owner and customer experience is an iMessage agent, built on Photon's Spectrum SDK | **Going for it** |
| Amazon | AWS | Models served on EC2 (g6.2xlarge), GPU for the vision model that reads menus | Bhavesh / Ricardo |
| LangChain | Agent loop and tools | The agent loop | Bhavesh |
| Scale AI | Human-verified labels and evaluation | The menu reader's eval set | Ricardo |
| D. E. Shaw | Measured ranking gains, rigor | Possible fit: search reranking | **Check the prize criteria** |
| Salesforce · Capital One | Small-business owner tools | Possible fit: JOLO is a tool for small-business owners | **Check the prize criteria.** We don't have the official wording yet; read it before claiming this one. |

_Open:_ which prizes to enter is still up for agreement (see the team chat). Most hackathons cap how many sponsor tracks one team can enter, so check that too.
