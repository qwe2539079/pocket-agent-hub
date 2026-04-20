# Pocket Agent Hub

[English](./README.md)

Pocket Agent Hub 是一个面向常驻 Ubuntu 主力机的本地优先控制平面。它通过手机聊天通道暴露编码智能体与日常助手能力，而不是依赖远程桌面工具。

## 项目目标

这个项目服务的是一个非常明确的工作流：

- 主力 Ubuntu 工作站长期在线
- 真正的开发工作在本机完成，工具包括 `Codex`、`Claude Code`，后续还会引入 `Gemini`
- 用户经常离开工位，需要用手机继续、重定向、检查当前任务
- 手机应该是自然的聊天入口，而不是远程桌面界面

本项目参考了以下仓库：

- [`claude-to-im-plus`](https://github.com/JiangJingC/claude-to-im-plus)
- [`cc-connect`](https://github.com/chenhg5/cc-connect)
- [`Claude-to-IM-skill`](https://github.com/op7418/Claude-to-IM-skill)

但它不是这些仓库的直接分支。这个仓库面向的是一台长期在线的个人工作站，以及两个手机入口：`飞书` 和个人 `微信`。

## 当前状态

- 运行时基础、飞书主通道、三个智能体适配（Codex / Claude / Gemini，全部基于共享的 `RunAdapter` 基类）都已在工作站上打通并可真实使用。
- 个人微信通道仍是占位实现，尚未接入真实网关。
- 后续工作主要集中在通知体验、易用性与文档，而不再是核心骨架。

## 工作模型

产品分成两个 persona：

- `dev-control`：用于继续真实开发任务的高风险控制模式
- `daily-assistant`：用于聊天、总结、写作、研究的低风险助手模式

架构分成五层：

- `channels/`：飞书与微信的传输适配层
- `core/`：统一消息、会话、路由、任务状态
- `agents/`：Codex、Claude Code、Gemini 适配层
- `policies/`：权限边界、审批规则、动作限制
- `storage/`：本地持久化层

## 仓库结构

```text
.github/
config/
src/
tests/
```

## 文档策略

- `README.md` 默认使用英文
- 中文入口在 [README.zh-CN.md](./README.zh-CN.md)
- 详细规划与本地说明文档保留在工作站本地，不再将 `docs/` 目录纳入远端仓库

## 本地开发

```bash
npm install
npm run check
npm test
npm run dev
```

## 飞书传输策略

飞书通道现在支持两种传输模式：

- `websocket`：主模式，对齐你给的参考仓库所采用的长连接路线
- `webhook`：回退模式，仅在你明确暴露公网回调地址时使用

现在默认示例配置已经切到 `websocket`，也就是由这台工作站主动向外建立连接，而不是等飞书从公网反向回调进来。

## 飞书本地配置

仓库支持一层私有本地覆盖配置：

- 可提交模板：`config/app.config.local.example.json`
- 本机私有文件：`config/app.config.local.json`

推荐操作：

```bash
cp config/app.config.local.example.json config/app.config.local.json
```

然后编辑 `config/app.config.local.json`，至少填：

- `channels.feishu.appId`
- `channels.feishu.appSecret`
- 如有需要，调整 `channels.feishu.websocketUrl`

本地启动命令：

```bash
npm run dev:local
```

如果保持 `mode: "websocket"`，这台主机只需要能主动访问外网。
如果切回 `mode: "webhook"`，则仍然需要公网 `HTTPS` 回调地址。

## 飞书中使用智能体

已验证的主链路是：`飞书 → 智能体 → 自动完成通知`。三个智能体（`/codex`、`/claude`、`/gemini`）共享同一套 run 生命周期。

发起任务：

```text
/dev /codex /project pocket-agent-hub <任务描述>
/dev /claude /project hub <任务描述>
```

手动查询最近一次任务状态：

```text
/dev /codex /project hub 查看当前项目状态
```

飞书文本里可识别的指令：

- persona：`/dev`（dev-control）或 `/daily`（daily-assistant）
- agent：`/codex`、`/claude`、`/gemini`
- project：`/project <id 或 alias>`
- session：`/current`（查看当前 session）、`/reset`（清空 session）、`/new`（下一次强制新开 session）
- 运行历史：`/list`（最近的 run）、`/running`（当前运行中的 run）、`/resume <run-id>`（让下一条消息从该 run 的回复继续）
- 桌面接管：`/desktop`（列出本机上的原生会话）、`/takeover <session-id>`（把某个桌面会话接管到当前手机对话；接管前请先在桌面终端关闭该会话，避免两端同时写同一份会话日志。当前仅支持 Claude）

不带指令的消息会默认续接当前会话的最新 session。

项目别名与按 persona 的沙箱策略在配置里声明，详见下节。

更完整的中文操作说明保留在本机 `docs/feishu-codex-guide.md`。

## 关键配置项

- `projects[].aliases?: string[]` —— 项目的短别名，用于 `/project <alias>`。例如给 `pocket-agent-hub` 配 `"aliases": ["hub"]` 后，`/project hub` 即可命中。别名不能与其他项目的 id 或其他别名冲突。
- `personas[].sandboxOverride?: "read-only" | "workspace-write" | "danger-full-access"` —— 会覆盖 agent 自己的 `sandboxMode`。示例配置把 `daily-assistant` 锁成 `read-only`，这样即便被路由到默认 `workspace-write` 的 agent，也不会意外修改项目文件。
- 配置文件的 `extends` 链 —— 任意 config JSON 都可以通过 `"extends": "<相对路径>"` 继承并深度合并上层配置，加载时会检测并拒绝循环引用。

### 运行时环境变量

- `POCKET_AGENT_HUB_SKIP_WARMUP=1` —— 跳过启动时的 warmup 路由，让冒烟和 CI 不消耗真实智能体的 API / 订阅配额。启动日志的其它行照常打印，只是不再有 warmup 回复。

## 致谢

本项目在设计上参考并吸收了以下仓库的思路，再结合“单人、单机、长期在线工作站”的目标做了重新实现：

- [`claude-to-im-plus`](https://github.com/JiangJingC/claude-to-im-plus)：提供了 daemon bridge 与移动端持久接入的整体思路
- [`cc-connect`](https://github.com/chenhg5/cc-connect)：提供了显式会话控制、会话隔离思路，以及更贴近 IM 使用方式的产品细节
- [`Claude-to-IM-skill`](https://github.com/op7418/Claude-to-IM-skill)：提供了较早期的桥接工作流参考，帮助明确通道与智能体集成方向

## 许可证

本项目使用 MIT License，详见 [LICENSE](./LICENSE)。
