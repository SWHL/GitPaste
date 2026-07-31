<p align="center">
  <img src="https://raw.githubusercontent.com/SWHL/GitPaste/refs/heads/main/assets/gitpaste-logo.png" width="128" height="128" alt="GitPaste logo">
</p>

简体中文 ｜ [English](../README.md)

# GitPaste

GitPaste 可以把图片上传到 GitHub，并将公开链接插入当前编辑器。它采用 VS Code Web Extension 架构，同一个扩展可以运行于桌面 VS Code, GitHub Codespaces、`vscode.dev` 和 `github.dev`。

第一版仅支持 GitHub，但上传层已经拆分为独立 Provider，后续增加 GitLab, S3 或其他对象存储时不需要修改粘贴和编辑器流程。

> **凭据安全：** vs-picgo 的 GitHub 上传器需要将 token 以明文写入配置文件。GitPaste 不会把 GitHub token 写入扩展配置或 `settings.json`。你可以直接使用 VS Code 内置 GitHub 登录，无需自行管理 PAT；也可以提供 PAT，由 GitPaste 将其保存在 VS Code `SecretStorage` 中。

## 使用方法

1. 在命令面板运行 **GitPaste: Configure GitHub Repository**。
2. 选择将配置保存到当前工作区或全局，然后按 `owner/repository` 格式填写仓库、分支和图片目录。
3. 使用 VS Code 内置 GitHub 登录，或者提供具有仓库 **Contents: Read and write** 权限的细粒度 PAT。
4. 复制图片并打开 Markdown 或 MDX 文档。Web 版使用 `Ctrl+V` 或 `Cmd+V`；桌面版使用 `Ctrl+Alt+U` 或 `Cmd+Alt+U`。

PAT 会保存在 VS Code `SecretStorage` 中，不会以明文配置写入 `settings.json`。
细粒度 PAT 的 **Resource owner** 必须是目标仓库所有者，**Repository access** 必须包含目标仓库。组织仓库还可能要求管理员批准令牌或完成 SSO 授权。
选择 PAT 后，GitPaste 不会在令牌暂时不可用时静默切换到 VS Code GitHub 登录；它会要求重新输入 PAT。

## 快捷键

| 功能 | Windows/Linux | macOS |
| --- | --- | --- |
| 从剪贴板上传（桌面版） | `Ctrl+Alt+U` | `Cmd+Alt+U` |
| 粘贴并上传图片（Web 版） | `Ctrl+V` | `Cmd+V` |
| 选择图片上传 | `Ctrl+Alt+E` | `Cmd+Alt+E` |
| 从路径或 URL 上传 | `Ctrl+Alt+O` | `Cmd+Alt+O` |
| 替换光标处图片 | 命令面板或编辑器右键菜单 | 命令面板或编辑器右键菜单 |
| 检查配置 | 命令面板 | 命令面板 |

需要复制图片本身，而不是图片地址。Web 版中，`Ctrl/Cmd+V` 遇到图片时会上传，遇到文字或其他内容时仍执行普通粘贴。由于浏览器只会通过真实粘贴事件提供图片二进制数据，GitPaste 的专用剪贴板快捷键仅用于桌面版。

## 仓库配置作用域

运行 **GitPaste: Configure GitHub Repository** 时，需要选择仓库、分支和图片目录的保存范围：

- **Current workspace（当前工作区）**：写入工作区设置，适合每个项目使用不同图片仓库。打开该工作区时，工作区值优先于全局值。
- **Global（全局）**：写入用户设置；没有工作区覆盖时，所有项目使用同一目标仓库。

凭据不会写入任何设置作用域。GitHub 登录会话由 VS Code 管理，PAT 始终保存在 VS Code `SecretStorage` 中。

## 同名文件处理

`gitpaste.github.conflictStrategy` 决定生成的远端路径已经存在时如何处理。

| 取值 | 行为 | 关键说明 |
| --- | --- | --- |
| `rename` | 查找第一个可用数字后缀，例如 `photo-2.png`、`photo-3.png`。 | 默认且最安全；保留已有文件。 |
| `overwrite` | 读取 GitHub 当前文件的 SHA 后覆盖该文件。 | 远端路径和公开 URL 通常不变；GitPaste 无法自动恢复旧内容。 |
| `prompt` | 每次冲突时询问使用重命名还是覆盖。 | 取消选择会停止当前操作。 |

