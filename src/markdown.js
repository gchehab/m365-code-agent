'use strict';
const MarkdownIt = require('markdown-it');
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content || '');
markdown.validateLink = url => /^https?:\/\//i.test(url);
function renderMarkdown(text) { return markdown.render(String(text)); }
function decorate(event) { return event.type === 'message' && event.role === 'assistant' ? { ...event, html: renderMarkdown(event.text) } : event; }
module.exports = { renderMarkdown, decorate };
