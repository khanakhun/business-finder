"""A fetched page, parsed once: what every extractor reads."""

import re
from dataclasses import dataclass, field

from bs4 import BeautifulSoup, Tag

from app.services.site_intel.urls import absolute

_SPACE = re.compile(r"\s+")
_INVISIBLE = ("script", "style", "noscript", "template", "svg")
#: Parsing is linear but not free: a page larger than this is read up to here (and says so in a warning).
MAX_HTML_CHARS = 3_000_000


@dataclass(frozen=True, slots=True)
class Link:
    url: str
    text: str
    rel: str = ""


@dataclass(slots=True)
class Page:
    url: str
    html: str
    kind: str = "other"
    status: int | None = None
    headers: dict[str, str] = field(default_factory=dict)
    soup: BeautifulSoup = field(init=False)
    #: The document without scripts, styles and templates: what a visitor can read.
    visible: BeautifulSoup = field(init=False)
    text: str = field(init=False)
    links: list[Link] = field(init=False)
    truncated: bool = field(init=False)

    def __post_init__(self) -> None:
        self.truncated = len(self.html) > MAX_HTML_CHARS
        self.html = self.html[:MAX_HTML_CHARS]
        self.soup = BeautifulSoup(self.html, "lxml")
        self.visible = BeautifulSoup(self.html, "lxml")
        for node in self.visible(_INVISIBLE):
            node.decompose()
        self.text = _SPACE.sub(" ", self.visible.get_text(" ")).strip()
        self.links = []
        for anchor in self.soup.find_all("a", href=True):
            if isinstance(anchor, Tag) and (url := absolute(str(anchor.get("href", "")), self.url)):
                rel = anchor.get("rel")
                self.links.append(
                    Link(url, _SPACE.sub(" ", anchor.get_text(" ")).strip()[:200], " ".join(rel or []))
                )

    def meta(self, name: str) -> str | None:
        tag = self.soup.find(
            "meta", attrs={"name": re.compile(f"^{re.escape(name)}$", re.I)}
        ) or self.soup.find("meta", attrs={"property": re.compile(f"^{re.escape(name)}$", re.I)})
        if isinstance(tag, Tag) and (content := tag.get("content")):
            return str(content).strip()[:1000] or None
        return None

    @property
    def title(self) -> str | None:
        title = self.soup.title
        return _SPACE.sub(" ", title.get_text()).strip()[:500] or None if title else None

    @property
    def lang(self) -> str | None:
        html = self.soup.find("html")
        value = html.get("lang") if isinstance(html, Tag) else None
        return str(value).strip()[:35] or None if value else None

    @property
    def h1(self) -> str | None:
        h1 = self.soup.find("h1")
        return _SPACE.sub(" ", h1.get_text(" ")).strip()[:500] or None if isinstance(h1, Tag) else None

    @property
    def word_count(self) -> int:
        return len(self.text.split())

    def script_sources(self) -> list[str]:
        return [str(tag.get("src")) for tag in self.soup.find_all("script", src=True) if isinstance(tag, Tag)]

    def inline_scripts(self) -> list[str]:
        return [
            tag.get_text()
            for tag in self.soup.find_all("script")
            if isinstance(tag, Tag) and not tag.get("src") and tag.get("type") != "application/ld+json"
        ]
