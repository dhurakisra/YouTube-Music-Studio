# Side-pillar / corner effects of the Studio drawer, cut out of the backdrop (design/ref/sk-studio.pre-sidefx.jpg -> design/tex/sk-studio.jpg):
#   * the painted steam above the right capacitor tube is painted out (live steam sprites replace it; see studio_bgfx in preload.js)
#   * five wheels (red valve, 2 pipe-gears, 2 corner gears) become rotating sprites sk-st-sfx-<n>.png + static masks sk-st-sfx-<n>-mask.png
# usage: python -I design/tools/studio_sidefx.py <pre.jpg> <out.jpg>        preview a wheel: ... --test <name> <angle> <out.png>
import sys
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi
from scipy.ndimage import map_coordinates
SRC = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else 'design/ref/sk-studio.pre-sidefx.jpg'
src = Image.open(SRC).convert('RGB'); A = np.asarray(src).astype(np.float32); L = A.mean(axis=2)
# name: centre x, y, hub r, outer r, spokes, wedge centre angle (deg, a clean spoke), excluded discs in front (cx, cy, r)
WHEELS = {
    'v':  dict(c=(4102, 607), ri=17, ro=49, n=6, a=150, excl=[]),
    'g1': dict(c=(4150, 938), ri=40, ro=101, n=8, a=225, excl=[]),
    'g2': dict(c=(4196, 1295), ri=38, ro=99, n=8, a=0, excl=[]),
    'br': dict(c=(4277, 1388), ri=17, ro=56, n=8, a=225, excl=[]),
    'bl': dict(c=(72, 1387), ri=17, ro=53, n=8, a=315, excl=[]),
    'el': dict(c=(2891, 654), ri=46, ro=72, n=0, a=0, excl=[(3019.5, 657.5, 131)], bar=(641, 677), frame=728),   # Enhancer side wheels (behind the cross bar,
    'er': dict(c=(3149, 647), ri=40, ro=66, n=0, a=0, excl=[(3019.5, 657.5, 131)], bar=(641, 677), frame=728),   #  the frame and the big wheel)
}
def build_ring(n):
    P = WHEELS[n]; CX, CY = P['c']; RI, RO = P['ri'], P['ro']; W = 360.0 / P['n']; W0 = P['a'] - W / 2
    R = int(RO + 3); S = 2 * R; x0, y0 = int(CX - R), int(CY - R)
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32); px, py = xx + x0, yy + y0
    d = np.hypot(px - CX, py - CY); th = np.degrees(np.arctan2(CY - py, px - CX)) % 360
    st = np.radians(W0 + ((th - W0) % W)); sx = CX + d * np.cos(st); sy = CY - d * np.sin(st)
    rgb = np.dstack([map_coordinates(A[..., c], [sy, sx], order=1, mode='nearest') for c in range(3)])
    m = ((d >= RI) & (d <= RO)).astype(np.float32)
    for ex, ey, er in P['excl']: m[np.hypot(px - ex, py - ey) <= er] = 0
    alpha = np.where((d >= RI - 1) & (d <= RO + 1), 255, 0).astype(np.uint8)
    sprite = Image.fromarray(np.dstack([rgb.clip(0, 255).astype(np.uint8), alpha]))
    mask = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.7))
    return (x0, y0, S), sprite, mask
