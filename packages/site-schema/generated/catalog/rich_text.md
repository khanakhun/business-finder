# Rich text (`rich_text`)

Longer text such as legal notices, in a small markdown subset.

## Use it

- Paragraphs, **bold**, *italic*, "- " lists, links to the site’s own pages as [label](page:<id>).

## Avoid

- HTML, images or links to other sites.

## Variants

| Variant | When | Preview |
|---|---|---|
| `narrow` | A reading column. | `thumbnails/rich_text/narrow.png` |
| `wide` | The full content width. | `thumbnails/rich_text/wide.png` |

## Props

| Prop | Type | Required | What to write |
|---|---|---|---|
| `heading` | text per locale |  | Section heading, e.g. "Our services". One entry per site locale, at most 80 characters each. |
| `body` | text per locale | yes | Limited markdown: paragraphs, **bold**, *italic*, "- " lists and links to the site's own pages as [label](page:<pageId>). No HTML, no other links. One entry per site locale, at most 5000 characters each. |

## Examples

- Good: See the [home](page:home) page. / Voir la page d’[accueil](page:home).
- Bad: See <a href="https://…">here</a> / Voir <a href="https://…">ici</a>
