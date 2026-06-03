#!/usr/bin/env bun
/**
 * opencode-notify 诊断与调试 CLI
 *
 * 用法:
 *   bun cli.ts check              检查配置文件的正确性
 *   bun cli.ts test                测试所有已启用的通知渠道
 *   bun cli.ts test <channel>      测试指定渠道 (system|wechat_work|feishu|custom_webhook)
 *   bun cli.ts log [lines]         查看最近 N 行插件日志 (默认 20)
 *   bun cli.ts info                显示插件版本、配置、渠道状态等综合信息
 *   bun cli.ts help                显示帮助
 */

import { loadYamlConfig, resolveConfig, mergeConfig } from "./config.js"
import type { PluginConfig, ChannelsConfig } from "./config.js"
import type { Message } from "./message.js"
import { SystemSender } from "./senders/system/index.js"
import { CustomWebhookSender } from "./senders/custom-webhook.js"
import { WechatWorkSender } from "./senders/wechat-work.js"
import { FeishuSender } from "./senders/feishu.js"
import { readFileSync, existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ─── 常量 ───────────────────────────────────────────────────────────────────

const PKG = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf-8"))
const DEFAULT_LOG_FILE = join(homedir(), ".opencode-notify", "plugin.log")
const YAML_PATH = join(homedir(), ".config", "opencode", "opencode-notify.yaml")

/** 读取有效日志文件路径（优先从配置中读取） */
function getLogFile(): string {
  const yamlCfg = loadYamlConfig()
  return yamlCfg?.log?.file ?? DEFAULT_LOG_FILE
}

const SAMPLE_MSG: Message = {
  agent: "opencode",
  event: "permission_required",
  sessionID: "diagnose-test",
  title: "opencode - 诊断测试",
  body: "这是一条来自诊断工具的测试通知，如果收到说明渠道配置正确",
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0] ?? "help"

  switch (cmd) {
    case "check":
      cmdCheck()
      break
    case "test":
      await cmdTest(args[1])
      break
    case "log":
      cmdLog(args[1] ? parseInt(args[1], 10) : 20)
      break
    case "info":
      cmdInfo()
      break
    case "help":
    default:
      cmdHelp()
      break
  }
}

// ─── 命令: check ─────────────────────────────────────────────────────────────

function cmdCheck() {
  console.log("═".repeat(50))
  console.log("  🔍 配置检查")
  console.log("═".repeat(50))

  // 1. 检查配置文件是否存在
  if (!existsSync(YAML_PATH)) {
    console.log(`\n❌ 配置文件不存在: ${YAML_PATH}`)
    console.log("   请创建 ~/.config/opencode/opencode-notify.yaml 配置文件")
    process.exit(1)
  }
  console.log(`\n✅ 配置文件: ${YAML_PATH}`)

  // 2. 尝试解析 YAML
  let yamlCfg: PluginConfig | null = null
  try {
    yamlCfg = loadYamlConfig()
    console.log("✅ YAML 解析成功")
  } catch (e: any) {
    console.log(`\n❌ YAML 解析失败: ${e.message}`)
    process.exit(1)
  }
  if (!yamlCfg) {
    console.log("\n❌ YAML 解析返回空")
    process.exit(1)
  }

  // 3. resolveConfig 合并
  const cfg = resolveConfig(mergeConfig(yamlCfg, {}))

  // 4. 检查渠道配置
  const channels = cfg.channels ?? {}
  let hasError = false

  for (const [name, ch] of Object.entries(channels)) {
    if (!ch || !ch.mode || ch.mode === "none") continue

    switch (name) {
      case "system":
        console.log(`\n✅ 系统通知: 已启用`)
        break
      case "custom_webhook": {
        const c = ch as any
        if (!c.url) {
          console.log(`\n❌ 自定义 Webhook: 已启用但未配置 url`)
          hasError = true
        } else {
          console.log(`\n✅ 自定义 Webhook: url=${c.url}`)
        }
        break
      }
      case "wechat_work": {
        const c = ch as any
        if (!c.webhook_url) {
          console.log(`\n❌ 企业微信: 已启用但未配置 webhook_url`)
          hasError = true
        } else {
          console.log(`\n✅ 企业微信: webhook_url=${c.webhook_url.slice(0, 60)}...`)
        }
        break
      }
      case "feishu": {
        const c = ch as any
        if (!c.webhook_url) {
          console.log(`\n❌ 飞书: 已启用但未配置 webhook_url`)
          hasError = true
        } else {
          console.log(`\n✅ 飞书: webhook_url=${c.webhook_url.slice(0, 60)}...`)
        }
        break
      }
    }
  }

  // 5. 检查订阅事件
  const events = cfg.events ?? []
  console.log(`\n📋 订阅事件: ${events.length > 0 ? events.join(", ") : "(无)"}`)

  // 6. 检查活跃抑制
  console.log(`\n🔇 活跃抑制: ${cfg.suppress_when_active ? "开启" : "关闭"} (超时 ${cfg.activity_timeout ?? 60}秒)`)

  // 6.5 日志配置
  console.log(`\n📝 日志: 等级=${cfg.log?.level ?? "info"} 文件=${getLogFile()}`)

  // 7. 检查去重
  console.log(`\n🔄 去重窗口: ${cfg.dedupe_seconds} 秒`)

  if (hasError) {
    console.log(`\n⚠️  检查完成，存在配置错误，请修正后重试`)
    process.exit(1)
  }
  console.log(`\n✅ 配置检查通过！`)
}