GEAR_DIM = 0.66
MESH_BEHIND = ('g2', 'br', 'bl')
ASSET = ('g1', 'g2', 'br', 'bl', 'el', 'er')            # replaced by whole gears from design/tex/sk-gear.png; 'v' (valve) stays a cut-out ring
def build_asset(n):
    P = WHEELS[n]; CX, CY = P['c']; RO = P['ro']
    R = int(RO + 3); S = 2 * R; x0, y0 = int(CX - R), int(CY - R)
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32); px, py = xx + x0, yy + y0; d = np.hypot(px - CX, py - CY)
    D = int(round(2 * (RO + 2))); g = Image.open('design/tex/sk-gear.png').convert('RGBA').resize((D, D), Image.LANCZOS)
    base = Image.new('RGBA', (S, S), (0, 0, 0, 0)); base.paste(g, ((S - D) // 2, (S - D) // 2))
    arr = np.asarray(base).astype(np.float32); rgb = arr[..., :3]; gm = arr[..., 3] > 128
    m = (d <= RO + 1).astype(np.float32)
    for ex, ey, er in P['excl']: m[np.hypot(px - ex, py - ey) <= er] = 0
    if P.get('bar'): m[(py >= P['bar'][0]) & (py <= P['bar'][1])] = 0
    if P.get('frame'): m[py >= P['frame']] = 0
    k = GEAR_DIM   # darkened to sit in the backdrop (the raw asset is far brighter than the painted scene)
    rgb = rgb * k; gray = rgb.mean(axis=2, keepdims=True); rgb = gray + (rgb - gray) * 1.45   # darker but richer
    sprite = Image.fromarray(np.dstack([(rgb).clip(0, 255).astype(np.uint8), np.where(gm, 255, 0).astype(np.uint8)]))
    mask = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.7))
    return (x0, y0, S), sprite, mask
def paint_out_wheels(out):
    """Paint the old baked wheels out of the backdrop by diffusing the surrounding colours into the disc (no flat disc, no visible
    edge), so the live gears' transparent gaps show what could plausibly be behind them (pipes / plate)."""
    rng = np.random.default_rng(9); H, W_ = out.shape[:2]
    for n in ASSET:
        P = WHEELS[n]; CX, CY = P['c']; RO = P['ro'] + 1; R = RO + 24
        xa, xb, ya, yb = max(int(CX - R), 0), min(int(CX + R), W_), max(int(CY - R), 0), min(int(CY + R), H)
        yy, xx = np.mgrid[ya:yb, xa:xb]; d = np.hypot(xx - CX, yy - CY); reg = out[ya:yb, xa:xb].copy()
        hole = d <= RO
        for ex, ey, er in P['excl']: hole &= np.hypot(xx - ex, yy - ey) > er + 1       # parts in front of the wheel stay painted
        if P.get('bar'): hole &= ~((yy >= P['bar'][0] - 1) & (yy <= P['bar'][1] + 1))
        if P.get('frame'): hole &= yy < P['frame'] - 1
        known = ~hole; fill = reg.copy()
        for c in range(3):
            ch = reg[..., c].copy(); ch[hole] = reg[..., c][known & (d < RO + 14)].mean()
            for _ in range(700):
                ch = np.where(hole, ndi.uniform_filter(ch, 9, mode='nearest'), reg[..., c])
            fill[..., c] = ch
        fill = fill * 0.97 + rng.normal(0, 2.0, reg.shape[:2])[..., None]
        if n in MESH_BEHIND:                                           # a dark mesh plate behind the gear instead of the pale diffused fill
            mesh = np.asarray(Image.open('design/ref/mesh-ref.png').convert('RGB').crop((200, 300, 1000, 1100)).resize((120, 120), Image.LANCZOS)).astype(np.float32)
            lum = mesh.mean(axis=2, keepdims=True); tint = lum * np.array([1.0, 0.6, 0.32]) * 0.62
            tiled = np.tile(tint, (int(np.ceil((yb - ya) / 120)), int(np.ceil((xb - xa) / 120)), 1))[:yb - ya, :xb - xa]
            fill = tiled * 0.9 + np.array([7.0, 4.0, 2.0])
        al = np.clip((RO + 2.0 - d) / 9.0, 0, 1)[..., None] ** 1.5   # wide soft fade: no visible ring around the gear
        out[ya:yb, xa:xb] = reg * (1 - al) + fill * al
    return out
