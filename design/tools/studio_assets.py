import sys
exec(open(sys.argv[3]).read().split("cmd = sys.argv")[0])
from PIL import ImageFilter
def plate(n, b, L, R, col, mw=8):
    a = crop(b); x0 = b[0]
    c = a[:, col-x0:col-x0+1]
    out = np.concatenate([a[:, :L], np.repeat(c, mw, 1), a[:, a.shape[1]-R:]], 1)
    save(out, n); return (L, R)
def asis(n, b): save(crop(b), n)
def dot(n, cx, cy, r, R):
    a = crop((cx-R, cy-R, cx+R, cy+R)); save(a, n, disc_alpha(2*R, 2*R, R, R, r, 2.5))
def vplate(n, b, T, B, row, mh=8):
    a = crop(b); y0 = b[1]; c = a[row-y0:row-y0+1]
    save(np.concatenate([a[:T], np.repeat(c, mh, 0), a[a.shape[0]-B:]], 0), n)
def _box(x, r, ax):
    r = max(1, int(r)); p = [(0,0)]*x.ndim; p[ax] = (r+1, r)
    c = np.cumsum(np.pad(x, p, mode='edge'), axis=ax)
    n = x.shape[ax]; hi = np.take(c, range(2*r+1, 2*r+1+n), axis=ax); lo = np.take(c, range(0, n), axis=ax)
    return (hi-lo)/(2*r+1)
def gblur(x, r):
    for _ in range(3): x = _box(_box(x, r*0.6, 0), r*0.6, 1)
    return x
def normfill(a, mask, rad=6):
    """fill masked pixels from unmasked neighbours (normalized convolution, coarse to fine)."""
    out = a.copy(); m = mask.copy()
    for r in (rad, rad*3, rad*9, rad*27):
        if not m.any(): break
        w = (~m).astype(np.float32)
        num = np.stack([gblur(out[..., k]*w, r) for k in range(3)], -1)
        den = gblur(w, r)
        ok = m & (den > 0.05)
        out[ok] = num[ok] / den[ok][:, None]; m = m & ~ok
    return out
def dilate(m, k=2):
    return np.asarray(Image.fromarray((m*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(2*k+1))) > 0
def textclean(a, b, mode='light', thr=30, k=2):
    s = a[b[1]:b[3], b[0]:b[2]]; lum = s.mean(2)
    med = np.median(lum)
    m = (lum > med + thr) if mode == 'light' else (lum < med - thr)
    m = dilate(m, k)
    a[b[1]:b[3], b[0]:b[2]] = normfill(s, m)
def texfill(a, b, src):
    sx0, sy0, sx1, sy1 = src; p = A[sy0:sy1, sx0:sx1]
    w, h = b[2]-b[0], b[3]-b[1]
    row = p
    while row.shape[1] < w: row = np.concatenate([row, row[:, ::-1]], 1)
    col = row[:, :w]; t = col
    while t.shape[0] < h: t = np.concatenate([t, t[::-1]], 0)
    t = t[:h]
    base = np.median(p.reshape(-1,3), 0)*0.9
    t = base + (t - gblur(t, 10))*0.9      # keep grunge detail, drop the lamp glows / banding
    # feather 10px into the existing image
    yy, xx = np.mgrid[0:h, 0:w]; f = np.minimum.reduce([xx, yy, w-1-xx, h-1-yy]).astype(np.float32)
    al = np.clip(f/10, 0, 1)[..., None]
    a[b[1]:b[3], b[0]:b[2]] = a[b[1]:b[3], b[0]:b[2]]*(1-al) + t*al
def needle(a, p0, p1, wdt=16):
    from PIL import ImageDraw
    m = Image.new('L', (a.shape[1], a.shape[0])); ImageDraw.Draw(m).line([p0, p1], fill=255, width=wdt)
    return normfill(a, np.asarray(m) > 0, 3)

# ---------- sprites ----------
plate('sk-st-cream-big.png', (108,178,465,250), 30, 26, 133)
plate('sk-st-cream.png', (1833,508,2063,568), 30, 30, 1860)
plate('sk-st-amber.png', (1572,506,1806,566), 28, 28, 1636)
plate('sk-st-red.png', (993,176,1066,224), 9, 9, 1001)
plate('sk-st-solo.png', (916,176,988,224), 9, 9, 923)
plate('sk-st-select.png', (1572,592,1935,650), 20, 62, 1585)
plate('sk-st-input.png', (1962,592,2355,650), 18, 18, 1972)
plate('sk-st-valbox.png', (702,175,795,235), 15, 15, 712)
asis('sk-st-minus.png', (652,178,698,230)); asis('sk-st-plus.png', (802,178,848,230))
dot('sk-st-led-on.png', 3250, 959, 15, 17); dot('sk-st-led-off.png', 3215, 953, 11, 13)
dot('sk-st-reddot.png', 157, 429, 17, 19)
vplate('sk-st-fslot.png', (986,244,1045,628), 22, 22, 272)
asis('sk-st-fcap.png', (983,304,1038,401)); asis('sk-st-fcap-red.png', (1150,298,1206,396))
vl = crop((3368,172,3648,365)); vl = needle(vl, (3485-3368,320-172), (3450-3368,222-172)); save(vl, 'sk-st-vu-l.png')
vr = crop((3675,172,3952,365)); vr = needle(vr, (3778-3675,325-172), (3708-3675,252-172)); save(vr, 'sk-st-vu-r.png')
# vocal-chain module plate (from COMP): title text + LED + controls removed
m = crop((1636,916,1838,1304)); H, W = m.shape[:2]
col = m[:, 48:49]
m[:82, 50:164] = np.repeat(col[:82], 114, 1)   # title plate band: text and LED gone
patch = m[229:276, 24:180]; body = patch
while body.shape[0] < 265: body = np.concatenate([body, body[::-1]], 0)
m[80:345, 24:180] = body[:265]
save(m, 'sk-st-mod.png')

# ---------- base ----------
B = A.copy()
for r in [(712,183,788,228),(712,268,788,315),(555,410,822,452),(1576,668,2005,708),(1385,852,2320,902),
          (180,1374,445,1410),(1968,1376,2182,1412),(3488,1378,3712,1410),(4035,1378,4198,1414)]:
    textclean(B, r, 'light', 28)
B[178:478, 1574:2598] = np.array([7,12,7])   # EQ screen glass: canvas draws grid/curve
texfill(B, (903,166,1420,776), (2720,836,3790,905))
texfill(B, (108,914,4042,1312), (2720,836,3790,905))
A0 = A; A = B
save(B, 'sk-studio.jpg', q=86)
