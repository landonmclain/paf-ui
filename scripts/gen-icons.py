"""Generate the PWA icons (run from repo root: python3 scripts/gen-icons.py).

Three variants of one design (lowercase "paf" wordmark + accent underline on the
app's dark background):

- ``any``      rounded tile on a transparent canvas, big wordmark. Used by desktop
               installs, the browser tab and Linux launchers, which show the image
               as-is, so it must fill its box.
- ``maskable`` full-bleed square; the wordmark sits inside the central safe zone
               (Android crops to a circle / squircle).
- ``apple``    full-bleed square (iOS rounds the corners itself), big wordmark.

Everything is drawn at 2048px and downsampled, so edges stay crisp at every size.
"""
from PIL import Image, ImageDraw, ImageFont

BG = "#0f1115"  # matches --background in .dark (app/globals.css)
FG = "#f4f4f5"
ACCENT = "#7c9cff"
FONT = "/usr/share/fonts/truetype/inter/Inter-ExtraBold.ttf"
MASTER = 2048


def wordmark(d: ImageDraw.ImageDraw, size: int, width_frac: float, cy_frac: float = 0.5):
    """Draw "paf" + underline centred at (size/2, size*cy_frac), `width_frac` wide."""
    fs = size // 2
    while True:
        font = ImageFont.truetype(FONT, fs)
        l, t, r, b = d.textbbox((0, 0), "paf", font=font)
        if r - l <= size * width_frac or fs < 8:
            break
        fs -= 2
    uh = max(2, size // 34)  # underline thickness
    gap = size * 0.045
    block_h = (b - t) + gap + uh  # wordmark + gap + underline, centred together
    top = size * cy_frac - block_h / 2
    x = (size - (r - l)) / 2 - l
    y = top - t
    d.text((x, y), "paf", font=font, fill=FG)
    uw = (r - l) * 0.34
    uy = top + (b - t) + gap
    ux = (size - uw) / 2
    d.rounded_rectangle((ux, uy, ux + uw, uy + uh), radius=uh / 2, fill=ACCENT)


def make_any() -> Image.Image:
    img = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = int(MASTER * 0.03)  # small transparent margin so the tile isn't clipped
    d.rounded_rectangle((m, m, MASTER - m, MASTER - m), radius=int(MASTER * 0.22), fill=BG)
    wordmark(d, MASTER, 0.74)
    return img


def make_square(width_frac: float) -> Image.Image:
    img = Image.new("RGB", (MASTER, MASTER), BG)
    wordmark(ImageDraw.Draw(img), MASTER, width_frac)
    return img


ANY, MASKABLE, APPLE = make_any(), make_square(0.62), make_square(0.70)

OUT = {
    "public/icon-192.png": (ANY, 192),
    "public/icon-256.png": (ANY, 256),
    "public/icon-512.png": (ANY, 512),
    "public/icon-1024.png": (ANY, 1024),
    "public/icon-maskable-512.png": (MASKABLE, 512),
    "app/apple-icon.png": (APPLE, 180),
    "app/icon.png": (ANY, 512),
}
for name, (src, size) in OUT.items():
    src.resize((size, size), Image.LANCZOS).save(name, optimize=True)
    print(name, size)
