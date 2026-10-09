# IMGX2 全局性能 / 稳定性 / 架构体检

> 测量基座：`scripts/perf-hotpath.js`（真实 Chrome headless + 真实源码 + 合成 X 时间线，无网络）
> 工件：`test-artifacts/perf-hotpath-baseline.json`（修复前）、`test-artifacts/perf-hotpath-report.json`（当前 + 基线对比）
> 运行：`npm run test:perf`（17 项预算断言）、`npm test`（82 项，含右键下载 E2E 17 项 + 媒体身份 16 项）

---

## 0. 结论摘要

| 热点 | 修复前 | 修复后 | 变化 |
| :--- | ---: | ---: | ---: |
| 沉浸模式每 120 次 mousemove 的样式写入 | 1546 次 | 32 次 | **−98%** |
| 沉浸模式 `handleMouseMove` 总耗时 | 11.5 ms | 4.6 ms | −60% |
| 悬停放大镜 `elementFromPoint` 强制命中测试 | 120 次 | 0 次 | **−100%** |
| 悬停放大镜 `handleMouseMove` 总耗时 | 37.3 ms | 18.8 ms | −50% |
| DOM 突变风暴 QSA 调用（160 张新图） | 100 次（80 图） | 40 次（160 图） | 归一化 **−80%** |
| 画廊冷重建（160 图，最坏） | 2.92 ms / 23.3 ms | 2.51 ms / 19.9 ms | −14% |
| 每次沉浸会话开启→关闭的堆增长（30 次循环） | 0.89 MB | 0.55 MB | −38% |

另外修复 9 类缺陷：重复响应/重复下载、视频监听器残留、MV3 SW 多路大缓冲、后台标签页常驻观察器、媒体身份无法单测、画廊重建重复 rect、探测白下载整包、瞬时断流不重试，以及**把工件写进 `_metadata/` 导致扩展直接无法加载**（§2.13）。

---

## 1. 方法：可复现的测量基座

* `scripts/lib/mix01-harness.js`：用 `page.route` 把 `https://x.com/...` 伪造成同源页面（`location.hostname === 'x.com'`，无需网络/TLS），注入内存版 `chrome.*` 总线 + 真实源码，按 `content.js` 的方式装配引擎。E2E 与 perf 共用，避免两套测试桩漂移。
* 页内仪表：包 `getBoundingClientRect` / `querySelectorAll` / `elementFromPoint(s)` / `CSSStyleDeclaration.setProperty` / `MutationObserver` / `requestIdleCallback`，同时给引擎方法（`handleMouseMove` / `updateRender` / `setHUDOpacity` …）打点。
* 场景：40 篇文章 × 4 图 + 3 个 blob 视频；突变风暴再加 20 篇 × 8 图（含 24 个广告文案 span、深层包裹，贴近线上）；沉浸/悬停各 120 次真实 `mousemove`。

---

## 2. 已修复项

### 2.1 沉浸模式 HUD / cursor 每帧冗余样式写入（`Basic/MediaRenderer.js`、`Basic/InputController.js`）

**问题**：沉浸模式下每个 mousemove 帧都会执行 `setHUDOpacity('1')`（3 个元素 × 4 个属性 = 12 次写入）和 `viewer.style.cursor='default'`。样式写入会触发样式失效/重算，即使值没变也一样要走 CSSOM。

**修复**：`setHUDOpacity` 增加状态去抖（`_hudOpacity`，`hide()` 时归零）；cursor 仅在状态变化时写。放弃「定时器 250ms 去抖」方案——那会给"停止移动后 0–250ms 内 HUD/鼠标消失"的手感回归；现在定时器仍逐次重挂，行为与原来完全一致。

### 2.2 悬停放大镜的强制布局命中测试（`Basic/InputController.js`）

**问题**：`handleMouseMove` 非沉浸分支对每次移动都执行 `document.elementFromPoint()`（强制命中测试/布局），而它只用于「指针离开媒体矩形时是否落在我们自己的 viewer 上」这一判定。

**修复**：先做纯几何判定，只有指针真正离开 `cachedRect + 12px` 时才做命中测试。判定语义等价（原逻辑仅在 `!isMouseOverTarget && 在矩形外` 时隐藏），实测 `elementFromPoint` 120 → 0 次。

### 2.3 DOM 突变扫描与媒体槽位（`Basic/InputController.js`）

