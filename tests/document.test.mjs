import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument, plainDocument, documentText } from '../public/assets/document.js';

const text = value => ({ type: 'text', text: value });
const paragraph = value => ({ type: 'paragraph', ...(value === '' ? {} : { content: [text(value)] }) });
const doc = (...content) => ({ type: 'doc', content });
const cell = (value, type = 'tableCell') => ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, align: null }, content: [paragraph(value)] });

test('legacy plaintext round-trips all characters and treats markup as literal text', () => {
  for (const value of ['', '\n', '\n\n', 'Первая\nВторая\n', '  пробелы\tи\r\nперенос\rконец', '<script>alert(1)</script>\n<img src=x onerror=alert(1)>', '😀\u0000\u2028\u2029']) {
    const result = plainDocument(value);
    assert.equal(validateDocument(result), result);
    assert.equal(documentText(result), value);
    assert.equal(documentText(JSON.parse(JSON.stringify(result))), value);
  }
  assert.throws(() => plainDocument(null), /формат|текст/i);
  assert.throws(() => plainDocument('x'.repeat(500001)), /размер|длин|больш/i);
});

test('formatting, lists, checklist states and table cells survive JSON conversion', () => {
  const value = doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('Название')] },
    { type: 'paragraph', content: [
      { ...text('Жирный'), marks: [{ type: 'bold' }, { type: 'italic', attrs: null }] },
      { type: 'hardBreak', marks: [{ type: 'underline' }] },
      { ...text('Код'), marks: [{ type: 'code' }] },
    ] },
    { type: 'bulletList', attrs: { listStyle: 'dash' }, content: [{ type: 'listItem', content: [paragraph('Пункт')] }] },
    { type: 'orderedList', attrs: { start: 4, type: '1' }, content: [{ type: 'listItem', content: [paragraph('Четыре')] }, { type: 'listItem', content: [paragraph('Пять')] }] },
    { type: 'taskList', content: [
      { type: 'taskItem', attrs: { checked: false }, content: [paragraph('Купить')] },
      { type: 'taskItem', attrs: { checked: true }, content: [paragraph('Готово')] },
    ] },
    { type: 'table', content: [{ type: 'tableRow', content: [cell('А', 'tableHeader'), cell('Б', 'tableHeader')] }, { type: 'tableRow', content: [cell('Один'), cell('Два')] }] },
    { type: 'codeBlock', attrs: { language: null }, content: [text('const x = 1;\n// текст')] },
  );
  const restored = JSON.parse(JSON.stringify(value));
  assert.deepEqual(validateDocument(restored), value);
  assert.equal(documentText(restored), 'Название\nЖирный\nКод\n- Пункт\n4. Четыре\n5. Пять\n☐ Купить\n☑ Готово\nА\tБ\nОдин\tДва\nconst x = 1;\n// текст');
});

test('legacy notes with thousands of lines preserve literal content inside the node budget', () => {
  for (const value of ['\n'.repeat(25000), '<b>literal</b>\r\n'.repeat(21000), 'x\n'.repeat(250000)]) {
    const result = plainDocument(value);
    assert.equal(validateDocument(result), result);
    assert.equal(result.content[0].type, 'codeBlock');
    assert.equal(documentText(result), value);
  }
});

test('Tiptap defaults and supported attrs are accepted without mutating input', () => {
  const value = doc(
    { type: 'paragraph', attrs: null, content: [] },
    { type: 'heading', attrs: { level: 3 }, content: [] },
    { type: 'bulletList', attrs: {}, content: [{ type: 'listItem', attrs: null, content: [paragraph('•')] }] },
    { type: 'orderedList', attrs: { start: 1, type: null }, content: [{ type: 'listItem', content: [paragraph('1')] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs: { colspan: 2, rowspan: 3, colwidth: [180, 220], align: 'right' }, content: [paragraph('X')] }] }] },
  );
  const snapshot = JSON.stringify(value);
  assert.equal(validateDocument(value), value);
  assert.equal(JSON.stringify(value), snapshot);
});

