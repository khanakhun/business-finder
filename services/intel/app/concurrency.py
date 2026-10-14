"""Keeps CPU-bound work (parsing, ML, geometry) off the event loop in a process pool."""

import asyncio
import functools
import multiprocessing
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

import structlog

logger: structlog.stdlib.BoundLogger = structlog.get_logger("bf-intel.cpu_pool")


class CpuPool:
    """Created lazily on first use, so the service starts fast and tests that never need it spawn nothing.

    Workers start with `forkserver`, not `fork`: by first use the process runs threads (OTel exporter, event
    loop), and forking a multithreaded process can deadlock the child. A pool broken by a crashed worker (e.g.
    OOM-killed) is discarded, so the next call gets a fresh one instead of failing until restart.
    """

    def __init__(self, max_workers: int | None = None) -> None:
        self._max_workers = max_workers
        self._executor: ProcessPoolExecutor | None = None

    async def run_cpu_bound[**P, R](self, fn: Callable[P, R], /, *args: P.args, **kwargs: P.kwargs) -> R:
        """`fn` and its arguments must be picklable (module-level functions, plain data)."""
        executor = self._executor
        if executor is None:
            executor = self._executor = ProcessPoolExecutor(
                max_workers=self._max_workers, mp_context=multiprocessing.get_context("forkserver")
            )
        try:
            return await asyncio.get_running_loop().run_in_executor(
                executor, functools.partial(fn, *args, **kwargs)
            )
        except BrokenProcessPool:
            logger.exception(
                "cpu pool broken (a worker died); it will be recreated", fn=getattr(fn, "__name__", "?")
            )
            if self._executor is executor:
                self._executor = None
                executor.shutdown(wait=False, cancel_futures=True)
            raise

    async def aclose(self) -> None:
        """Waits for running work without blocking the event loop."""
        executor, self._executor = self._executor, None
        if executor is not None:
            await asyncio.to_thread(executor.shutdown, wait=True, cancel_futures=True)
