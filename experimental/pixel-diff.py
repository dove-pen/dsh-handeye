#!/usr/bin/env python3
"""diff.py - compare two images and report *where* they differ.

Adapted from pixel_diff.py in Anionex/agent-vision-toolkit (MIT, (c) 2026 Anionex).
The loading rule (flatten alpha onto white) and the "rank the worst regions" idea
are theirs; the fixed grid is replaced with connected components so a single
changed button is reported as one box instead of a whole cell.

Reads two images, writes JSON to --out, prints nothing to stdout (stdout encoding
is unreliable across code pages).
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import deque
from pathlib import Path

from PIL import Image
import numpy as np


def load(path: Path) -> Image.Image:
    # Transparent UI renders black if the alpha channel is left attached, which
    # shows up as a huge phantom diff. Compositing on white is what a viewer sees.
    image = Image.open(path)
    if image.mode in ("RGBA", "LA", "P"):
        image = image.convert("RGBA")
        canvas = Image.new("RGB", image.size, "white")
        canvas.paste(image, mask=image.split()[-1])
        image = canvas
    else:
        image = image.convert("RGB")
    return image


def components(mask: np.ndarray, min_area: int) -> list[tuple[int, int, int, int, int]]:
    """Label 4-connected regions of True and return (x, y, w, h, area) boxes."""
    height, width = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    boxes = []
    rows, cols = np.nonzero(mask)
    for start in range(len(rows)):
        sy, sx = int(rows[start]), int(cols[start])
        if seen[sy, sx]:
            continue
        seen[sy, sx] = True
        queue = deque([(sy, sx)])
        minx = maxx = sx
        miny = maxy = sy
        area = 0
        while queue:
            y, x = queue.popleft()
            area += 1
            if x < minx:
                minx = x
            if x > maxx:
                maxx = x
            if y < miny:
                miny = y
            if y > maxy:
                maxy = y
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < height and 0 <= nx < width and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    queue.append((ny, nx))
        if area >= min_area:
            boxes.append((minx, miny, maxx - minx + 1, maxy - miny + 1, area))
    return boxes


def merge(boxes: list[tuple[int, int, int, int, int]], gap: int) -> list[tuple[int, int, int, int, int]]:
    """Merge boxes whose edges are within `gap` pixels, so one line of text is one box."""
    boxes = list(boxes)
    changed = True
    while changed:
        changed = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                ax, ay, aw, ah, aa = boxes[i]
                bx, by, bw, bh, ba = boxes[j]
                if (
                    ax - gap <= bx + bw
                    and bx - gap <= ax + aw
                    and ay - gap <= by + bh
                    and by - gap <= ay + ah
                ):
                    x1 = min(ax, bx)
                    y1 = min(ay, by)
                    x2 = max(ax + aw, bx + bw)
                    y2 = max(ay + ah, by + bh)
                    boxes[i] = (x1, y1, x2 - x1, y2 - y1, aa + ba)
                    boxes.pop(j)
                    changed = True
                    break
            if changed:
                break
    return boxes


def main() -> None:
    parser = argparse.ArgumentParser(prog="diff")
    parser.add_argument("--a", required=True)
    parser.add_argument("--b", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--threshold", type=int, default=24)
    parser.add_argument("--min-area", type=int, default=40)
    parser.add_argument("--merge-gap", type=int, default=6)
    parser.add_argument("--max-regions", type=int, default=12)
    parser.add_argument("--crop-dir", default="")
    args = parser.parse_args()

    try:
        pa, pb = Path(args.a), Path(args.b)
        for p in (pa, pb):
            if not p.is_file():
                raise FileNotFoundError(str(p))
        a = load(pa)
        b = load(pb)
        resized = None
        if a.size != b.size:
            resized = [b.size[0], b.size[1]]
            b = b.resize(a.size, Image.LANCZOS)

        arr_a = np.asarray(a, dtype=np.int16)
        arr_b = np.asarray(b, dtype=np.int16)
        delta = np.abs(arr_a - arr_b).max(axis=2)
        mask = delta > args.threshold

        total = int(a.size[0] * a.size[1])
        changed = int(mask.sum())
        boxes = merge(components(mask, args.min_area), args.merge_gap) if changed else []
        boxes.sort(key=lambda t: t[4], reverse=True)
        boxes = boxes[: args.max_regions]

        regions = []
        crop_dir = Path(args.crop_dir) if args.crop_dir else None
        if crop_dir:
            crop_dir.mkdir(parents=True, exist_ok=True)
        for index, (x, y, w, h, area) in enumerate(boxes, 1):
            patch = delta[y : y + h, x : x + w]
            item = {
                "x": x,
                "y": y,
                "w": w,
                "h": h,
                "area": area,
                "max_delta": int(patch.max()) if patch.size else 0,
                "mean_delta": round(float(patch.mean()), 1) if patch.size else 0,
                "ratio": round(area / total * 100, 3),
            }
            if crop_dir:
                before = crop_dir / f"{index}-before.png"
                after = crop_dir / f"{index}-after.png"
                a.crop((x, y, x + w, y + h)).save(before)
                b.crop((x, y, x + w, y + h)).save(after)
                item["before"] = str(before)
                item["after"] = str(after)
            regions.append(item)

        result = {
            "ok": True,
            "width": a.size[0],
            "height": a.size[1],
            "total_pixels": total,
            "changed_pixels": changed,
            "ratio": round(changed / total * 100, 3),
            "threshold": args.threshold,
            "regions": regions,
            "resized_b_from": resized,
        }
    except Exception as exc:  # noqa: BLE001 - reported as data, not a traceback
        result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    Path(args.out).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
