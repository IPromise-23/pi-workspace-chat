# Pi Workspace Chat

在 VS Code 的右侧辅助侧栏使用 [Pi Coding Agent](https://pi.dev/)。点击 **Pi** 标签或编辑器工具栏中的 **π**，即可打开聊天。本机窗口调用本机 Pi，Remote-SSH 窗口调用服务器上的 Pi。

## 功能

- 在聊天中查看流式回答、工具进度、文件跳转和 Pi 返回的编辑补丁。
- 从编辑器引用当前文件或选区，发送前可预览和移除引用。
- 选择 Pi 提供的模型与思考强度，通过 `/` 使用可发现的技能、提示模板和扩展命令。
- 打开历史会话，或把当前会话移交给同一台机器上的原生 Pi 终端。

## 运行要求

| 项目 | 要求与验证状态 |
| --- | --- |
| VS Code | 桌面版 1.145.0 起，使用受信任的工作区 |
| Pi Coding Agent | 1.5.0 起，安装在工作区所在的机器上 |
| Node.js | 从源码构建需要 22.19.0 或更新版本。运行 Pi 时按所安装的 Pi 版本要求配置 |
| macOS Apple Silicon | 已在 VS Code 1.145.2 和 Pi 1.5.2 验证侧栏在线对话、文件编辑和补丁预览 |
| Ubuntu x86_64 Remote-SSH | 目标环境，待服务器准备好 Pi 和登录后完成实机验收 |

## 安装与首次使用

### 本机

1. 在扩展视图搜索 **Pi Workspace Chat**，或安装扩展 ID `ipromise.pi-workspace-chat`。
2. 也可以获取 `pi-workspace-chat-<版本>.vsix`，在 VS Code 命令面板执行 **Extensions: Install from VSIX…** 安装。
3. 打开受信任的项目目录，点击右侧 **Pi** 标签。点击 **启动 Pi** 或直接发送消息。如果还没有打开工作区，Pi 面板提供 **打开文件夹…**。

### Remote-SSH

1. 用 **Remote-SSH: Connect to Host…** 连接服务器并打开远程项目。确认远程环境中的 `pi --version` 可以运行。
2. 在已连接的窗口执行 **Extensions: Install from VSIX…**。在扩展视图确认 Pi Workspace Chat 位于对应的 SSH 主机下。
3. 从右侧 **Pi** 打开会话。使用 **Developer: Show Running Extensions** 可核对扩展是否运行在远程宿主。安装方式见 [VS Code 的远程扩展文档](https://code.visualstudio.com/api/advanced-topics/remote-extensions#installing-a-development-version-of-your-extension)。

### 斜杠命令与 Pi 终端

扩展复用当前宿主 Pi 的认证和模型配置。本机与远程分别登录。侧栏输入 `/` 可查看命令和总数，用方向键、滚轮或继续输入命令名称浏览完整列表。列表包含 Pi 1.5 的内置命令和当前工作目录的 Pi 通过 RPC 报告的扩展命令、技能及模板。

- `/login`：打开同一宿主的 VS Code 原生 Pi 终端。等 Pi 的输入框出现后，在终端执行 `/login` 并选择提供方。完成后在终端执行 `/quit`，再点侧栏的 **启动 Pi** 继续会话。登录输入留在 Pi 终端。
- `/new`、`/resume`、`/quit`：在侧栏新建、选择历史会话或停止 Pi。退出后聊天记录仍可查看，点 **启动 Pi** 可继续已保存的会话。
- `/tree`、`/settings`、`/export` 等命令会打开 Pi 终端。按侧栏提示在终端执行命令及所需参数。第三方命令可在菜单中选择 **在侧栏运行** 或 **在 Pi 终端执行**。
- 安装、禁用或更新 Pi 资源后，空闲时点击 **刷新命令** 或提交 `/reload`。侧栏会重启当前 Pi 进程并重新读取资源，已保存的会话会接回。
- Pi 的 RPC 不提供扩展自行修改的 TUI 补全菜单和参数补全。需要这些交互时可输入 `/terminal`，在原生 Pi 终端中按 `/` 查看。

切换界面或退出前，请先等待或停止当前任务。侧栏不会向终端自动注入输入。终端中的认证、确认和自定义界面均由 Pi 自己处理。

## 日常使用

- 在编辑器右键选择 **Pi: 将文件或选区加入对话**。有选区时附加选中的文本，没有选区时附加文件路径。
- 在工具卡片中打开文件或查看 Pi 返回的补丁。完整的 Git 差异在 VS Code 源代码管理中查看。文件修改和确认提示遵循 Pi 自己的权限规则。
- 通过聊天顶部的操作打开历史或新建会话。选择视图菜单中的 **在 Pi 终端中打开**，可以把空闲会话移交给原生 Pi，使用登录、设置和终端专用交互。退出终端后点击 **启动 Pi** 接回原会话，终端里新开的会话可从历史选择。
- 连接中断后，从历史打开已保存的会话。历史按宿主机和工作目录查找，恢复时需要手动决定是否重新发送上次的任务。

## 扩展设置

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `piWorkspace.executablePath` | 空 | 自动查找 Pi。可填写当前宿主上 Pi 可执行文件的绝对路径 |
| `piWorkspace.nodeDirectory` | 空 | 在 Pi 找不到 Node 时，指定包含 `node` 的绝对目录 |
| `piWorkspace.expandToolResults` | `false` | 默认展开工具活动和结果 |
| `piWorkspace.sendWithModifier` | `false` | 默认 Enter 发送。开启后改用 Cmd/Ctrl+Enter |

在 **设置** 中搜索 `Pi Workspace Chat`。Pi 和 Node 的路径应设置在对应机器的本机用户设置或 **Remote Settings**。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 右侧找不到 Pi | 确认扩展装在当前工作区宿主，打开辅助侧栏，或点击编辑器工具栏的 **π** |
| 找不到 Pi 或 Pi 启动失败 | 在同一台机器的终端检查 `pi --version` 和 `node --version`，再核对扩展设置中的路径 |
| 侧栏没有可用模型 | 在同一宿主的 Pi 终端检查登录和模型，然后重启侧栏会话 |
| 项目技能或扩展没有出现 | 分别检查 VS Code 工作区信任和 Pi 的项目信任。由原生 Pi 在同一目录审核项目资源 |
| 终端会话无法接回 | 先退出该会话对应的 Pi 进程，再回侧栏启动。使用同一份会话时应避免在不同窗口同时运行 Pi |

## 从源码开发

```sh
npm ci
npm run check
npm test
npm run package:vsix
```

打包命令把 `pi-workspace-chat-<版本>.vsix` 写到 `dist/`。用已安装的 VS Code 运行 `npm run test:vscode` 可验证扩展宿主和终端移交。用 `npm run test:pi` 可在临时配置中以本地测试模型验证真实 Pi。打包与发布的区别见 [VS Code 扩展打包文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#vsce)。

已在本机 Pi 配置 OpenAI 模型时，可以运行 `npm run test:pi -- --live-model`，在临时目录中验证在线回复、文件编辑和补丁。看到在线阶段的 `PASS` 才算完成 RPC 验收。侧栏验收在 VS Code 的临时工作区中发送一条测试消息，再检查工具卡片和实际文件差异。

Windows、跨主机会话共享和断线后持续执行是后续范围。第三方依赖许可见 `THIRD_PARTY_NOTICES.txt`。
