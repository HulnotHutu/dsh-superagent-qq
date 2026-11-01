# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## QQ Source (OneBot v11)

This repository adds a QQ Source to upstream dsh-superagent: messages in configured QQ groups, received through the [OneBot v11](https://github.com/botuniverse/onebot-11) protocol, become Triggers like any other Source's, and replies go back to the group. It ships `napq`, a small dependency-free Python CLI in [napq/](napq/README.md) that translates between a local OneBot v11 HTTP endpoint (such as [NapCat](https://napneko.github.io/)) and the CLI contract the host expects. [docs/009-qq-source.md](docs/009-qq-source.md) walks through the whole implementation step by step.

中文：本仓库在上游 [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype) 基础上新增了 QQ 来源——所配置 QQ 群里经 OneBot v11 协议收到的消息会像其他来源一样变成触发，回复直接发回群里。它自带零依赖的 Python 命令行工具 `napq`（见 [napq/README.md](napq/README.md)），负责在本地 OneBot v11 HTTP 接口（如 NapCat）和宿主期望的 CLI 约定之间传话。实现细节见 [docs/009-qq-source.md](docs/009-qq-source.md)。

**Differences from upstream**: the only functional addition is the QQ Source — `src/sources/qq.ts`, the `qq-watch` plugin entry, the `napq` CLI, and its documentation ([009](docs/009-qq-source.md)), plus a CI workflow. Everything else tracks upstream; rebase onto upstream releases to pick up their changes.

> **Disclaimer / 免责声明.** This project is not affiliated with or endorsed by Tencent. QQ is a product of Tencent; connecting to it through third-party OneBot v11 client implementations may violate Tencent's terms of service and can lead to account restrictions. Use at your own risk. This repository distributes no QQ client and contains no Tencent code.
>
> 本项目与腾讯公司无关联、未获其认可。QQ 是腾讯公司的产品；通过第三方 OneBot v11 客户端实现连接 QQ 可能违反腾讯的用户协议并导致账号受限，风险自负。本项目不分发、也不包含任何 QQ 客户端或腾讯专有代码。

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 QQ Source](docs/009-qq-source.md): the repository's QQ Source, step by step

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
