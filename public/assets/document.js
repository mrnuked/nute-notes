const MAX_DEPTH = 30;
const MAX_NODES = 20000;
const MAX_TEXT = 500000;
const MAX_JSON = 1200000;
const BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'bulletList', 'orderedList', 'taskList', 'table']);
const INLINE = new Set(['text', 'hardBreak']);
const MARKS = new Set(['bold', 'italic', 'underline', 'strike', 'code']);
const TYPES = new Set(['doc', ...BLOCKS, ...INLINE, 'listItem', 'taskItem', 'tableRow', 'tableCell', 'tableHeader']);
const invalid = () => { throw new Error('Повреждён формат документа заметки.'); };
const oversized = () => { throw new Error('Документ слишком большой: превышен допустимый размер.'); };
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

function objectKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid();
  }
}

function attributes(node, allowed = []) {
  if (!Object.hasOwn(node, 'attrs') || node.attrs === null) return {};
  objectKeys(node.attrs, allowed);
  return node.attrs;
}

function validateAttributes(node) {
  let attrs;
  switch (node.type) {
    case 'heading':
      attrs = attributes(node, ['level']);
      if (Object.hasOwn(attrs, 'level') && !integer(attrs.level, 1, 3)) invalid();
      break;
    case 'codeBlock':
      attrs = attributes(node, ['language']);
      if (Object.hasOwn(attrs, 'language') && attrs.language !== null) invalid();
      break;
    case 'bulletList':
      attrs = attributes(node, ['listStyle']);
      if (Object.hasOwn(attrs, 'listStyle') && !['bullet', 'dash'].includes(attrs.listStyle)) invalid();
      break;
    case 'orderedList':
      attrs = attributes(node, ['start', 'type']);
      if (Object.hasOwn(attrs, 'start') && !integer(attrs.start, 1, 1000000)) invalid();
      if (Object.hasOwn(attrs, 'type') && ![null, '1', 'a', 'A', 'i', 'I'].includes(attrs.type)) invalid();
      break;
    case 'taskItem':
      attrs = attributes(node, ['checked']);
      if (typeof attrs.checked !== 'boolean') invalid();
      break;
    case 'tableCell': case 'tableHeader': {
      attrs = attributes(node, ['colspan', 'rowspan', 'colwidth', 'align']);
      for (const name of ['colspan', 'rowspan']) if (Object.hasOwn(attrs, name) && !integer(attrs[name], 1, 100)) invalid();
      if (Object.hasOwn(attrs, 'colwidth') && attrs.colwidth !== null && (!Array.isArray(attrs.colwidth) || attrs.colwidth.length !== (attrs.colspan ?? 1) || !Array.from(attrs.colwidth).every(width => integer(width, 1, 100000)))) invalid();
      if (Object.hasOwn(attrs, 'align') && ![null, 'left', 'center', 'right'].includes(attrs.align)) invalid();
      break;
    }
    default: attributes(node);
  }
}

function validateMarks(node, allowed) {
  if (!Object.hasOwn(node, 'marks')) return;
  if (!allowed || !Array.isArray(node.marks) || node.marks.length > MARKS.size) invalid();
  const seen = new Set();
  for (const mark of node.marks) {
    objectKeys(mark, ['type', 'attrs']);
    if (!MARKS.has(mark.type) || seen.has(mark.type)) invalid();
    attributes(mark);
    seen.add(mark.type);
  }
}

/** Validate the JSON-only allowlist before an imported document reaches an editor. */
export function validateDocument(document) {
  const budget = { nodes: 0, text: 0 };
  function visit(node, depth, allowMarks = true) {
    if (depth > MAX_DEPTH) throw new Error('Превышена допустимая глубина документа.');
    if (++budget.nodes > MAX_NODES) oversized();
    objectKeys(node, ['type', 'attrs', 'content', 'marks', 'text']);
    if (!TYPES.has(node.type)) invalid();
    validateAttributes(node);
    validateMarks(node, allowMarks && INLINE.has(node.type));
    if (node.type === 'text') {
      if (typeof node.text !== 'string' || node.text.length === 0 || Object.hasOwn(node, 'content')) invalid();
      budget.text += node.text.length;
      if (budget.text > MAX_TEXT) oversized();
      return;
    }
    if (Object.hasOwn(node, 'text')) invalid();
    if (node.type === 'hardBreak') {
      if (Object.hasOwn(node, 'content')) invalid();
      return;
    }
    const content = Object.hasOwn(node, 'content') ? node.content : [];
    if (!Array.isArray(content)) invalid();
    let children;
    switch (node.type) {
      case 'paragraph': case 'heading': children = INLINE; break;
      case 'codeBlock': children = new Set(['text']); break;
      case 'bulletList': case 'orderedList': children = new Set(['listItem']); break;
      case 'taskList': children = new Set(['taskItem']); break;
      case 'table': children = new Set(['tableRow']); break;
      case 'tableRow': children = new Set(['tableCell', 'tableHeader']); break;
      default: children = BLOCKS;
    }
    if (!['paragraph', 'heading', 'codeBlock'].includes(node.type) && content.length === 0) invalid();
    if (['listItem', 'taskItem'].includes(node.type) && content[0]?.type !== 'paragraph') invalid();
    for (const child of content) {
      if (!child || !children.has(child.type)) invalid();
      visit(child, depth + 1, node.type !== 'codeBlock');
    }
  }
  if (!document || document.type !== 'doc') invalid();
  visit(document, 1);
  if (JSON.stringify(document).length > MAX_JSON) oversized();
  return document;
}

/** Legacy text is never parsed as HTML or Markdown. Dense line counts use one literal code block. */
export function plainDocument(text) {
  if (typeof text !== 'string') throw new Error('Неподдерживаемый формат текста заметки.');
  if (text.length > MAX_TEXT) oversized();
  const lines = text.split('\n');
  if (1 + lines.length + lines.filter(Boolean).length > 15000) {
    return validateDocument({ type: 'doc', content: [{ type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text }] }] });
  }
  return validateDocument({ type: 'doc', content: lines.map(line => ({ type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}) })) });
}

/** Deterministic search/preview text; validation also applies when called directly. */
export function documentText(document) {
  validateDocument(document);
  function read(node) {
    const content = node.content ?? [];
    switch (node.type) {
      case 'text': return node.text;
      case 'hardBreak': return '\n';
      case 'paragraph': case 'heading': case 'codeBlock': return content.map(read).join('');
      case 'bulletList': return content.map(item => `${node.attrs?.listStyle === 'dash' ? '-' : '•'} ${read(item)}`).join('\n');
      case 'orderedList': return content.map((item, index) => `${(node.attrs?.start ?? 1) + index}. ${read(item)}`).join('\n');
      case 'taskItem': return `${node.attrs.checked ? '☑' : '☐'} ${content.map(read).join('\n')}`;
      case 'tableRow': return content.map(read).join('\t');
      default: return content.map(read).join('\n');
    }
  }
  return read(document);
}
