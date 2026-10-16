"""URL helpers: normalisation and same-site checks against the registrable domain (public suffix list)."""

from urllib.parse import urldefrag, urljoin, urlsplit

import tldextract

# The suffix list bundled with tldextract: never fetched at run time (no network, deterministic). Private
# suffixes included: `salon.wixsite.com` and `other.wixsite.com` are two businesses, not one site.
_EXTRACT = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None, include_psl_private_domains=True)


MAX_URL = 2000  # the contract's limit on every URL it carries


def with_scheme(url: str) -> str:
    """`salon.example` → `http://salon.example` (a website field often omits the scheme; HTTPS upgrades come
    from the site's own redirect)."""
    url = url.strip()
    return url if "://" in url or url.startswith("//") else f"http://{url}"


def host_of(url: str) -> str:
    return (urlsplit(url).hostname or "").lower().rstrip(".")


def registrable_domain(host: str) -> str:
    """`www.salon.example.co.uk` → `example.co.uk`; hosts without a public suffix stay whole."""
    host = host.lower().rstrip(".")
    return _EXTRACT(host).top_domain_under_public_suffix or host


def same_site(url: str, other: str) -> bool:
    return registrable_domain(host_of(url)) == registrable_domain(host_of(other))


def absolute(href: str, base: str) -> str | None:
    """An http(s) URL for `href` relative to `base`, without fragment; None for other schemes or junk."""
    href = href.strip()
    if not href or href.startswith(("javascript:", "data:", "#")):
        return None
    try:
        joined, _ = urldefrag(urljoin(base, href))
        parts = urlsplit(joined)
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname or len(joined) > MAX_URL:
        return None
    return joined


def path_key(url: str) -> str:
    """A page's identity within a site (host + path, trailing slash ignored): never crawled twice."""
    parts = urlsplit(url)
    return f"{(parts.hostname or '').lower()}{parts.path.rstrip('/') or '/'}"


def registrable_suffix(host: str) -> str:
    """The public suffix of `host` (`co.uk`, `fr`), or "" when it has none (not a real domain)."""
    return _EXTRACT(host.lower().rstrip(".")).suffix
