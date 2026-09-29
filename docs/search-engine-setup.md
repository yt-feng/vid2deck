# Vid2PPT 搜索引擎配置

代码侧已经准备好以下公开入口：

- `https://vid2ppt.com/robots.txt`
- `https://vid2ppt.com/sitemap.xml`
- `https://vid2ppt.com/blog/feed.xml`
- `https://vid2ppt.com/llms.txt`
- 首页、指南和文章页的 Organization、WebSite、HowTo、BlogPosting、BreadcrumbList、FAQPage 结构化数据

## Google Search Console

1. 打开 [Google Search Console](https://search.google.com/search-console)，添加 Domain property：`vid2ppt.com`。
2. 按页面提示在 DNS 增加 TXT 记录，等待验证完成。
3. 打开「站点地图」，提交：`https://vid2ppt.com/sitemap.xml`。
4. 使用 URL Inspection 检查首页、文章库和一篇文章，提交需要加速抓取的 URL。

Domain property 的验证需要域名 DNS 管理权限。HTML 文件或 meta 验证适用于 URL-prefix property，也需要 Search Console 账号内的验证值。

## Bing Webmaster Tools

1. 打开 [Bing Webmaster Tools](https://www.bing.com/webmasters)，验证 `https://vid2ppt.com/`。
2. 可以从已验证的 Google Search Console 导入站点，也可以使用 DNS、XML 文件或 meta 验证。
3. 提交：`https://vid2ppt.com/sitemap.xml`。
4. 在 IndexNow 页面生成密钥，把名为 `<密钥>.txt` 的文件放入 `public/` 根目录，文件内容写入同一个密钥。
5. 把密钥保存为 GitHub Actions secret：`INDEXNOW_KEY`。之后博客发布或站点地图变化时，`.github/workflows/indexnow.yml` 会通知 IndexNow。

当前工作流会在缺少 `INDEXNOW_KEY` 时跳过通知，站点发布流程保持可用。Google 普通文章使用 sitemap、内部链接和 URL Inspection；Google Indexing API 适用范围不包含普通博客文章。

## 每日文章发布

`.github/workflows/blog-daily.yml` 每天 08:17 UTC 检查 `content/blog-queue.json`。只有 `approved` 且到期的文章会生成页面，同时更新博客索引、sitemap 和 RSS。工作流会创建一个固定分支上的发布 PR，已有 PR 会持续更新，避免重复产生多个 PR；合并后由站点部署流程上线。GitHub 的定时任务需要把这个 workflow 放在仓库默认分支上才会按日触发。
