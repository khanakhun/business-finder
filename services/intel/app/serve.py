"""Entry point: `python -m app.serve [--reload]` (the container runs it without --reload)."""

import argparse

import uvicorn

from app.settings import get_settings


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the intel service.")
    parser.add_argument("--reload", action="store_true", help="restart on code changes (development)")
    args = parser.parse_args()
    settings = get_settings()
    uvicorn.run(
        "app.main:create_app",
        factory=True,
        host=settings.intel_host,
        port=settings.intel_port,
        workers=1 if args.reload else settings.intel_workers,
        reload=args.reload,
        log_config=None,  # app.logging owns the handlers (JSON lines)
        access_log=False,  # RequestContextMiddleware logs one line per request
        proxy_headers=False,
        server_header=False,
    )


if __name__ == "__main__":
    main()
