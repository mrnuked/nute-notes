import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createNoteMenu } from '../public/assets/note-menu.js';
const html = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
function fixture() {
  const dom = new JSDOM(html), doc = dom.window.document, menu = doc.getElementById('note-menu');
  const notes = new Map([['a', { pinned:false, deleted:null }], ['b', { pinned:true, deleted:null }]]), actions = [];
  const bridge = createNoteMenu(menu, { getNote: id => notes.get(id), onAction: (action,id) => actions.push({action,id}) });
  const cards = ['a','b'].map(id => { const card = doc.createElement('button'); card.textContent = id; doc.body.append(card); bridge.bind(card,id); return card; });
  const right = (card, x=100, y=100) => card.dispatchEvent(new dom.window.MouseEvent('contextmenu', {bubbles:true,cancelable:true,clientX:x,clientY:y}));
  return { dom, doc, menu, notes, actions, bridge, cards, right };
}
test('context actions address the right-clicked note, reflect pin state and never use stale targets', () => {
  const f=fixture(); f.cards[0].focus(); f.right(f.cards[1]);
  assert.equal(f.menu.hidden,false); assert.equal(f.menu.querySelector('[data-action=pin] span').textContent,'Открепить заметку');
  f.menu.querySelector('[data-action=pin]').click(); assert.deepEqual(f.actions,[{action:'pin',id:'b'}]); assert.equal(f.menu.hidden,true);
  f.right(f.cards[0]); f.notes.clear(); f.menu.querySelector('[data-action=delete]').click(); assert.equal(f.actions.length,1,'locked or removed target cannot run an action');
  f.dom.window.close();
});
test('trash offers restore and permanent delete; keyboard navigation and dismissal stay within the menu', () => {
  const f=fixture(); f.notes.get('a').deleted=100; f.cards[0].dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));
  assert.equal(f.menu.hidden,false); assert.equal(f.menu.querySelector('[data-action=pin]').hidden,true);
  assert.equal(f.menu.querySelector('[data-action=delete] span').textContent,'Удалить навсегда');
  assert.equal(f.doc.activeElement.dataset.action,'restore');
  f.doc.activeElement.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); assert.equal(f.doc.activeElement.dataset.action,'delete');
  f.doc.activeElement.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})); assert.equal(f.menu.hidden,true); assert.equal(f.doc.activeElement,f.cards[0]);
  f.dom.window.close();
});
test('menu stays inside the viewport and touch scrolling cancels the long press', () => {
  const f=fixture(), win=f.dom.window;
  Object.defineProperty(win,'innerWidth',{value:390}); Object.defineProperty(win,'innerHeight',{value:568});
  f.menu.getBoundingClientRect=()=>({width:286,height:114}); f.right(f.cards[0],389,567);
  assert.ok(parseFloat(f.menu.style.left)+286<=382); assert.ok(parseFloat(f.menu.style.top)+114<=560); f.bridge.close();
  let pending=null; win.setTimeout=callback=>{pending=callback;return 1}; win.clearTimeout=()=>{pending=null};
  const pointer=(type,x,y)=>{const event=new win.Event(type,{bubbles:true}); Object.assign(event,{pointerType:'touch',isPrimary:true,clientX:x,clientY:y}); f.cards[0].dispatchEvent(event)};
  pointer('pointerdown',100,100); assert.ok(pending); pointer('pointermove',100,125); assert.equal(pending,null);
  pointer('pointerdown',100,100); pending(); assert.equal(f.menu.hidden,false);
  let selected=false; f.cards[0].addEventListener('click',()=>{selected=true}); f.cards[0].click(); assert.equal(selected,false,'release after holding must not open the editor');
  f.bridge.close(); assert.equal(f.menu.hidden,true); f.dom.window.close();
});