默认文件名模板包含 `${random}`，所以通常不会冲突；自定义模板移除随机值后，这项设置会更重要。

## 上传失败恢复

批量上传中某一项失败时，GitPaste 会显示具体错误并提供：

- **Retry**：重新上传当前图片。
- **Skip**：跳过当前图片，继续处理后续图片。
- **Stop**：停止批次，并可清理本次操作此前新建的远端文件。

清理不会删除被覆盖的文件，因为 GitPaste 没有保存覆盖前的内容。删除本次新建文件前，GitPaste 会重新读取远端 SHA；如果文件已被其他操作修改，则拒绝删除。通过文件选择器或路径/URL 上传时，如果远端上传成功但编辑器写入失败，也会提供清理选项。

## 替换图片

将光标放在行内 Markdown 图片中，例如 `![old](https://example.com/old.png)`，然后从命令面板或编辑器右键菜单运行 **GitPaste: Replace Image at Cursor**。

1. 选择一张替换图片。
2. GitPaste 按正常的文件名和冲突设置上传图片。
3. GitPaste 用新生成的内容替换光标所在的完整 Markdown 图片。
4. 如果旧 URL 能够明确映射到当前配置的仓库、分支和图片目录，GitPaste 会询问是否删除旧远端文件。

引用式图片 `![old][image-id]` 暂不支持替换。无关 URL 或无法反向解析的自定义 URL 模板不会出现删除选项。如果覆盖时使用了同一远端路径，GitPaste 会保留该路径，也不会再次询问删除。

删除 GitHub 文件只会在当前分支创建一个删除 commit，并不会从 Git 历史中彻底抹除文件；CDN 也可能继续提供一段时间的缓存。删除还可能破坏其他文档对同一 URL 的引用，因此 GitPaste 会要求明确确认。

## 配置检查

运行 **GitPaste: Check Configuration** 可以检查：

- 仓库格式、仓库写权限和目标分支访问；
- 仓库路径是否安全、commit 信息是否为空；
- 文件名冲突策略是否合法；
- 文件名、公开 URL 和输出模板是否合法。

自定义公开 URL 必须使用 HTTP(S) 并包含 `${path}`，输出模板必须包含 `${url}`。检查过程是只读的，不会创建测试 commit。GitHub 分支保护或仓库规则仍可能拒绝后续上传，GitPaste 也不会检查自定义 CDN 当前是否可访问。

## 设置

```json
{
  "gitpaste.github.repository": "owner/images",
  "gitpaste.github.branch": "main",
  "gitpaste.github.path": "images",
  "gitpaste.github.publicUrl": "",
  "gitpaste.github.commitMessage": "Upload ${uploadedName} with GitPaste",
  "gitpaste.github.conflictStrategy": "rename",
  "gitpaste.fileNameFormat": "${yyyy}-${MM}-${dd}_${HH}-${mm}-${ss}-${random}${extName}",
  "gitpaste.outputFormat": "![${uploadedName}](${url})",
  "gitpaste.includeImageName": true,
  "gitpaste.maxFileSizeMb": 20,
  "gitpaste.uploadOnPaste": true
}
```

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `gitpaste.github.repository` | `""` | 必填的 `owner/repository` 目标仓库。不同项目使用不同仓库时应保存到工作区。 |
| `gitpaste.github.branch` | `"main"` | 接收上传和删除 commit 的分支；支持包含 `/` 的分支名。 |
| `gitpaste.github.path` | `"images"` | 仓库内图片目录；留空表示仓库根目录，禁止使用 `..` 路径段。 |
| `gitpaste.github.authenticationMethod` | `"github"` | `github` 使用 VS Code 登录；`pat` 使用 `SecretStorage` 中的令牌。通常由配置流程设置。 |
| `gitpaste.github.publicUrl` | `""` | 留空时使用 GitHub 返回的 Raw URL；自定义 HTTP(S) 模板必须包含 `${path}`。 |
| `gitpaste.github.commitMessage` | `"Upload ${uploadedName} with GitPaste"` | 非空的 Git commit 信息模板，支持 `${uploadedName}`。 |
| `gitpaste.github.conflictStrategy` | `"rename"` | 可选 `rename`、`overwrite`、`prompt`，详见“同名文件处理”。 |
| `gitpaste.fileNameFormat` | 日期、时间和随机后缀 | 远端文件名模板。未提供图片扩展名时，会根据源文件名或 MIME 类型自动补充。 |
| `gitpaste.outputFormat` | `![${uploadedName}](${url})` | 插入编辑器的文本；必须包含 `${url}`，可以生成 Markdown 或 HTML。 |
| `gitpaste.includeImageName` | `true` | 设为 `false` 时 `${uploadedName}` 为空，默认输出变为 `![](${url})`。 |
| `gitpaste.maxFileSizeMb` | `20` | 每张图片的客户端大小限制，范围 1-100 MB；GitHub 还可能有额外限制。 |
| `gitpaste.uploadOnPaste` | `true` | 在 VS Code Web 中允许普通粘贴自动上传图片；桌面端有意忽略此项，仍使用专用快捷键。 |

