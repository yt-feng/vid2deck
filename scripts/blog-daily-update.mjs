#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const queuePath = path.join(root, 'content', 'blog-queue.json');
const blogRoot = path.join(root, 'public', 'blog');
const blogIndexPath = path.join(blogRoot, 'index.html');
const sitemapPath = path.join(root, 'public', 'sitemap.xml');
const feedPath = path.join(blogRoot, 'feed.xml');
const forbiddenCopy = ['\u4e0d', '\u4e0d\u662f', '\u800c\u662f', '\u5148', '\u518d', '\u5e76\u975e'];

const args = new Set(process.argv.slice(2));
const dateArgumentIndex = process.argv.indexOf('--date');
const requestedDate = dateArgumentIndex >= 0 ? process.argv[dateArgumentIndex + 1] : undefined;
const dryRun = args.has('--dry-run');

function fail(message) {
  console.error(`blog-daily-update: ${message}`);
  process.exitCode = 1;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function jsonLd(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function assertQueueEntry(entry, index) {
  const required = ['slug', 'status', 'publishDate', 'tag', 'title', 'description', 'lead', 'minutes', 'keywords', 'sections', 'faq'];
  for (const key of required) {
    if (entry[key] === undefined || entry[key] === null || entry[key] === '') {
      throw new Error(`queue item ${index + 1} is missing ${key}`);
    }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug)) throw new Error(`queue item ${index + 1} has an unsafe slug`);
  if (!['draft', 'approved', 'published'].includes(entry.status)) throw new Error(`queue item ${index + 1} has an invalid status`);
  if (!validDate(entry.publishDate)) throw new Error(`queue item ${index + 1} has an invalid publishDate`);
  if (!Number.isInteger(entry.minutes) || entry.minutes < 1 || entry.minutes > 30) throw new Error(`queue item ${index + 1} has an invalid minutes value`);
  if (!Array.isArray(entry.sections) || entry.sections.length < 2) throw new Error(`queue item ${index + 1} needs at least two sections`);
  if (!Array.isArray(entry.faq) || entry.faq.length < 2) throw new Error(`queue item ${index + 1} needs at least two FAQ items`);
  const text = JSON.stringify(entry);
  for (const token of forbiddenCopy) {
    if (text.includes(token)) throw new Error(`queue item ${index + 1} contains forbidden copy token ${token}`);
  }
}

function assertDate(value) {
  if (value && !validDate(value)) throw new Error(`date must use YYYY-MM-DD: ${value}`);
  return value || new Date().toISOString().slice(0, 10);
}

function articlePath(entry) {
  return path.join(blogRoot, entry.slug, 'index.html');
}

function dateLabel(date) {
  const [year, month, day] = date.split('-');
  return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
}

function cardMarkup(entry) {
  return `          <a class="article-card" href="/blog/${escapeHtml(entry.slug)}/">\n            <span class="tag">${escapeHtml(entry.tag)}</span><h3>${escapeHtml(entry.title)}</h3><p>${escapeHtml(entry.description)}</p><span class="meta"><span>${dateLabel(entry.publishDate)} · ${entry.minutes} 分钟</span><span class="read">阅读文章 →</span></span>\n          </a>\n`;
}

function articleMarkup(entry) {
  const canonical = `https://vid2ppt.com/blog/${entry.slug}/`;
  const breadcrumb = [
    { '@type': 'ListItem', position: 1, name: '首页', item: 'https://vid2ppt.com/' },
    { '@type': 'ListItem', position: 2, name: '文章', item: 'https://vid2ppt.com/blog/' },
    { '@type': 'ListItem', position: 3, name: entry.title, item: canonical },
  ];
  const article = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: entry.title,
    description: entry.description,
    author: { '@type': 'Organization', name: 'Vid2PPT', url: 'https://vid2ppt.com/' },
    publisher: { '@type': 'Organization', name: 'Vid2PPT', url: 'https://vid2ppt.com/' },
    datePublished: entry.publishDate,
    dateModified: entry.publishDate,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    image: 'https://vid2ppt.com/brand/vid2ppt-mark-concept.png',
    inLanguage: 'zh-CN',
    timeRequired: `PT${entry.minutes}M`,
    isAccessibleForFree: true,
    keywords: entry.keywords,
  };
  const faq = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: entry.faq.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
  const sections = entry.sections.map((section) => `      <h2>${escapeHtml(section.heading)}</h2>\n${section.paragraphs.map((paragraph) => `      <p>${escapeHtml(paragraph)}</p>`).join('\n')}`).join('\n');
  const faqMarkup = entry.faq.map((item) => `        <details><summary>${escapeHtml(item.question)}</summary><p>${escapeHtml(item.answer)}</p></details>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(entry.title)}｜Vid2PPT</title>
  <meta name="description" content="${escapeHtml(entry.description)}" />
  <link rel="canonical" href="${canonical}" /><link rel="icon" type="image/svg+xml" href="/brand/vid2ppt-mark.svg" /><link rel="stylesheet" href="/blog/blog.css" />
  <meta property="og:type" content="article" /><meta property="og:site_name" content="Vid2PPT" /><meta property="og:title" content="${escapeHtml(entry.title)}" /><meta property="og:description" content="${escapeHtml(entry.description)}" /><meta property="og:url" content="${canonical}" /><meta property="og:image" content="https://vid2ppt.com/brand/vid2ppt-mark-concept.png" />
  <script type="application/ld+json">${jsonLd(article)}</script>
  <script type="application/ld+json">${jsonLd({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: breadcrumb })}</script>
  <script type="application/ld+json">${jsonLd(faq)}</script>
</head>
<body>
  <div class="blog-wrap"><header class="blog-nav"><a class="blog-brand" href="/" aria-label="Vid2PPT 首页"><img src="/brand/vid2ppt-mark.svg" alt="" /><span>Vid2PPT</span></a><nav class="blog-links" aria-label="主要导航"><a href="/blog/" aria-current="page">文章</a><a href="/guide/">使用指南</a><a href="/pricing/">套餐与价格</a><a href="/contact/">联系支持</a><a class="blog-cta" href="/#start">开始整理视频</a></nav></header></div>
  <main class="article-shell" id="mainContent">
    <nav class="breadcrumbs" aria-label="面包屑"><a href="/">首页</a><span aria-hidden="true">/</span><a href="/blog/">文章</a><span aria-hidden="true">/</span><span>${escapeHtml(entry.tag.split(' · ')[0])}</span></nav>
    <header class="article-header"><p class="tag">${escapeHtml(entry.tag)}</p><h1>${escapeHtml(entry.title)}</h1><p class="lead">${escapeHtml(entry.lead)}</p><div class="article-meta"><span>更新于 ${dateLabel(entry.publishDate)}</span><span>阅读约 ${entry.minutes} 分钟</span><span>Vid2PPT 编辑部</span></div></header>
    <article class="article-content">
${sections}
      <section class="article-faq" aria-labelledby="faqTitle"><h2 id="faqTitle">常见问题</h2>
${faqMarkup}
      </section>
      <div class="article-cta"><p>手里有一段课程、会议或培训视频？上传后直接查看页面笔记。</p><a href="/#start">开始整理视频 →</a></div>
    </article>
  </main>
  <footer class="blog-footer"><a href="/">首页</a><a href="/blog/">文章</a><a href="/guide/">使用指南</a><a href="/pricing/">套餐与价格</a><a href="/privacy/">隐私说明</a><span>© 2026 Vid2PPT</span></footer>
</body>
</html>
`;
}

function updateIndex(entry) {
  const current = fs.readFileSync(blogIndexPath, 'utf8');
  const marker = '          <!-- DAILY_ARTICLES -->';
  if (!current.includes(marker)) throw new Error('blog index is missing the DAILY_ARTICLES marker');
  if (current.includes(`/blog/${entry.slug}/`)) throw new Error(`blog index already contains ${entry.slug}`);
  return current.replace(marker, `${cardMarkup(entry)}${marker}`);
}

function updateSitemap(entry) {
  const current = fs.readFileSync(sitemapPath, 'utf8');
  const url = `https://vid2ppt.com/blog/${entry.slug}/`;
  if (current.includes(url)) throw new Error(`sitemap already contains ${entry.slug}`);
  const item = `  <url><loc>${url}</loc><lastmod>${entry.publishDate}</lastmod><priority>0.7</priority></url>\n`;
  return current.replace('</urlset>', `${item}</urlset>`);
}

function updateFeed(entry) {
  if (!fs.existsSync(feedPath)) return null;
  const current = fs.readFileSync(feedPath, 'utf8');
  const url = `https://vid2ppt.com/blog/${entry.slug}/`;
  if (current.includes(url)) throw new Error(`RSS feed already contains ${entry.slug}`);
  const date = new Date(`${entry.publishDate}T00:00:00Z`).toUTCString();
  const item = `    <item>\n      <title>${escapeHtml(entry.title)}</title>\n      <link>${url}</link>\n      <guid isPermaLink="true">${url}</guid>\n      <pubDate>${date}</pubDate>\n      <description>${escapeHtml(entry.description)}</description>\n    </item>\n`;
  return current.replace(/<lastBuildDate>[^<]+<\/lastBuildDate>/, `<lastBuildDate>${date}</lastBuildDate>`)
    .replace('  </channel>', `${item}  </channel>`);
}

function validateExistingBlogPages() {
  const pages = fs.readdirSync(blogRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(blogRoot, entry.name, 'index.html')).filter((filePath) => fs.existsSync(filePath));
  for (const filePath of pages) {
    const html = fs.readFileSync(filePath, 'utf8');
    for (const token of forbiddenCopy) {
      if (html.includes(token)) throw new Error(`existing blog page contains forbidden copy token ${token}: ${path.relative(root, filePath)}`);
    }
  }
}

function main() {
  const publishDate = assertDate(requestedDate);
  const queue = readJson(queuePath);
  if (!Array.isArray(queue)) throw new Error('blog queue must be an array');
  const slugs = new Set();
  queue.forEach((entry, index) => {
    assertQueueEntry(entry, index);
    if (slugs.has(entry.slug)) throw new Error(`duplicate queue slug: ${entry.slug}`);
    slugs.add(entry.slug);
  });
  validateExistingBlogPages();
  const due = queue.filter((entry) => entry.status === 'approved' && entry.publishDate <= publishDate).sort((left, right) => left.publishDate.localeCompare(right.publishDate));
  if (due.length === 0) {
    console.log(`blog-daily-update: no approved article due on ${publishDate}`);
    return;
  }
  const entry = due[0];
  if (fs.existsSync(articlePath(entry))) throw new Error(`article already exists for ${entry.slug}; mark the queue item published`);
  const nextQueue = queue.map((item) => item.slug === entry.slug ? { ...item, status: 'published', publishedAt: publishDate } : item);
  const nextIndex = updateIndex(entry);
  const nextSitemap = updateSitemap(entry);
  const nextFeed = updateFeed(entry);
  console.log(`blog-daily-update: ${dryRun ? 'would publish' : 'publishing'} ${entry.slug} for ${publishDate}`);
  if (dryRun) return;
  fs.mkdirSync(path.dirname(articlePath(entry)), { recursive: true });
  fs.writeFileSync(articlePath(entry), articleMarkup(entry));
  fs.writeFileSync(blogIndexPath, nextIndex);
  fs.writeFileSync(sitemapPath, nextSitemap);
  if (nextFeed) fs.writeFileSync(feedPath, nextFeed);
  writeJson(queuePath, nextQueue);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
