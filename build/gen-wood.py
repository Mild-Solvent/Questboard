#!/usr/bin/env python3
"""Generates assets/wood.png: an anime-style plank wall for the Tavern theme.

Cel-shaded look: each plank gets a flat base tone, grain is posterized into a few
bands with crisp darker grain lines, knots bend the grain around them, plank edges get a
lit top bevel and a shadowed bottom, and butt joints carry two nail heads.
The tile repeats seamlessly in both directions.  Re-run: python3 build/gen-wood.py
"""
import math
import os
import random

import numpy as np
from PIL import Image, ImageFilter

W, H = 1024, 600          # tile size; 5 planks of 120 px
PLANK = 120
SEED = 11
rng = random.Random(SEED)
np.random.seed(SEED)

ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)


def periodic_noise(octaves, amp, seed):
    """Smooth noise that repeats every W pixels in x (sum of integer-period sines)."""
    r = np.random.RandomState(seed)
    out = np.zeros((H, W), np.float32)
    for o in range(octaves):
        k = 1 + o + r.randint(0, 1)                # whole periods across the tile (few = long, lazy grain)
        ph = r.uniform(0, 2 * math.pi)
        fy = r.uniform(0.001, 0.006)
        out += np.sin(2 * math.pi * k * xs / W + ph + ys * fy) / (o + 1)
    return out * amp


# palette: warm anime wood (light, mid, dark, line)
BASES = [
    (176, 102, 52), (164, 92, 46), (186, 112, 58), (158, 88, 44), (172, 98, 50),
]
img = np.zeros((H, W, 3), np.float32)

for i in range(H // PLANK):
    y0 = i * PLANK
    band = (ys >= y0) & (ys < y0 + PLANK)
    img_knot = np.zeros_like(band)
    base = np.array(BASES[i % len(BASES)], np.float32) * rng.uniform(0.94, 1.06)
    ly = ys - y0

    # grain field: long horizontal rings that wander, plus knots that pinch them
    field = ly * rng.uniform(0.035, 0.05) + periodic_noise(3, 0.9, SEED + i * 7)
    # cathedral arches: a slow bump in the middle of some planks
    if rng.random() < 0.6:
        cx = rng.uniform(0, W); sw = rng.uniform(140, 260)
        dxc = (xs - cx + W / 2) % W - W / 2
        field += 1.6 * np.exp(-(dxc / sw) ** 2) * (1 - ly / PLANK)
    for _ in range(rng.choice([0, 1, 1])):
        kx, ky = rng.uniform(0, W), y0 + rng.uniform(30, PLANK - 30)
        rx, ry = rng.uniform(12, 20), rng.uniform(6, 9)
        dx = (xs - kx + W / 2) % W - W / 2               # wrap so knots tile
        d = np.sqrt((dx / (rx * 3.2)) ** 2 + ((ys - ky) / (ry * 2.2)) ** 2)
        field += np.where(band, 1.4 * np.exp(-d * d) * np.sign(ys - ky + 0.01), 0)
        kd = np.sqrt((dx / rx) ** 2 + ((ys - ky) / ry) ** 2)
        knot_rings = (kd < 1.0)
        field = np.where(band & knot_rings, kd * 2.2 + 40, field)
        img_knot = band & (kd < 0.45)

    knot_core = img_knot & band
    frac = field - np.floor(field)
    # posterize into 3 tones, then add crisp grain lines
    tone = np.where(frac < 0.55, 1.0, np.where(frac < 0.85, 0.91, 0.84))
    line = np.abs(frac - 0.85) < 0.022
    col = base[None, None, :] * tone[..., None]
    col = np.where(line[..., None], base * 0.62, col)
    col = np.where(knot_core[..., None], base * 0.5, col)

    # cel-shaded bevel: lit top edge, shadowed bottom, dark seam
    top = ly < 4
    bottom = (ly >= PLANK - 9) & (ly < PLANK - 3)
    seam = ly >= PLANK - 3
    col = np.where(top[..., None], np.minimum(base * 1.28, 255), col)
    col = np.where(bottom[..., None], col * 0.72, col)
    col = np.where(seam[..., None], np.array([42, 20, 9], np.float32), col)

    img = np.where(band[..., None], col, img)

    # butt joints with two nails (offset per plank like a real wall)
    jx = int((rng.uniform(0.15, 0.85) * W + i * 377) % W)
    for x in range(jx - 2, jx + 2):
        img[y0 + 3:y0 + PLANK - 3, x % W] = (48, 24, 11)
    img[y0 + 3:y0 + PLANK - 3, (jx + 2) % W] = np.minimum(base * 1.2, 255)
    for ny in (y0 + 22, y0 + PLANK - 26):
        for nxo in (-10, 10):
            cx = (jx + nxo) % W
            for yy in range(ny - 4, ny + 5):
                for xx in range(cx - 4, cx + 5):
                    r2 = (yy - ny) ** 2 + (xx - cx) ** 2
                    if r2 <= 16:
                        shade = 70 if (yy - ny) + (xx - cx) > 1 else 120
                        if r2 <= 2 and (yy - ny) < 0:
                            shade = 175
                        img[yy % H, xx % W] = (shade, shade * 0.85, shade * 0.75)

# a little wear: soft darker blotches (very subtle, keeps the flat anime look)
wear = periodic_noise(3, 1.0, 99)
img *= (1.0 - 0.05 * (wear > 0.6))[..., None]

out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), 'RGB')
out = out.filter(ImageFilter.SMOOTH_MORE)          # soften aliasing, keep crisp bands
path = os.path.join(os.path.dirname(__file__), '..', 'assets', 'wood.png')
out.save(path, optimize=True)
print('wrote', os.path.abspath(path), os.path.getsize(path), 'bytes')
