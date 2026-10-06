from PIL import Image, ImageDraw
def icon(size, maskable=False, path=''):
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pad = 0 if maskable else int(size * 0.06)
    r = 0 if maskable else int(size * 0.22)
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=r, fill=(37, 99, 235, 255))
    s = size / 512
    sc = 0.78 if maskable else 1.0
    def T(x, y): return (size/2 + (x-256)*s*sc, size/2 + (y-256)*s*sc)
    # 문서
    d.rounded_rectangle([*T(150, 110), *T(362, 400)], radius=int(22*s*sc), fill=(255, 255, 255, 255))
    for i, w in enumerate([160, 130, 150, 100]):
        y = 160 + i * 42
        d.rounded_rectangle([*T(180, y), *T(180 + w, y + 16)], radius=int(8*s*sc), fill=(148, 163, 184, 255))
    # 마이크
    d.ellipse([*T(300, 300), *T(420, 420)], fill=(250, 204, 21, 255))
    d.rounded_rectangle([*T(343, 322), *T(377, 380)], radius=int(17*s*sc), fill=(30, 41, 59, 255))
    d.rectangle([*T(357, 382), *T(363, 400)], fill=(30, 41, 59, 255))
    im.save(path)
icon(192, False, 'app/icons/icon-192.png')
icon(512, False, 'app/icons/icon-512.png')
icon(512, True, 'app/icons/icon-maskable-512.png')