### 模板变量

| 模板 | 可用变量 |
| --- | --- |
| `gitpaste.fileNameFormat` | `${name}`, `${extName}`, `${timestamp}`, `${random}`, `${yyyy}`, `${MM}`, `${dd}`, `${HH}`, `${mm}`, `${ss}`, `${document}` |
| `gitpaste.github.publicUrl` | `${owner}`, `${repository}`, `${branch}`, `${path}` |
| `gitpaste.github.commitMessage` | `${uploadedName}` |
| `gitpaste.outputFormat` | `${uploadedName}`, `${originalName}`, `${url}` |

`${random}` 是 8 位十六进制随机值，`${timestamp}` 是 Unix 纪元起的毫秒数。`${document}` 是替换不安全文件名字符后的当前文档文件名。`${path}` 会按仓库路径的每一段进行 URL 编码。

访问任意外部 HTTP 链接会受到源服务器浏览器跨域（CORS）策略限制。工作区文件与粘贴的图片不受此限制。

## 与 PicGo, vs-picgo 的关系与区别

GitPaste 是基于 MIT 许可证项目
[`PicGo/vs-picgo`](https://github.com/PicGo/vs-picgo) 重写的浏览器兼容扩展。
项目按照 MIT 许可证保留了原作者版权声明，但 GitPaste 是独立项目，并非 PicGo
或 vs-picgo 的官方版本。

| 项目 | 主要定位 | 运行环境 | 存储支持 |
| --- | --- | --- | --- |
| [PicGo](https://github.com/Molunerfinn/PicGo) | 桌面图床上传应用与插件生态 | 桌面应用 | 通过内置上传器和插件支持多种图床 |
| [vs-picgo](https://github.com/PicGo/vs-picgo) | 基于 PicGo 的 VS Code 集成 | 桌面 VS Code 与 PicGo/Node.js 组件 | 使用 PicGo 上传器和配置 |
| GitPaste | 面向编辑器图片粘贴的 VS Code Web Extension | 同一浏览器兼容包运行于 Web 和桌面 VS Code | 当前版本直接使用 GitHub Contents API |

GitPaste 不加载 PicGo 插件，也不读取 PicGo 或 vs-picgo 配置。它使用
`gitpaste.*` 设置，将凭据保存在 VS Code `SecretStorage` 中，并直接调用 GitHub
API 上传。已有的 PicGo 或 vs-picgo 设置需要在 GitPaste 中重新配置。

凭据处理方式是两者一个重要且有意为之的区别。vs-picgo 的 GitHub 上传器要求
在配置文件中填写 token，因此 token 会成为明文配置；GitPaste 则始终将 token
排除在 `gitpaste.*` 设置之外。使用内置 GitHub 登录时，认证由 VS Code 管理；
使用 PAT 时，密钥保存在 `SecretStorage` 中，`settings.json` 只记录所选择的认证方式。
