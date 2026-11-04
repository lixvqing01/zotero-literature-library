# Literature Library for Zotero

单个 Zotero 插件：MinerU PDF → Markdown、插件内 Qwen 本地向量化或兼容 OpenAI 的 Embeddings API、分层文献查询、知识库管理界面和 MCP。普通用户无需安装 Ollama、Python、Node.js、Docker 或数据库服务。

当前源码为 **0.4.1 测试版**，新增摘要优先、多主题候选集与集内证据检索，并自动清理 MinerU 原始结果压缩包、显示本机缓存占用。新检索链路通过后台 SQLite、MCP 调用和浏览器 Worker 测试，尚未在原生 Zotero/Gecko 中验收；既有版本曾在隔离的 Zotero 10.0.7 / Windows 配置中验证，清单声明 Zotero 8–10，但 8/9 尚未实机验证。测试未修改正式 Zotero 配置或文献库。

[已发布版本](https://github.com/lixvqing01/zotero-literature-library/releases) · [0.4.0 验证说明](docs/0.4.0验证说明.md) · [Agent 使用说明](docs/Agent使用说明.md)

## 安装与首次配置

1. 从 [GitHub Releases](https://github.com/lixvqing01/zotero-literature-library/releases) 下载已发布的 `.xpi`。在 Zotero 的“工具 → 插件”中，选择齿轮菜单“从文件安装插件”，打开下载的安装包，按 Zotero 提示重启。当前开发构建产物位于 `dist/literature-library-0.4.1.xpi`。
2. 在“工具 → 插件”的 Literature Library 卡片点击“打开知识库 / MinerU 设置”。也可以从“设置 → Literature Library”或“工具 → Literature Library”进入，条目右键菜单有“查看知识库”。
3. 在插件设置页或管理器“设置”中输入 MinerU Key。可填写 Key **生成日期**或实际到期日期；不填时显示有效期未知。保存日期不会被当作生成日期。Key 存入 Zotero/Gecko 登录凭据存储，界面不回显；安装包不包含用户 Key。
4. 设置页按“PDF 解析 → 向量模型 → Agent 接入”分步配置。MinerU 云解析固定开启，配置有效 Key 后才能解析 PDF；Key 旁悬停提示和链接说明获取方式。解析结果保存在本机。
5. 在“向量模型”选择本地模型或 API。本地默认 Qwen3-Embedding-0.6B Q8（1024 维），也可选 E5-small Q8（384 维）；默认从 ModelScope 下载，可切换 hf-mirror.com / Hugging Face。点击“测试并准备模型”自动下载和推理，显示维度与测试时间。API 模式填写 Base URL、模型名和 Key 后测试连接，无需下载本地模型；文本片段会发送到所配置的服务。
6. 选中文献，右键“加入 Literature Library”。如需自动处理后续新增条目，开启“新加入的条目自动入库”。开启不会立即批量上传全部历史文献，历史条目可手动选择加入。

条目列表的列选择菜单中可启用“知识库”状态列。管理器提供覆盖数量、任务进度、失败原因、搜索、分层详情、更新索引和移除派生索引。搜索条件和结果在刷新、切换页面后保留；全选只选择当前页。文献库可按标题、作者、年份、期刊、状态升降序排列，新搜索默认按检索相关度显示。点击命中标题可阅读对应段落，并跳转到 PDF 原页；长全文支持上一段 / 下一段。任务队列支持按标题/错误/阶段搜索、状态筛选、逐项或多选重试、右键操作、删除任务和清理已完成记录；Ctrl/Cmd 多选、Shift 连选及跨页选择会保留。批量重试排除无 PDF、页数或大小超限等任务；需重新提交的任务单独提示。失败或等待凭据/模型的任务可以删除，处理中任务需等待结束。删除失败更新任务会保留之前成功的索引。移除派生索引保留 Zotero 条目与原 PDF；当前版本不会自动清理已下载的派生文件缓存。

## 从旧版本升级

0.4.0 首次启动会把已有派生资料迁移到独立的书目/摘要、文本块、向量表，并逐批持久化；中断后可继续。迁移不重新上传 PDF、不调用 embedding API、不更改 Zotero 原条目。索引和向量原始数据保留，原连接配置可以复用；客户端需刷新 MCP 工具列表以识别新参数和 literature_workspace。

默认 auto 现在只搜索书目与摘要；需要正文证据请显式选择 fulltext。Agent 可先多主题批搜并批读摘要，再用候选 ID 或主题工作区范围精查正文，读取相邻段落并保存证据。GUI「调研主题」可查看筛选理由、来源变化和查询轨迹。摘要缺失不代表文献无关。

安装新 XPI 后，原设置、解析结果和任务保留，文献概览表自动补齐。本版支持切换向量服务和下载源，配置改变后旧向量可能标记为需要更新：选中文献点击管理页“更新索引”，或右键“加入 Literature Library”，可复用未变化 PDF 的 Markdown，仅重新生成向量。不要为更新模型使用右键“重建”——该操作会重新解析 PDF。

纯向量模式只使用与当前版本模型匹配的向量，不混入关键词结果；混合模式使用排名融合，并在文献级结果中合并同一 Zotero 条目的多个 PDF。目标层没有可用向量时，纯向量模式明确报错，混合模式提示并回退关键词，不为一个空索引下载模型。相似度和融合分数不是“回答正确率”。

## 提取、重复入库和错误恢复

- 书目与摘要来自 Zotero，包括期刊、ISSN、卷期页、DOI 等；没有原文摘要则明确标记缺失。
- PDF 使用 MinerU 精准 v4 API，支持 OCR、表格和公式；从结构化内容列表保留 PDF 页号。缺少页号时返回空值，不猜页。
- 依次提供 metadata、abstract、outline、fulltext 和 notes。全文可指定章节、页号及字符范围。
- 按 PDF SHA-256、书目信息、解析配置和模型来源/版本判断更新；未变化则跳过，活动任务不会被重复或强制操作覆盖。
- Key 过期 `A0211` 返回 `MINERU_TOKEN_EXPIRED`，暂停相关任务。无效 `A0202`、HTTP 鉴权失败、网络和限流分别报告。更新 Key 后只恢复因凭据暂停的任务，并继续原阶段，也可在任务队列点击“恢复 / 重试”。
- 90 天到期日期是依据用户提供的生成日期计算的预计值；实际 API 响应是过期判定依据。保存 Key 不会创建收费解析任务。
- 提交结果不确定、上传未完成或云端任务失效时，不会因自动扫描、更新 Key 或批量恢复而重复提交；需检查 MinerU 后，单独点击“检查后重建”。升级后会恢复旧版因关闭上传而暂停的任务。重建失败时保留最后可读版本。
- 新增 PDF/条目由 Zotero Notifier 触发；启动及每 5 分钟补查启用自动索引期间的变化与已入库条目。尚未下载到本机的附件会等待后重试。

## Agent 接入

打开管理器“设置 → Agent 接入”，点击“一键配置 Codex”或“一键配置 Claude Code”，然后重启对应 Agent。同一电脑使用默认配置目录时，每个客户端只需配置一次，其他对话/Agent 复用用户级配置。插件自动启用 MCP，合并专用服务项，并备份原配置为 `.literature-library.bak`；写入失败会尝试恢复原文件。

Codex 默认写入 `~/.codex/config.toml`，Claude Code 默认写入 `~/.claude.json`。自定义配置目录、远程主机或其他客户端（例如 DeepSeek Harness）请点击“复制通用 MCP JSON 配置”，粘贴到其 MCP 设置；客户端须支持 HTTP MCP 和自定义请求头。Qoder、Zcode 暂未实现专用安装器。连接令牌只授予本机插件访问权，与 MinerU Key 不同；连接配置含本地访问令牌，请勿公开。

插件提供 Streamable HTTP，无需单独启动 MCP 服务。默认地址为 `http://127.0.0.1:23119/literature-library/mcp`，以界面显示端口为准。客户端需要支持 HTTP MCP 和 `Authorization: Bearer` 请求头。连接失败先确认 Zotero 正在运行、本地 HTTP 服务未被禁用且插件 MCP 显示已启用。

| 工具 | 用途 |
|---|---|
| `literature_search` | 按书目、摘要或证据段落关键词/语义/混合检索；可筛选文库、年份和期刊 |
| `literature_read` | 按文献身份读取书目、摘要、目录、章节、页或笔记 |
| `literature_index` | 将指定 Zotero 文献加入持久队列 |
| `literature_status` | 紧凑覆盖、队列计数、模型与凭据状态；任务详情用 view=jobs 分页 |
| `literature_workspace` | 保存主题候选、筛选理由、阅读进度、查询轨迹和原文证据 |
| `citation_styles` | 列出 Zotero 已安装 CSL 格式 |
| `citation_render` | 用 Zotero CSL 生成引用/参考文献文本 |
| `citation_prepare` | 为下一次**新增** Zotero 原生 Word/WPS 引用预选文献 |
| `citation_handoff` | 查看/取消待确认引用交接 |

推荐 Agent 约定见 [docs/Agent使用说明.md](docs/Agent使用说明.md)。同样的工具可通过 `/literature-library/api` 调用，POST JSON `{ "tool": "literature_read", "arguments": { "document_id": "…", "layer": "abstract" } }`，鉴权方式相同。

## Word / WPS 引用

`citation_render` 生成普通文本。可更新引用使用 `citation_prepare`：

1. Agent 查询并选择文献，调用 `citation_prepare`。
2. 用户在 Word/WPS 将光标放到**新引用位置**，点击原生 Zotero “Add/Edit Citation”。
3. 插件只为这次空白原生引用窗口填入所选文献，用户确认；由 Zotero 原生集成负责写字段、维护引用与参考文献。
4. 格式由当前文档的 Zotero “Document Preferences”管理，可切换 APA、Vancouver、GB/T 等已安装 CSL。插件不擅自修改整篇文稿的引用风格。

预选请求 10 分钟有效，已有引用编辑不会被覆盖。用户关闭/接受窗口只报告窗口状态，不被宣称为文稿已保存或刷新成功。卸载插件恢复原生引用窗口函数。

**验证边界：原生交接逻辑已通过测试；本机 Office COM 启动未完成，Word 实际写入及 Refresh 尚未完成验证。WPS 依赖其已可工作的 Zotero 集成，也未实机验证。** 不应将这一版当作已经验收的全自动 Word/WPS 引用工具。

## 本地数据与版本边界

插件数据保存在当前 Zotero **配置目录**下的 `literature-library/`：`library.sqlite` 为派生索引、文献概览和任务，`documents/` 为 MinerU 缓存，`models/` 为按下载源和版本区分的模型缓存（ModelScope 使用其 master 修订）。密钥在系统凭据存储；不进入 SQLite、Agent 返回或导出的连接配置。

这一版使用 SQLite 独立派生检索表、Worker 内 MiniSearch 倒排索引和范围内 typed-array 余弦计算；仅在语义或混合模式按需读取向量，发现检索与摘要读取不再解析整库全文向量 JSON。保留旧原始行供单篇读取和恢复，持久检索快照可重建。尚未做真实大规模文库性能验收；不提供 ANN 数据库、聚类图谱或自动缓存清理。模型本地导入与 Zotero 原生全文降级阅读仍是后续功能；本地模式需要首次联网下载模型，API 模式依赖所配置的 API。关闭 Zotero 即停止插件与 MCP。

MinerU 上传/轮询/ZIP 导入和过期恢复已通过模拟服务的完整流程验证；未使用真实 Key 调用云端解析。服务端实际配额、特定 PDF 的提取质量仍需首次真实解析确认。

若旧版任务提示“原任务尚未收到完整 PDF”，升级至 0.3.3 后到“解析与入库任务”点击“恢复查询原任务”，先查询已有云端任务，不会重新上传。新上传显示“等待上传确认”，确认超时也可恢复查询；只有检查原任务后仍需重传时，才选择“检查后重建”。本地文件读取不完整或文件头异常会在创建云端任务前单独报错。

任务队列的“一键重试”只恢复可重试任务，自动跳过无可用 PDF、页数/大小超限以及需单独重建的任务；结果显示恢复/跳过数量与原因。“需处理”筛选保留这些条目，修正 PDF 或检查原云端任务后再单独操作。

## 开发与验证

```text
npm ci
npm run typecheck
npm test
npm run build
```

`npm run preview` 启动 `http://127.0.0.1:4179` 管理页，**使用演示数据**；`node scripts/check-ui.mjs` 检查桌面/窄屏布局；`node scripts/check-ui-interactions.mjs` 检查大列表、XHTML 分页、搜索输入稳定性与批量重试排除；`node scripts/check-ui-queue.mjs` 检查跨页连选、变化中的进度刷新、右键批量操作、任务删除和相关度排序，使用独立内存宿主桥，不连接真实 Zotero。

`node scripts/check-research.mjs` 另验调研主题、候选与证据查看、来源变化、窄屏布局，以及实际编译后的隐藏 iframe/Worker 桥、倒排查询、语义扫描和快照恢复。浏览器以 headless Chromium 运行，不启动桌面应用；通过不等于原生 Zotero/Gecko 已验收。

`node scripts/setup-zotero-test.mjs` 准备 `.test-profile` 与 `.test-data` 隔离测试配置。用 Zotero `-no-remote -profile <绝对路径>` 启动该配置后，测试版插件生成 `integration-report.json`；`node scripts/check-mcp.mjs` 执行真实 HTTP 测试。测试 harness 只打进隔离测试包，不进入发布 XPI。

既有版本曾验证真实 Zotero 启动/凭据/GUI/入库/自动通知、MinerU 模拟过期恢复与重复跳过、Qwen/E5 真实 WASM 推理、向量存储与语义检索及 MCP HTTP。0.4.0 的验证结果与限制独立记录在 [验证说明](docs/0.4.0验证说明.md)，不把历史宿主验收当作新链路已验证；本轮没有操作用户桌面或调用真实云解析。

源码独立实现，第三方运行时及模型许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。源码托管于 GitHub，安装包通过 Releases 分发；插件更新清单位于仓库的 `updates.json`。GitHub Actions 对推送和 Pull Request 执行类型检查、核心测试及 XPI 构建；原生 Zotero 集成检查仍需本机执行。
