# BusinessFinderBot

`BusinessFinderBot/1.0` is the crawler of Business Finder, a tool that helps small web agencies find local businesses
whose websites they could improve.

- **What it reads**: a business's public website — the home page and a few key pages (contact, legal notice, about,
  services, menu, booking), at most 12 pages per visit, one page at a time. Pages are rendered in a browser, so the
  images, scripts and styles they load (including from other hosts, such as a booking widget) are fetched too, as for
  any visitor.
- **What it respects**: `robots.txt` (including `Crawl-delay`, up to 5 seconds; when `robots.txt` cannot be read,
  only the home page is visited). It does not crawl other websites linked from yours, and it does not fill in or
  submit forms itself (a page's own scripts run as in any browser).
- **How often**: on demand, when someone analyses a business; identical requests within 10 minutes reuse the result.
- **Opting out**: disallow `BusinessFinderBot` in your `robots.txt`:

  ```
  User-agent: BusinessFinderBot
  Disallow: /
  ```

Statements such as "pas de démarchage" or "no solicitation" on your site are detected and honoured: businesses that
publish them are not contacted.
