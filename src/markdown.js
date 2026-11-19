'use strict';
const MarkdownIt = require('markdown-it');
const { formatAnswer } = require('./answer-format');
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content || '');
markdown.validateLink = (url) => /^https?:\/\//i.test(url);
function renderMarkdown(text) {
  return markdown.render(String(text));
}
function decorate(event, request = '') {
  if (event.type !== 'message' || event.role !== 'assistant') return event;
  const text = formatAnswer(event.text, request);
  return { ...event, text, html: renderMarkdown(text) };
}
function decorateHistory(events) {
  let request = '';
  return events.map((event) => {
    if (event.type === 'message' && event.role === 'user') request = event.text;
    return decorate(event, request);
  });
}
module.exports = { renderMarkdown, decorate, decorateHistory };
