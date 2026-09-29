import { access, readFile } from 'node:fs/promises';

const site = 'https://vid2ppt.com';
const key = process.env.INDEXNOW_KEY?.trim();
if (!key) {
  console.log('IndexNow skipped: INDEXNOW_KEY is not configured');
  process.exit(0);
}
if (!/^[A-Za-z0-9_-]+$/.test(key)) {
  throw new Error('INDEXNOW_KEY contains unsupported filename characters');
}
const keyLocation = `${site}/${key}.txt`;
try {
  await access(new URL(`../public/${key}.txt`, import.meta.url));
} catch {
  throw new Error(`IndexNow key file is missing: public/${key}.txt`);
}
const sitemap = await readFile(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
const urlList = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((match) => match[1].trim())
  .filter((url) => url.startsWith(`${site}/`) && !url.endsWith('/feed.xml'));

if (urlList.length === 0) {
  throw new Error('sitemap.xml has no site URLs');
}

if (process.env.INDEXNOW_DRY_RUN === '1') {
  console.log(`IndexNow dry run: ${urlList.length} URLs, key location ${keyLocation}`);
  process.exit(0);
}

const response = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: 'vid2ppt.com', key, keyLocation, urlList })
});

if (!response.ok) {
  const body = await response.text();
  throw new Error(`IndexNow returned ${response.status}: ${body.slice(0, 500)}`);
}

console.log(`IndexNow accepted ${urlList.length} URLs (${response.status})`);
