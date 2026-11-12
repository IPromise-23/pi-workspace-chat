# Pi Workspace Chat 开发约定

这是供个人侧载的桌面 VS Code 扩展。目标是在本机 Apple Silicon 和 Ubuntu x86_64 Remote-SSH 工作区中，通过右侧辅助侧栏使用宿主机上已安装的 Pi Coding Agent。用户操作见 `README.md`。兼容性声明以 `package.json` 的 `engines` 和 `src/launch.ts` 的启动检查为准。

## 代码入口

| 路径 | 职责 |
| --- | --- |
| `package.json`、`package.nls*.json` | 扩展标识、辅助侧栏、命令、设置、工作区能力及中英文本 |
| `src/extension.ts` | 注册 Webview 和命令，选择工作区，驱动会话与终端移交 |
| `src/launch.ts`、`src/rpc.ts` | 查找并启动 Pi，解析 JSONL，匹配请求及管理子进程 |
| `src/protocol.ts`、`src/sessions.ts` | 整理界面数据，发现并校验当前工作目录的 Pi 会话 |
| `src/webview.ts`、`media/style.css` | 聊天、输入、交互请求、补丁预览与主题样式 |
| `scripts/build.mjs`、`.vscodeignore` | 构建宿主与 Webview 两个包，限定 VSIX 内容 |

## 实现约束

- 保持 `extensionKind: ["workspace"]`。在受信任的工作区中，由工作区宿主以选中目录为 `cwd` 启动 `pi --mode rpc`。Remote-SSH 窗口沿用 VS Code 的远程扩展宿主和终端。
- 保留右侧辅助侧栏和编辑器工具栏入口。新增标题、命令或设置时同步默认和简体中文清单。Webview 使用 VS Code 主题变量，交互控件保留键盘焦点和可访问名称。
- 把认证、技能、扩展、MCP 和工具权限留给所在机器的 Pi。认证在对应宿主的 Pi 终端完成。向 Webview 只传展示和交互所需的数据，诊断只保留脱敏的错误类别。保持 CSP、Webview 消息校验和文件路径校验。
- 用 RPC 请求 ID 匹配响应及扩展对话框。以 `agent_settled` 等协议事件判断任务完成，并保留扩展命令只返回 `handled` 的路径。历史恢复使用 Pi 会话文件，避免自动重发提示词。
- 会话移交仅在空闲时开始。确认 RPC 子进程退出后才启动终端，确认终端中的 Pi 退出后才接回侧栏。同一会话由一个 Pi 进程写入。
- 用 Pi 返回的结构化补丁做只读审阅，用 VS Code 源代码管理查看 Git 差异。尊重工作区边界和编辑器未保存内容。
- 跨端验收使用临时工作目录。远程运行时和登录由用户准备，项目维护范围限于当前扩展、测试目录和经授权的操作。Windows 启动适配、跨主机会话共享和断线后持续执行属于后续范围。

## 开发与验收

使用仓库锁定的 npm 依赖。需要恢复依赖时运行 `npm ci`，修改前检查 `git status`，保留已有工作区改动。

| 命令 | 验证范围 |
| --- | --- |
| `npm run check` | TypeScript 类型检查 |
| `npm test` | 启动、JSONL、RPC、会话及界面数据的自动测试 |
| `npm run test:vscode` | 使用隔离配置和模拟 Pi 验证 VS Code 扩展宿主及原生终端移交，可用 `VSCODE_TEST_EXECUTABLE` 指定编辑器可执行文件 |
| `npm run test:pi` | 使用真实 Pi、临时配置和本地测试模型验证技能、对话框、流式消息及编辑补丁 |
| `npm run test:pi -- --live-model` | 复用当前本机 Pi 登录，在临时目录验证 OpenAI 模型的流式回复、实际编辑及结构化补丁 |
| `npm run package:vsix` | 类型检查、构建及打包，将 VSIX 写入 `dist/` |

按变更范围选择验证。界面变更需在 VS Code 中核对辅助侧栏、主题和交互。在线测试以该阶段输出 `PASS` 为准。侧栏在线验收需从 VS Code 实际发送测试消息，并核对回复、工具卡片和文件结果。记录最近验收与待办见 [HANDOFF.md](HANDOFF.md)。

修改扩展标识、最低版本、命令、设置或侧载方式时，同步检查 `README.md`。更新捆绑依赖时核对 `THIRD_PARTY_NOTICES.txt`。打包后检查 VSIX 内的清单、README、运行产物和资源。Git 提交、推送及发布按用户授权执行。
