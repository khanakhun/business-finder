# Menu (`menu`)

A food or drinks menu from the business’s published menu.

## Use it

- Sections and dishes as the menu names them; prices as price facts.
- A note for seasonal changes.

## Avoid

- Dishes or prices not on the published menu.

## Variants

| Variant | When | Preview |
|---|---|---|
| `columns` | Sections side by side. | `thumbnails/menu/columns.png` |
| `list` | One long list, sections as headings. | `thumbnails/menu/list.png` |
| `cards` | A card per section. | `thumbnails/menu/cards.png` |

## Shape

A block is `{ "id", "type": "menu", "variant", "props" }`: `id` is 6–32 URL-safe characters, unique in the site; every
localized text has an entry for every site locale.

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `heading` | text per locale | yes | Section heading, e.g. "Our services". One entry per site locale, at most 80 characters each. |
| `intro` | text per locale |  | One or two sentences introducing the section. One entry per site locale, at most 300 characters each. |
| `sections` | list (1–10) of object | yes | The menu sections, in menu order. |
| `sections[].title` | text per locale | yes | A menu section, e.g. "Starters". One entry per site locale, at most 60 characters each. |
| `sections[].items` | list (1–30) of object | yes | The dishes of the section. |
| `sections[].items[].name` | text per locale | yes | The dish as the menu names it. One entry per site locale, at most 60 characters each. |
| `sections[].items[].description` | text per locale |  | Its ingredients or style. One entry per site locale, at most 240 characters each. |
| `sections[].items[].price` | object |  | A published price; `factId` must name a price fact with the same amount. |
| `sections[].items[].price.amount` | number | yes | The amount, as published (e.g. 65). |
| `sections[].items[].price.currency` | string | yes | ISO 4217, e.g. "EUR". |
| `sections[].items[].price.unit` | one of `each`, `per_person`, `per_hour`, `per_night` |  | What the price is for. |
| `sections[].items[].price.from` | boolean |  | A starting price ("from €90"). |
| `sections[].items[].price.factId` | string | yes | The price fact (required: never estimate a price). |
| `sections[].items[].tags` | list (0–4) of one of `vegetarian`, `vegan`, `gluten_free`, `spicy`, `house_special`, `local` |  | Dietary or house tags. |
| `note` | text per locale |  | E.g. "Menu changes with the season". One entry per site locale, at most 200 characters each. |

## Examples

- Good: Fresh juice — €7 / Jus pressé — 7 €
- Bad: Chef’s secret special — ask us! / Le plat secret du chef — demandez !

A valid block (from a fixture site):

```json
{
  "id": "menu-menu1",
  "type": "menu",
  "variant": "columns",
  "props": {
    "heading": {
      "fr": "Le matin",
      "en": "Mornings"
    },
    "sections": [
      {
        "title": {
          "fr": "Boissons",
          "en": "Drinks"
        },
        "items": [
          {
            "name": {
              "fr": "Expresso",
              "en": "Espresso"
            },
            "price": {
              "amount": 3,
              "currency": "EUR",
              "factId": "price.espresso"
            }
          },
          {
            "name": {
              "fr": "Jus pressé",
              "en": "Fresh juice"
            },
            "price": {
              "amount": 7,
              "currency": "EUR",
              "factId": "price.juice"
            },
            "tags": [
              "local"
            ]
          }
        ]
      },
      {
        "title": {
          "fr": "À manger",
          "en": "To eat"
        },
        "items": [
          {
            "name": {
              "fr": "Bol de fruits",
              "en": "Fruit bowl"
            },
            "price": {
              "amount": 12,
              "currency": "EUR",
              "factId": "price.bowl"
            },
            "tags": [
              "vegan",
              "gluten_free"
            ]
          }
        ]
      }
    ]
  }
}
```
