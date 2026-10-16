# Testimonials (`testimonials`)

Real customer quotes from the fact registry.

## Use it

- Quotes as published, attributed as the policy allows (initials).

## Avoid

- Any quote that is not a testimonial fact — never write one.

## Variants

| Variant | When | Preview |
|---|---|---|
| `cards` | A card per quote with its rating. | `thumbnails/testimonials/cards.png` |
| `quotes` | Large quotes, one or two. | `thumbnails/testimonials/quotes.png` |
| `carousel` | One quote at a time. | `thumbnails/testimonials/carousel.png` |

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `heading` | text per locale |  | Section heading, e.g. "Our services". One entry per site locale, at most 80 characters each. |
| `items` | list (1–6) of object | yes | The quotes, one to six. |
| `items[].factId` | string | yes | The testimonial fact quoted. Required: never write a testimonial. |
| `items[].quote` | text per locale | yes | The quote as published (translated faithfully for other locales). One entry per site locale, at most 400 characters each. |
| `items[].author` | text (≤ 60) |  | As the attribution policy allows: initials, e.g. "Marie L.", or left out. |
| `items[].source` | one of `google`, `tripadvisor`, `facebook`, `direct` |  | Where it was published. |
| `items[].rating` | integer |  | Its star rating, as published. |

## Examples

- Good: “Warm welcome and a perfect cut.” — Claire D. / « Accueil chaleureux et coupe parfaite. » — Claire D.
- Bad: “Amazing!” — Happy customer / « Génial ! » — Un client ravi