def continue_pipes(out, ref):
    """Pipes that ran behind the old wheels: tile a clean piece of the same pipe (taken from ref = the untouched backdrop) through the wheel
    discs, only inside the discs, so they keep running behind the live gears' transparent gaps."""
    H, W_ = out.shape[:2]
    # (x0, x1, clean source rows y0..y1, destination rows, wheel the pipe runs behind)
    PIPES = [(4058, 4106, 1044, 1092, 840, 1044, 'g1'), (4170, 4216, 1098, 1136, 1190, 1310, 'g2'), (4170, 4216, 1098, 1136, 840, 1046, 'g1')]
    for x0, x1, sy0, sy1, dy0, dy1, wn in PIPES:
        P = WHEELS[wn]; CX, CY = P['c']; RO = P['ro'] + 1
        strip = ref[sy0:sy1, x0:x1].copy(); sh = sy1 - sy0
        col = np.zeros((dy1 - dy0, x1 - x0, 3), np.float32)
        for i in range(0, dy1 - dy0, sh):
            piece = strip if (i // sh) % 2 == 0 else strip[::-1]
            n = min(sh, dy1 - dy0 - i); col[i:i + n] = piece[:n]
        yy, xx = np.mgrid[dy0:dy1, x0:x1]
        inside = (np.hypot(xx - CX, yy - CY) <= RO).astype(np.float32)
        edge_x = np.clip(np.minimum(xx - x0, x1 - 1 - xx) / 4.0, 0, 1)
        edge_y = np.clip(np.minimum(yy - dy0, dy1 - 1 - yy) / 8.0, 0, 1)
        al = (inside * edge_x * edge_y)[..., None]
        out[dy0:dy1, x0:x1] = out[dy0:dy1, x0:x1] * (1 - al) + col * al
    return out
def build(n):
    return build_asset(n) if n in ASSET else build_ring(n)
def remove_steam(a):
    X0, Y0, X1, Y1 = 4160, 0, 4344, 222
    reg = a[Y0:Y1, X0:X1]
    haze = np.zeros(reg.shape[:2], bool); haze[0:200, 12:] = True   # the whole cloud box above the funnel (x >= 4172, y < 200)
    known = ~haze; rng = np.random.default_rng(3); filled = reg.copy()
    for c in range(3):                                              # diffusion fill from the surroundings (pipe on the left, funnel below)
        ch = reg[..., c].copy(); ch[haze] = reg[..., c][known & (np.arange(Y1 - Y0)[:, None] < 215)].mean() * 0.8
        for _ in range(900):
            sm = ndi.uniform_filter(ch, 9, mode='nearest'); ch = np.where(haze, sm, reg[..., c])
        filled[..., c] = ch
    yy = np.arange(Y1 - Y0)[:, None, None]
    filled = filled * 0.55 + np.array([22.0, 13.0, 8.0]) * 0.45 + rng.normal(0, 4.0, filled.shape[:2])[..., None]   # plate-coloured, grainy
    al = ndi.gaussian_filter(haze.astype(np.float32), 3.0)[..., None]
    a[Y0:Y1, X0:X1] = reg * (1 - al) + filled * al
    # the right-hand pipe used to disappear behind the steam: extend it upward from its clean lower part (fades out at the top)
    strip = a[216:262, 4270:4312].copy(); H = strip.shape[0]
    for k in range(3):
        y1 = 216 - k * H; y0 = y1 - H
        if y0 < 110: break
        fade = np.clip((y0 - 105) / 50.0, 0, 1) if k == 2 else 1.0
        blend = np.full((H, 1, 1), 1.0 if k < 2 else float(fade), np.float32)
        a[y0:y1, 4270:4312] = a[y0:y1, 4270:4312] * (1 - blend) + strip[::-1 if k % 2 else 1] * blend
    # pipe elbow from the page-background asset (design/tex/sk-bg.jpg: the elbow left of the red valve), mirrored, closes the pipe's top
    bg = Image.open('design/tex/sk-bg.jpg').convert('RGB').crop((1636, 594, 1726, 662))           # 90 x 68 bg px
    K = 1.68; bw, bh = 90, 68
    yy, xx = np.mgrid[0:bh, 0:bw].astype(np.float32); X, Y = xx + 1636, yy + 594
    rr = np.hypot(X - 1688, Y - 644)
    geo = ((rr >= 26) & (rr <= 50) & (X <= 1688) & (Y <= 644)) | ((X >= 1638) & (X <= 1662) & (Y >= 644)) | ((X >= 1688) & (Y >= 595) & (Y <= 620))
    el = np.asarray(bg.resize((int(bw * K), int(bh * K)), Image.LANCZOS)).astype(np.float32)[:, ::-1]
    al = ndi.gaussian_filter(np.asarray(Image.fromarray((geo * 255).astype(np.uint8)).resize((int(bw * K), int(bh * K)), Image.BILINEAR)).astype(np.float32)[:, ::-1] / 255.0, 1.2)
    al[-14:] *= np.linspace(1, 0, 14)[:, None]
    ex0, ey0 = 4165, 72; h_, w_ = al.shape
    sl = (slice(ey0, ey0 + h_), slice(ex0, ex0 + w_))
    a[sl] = a[sl] * (1 - al[..., None]) + el * 0.92 * al[..., None]
    return a
if __name__ == '__main__':
    if '--test' in sys.argv:
        i = sys.argv.index('--test'); n, ang, out = sys.argv[i + 1], float(sys.argv[i + 2]), sys.argv[i + 3]
        (x0, y0, S), sprite, mask = build(n); rot = sprite.rotate(ang, resample=Image.BICUBIC)
        la = np.asarray(rot.split()[3]).astype(np.float32) * np.asarray(mask).astype(np.float32) / 255.0
        rot.putalpha(Image.fromarray(la.astype(np.uint8))); comp = src.copy(); comp.paste(rot, (x0, y0), rot)
        cx, cy = WHEELS[n]['c']; R = WHEELS[n]['ro'] + 40; comp.crop((cx - R, cy - R, cx + R, cy + R)).resize((520, 520)).save(out)
    else:
        for n in WHEELS:
            (x0, y0, S), sprite, mask = build(n); sprite.save(f'design/tex/sk-st-sfx-{n}.png')
            o = Image.new('RGBA', (S, S), (0, 0, 0, 0)); o.putalpha(mask); o.save(f'design/tex/sk-st-sfx-{n}-mask.png'); print(n, x0, y0, x0 + S, y0 + S)
        out = continue_pipes(paint_out_wheels(remove_steam(A.copy())), A)
        # capacitor tubes: the glow (saturated orange light) is dimmed IN the backdrop; the original glow is kept as a light sprite
        # sk-st-glow-<n>.png (alpha = glow strength) that the drawer fades in while the Vocal Lab is on. Natural shape, no box.
        TUBES = {'t1': (4048, 190, 4176, 420), 't2': (4170, 345, 4296, 592), 't3': (4262, 1112, 4308, 1194), 'tl': (40, 1066, 82, 1142)}   # tube + the small white highlight above it
        for n, (x0, y0, x1, y1) in TUBES.items():
            reg = A[y0:y1, x0:x1]; Rr, Gg, Bb = reg[..., 0], reg[..., 1], reg[..., 2]
            g = np.clip((Rr - 95) / 110.0, 0, 1) * np.clip((Rr - Bb - 50) / 90.0, 0, 1)
            if n in ('t1', 't2'):                                          # small white highlight on the cap right above the glass
                band = np.zeros_like(g); band[:44] = 1; cx = reg.shape[1] // 2
                band[:, :cx - 26] = 0; band[:, cx + 26:] = 0
                g = np.maximum(g, band * np.clip((reg.min(axis=2) - 135) / 60.0, 0, 1))
            g = ndi.gaussian_filter(g, 1.6); g = np.clip(g * 1.25, 0, 1)
            sp = np.dstack([reg.clip(0, 255).astype(np.uint8), (g * 255).astype(np.uint8)]); Image.fromarray(sp).save(f'design/tex/sk-st-glow-{n}.png')
            dim = reg * np.array([0.34, 0.27, 0.22]) + np.array([6.0, 3.0, 2.0])        # unlit: dull dark-amber glass
            out[y0:y1, x0:x1] = reg * (1 - g[..., None]) + dim * g[..., None]
        Image.fromarray(np.clip(out, 0, 255).astype(np.uint8)).save(sys.argv[2], quality=88)
