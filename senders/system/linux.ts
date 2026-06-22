/**
 * Linux 系统通知
 *
 * 使用 notify-send（来自 libnotify）。
 * 支持点击通知打开 Terminator 终端（通过 --action default）。
 * 桌面发行版通常预装，如缺失可:
 *   apt install libnotify-bin / yum install libnotify
 */

import { spawn, execSync } from "node:child_process"

/** 窗口匹配标题列表（按优先级） */
const TITLE_PATTERNS = ["OC", "OpenCode"]

/**
 * 在 X11 下激活匹配标题的窗口
 * 使用 xdotool 搜索并聚焦窗口
 */
function x11Activate(titlePatterns: string[]): boolean {
  for (const pattern of titlePatterns) {
    const wid = execSync(
      `xdotool search --name '${pattern}' 2>/dev/null | grep -v mutter-x11-frames | tail -1`,
      { encoding: "utf-8", timeout: 3000 },
    ).trim()
    if (wid) {
      execSync(`xdotool windowactivate ${wid} 2>/dev/null`, { timeout: 3000 })
      return true
    }
  }

  // 回退：按常见终端类名匹配
  for (const cls of ["Terminator", "gnome-terminal", "kitty", "alacritty", "foot"]) {
    const wid = execSync(
      `xdotool search --onlyvisible --class ${cls} 2>/dev/null | head -1`,
      { encoding: "utf-8", timeout: 3000 },
    ).trim()
    if (wid) {
      execSync(`xdotool windowactivate ${wid} 2>/dev/null`, { timeout: 3000 })
      return true
    }
  }
  return false
}

/**
 * 在 Wayland GNOME 下激活窗口
 * 通过 GNOME Shell Eval 方法聚焦匹配标题的窗口
 */
function waylandGnomeActivate(titlePatterns: string[]): boolean {
  const pattern = titlePatterns[0]
  const script = `
const actors = global.get_window_actors();
for (let a of actors) {
  let mw = a.meta_window;
  if (mw && mw.get_title().includes('${pattern}')) {
    mw.activate(global.get_current_time());
    break;
  }
}
`
  try {
    const result = execSync(
      `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval ${JSON.stringify(script)}`,
      { encoding: "utf-8", timeout: 3000 },
    ).trim()
    return result.startsWith("(true,")
  } catch {
    return false
  }
}

/**
 * 在 Wayland KDE 下激活窗口
 * 通过 KWin DBus 接口聚焦匹配标题的窗口
 */
function waylandKdeActivate(titlePatterns: string[]): boolean {
  for (const pattern of titlePatterns) {
    try {
      execSync(
        `qdbus org.kde.KWin /KWin activateWindow $(qdbus org.kde.KWin /KWin getWindows 2>/dev/null | grep -i ${JSON.stringify(pattern)} | head -1)`,
        { encoding: "utf-8", timeout: 3000 },
      )
      return true
    } catch {
      continue
    }
  }
  return false
}

/**
 * 在 wlroots 系合成器（Sway / Hyprland）下激活窗口
 */
function waylandWlrootsActivate(titlePatterns: string[]): boolean {
  // Sway: swaymsg [title="OC"] focus
  if (process.env.SWAYSOCK) {
    for (const pattern of titlePatterns) {
      try {
        execSync(
          `swaymsg '[title="${pattern}"]' focus 2>/dev/null`,
          { encoding: "utf-8", timeout: 3000 },
        )
        return true
      } catch { continue }
    }
  }

  // Hyprland: hyprctl dispatch focuswindow title:OC
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    for (const pattern of titlePatterns) {
      try {
        execSync(
          `hyprctl dispatch focuswindow title:${pattern} 2>/dev/null`,
          { encoding: "utf-8", timeout: 3000 },
        )
        return true
      } catch { continue }
    }
  }

  return false
}

/**
 * 按当前环境激活 opencode TUI 窗口
 */
function focusOpencodeWindow(): void {
  const sessionType = process.env.XDG_SESSION_TYPE ?? ""
  const desktopEnv = (process.env.XDG_CURRENT_DESKTOP ?? "").toLowerCase()

  // Wayland
  if (sessionType === "wayland") {
    // GNOME
    if (desktopEnv.includes("gnome")) {
      if (waylandGnomeActivate(TITLE_PATTERNS)) return
    }
    // KDE
    if (desktopEnv.includes("kde") || desktopEnv.includes("plasma")) {
      if (waylandKdeActivate(TITLE_PATTERNS)) return
    }
    // wlroots (Sway / Hyprland)
    if (waylandWlrootsActivate(TITLE_PATTERNS)) return
    // Wayland 下无匹配 → 静默
    return
  }

  // X11（含 XWayland）
  x11Activate(TITLE_PATTERNS)
}

export async function notify(title: string, body: string): Promise<void> {
  try {
    // 异步 spawn + --action 实现点击交互
    // --action 隐含 --wait，子进程驻留直到用户交互或通知超时
    // 用户点击通知体 → 收到 "default" action → 聚焦 Terminator
    const proc = spawn("notify-send", [
      "--action", "default=打开",
      "--expire-time", "10000",
      title, body,
    ], {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    })

    // 收集用户交互结果
    let output = ""
    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })

    // 用户点击通知 → 聚焦 opencode TUI 窗口
    proc.on("close", () => {
      if (output.trim() === "default") {
        try {
          focusOpencodeWindow()
        } catch {
          // 聚焦失败不影响主流程
        }
      }
    })

    // 分离子进程，不阻塞主流程
    proc.unref()
  } catch {
    // Linux 系统通知失败不影响主流程
  }
}