**问题**：① `_globalDomObserver` 对每个新增元素（含叶子文本/图标节点）都入队，空闲批处理 `querySelectorAll`；② `scanAndObserve` 对每张图都重算 `article.querySelectorAll('img, video')` 找槽位（同一文章 n 张图 → O(n²) 次查询 + 过滤）；③ 同一批次父子节点重复扫描。

**修复**：叶子非 IMG/VIDEO 节点不入队；同一批次中祖先已入队则跳过后代独立扫描（祖先扫描已覆盖）；文章媒体列表与 statusId 在一次扫描内按文章缓存一次（O(n²) → O(n)）。突变风暴下 QSA 调用归一化 −80%，扫描落地延迟 96ms → 16ms。

### 2.4 候选媒体集合的双匹配选择器（`immersive-rules.js`）

**问题**：`document.querySelectorAll('article img, article video, img, video')` 中 `article img` 是 `img` 的子集，每张图返回两条匹配，结果集翻倍，随后 Set 去重与每项 rect 读取都翻倍。

**修复**：改为 `img, video`（覆盖前者），结果集减半。

### 2.5 base64 域下载并发闸门（`background.js`，稳定性）

**问题**：`base64Domains`（防盗链站点）走「SW 内 fetch → 内存缓冲 ≤8MB → dataURL（+33%）」链路。用户连续触发下载时，N 路 8MB 缓冲 + N 份 dataURL 同时驻留 SW 堆，MV3 下可能 OOM 重启。

**修复**：最多 2 路并发缓冲，等待队列上限 3，超出直接走直链兜底（`并发限流直下`），所有下载仍会完成。E2E 用 7 路并发验证：全部完成且确实命中限流分支（移除闸门时该断言失败）。

### 2.6 自愈路径的监听器泄漏（`Basic/MediaRenderer.js`，稳定性）

**问题**：`chrome.runtime.onMessage` 监听器是匿名函数且从不移除。插件重载后 `content.js` 会自毁重建引擎，但旧渲染器的监听器仍留在页面上，导致同一条消息被**旧+新两个渲染器各处理一次**（重复应答、重复下载）。

**修复**：保存监听器引用并在 `destroy()` 中 `removeListener`。E2E 断言：destroy 后消息无应答、无新增下载（无修复时该断言失败）。

### 2.8 全局突变观察器后台常驻（`Basic/InputController.js`，性能 + 稳定性）

**问题**：`MutationObserver.observe(body, {childList, subtree})` 从页面加载起永久开启。X 这种高动态页面在后台标签页仍会持续产生突变记录；站点被用户禁用后也只是在回调里 early-return，观察本身仍在生效。

**修复**：`_setGlobalDomObserver(active)` 统一管理挂载/卸载：页面隐藏或站点禁用时 `disconnect()`；恢复可见/启用时重新 `observe` + 全量补扫（隐藏期间的虚拟列表回收/新增不会漏），并标记画廊缓存脏。perf 基座新增行为断言：隐藏期间新增的 4 图 `_mix01Observed` 必须为 0，可见后必须全部补扫到（无修复时前者为 4，断言失败）。

### 2.9 视频 `canplay/loadeddata` 监听器残留（`Basic/MediaRenderer.js`，稳定性）

**问题**：两个 `{once:true}` 监听器各自注册，只触发一个时另一个残留；切换视频后旧回调仍会隐藏新会话的 loading 环。

**修复**：统一清理函数，回调触发或 `stopVideoRender()` 时都移除两个监听器。

---

### 2.13 ⚠️ 扩展根目录保留名导致「无法加载扩展程序」（严重，已修复并加守护）

**故障现象**（用户报错）：

```
未能成功加载扩展程序
文件 D:\UGit\IMGX2
错误 Cannot load extension with file or directory name _metadata.
    Filenames starting with "_" are reserved for use by the system.
```

**根因（用 CDP `Extensions.loadUnpacked` 实测得出）**：

1. Chromium 的 unpacked 加载器拒绝扩展**根目录**下任何 `_` 前缀条目，只对**自己生成的** `_metadata/` 开一个例外。
2. 例外条件很严格：`_metadata/` 内容必须恰好是 Chrome 自己的布局（`generated_indexed_rulesets/<ruleset 索引>`）。里面一旦出现别的文件，豁免**立即失效**。
3. 而 Chrome 每次成功加载后会往 `_metadata/` 写入（/刷新）DNR 索引规则集——也就是说这个目录是浏览器托管的缓存，**不是**给开发者放数据的地方。
4. 本次事故就是我把 perf/e2e 的 JSON 报表写进了 `_metadata/` → 下次加载直接报错。

