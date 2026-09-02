# 文件实时编辑功能 — 设计方案

> 状态: 草案,等待决策
> 范围: 右侧文件查看面板 (`FileViewer` → `TextFileViewer`) 的文本/Markdown 文件就地编辑

## 1. 背景与现状

当前 `components/FileViewer.tsx` 内的文本文件视图 (`TextFileViewer`) 是**只读**的:

- 顶部工具栏:路径、元信息、`source` / `preview` / `diff` 模式切换、@ mention、下载
- 内容区: `react-syntax-highlighter` 渲染高亮,行号可选中做 line-range mention
- 通过 `GET /api/files/[...path]?type=watch` 的 SSE 实时同步外部变更 (`fs.watch`)
- 同一个文件可在多个 tab 打开,tab 状态 (`scrollTop` / `scrollLeft` / `displayMode` / `wrapLines`) 由 `AppShell` 持久化

**没有任何写入能力** — 只能 `read` / `meta` / `download` / `preview` / `watch` / `list`。后端 `app/api/files/[...path]/route.ts` 实现了 `GET` 和 `POST(upload)`,**没有 `PUT` / `PATCH`**。

## 2. 目标

让用户在右侧面板打开的**文本类**文件可以直接编辑并保存回磁盘,做到:

- 编辑体验接近现代编辑器 (行号、语法高亮、可选 wrap)
- 编辑状态被尊重: 不会因为 SSE 收到外部 change 就把用户内容冲掉
- 关闭 tab / 切换文件前,未保存内容有明确处理路径
- 与现有 `getAllowedFileRoots()` 安全模型保持对称

## 3. 非目标 (本期不做)

为了控制改动半径,**显式排除**:

- ❌ 文件创建 / 重命名 / 删除 (已有上传路径,不在本次范围)
- ❌ 多光标、列编辑、宏等高级 IDE 特性
- ❌ 与正在运行的 chat agent 抢锁的协调 (先做"乐观编辑 + 冲突提示")
- ❌ 协同锁 (crdt / OT)
- ❌ 图片 / 音频 / PDF / DOCX 的内联编辑 (这些走各自的 viewer)
- ❌ 二进制文件编辑

## 4. 关键设计决策 (需要你拍板)

下面 7 个点我列了主流选项和我的倾向,但**最终决定权在你**。详见文末 §9 "待你决定的决策"。

| # | 决策点 | 倾向 |
|---|--------|------|
| A | 编辑器底层: Monaco / CodeMirror 6 / 原生 textarea | **Monaco** (体验最好,VS Code 同款,体积代价可接受) |
| B | 保存触发: 手动 / 失焦 / 防抖自动 | **手动 Cmd/Ctrl+S + 防抖自动保存到草稿** |
| C | 外部文件被改动的冲突处理 | **脏状态时屏蔽自动 reload,顶部显示 banner 让用户选** |
| D | 可编辑文件大小阈值 | **沿用 256KB,超阈值禁用编辑并提示** |
| E | 脏状态 UX | **tab 圆点 + 关闭拦截 + 工具栏 `Modified` 标识** |
| F | API 形态 | **复用 `/api/files/[...path]`,新增 `type=write` (POST body)** |
| G | 同文件多 tab | **允许,但脏状态时通过 SSE 收到外部 change 弹冲突对话框** |

## 5. 架构概览

```
用户键入
   │
   ▼
EditableSourceView (Monaco)
   │   editorContent (useState)
   │   serverContent (上次从 API 拉到的快照)
   ▼
点 "Save" 或 Cmd/Ctrl+S
   │
   ▼
POST /api/files/<path>?type=write
   │  body: { content, baseRevision: <mtimeMs> }
   ▼
服务端校验路径 + 原子写
   │  tmp file + rename 替换
   │  如果 baseRevision 不匹配 → 409 让客户端做冲突 UI
   ▼
成功 → 客户端用响应里的新 mtimeMs 刷新 serverContent
   │
   ▼
watch SSE 推 change 事件 → 客户端比对:不脏就直接 reload;脏就弹冲突对话框
```

## 6. 后端设计

### 6.1 新增 `type=write` 处理 (沿用 `app/api/files/[...path]/route.ts` 的 `POST`)

请求:

```
POST /api/files/<encoded-path>?type=write
Content-Type: application/json
Body: { content: string, baseRevision?: number }
```

- `baseRevision` = 客户端当时读到的 `mtimeMs` (来自 `meta` 接口)
- 服务端处理顺序:
  1. `isApiRequestAllowed(request)` — 与现有读写同源保护一致
  2. `isFilePathAllowed(filePath, allowedRoots)` — 复用 `lib/file-access.ts`
  3. 校验 body 大小 (沿用 `TEXT_PREVIEW_MAX_BYTES` 256KB 阈值,超过返回 413)
  4. `fs.statSync` 读当前 `mtimeMs`,如果客户端给了 `baseRevision` 且不匹配 → 返回 `409 { error: "stale", currentRevision, serverContent }`,让客户端拉服务端版本做冲突选择
  5. **原子写**: 写 `<filePath>.pi-web-tmp-<pid>-<rand>` → `fs.fsyncSync` → `fs.renameSync` 覆盖目标
     - 关键: `fs.writeFileSync` 直接写**不是原子**的,进程崩溃或断电会留下半截文件;临时文件 + rename 是 POSIX 原子操作
  6. 返回 `{ mtime: <mtimeMs>, size: <newSize> }`

