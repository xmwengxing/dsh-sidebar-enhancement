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

**终端停靠 / Terminal dock**（复用内置终端，不改动其注册）

- 终端面板工具栏一键停靠到会话输入框下方 / One click docks the terminal below the conversation composer
- 顶缘拖拽调节高度（160px – 70% 视口），模式与高度持久化 / Drag the top edge to resize; mode and height persist in localStorage
- 随时可移回侧边栏，切换期间终端进程与画面保持 / Move back to the sidebar anytime — the terminal process and screen survive the switch

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
- **终端停靠**：以 `priority: -1` 影子替换内置终端面板 Slot，同时向 `conversation.composer.dock` 注册停靠条目；两侧共享同一模式存储，任意时刻只有一侧挂载终端。终端本体直接复用内置懒加载分块（`client.terminal.js`，含 xterm）中的 `TerminalBody` 组件与 `webTerminals` 视图模型，不重复实现终端。

## 兼容性 / Compatibility

- 仅支持会话工作区内的文件（session workspace scope），跨会话与绝对地址不受影响。
- 二进制文件、超大文本（读取上限 6M 字符）不进入编辑器，回落内置行为。
- 目录监视（watch）暂未实现：变更通过手动刷新与操作后自动重列感知。
- 终端停靠依赖内置终端面板包（随插件引导注入），若宿主缺失相关服务则自动跳过该功能。

## License

[MIT](./LICENSE)
