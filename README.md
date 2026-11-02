# Literature Library for Zotero

单个 Zotero 插件：MinerU PDF → Markdown、插件内 Qwen 本地向量化、分层文献查询、知识库管理界面和 MCP。普通用户无需安装 Ollama、Python、Node.js、Docker 或数据库服务。

当前为 **0.2.0 测试版**。已在隔离的 Zotero 10.0.7 / Windows 配置中运行验证；清单声明 Zotero 8–10，但 8/9 尚未实机验证。测试未修改正式 Zotero 配置或文献库。

[下载 v0.2.0 测试版](https://github.com/lixvqing01/zotero-literature-library/releases/tag/v0.2.0) · [验证记录](docs/验证记录.md) · [Agent 使用说明](docs/Agent使用说明.md)

## 安装与首次配置

1. 从 [GitHub Releases](https://github.com/lixvqing01/zotero-literature-library/releases) 下载 `.xpi`。在 Zotero 的“工具 → 插件”中，选择齿轮菜单“从文件安装插件”，打开下载的安装包，按 Zotero 提示重启。开发构建产物位于 `dist/literature-library-0.2.0.xpi`。
2. 在“工具 → 插件”的 Literature Library 卡片点击“打开知识库 / MinerU 设置”。也可以从“设置 → Literature Library”或“工具 → Literature Library”进入，条目右键菜单有“查看知识库”。
3. 在插件设置页或管理器“设置”中输入 MinerU Key。可填写 Key **生成日期**或实际到期日期；不填时显示有效期未知。保存日期不会被当作生成日期。Key 存入 Zotero/Gecko 登录凭据存储，界面不回显；安装包不包含用户 Key。
4. 启用“MinerU 云端解析”。选中的 PDF 会上传到 MinerU，解析结果和向量保存在本机。
5. 点击“加载 / 下载模型”。默认 Qwen3-Embedding-0.6B Q8，1024 维；也可选多语言 E5-small Q8，384 维。首次从 Hugging Face 下载，后续使用本地缓存。Qwen 文件较大，需要足够内存与磁盘空间。
6. 选中文献，右键“加入 Literature Library”。如需自动处理后续新增条目，开启“新加入的条目自动入库”。开启不会立即批量上传全部历史文献，历史条目可手动选择加入。

条目列表的列选择菜单中可启用“知识库”状态列。管理器提供覆盖数量、任务进度、失败原因、搜索、分层详情、更新索引和移除派生索引。搜索条件和结果在刷新、切换页面后保留；全选只选择当前结果。点击命中标题可阅读对应段落，并跳转到 PDF 原页；长全文支持上一段 / 下一段。任务可逐项重试，需重新提交的任务单独提示。移除派生索引保留 Zotero 条目与原 PDF；当前版本不会自动清理已下载的派生文件缓存。

## 从 0.1.0 升级

安装新 XPI 后，原设置、解析结果和任务保留，文献概览表自动补齐。本版增加了书目向量层，旧向量会标记为需要更新：选中文献点击管理页“更新索引”，或右键“加入 Literature Library”，可复用未变化 PDF 的 Markdown，仅重新生成向量。不要为更新模型使用右键“重建”——该操作会重新解析 PDF。

纯向量模式只使用与当前版本模型匹配的向量，不混入关键词结果；混合模式使用排名融合，并在文献级结果中合并同一 Zotero 条目的多个 PDF。目标层没有可用向量时，纯向量模式明确报错，混合模式提示并回退关键词，不为一个空索引下载模型。相似度和融合分数不是“回答正确率”。

## 提取、重复入库和错误恢复

- 书目与摘要来自 Zotero，包括期刊、ISSN、卷期页、DOI 等；没有原文摘要则明确标记缺失。
- PDF 使用 MinerU 精准 v4 API，支持 OCR、表格和公式；从结构化内容列表保留 PDF 页号。缺少页号时返回空值，不猜页。
- 依次提供 metadata、abstract、outline、fulltext 和 notes。全文可指定章节、页号及字符范围。
- 按 PDF SHA-256、书目信息、解析配置和模型固定版本判断更新；未变化则跳过，活动任务不会被重复或强制操作覆盖。
- Key 过期 `A0211` 返回 `MINERU_TOKEN_EXPIRED`，暂停相关任务。无效 `A0202`、HTTP 鉴权失败、网络和限流分别报告。更新 Key 后只恢复因凭据暂停的任务，并继续原阶段，也可在任务队列点击“恢复 / 重试”。
- 90 天到期日期是依据用户提供的生成日期计算的预计值；实际 API 响应是过期判定依据。没有可用于只读检查的已有任务时，“验证状态”不会创建一个收费解析任务。
- 提交结果不确定、上传未完成或云端任务失效时，不会因自动扫描、更新 Key 或批量恢复而重复提交；需检查 MinerU 后，单独点击“检查后重建”。启用云端解析会恢复因关闭上传而暂停的任务。重建失败时保留最后可读版本。
- 新增 PDF/条目由 Zotero Notifier 触发；启动及每 5 分钟补查启用自动索引期间的变化与已入库条目。尚未下载到本机的附件会等待后重试。

## Agent 接入

在管理器设置中启用“本地 MCP / JSON API”，点击“复制连接配置”。令牌只授予本机插件访问权，与 MinerU Key 不同。连接配置含本地访问令牌，应直接放入 Agent 客户端配置，不写入公共仓库。

插件提供 Streamable HTTP，无需单独启动 MCP 服务。默认地址为 `http://127.0.0.1:23119/literature-library/mcp`，以界面显示端口为准。客户端需要支持 HTTP MCP 和 `Authorization: Bearer` 请求头。连接失败先确认 Zotero 正在运行、本地 HTTP 服务未被禁用且插件 Agent 开关已开启。

| 工具 | 用途 |
|---|---|
| `literature_search` | 按书目、摘要或证据段落关键词/语义/混合检索；可筛选文库、年份和期刊 |
| `literature_read` | 按文献身份读取书目、摘要、目录、章节、页或笔记 |
| `literature_index` | 将指定 Zotero 文献加入持久队列 |
| `literature_status` | 覆盖情况、任务、模型和密钥状态，不返回密钥 |
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

插件数据保存在当前 Zotero **配置目录**下的 `literature-library/`：`library.sqlite` 为派生索引、文献概览和任务，`documents/` 为 MinerU 缓存，`models/` 为固定版本模型缓存。密钥在系统凭据存储；不进入 SQLite、Agent 返回或导出的连接配置。

这一版使用 SQLite JSON 行与内存余弦计算；管理页和状态统计读取独立的文献概览表，避免反复加载全文和向量数组。当前检索实现适合先验证个人文库工作流，尚未做大规模文库性能验收；不提供 ANN 数据库、聚类图谱或自动缓存清理。模型本地导入与 Zotero 原生全文降级阅读仍是后续功能，当前需要首次联网下载模型。关闭 Zotero 即停止插件与 MCP。

MinerU 上传/轮询/ZIP 导入和过期恢复已通过模拟服务的完整流程验证；未使用真实 Key 调用云端解析。服务端实际配额、特定 PDF 的提取质量仍需首次真实解析确认。

## 开发与验证

```text
npm ci
npm run typecheck
npm test
npm run build
```

`npm run preview` 启动 `http://127.0.0.1:4179` 管理页，**使用演示数据**；`node scripts/check-ui.mjs` 检查桌面/窄屏布局。

`node scripts/setup-zotero-test.mjs` 准备 `.test-profile` 与 `.test-data` 隔离测试配置。用 Zotero `-no-remote -profile <绝对路径>` 启动该配置后，测试版插件生成 `integration-report.json`；`node scripts/check-mcp.mjs` 执行真实 HTTP 测试。测试 harness 只打进隔离测试包，不进入发布 XPI。

已验证：17 项核心测试、真实 Zotero 启动/凭据/GUI/入库/自动通知、MinerU 模拟过期恢复与重复跳过、Qwen/E5 真实 WASM 推理、Qwen 向量存储与语义检索、MCP 真实 HTTP、管理页桌面与窄屏检查。

源码独立实现，第三方运行时及模型许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。源码托管于 GitHub，安装包通过 Releases 分发；插件更新清单位于仓库的 `updates.json`。GitHub Actions 对推送和 Pull Request 执行类型检查、核心测试及 XPI 构建；原生 Zotero 集成检查仍需本机执行。
