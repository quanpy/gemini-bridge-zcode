# zcode-gemini-bridge 🐋

**让 ZCode 无痛使用 Gemini API —— 附带一个本地签名修复代理,根治 `thought_signature 400` 和长对话断连。**

> 本项目由 `D:\root\zcode-gemini-bridge-master` 导入,并将代理从 PowerShell 单线程版升级为 **Node.js 事件驱动版 (v6)**。

## 这是什么

ZCode 通过 OpenAI 兼容格式接入 Gemini API 时,会遇到两类问题:

1. **`thought_signature` 400**:Gemini 3.x 思考模型每次工具调用都会附带 `thought_signature` 签名,Google 要求后续请求历史中**原样带回**。但 ZCode 不认识这个字段,直接丢弃,于是 agent 一调工具,第二轮请求立刻 400 `missing a thought_signature`。
2. **长对话断连**:旧版代理是 PowerShell 单线程,一次只能处理一个流式请求,对话一长、并发一轮,其他请求全部排队超时 → 无限"断开重连"。加上 HttpListener 默认 120 秒空闲回收连接,思考模型静默期一长就断。

修复思路:在本地跑一个**事件驱动**的透明代理,夹在 ZCode 和 Google 之间。它缓存 Google 返回的签名并自动补回,同时剥离 Google 端点不认的字段,ZCode 一行不用改。

```
ZCode → http://127.0.0.1:8899/v1beta/openai (Node 修复代理 v6) → https://generativelanguage.googleapis.com
```

## 优化


| 并发 | 单线程,一个流式请求阻塞一切 → 长对话必断 | 事件驱动天然并发,互不阻塞 |
| 空闲连接超时 | HttpListener 默认 120s,思考静默期必断 | 15 分钟,思考期不断 |
| 未知字段剥离 | 有 (`thinking`/`enable_thinking`/`reasoning`) | 有(保留) |
| thought_signature 缓存/补回 | 有 | 有(保留,并发安全) |
| 出口代理 | 硬编码 `127.0.0.1:15556` | 动态读系统代理,本机目标强制直连 |
| 依赖 | PowerShell | Node.js ≥ 18 |

## 快速开始

### 1. 安装 nodejs


### 2. 启动代理

**双击** `scripts/start-proxy.bat`,或:

```bash
node scripts/gemini-proxy.mjs
```

**停止代理**:双击 `scripts/stop-proxy.bat`。

代理日志在 `%USERPROFILE%\.zcode\gemini-proxy.log`(排障第一现场)。想开机自启,把 `start-proxy.bat` 的快捷方式丢进 `shell:startup`。

### 3. 在 ZCode 里创建 provider

设置 → 模型 Provider → 添加自定义:

| 配置项 | 值 | 说明 |
|---|---|---|
| 格式 | **OpenAI Chat Completions** | 千万别选 Responses,Google 没有那个端点,必 404 |
| 地址 | `http://127.0.0.1:8899/v1beta/openai` | 指向本地代理 |
| API Key | 你的 AI Studio key(`AQ.` 或 `AIzaSy` 开头) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 获取 |
| 模型名 | `gemini-3.7-flash` / `gemini-3.6-flash` | 手动输入,别信下拉列表 |

### 4. 开一个新对话,选模型,开聊

注意:**必须新对话**。旧对话缓存了旧配置,改了也不生效。

## 报错速查(全部实战验证)

| 报错 | 病因 | 药方 |
|---|---|---|
| 400 `missing a thought_signature` | ZCode 丢了签名 | 跑本代理(v6 会自动补回) |
| 400 `Unknown name "thinking/enable_thinking/reasoning"` | ZCode 发 Gemini 原生字段,openai 端点不认 | 代理会自动剥离(已验证) |
| 400 `Invalid reasoning_effort: max` | 思考档位选了 max | 改 high(Google 只认 high/low/medium/minimal/none) |
| 404 Not Found | 选了 Responses 格式 / 模型名不对 / 地址拼错 | 用 Chat Completions + 核对模型名 |
| 403 `project has been denied access` | 项目没绑结算 | AI Studio 里给项目设置结算信息 |
| 403 auth_failed | key 错/复制不全 | curl 验证 key(见下) |
| 503 high demand | Gemini 3.7 高峰期 | 等几分钟重试 |
| 长时间无响应/一直重连 | 代理没跑 / 出口不通 | 查日志 + 确认系统代理开启 |

验证 key:

```bash
curl "https://generativelanguage.googleapis.com/v1beta/models?key=<KEY>"
```

能列出模型即有效。

## 已知 ZCode 怪癖

- **退出时会用内存配置覆盖 config.json** —— provider 要在界面里建,别手改文件
- **点 X 只是缩小到托盘** —— 真重启要托盘右键退出
- **报错的 TraceID 不变说明在旧会话里打转** —— 改完配置必开新对话
- **思考档位**:Google 只认 `high/low/medium/minimal/none`,不认 `max`

## 前提条件

- Node.js ≥ 18(`node --version` 确认)
- 网络能访问 `generativelanguage.googleapis.com`(本机直连不通时,Windows 系统代理需开启且代理软件在运行——代理会自动检测)
- 一个开通了 Gemini API 的 Google 账号和有效的 API key
- (Agent 工具调用场景需要思考模型时)项目已绑定结算

## License

MIT