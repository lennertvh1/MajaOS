#!/usr/bin/env python3
# Logo and progress bar on top of the installer window. Closes when the language screen has been drawn.
import math
import os
import time
import tkinter as tk

READY = os.environ.get('UI_READY', '/run/homebaseos-install/ui-ready')
LOGO = os.environ.get('LOGO', '/usr/share/plymouth/themes/homebaseos/logo.png')
BG = '#101a33'


def main():
    root = tk.Tk()
    root.configure(bg=BG, cursor='left_ptr')
    root.attributes('-fullscreen', True)
    root.overrideredirect(True)
    root.attributes('-topmost', True)
    sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
    canvas = tk.Canvas(root, width=sw, height=sh, bg=BG, highlightthickness=0, cursor='left_ptr')
    canvas.pack()
    photo = None
    logo_h = 0
    if os.path.exists(LOGO):
        try:
            photo = tk.PhotoImage(file=LOGO)
            logo_h = photo.height()
            canvas.create_image(sw / 2, sh / 2 - 16, image=photo)
        except tk.TclError:
            photo = None
    bar_w, bar_h, gap = 220, 6, 8
    y = sh / 2 + (logo_h / 2 if logo_h else 24) + gap
    x = sw / 2 - bar_w / 2
    canvas.create_rectangle(x, y, x + bar_w, y + bar_h, fill='#5c6d88', width=0)
    fill = canvas.create_rectangle(x, y, x + 8, y + bar_h, fill='#ffffff', width=0)
    started = time.monotonic()

    def tick():
        if os.path.exists(READY):
            root.destroy()
            return
        t = time.monotonic() - started
        level = 0.45 + 0.48 * (1 - math.exp(-t / 7))
        canvas.coords(fill, x, y, x + bar_w * level, y + bar_h)
        root.lift()
        root.after(50, tick)

    root.after(16, tick)
    root.mainloop()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        import traceback
        traceback.print_exc()
