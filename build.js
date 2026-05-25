#!/usr/bin/env node

/**
 * build.js — 构建博客静态站点
 *
 * 读取 posts/ 目录下所有 .md 文件，解析 frontmatter，转换为 HTML，
 * 填入模板，输出到 _site/ 目录。
 *
 * 用法：node build.js
 */

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { marked } = require('marked');

const POSTS_DIR = path.join(__dirname, 'posts');
const TEMPLATE_DIR = path.join(__dirname, 'template');
const OUTPUT_DIR = path.join(__dirname, '_site');

// 配置 marked
marked.setOptions({
  gfm: true,
  breaks: false,
});

// 确保输出目录存在
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 读取模板
function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATE_DIR, name), 'utf-8');
}

// 标准化日期为字符串，兼容 gray-matter 可能解析出的 Date 对象
function normalizeDate(val) {
  if (!val) return '1970-01-01';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val);
}

// 日期格式化：YYYY-MM-DD → YYYY年MM月DD日
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${y}年${m}月${day}日`;
}

// 简单的字符串替换（用 {{{}}} 避免与 Frontmatter 的 --- 冲突）
function render(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{{${key}}}}`, value);
  }
  return result;
}

// 生成 TOC 链接
function generateTocLinks(html) {
  const headingRegex = /<h([23])[^>]*id="([^"]*)"[^>]*>(.*?)<\/h[23]>/g;
  const links = [];
  let match;

  while ((match = headingRegex.exec(html)) !== null) {
    const level = match[1];
    const id = match[2];
    const text = match[3].replace(/<[^>]*>/g, '');
    const cls = level === '3' ? ' class="toc-h3"' : '';
    links.push(`<a href="#${id}"${cls}>${text}</a>`);
  }

  return links.join('\n          ');
}

// 构建文章列表 HTML
function buildArticleListItem(post) {
  const keywords = (post.frontmatter.tags || []).join(' ');
  const title = post.frontmatter.title || post.slug;
  const excerpt = post.frontmatter.excerpt || post.body.split('\n').find((l) => l.trim() && !l.startsWith('#') && !l.startsWith('!'))?.slice(0, 100) + '...' || '';

  return `<article class="log-row" data-keywords="${keywords} ${title}">
          <span class="log-date">${formatDate(post.frontmatter.date)}</span>
          <div>
            <a href="${post.slug}.html" class="log-title-link"><h3 class="log-title">${title}</h3></a>
            <p class="log-excerpt">${excerpt}</p>
          </div>
        </article>`;
}

// 主构建流程
async function build() {
  console.log('开始构建博客...');

  // 1. 读取所有 markdown 文章
  if (!fs.existsSync(POSTS_DIR)) {
    console.log('posts/ 目录不存在，创建空目录。');
    fs.mkdirSync(POSTS_DIR, { recursive: true });
  }

  const postFiles = fs
    .readdirSync(POSTS_DIR)
    .filter((f) => f.endsWith('.md'));

  if (postFiles.length === 0) {
    console.log('没有文章需要构建。');
  }

  const posts = postFiles
    .map((file) => {
      const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf-8');
      const { data, content } = matter(raw);
      return {
        slug: file.replace(/\.md$/, ''),
        fileName: file,
        frontmatter: data,
        body: content,
        html: marked.parse(content),
      };
    })
    .sort((a, b) => {
      const dateA = normalizeDate(a.frontmatter.date);
      const dateB = normalizeDate(b.frontmatter.date);
      return dateB.localeCompare(dateA);
    });

  // 2. 准备输出目录
  ensureDir(OUTPUT_DIR);
  ensureDir(path.join(OUTPUT_DIR, 'css'));

  // 3. 读取模板
  const postTemplate = readTemplate('post.html');
  const indexTemplate = readTemplate('index.html');
  const articlesTemplate = readTemplate('articles.html');

  // 4. 生成每篇文章的详情页
  console.log(`生成 ${posts.length} 篇文章详情页...`);
  for (const post of posts) {
    const tocLinks = generateTocLinks(post.html);
    const html = render(postTemplate, {
      title: post.frontmatter.title || post.slug,
      date: formatDate(post.frontmatter.date),
      content: post.html,
      toc_links: tocLinks,
    });
    fs.writeFileSync(path.join(OUTPUT_DIR, `${post.slug}.html`), html);
    console.log(`  → ${post.slug}.html`);
  }

  // 5. 生成文章列表页
  console.log('生成文章列表页...');
  const articleListItems = posts.map(buildArticleListItem).join('\n        ');
  const articlesHtml = render(articlesTemplate, {
    article_list: articleListItems,
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'articles.html'), articlesHtml);

  // 6. 生成首页（最近 5 篇）
  console.log('生成首页...');
  const recentPosts = posts.slice(0, 5);
  const recentItems = recentPosts.map(buildArticleListItem).join('\n        ');
  const indexHtml = render(indexTemplate, {
    recent_articles: recentItems,
  });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), indexHtml);

  // 7. 复制静态资源
  console.log('复制静态资源...');
  ['about.html'].forEach((file) => {
    fs.copyFileSync(
      path.join(TEMPLATE_DIR, file),
      path.join(OUTPUT_DIR, file),
    );
  });

  // 递归复制 css 目录
  function copyDir(src, dest) {
    ensureDir(dest);
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
  copyDir(path.join(TEMPLATE_DIR, 'css'), path.join(OUTPUT_DIR, 'css'));

  console.log(`\n构建完成。输出目录: _site/ (${posts.length} 篇文章)`);
}

build().catch((err) => {
  console.error('构建失败:', err);
  process.exit(1);
});
