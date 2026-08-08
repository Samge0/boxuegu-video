"""
Generate app icon for Boxuegu Video Player.
Apple-style design: rounded square background, owl mascot, minimal padding.
"""
from PIL import Image, ImageDraw, ImageFilter
import math, os

def create_owl_icon(size=512):
    # Create canvas with transparency
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    s = size / 512.0

    # === Rounded square background (iOS/macOS style) ===
    corner_radius = int(115 * s)  # iOS super-ellipse-like radius
    margin = 0
    # Red gradient background matching app theme
    bg_color_outer = (233, 69, 96)     # #e94560
    bg_color_inner = (200, 45, 75)     # slightly darker for depth

    # Draw filled rounded rectangle
    draw.rounded_rectangle(
        [margin, margin, size - margin, size - margin],
        radius=corner_radius,
        fill=bg_color_outer
    )

    # Add subtle gradient overlay (top-left lighter)
    overlay = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    o_draw = ImageDraw.Draw(overlay)
    for i in range(int(60 * s)):
        alpha = int(40 * (1 - i / (60 * s)))
        r2 = int(corner_radius + i * 3)
        o_draw.rounded_rectangle(
            [i, i, size - i, size - i],
            radius=r2,
            outline=(255, 255, 255, alpha)
        )
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)

    # Add top highlight (gloss effect)
    gloss = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    g_draw = ImageDraw.Draw(gloss)
    gloss_h = int(180 * s)
    for y in range(gloss_h):
        alpha = int(30 * (1 - y / gloss_h) ** 2)
        g_draw.line([(0, y), (size, y)], fill=(255, 255, 255, alpha))
    # Mask gloss to rounded rect
    mask = Image.new('L', (size, size), 0)
    m_draw = ImageDraw.Draw(mask)
    m_draw.rounded_rectangle([0, 0, size, size], radius=corner_radius, fill=255)
    gloss.putalpha(Image.composite(gloss.split()[3], Image.new('L', (size, size), 0), mask))
    img = Image.alpha_composite(img, gloss)
    draw = ImageDraw.Draw(img)

    # === Owl mascot (larger, fills more of the icon) ===
    cx = size // 2
    cy = int(size * 0.52)

    white = (255, 255, 255, 255)
    dark = (40, 25, 50, 255)
    beak_color = (255, 190, 60, 255)

    # Body - large rounded shape
    body_top = int(cy - 60 * s)
    body_bottom = int(cy + 150 * s)
    body_left = cx - int(95 * s)
    body_right = cx + int(95 * s)
    draw.ellipse([body_left, body_top, body_right, body_bottom], fill=white)

    # Belly detail - subtle inner shadow at bottom
    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    sh_draw = ImageDraw.Draw(shadow)
    sh_draw.ellipse([body_left, int(cy + 30 * s), body_right, body_bottom + int(20 * s)],
                     fill=(0, 0, 0, 25))
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(15 * s)))
    img = Image.alpha_composite(img, shadow)
    draw = ImageDraw.Draw(img)

    # Head - large circle
    head_r = int(115 * s)
    head_cy = int(cy - 55 * s)
    draw.ellipse([cx - head_r, head_cy - head_r, cx + head_r, head_cy + head_r], fill=white)

    # Ear tufts - two pointed triangles on top
    ear_color = white
    # Left ear
    draw.polygon([
        (cx - int(78 * s), head_cy - int(80 * s)),
        (cx - int(40 * s), head_cy - int(135 * s)),
        (cx - int(30 * s), head_cy - int(72 * s))
    ], fill=ear_color)
    # Right ear
    draw.polygon([
        (cx + int(78 * s), head_cy - int(80 * s)),
        (cx + int(40 * s), head_cy - int(135 * s)),
        (cx + int(30 * s), head_cy - int(72 * s))
    ], fill=ear_color)

    # Eyes - large, expressive
    eye_r = int(52 * s)
    eye_offset = int(55 * s)
    eye_y = head_cy

    # Left eye white
    draw.ellipse([cx - eye_offset - eye_r, eye_y - eye_r, cx - eye_offset + eye_r, eye_y + eye_r], fill=white)
    # Right eye white
    draw.ellipse([cx + eye_offset - eye_r, eye_y - eye_r, cx + eye_offset + eye_r, eye_y + eye_r], fill=white)

    # Eye rings (subtle gray)
    ring_r = int(46 * s)
    ring_w = max(2, int(2.5 * s))
    draw.ellipse([cx - eye_offset - ring_r, eye_y - ring_r, cx - eye_offset + ring_r, eye_y + ring_r],
                 outline=(220, 220, 230, 255), width=ring_w)
    draw.ellipse([cx + eye_offset - ring_r, eye_y - ring_r, cx + eye_offset + ring_r, eye_y + ring_r],
                 outline=(220, 220, 230, 255), width=ring_w)

    # Pupils - large dark circles
    pupil_r = int(28 * s)
    draw.ellipse([cx - eye_offset - pupil_r, eye_y - pupil_r, cx - eye_offset + pupil_r, eye_y + pupil_r], fill=dark)
    draw.ellipse([cx + eye_offset - pupil_r, eye_y - pupil_r, cx + eye_offset + pupil_r, eye_y + pupil_r], fill=dark)

    # Pupil highlights (catch lights)
    hl_r = int(10 * s)
    # Left highlight
    draw.ellipse([cx - eye_offset - int(8 * s), eye_y - int(14 * s),
                  cx - eye_offset + int(12 * s), eye_y + int(6 * s)], fill=white)
    # Right highlight
    draw.ellipse([cx + eye_offset - int(8 * s), eye_y - int(14 * s),
                  cx + eye_offset + int(12 * s), eye_y + int(6 * s)], fill=white)

    # Small secondary highlights
    hl2 = int(5 * s)
    draw.ellipse([cx - eye_offset + int(10 * s), eye_y + int(5 * s),
                  cx - eye_offset + int(10 * s) + hl2 * 2, eye_y + int(5 * s) + hl2 * 2], fill=(255, 255, 255, 160))
    draw.ellipse([cx + eye_offset + int(10 * s), eye_y + int(5 * s),
                  cx + eye_offset + int(10 * s) + hl2 * 2, eye_y + int(5 * s) + hl2 * 2], fill=(255, 255, 255, 160))

    # Beak - rounded, orange
    beak_top = int(cy - 15 * s)
    beak_bottom = int(cy + 15 * s)
    beak_w = int(22 * s)
    draw.polygon([
        (cx, beak_top - int(8 * s)),
        (cx - beak_w, beak_bottom),
        (cx + beak_w, beak_bottom)
    ], fill=beak_color)

    # Wings - subtle, on sides of body
    wing_color = (245, 245, 248, 255)
    # Left wing
    wing_pts_l = [
        (body_left + int(5 * s), int(cy + 10 * s)),
        (body_left - int(15 * s), int(cy + 70 * s)),
        (body_left + int(35 * s), int(cy + 95 * s)),
        (body_left + int(55 * s), int(cy + 50 * s)),
    ]
    # Right wing
    wing_pts_r = [
        (body_right - int(5 * s), int(cy + 10 * s)),
        (body_right + int(15 * s), int(cy + 70 * s)),
        (body_right - int(35 * s), int(cy + 95 * s)),
        (body_right - int(55 * s), int(cy + 50 * s)),
    ]
    # Draw wings as subtle arcs
    draw.ellipse([body_left - int(10 * s), int(cy + 5 * s), body_left + int(70 * s), int(cy + 100 * s)],
                 fill=wing_color)
    draw.ellipse([body_right - int(70 * s), int(cy + 5 * s), body_right + int(10 * s), int(cy + 100 * s)],
                 fill=wing_color)

    # Redraw body outline to clean up wing overlaps
    draw.ellipse([body_left, body_top, body_right, body_bottom], fill=white)
    # Redraw wings on top
    draw.ellipse([body_left - int(10 * s), int(cy + 5 * s), body_left + int(70 * s), int(cy + 100 * s)],
                 fill=wing_color)
    draw.ellipse([body_right - int(70 * s), int(cy + 5 * s), body_right + int(10 * s), int(cy + 100 * s)],
                 fill=wing_color)

    # Feet - small orange claws
    foot_y = body_bottom - int(5 * s)
    foot_color = beak_color
    for side in [-1, 1]:
        fx = cx + side * int(30 * s)
        for i in range(3):
            tx = fx + (i - 1) * int(10 * s)
            draw.ellipse([tx - int(4 * s), foot_y, tx + int(4 * s), foot_y + int(14 * s)], fill=foot_color)

    return img


# Generate
os.makedirs('build', exist_ok=True)

# PNG (512x512)
icon_png = create_owl_icon(512)
icon_png.save('build/icon.png', 'PNG')
print('Saved build/icon.png')

# 256x256
icon_png.resize((256, 256), Image.LANCZOS).save('build/icon-256.png', 'PNG')

# ICO (multi-size)
icon_png.save('build/icon.ico', sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('Saved build/icon.ico')

print('Done!')