实测矩阵（Chrome 154.0.8037.99）：

| 根目录内容 | 加载结果 |
| :--- | :--- |
| 无 `_` 前缀条目 | ✅ |
| `_metadata/generated_indexed_rulesets/_ruleset1`（Chrome 生成） | ✅ |
| `_metadata/` + 任何额外文件（如我们的报表） | ❌ `...file or directory name _metadata...` |
| `_foo/` | ❌ `...file or directory name _foo...` |
| `sub/_foo/`（嵌套下划线） | ✅（只检查根目录） |
| `.hidden/`、`my_notes.txt` | ✅ |

**修复**：

* 测试工件改放 `test-artifacts/`（无下划线前缀），两个脚本已同步。
* `_metadata/` 移出仓库并加入 `.gitignore`（Chrome 托管缓存，不该入库）。
* 新增 `scripts/verify-loadable.js`（`npm run test:loadable`）：
  * 静态：根目录无违规保留名；且 `_metadata/` 内不得有非 Chrome 生成的条目
  * 静态：测试脚本不得向保留名路径写文件（防止旧错误重现）
  * 静态：manifest 引用的文件全部存在 + `content_scripts` 依赖顺序正确
  * **端到端**：启动真实 Chrome 调 CDP `Extensions.loadUnpacked`（与「加载已解压的扩展程序」同一代码路径）拿真实结果

**负向验证**（确认守护非自测）：把报表放回 `_metadata/` 或新建 `_foo/` → 静态与端到端双双 FAIL，且错误文案与用户报错完全一致。

---

## 3. 未动但建议排期（按优先级）

| 级别 | 问题 | 证据 / 现状 | 建议 |
| :--- | :--- | :--- | :--- |
| P1 | `InputController.js` 仍偏大（2445 → 2430 行） | 已抽媒体身份模块（§2.10）；事件/HUD/画廊导航/预加载/下载/物理惯性仍同处一类 | 继续拆 `GalleryNavigator`（导航+trail+fetch-more）与 `Preloader`，保留 `InputController` 作为门面 |
| P2 | X 适配器 `getGalleryImages` 全量扫描成本随媒体数线性增长 | 已加单次重建内 rect 缓存（§2.11）；`galleryStorm` 均 ~1.1ms / 峰值 12ms（约 320 候选） | 批量用 `IntersectionObserverEntry.boundingClientRect` 预热，长页 >1000 媒体可降至亚毫秒 |
| P2 | 下载无断点续传 | 已加瞬时故障重试（§2.12）；大文件中断后仍需重头下载 | 失败 URL 进队列延迟重试；必要时 `Range` 分块 |
| P3 | 内容脚本与 SW 之间只有 `action` 字符串协议，无版本号 | 扩展更新后旧页面脚本可能收到新协议消息（本次靠 `status` 兜底） | 消息带 `protocol: 2`，SW 对旧协议降级 |
| P3 | `content.js` 通过 `chrome.runtime.connect()` 端口检测扩展重载 | 自毁链路本身已可靠（本次修复了监听器残留） | 保持现状，补充「引擎已重建」的 HUD 提示 |

---

## 4. 如何复现

```bash
npm test                          # 87 项：可加载性守护 + 纯 Node 回归 + 媒体身份判定 + X 右键下载 E2E
npm run test:loadable             # 扩展可加载性：静态 + 真实浏览器 loadUnpacked（推荐改完先跑这个）
npm run test:e2e:context-download # 仅右键下载 E2E（真实 Chrome，自动定位本机 Chrome/Edge）
npm run test:perf                 # 热路径体检：17 项预算 + 与基线的对比表
```

工件（均在 `test-artifacts/`，已 gitignore）：

* `test-artifacts/e2e-context-download-report.json`：菜单树、消息载荷、下载记录、失败记录
* `test-artifacts/perf-hotpath-baseline.json` / `test-artifacts/perf-hotpath-report.json`：修复前后测量与 `delta`
* `test-artifacts/loadable-report.json`：保留名扫描结果 + 真实浏览器加载得到的 extensionId

> ⚠️ 不要把任何测试产物写进扩展根目录的 `_metadata/`（Chrome 托管目录）：会让 `_` 保留名豁免失效，扩展直接无法加载——详见 §2.13。
