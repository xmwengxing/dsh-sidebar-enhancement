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

## 安装 / Install

前提：DSH Web（`@deepseek-ai/dsh`）。

```sh
# 在 DSH 插件安装入口（Web 设置页或 CLI 的包安装功能）安装 npm 包：
dsh-sidebar-enhancement
```

也可以从源码安装本地目录（pnpm 会直接链接工作区，改动刷新即生效）：

```sh
git clone https://github.com/xmwengxing/dsh-sidebar-enhancement.git
# 在 DSH 插件安装入口选择本地目录 dsh-sidebar-enhancement/
```

安装后刷新 DSH 网页即可看到新侧边栏。

## 工作原理 / How it works

- **Host 半部**（`index.js`）向 DSH 内置 web 服务器注册 6 条路由（`/sidebar-enhancer/{save,create,mkdir,rename,remove,upload}`），全部经过连接信任围栏、有界请求体、`typert` 会话工作区根解析与路径包含检查；文件读写经由 `ctx.fs`（乐观锁 `writeText`），目录操作走 `node:fs/promises`。
- **Client 半部**（`client.js`）以 `priority: -1` 影子替换内置文件面板 Slot，并向 `documentPreviews` 注册 `priority: 'extension'` 的渲染器定义与对应文档 Slot。读取走内置 `workspaceFiles` Remote（分页 1 基行号），写入走上述 Host 路由。
- 预览渲染遵循 `DocumentContent` 契约：加载完成后上报 `content.loaded(version)`，外部变更通过 `content.revision` 感知。

## 兼容性 / Compatibility

- 仅支持会话工作区内的文件（session workspace scope），跨会话与绝对地址不受影响。
- 二进制文件、超大文本（读取上限 6M 字符）不进入编辑器，回落内置行为。
- 目录监视（watch）暂未实现：变更通过手动刷新与操作后自动重列感知。

## License

[MIT](./LICENSE)
