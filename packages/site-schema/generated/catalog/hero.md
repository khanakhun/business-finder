# Hero (`hero`)

The first section of every page: what the business is, where, and the main action.

## Use it

- Exactly once per page, first.
- Title in the business’s own terms; the place in the eyebrow.

## Avoid

- Slogans with no information.
- A second hero further down (use a CTA banner).

## Variants

| Variant | When | Preview |
|---|---|---|
| `split` | Text beside a photo. Needs an image. | `thumbnails/hero/split.png` |
| `centered` | Centred text, no image: inner pages and businesses without good photos. | `thumbnails/hero/centered.png` |
| `image_full` | Full-width photo behind the text. Needs a strong, uncluttered image. | `thumbnails/hero/image_full.png` |
| `minimal` | A title only: legal and contact pages. | `thumbnails/hero/minimal.png` |

## Shape

A block is `{ "id", "type": "hero", "variant", "props" }`: `id` is 6–32 URL-safe characters, unique in the site; every
localized text has an entry for every site locale.

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `eyebrow` | text per locale |  | A short line above the title, e.g. the place: "Gustavia · St Barth". One entry per site locale, at most 40 characters each. |
| `title` | text per locale | yes | The page headline: what the business is, in its own terms. Up to 60 characters. One entry per site locale, at most 60 characters each. |
| `subtitle` | text per locale |  | One sentence on why customers come (40–160 characters). One entry per site locale, at most 160 characters each. |
| `primaryCta` | action, one of `call`, `email`, `whatsapp`, `booking`, `directions`, `page`, `url` (see actions.md) |  | A button or link. Prefer `call`, `booking` or `page` over `url`. |
| `secondaryCta` | action, one of `call`, `email`, `whatsapp`, `booking`, `directions`, `page`, `url` (see actions.md) |  | A button or link. Prefer `call`, `booking` or `page` over `url`. |
| `imageAssetId` | string |  | The main photo (required by the `split` and `image_full` variants). |

## Examples

- Good: Hair and care in Gustavia / Coiffure et soins à Gustavia
- Bad: Welcome to excellence! / Bienvenue dans l’excellence !

A valid block (from a fixture site):

```json
{
  "id": "hero-home1",
  "type": "hero",
  "variant": "split",
  "props": {
    "eyebrow": {
      "fr": "Gustavia · Saint-Barth",
      "en": "Gustavia · St Barth"
    },
    "title": {
      "fr": "Coiffure et soins à Gustavia",
      "en": "Hair and care in Gustavia"
    },
    "subtitle": {
      "fr": "Un salon lumineux sur le port, pour une coupe ou une couleur faite avec soin.",
      "en": "A bright salon by the harbour, for a cut or colour done with care."
    },
    "primaryCta": {
      "kind": "booking",
      "label": {
        "fr": "Réserver en ligne",
        "en": "Book online"
      }
    },
    "secondaryCta": {
      "kind": "call",
      "label": {
        "fr": "Appeler",
        "en": "Call us"
      }
    },
    "imageAssetId": "img-salon-1"
  }
}
```
