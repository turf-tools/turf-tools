#!/usr/bin/env python3
"""Generate the heading-cone sprites for user-location-dot.tsx.

White-on-alpha wedges tinted at runtime via Image tintColor. Geometry and
knobs mirror the component's constants — keep them in sync:
  CONE_RADIUS 62pt, DOT_SIZE 19pt, CONE_OPACITY 0.45 at the apex fading
  linearly to 0 at the rim, base chord spanning the dot's width, sides
  spreading to the accuracy angle, arc cap at CONE_RADIUS.

Output: assets/map/cone-{55,75,100}.png at 3x (372px for a 124pt box).
"""

import math
import os
import struct
import zlib

SCALE = 3  # pixels per point
CONE_RADIUS_PT = 62
DOT_SIZE_PT = 19
CONE_OPACITY = 0.45
ANGLES = [55, 75, 100]
SUPERSAMPLE = 2

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "assets", "map")


def write_png(path, size, rows):
    def chunk(tag, data):
        raw = tag + data
        return struct.pack(">I", len(data)) + raw + struct.pack(">I", zlib.crc32(raw))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(b"".join(b"\x00" + row for row in rows), 9)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", idat))
        f.write(chunk(b"IEND", b""))


def coverage(dx, dy, radius, dot_radius, half_rad):
    # Inside test in centered coords, y-down; beam points up (-y).
    if dy > 0:
        return 0.0
    dist = math.hypot(dx, dy)
    if dist > radius:
        return 0.0
    ax = radius * math.sin(half_rad)
    ay = -radius * math.cos(half_rad)
    # Left side: right of the line from (-dot_radius, 0) to (-ax, ay).
    dlx, dly = -ax + dot_radius, ay
    if dlx * dy - dly * (dx + dot_radius) < 0:
        return 0.0
    # Right side, mirrored.
    drx, dry = ax - dot_radius, ay
    if drx * dy - dry * (dx - dot_radius) > 0:
        return 0.0
    return CONE_OPACITY * (1.0 - dist / radius)


def generate(angle):
    radius = CONE_RADIUS_PT * SCALE
    dot_radius = DOT_SIZE_PT * SCALE / 2
    size = 2 * radius
    half_rad = math.radians(angle / 2)
    step = 1.0 / SUPERSAMPLE
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = 0.0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    dx = x + (sx + 0.5) * step - radius
                    dy = y + (sy + 0.5) * step - radius
                    acc += coverage(dx, dy, radius, dot_radius, half_rad)
            alpha = round(255 * acc / (SUPERSAMPLE * SUPERSAMPLE))
            row += bytes((255, 255, 255, alpha))
        rows.append(bytes(row))
    out = os.path.join(OUT_DIR, f"cone-{angle}.png")
    write_png(out, size, rows)
    print(f"wrote {out} ({size}x{size})")


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for a in ANGLES:
        generate(a)
