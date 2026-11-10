# Pi Workspace Chat

在 VS Code 的辅助侧栏使用你已经安装的 [Pi Coding Agent](https://pi.dev/)。在右侧点击 **Pi** 标签，或点击编辑器工具栏中的 **π** 图标打开聊天。本机窗口调用本机 Pi，Remote-SSH 窗口调用远程 Pi。

## 安装与启动

需要 VS Code 1.145 或更新版本、Pi 1.5.0 或更新版本，以及 Pi 所需的 Node.js（npm 安装的 Pi 1.5.0 要求 Node.js 22.19 或更新版本）。首版目标为 macOS Apple Silicon 和 Ubuntu x86_64 Remote-SSH。

1. 下载或构建 `pi-workspace-chat-0.1.1.vsix`。本机可在扩展视图选择 **Install from VSIX…**，或运行 `code --install-extension /path/to/pi-workspace-chat-0.1.1.vsix`。
2. 远程使用时，通过 **Remote-SSH: Connect to Host…** 连接服务器，打开远程项目目录，再在**该远程窗口**选择 **Extensions: Install from VSIX…**。在扩展列表确认安装目标为 **SSH: 服务器**。服务器需要自己的 Pi 和 Node。对于 `zju-lab`，使用你自己的用户环境安装，避免修改共享环境。可用 **Developer: Show Running Extensions** 确认 Pi 扩展在远程宿主运行。
3. 打开受信任的工作区，打开 **Pi** 侧栏，点击 **启动 Pi**，或直接发送消息。未登录时，在同一窗口打开 **Pi 终端**，用 Pi 的 `/login` 和 **Sign in with ChatGPT**（或你已使用的 provider）完成登录。远程登录按 Pi 自己的提示完成；不要复制本机凭证。退出 Pi 终端后重新启动侧栏。

如 Pi 已安装但侧栏找不到它，打开 **Settings** 搜索 `Pi Workspace Chat`。在本机用户设置或对应的 **Remote** 设置里配置 `piWorkspace.executablePath`（Pi 的绝对路径）及可选的 `piWorkspace.nodeDirectory`（包含 `node` 的目录）。启动器也识别常见的 `~/.npm-global/bin`、`~/.local/bin` 和 Apple Silicon Homebrew 路径。

## 日常操作

- 编辑器右键选 **Pi: 将文件或选区加入对话**。没有选区时仅附加文件路径；有选区时可以预览、移除，发送后内容才交给 Pi。
- 输入 `/` 选择 Pi 发现的技能、提示模板和扩展命令。选择模型与思考强度时，使用 Pi 当前提供的选项。登录、配置、终端专用命令和自定义终端组件可在 Pi 终端使用。
- 工具卡片显示活动和结果；Pi 返回的编辑补丁可在侧栏预览，也可在只读编辑器中打开。使用 **更改** 跳到 VS Code 源代码管理查看 Git 差异。Pi 按当前配置直接改文件；确认框只响应 Pi 扩展请求。侧栏不会保存或丢弃编辑器中未保存的缓冲区。
- 聊天顶部提供新建、历史和设置。使用视图菜单中的 **在 Pi 终端中打开** 移交当前会话。退出终端后点击 **启动 Pi** 接回原会话，在终端另开的会话可从历史中选择。请不要在独立 Pi 终端或另一个 VS Code 窗口同时打开同一个会话。
- 关闭或重连窗口后可重新打开保存的会话。侧栏不自动重发中断的任务。服务器上的长期计算仍使用项目已有的调度方式。
- 可用 `piWorkspace.expandToolResults` 默认展开工具结果，或用 `piWorkspace.sendWithModifier` 改为 Cmd/Ctrl+Enter 发送。

插件复用所在机器的 Pi 配置、扩展、技能、MCP、工具权限与会话文件。不会读取 Pi 的认证文件，也不会在主机之间同步会话。Windows、跨主机会话共享和断线后的自动接管不在首版范围。

VS Code 工作区信任和 Pi 项目信任分别生效。如果项目级技能或扩展没有显示，请先从同一工作目录打开原生 Pi，在 Pi 中审核项目资源并选择是否信任，然后重启侧栏会话。插件不会替 Pi 跳过项目审批。

## 开发

```sh
npm ci
npm run check
npm test
npm run package:vsix
```

VSIX 输出到 `dist/`，文件名包含扩展版本。`npm run test:vscode` 用本机 VS Code、隔离的配置与模拟 Pi 验证扩展宿主和终端移交。`npm run test:pi` 用真实 Pi 和临时配置验证技能发现及扩展请求。远程验收需要在目标机器自行装好 Pi 后执行。
