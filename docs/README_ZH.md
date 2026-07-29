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
2. 按 `owner/repository` 格式填写仓库，然后填写分支和图片目录。
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

需要复制图片本身，而不是图片地址。Web 版中，`Ctrl/Cmd+V` 遇到图片时会上传，遇到文字或其他内容时仍执行普通粘贴。由于浏览器只会通过真实粘贴事件提供图片二进制数据，GitPaste 的专用剪贴板快捷键仅用于桌面版。

上传完成后默认插入 GitHub 返回的 `https://raw.githubusercontent.com/...` 原始链接，不经过第三方 CDN。仅在明确配置 `gitpaste.github.publicUrl` 时才使用自定义 URL 模板。

任意 HTTP 图片 URL 的下载会受到来源网站 CORS 策略限制；工作区文件和直接粘贴的图片不受此限制。

## Settings

```json
{
  "gitpaste.github.repository": "owner/images", // GitHub仓库地址 格式：用户名/仓库名
  "gitpaste.github.branch": "main",              // 目标分支
  "gitpaste.github.path": "images",              // 仓库内存放图片的文件夹路径
  "gitpaste.github.publicUrl": "",               // 自定义公开访问域名（留空使用官方raw地址）
  "gitpaste.fileNameFormat": "${yyyy}-${MM}-${dd}_${HH}-${mm}-${ss}-${random}${extName}", // 上传文件名格式
  "gitpaste.includeImageName": true,              // 是否在图片链接的 [] 中包含上传后的文件名
  "gitpaste.maxFileSizeMb": 20,                  // 最大上传文件大小，单位MB
  "gitpaste.uploadOnPaste": true                 // 粘贴图片时自动开启上传
}
```

GitPaste 默认使用 GitHub 返回的原始下载链接 `https://raw.githubusercontent.com/...`。仅当需要自定义链接模板时，才设置 `gitpaste.github.publicUrl`。
使用 `gitpaste.outputFormat` 可以自定义插入的 Markdown 或 HTML 内容。
将 `gitpaste.includeImageName` 设为 `false` 后，默认输出会从 `![${uploadedName}](${url})` 变为 `![](${url})`。

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
