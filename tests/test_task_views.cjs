// Optional browser regression: NODE_PATH=<playwright node_modules> node tests/test_task_views.cjs
// Offline fixtures only; no Paperclip requests or writes.
const {chromium} = require('playwright');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const assert = require('node:assert/strict');

(async()=>{
  const browser = await chromium.launch({headless:true, ...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error=>errors.push(error.message));
    await page.route('**/*', route=>route.fulfill({contentType:'text/html', body:
      readFileSync(join(__dirname,'../index.html'),'utf8').replace('boot();','/* offline fixture */')}));
    await page.goto('http://paperclip.test/');
    await page.evaluate(()=>{
      selected = 'pl'; names = {pl:'PL',qa:'QA'}; agents = [{id:'pl',name:'PL'}];
      const run = (id, agentId, start, end, status='succeeded') => ({id,agentId,agentName:names[agentId],status,startedAt:start,finishedAt:end});
      const base = {relation:'assigned',priority:'medium',status:'in_progress',phase:1,
        lastActivityAt:'2026-10-22T08:00:00Z',children:{total:0,done:0},comments:{total:0,latest:[]},checklist:null,
        runs:{total:3,active:0,failed:0},title:'并行任务 <script>unsafe</script>'};
      tasks = [
        {...base,id:'one',identifier:'HER-1',attempts:[
          run('a','pl','2026-10-22T08:00:00Z','2026-10-22T08:05:00Z'),
          run('b','pl','2026-10-22T08:02:00Z','2026-10-22T08:04:00Z'),
          run('c','qa','2026-10-22T08:01:00Z','2026-10-22T08:03:00Z')]},
        {...base,id:'two',identifier:'HER-2',status:'blocked',attempts:[],runs:{total:0,active:0,failed:0}},
        {...base,id:'three',identifier:'HER-3',status:'done',phase:3,attempts:[
          {...run('d','qa',null,null,'queued'),createdAt:'2026-10-22T08:03:00Z'}]},
      ];
      tasksLoaded = true; tasksAt = Date.now(); tasksMeta = {groups:{open:2,done:1},note:'有界查询'};
      panelInit = true; renderTasks(); openPanel('tasks');
      const intervals = taskIntervals([
        {...tasks[0],attempts:[
          run('live','pl','2026-10-22T08:00:00Z',null,'running'),
          run('missing','pl','2026-10-22T08:00:00Z',null,'failed'),
          run('bad','pl','2026-10-22T08:05:00Z','2026-10-22T08:00:00Z'),
          run('invalid','pl','invalid',null)]}
      ], Date.parse('2026-10-22T08:10:00Z'));
      if(intervals.length!==3 || intervals.filter(r=>r.measured).length!==1 || intervals.find(r=>r.run.id==='live').end-intervals.find(r=>r.run.id==='live').start!==600000) throw Error('区间计算错误');
    });
    assert.equal(await page.locator('.task-card').count(),3);
    await page.locator('.task-summary').first().click();
    assert.equal(await page.locator('.task-card[open]').count(),1);
    await page.locator('#tasks-trace-view').click();
    assert.equal(await page.locator('.trace-row').count(),3); // two members in task one, queued task three
    assert.equal(await page.locator('.trace-bar').count(),4);
    assert.equal(await page.locator('.trace-row').first().evaluate(el=>el.getBoundingClientRect().height),72);
    assert.equal(await page.locator('.trace-bar.queued').count(),1);
    assert.equal(await page.locator('#tasklist script').count(),0);
    await page.locator('.trace-bar').first().click();
    assert.match(await page.locator('.trace-selected').innerText(),/运行：a/);
    await page.locator('[data-trace-zoom="in"]').click();
    assert.equal(await page.locator('.trace-canvas').evaluate(el=>el.style.width),'200%');
    await page.locator('.trace-scroll').evaluate(el=>el.scrollLeft=120);
    await page.evaluate(()=>{tasksSignature=null;renderTasks();});
    assert.equal(await page.locator('.trace-scroll').evaluate(el=>el.scrollLeft),120);
    await page.locator('#tasks-list-view').click();
    assert.equal(await page.locator('.task-card[open]').count(),1);
    await page.locator('#tasks-search').fill('HER-2');
    assert.equal(await page.locator('.task-card').count(),1);
    await page.locator('#tasks-filter').selectOption('done');
    assert.match(await page.locator('#tasklist').innerText(),/没有匹配/);
    await page.locator('#tasks-search').fill('');
    assert.equal(await page.locator('.task-card').count(),1);
    await page.locator('#tasks-filter').selectOption('all');
    for(const width of [1440,1024,390,320]){
      await page.setViewportSize({width,height:900});
      for(const layout of ['list','trace']){
        await page.evaluate(layout=>setTaskLayout(layout),layout);
        const metrics = await page.evaluate(()=>({body:document.documentElement.scrollWidth,viewport:innerWidth,
          panel:$('#sidepanel').getBoundingClientRect().width,trace:$('#tasklist .trace-scroll')?.getBoundingClientRect().width}));
        assert.ok(metrics.body<=width,`page overflow ${width}/${layout}: ${JSON.stringify(metrics)}`);
        assert.ok(metrics.panel<=width,`panel overflow ${width}/${layout}`);
        if(layout==='trace') assert.ok(metrics.trace<=metrics.panel,`trace overflow ${width}`);
      }
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: true intervals, parallel lanes, queued point, escaping, detail, zoom, scroll retention, expanded state, search/status filters and 4 viewport widths');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
