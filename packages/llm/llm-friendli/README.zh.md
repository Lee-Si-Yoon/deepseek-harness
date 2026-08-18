# @deepseek-ai/dsh-llm-friendli

[English](README.md) | 中文

面向 harness LLM seam 的 FriendliAI serverless chat-completions 适配器：直接 `fetch` + SSE（由 `eventsource-parser` 分帧），将 FriendliAI 的 OpenAI 兼容 wire 格式——连同其确定性 reasoning 解析（依据来源：[reasoning 指南](https://friendli.ai/docs/guides/reasoning) 与 [chat-completions OpenAPI schema](https://friendli.ai/docs/openapi/model-apis/chat-completions.md)）——翻译为 `StreamChunk` 协议。

本包拥有 `friendli` provider 路由。它镜像 `@deepseek-ai/dsh-llm-deepseek`：一个仅负责传输的适配器，连接事实每次操作解析一次，由注册插件负责校验、分层与凭据策略。为 `friendli` 再次注册适配器会抛出 `LlmError('DUPLICATE_ADAPTER')`。

包根导出 Cordis 插件契约与 `FriendliAdapter`；wire 序列化、SSE 解析、chunk 翻译与模型发现辅助函数不属于该根契约。

## 配置

```yaml
- id: llm-friendli
  name: '@deepseek-ai/dsh-llm-friendli'
  config:
    apiKeyEnv: FRIENDLI_API_KEY  # 默认；每次请求经 ctx.credentials 解析，然后是环境
    baseURL: https://api.friendli.ai/serverless/v1 # 可选；$FRIENDLI_BASE_URL 然后是公共 serverless API
    thinking: enabled        # 可选；省略时使用 provider/model 默认
    reasoningEffort: high    # 可选；off | low | medium | high | max
    maxTokens: 32768         # 可选正整数每请求输出上限；这是默认值
    streamIdleTimeoutMs: 300000 # 可选；正有限 Node 定时器延迟；默认五分钟
    retryPolicy:             # 可选；省略使用有界的 normal 默认
      mode: always           # normal | always
      backoff:
        initialDelayMs: 500
        maxDelayMs: 10000
        jitterRatio: 0.1
    defaultContextWindow: 131072 # 可选正整数回退；这是默认值
    models:                  # 可选；默认为 serverless 目录的快照
      - id: zai-org/GLM-5.2
        name: GLM-5.2
        contextWindow: 1048576
      - id: deepseek-ai/DeepSeek-V3.2
        contextWindow: 163840
```

插件注册单一 provider 路由 `friendli` 及其解析后的 `retryPolicy`。请求以 `provider: friendli` 选中它；其 `model` 作为 wire `model` 字符串透传（FriendliAI 模型 id 带有厂商前缀，如 `zai-org/GLM-5.2`），因此切换模型无需生命周期期注册。省略 `models` 会公布 serverless 目录的快照；显式列表将替换这些默认值，而 `models: []` 不公布任何模型。目录条目通过 `ctx.llm.listModels('friendli')` 暴露给 ACP 编辑器与 Web 选择器等客户端，但仍是建议性的：未列出的模型 id 仍原样透传。省略的条目 name 默认为其 id。

`contextWindow` 对每个已配置模型可选。`ctx.llm.resolveModelInfo('friendli', model).context` 先返回精确模型值，然后对无容量条目或未列出的透传 id 返回 `defaultContextWindow`。适配器默认为 131,072——serverless 目录中的保守下限，其旗舰模型远高于此，因此固定大上下文模型的部署应显式设置。

`maxTokens` 是会话请求的适配器配置输出上限，默认 32,768。目录条目可携带自身 `maxTokens`，对该模型胜出；无此项的条目及任何未列出的透传 id 解析为 profile 值。精确模型解析将胜者暴露为 `defaultMaxTokens`；`LlmRuntime` 在 agent loop 写入 `request/header` 前将该值物化进 `GenerateOptions.maxTokens`，从而 wire 请求可重建。显式请求或 `AgentOptions.maxTokens` 值胜出并序列化为 `max_tokens`。适配器不会将该请求预算按 `contextWindow` 钳制。

## Reasoning

FriendliAI 执行**与模型无关的 reasoning 解析**：不将思维链留在 `content` 内的 `<think>` 标签中，而是将 reasoning 分离到 `reasoning_content`。本适配器始终声明该方言——每个请求发送 `parse_reasoning: true` 与 `include_reasoning: true`——因为较旧端点将 `parse_reasoning` 默认为 `false`，且 [reasoning 指南](https://friendli.ai/docs/guides/reasoning) 建议显式命名。解析后的 reasoning token 以 `delta.reasoning_content` 流式传输并成为 harness `reasoning` 块；answer token 以 `delta.content` 流式传输并成为 `text` 块。

thinking 与解析分开控制。对可控 reasoning 模型（如 `zai-org/GLM-5.2`），开关走 `chat_template_kwargs.enable_thinking`；effort 等级映射为顶层 `reasoning_effort`。适配器拥有的 `off` effort 发送 `chat_template_kwargs.enable_thinking: false`，绝不以 `reasoning_effort: 'off'` 越过 wire；`low`、`medium`、`high`、`max` 启用 thinking 并序列化对应的 `reasoning_effort`。不受支持的值在网络 I/O 前以 `UNSUPPORTED_REASONING_EFFORT` 失败。始终 reasoning 的模型忽略该开关并无论如何都 reasoning；适配器仍以相同方式解析其 `reasoning_content`。

`thinking: disabled` 是一个部署锁，仅公布 `off` 并以 `off` 为默认；在其旁配置 `low`/`medium`/`high`/`max` 会导致插件加载失败，直接的每请求启用 thinking 尝试在网络 I/O 前失败。`GenerateOptions.purpose: 'session-title'` 的请求也强制 thinking 关闭，为可见标题文本保留其有界输出，而不改变会话或压缩默认。reasoning 仅在携带 tool call 的 assistant 回合作为 `reasoning_content` 回传（使交错 reasoning 模型在 tool 往返中保持其链），在无 tool call 的回合丢弃以节省 token。

`reasoningEffort` 选择部署默认；当部署策略允许 thinking 时，精确模型解析在 `reasoning` 下为每个透传模型暴露有序的 `off`、`low`、`medium`、`high`、`max` effort。目录条目可设 `reasoning: false`，为非 reasoning 模型仅公布 `off`。`agent/request` 可在每个会话步替换 effort；解析后的值记录在 `request/header` 中。

## 模型发现

插件为 `llm-friendli` settings 命名空间注册模型发现处理器。配置界面查询 serverless `GET {baseURL}/models` 列表，该列表披露 `context_length` 与 `max_completion_tokens`，从而被采用的模型是有尺寸的而非猜测的。携带 `deprecation_date` 的模型被跳过：列表成员身份并非访问授权——账户、权限与弃用各自决定对该模型的请求是否真正成功。发现不存储任何内容；回复是界面提供采用的候选元数据，settings 文档仍是唯一决定路由所服务内容的东西。

## 动态配置（settings + credentials）

连接事实并非在加载时冻结。`resolveAdapterOptions` 是从原始配置到已校验事实的唯一显式解析步骤，适配器每次操作通过 thunk 重新读取一次：base URL、目录、请求默认与空闲预算都在下一请求生效，而进行中的流保持其起始时的事实。两个可选 seam 供给该 thunk：

- **`ctx.settings`** — 插件以相同的 `Config` schema 注册 `llm-friendli` 命名空间，并将其 `cordis.yml` 条目作为组合 `base`，因此用户 settings 文档中的 `llm-friendli:` 段可无需重启覆盖任何字段。无挂载的 settings 服务时，仅由条目配置驱动适配器。通过 schema 但未通过 schema 之外边界（重复目录 id、不合法的 thinking/effort 组合）的实时 settings 快照会保留上一次良好事实并记录失败；条目配置本身仍会使插件加载失败。
- **`ctx.credentials`** — API key 每次流调用解析，来自供给端点的*同一个*已解析快照。配置仅携带 `apiKeyEnv`，从不携带字面 key。因凭据事实随连接事实一同流动，解析器拒绝的 settings 快照既不贡献其端点也不贡献其 key。每个解析后的 key 在使用前经过格式检查，因此任何 HTTP header 无法承载的值会以 `LlmError('INVALID_CREDENTIAL')` 拒绝并命名失败的入口——绝不含 key 的任何部分。任何地方都没有 key 的请求以 `MISSING_CREDENTIAL` 失败并命名每个配置入口，同时路由保持注册、目录保持可浏览——首次上手是「浏览模型、存储 key、再次提示」，其间无需重启。

唯一在注册时捕获的事实是 retry policy：当其解析值变化时，插件原地重新注册路由（同一适配器实例，一个同步段），因此 `ctx.llm.providerRetryPolicy('friendli')` 始终报告当前策略。

插件也在可配置 provider 目录（`ctx.llm.listConfigurableProviders()`）中声明其路由：provider `friendli`、settings 命名空间 `llm-friendli`、空 settings 路径——整个段就是 profile。

## 应用归因

每个请求携带来自 dsh-llm `attributionHeaders()` 的共享归因 header——标识 harness 的强制 `User-Agent` 基线（见 [dsh-llm § App attribution](../llm/README.md#app-attribution-attributionts)）。本适配器不添加任何 provider 专属的应用归因或请求身份 header；bearer token 与共享 `User-Agent` 是内容类型与 accept 之外的全部 header 面，发往已解析的 `baseURL`，包括已配置的 gateway。

## Wire 格式说明

- 仅流式（`stream_options.include_usage` 始终开启）。`usage` 可能附于 finish chunk 或作为尾部仅 usage chunk 到达——翻译器将两者都推迟到 `[DONE]`，因此 `usage` 始终先于 `finish`，且 `finish` 之后无内容。
- 始终发送 `parse_reasoning: true` 与 `include_reasoning: true`，因此 reasoning 以 `reasoning_content` 分离到达，而非内联 `<think>` 标签。
- 适配器拥有的 `off` effort 映射为 `chat_template_kwargs.enable_thinking: false`，绝不以 `reasoning_effort: 'off'` 越过 wire。
- 首个 reasoning chunk 可能携带 `reasoning_content: ""`——已处理（不会产生虚假 reasoning 块）。
- **reasoning 回传规则**：在携带 tool call 的 assistant 回合，`reasoning_content` 序列化回历史；在无 tool call 的回合丢弃。
- 缓存核算：`cacheReadTokens` ← `prompt_tokens_details.cached_tokens`；FriendliAI 不报告缓存写指标。

## 错误

非 2xx 响应抛出带稳定 code 的 `LlmError`：`AUTH`（401/403）、`QUOTA`（provider 细节标明配额、余额或额度耗尽的响应）、`RATE_LIMIT`（其他 429）、`CONTEXT_WINDOW_EXCEEDED`（provider code、type 或 message 标明上下文溢出的 400/422）、`INVALID_REQUEST`（其他 400 与 422——FriendliAI 在 OpenAI 返回 400 处返回 `422 Unprocessable Entity`）、`SERVER`（5xx），否则 `HTTP_<status>`。其可序列化的 `failure` 保留 HTTP status 以及有效的正 `Retry-After` 秒/日期延迟与出现时的 `x-request-id`。响应前的传输失败（DNS、拒绝连接、TLS、代理）抛出 `TRANSPORT`，命名已配置端点并将原始拒绝链为 `cause`；调用方中止抛出 `ABORTED`。协议违规抛出 `STREAM_CLOSED`（无 `[DONE]`）或 `MALFORMED_RESPONSE`（错误的 JSON 载荷）。未知的 wire `finish_reason` 成为 `finish {kind: 'error', failure}` chunk，而 `stop`（或缺失）finish 未打开任何内容块的已完成流成为 code 为 `EMPTY_RESPONSE` 的 `finish {kind: 'error'}`（默认策略重试）。

## Model Experience

### FriendliAI 请求

#### 模型看到什么

选中的 FriendliAI 模型接收 harness 系统提示、消息历史、工具 schema、停止序列与调用配置，没有适配器撰写的提示散文。在携带 tool call 的先前 assistant 回合，其 reasoning 内容作为 `reasoning_content` 回传；无 tool call 回合的 reasoning 被省略。

#### Token 影响

provider 分词决定精确输入。有条件的 reasoning 回传增加 tool 往返上下文，而丢弃其他 reasoning 避免再次为这些 token 付费；可用时报告缓存读 usage。

#### KV 缓存影响

未变的已组装前缀有资格用于 FriendliAI 提示缓存复用，本适配器在 usage 中报告。模型路由变更或任何上游提示、schema、前缀或历史变更可能从首个变化 token 起阻止复用；reasoning 回传在 tool 往返期间追加。

### FriendliAI 响应

#### 模型看到什么

解析后的 reasoning、answer 文本与原始字符串工具参数被翻译为 harness chunk，供 loop 记录与组装。

#### Token 影响

生成的 token 遵循请求记录的 reasoning effort 与 `maxTokens`；仅 loop 保留的块影响后续输入。provider 报告时，reasoning token 计为输出的子集。

#### KV 缓存影响

loop 保留的响应块追加到下一请求并保留其先前可复用前缀；丢弃的块无后续缓存影响。变更 provider 或 model 选择不同的缓存域。

## Known Limitations and Deferred Work

- **settings `models` 列表整体替换组合列表** — settings 层合并是按字段的，而数组是一个字段；按条目的目录合并需要带键的形状。
- **reasoning effort 等级是固定的 `off`/`low`/`medium`/`high`/`max` 集合** — FriendliAI schema 也接受 `minimal`/`xhigh`/`ultracode`，且模型认可的等级各异；已公布集合是跨目录的公约数，未列出的请求值仍透传到端点，端点是权威。
- **未映射 `tool_choice` 与结构化输出（`response_format`）** — 不属于核心词汇（与 DeepSeek 和 pi-ai 适配器共享的裁剪）；FriendliAI 另外拒绝 `response_format` 与 `tools` 组合。
- **请求使用原始 `fetch`，而非 `@cordisjs/plugin-http`** — 无共享代理/拦截配置；推迟采用直到第二个适配器需要它（`TODO(http)`）。
- **序列化将 user 与 tool-result 内容扁平化为文本块** — 插件添加的块类型被跳过，空 tool 输出以字面 `(no output)` 越过 wire。
