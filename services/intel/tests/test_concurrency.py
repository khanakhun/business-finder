import os
from concurrent.futures.process import BrokenProcessPool

import pytest

from app.concurrency import CpuPool


def square_and_pid(value: int, *, offset: int = 0) -> tuple[int, int]:
    return value * value + offset, os.getpid()


def die() -> None:
    os._exit(1)  # simulates an OOM-killed worker


async def test_runs_cpu_bound_work_in_another_process() -> None:
    pool = CpuPool(max_workers=1)
    try:
        result, pid = await pool.run_cpu_bound(square_and_pid, 7, offset=1)
    finally:
        await pool.aclose()
    assert result == 50
    assert pid != os.getpid()


async def test_recovers_after_a_worker_dies() -> None:
    pool = CpuPool(max_workers=1)
    try:
        with pytest.raises(BrokenProcessPool):
            await pool.run_cpu_bound(die)
        result, _ = await pool.run_cpu_bound(square_and_pid, 3)
    finally:
        await pool.aclose()
    assert result == 9


async def test_close_without_use_is_a_no_op() -> None:
    pool = CpuPool()
    await pool.aclose()
    await pool.aclose()