### 6.2 编码与换行

- 读侧当前固定 utf-8;写侧**也写 utf-8**
- 换行: 客户端送来的 `content` 是编辑器内部统一字符串,服务端**不主动改**;渲染前由 Monaco 处理 LF/CRLF 显示,提交时由客户端根据原始字节做归一化 (见 §7.4)

### 6.3 安全要点

- 写权限检查**完全对称**于读权限,无新增白名单
- 不写绝对路径外的文件 (跟 `isFilePathAllowed` 走同一路径)
- `isApiRequestAllowed` 强制同源保护
- 不允许写入 `node_modules` / `.git` 等被排除目录的子文件 — 这些目录根本不会被允许作为 root,所以自动受限
- tmp 文件落在**目标文件同目录**,避免跨文件系统 rename 退化为 copy+delete

## 7. 前端设计

### 7.1 组件拆分

在 `components/FileViewer.tsx` 内部新增 `<EditableSourceView>`,与现有只读 `SyntaxHighlighter` 渲染并列。`TextFileViewer` 根据 `dirty` 状态决定渲染哪个:

```
<TextFileViewer>
  ├── toolbar (扩展: Edit 按钮 / Save 按钮 / 状态徽章 / conflict banner)
  ├── {displayMode === "source" && !isReadOnly
  │       ? <EditableSourceView
  │           value={editorContent}
  │           language={data.language}
  │           onChange={setEditorContent}
  │           registerSave={registerSave}  // 父组件注册 Cmd+S 处理器
  │         />
  │       : <SyntaxHighlighter ... />
  │   }
  └── ...
```

`preview` / `diff` 模式保持只读 (与"编辑"语义不符)。

### 7.2 状态拆分 (关键)

把当前 `data: FileData` 拆成两个:

```ts
const [serverContent, setServerContent] = useState<string>("");
const [serverRevision, setServerRevision] = useState<number>(0); // mtimeMs
const [editorContent, setEditorContent] = useState<string>("");
const isDirty = serverContent !== editorContent;
```

脏判断 = **字符串值不等** (而不是简单的 boolean),简单且足够可靠。`serverRevision` 用于写时回传给服务端做 CAS 校验。

### 7.3 加载与同步

- 初次加载: `fetchContent` 拉内容 → 同时 `setServerContent` + `setEditorContent`
- watch SSE `change` 事件到达:
  - **不脏** → 直接 `setServerContent(nextContent)`,同时 `setEditorContent(nextContent)` (清脏)
  - **脏** → 不动 `editorContent`,只更新 `serverContent` + `serverRevision`,并在工具栏显示 `File changed on disk — reload / keep mine` 横幅
- 用户选 `reload` → 用 `serverContent` 覆盖 `editorContent`,清脏
- 用户选 `keep mine` → 清掉横幅;继续编辑。下次保存会用 `serverRevision` 走 CAS,服务端如果发现外部已变会返回 409,再走一次冲突流程

### 7.4 行尾处理 (CRLF)

- Monaco 默认按文件实际字节显示;用 `model.setEOL` 显式保留用户原文件的换行风格
- 保存时: 客户端**不改**用户输入的换行符 — 写服务端就用 `editorContent` 原样写
- 妥协: 如果用户**新建或完全替换**了内容,默认 LF;如果原文件是 CRLF,Monaco 会检测并保持

### 7.5 Monaco 加载

- 用 `@monaco-editor/react` (社区封装,SSR 友好)
- 在 `next.config.ts` 已有的 transpile 列表里加上 `monaco-editor`,避免 SSR 报错
- 只在客户端动态 import (`dynamic(..., { ssr: false })`),避免 SSR 时拉 2MB
- worker 用 `loader.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@<ver>/esm/vs" } })`,避免自托管 worker 的 webpack 复杂度 (取决于决策 A)

### 7.6 Tab 状态

`Tab` 类型 (在 `components/TabBar.tsx`) 已经支持 `viewerState` + `viewerRevision`,扩展:

```ts
interface Tab {
  // ... 已有字段
  isDirty?: boolean; // 关闭 tab 前判断要不要拦截
}
```

`AppShell` 持有 `tabs` 数组,`onCloseTab` 检测到 `isDirty` 时弹原生 `confirm("Discard unsaved changes?")`。

### 7.7 工具栏扩展

在现有 source/preview/diff 切换器左侧加一组编辑控件:

