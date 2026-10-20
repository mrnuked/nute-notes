import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BulletList, TaskList, TaskItem } from '@tiptap/extension-list';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { CodeBlock } from '@tiptap/extension-code-block';
import { Plugin } from '@tiptap/pm/state';
import { validateDocument, plainDocument, documentText } from '../public/assets/document.js';

const StyledBulletList = BulletList.extend({
  addAttributes() { return { listStyle: { default: 'bullet', parseHTML: element => element.dataset.listStyle === 'dash' ? 'dash' : 'bullet', renderHTML: attrs => ({ 'data-list-style': attrs.listStyle }) } }; },
});
const PlainCodeBlock = CodeBlock.extend({
  addAttributes() { return { language: { default: null, parseHTML: () => null, rendered: false } }; },
});
// No HTML is stored. Only schema nodes and validated attributes can be rendered.
// Avoid inline styles so the editor works with NUTE's strict Content-Security-Policy.
const SafeTable = Table.extend({ renderHTML() { return ['div', { class: 'tableWrapper' }, ['table', ['tbody', 0]]]; } });
const cellRenderer = tag => ({ node }) => [tag, { colspan: node.attrs.colspan, rowspan: node.attrs.rowspan, class: `align-${node.attrs.align || 'left'}` }, 0];
const SafeCell = TableCell.extend({ renderHTML: cellRenderer('td') });
const SafeHeader = TableHeader.extend({ renderHTML: cellRenderer('th') });

export function editorExtensions(onError = () => {}) {
  const Limits = Extension.create({
    name: 'nuteDocumentLimits',
    addProseMirrorPlugins() {
      return [new Plugin({ filterTransaction(transaction) {
        if (!transaction.docChanged) return true;
        try { const doc = transaction.doc.toJSON(); validateDocument(doc); if (documentText(doc).length > 500000) throw new Error('Text limit'); return true; }
        catch { onError('Изменение не добавлено: превышен размер заметки или формат не поддерживается.'); return false; }
      } })];
    },
  });
  return [StarterKit.configure({ link: false, blockquote: false, horizontalRule: false, bulletList: false, codeBlock: false, trailingNode: false, heading: { levels: [1, 2, 3] } }),
    StyledBulletList, PlainCodeBlock, TaskList, TaskItem.configure({ nested: true, a11y: { checkboxLabel: (node, checked) => `${checked ? 'Снять отметку' : 'Отметить'}: ${node.textContent || 'Пункт списка'}` } }),
    SafeTable.configure({ resizable: false }), TableRow, SafeCell, SafeHeader, Limits];
}

export function createNoteEditor(element, { onChange, onState = () => {}, onError = () => {} }) {
  let editor = null, noteId = null;
  const active = () => {
    if (!editor) return {};
    return { bold: editor.isActive('bold'), italic: editor.isActive('italic'), underline: editor.isActive('underline'), strike: editor.isActive('strike'),
      title: editor.isActive('heading', { level: 1 }), heading: editor.isActive('heading', { level: 2 }), subheading: editor.isActive('heading', { level: 3 }),
      paragraph: editor.isActive('paragraph') && !['bulletList','orderedList','taskList'].some(type => editor.isActive(type)),
      mono: editor.isActive('codeBlock'), bullet: editor.isActive('bulletList', { listStyle: 'bullet' }), dash: editor.isActive('bulletList', { listStyle: 'dash' }),
      ordered: editor.isActive('orderedList'), checklist: editor.isActive('taskList'), table: editor.isActive('table') };
  };
  function clear() { editor?.destroy(); editor = null; noteId = null; element.replaceChildren(); onState({}); }
  function setNote(note) {
    if (!note) { clear(); return; }
    const doc = note.document || plainDocument(note.body);
    validateDocument(doc);
    if (editor && note.id === noteId && JSON.stringify(editor.getJSON()) === JSON.stringify(doc)) { editor.setEditable(note.deleted === null, false); onState(active()); return; }
    clear(); noteId = note.id;
    editor = new Editor({ element, extensions: editorExtensions(onError), content: doc, editable: note.deleted === null, injectCSS: false,
      enableContentCheck: true,
      editorProps: { attributes: { role: 'textbox', 'aria-label': 'Текст заметки', 'aria-multiline': 'true', spellcheck: 'false', class: 'nute-rich-editor' } },
      onUpdate: ({ editor: current }) => { const document = current.getJSON(); validateDocument(document); onChange(document, documentText(document)); },
      onSelectionUpdate: () => onState(active()), onTransaction: () => onState(active()),
    });
    onState(active());
  }
  function command(name) {
    if (!editor?.isEditable) return false;
    const chain = editor.chain().focus();
    const marks = { bold: 'toggleBold', italic: 'toggleItalic', underline: 'toggleUnderline', strike: 'toggleStrike' };
    if (marks[name]) return chain[marks[name]]().run();
    if (['title','heading','subheading'].includes(name)) return chain.setHeading({ level: { title: 1, heading: 2, subheading: 3 }[name] }).run();
    if (name === 'paragraph') return chain.clearNodes().setParagraph().run();
    if (name === 'mono') return chain.toggleCodeBlock().run();
    if (name === 'bullet' || name === 'dash') {
      if (editor.isActive('bulletList') && !editor.isActive('bulletList', { listStyle: name })) return chain.updateAttributes('bulletList', { listStyle: name }).run();
      return chain.toggleBulletList().updateAttributes('bulletList', { listStyle: name }).run();
    }
    if (name === 'ordered') return chain.toggleOrderedList().run();
    if (name === 'checklist') return chain.toggleTaskList().run();
    if (name === 'table') return editor.isActive('table') || chain.insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run();
    const tableCommands = { 'row-before': 'addRowBefore', 'row-after': 'addRowAfter', 'column-before': 'addColumnBefore', 'column-after': 'addColumnAfter', 'delete-row': 'deleteRow', 'delete-column': 'deleteColumn', 'delete-table': 'deleteTable' };
    if (tableCommands[name]) return chain[tableCommands[name]]().run();
    return false;
  }
  return { setNote, clear, command, active, focus: () => editor?.commands.focus(), destroy: clear };
}
