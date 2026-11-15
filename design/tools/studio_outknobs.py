# Output MASTER / THRESH knobs from design/ref/outknobs-ref.png.
# base = the whole knob with its pointer painted out (static); cap = the pointer alone, rotated to point straight up, on a
# canvas the same size as the base, so both share one exact centre (fitted to the dark face circle) and the cap turns in place.
# usage: python -I design/tools/studio_outknobs.py design/ref/outknobs-ref.png design/tex
import sys, math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
src, out = sys.argv[1], sys.argv[2]
img = Image.open(src).convert('RGB')
def knob(name, cx, cy, R, rdisc, studs, p0, p1, pw):
    S = 2 * R
    # pad so the square crop can leave the source image
    pad = Image.new('RGB', (img.width + 2 * R, img.height + 2 * R)); pad.paste(img, (R, R))
    ox, oy = cx - R + R, cy - R + R  # crop origin in padded coords (sub-pixel centre handled by affine below)
    crop = pad.transform((S, S), Image.AFFINE, (1, 0, cx - R + R, 0, 1, cy - R + R), resample=Image.BICUBIC)
    c = (R, R)
    # pointer mask (segment p0->p1, width pw), in crop coordinates
    q0 = (p0[0] - cx + R, p0[1] - cy + R); q1 = (p1[0] - cx + R, p1[1] - cy + R)
    pm = Image.new('L', (S, S)); d = ImageDraw.Draw(pm); d.line([q0, q1], fill=255, width=pw)
    for q in (q0, q1): d.ellipse([q[0] - pw / 2, q[1] - pw / 2, q[0] + pw / 2, q[1] + pw / 2], fill=255)
    pm = pm.filter(ImageFilter.GaussianBlur(1.5))
    # base: pointer area filled from the same knob turned by 90 deg (ticks repeat every 30 deg, the face is radially uniform)
    fill = crop.rotate(90, resample=Image.BICUBIC, center=c)
    # erase mask: pointer plus its drop shadow (wider, extended a little toward the centre and outwards)
    em = Image.new('L', (S, S)); d2 = ImageDraw.Draw(em)
    vx, vy = q1[0] - q0[0], q1[1] - q0[1]; L = math.hypot(vx, vy); ux, uy = vx / L, vy / L
    e0 = (q0[0] - ux * pw * 0.6, q0[1] - uy * pw * 0.6); e1 = (q1[0] + ux * pw * 0.4, q1[1] + uy * pw * 0.4)
    d2.line([e0, e1], fill=255, width=int(pw * 2.6))
    d2.line([(e0[0], e0[1] + pw * 0.8), (e1[0], e1[1] + pw * 0.8)], fill=255, width=int(pw * 2.6))
    # plus the whole wedge around the pointer inside the tick ring (its soft shadow spreads wider than the bar)
    a0 = math.degrees(math.atan2(uy, ux)); rin = math.hypot(q1[0] - R, q1[1] - R) + pw * 0.5
    d2.pieslice([R - rin, R - rin, R + rin, R + rin], a0 - 22, a0 + 26, fill=255)
    big = em.filter(ImageFilter.GaussianBlur(3))
    base = Image.composite(fill, crop, big)
    am = Image.new('L', (S, S)); d = ImageDraw.Draw(am)
    d.ellipse([R - rdisc, R - rdisc, R + rdisc, R + rdisc], fill=255)
    for (sx, sy, sr) in studs:
        sx, sy = sx - cx + R, sy - cy + R; d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=255)
    am = am.filter(ImageFilter.GaussianBlur(2))
    b = base.convert('RGBA'); b.putalpha(am); b.save(f'{out}/sk-st-{name}-base.png', optimize=True)
    # cap: the pointer pixels, rotated so it points up (angle measured clockwise from 12 o'clock)
    ang = math.degrees(math.atan2(q1[0] - R, -(q1[1] - R)))
    cap = crop.convert('RGBA'); cap.putalpha(pm)
    cap = cap.rotate(ang, resample=Image.BICUBIC, center=c)   # PIL rotates counter-clockwise for positive angles
    cap.save(f'{out}/sk-st-{name}-cap.png', optimize=True)
    print(name, 'pointer angle', round(ang, 1))
knob('kout-master', 523.5, 360.0, 372, 338, [(160, 381, 24), (873, 381, 24)], (585, 333), (722, 257), 24)
knob('kout-thresh', 1327.4, 385.2, 192, 172, [(1143, 400, 16), (1503, 400, 16)], (1355, 408), (1420, 463), 14)
