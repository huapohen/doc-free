# 2026-09-06 发布与提交记录

编写时间：`2026-09-06T02:55:02+08:00`（Asia/Shanghai）。本记录将代码、文档和验证的真实提交关联起来，不替代各篇文档的能力边界。

## 已发布位置

- [Active Agent](https://github.com/huapohen/active-agent/tree/evolve)：公开仓库，默认分支 evolve，main 保留清理后的 0.1 基线。
- [Doc Free](https://github.com/huapohen/doc-free/tree/evolve)：升级在 evolve，main 未合并。

## 提交、时间和描述

| 仓库 | Commit | 提交时间 | 描述 |
|---|---|---|---|
| active-agent | [`8952acd`](https://github.com/huapohen/active-agent/commit/8952acdb87d9969a996112a3fc8c6c5a20653620) | `2026-09-06T01:58:13+08:00` | chore: import sanitized Active Agent 0.1 prototype |
| active-agent | [`c05f904`](https://github.com/huapohen/active-agent/commit/c05f904f0ec11d680d5527e37519e1836ccba0af) | `2026-09-06T02:41:10+08:00` | feat: evolve proactive agents around visible collaborative documents |
| active-agent | [`ed90dad`](https://github.com/huapohen/active-agent/commit/ed90dad6e728a8eea05e304f9d22353a6cafe48d) | `2026-09-06T02:51:19+08:00` | docs: publish dated evolve architecture, evidence and roadmap |
| doc-free | [`3e943c8`](https://github.com/huapohen/doc-free/commit/3e943c865b9285fd82a2bb0e6010ee38d57c8d27) | `2026-09-03T16:07:32+08:00` | docs: version freedom P0 P1 release boundary |
| doc-free | [`f5c3b6f`](https://github.com/huapohen/doc-free/commit/f5c3b6f0cdbf03b74895d6e3884154578b8ceb3f) | `2026-09-06T02:41:11+08:00` | feat: add document-native workspace for proactive agent collaboration |
| doc-free | [`b182142`](https://github.com/huapohen/doc-free/commit/b1821427742b2b15f0f988afc9d569bf47ba3352) | `2026-09-06T02:42:03+08:00` | style: format collaboration sources for contributors |
| doc-free | [`ad22175`](https://github.com/huapohen/doc-free/commit/ad2217587012a22e36fc1de2e9af80bcc6bbdb29) | `2026-09-06T02:51:19+08:00` | docs: record evolve integration contract and validation boundaries |

## 已通过的远端验证

- [Active Agent CI](https://github.com/huapohen/active-agent/actions/runs/33985379391)：文档提交 ed90dad，Python 3.9 / 3.13 两个 job 均成功，含单元测试与凭据检查。
- [Doc Free CI](https://github.com/huapohen/doc-free/actions/runs/33985392320)：文档提交 ad22175，Node 构建及真实文档协作集成测试成功。

本机 22 项 Python 测试、12 项文档服务集成测试通过；真实 gpt-6-astra / medium 提案已在浏览器接受，来源 r1 → r2。细节和限制见验证文档。

运行配置、模型凭据、workspace token、数据库和浏览器会话均未发布。没有 IM 集成或生产部署。

本发布记录后续提交自身的 SHA 可在 GitHub History 或 `git log -1 -- docs/evolve/2026-09-06/PUBLICATION.md` 获取，避免在文件内制造自身 hash 的循环引用。