// ─── 命令: test ──────────────────────────────────────────────────────────────

async function cmdTest(channel?: string) {
  const yamlCfg = loadYamlConfig() ?? {}
  const cfg = resolveConfig(mergeConfig(yamlCfg, {}))
  const channels = cfg.channels ?? {}
  const allChannels: [string, boolean, () => Promise<void>][] = []

  // 收集要测试的渠道
  function add(name: string, enabled: boolean, sender: () => Promise<void>) {
    allChannels.push([name, enabled, sender])
  }

  const modeOk = (m: string | undefined): boolean => m !== undefined && m !== "none"

  add("system_message", modeOk(channels.system_message?.mode), async () => {
    await new SystemSender().send(SAMPLE_MSG)
  })

  if (modeOk(channels.custom_webhook?.mode) && channels.custom_webhook?.url) {
    add("custom_webhook", true, async () => {
      await new CustomWebhookSender(channels.custom_webhook!).send(SAMPLE_MSG)
    })
  }

  if (modeOk(channels.wechat_work?.mode) && channels.wechat_work?.webhook_url) {
    add("wechat_work", true, async () => {
      await new WechatWorkSender(channels.wechat_work!).send(SAMPLE_MSG)
    })
  }

  if (modeOk(channels.feishu?.mode) && channels.feishu?.webhook_url) {
    add("feishu", true, async () => {
      await new FeishuSender(channels.feishu!).send(SAMPLE_MSG)
    })
  }

  // 过滤
  const targets = channel
    ? allChannels.filter(([n]) => n === channel)
    : allChannels

  if (targets.length === 0) {
    console.log(`没有匹配的渠道。${channel ? `渠道 "${channel}" 不存在或未启用。` : "请在配置文件中启用至少一个渠道。"}`)
    console.log("可用渠道: system, custom_webhook, wechat_work, feishu")
    process.exit(1)
  }

  console.log(`开始测试 ${targets.length} 个渠道...\n`)

  for (const [name, enabled, send] of targets) {
    process.stdout.write(`  ${enabled ? "▶" : "⏭"} ${name} ... `)
    try {
      await send()
      console.log("✅ 成功")
    } catch (e: any) {
      console.log(`❌ 失败: ${e.message}`)
    }
  }

  console.log("\n测试完成。")
}

// ─── 命令: log ───────────────────────────────────────────────────────────────

function cmdLog(lines: number) {
  const logFile = getLogFile()
  if (!existsSync(logFile)) {
    console.log(`日志文件不存在: ${logFile}`)
    console.log("插件尚未运行过，或日志已被清理。")
    process.exit(1)
  }

  const stat = statSync(logFile)
  const all = readFileSync(logFile, "utf-8").trimEnd()
  const entries = all.split("\n")

  console.log(`📄 ${logFile} (${(stat.size / 1024).toFixed(1)} KB, ${entries.length} 行)\n`)

  const tail = entries.slice(-lines)
  for (const line of tail) {
    // 着色: 错误行标红，成功行标绿
    if (line.includes("失败") || line.includes("error") || line.includes("Error")) {
      console.log(`  ${line}`)
    } else if (line.includes("成功") || line.includes("✅")) {
      console.log(`  ${line}`)
    } else {
      console.log(`  ${line}`)
    }
  }

  if (entries.length > lines) {
    console.log(`\n... 共 ${entries.length} 行，显示最后 ${lines} 行`)
  }
}

// ─── 命令: info ──────────────────────────────────────────────────────────────

