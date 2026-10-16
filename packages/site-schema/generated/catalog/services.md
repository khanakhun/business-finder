# Services (`services`)

What the business offers, with published prices only.

## Use it

- The services as the business names them.
- A price only when the business publishes it (a price fact).

## Avoid

- Estimated or typical prices.
- Services the facts do not mention.

## Variants

| Variant | When | Preview |
|---|---|---|
| `grid` | A grid of short items. | `thumbnails/services/grid.png` |
| `list` | A list with descriptions and prices on the right. | `thumbnails/services/list.png` |
| `cards` | Cards with an optional photo and action each. | `thumbnails/services/cards.png` |

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `heading` | text per locale | yes | Section heading, e.g. "Our services". One entry per site locale, at most 80 characters each. |
| `intro` | text per locale |  | One or two sentences introducing the section. One entry per site locale, at most 300 characters each. |
| `items` | list (1–12) of object | yes | The services, as the business lists them. |
| `items[].title` | text per locale | yes | The service as the business names it. One entry per site locale, at most 60 characters each. |
| `items[].description` | text per locale |  | What it includes, in one or two sentences. One entry per site locale, at most 240 characters each. |
| `items[].price` | object |  | A published price; `factId` must name a price fact with the same amount. |
| `items[].price.amount` | number | yes | The amount, as published (e.g. 65). |
| `items[].price.currency` | string | yes | ISO 4217, e.g. "EUR". |
| `items[].price.unit` | one of `each`, `per_person`, `per_hour`, `per_night` |  | What the price is for. |
| `items[].price.from` | boolean |  | A starting price ("from €90"). |
| `items[].price.factId` | string | yes | The price fact (required: never estimate a price). |
| `items[].imageAssetId` | string |  | The id of an asset in `assets`. |
| `items[].cta` | value |  | A button or link. Prefer `call`, `booking` or `page` over `url`. |

## Examples

- Good: Women's cut — €65 / Coupe femme — 65 €
- Bad: Women's cut — from around €50 / Coupe femme — environ 50 €
