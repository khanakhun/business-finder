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

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `title` | text per locale | yes | An invitation, e.g. "Ready for your next cut?". One entry per site locale, at most 80 characters each. |
| `text` | text per locale |  | One supporting sentence. One entry per site locale, at most 300 characters each. |
| `cta` | value | yes | A button or link. Prefer `call`, `booking` or `page` over `url`. |
| `imageAssetId` | string |  | Background photo for the `image` variant. |

## Examples

- Good: Ready for a new look? — Book now / Envie d’un nouveau style ? — Réserver
- Bad: Click here / Cliquez ici
