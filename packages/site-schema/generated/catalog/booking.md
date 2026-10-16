# Booking (`booking`)

Sends visitors to the business’s existing booking page.

## Use it

- When the facts give a booking URL (known provider or own domain).

## Avoid

- Any booking link the facts do not hold.

## Variants

| Variant | When | Preview |
|---|---|---|
| `link` | A button to the booking page. | `thumbnails/booking/link.png` |
| `embed` | The booking page embedded, where the provider allows it. | `thumbnails/booking/embed.png` |

## Shape

A block is `{ "id", "type": "booking", "variant", "props" }`: `id` is 6–32 URL-safe characters, unique in the site; every
localized text has an entry for every site locale.

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `heading` | text per locale | yes | E.g. "Book your appointment". One entry per site locale, at most 80 characters each. |
| `intro` | text per locale |  | One or two sentences introducing the section. One entry per site locale, at most 300 characters each. |
| `label` | text per locale | yes | The button, e.g. "Book online". One entry per site locale, at most 30 characters each. |

## Examples

- Good: Book your appointment — Book online / Prendre rendez-vous — Réserver en ligne
- Bad: Book via this link: … / Réservez via ce lien : …

A valid block (from a fixture site):

```json
{
  "id": "book-serv1",
  "type": "booking",
  "variant": "link",
  "props": {
    "heading": {
      "fr": "Prendre rendez-vous",
      "en": "Book an appointment"
    },
    "label": {
      "fr": "Réserver en ligne",
      "en": "Book online"
    }
  }
}
```
