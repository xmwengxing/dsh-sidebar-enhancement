# dsh-sidebar-enhancement

[![npm version](https://img.shields.io/npm/v/dsh-sidebar-enhancement)](https://www.npmjs.com/package/dsh-sidebar-enhancement)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

[DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) 侧边栏增强插件：给文件树补上完整的文件管理操作，并把文档预览升级为可编辑、可保存的文本编辑器。

An enhanced sidebar plugin for DeepSeek Harness: full file-management operations on the files tree, plus an editable, savable document preview.

## 功能 / Features

**文件树 / Files tree**（影子替换内置文件面板）

- 重命名 / Rename（行内输入框，右键菜单或 `⋯` 按钮）
- 新建文件、新建目录 / New file & new directory
- 上传 / Upload（工具栏按钮多选上传，或直接拖拽文件到目录行/面板空白处）
- 删除 / Delete（文件与目录，递归删除需确认）
- 右键上下文菜单、展开/折叠、手动刷新
- 保留内置面板的打开行为与会话动作插槽 / Keeps the built-in open behavior and session action slot

**文档编辑器 / Document editor**（接管约 130 种文本扩展名的预览）

- 预览区直接编辑，`Ctrl/Cmd+S` 保存，工具栏按钮同效
- 乐观锁保存：携带读取时的文件版本，磁盘已变更时提示冲突，可确认覆盖或加载磁盘版本
- 读取期间文件被外部修改的变更提示 / External-change notice during load
- 大小写不敏感的扩展名匹配，内置渲染器（Markdown/HTML/SVG 等）仍可在切换器中选择

**下侧终端面板 / Bottom terminal panel**（复用内置终端内核，不改动其注册）

- 会话头部新增终端按钮，点击在输入框下方弹出独立面板，再点收起 / A terminal button in the session header shows/hides an independent panel below the composer
- 面板支持多标签，**完全独立于右侧边栏**：底部开的终端不会出现在侧边栏，反之亦然 / Multi-tab panel, fully independent of the right sidebar — neither side sees the other's terminals
- 面板内 + 新建终端、× 关闭标签（进程一并结束）、顶缘拖拽调高（160px – 70% 视口），显隐与高度持久化 / + opens a terminal, × closes a tab and its process, drag the top edge to resize; all state persists

## 安装 / Install

前提：DSH Web（`@deepseek-ai/dsh`）。

**方式一：CLI 从 npm 安装（推荐 / Recommended）**

```sh
dsh plugin --profile web add dsh-sidebar-enhancement
```

安装后重启 `dsh web` 并刷新页面即可生效（包内自带 `dsh.bundle.patch`，Loader 自动注册，无需改 profile 配置）。

**方式二：从源码本地安装（开发模式 / Dev mode）**

```sh
git clone https://github.com/xmwengxing/dsh-sidebar-enhancement.git
# 在 DSH 插件安装入口选择本地目录 dsh-sidebar-enhancement/
```

本地目录安装采用 pnpm link：改动源码后刷新页面即生效，无需重装，适合迭代开发。

卸载 / Uninstall：

```sh
dsh plugin --profile web remove dsh-sidebar-enhancement
```

## 工作原理 / How it works

- **Host 半部**（`index.js`）向 DSH 内置 web 服务器注册 6 条路由（`/sidebar-enhancer/{save,create,mkdir,rename,remove,upload}`），全部经过连接信任围栏、有界请求体、`typert` 会话工作区根解析与路径包含检查；文件读写经由 `ctx.fs`（乐观锁 `writeText`），目录操作走 `node:fs/promises`。
- **Client 半部**（`client.js`）以 `priority: -1` 影子替换内置文件面板 Slot，并向 `documentPreviews` 注册 `priority: 'extension'` 的渲染器定义与对应文档 Slot。读取走内置 `workspaceFiles` Remote（分页 1 基行号），写入走上述 Host 路由。
- 预览渲染遵循 `DocumentContent` 契约：加载完成后上报 `content.loaded(version)`，外部变更通过 `content.revision` 感知。
- **下侧终端面板**：向 `conversation.composer.dock` 注册多标签面板条目，并向 `conversation.session.header.utilities` 注册头部按钮。面板拥有自己的终端 seat 台账（`panelSeats`）：每个 seat 合成唯一 content identity，直接向 `ctx.webTerminals.view()` 取视图并 `refresh()` 分配新终端；关闭走控制器自己的 `ctx.webTerminals.close(sessionId, key, contentId, terminalId)`（记录关闭意图、清掉绑定与视图、后台结束进程且失败可重试）。不直接调 `view.close()`：它只杀进程，控制器账本仍占着会话终端名额，连续开关后会撞上「终端数量已达上限」。不读取、不写入侧边栏标签清单（`openTabs`/`openTabIn`/`closeIn`），因此与右侧边栏终端完全互不干扰。终端渲染复用内置懒加载分块（`client.terminal.js`，含 xterm）中的 `TerminalBody` 组件与 `webTerminals` 视图模型，不重复实现终端。

## 兼容性 / Compatibility

- 仅支持会话工作区内的文件（session workspace scope），跨会话与绝对地址不受影响。
- 二进制文件、超大文本（读取上限 6M 字符）不进入编辑器，回落内置行为。
- 目录监视（watch）暂未实现：变更通过手动刷新与操作后自动重列感知。
- 下侧终端面板依赖内置终端面板包与会话面板（随插件引导注入），若宿主缺失相关服务则自动跳过该功能。

## License

[MIT](./LICENSE)
