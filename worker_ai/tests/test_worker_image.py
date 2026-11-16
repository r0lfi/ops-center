"""The AI worker image copies only selected backend modules (worker_ai/Dockerfile).

Every app.services/app.schemas module the worker imports must be among them,
or the worker crashes on start (2026-10-25: memory_suggestions was missing).
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_every_imported_backend_module_is_copied_into_the_image():
    dockerfile = (ROOT / "worker_ai/Dockerfile").read_text()
    copied_dirs = set(re.findall(r"COPY backend/app/(\w+) ", dockerfile))
    copied_files = set(re.findall(r"COPY backend/app/([\w/]+)\.py ", dockerfile))
    imported = set()
    for source in (ROOT / "worker_ai").rglob("*.py"):
        if "tests" in source.parts:
            continue
        imported |= set(re.findall(r"from app\.([\w.]+) import", source.read_text()))
    missing = sorted(module for module in imported
                     if module.split(".")[0] not in copied_dirs and module.replace(".", "/") not in copied_files)
    assert not missing, f"worker_ai imports modules its image does not copy: {missing}"
