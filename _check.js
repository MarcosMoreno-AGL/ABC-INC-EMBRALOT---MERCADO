const fs = require('fs');
const c = fs.readFileSync('index.html','utf8');
['div','section','svg','table','video','script','img'].forEach(tag=>{
  const o=(c.match(new RegExp('<'+tag+'\\b','g'))||[]).length;
  const cl=(c.match(new RegExp('</'+tag+'>','g'))||[]).length;
  console.log(tag,o,cl,tag==='img'?'(self-closing, no closing tag expected)':o-cl);
});
const m = c.match(/<script>([\s\S]*?)<\/script>/);
if(m){
  try { new Function(m[1]); console.log('JS SYNTAX OK'); }
  catch(e) { console.log('JS SYNTAX ERROR:', e.message); }
}
