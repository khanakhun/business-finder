# Actions

Buttons and links (`primaryCta`, `cta`, `layout.header.cta`…). Each kind carries only what it uses.

| Kind | Fields | Opens |
|---|---|---|
| `call` | `label` | the phone number in `contact.phone` |
| `email` | `label` | the address in `contact.email` |
| `whatsapp` | `label` | the number in `contact.whatsapp` |
| `booking` | `label` | the booking page in `contact.bookingUrl` (fact-backed) |
| `directions` | `label` | a map to `contact.address` or `contact.geo` |
| `page` | `label`, `pageId` | a page of the site |
| `url` | `label`, `url` | the business's own domain only (no redirect); booking pages use `booking` |

Example: `{ "kind": "booking", "label": { "fr": "Réserver", "en": "Book" } }`.
