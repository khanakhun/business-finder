# Call-to-action banner (`cta_banner`)

A band that asks for one action, near the end of a page.

## Use it

- One clear action: book, call, see the menu.

## Avoid

- Several banners on one page.
- Vague invitations.

## Variants

| Variant | When | Preview |
|---|---|---|
| `solid` | On the primary colour. | `thumbnails/cta_banner/solid.png` |
| `image` | Over a photo. | `thumbnails/cta_banner/image.png` |
| `outline` | Light, with a border. | `thumbnails/cta_banner/outline.png` |

## Shape

A block is `{ "id", "type": "cta_banner", "variant", "props" }`: `id` is 6–32 URL-safe characters, unique in the site; every
localized text has an entry for every site locale.

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `title` | text per locale | yes | An invitation, e.g. "Ready for your next cut?". One entry per site locale, at most 80 characters each. |
| `text` | text per locale |  | One supporting sentence. One entry per site locale, at most 300 characters each. |
| `cta` | action, one of `call`, `email`, `whatsapp`, `booking`, `directions`, `page`, `url` (see actions.md) | yes | A button or link. Prefer `call`, `booking` or `page` over `url`. |
| `imageAssetId` | string |  | Background photo for the `image` variant. |

## Examples

- Good: Ready for a new look? — Book now / Envie d’un nouveau style ? — Réserver
- Bad: Click here / Cliquez ici

A valid block (from a fixture site):

```json
{
  "id": "cta-home1",
  "type": "cta_banner",
  "variant": "solid",
  "props": {
    "title": {
      "fr": "Envie d’un nouveau style ?",
      "en": "Ready for a new look?"
    },
    "cta": {
      "kind": "booking",
      "label": {
        "fr": "Réserver",
        "en": "Book now"
      }
    }
  }
}
```
