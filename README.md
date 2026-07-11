# DeepSeek Auto Mode Proxy

让 Claude Code + DeepSeek API 的 **Auto Mode** 安全分类请求不再超时的本地代理工具。

## 问题背景

Claude Code 的 Auto Mode 在执行 Bash 命令前，会向 API 发送一个「安全分类请求」，由模型判断该命令是否安全。这个分类请求有大约 **30 秒的内部超时**。

DeepSeek V4 Pro 默认开启了「思考模式」(thinking)，导致安全分类请求的响应时间达到 **28～32 秒**，非常接近超时阈值，经常触发超时而被 Claude Code 拒绝执行。

## 解决方案

本代理运行在本地 `127.0.0.1:8787`，对请求进行分类拦截：

| 请求类型 | 处理方式 |
|----------|----------|
| 安全分类请求 | 注入 `thinking: { type: "disabled" }`，关闭思考模式，响应降至 2～3 秒 |
| 普通对话/工具调用/流式请求 | 原样转发，保留思考能力 |

```
Claude Code
    ↓ http://127.0.0.1:8787
本地代理 ──→ 识别分类请求 → 注入 thinking: disabled
    ↓ https://api.deepseek.com/anthropic
DeepSeek API
```

## 前置要求

- **Node.js** ≥ 18（Claude Code 的 npm 安装已要求 Node.js，通常无需额外安装）
- **DeepSeek API Key**
- **Claude Code** 已安装并配置

## 快速开始

### 1. 获取脚本

将 `deepseek-auto-proxy.mjs` 放到任意目录，例如：

```powershell
git clone git@github.com:dashxio/deepseek-claude-proxy.git
# 或直接下载 deepseek-auto-proxy.mjs 到本地任意位置
```

### 2. 启动代理

在 PowerShell 中运行：

```powershell
node deepseek-auto-proxy.mjs
```

输出：

```
DeepSeek Auto Mode proxy: http://127.0.0.1:8787
Upstream: https://api.deepseek.com/anthropic
```

**保持此窗口运行，不要关闭。**

> 可选检查：语法 `node --check deepseek-auto-proxy.mjs`（无输出即正确）；健康 `Invoke-RestMethod http://127.0.0.1:8787/health`（应返回 `ok True`）。

### 3. 配置 Claude Code

只需将 `ANTHROPIC_BASE_URL` 从 DeepSeek 直连地址改为本地代理地址，其他配置保持不变。两种方式**任选其一**：

#### 方式 A：settings.json

编辑 `%USERPROFILE%\.claude\settings.json`，将 `env` 下的 `ANTHROPIC_BASE_URL` 改为：

```json
"ANTHROPIC_BASE_URL": "http://127.0.0.1:8787"
```

#### 方式 B：环境变量

在 PowerShell 中执行（关闭窗口后失效）：

```powershell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
```

如需持久化，写入用户变量（关闭并重新打开 PowerShell 后生效）：

```powershell
[Environment]::SetEnvironmentVariable(
    "ANTHROPIC_BASE_URL",
    "http://127.0.0.1:8787",
    "User"
)
```

> **注意：** 不要加 `/anthropic` 后缀，代理会自动添加。

### 4. 启动 Claude Code

```powershell
cd 你的项目目录
claude
```

## 恢复直连

将 `ANTHROPIC_BASE_URL` 改回 `https://api.deepseek.com/anthropic` 即可（settings.json 或环境变量，取决于你之前的配置方式）。

> **注意：** 使用代理期间，每次启动 Claude Code 前需先在另一个窗口启动代理。

## 运行效果

代理窗口在请求经过时会打印日志：

```
# 普通请求 — 原样转发
POST /v1/messages [pass] -> 200

# 安全分类请求 — 已注入 thinking: disabled
POST /v1/messages [classifier patched] -> 200
```

看到 `[classifier patched]` 即表示代理已识别分类请求并关闭了思考模式。

## 自定义端口

默认端口为 `8787`，可通过环境变量修改：

```powershell
$env:DS_PROXY_PORT=9999
node .\deepseek-auto-proxy.mjs
```

## 故障排查

| 现象 | 原因 | 解决 |
|------|------|------|
| 代理窗口无任何请求日志 | Claude Code 未使用代理地址 | 检查 `$env:ANTHROPIC_BASE_URL` 是否为 `http://127.0.0.1:8787` |
| `[classifier patched] -> 401` | API Key 未传入 | 检查 `$env:ANTHROPIC_AUTH_TOKEN` 是否已设置 |
| `[classifier patched] -> 502` | 代理无法连接 DeepSeek | 检查网络连接，确认能访问 `api.deepseek.com` |
| 启动报端口占用 | 端口被其他程序使用 | 换一个端口：`$env:DS_PROXY_PORT=9999` |

## 技术原理

### 安全分类请求的识别条件

代理通过以下特征识别安全分类请求（在代理脚本中的 `isSecurityClassifier` 函数中定义）：

- `stream` 不为 `true`（分类器不使用流式输出）
- `tools` 为空（分类器不调用工具）
- `messages` 数量为 1（只包含一条 system 消息）

### 注入内容

对识别到的分类请求，代理向请求体注入：

```json
{
  "thinking": {
    "type": "disabled"
  }
}
```

同时删除旧版参数 `reasoning_effort` 和 `output_config` 以保证兼容性。

### 安全性

- 代理仅监听 `127.0.0.1`，局域网内其他机器无法连接
- 不打印请求正文和 API Key
- 仅修改安全分类请求，其他请求完整透传

## 备选方案

如果不想使用代理，也可以：

1. **使用 acceptEdits 模式**：`claude --permission-mode acceptEdits`，Bash 命令由用户手动确认，不依赖云端分类器
2. **在分类请求中切换模型**：修改代理脚本，将分类请求的 model 改为 `deepseek-v4-flash[1m]`，进一步缩短响应时间

## 许可

MIT
