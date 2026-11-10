import sys

from PIL import Image

PANEL_HEIGHT = 560


def panel(image):
    return image.resize((int(image.width * PANEL_HEIGHT / image.height), PANEL_HEIGHT))


def main(photo_path, render_path, out_path):
    photo = Image.open(photo_path).convert("RGB")
    render = Image.open(render_path).convert("RGB").resize(photo.size)
    panels = [panel(photo), panel(render), panel(Image.blend(photo, render, 0.5))]
    sheet = Image.new("RGB", (sum(p.width for p in panels) + 16, PANEL_HEIGHT), (255, 255, 255))
    x = 0
    for p in panels:
        sheet.paste(p, (x, 0))
        x += p.width + 8
    sheet.save(out_path)


if __name__ == "__main__":
    main(*sys.argv[1:4])
