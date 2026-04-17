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

当前仓库已经具备：

- 可运行的 TypeScript 脚手架
- 基本的仓库维护基础设施
- 适合长期维护的基础结构

运行时功能仍在逐步实现，后续开发以本机上的产品和系统设计基线为准。

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

## 飞书中使用 Codex

当前已经验证通过的主链路是：`飞书 -> Codex -> 自动完成通知`。

在飞书里发起一个真实 `Codex` 任务，请使用：

```text
/dev /codex /project pocket-agent-hub <任务描述>
```

手动查询最近一次任务状态，请使用：

```text
/dev /codex /project pocket-agent-hub 查看当前项目状态
```

当前行为是：

- 第一条消息会在本机后台启动真实 `codex exec`
- 飞书会立即返回 `started task` 和本次运行编号
- 任务运行过程中你可以手动查询状态
- 任务完成或失败后，飞书会自动回推结果
- 同一飞书会话中的后续消息默认会续接当前活跃 session
- `/current` 可查看当前对话绑定的活跃 session
- `/reset` 可清空当前对话绑定的活跃 session
- `/new` 可强制下一次请求从新 session 开始，而不复用当前上下文

更完整的中文操作说明保留在本机 `docs/feishu-codex-guide.md`。

## 致谢

本项目在设计上参考并吸收了以下仓库的思路，再结合“单人、单机、长期在线工作站”的目标做了重新实现：

- [`claude-to-im-plus`](https://github.com/JiangJingC/claude-to-im-plus)：提供了 daemon bridge 与移动端持久接入的整体思路
- [`cc-connect`](https://github.com/chenhg5/cc-connect)：提供了显式会话控制、会话隔离思路，以及更贴近 IM 使用方式的产品细节
- [`Claude-to-IM-skill`](https://github.com/op7418/Claude-to-IM-skill)：提供了较早期的桥接工作流参考，帮助明确通道与智能体集成方向

## 许可证

本项目使用 MIT License，详见 [LICENSE](./LICENSE)。
