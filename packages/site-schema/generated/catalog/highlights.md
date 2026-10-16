# Highlights (`highlights`)

Three or four strengths at a glance, each backed by a fact.

## Use it

- Concrete, checkable strengths (open 7 days, on the harbour, online booking).

## Avoid

- Invented superlatives or numbers.
- More than six items.

## Variants

| Variant | When | Preview |
|---|---|---|
| `icons` | An icon and a short title per item. | `thumbnails/highlights/icons.png` |
| `cards` | Items as cards with a sentence each. | `thumbnails/highlights/cards.png` |
| `inline` | A single line of short items, for compact pages. | `thumbnails/highlights/inline.png` |

## Shape

A block is `{ "id", "type": "highlights", "variant", "props" }`: `id` is 6–32 URL-safe characters, unique in the site; every
localized text has an entry for every site locale.

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `heading` | text per locale |  | Section heading, e.g. "Our services". One entry per site locale, at most 80 characters each. |
| `items` | list (2–6) of object | yes | The strengths, two to six. |
| `items[].icon` | one of `star`, `leaf`, `clock`, `map_pin`, `phone`, `sparkles`, `heart`, `shield`, `sun`, `waves`, `utensils`, `coffee`, `scissors`, `wrench`, `hammer`, `home`, `key`, `calendar`, `award`, `users`, `wifi`, `car`, `truck`, `gift` | yes | An icon for the strength. |
| `items[].title` | text per locale | yes | A short strength, e.g. "Open 7 days". One entry per site locale, at most 60 characters each. |
| `items[].text` | text per locale |  | One sentence backing it. One entry per site locale, at most 240 characters each. |
| `items[].factIds` | list (0–5) of string |  | The facts this highlight states. |

## Examples

- Good: Open 7 days / Ouvert 7 jours sur 7
- Bad: Best salon on the island / Le meilleur salon de l’île

A valid block (from a fixture site):

```json
{
  "id": "high-home1",
  "type": "highlights",
  "variant": "icons",
  "props": {
    "items": [
      {
        "icon": "scissors",
        "title": {
          "fr": "Coupe et couleur",
          "en": "Cut and colour"
        },
        "factIds": [
          "service.cut_women"
        ]
      },
      {
        "icon": "calendar",
        "title": {
          "fr": "Réservation en ligne",
          "en": "Online booking"
        },
        "factIds": [
          "booking.url"
        ]
      },
      {
        "icon": "map_pin",
        "title": {
          "fr": "Sur le port de Gustavia",
          "en": "On Gustavia harbour"
        },
        "factIds": [
          "address.main"
        ]
      }
    ]
  }
}
```
