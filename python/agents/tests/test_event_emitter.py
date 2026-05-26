from nolag_agents.event_emitter import EventEmitter


class TestEventEmitter:
    def test_on_and_emit(self):
        emitter = EventEmitter()
        received = []
        emitter.on("test", lambda x: received.append(x))
        emitter._emit("test", "hello")
        assert received == ["hello"]

    def test_off_removes_handler(self):
        emitter = EventEmitter()
        received = []
        handler = lambda x: received.append(x)
        emitter.on("test", handler)
        emitter.off("test", handler)
        emitter._emit("test", "hello")
        assert received == []

    def test_off_without_handler_removes_all(self):
        emitter = EventEmitter()
        received = []
        emitter.on("test", lambda x: received.append(x))
        emitter.on("test", lambda x: received.append(x + "!"))
        emitter.off("test")
        emitter._emit("test", "hello")
        assert received == []

    def test_remove_all_listeners(self):
        emitter = EventEmitter()
        received = []
        emitter.on("a", lambda: received.append("a"))
        emitter.on("b", lambda: received.append("b"))
        emitter.remove_all_listeners()
        emitter._emit("a")
        emitter._emit("b")
        assert received == []

    def test_listener_count(self):
        emitter = EventEmitter()
        assert emitter.listener_count("test") == 0
        emitter.on("test", lambda: None)
        assert emitter.listener_count("test") == 1
        emitter.on("test", lambda: None)
        assert emitter.listener_count("test") == 2

    def test_duplicate_handler_not_added(self):
        emitter = EventEmitter()
        handler = lambda: None
        emitter.on("test", handler)
        emitter.on("test", handler)
        assert emitter.listener_count("test") == 1

    def test_handler_error_does_not_stop_others(self, capsys):
        emitter = EventEmitter()
        received = []

        def bad_handler(x):
            raise ValueError("oops")

        emitter.on("test", bad_handler)
        emitter.on("test", lambda x: received.append(x))
        emitter._emit("test", "hello")
        assert received == ["hello"]

    def test_multiple_args(self):
        emitter = EventEmitter()
        received = []
        emitter.on("test", lambda a, b: received.append((a, b)))
        emitter._emit("test", 1, 2)
        assert received == [(1, 2)]

    def test_chaining(self):
        emitter = EventEmitter()
        result = emitter.on("test", lambda: None).on("test2", lambda: None)
        assert result is emitter
