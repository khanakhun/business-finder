# Social links (`social_links`)

Links to the business’s own social profiles.

## Use it

- When the contact facts list profiles.

## Avoid

- Profiles of other businesses or people.

## Variants

| Variant | When | Preview |
|---|---|---|
| `icons` | Network icons. | `thumbnails/social_links/icons.png` |
| `buttons` | Labelled buttons. | `thumbnails/social_links/buttons.png` |

## Shape

A block is `{ "id", "type": "social_links", "variant", "props" }`: `id` is 6–32 URL-safe characters, unique in the site; every
localized text has an entry for every site locale.

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `heading` | text per locale |  | E.g. "Follow us". One entry per site locale, at most 80 characters each. |

## Examples

- Good: Follow us / Suivez-nous
- Bad: Follow our partners / Suivez nos partenaires

A valid block (from a fixture site):

```json
{
  "id": "soci-cont1",
  "type": "social_links",
  "variant": "icons",
  "props": {
    "heading": {
      "fr": "Suivez-nous",
      "en": "Follow us"
    }
  }
}
```
