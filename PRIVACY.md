# 隐私说明 / Privacy

## 中文

本扩展仅供维护者个人使用。运行数据保存在当前 Chrome 用户资料内的 `chrome.storage.local` 和 IndexedDB。后台逻辑归档区为 IndexedDB 的 `taskArchive`；它不是仓库里的文件夹，也不会自动同步到 GitHub。

- 保存内容：追踪账号、开始和成功检查时间、每日启动标记、任务结果、已下载图片索引及尺寸。Chrome 下载记录还可能包含本地文件路径。
- 网络：访问 X 页面并读取该页面正常发出的 GraphQL 响应，向 `pbs.twimg.com` 请求图片；不读取 Cookie、密码或登录令牌。访问 X 时，X 仍会按自身规则处理浏览器会话和访问数据。
- 没有开发者自建服务器、遥测、广告或数据上传功能。
- 导出迁移备份包含追踪账号、检查时间和成功图片索引，不包含图片文件、登录数据、本地绝对路径、旧任务或后台归档。请自行保管。
- 导出诊断日志包含账号、任务错误、推文来源链接、筛选页、接口操作名和响应状态，不包含完整接口响应或请求参数。分享前请检查内容。
- “清空显示记录”将任务从默认列表隐藏并在本地归档，不删除图片、去重索引或追踪状态。“查看后台记录”可查看最近 40 条后台任务并重试。
- 卸载扩展会清除扩展存储；已经下载的图片、手动导出的备份和日志需自行管理。

权限用途：`storage` 保存设置与任务，`downloads` 保存图片并确认下载完成，`offscreen` 解码校验图片与管理 Blob，`alarms` 恢复进行中的队列。站点权限限于 `x.com`、`twitter.com` 和 `pbs.twimg.com`。

## English

This extension is maintained solely for the owner's personal use. Runtime data stays in the current Chrome profile's `chrome.storage.local` and IndexedDB. The logical background archive is the IndexedDB `taskArchive` store; it is not a repository folder and is not automatically synced to GitHub.

- Stored data: tracked handles, tracking and successful-check timestamps, daily-startup marker, task outcomes, and downloaded-image indices and dimensions. Chrome download records may also contain local file paths.
- Network: visits X pages, observes GraphQL responses normally requested by those pages, and requests images from `pbs.twimg.com`. It does not read cookies, passwords, or login tokens. X still processes the browser session and access data under its own rules.
- No developer-operated backend, telemetry, advertising, or data-upload feature.
- Migration backups contain handles, check timestamps, and completed-image indices. They exclude image files, authentication data, local absolute paths, old tasks, and the background archive. Keep them private.
- Diagnostic exports contain handles, task errors, source-post links, photo-filter state, operation names, and response statuses. They exclude full API responses and request parameters. Review before sharing.
- “Clear displayed records” hides tasks from the default list and archives them locally. It preserves images, deduplication indices, and tracking state. “View background records” shows the latest 40 background tasks and allows retrying failures.
- Uninstalling clears extension storage. Downloaded images and manually exported backups and logs remain under your control.

Permissions: `storage` for settings and tasks, `downloads` for saving images and confirming completion, `offscreen` for decoding/validating images and managing Blobs, and `alarms` for recovering active queues. Host access is limited to `x.com`, `twitter.com`, and `pbs.twimg.com`.
