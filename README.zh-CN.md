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

## 飞书本地配置

仓库现在支持一层私有本地覆盖配置：

- 可提交模板：`config/app.config.local.example.json`
- 本机私有文件：`config/app.config.local.json`

推荐操作：

```bash
cp config/app.config.local.example.json config/app.config.local.json
```

然后编辑 `config/app.config.local.json`，至少填这三项：

- `channels.feishu.appId`
- `channels.feishu.appSecret`
- `channels.feishu.verificationToken`

本地启动命令：

```bash
npm run dev:local
```

默认监听地址：

- `http://0.0.0.0:8787/feishu/events`
- `http://127.0.0.1:8787/healthz`

真机联调要注意：

- 飞书事件订阅必须回调到公网 `HTTPS` 地址
- 这台机器当前只有本地/LAN 地址，所以若要让飞书真正打回调，还需要隧道或公网反向代理
- `config/app.config.local.json` 已加入 `.gitignore`，不会被推送到 GitHub

## 许可证

本项目使用 MIT License，详见 [LICENSE](./LICENSE)。