function cmdInfo() {
  console.log("═".repeat(50))
  console.log("  📋 opencode-notify 插件信息")
  console.log("═".repeat(50))

  // 版本
  console.log(`\n  📦 版本:       ${PKG.version}`)
  console.log(`  📂 项目路径:   ${import.meta.dirname}`)

  // 配置文件
  console.log(`\n  📄 配置文件:`)
  if (existsSync(YAML_PATH)) {
    const stat = statSync(YAML_PATH)
    console.log(`     路径: ${YAML_PATH}`)
    console.log(`     大小: ${(stat.size / 1024).toFixed(1)} KB`)
  } else {
    console.log(`     路径: ${YAML_PATH} (不存在，使用默认配置)`)
  }

  // 日志文件
  const logFile = getLogFile()
  console.log(`\n  📝 日志文件:`)
  if (existsSync(logFile)) {
    const stat = statSync(logFile)
    const lines = readFileSync(logFile, "utf-8").split("\n").length
    const recent = readFileSync(logFile, "utf-8").trimEnd().split("\n").slice(-1)[0] ?? ""
    console.log(`     路径: ${logFile}`)
    console.log(`     大小: ${(stat.size / 1024).toFixed(1)} KB, ${lines} 行`)
    console.log(`     最新: ${recent}`)
  } else {
    console.log(`     路径: ${logFile} (暂无日志)`)
  }

  // 配置详情
  const yamlCfg = loadYamlConfig()
  const cfg = yamlCfg ? resolveConfig(mergeConfig(yamlCfg, {})) : null

  if (cfg) {
    const ch = cfg.channels ?? {}

    console.log(`\n  🔔 通知渠道:`)
    const channelNames: [string, any, string][] = [
      ["系统消息", ch.system_message, ""],
      ["屏幕跑马灯", ch.screen_flash, ch.screen_flash?.mode !== "none" ? `强度${ch.screen_flash?.intensity ?? 0.9}` : ""],
      ["自定义 Webhook", ch.custom_webhook, ch.custom_webhook?.url ?? ""],
      ["企业微信", ch.wechat_work, ch.wechat_work?.webhook_url ? `${ch.wechat_work.webhook_url.slice(0, 40)}...` : ""],
      ["飞书", ch.feishu, ch.feishu?.webhook_url ? `${ch.feishu.webhook_url.slice(0, 40)}...` : ""],
    ]
    for (const [label, config, url] of channelNames) {
      if (config?.mode !== "none") {
        const urlInfo = url ? ` ${url}` : ""
        console.log(`     ✅ ${label}${urlInfo}`)
      } else {
        console.log(`     ⏸  ${label} (未启用)`)
      }
    }

    console.log(`\n  📋 订阅事件:   ${cfg.events?.join(", ") ?? "(无)"}`)
    console.log(`  🔇 活跃抑制:   ${cfg.suppress_when_active ? "开启" : "关闭"}`)
    console.log(`  📝 日志等级:   ${cfg.log?.level ?? "info"}`)
    console.log(`  ⏱  去重窗口:   ${cfg.dedupe_seconds} 秒`)
  } else {
    console.log(`\n  ⚠️  未加载到配置`)
  }

  console.log(`\n  🔧 诊断命令:`)
  console.log(`     bun cli.ts check      检查配置`)
  console.log(`     bun cli.ts test       测试所有渠道`)
  console.log(`     bun cli.ts log        查看日志`)
}

// ─── 命令: help ──────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log("opencode-notify 诊断工具")
  console.log("")
  console.log("用法:")
  console.log("  bun cli.ts check              检查配置文件")
  console.log("  bun cli.ts test                测试所有通知渠道")
  console.log("  bun cli.ts test <channel>      测试指定渠道")
  console.log("  bun cli.ts log [lines]         查看插件日志 (默认 20 行)")
  console.log("  bun cli.ts info                显示插件综合信息")
  console.log("  bun cli.ts help                显示此帮助")
  console.log("")
  console.log("渠道名称:")
  console.log("  system          系统通知")
  console.log("  wechat_work     企业微信")
  console.log("  feishu          飞书")
  console.log("  custom_webhook  自定义 Webhook")
  console.log("")
  console.log("示例:")
  console.log("  bun cli.ts check")
  console.log("  bun cli.ts test wechat_work")
  console.log("  bun cli.ts test feishu")
  console.log("  bun cli.ts log 50")
  console.log("  bun cli.ts info")
}

// ─── 启动 ────────────────────────────────────────────────────────────────────

main().catch((e) => {
  console.error("诊断工具执行出错:", e.message)
  process.exit(1)
})
