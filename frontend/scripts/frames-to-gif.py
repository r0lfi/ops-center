#!/usr/bin/env python3
"""Assemble the animated Ops Floor README image from capture-readme.mjs frames.

    node scripts/capture-readme.mjs ops-floor-live
    python3 scripts/frames-to-gif.py test-results/ops-floor-live-frames ../docs/images/ops-floor.gif

Frame names are <index>-<milliseconds since the first frame>.png, so each GIF
frame lasts as long as the browser actually showed it. Needs Pillow.
"""
import sys
from pathlib import Path

from PIL import Image

WIDTH = 960
HOLD_LAST_MS = 1500


def main(frames_dir: str, output: str) -> None:
    files = sorted(Path(frames_dir).glob("*.png"))
    if len(files) < 2:
        raise SystemExit(f"need at least two frames in {frames_dir}")
    times = [int(f.stem.split("-")[1]) for f in files]
    durations = [max(20, b - a) for a, b in zip(times, times[1:])] + [HOLD_LAST_MS]
    frames = []
    for f in files:
        img = Image.open(f).convert("RGB")
        img = img.resize((WIDTH, round(img.height * WIDTH / img.width)), Image.Resampling.LANCZOS)
        frames.append(img)
    # One palette for every frame keeps colours stable between frames.
    palette = frames[len(frames) // 2].quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    quantized = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
    quantized[0].save(output, save_all=True, append_images=quantized[1:], duration=durations,
                      loop=0, optimize=True, disposal=1)
    print(f"{output}: {len(quantized)} frames, {sum(durations) / 1000:.1f} s, {Path(output).stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
