import asyncio
import pytest
from nolag_agents.correlation import CorrelationManager


@pytest.fixture
def manager():
    return CorrelationManager()


class TestCorrelationManager:
    @pytest.mark.asyncio
    async def test_register_and_resolve(self, manager):
        future = manager.register("abc")
        assert manager.has("abc")
        assert manager.size == 1

        manager.resolve("abc", "result")
        result = await future
        assert result == "result"
        assert not manager.has("abc")

    @pytest.mark.asyncio
    async def test_resolve_unknown_returns_false(self, manager):
        assert manager.resolve("unknown", "val") is False

    @pytest.mark.asyncio
    async def test_reject(self, manager):
        future = manager.register("abc")
        manager.reject("abc", ValueError("bad"))

        with pytest.raises(ValueError, match="bad"):
            await future

    @pytest.mark.asyncio
    async def test_reject_unknown_returns_false(self, manager):
        assert manager.reject("unknown", ValueError("x")) is False

    @pytest.mark.asyncio
    async def test_timeout(self, manager):
        future = manager.register("abc", timeout_ms=50)
        with pytest.raises(TimeoutError, match="timed out"):
            await future

    @pytest.mark.asyncio
    async def test_clear_rejects_all(self, manager):
        f1 = manager.register("a")
        f2 = manager.register("b")
        manager.clear()

        with pytest.raises(Exception, match="cancelled"):
            await f1
        with pytest.raises(Exception, match="cancelled"):
            await f2
        assert manager.size == 0

    @pytest.mark.asyncio
    async def test_resolve_before_timeout(self, manager):
        future = manager.register("abc", timeout_ms=5000)
        manager.resolve("abc", "fast")
        result = await future
        assert result == "fast"
