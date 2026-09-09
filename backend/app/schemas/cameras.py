from pydantic import BaseModel


class CameraStatus(BaseModel):
    name: str
    ip: str
    kind: str = "tapo"  # "tapo" | "ring" - ring has no watchdog (fail/cooldown/kick fields stay empty)
    reachable: bool  # fresh, live TCP-connect to the RTSP port - not cached
    consecutive_fails: int  # from the watchdog's Redis counter (worker/scheduled_tasks.py)
    cooldown_remaining_seconds: int | None = None  # set while the watchdog won't re-kick yet
    last_kick_at: str | None = None  # ISO 8601, UTC
    last_kick_result: str | None = None  # "kicked" | "not_found" | "error"
    has_stream: bool = False  # a go2rtc live-view entry exists for this camera
