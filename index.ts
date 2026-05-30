import type { Plugin } from "@opencode-ai/plugin"
import type { PluginConfig } from "./config.js"
import { resolveConfig, loadYamlConfig, mergeConfig } from "./config.js"
import { route } from "./events.js"
import { Dispatcher } from "./dispatcher.js"
import { FileStore } from "./store.js"
import { SystemSender } from "./senders/system.js"
import { CustomWebhookSender } from "./senders/custom-webhook.js"
import { WechatWorkSender } from "./senders/wechat-work.js"
import { FeishuSender } from "./senders/feishu.js"
import { writeFileSync, mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const LOG_DIR = join(homedir(), ".opencode-notify")
const LOG_FILE = join(LOG_DIR, "plugin.log")

function log(msg: string) {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
    writeFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, { flag: "a" })
  } catch {
    // 日志写入失败不影响主流程
  }
}

// 用户活跃事件类型
const USER_ACTIVITY_EVENTS = new Set([
  "message.updated",
  "permission.replied",
  "question.replied",
  "command.executed",
  "tui.command.execute",
])

const plugin: Plugin = async (_input, options) => {
  // 加载 YAML 配置 + 合并 plugin options
  const yamlCfg = loadYamlConfig() ?? {}
  const merged = mergeConfig(yamlCfg, options as PluginConfig ?? {})
  const cfg = resolveConfig(merged)
  const store = new FileStore()
  const senders = buildSenders(cfg)
  const dispatcher = new Dispatcher(store, cfg.dedupe_seconds ?? 60, senders)
  // 用户活跃追踪
  let lastActivity = Date.now()
  const suppressActive = cfg.suppress_when_active ?? true
  const activityTimeout = cfg.activity_timeout_ms ?? 30_000

  log(`插件已加载, 配置: events=${JSON.stringify(cfg.events)}, suppressActive=${suppressActive}, timeout=${activityTimeout}ms`)

  return {
    // event 总线 — 所有事件通过此钩子
    event: async ({ event }) => {
      const { type, properties } = event as any
      const propKeys = properties ? Object.keys(properties).join(",") : ""

      // 调试日志：记录所有事件（随时可关闭）
      log(`[event] type=${type} keys=${propKeys}`)

      // 用户活跃事件追踪
      if (USER_ACTIVITY_EVENTS.has(type)) {
        lastActivity = Date.now()
        log(`→ 用户活跃事件, 重置活跃时间`)
      }

      // 活跃抑制检查
      if (suppressActive) {
        const idleMs = Date.now() - lastActivity
        if (idleMs < activityTimeout) {
          // 用户活跃中，跳过通知
          return
        }
      }

      const msg = route(event, cfg.events)
      if (msg) {
        log(`→ 匹配通知: ${msg.event}`)
        await dispatcher.dispatch(msg)
      }
    },
  }
}

function buildSenders(cfg: PluginConfig) {
  const senders: import("./senders/types.js").Sender[] = []
  if (cfg.channels?.system?.enabled) {
    senders.push(new SystemSender())
    log("系统通知渠道已启用")
  }
  if (cfg.channels?.custom_webhook?.enabled && cfg.channels.custom_webhook.url) {
    senders.push(new CustomWebhookSender(cfg.channels.custom_webhook))
    log("自定义 Webhook 渠道已启用")
  }
  if (cfg.channels?.wechat_work?.enabled && cfg.channels.wechat_work.webhook_url) {
    senders.push(new WechatWorkSender(cfg.channels.wechat_work))
    log("企业微信渠道已启用")
  }
  if (cfg.channels?.feishu?.enabled && cfg.channels.feishu.webhook_url) {
    senders.push(new FeishuSender(cfg.channels.feishu))
    log("飞书渠道已启用")
  }
  return senders
}

export default plugin
