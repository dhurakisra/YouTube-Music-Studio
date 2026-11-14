import sys
exec(open(sys.argv[3]).read().split("cmd = sys.argv")[0])
def kn(n, cx, cy, R, rc):
    a = crop((cx-R, cy-R, cx+R, cy+R)); save(a, f'sk-st-{n}-base.png', disc_alpha(2*R,2*R,R,R,R-1,2.5))
    s = rc+2; c = crop((cx-s, cy-s, cx+s, cy+s)); save(c, f'sk-st-{n}-cap.png', disc_alpha(2*s,2*s,s,s,rc,1.6))
kn('kcream', 2961, 208, 46, 29)
kn('kred', 3213, 210, 46, 30)
kn('kdark', 3783, 473, 46, 30)
kn('kmaster', 3547, 479, 104, 63)