test('unsupported nodes, marks, attributes and injected properties are rejected', () => {
  const invalid = [
    { type: 'image', attrs: { src: 'javascript:alert(1)' } },
    { type: 'iframe', attrs: { src: 'https://example.com' } },
    { type: 'paragraph', attrs: { onclick: 'alert(1)' } },
    { type: 'paragraph', attrs: { style: 'color:red' } },
    { type: 'paragraph', html: '<script>evil()</script>' },
    { type: 'paragraph', content: [{ ...text('X'), marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] },
    { type: 'paragraph', content: [{ ...text('X'), marks: [{ type: 'bold', attrs: { class: 'evil' } }] }] },
    { type: 'paragraph', content: [{ ...text('X'), marks: [{ type: 'bold' }, { type: 'bold' }] }] },
    { type: 'codeBlock', attrs: { language: 'javascript' }, content: [text('alert(1)')] },
    { type: 'heading', attrs: { level: 7 } },
    { type: 'orderedList', attrs: { start: 0 }, content: [{ type: 'listItem', content: [paragraph('X')] }] },
    { type: 'orderedList', attrs: { type: 'evil' }, content: [{ type: 'listItem', content: [paragraph('X')] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: 'false' }, content: [paragraph('X')] }] },
    { type: 'taskList', content: [{ type: 'taskItem', content: [paragraph('X')] }] },
  ];
  for (const value of invalid) assert.throws(() => validateDocument(doc(value)), /формат|поврежд|атрибут/i);
  assert.throws(() => validateDocument(JSON.parse('{"type":"doc","content":[{"type":"paragraph"}],"__proto__":{"polluted":true}}')));
  assert.throws(() => validateDocument({ ...doc(paragraph('X')), toJSON() { return {}; } }));
  assert.equal({}.polluted, undefined);
});

test('invalid parent-child relationships and malformed cells are rejected', () => {
  const invalid = [
    { type: 'doc', content: [] },
    doc(text('root text')),
    doc({ type: 'paragraph', content: [paragraph('nested')] }),
    doc({ type: 'listItem', content: [paragraph('orphan')] }),
    doc({ type: 'bulletList', content: [paragraph('wrong child')] }),
    doc({ type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'heading', attrs: { level: 1 } }] }] }),
    doc({ type: 'taskList', content: [{ type: 'listItem', content: [paragraph('wrong item')] }] }),
    doc({ type: 'table', content: [cell('wrong child')] }),
    doc({ type: 'table', content: [{ type: 'tableRow', content: [paragraph('wrong cell')] }] }),
    doc({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [text('inline cell')] }] }] }),
    doc({ type: 'codeBlock', content: [{ ...text('X'), marks: [{ type: 'bold' }] }] }),
    doc({ type: 'paragraph', content: [{ type: 'text', text: '' }] }),
    doc({ type: 'paragraph', content: [{ type: 'hardBreak', content: [text('X')] }] }),
  ];
  for (const attrs of [{ colspan: 0 }, { rowspan: 101 }, { colspan: 2, colwidth: [100] }, { colwidth: [0] }, { colwidth: [100001] }, { align: 'justify' }]) {
    invalid.push(doc({ type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', attrs, content: [paragraph('X')] }] }] }));
  }
  for (const value of invalid) assert.throws(() => validateDocument(value), /формат|поврежд|атрибут/i);
});

test('depth, node, total text and serialized-size limits bound imported documents', () => {
  let nested = paragraph('leaf');
  for (let i = 0; i < 16; i++) nested = { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(''), nested] }] };
  assert.throws(() => validateDocument(doc(nested)), /глуб|размер|больш/i);
  assert.doesNotThrow(() => validateDocument(doc(...Array.from({ length: 19999 }, () => paragraph('')))));
  assert.throws(() => validateDocument(doc(...Array.from({ length: 20000 }, () => paragraph('')))), /размер|больш/i);
  assert.doesNotThrow(() => validateDocument(doc(paragraph('x'.repeat(500000)))));
  assert.throws(() => validateDocument(doc(paragraph('x'.repeat(250001)), paragraph('x'.repeat(250000)))), /размер|длин|больш/i);
  assert.throws(() => validateDocument(doc(paragraph('\u0000'.repeat(210000)))), /размер|больш/i);
  const cyclic = { type: 'bulletList', content: [] };
  cyclic.content.push({ type: 'listItem', content: [paragraph(''), cyclic] });
  assert.throws(() => validateDocument(doc(cyclic)), /глуб|размер|больш/i);
});
