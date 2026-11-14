# JOLO brand

![JOLO logo](logo.svg)

**The idea:** a coffee cup whose steam is a chat bubble. JOLO is the café you can text.

| File | Use |
|---|---|
| [`logo.svg`](logo.svg) | Mark plus wordmark, for slides, the README and the web |
| [`logo-mark.svg`](logo-mark.svg) | The mark alone (rounded square), for avatars and small sizes |
| [`../../jolo-app/assets/icon.svg`](../../jolo-app/assets/icon.svg) | Full-bleed square app icon; the PNGs in `jolo-app/assets/` are rendered from it |

Leave clear space of at least ¼ of the mark's height on every side. Don't recolour the mark: on dark backgrounds, use it as-is, since it already has its own espresso background.

## Colours: "Aroma & Crema"

These are the same tokens as the JOLO app ([`jolo-app/constants/Colors.js`](../../jolo-app/constants/Colors.js)), so the app, the logo and the slides all match.

| Token | Hex | Use |
|---|---|---|
| `primary` (Espresso) | `#2c1b17` | Logo background, headers, primary buttons |
| `secondary` (Caramel) | `#7a582f` | Accents, active tabs, links |
| `secondaryContainer` (Crema) | `#fecf9c` | The chat bubble, highlight chips, "new item" badges |
| `background` | `#fcf9f8` | Screen background, the cup |
| `surfaceContainerLow` | `#f6f3f2` | Cards |
| `onSurface` | `#1c1b1b` | Body text |
| `onSurfaceVariant` | `#4f4442` | Secondary text |
| `outlineVariant` | `#d3c3c0` | Dividers |
| `error` | `#ba1a1a` | Errors, "removed" in change lists |

Contrast, computed with the WCAG formula:

| Text on background | Ratio |
|---|---|
| Espresso on Background | 15.7:1 |
| Caramel on Background | 6.1:1 |
| Error on Background | 6.2:1 |
| Espresso on Crema | 11.5:1 |

All four pass WCAG AA for body text (4.5:1). Never put text on Crema in anything lighter than Espresso.

## Type

| Role | Font | Token |
|---|---|---|
| Headlines, wordmark | Montserrat 600/700 (900 for the wordmark) | `Typography.headline*` |
| Body, labels | Plus Jakarta Sans 400/500/600 | `Typography.body*`, `label*` |

Both fonts are free (Google Fonts) and loaded in the app through `@expo-google-fonts`.

## In the app

- **Prices are the hero.** They're right-aligned and use tabular figures, so a column of prices lines up.
- **Changes use colour and a symbol.** `+` new (Crema chip), `•` changed (Caramel), `–` removed (error red). The symbols match the iMessage summary, so owners see the same language in both places.
- **Never colour alone.** Every status also has a symbol or a word, for colour-blind owners.
