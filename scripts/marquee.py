#!/usr/bin/env python3
"""
屏幕四边跑马灯效果 — GTK 透明覆盖层

用法:
  python3 marquee.py [duration] [speed] [intensity]

参数:
  duration   持续秒数 (默认 3.0)
  speed      移动速度因子 (默认 4.0)
  intensity  不透明度 0.0–1.0 (默认 0.9)

依赖: Python 3 + PyGObject (Ubuntu GNOME 内置)
"""

import gi
import sys
import time
import signal

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib, Gdk
import cairo as _cairo

# 跑马灯颜色序列：红 → 橙 → 黄 → 绿 → 蓝
MARQUEE_COLORS = [
    (1.0, 0.2, 0.1),
    (1.0, 0.6, 0.0),
    (1.0, 1.0, 0.0),
    (0.0, 1.0, 0.0),
    (0.0, 0.6, 1.0),
]


class MarqueeWindow(Gtk.Window):
    def __init__(self, duration=3.0, speed=4.0, intensity=0.9):
        super().__init__(type=Gtk.WindowType.POPUP)
        self.set_title("opencode-marquee")
        self.set_decorated(False)
        self.set_app_paintable(True)
        self.set_keep_above(True)
        self.set_accept_focus(False)
        self.set_skip_taskbar_hint(True)
        # 覆盖所有工作区
        self.stick()

        # 获取主显示器尺寸
        screen = Gdk.Screen.get_default()
        display = screen.get_display()
        monitor = display.get_primary_monitor() if display else screen.get_monitor(0)
        geo = monitor.get_geometry()
        self.screen_w = geo.width
        self.screen_h = geo.height
        self.set_default_size(self.screen_w, self.screen_h)
        self.move(geo.x, geo.y)

        self.border_w = 6          # 边框厚度 (px)
        self.light_w = 28          # 单个灯宽度 (px)
        self.light_gap = 12        # 灯间距 (px)
        self.speed = speed
        self.intensity = min(max(intensity, 0.0), 1.0)
        self.duration = duration
        self.start_time = time.monotonic()
        self.t = 0.0

        # 设置透明背景
        self._setup_transparency()

        self.connect("realize", self._on_realize)
        self.connect("draw", self.on_draw)
        self.connect("screen-changed", self.on_screen_changed)

        # 60fps 动画循环
        GLib.timeout_add(16, self.on_tick)

    def _setup_transparency(self):
        """配置 RGBA 透明支持"""
        visual = self.get_screen().get_rgba_visual()
        if visual:
            self.set_visual(visual)
        else:
            # 没有 RGBA 支持时回退为整体窗口透明度
            self.set_opacity(self.intensity)

    def _on_realize(self, widget):
        """窗口实时化后，设置空的输入区域 → 点击穿透"""
        surf = _cairo.ImageSurface(_cairo.Format.A1, 1, 1)
        empty = Gdk.cairo_region_create_from_surface(surf)
        if empty:
            widget.input_shape_combine_region(empty)

    def on_screen_changed(self, widget, old_screen):
        self._setup_transparency()

    def on_draw(self, widget, cr):
        w = self.screen_w
        h = self.screen_h
        bw = self.border_w
        t = self.t
        step = self.light_w + self.light_gap

        # 清空为全透明
        cr.set_source_rgba(0, 0, 0, 0)
        cr.set_operator(_cairo.Operator.SOURCE)
        cr.paint()
        cr.set_operator(_cairo.Operator.OVER)

        # 构造所有灯光的 (x, y, width, height, side_index)
        lights = []

        # 上边：从左向右
        offset = (t * self.speed * step) % (w + self.light_w * 2)
        for i in range(0, w + step, step):
            x = (i + offset) % (w + self.light_w * 4) - self.light_w * 2
            lights.append((x, 0, self.light_w, bw, 0))

        # 右边：从上向下
        offset = (t * self.speed * step) % (h + self.light_w * 2)
        for i in range(0, h + step, step):
            y = (i + offset) % (h + self.light_w * 4) - self.light_w * 2
            lights.append((w - bw, y, bw, self.light_w, 1))

        # 下边：从右向左
        offset = (t * self.speed * step) % (w + self.light_w * 2)
        for i in range(0, w + step, step):
            x = (w + self.light_w * 4 - (i + offset)) % (w + self.light_w * 4) - self.light_w * 2
            lights.append((x, h - bw, self.light_w, bw, 2))

        # 左边：从下向上
        offset = (t * self.speed * step) % (h + self.light_w * 2)
        for i in range(0, h + step, step):
            y = (h + self.light_w * 4 - (i + offset)) % (h + self.light_w * 4) - self.light_w * 2
            lights.append((0, y, bw, self.light_w, 3))

        # 绘制灯光
        nc = len(MARQUEE_COLORS)
        for idx, (lx, ly, lw, lh, side) in enumerate(lights):
            r, g, b = MARQUEE_COLORS[(idx + side) % nc]
            fade = 0.5 + 0.5 * (1.0 - abs(float(idx % 5) / 5.0 - 0.5) * 2)
            cr.set_source_rgba(r, g, b, fade * self.intensity)
            cr.rectangle(lx, ly, lw, lh)
            cr.fill()

        return True

    def on_tick(self):
        elapsed = time.monotonic() - self.start_time
        if elapsed >= self.duration:
            Gtk.main_quit()
            return False
        self.t = elapsed
        self.queue_draw()
        return True


def main():
    # 解析命令行参数
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
    speed = float(sys.argv[2]) if len(sys.argv) > 2 else 4.0
    intensity = float(sys.argv[3]) if len(sys.argv) > 3 else 0.9

    # 检查 DISPLAY
    import os
    if not os.environ.get("DISPLAY"):
        print("marquee: DISPLAY 未设置，跳过", file=sys.stderr)
        sys.exit(1)

    win = MarqueeWindow(duration=duration, speed=speed, intensity=intensity)
    win.show_all()

    # 优雅退出
    signal.signal(signal.SIGINT, lambda s, f: Gtk.main_quit())
    signal.signal(signal.SIGTERM, lambda s, f: Gtk.main_quit())

    Gtk.main()


if __name__ == "__main__":
    main()
