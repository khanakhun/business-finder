"""A local web server for the synthetic fixture sites (tests/fixtures/sites, BF-026).

Sites are chosen by the `Host` header (`salon.test:<port>` serves `fixtures/sites/salon`). Some hosts behave
specially instead of serving files: `evil.test` redirects to the cloud metadata address (the crawler must
refuse to follow), `slow.test` never answers in time, `forbidden.test` answers 403 (a bot wall),
`moved.test` redirects to `nobots.test` (whose robots.txt disallows us), `flaky.test` is the café whose
robots.txt answers 503, and `/go-home` on any site redirects to `/`. Nothing here touches the network beyond
loopback.
"""

import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SITES = Path(__file__).parent / "fixtures" / "sites"
_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml",
    ".png": "image/png",
    ".jpg": "image/png",
    ".css": "text/css",
}


class _Handler(BaseHTTPRequestHandler):
    server_version = "fixture"
    sys_version = ""

    def log_message(self, format: str, *args: object) -> None:
        return

    def _site(self) -> str:
        return (self.headers.get("Host") or "").split(":", 1)[0].removesuffix(".test")

    def _redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _file(self, site: str) -> Path | None:
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        root = (SITES / site).resolve()
        candidates = [path.lstrip("/")]
        if path.endswith("/") or path == "":
            candidates = [f"{path.strip('/')}/index.html".lstrip("/")]
        elif "." not in path.rsplit("/", 1)[-1]:
            candidates.append(f"{path.lstrip('/')}.html")
        for candidate in candidates:
            target = (root / candidate).resolve()
            if target.is_file() and target.is_relative_to(root):
                return target
        return None

    def do_HEAD(self) -> None:
        self._serve(body=False)

    def do_GET(self) -> None:
        self._serve(body=True)

    def do_POST(self) -> None:
        self.send_response(204)
        self.end_headers()

    def _status(self, status: int, html: bytes, *, body: bool) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.end_headers()
        if body:
            self.wfile.write(html)

    def _special(self, site: str, *, body: bool) -> bool:
        """Hosts and paths that behave instead of serving a file. True when the request was answered."""
        port = (self.headers.get("Host") or "").rsplit(":", 1)[-1]
        if site == "evil":
            self._redirect("http://169.254.169.254/latest/meta-data/")
        elif site == "slow":
            time.sleep(30)
        elif site == "moved":
            self._redirect(f"http://nobots.test:{port}/")
        elif self.path == "/go-home":
            self._redirect("/")
        elif site == "flaky" and self.path == "/robots.txt":
            self._status(503, b"", body=body)
        elif site == "forbidden":
            self._status(403, b"<html><body>Access denied</body></html>", body=body)
        else:
            return False
        return True

    def _serve(self, *, body: bool) -> None:
        site = self._site()
        if self._special(site, body=body):
            return
        site = "cafe" if site == "flaky" else site
        target = self._file(site)
        if target is None:
            self._status(404, b"<html><body>Not found</body></html>", body=body)
            return
        content = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", _TYPES.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(content)))
        if site == "salon":
            self.send_header("Strict-Transport-Security", "max-age=31536000")
            self.send_header("Last-Modified", "Tue, 12 Mar 2024 10:00:00 GMT")
        if site == "cafe":
            self.send_header("X-Powered-By", "PHP/8.2.0")
        self.end_headers()
        if body:
            self.wfile.write(content)


@contextmanager
def serve_sites() -> Iterator[int]:
    """Serves the fixture sites on a free loopback port; yields the port."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