```
[Modified ●] [Edit | Save] [↶] [↷]   |   [source preview diff] ...
```

- `Edit` 切换按钮: 进入编辑态 (只读 → 可编辑),首次进入用 `editorContent === serverContent` 初始化
- `Save` 按钮: disabled 当 `!isDirty` 或正在保存中
- `Modified ●`: 灰色圆点,脏时变橙色
- 冲突 banner: 横跨工具栏下方,黄色背景,`[Reload from disk] [Keep mine] [View diff]`

## 8. 错误与边界

| 情况 | 行为 |
|------|------|
| 写 413 (超 256KB) | 禁用 Edit 按钮,工具栏显示 "File too large to edit (>256KB)" |
| 写 409 (revision mismatch) | 弹冲突对话框,用户选 reload/keep/manual merge |
| 写 403 (路径越权) | 显示 "Access denied" 红条 |
| 写 500 (磁盘满等) | 弹错误 toast,保留脏状态 |
| watch SSE 中断 | 现有"live/static"指示,行为不变 |
| 切到其他 tab 再切回来 | 编辑器状态保留 (持久化在 `Tab` 上) |
| 用户在编辑器里时 SSE 推 `change` | §7.3 脏逻辑处理 |

## 9. 待你决定的决策

> **请你逐项勾选或调整**,勾完我才开始写代码。

### A. 编辑器选型

- [ ] **Monaco** (`@monaco-editor/react` + CDN workers) — 体验最完整,VS Code 同款,~2MB 初始
- [ ] **CodeMirror 6** (`@uiw/react-codemirror` + `@codemirror/lang-*`) — 模块化,~200KB,需要自己接语言包
- [ ] **原生 `<textarea>`** — 零依赖,体验最差,行号/高亮自己造

我倾向 **A (Monaco)**: 用户期望"现代编辑器"体验,2MB 在 dev 模式无所谓,生产构建可以走 dynamic import 进一步分包。

### B. 保存触发

- [ ] **手动 Cmd/Ctrl+S** (仅手动,简单清晰)
- [ ] **失焦自动保存** (切 tab 时偷偷存)
- [ ] **防抖自动保存** (停键 1s 后静默存)
- [ ] **混合**: 手动 Cmd+S + 切换/关闭前自动存

我倾向 **D (混合)**: 用户主导 + 离开时兜底,既不"忘了存",也不"边打边存"。

### C. 外部文件变更冲突

- [ ] **脏时屏蔽 + banner** (用户自己 reload/keep,简单)
- [ ] **弹模态对话框** (侵入强但不会错过)
- [ ] **什么都不做,下次保存 409 才发现** (最差)

我倾向 **A (banner)**: 不打断心流,关键决策显式给用户。

### D. 可编辑文件大小阈值

- [ ] 256KB (沿用 `TEXT_PREVIEW_MAX_BYTES`,覆盖绝大多数代码/MD/JSON)
- [ ] 1MB
- [ ] 不限 (走 Monaco 大文件模式)

我倾向 **A (256KB)**: 简单、与现有阈值一致,巨型 JSON/日志本就不该手编。

### E. 脏状态 UX

- [ ] **tab 圆点 + 关闭拦截 + 工具栏 Modified 徽章** (我推荐)
- [ ] tab 圆点 + 关闭拦截 (省略工具栏徽章)
- [ ] 只在 tab 显示

### F. API 形态

- [ ] **复用 `POST /api/files/[...path]?type=write`** (与 upload 同一入口,代码集中)
- [ ] 新建 `PUT /api/files/[...path]` (REST 更标准,但要拆 if 分支)

我倾向 **A (复用 POST + type=write)**: 与现有 GET 类型路由同构,改动最小。

### G. 同文件多 tab 策略

- [ ] **允许多 tab,但通过 SSE 收 change 时各 tab 各自决策** (状态独立,实现简单)
- [ ] **强制同 filePath 单 tab,再开就激活已存在的** (避免多 tab 状态漂移)
- [ ] **允许多 tab 且共享编辑器状态** (复杂,通常不需要)

我倾向 **A (允许多 tab,各自决策)**: 用户工作流不被限制。

---

## 10. 实施路径预览 (你确认后才会动)

如果上面 7 项决策都定下来,实施顺序:

1. **后端**: `app/api/files/[...path]/route.ts` 新增 `type=write` 分支 (原子写、CAS、错误码) — 风险最低
2. **客户端基础设施**: `Tab` 类型加 `isDirty`;`AppShell` 关闭拦截;`useAgentSession` 旁路
3. **EditableSourceView**: 新组件,接 Monaco,处理 §7.2/§7.3 状态机
4. **冲突 UI**: 工具栏 banner + 冲突对话框
5. **CRLF / 行尾**: 验证 round-trip 行为
6. **端到端**: 手动测 + 写一个 mjs 测试覆盖服务端原子写和 409 分支

预计 4-6 个文件改动,~600-900 行新增/修改。
