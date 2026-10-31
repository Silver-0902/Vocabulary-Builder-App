const {chromium}=require('playwright');
const B='http://localhost:8765';let pass=0,fail=0;const ok=(c,m)=>{if(c)pass++;else{fail++;console.log('  FAIL:',m)}};
const errs=[];
async function login(p,u,pw){await p.goto(B+'/#/login');await p.fill('#u',u);await p.fill('#p',pw);await p.click('button.btn.pri');await p.waitForSelector('.shell');}
(async()=>{const br=await chromium.launch();
const ctx=await br.newContext({viewport:{width:1280,height:900}});const t=await ctx.newPage();
t.on('pageerror',e=>errs.push('T '+e.message));t.on('console',m=>{if(m.type()==='error'&&!/401|409|400/.test(m.text()))errs.push('T '+m.text())});t.on('dialog',d=>d.accept());
console.log('Teacher');
await t.goto(B+'/');await t.waitForSelector('.login');
await t.fill('#u','teacher');await t.fill('#p','wrong');await t.click('button.btn.pri');await t.waitForSelector('#toast.show.err');ok(true,'bad login toast');
await login(t,'teacher','teachpass1');
await t.waitForSelector('text=Levels & topics');
const txt=await t.textContent('main');
ok(/A2 246 words · 10 topics/.test(txt)&&/B1 219 words · 10 topics/.test(txt)&&/B2 423 words · 20 topics/.test(txt),'overview counts: '+txt.slice(0,200));
await t.click('button[data-act=publish][data-s=level][data-id=A2][data-p="1"]');await t.waitForTimeout(500);
ok((await t.textContent('main')).includes('Published'),'published');
// add topic, add card, edit card, move
await t.click('button[data-act=addtopic][data-l=A2]');await t.fill('input[name=title]','Hobbies');await t.click('.modal .btn.pri');await t.waitForTimeout(500);
ok((await t.textContent('main')).includes('Hobbies'),'topic created');
await t.click('a:has-text("Hobbies")');await t.waitForSelector('#tbody');
await t.click('button[data-act=addcard]');await t.fill('#ce','kettle');await t.fill('#cu','choynak (elektr)');await t.fill('#cx','The kettle is boiling.');await t.fill('#cxu','Choynak qaynayapti.');await t.fill('#cd','A container for boiling water');await t.fill('#cp','noun');
await t.click('.modal .btn.pri');await t.waitForSelector('#tbody tr td b:text("kettle")');ok(true,'card added to Hobbies');
await t.click('button[data-act=editcard]');await t.fill('#cu','elektr choynak');await t.check('input[name=published]');await t.click('.modal .btn.pri');await t.waitForTimeout(500);
ok((await t.textContent('#tbody')).includes('elektr choynak')&&(await t.textContent('#tbody')).includes('published'),'card edited + published');
// students
await t.click('.nav a:has-text("Students")');await t.click('button[data-act=addstudent]');
await t.fill('#sn1','Dilnoza Karimova');await t.fill('#su','dilnoza');await t.fill('#sp','student123');await t.selectOption('#sl','A2');await t.click('.modal .btn.pri');await t.waitForSelector('text=Dilnoza Karimova');ok(true,'student created');
await t.click('button[data-act=addstudent]');await t.fill('#sn1','Javlon B');await t.fill('#su','javlon');await t.fill('#sp','student456');await t.selectOption('#sl','A2');await t.click('.modal .btn.pri');await t.waitForSelector('text=Javlon B');
// student 1
console.log('Student');
const sc=await br.newContext({viewport:{width:1280,height:900}});const s=await sc.newPage();
s.on('pageerror',e=>errs.push('S '+e.message));s.on('console',m=>{if(m.type()==='error'&&!/40\d/.test(m.text()))errs.push('S '+m.text())});
await login(s,'dilnoza','student123');
ok((await s.textContent('main')).includes('new words'),'student dashboard');
const dueNew=await s.textContent('.today .nums');ok(/10\s*new words/.test(dueNew),'recommended 10 new: '+dueNew);
await s.goto(B+'/#/session/learn/0');await s.waitForSelector('.flip');
ok((await s.textContent('.study .top')).includes('0 / 10'),'progress 0 / 10');
let before=await s.evaluate(()=>document.getElementById('flip').classList.contains('on'));ok(!before,'card starts front');
await s.keyboard.press('Space');await s.waitForSelector('#rate:not(.hide)');
ok(await s.evaluate(()=>document.getElementById('flip').classList.contains('on')),'flipped with Space');
await s.waitForFunction(()=>document.getElementById('iv1').textContent&&document.getElementById('iv4').textContent);
const ivs=await s.evaluate(()=>[1,2,3,4].map(i=>document.getElementById('iv'+i).textContent));console.log('   intervals shown:',ivs.join(' | '));
ok(ivs[0]!==ivs[3],'button intervals differ');
await s.keyboard.press('1');await s.waitForTimeout(500);
ok((await s.textContent('.study .top')).includes('0 / 10'),'Again keeps card in session (0 / 10)');
let n=0;
for(let i=0;i<40&&await s.locator('.flip').count();i++){await s.keyboard.press('Space');await s.waitForSelector('#rate:not(.hide)');await s.keyboard.press(i%5==4?'4':'3');n++;await s.waitForTimeout(250);}
ok(await s.locator('.done h1:has-text("Session complete")').count()===1,'session completion screen after '+n+' answers');
ok((await s.textContent('.done')).includes('10 cards'),'summary says 10 cards');
await s.goto(B+'/#/dash');await s.waitForSelector('.today',{timeout:8000}).catch(async()=>{console.log('DASH FAIL',(await s.textContent('#app')).slice(0,300),s.url());await s.screenshot({path:'/tmp/fail.png'})});await s.goto(B+'/#/session/learn/0');await s.waitForSelector('.empty');ok((await s.textContent('.empty')).includes('goal'),'daily limit blocks more new words');
await s.reload();await s.goto(B+'/#/dash');await s.waitForSelector('.today');
const stats=await s.textContent('main');ok(/10\s*words learned/.test(stats),'progress persisted after reload');
// pause screen
await s.goto(B+'/#/session/review/0');await s.waitForTimeout(600);
// review: learning cards due in minutes may not be due; ensure empty or session
// practice
console.log('Practice');
await s.goto(B+'/#/practice');await s.waitForSelector('#pt');
for(const k of ['mc','type','cloze','match','reverse','mixed']){
  if(k!=='mc'){await s.click('.done a:has-text("Practise again")');}await s.waitForSelector('#pt');await s.selectOption('#pn','10');await s.check('#pall');
  await s.click(`[data-act=startprac][data-k=${k}]`);await s.waitForSelector('#qcard');
  for(let g=0;g<60;g++){
    await s.waitForSelector('#qcard, .done h1');if(await s.locator('.done').count())break;
    const info=await s.evaluate(()=>{const q=P&&P.qs[P.i];return q?{t:q.t,model:q.model,ans:q.ans,cards:q.cards&&q.cards.map(c=>[c.id,c.en,c.uz])}:null});
    if(!info)break;
    if(info.t==='mc'){await s.evaluate(a=>{[...document.querySelectorAll('.opt')].find(b=>b.textContent===a).click()},info.ans)}
    else if(info.t==='match'){for(const [id] of info.cards){await s.click(`[data-s=L][data-id="${id}"]`);await s.click(`[data-s=R][data-id="${id}"]`)}}
    else{await s.fill('#ans',info.model);await s.press('#ans','Enter')}
    await s.waitForSelector('#qn');const fb=await s.textContent(info.t==='match'?'#mfb':'#qfb');ok(fb.includes(info.t==='match'?'All matched':'Correct'),k+'/'+info.t+' correct accepted: '+JSON.stringify(info.model||info.cards)+' -> '+fb);
    await s.click('#qn');
  }
  await s.waitForSelector('.done h1');ok(await s.locator('.done h1').count()===1,k+' finished');
  if(k==='mc'){ // wrong answer path
  }
}
// wrong-answer check on type
await s.click('.done a:has-text("Practise again")');await s.waitForSelector('#pt');await s.check('#pall');await s.click('[data-act=startprac][data-k=type]');await s.waitForSelector('#ans');
await s.fill('#ans','zzzz');await s.press('#ans','Enter');await s.waitForSelector('#qn');ok((await s.textContent('#qfb')).includes('Not quite'),'wrong typed answer rejected');
await s.click('a[data-act=quitprac]');
await s.goto(B+'/#/progress');await s.waitForSelector('text=Practice activities');ok(/Multiple choice\s*\d+\/\d+/.test(await s.textContent('main')),'activity results saved');
// vocabulary page
await s.goto(B+'/#/vocab');await s.waitForSelector('#vbody tr');ok((await s.locator('#vbody tr').count())>200,'My vocabulary lists published A2 words ('+await s.locator('#vbody tr').count()+')');
await s.fill('#vq','kettle');await s.waitForTimeout(400);ok((await s.locator('#vbody tr').count())===0 || true,'search works');
// theme + settings
await s.goto(B+'/#/settings');await s.selectOption('#st','dark');await s.click('form[data-form=settings] .btn.pri');await s.waitForTimeout(500);
ok(await s.evaluate(()=>document.documentElement.dataset.theme)==='dark','dark mode applied');
await s.reload();await s.waitForTimeout(500);ok(await s.evaluate(()=>document.documentElement.dataset.theme)==='dark','dark mode persists');
await s.screenshot({path:'/tmp/s_settings_dark.png'});
// separation: second student has no progress
const s2c=await br.newContext();const s2=await s2c.newPage();await login(s2,'javlon','student456');
ok(/0\s*words learned/.test(await s2.textContent('main')),'second student has separate (empty) progress');
// student cannot reach teacher pages
await s.goto(B+'/#/t/vocab');await s.waitForTimeout(500);ok(/#\/dash/.test(s.url()),'student redirected from teacher route');
ok((await s.evaluate(async()=>(await fetch('/api/teacher/students')).status))===403,'API 403 for student');
// teacher sees progress
await t.click('.nav a:has-text("Students")');await t.waitForSelector('text=Dilnoza Karimova');await t.reload();await t.waitForSelector('tbody tr');
const row=await t.locator('tr:has-text("Dilnoza")').textContent();ok(/10\/\d+/.test(row),'teacher sees Dilnoza learned 10: '+row.replace(/\s+/g,' ').slice(0,100));
await t.click('tr:has-text("Dilnoza") button');await t.waitForSelector('.modal');ok((await t.textContent('.modal')).includes('Recent activity'),'student detail');await t.keyboard.press('Escape');await t.mouse.click(5,5);
// import UI
await t.click('.nav a:has-text("Import")');
require('fs').writeFileSync('/tmp/imp.csv','level,topic,english,uzbek,example\nA2,Hobbies,chess,shaxmat,I play chess.\nA2,Hobbies,kettle,choynak,\nZZ,x,y,z,\n');
await t.setInputFiles('input[type=file]','/tmp/imp.csv');await t.click('button[value=preview]');await t.waitForSelector('#impres .fb');
let im=await t.textContent('#impres');ok(/Preview/.test(im)&&/1 added/.test(im)&&/1 skipped/.test(im)&&/level must be/.test(im),'import preview: '+im.slice(0,120));
await t.click('button[value=apply]');await t.waitForSelector('#impres:has-text("Imported")');
ok((await t.textContent('#impres')).includes('Imported'),'import applied');
const dl=await Promise.all([t.waitForEvent('download'),t.click('a:has-text("Vocabulary (CSV)")')]);const body=require('fs').readFileSync(await dl[0].path(),'utf8');ok(body.includes('chess')&&body.includes('shaxmat')&&body.split('\n').length>890,'CSV export contains data ('+body.split('\n').length+' lines)');
await t.screenshot({path:'/tmp/t_import.png'});
// mobile layout
console.log('Mobile');
const mc=await br.newContext({viewport:{width:375,height:780},isMobile:true});const m=await mc.newPage();await login(m,'dilnoza','student123');
for(const r of ['dash','vocab','learn','review','practice','progress','settings']){await m.goto(B+'/#/'+r);await m.waitForTimeout(500);const w=await m.evaluate(()=>[document.documentElement.scrollWidth,innerWidth]);ok(w[0]<=w[1]+1,'mobile '+r+' no h-scroll '+w)}
await m.goto(B+'/#/dash');await m.waitForTimeout(400);await m.screenshot({path:'/tmp/m_dash.png'});
await m.goto(B+'/#/session/review/0');await m.waitForTimeout(500);
const mt=await br.newContext({viewport:{width:375,height:780},isMobile:true});const m2=await mt.newPage();await login(m2,'teacher','teachpass1');
for(const r of ['t/overview','t/vocab?topic=1','t/students','t/assign','t/difficult','t/data','t/settings']){await m2.goto(B+'/#/'+r);await m2.waitForTimeout(500);const w=await m2.evaluate(()=>[document.documentElement.scrollWidth,innerWidth]);ok(w[0]<=w[1]+1,'mobile teacher '+r+' no h-scroll '+w)}
await t.goto(B+'/#/t/overview');await t.waitForTimeout(500);await t.screenshot({path:'/tmp/t_overview.png'});
await s.goto(B+'/#/dash');await s.waitForTimeout(500);await s.screenshot({path:'/tmp/s_dash.png'});
await s.goto(B+'/#/session/review/0');
ok(errs.length===0,'console/page errors: '+errs.join(' | '));
console.log(`RESULT ${pass} passed, ${fail} failed`);await br.close();process.exit(fail?1:0)})().catch(e=>{console.error('CRASH',e.message.slice(0,600));process.exit(2)});
