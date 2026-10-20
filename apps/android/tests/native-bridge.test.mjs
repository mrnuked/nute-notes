import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../app/src/main/native-bridge.js', import.meta.url), 'utf8');
function harness(origin = 'https://appassets.androidplatform.net', top = true) {
  const messages = [], timers = new Map(); let serial = 0;
  const window = { NuteAndroid: { postMessage(value) { messages.push(JSON.parse(value)); } } }; window.top = top ? window : {};
  vm.runInNewContext(source, { window, location: { origin }, setTimeout(callback) { timers.set(++serial, callback); return serial; }, clearTimeout(id) { timers.delete(id); } });
  return { window, messages, timers, reply(value) { window.NuteAndroid.onmessage({ data: JSON.stringify(value) }); } };
}
test('bridge exists only in the packaged top-level origin and exposes the exact frozen contract', () => {
  assert.equal(harness('https://notes.example.org').window.NuteNative, undefined);
  assert.equal(harness(undefined, false).window.NuteNative, undefined);
  const h = harness(); assert.equal(Object.isFrozen(h.window.NuteNative), true);
  assert.deepEqual(Object.keys(h.window.NuteNative).sort(), ['ack','clear','enqueue','load','openExternal','request','save','saveFile']);
  assert.equal(Object.getOwnPropertyDescriptor(h.window,'NuteNative').writable, false);
});
test('Promise responses preserve API status and reject only native transport errors', async () => {
  const h = harness(); const request = h.window.NuteNative.request({ action:'sync_pull', method:'POST', data:{after:4} });
  assert.equal(h.messages[0].method, 'request'); assert.equal(h.messages[0].value.data.after, 4);
  h.reply({ id:h.messages[0].id, result:{status:401,body:{error:'unauthorized'}} }); assert.equal((await request).status,401);
  const failure = h.window.NuteNative.load(); h.reply({id:h.messages[1].id,error:'Offline'}); await assert.rejects(failure,/Offline/); assert.equal(h.timers.size,0);
});
test('parallel calls resolve by ID and a timeout cannot consume a later reply', async () => {
  const h=harness(), first=h.window.NuteNative.load(), second=h.window.NuteNative.ack({ids:[]});
  h.reply({id:h.messages[1].id,result:{ok:true}}); assert.equal((await second).ok,true);
  const timeout = [...h.timers.values()][0]; timeout(); await assert.rejects(first,/не ответило/);
  h.reply({id:h.messages[0].id,result:{cache:'too late'}});
  const save=h.window.NuteNative.saveFile({name:'backup.json',data:'{}'}); assert.equal(h.messages.at(-1).method,'saveFile');
  h.reply({id:h.messages.at(-1).id,result:{ok:true}}); assert.equal((await save).ok,true);
});
