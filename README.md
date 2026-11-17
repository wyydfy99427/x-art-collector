# X Art Collector · 画师原图收藏

**仅供维护者本人个人使用与跨电脑备份 / For the maintainer's personal use and cross-device backup only.**

Chrome Manifest V3 · v0.1.3 · Chrome 127+

[中文](#中文) · [English](#english) · [隐私 / Privacy](PRIVACY.md)

## 中文

### 项目定位与使用边界

这是我为自己整理 X（原 Twitter）图片收藏制作的个人工具。此私有仓库用于保存源码和安装包，方便我换电脑后重新安装。它不是公共图片库、内容分发服务或 X 官方产品，也不代表 X 或任何画师的认可。

仅在自己拥有相应权利、已获许可或适用法律允许的范围内保存内容。尊重创作者意愿、版权、隐私和平台规则；个人使用声明本身不构成下载授权。不得使用本工具绕过付费墙、私密账号权限、验证码、访问控制或平台限制，不得用于侵权转载、售卖作品、骚扰或未经许可的数据集收集。

本仓库及发布包只包含扩展代码、文档和使用合成数据的测试，不包含画师作品、真实个人追踪名单、登录资料或运行日志。请遵守 [GitHub 可接受使用政策](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)及相关权利要求。上述说明不能保证任何具体使用方式均符合所有法律或服务条款。

### 功能

- 按账号保存原创推文中的静态图片，可限定日期；排除回复、转推、引用内容中的图片、视频和 GIF。不自动识别画作与截图。
- 明确进入照片分类，请求 X 提供的 `orig` 图片版本，保存前验证文件类型和解码尺寸。若提供了原图尺寸，文件必须达到该尺寸；失败不改存缩略图。
- 最多追踪 **200 位画师**。在扩展里手动开启追踪，保存开启后发布的新图；X 网站上的“关注”不会自动导入。
- 每天首次启动 Chrome 时检查一次并自动下载新图；当天不重复自动检查。失败显示红色 `!`，支持手动重试。
- 逐个扫描画师，同时最多下载 3 张图片。按推文 ID 和图片序号去重，支持中断后重新扫描与手动补下载。
- **清空显示记录**：隐藏任务和失败记录，后台保留检查时间、失败状态及去重索引；不停止任务或删除已下载图片。
- **查看后台记录**：查看最近 40 条后台任务并重试。后台归档位于 Chrome 扩展 IndexedDB 的 `taskArchive` 区，不写入代码目录或 GitHub。
- **导出／导入迁移备份**：迁移追踪名单、成功检查时间和已下载索引。图片文件需另行复制。

### 安装与更新

1. 从此私有仓库的 Releases 下载版本 ZIP，解压到固定文件夹；也可下载源码，使用含 `manifest.json` 的项目目录。
2. 在 Chrome 打开 `chrome://extensions/`，开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择含 `manifest.json` 的文件夹。
4. 固定扩展图标，在同一个 Chrome 用户资料中登录 X。
5. 打开画师主页使用“收藏历史原图”，或在弹窗输入账号并选择日期。

更新时覆盖原目录，在扩展管理页“重新加载”并刷新 X 页面。**不要卸载旧扩展**，以保留本机追踪和去重数据。默认保存到 Chrome 下载目录的 `X-Art/画师账号/`；文件名为 `UTC发布时间_推文ID_图片序号.原始格式`。日期筛选按电脑本地时区，包含结束当天。

批量下载前建议关闭 Chrome 的“下载前询问每个文件的保存位置”。保持扫描标签页打开和网络可用，可切到其他标签页。扩展不修改浏览器的安全或网络设置。

### 每日追踪与清空记录

开启追踪不立即下载旧图。每天首次启动 Chrome 时从上次成功检查时间继续补查；新图全部成功保存后才推进时间。可随时点击“立即检查 / 重试”使用相同链路主动检查。

“每天”按电脑本地日期判断，要求 Chrome 真正启动；关闭窗口但保留后台进程可能不会触发。安装或重新加载扩展不等于浏览器重启，运行中跨过午夜也不会触发定时检查。

清空显示后，原有失败仍需手动处理，不会被标记为成功，也不会因为清空而在下次启动自动重试。可从追踪列表“立即检查 / 重试”或“查看后台记录”继续处理。运行中的任务继续执行；之后创建的新任务正常显示。默认和后台查看区均显示最近 40 条记录。

### 换电脑

1. 在旧电脑“导出迁移备份”，妥善保存 JSON；另行复制下载目录的 `X-Art` 图片文件夹。
2. 在新电脑登录自己的 GitHub，下载私有仓库安装包并加载扩展，再在 X 登录自己的账号。
3. 复制图片文件夹并“导入迁移备份”。导入合并追踪名单和成功索引，不覆盖现有正在执行的任务。
4. 点击“立即检查 / 重试”确认补查正常。新电脑的每日启动标记独立计算。

备份**不包含图片、登录凭据、运行任务或后台历史归档**。若未复制图片却导入成功索引，扩展仍跳过这些图片；需要时勾选“重新下载已保存图片”并限定日期补回。GitHub 只保管程序，不自动同步个人追踪数据。

### 隐私、限制与测试

运行数据保存在本机，没有开发者服务器或遥测。备份含个人追踪信息，不要提交到仓库；诊断日志分享前需检查内容。详见 [PRIVACY.md](PRIVACY.md)。

“原图”指 X 当前提供的最高规格版本，不保证与上传前源文件一致，不会将小图放大成 4K。未提供原始尺寸时，只能验证 `orig` 响应与解码尺寸。历史加载限制、限流和页面变化可能导致无法获取全部内容，扩展不绕过这些限制。

维护者已验证过真实页面的历史下载；自动新图下载、200 位排队、清空后状态保留和迁移恢复有隔离 Chrome 集成测试。测试使用合成 X 响应，不代表所有账号或真实 Chrome 重启场景都已验收。

运行扩展无需 Node.js。开发测试与打包：

```powershell
npm install
npm test
# 需安装 Chrome；可用 CHROME_PATH 指定其他安装位置。
npm run test:chrome
./scripts/package.ps1
```

打包脚本只收录明确列出的程序和文档，生成 SHA-256 文件，不打包个人备份、日志、图片或浏览器资料。源码保留全部权利，不授予转载或商业使用许可，见 [LICENSE](LICENSE)；不改变第三方作品权利归属。

## English

### Purpose and permitted use

This is a personal tool I built to organize my own X (formerly Twitter) image collection. This private repository stores source and installation packages so I can reinstall it on another computer. It is not a public image archive, a content-distribution service, or an official X product, and is not endorsed by X or any artist.

Save content only when you hold the necessary rights, have permission, or are allowed under applicable law. Respect creators' wishes, copyright, privacy, and platform rules. A personal-use statement does not itself grant permission to download. Do not bypass paywalls, private-account permissions, CAPTCHAs, access controls, or platform restrictions, or use this tool for infringing redistribution, artwork sales, harassment, or unauthorized dataset collection.

The repository and release packages contain only extension code, documentation, and tests using synthetic data. They contain no artists' works, real personal watch lists, authentication data, or runtime logs. Follow the [GitHub Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies) and applicable rights requirements. These statements do not guarantee that every use complies with every law or service's terms.

### Features

- Save static images from an account's original posts, optionally within a date range. Excludes replies, reposts, images inside quoted posts, videos, and GIFs. Does not distinguish artwork from screenshots.
- Explicitly selects photos and requests X's `orig` version. Checks file signatures and decoded dimensions; files must meet declared original dimensions when available. Failed originals are not replaced with thumbnails.
- Track up to **200 artists**, enabled manually in the extension. Only posts published after tracking begins are eligible. X follows are not automatically imported.
- Check once on the first Chrome startup of each local day and download new images. Failures show a red `!` and support manual retries.
- Scan artists sequentially and download at most three images concurrently. Persistent post-ID/media-index deduplication, rescanning after interruptions, and optional redownloads.
- **Clear displayed records** hides tasks and failures while retaining check cursors, failure state, and deduplication indices. It does not stop tasks or delete images.
- **View background records** shows the latest 40 background tasks and supports retries. The archive is the `taskArchive` store in local extension IndexedDB, not a folder committed to GitHub.
- **Export/import migration backup** transfers watches, successful-check cursors, and completed-image indices. Image files must be copied separately.

### Install and update

1. Download a version ZIP from this private repository's Releases and extract it to a stable folder, or download the source and use the directory containing `manifest.json`.
2. Open `chrome://extensions/` and enable Developer mode.
3. Choose “Load unpacked” and select the folder containing `manifest.json`.
4. Pin the extension and sign in to X in the same Chrome profile.
5. Visit an artist's profile and collect historical images, or enter a handle and date range in the popup.

To update, replace the files in the existing directory, reload the extension, and refresh X tabs. **Do not uninstall the existing extension** if you want to retain local tracking and deduplication state. Files go to `X-Art/artist_handle/` under Chrome's default downloads directory. Names follow `UTC_timestamp_postID_mediaIndex.originalFormat`. Date filters use the computer's local timezone and include the end date.

For batch downloads, consider disabling Chrome's “Ask where to save each file before downloading” setting. Keep the scanning tab open and the network available; other tabs remain usable. The extension does not change browser security or network settings.

### Daily tracking and clearing records

Enabling tracking does not immediately download old posts. The first Chrome startup each day checks back to the last successful cursor. That cursor advances only after all new images in the task are saved successfully. “Check now / Retry” runs the same pipeline manually.

A day uses the computer's local date and requires a genuine Chrome startup. Closing windows while background processes remain may not trigger it. Installing or reloading the extension is not a browser restart; crossing midnight with Chrome open does not trigger a scheduled check.

Clearing records does not silently resolve failures or automatically retry them on the next startup. Use “Check now / Retry” in the watch list or “View background records” to handle them. Active tasks continue; newly created tasks appear normally. Both task views show the latest 40 records.

### Move to another computer

1. Export a migration JSON backup on the old computer and keep it private. Separately copy the downloaded `X-Art` folder.
2. Sign in to your GitHub on the new computer, download the private package, load the extension, and sign in to X.
3. Copy the images and import the backup. Import merges watches and completed indices without replacing active tasks.
4. Use “Check now / Retry” to verify catch-up checks. The new computer keeps its own daily-startup marker.

Backups **exclude images, credentials, active tasks, and the background-history archive**. Importing completed indices without copying images still causes those images to be skipped; use the redownload checkbox and date range if needed. GitHub stores the program, not automatic personal-state sync.

### Privacy, limitations, and testing

Runtime state stays local, with no developer-operated server or telemetry. Backups contain personal watch information and should not be committed. Review logs before sharing. See [PRIVACY.md](PRIVACY.md).

“Original” means the highest-specification version currently offered by X, which may differ from the pre-upload source. Small images are not upscaled to 4K. Without declared original dimensions, only the `orig` response and decoded dimensions can be checked. Historical loading restrictions, rate limits, and changing page structures may prevent complete collection. The extension does not bypass those restrictions.

The maintainer has tested historical downloads on a real page. Isolated Chrome tests cover new-image automatic downloads, 200-watch scheduling, state preservation after clearing, and backup restoration. Synthetic-response tests do not certify every account or real browser-restart scenario.

Node.js is unnecessary for using the extension. Development and packaging:

```powershell
npm install
npm test
# Chrome must be installed; set CHROME_PATH for another executable location.
npm run test:chrome
./scripts/package.ps1
```

Packaging uses an explicit allowlist of code and documentation and produces a SHA-256 file. Personal backups, logs, images, and browser profiles are excluded. Source rights are reserved; redistribution or commercial-use permission is not granted. See [LICENSE](LICENSE). Third-party content rights remain with their holders.
