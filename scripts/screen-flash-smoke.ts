#!/usr/bin/env bun
/**
 * 屏幕跑马灯冒烟测试（不依赖网络/opencode/显示器）：
 *   1. resolveEnv：Wayland 会话下强制 GDK_BACKEND=x11（XWayland 覆盖层才可见）
 *   2. resolveEnv：已有 GDK_BACKEND / 纯 X11 会话 / 无 DISPLAY 时不乱改
 *   3. 跑马灯脚本存在且可被 python3 解析（语法自检）
 *
 * 运行：bun scripts/screen-flash-smoke.ts
 */
import { existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { resolveEnv } from "../senders/screen-flash/linux.js"
import { configureLog } from "../log.js"

configureLog("off")

let failures = 0
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✅ ${label}`)
  else { failures++; console.log(`  ❌ ${label}`) }
}

console.log("\n▶ resolveEnv：显示后端选择")
{
  // Wayland + XWayland → 强制 x11（GTK3 Wayland 后端画不出覆盖层）
  const wayland = resolveEnv({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" })
  assert(wayland.GDK_BACKEND === "x11", "Wayland + DISPLAY → GDK_BACKEND=x11")

  // 用户已显式指定后端 → 不覆盖
  const explicit = resolveEnv({ WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0", GDK_BACKEND: "wayland" })
  assert(explicit.GDK_BACKEND === "wayland", "已显式设置 GDK_BACKEND → 不覆盖")

  // 纯 X11 会话 → 不动（GTK 默认就是 x11）
  const x11 = resolveEnv({ DISPLAY: ":0" })
  assert(x11.GDK_BACKEND === undefined, "纯 X11 会话 → 不设置 GDK_BACKEND")

  // Wayland 但无 XWayland → 不设置（无 X 服务可用，脚本无法显示）
  const noX = resolveEnv({ WAYLAND_DISPLAY: "wayland-0" })
  assert(noX.GDK_BACKEND === undefined, "Wayland 无 DISPLAY → 不设置 GDK_BACKEND")

  // 不修改传入对象
  const src: NodeJS.ProcessEnv = { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }
  resolveEnv(src)
  assert(src.GDK_BACKEND === undefined, "不污染传入的环境对象")
}

console.log("\n▶ 跑马灯脚本")
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..")
  const script = join(root, "scripts", "linux-marquee.py")
  assert(existsSync(script), "scripts/linux-marquee.py 存在")

  // 用 compile() 在内存里做语法自检（-m py_compile 会写 __pycache__ 污染仓库）
  const src = readFileSync(script, "utf-8")
  const py = spawnSync(
    "python3",
    ["-c", "import sys; compile(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1], 'exec')", script],
    { encoding: "utf-8" },
  )
  assert(py.status === 0, `python3 语法自检通过${py.status === 0 ? "" : "：" + (py.stderr || "").trim()}`)

  // Wayland 无 primary monitor 的回退逻辑必须在（否则脚本直接 AttributeError 崩掉）
  assert(src.includes("get_primary_monitor()"), "脚本探测 primary monitor")
  assert(
    /get_primary_monitor\(\)[\s\S]{0,200}get_monitor\(0\)/.test(src),
    "primary monitor 为 None 时回退到 get_monitor(0)",
  )
}

console.log("\n" + "═".repeat(56))
if (failures === 0) {
  console.log("✅ 全部通过")
  process.exit(0)
}
console.log(`❌ ${failures} 项失败`)
process.exit(1)
