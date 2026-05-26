import uuid
import time


def generate_id() -> str:
    return str(uuid.uuid4())


def create_timestamp() -> int:
    return int(time.time() * 1000)


def create_logger(prefix: str, enabled: bool):
    if not enabled:
        return lambda *args: None
    def _log(*args):
        print(f"[{prefix}]", *args)
    return _log
