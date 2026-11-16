const {test}=require('node:test');
const assert=require('node:assert/strict');
const Model=require('../web/model.js');
const base=()=>({app:'kartochki',version:1,decks:{d1:{id:'d1',name:'Тест',cards:[{id:'c1',front:'Вопрос',back:'Ответ'}]}},settings:{theme:'dark',newPerDay:20}});
test('legacy cards get scheduling defaults; collection roundtrip preserves progress',()=>{
 const x=base();x.decks.d1.newLog={date:'2026-11-16',count:8};x.decks.d1.cards[0].state='review';x.decks.d1.cards[0].interval=12;
 const result=Model.decode(JSON.stringify(x));assert.equal(result.decks.d1.cards[0].ease,2.5);assert.equal(result.decks.d1.cards[0].interval,12);assert.equal(result.decks.d1.newLog.count,8);
 assert.deepEqual(Model.decode(JSON.stringify(result)),result);
});
test('dangerous ids cannot become HTML or prototype keys',()=>{
 const x=base();x.decks.d1.id='__proto__';x.decks.d1.cards[0].id='c" onclick="alert(1)';
 const result=Model.collection(x);assert.equal(Object.getPrototypeOf(result.decks),null);assert.match(result.decks.__proto__.cards[0].id,/^c[a-z0-9]+$/);
});
test('reject malformed collections and unsupported versions without partial imports',()=>{
 for(const mutate of [x=>x.version=2,x=>x.decks.d1.cards=null,x=>x.decks.d1.cards.push(null),x=>x.decks.d1.cards[0].freq=0,x=>x.decks.d1.cards[0].due=Infinity,x=>x.settings.newPerDay=-1,x=>x.settings.theme='\" autofocus onfocus=alert(1)']){
  const x=base();mutate(x);assert.throws(()=>Model.collection(x));
 }
 assert.throws(()=>Model.decode('{broken'));
});
test('CSV quoted multiline cells, escaped quotes, CRLF and header records',()=>{
 assert.deepEqual(Model.records('q;a\r\n"hello; world";"line 1\nline ""2"""\r\n',';'),[['q','a'],['hello; world','line 1\nline "2"']]);
 assert.throws(()=>Model.records('"unclosed;answer',';'));
});
test('backup import gets unique ids while keeping progress and daily log',()=>{
 const x=base();x.decks.d1.newLog={date:'2026-11-16',count:4};x.decks.d1.cards[0].reps=19;
 const y=Object.values(Model.collection(x,true).decks)[0];assert.notEqual(y.id,'d1');assert.notEqual(y.cards[0].id,'c1');assert.equal(y.cards[0].reps,19);assert.equal(y.newLog.count,4);
});
