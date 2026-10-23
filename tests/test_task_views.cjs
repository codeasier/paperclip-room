// Offline browser regression: NODE_PATH=<playwright node_modules> node tests/test_task_views.cjs
const {chromium} = require('playwright');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const assert = require('node:assert/strict');

(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:900}}), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:readFileSync(join(__dirname,'../index.html'),'utf8').replace('boot();','/* offline fixture */')}));
    let denseAttempts=0;
    await page.route('**/api/run?**',route=>{
      const url=new URL(route.request().url()),id=url.searchParams.get('run');
      if(id==='b') return route.fulfill({json:{id:'b',agentId:'pl',status:'succeeded',state:'available',ts:'2026-10-22T08:02:00Z',entries:[{id:'old-reply',kind:'assistant',text:'历史运行的助手消息',ts:'2026-10-22T08:03:00Z'}]}});
      if(id==='live-bg') return route.fulfill({json:{id:'live-bg',agentId:'pl',status:'running',state:'available',ts:new Date(Date.now()-5*60000).toISOString(),entries:[{id:'bg-entry',kind:'assistant',text:'后台运行过程',ts:new Date(Date.now()-4*60000).toISOString()}]}});
      if(id==='dense1' && ++denseAttempts>1) return route.fulfill({json:{id:'dense1',agentId:'pl',status:'succeeded',state:'available',ts:'2026-10-22T08:00:00Z',entries:[{id:'retry',kind:'assistant',text:'重试后恢复执行过程',ts:'2026-10-22T08:00:01Z'}]}});
      if(url.searchParams.has('before')) return route.fulfill({json:{state:'available',nextCursor:null,entries:[{id:'m-1',kind:'assistant',text:'更早的助手消息',ts:'2026-10-22T07:59:00Z'},{id:'m-20',kind:'assistant',text:'当前助手消息',ts:'2026-10-22T08:03:00Z'}]}});
      return route.fulfill({status:503,json:{error:'temporary'}});
    });
    await page.goto('http://paperclip.test/');
    await page.evaluate(()=>{
      selected='pl';names={pl:'PL',qa:'QA'};agents=[{id:'pl',name:'PL',status:'idle',running:0,current:{identifier:'HER-110',title:'待 PL 跟进的评审',status:'in_progress'}}];
      const run=(id,agentId,start,end,status='succeeded')=>({id,agentId,agentName:names[agentId],status,startedAt:start,finishedAt:end});
      const base={relation:'assigned',priority:'medium',status:'in_progress',phase:1,lastActivityAt:'2026-10-22T08:00:00Z',children:{total:0,done:0},comments:{total:0,latest:[]},checklist:null,runs:{total:3,active:0,failed:0},title:'并行任务 <script>unsafe</script>'};
      tasks=[
        {...base,id:'one',identifier:'HER-1',attempts:[run('a','pl','2026-10-22T08:00:00Z','2026-10-22T08:05:00Z'),run('b','pl','2026-10-22T08:02:00Z','2026-10-22T08:04:00Z'),run('c','qa','2026-10-22T08:01:00Z','2026-10-22T08:03:00Z')]},
        {...base,id:'two',identifier:'HER-2',status:'blocked',attempts:[{id:'untimed',agentId:'pl',agentName:'PL',status:'failed'}],runs:{total:1,active:0,failed:1}},
        {...base,id:'three',identifier:'HER-3',status:'done',phase:3,attempts:[{...run('d','pl',null,null,'queued'),createdAt:'2026-10-22T08:03:00Z'}]},
        {...base,id:'assigned-only',identifier:'HER-110',title:'待 PL 跟进的评审',attempts:[run('qa-cancelled','qa','2026-10-22T08:00:00Z','2026-10-22T08:05:00Z','cancelled')],runs:{total:1,active:0,failed:0}},
      ];
      tasksLoaded=true;tasksAt=Date.now();tasksMeta={groups:{open:2,done:1},note:'有界查询'};
      roomEvents=[
        {id:'issue',kind:'issue',issueId:'one',issue:'HER-1',title:'并行任务',status:'in_progress',ts:'2026-10-22T08:00:00Z'},
        {id:'comment',kind:'comment',issueId:'one',issue:'HER-1',issueTitle:'并行任务',text:'给 QA\n请验收',sender:{name:'PL'},recipients:[{name:'QA'}],ts:'2026-10-22T08:01:00Z'},
      ];
      executionRuns=[{id:'a',agentId:'pl',status:'succeeded',issue:'HER-1',issueTitle:'并行任务',ts:'2026-10-22T08:00:00Z',state:'available',nextCursor:20,entries:[{id:'tool',kind:'tool_call',toolCallId:'call',name:'terminal',text:'{"command":"true"}',ts:'2026-10-22T08:02:00Z'},{id:'result',kind:'tool_result',toolCallId:'call',text:'tool-result',ts:'2026-10-22T08:02:10Z'},{id:'m-20',kind:'assistant',text:'当前助手消息',ts:'2026-10-22T08:03:00Z'}]}];
      executionLoaded=true;renderTimeline();setView('tasks');renderHead();
      const intervals=taskIntervals([{...tasks[0],attempts:[run('live','pl','2026-10-22T08:00:00Z',null,'running'),run('missing','pl','2026-10-22T08:00:00Z',null,'failed'),run('bad','pl','2026-10-22T08:05:00Z','2026-10-22T08:00:00Z'),run('invalid','pl','invalid',null)]}],Date.parse('2026-10-22T08:10:00Z'));
      if(intervals.length!==3 || intervals.filter(r=>r.measured).length!==1 || intervals.find(r=>r.run.id==='live').end-intervals.find(r=>r.run.id==='live').start!==600000) throw Error('区间计算错误');
    });
    assert.equal(await page.locator('#sidepanel').isHidden(),true);
    assert.equal(await page.locator('#tab-tasks').count(),0);
    assert.equal(await page.locator('#sidepanel .task-controls').count(),0);
    assert.equal(await page.locator('#taskpane .task-controls').count(),1);
    assert.equal(await page.locator('#taskspane').isHidden(),true);
    assert.equal(await page.locator('#stream [data-event]').count(),3);
    assert.equal(await page.locator('#stream .tool-step').count(),0);
    assert.equal(await page.locator('#stream .assistant-output').count(),0);
    await page.locator('.comm .comm-summary').click();
    assert.match(await page.locator('#detailcontent').innerText(),/消息详情/);
    await page.locator('[data-detail-task]').click();
    assert.match(await page.locator('#detailcontent').innerText(),/任务详情/);
    await page.getByText('历史运行的助手消息',{exact:true}).waitFor();
    await page.locator('#closepanel').click();
    await page.locator('[data-issue-detail]').press('Enter');
    assert.match(await page.locator('#detailcontent').innerText(),/HER-1/);
    await page.keyboard.press('Escape');
    await page.locator('[data-execution-detail]').click();
    assert.match(await page.locator('#detailcontent').innerText(),/运行：a/);
    assert.match(await page.locator('#detailcontent').innerText(),/当前助手消息/);
    assert.equal(await page.locator('#detailcontent .tool-step').count(),1);
    await page.locator('#detailcontent .tool-step summary').click();
    assert.match(await page.locator('#detailcontent .tool-body').innerText(),/tool-result/);
    await page.locator('[data-run-more]').click();
    await page.getByText('更早的助手消息',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-output="m-20"]').count(),1);
    assert.equal(await page.locator('#detailcontent .tool-step[open]').count(),1);
    assert.equal(await page.locator('[data-run-more]').count(),0);
    await page.evaluate(()=>{
      executionRuns[0].entries.push(...Array.from({length:20},(_,i)=>({id:`extra-${i}`,kind:'assistant',text:`新增消息 ${i}`,ts:'2026-10-22T08:04:00Z'})));
      renderTimeline();$('#detailpane').scrollTop=120;
    });
    await page.evaluate(()=>{executionRuns[0].entries.push({id:'live',kind:'assistant',text:'实时新增消息',ts:'2026-10-22T08:05:00Z'});renderTimeline();});
    assert.equal(await page.locator('#detailpane').evaluate(el=>el.scrollTop),120);
    assert.match(await page.locator('#detailcontent').innerText(),/实时新增消息/);
    assert.equal(await page.locator('#detailcontent .tool-step[open]').count(),1);
    await page.locator('[data-execution-detail]').click();
    assert.equal(await page.locator('#sidepanel').isHidden(),true);
    await page.locator('#tasks-trace-view').click();
    assert.equal(await page.locator('#taskrecords').isHidden(),true);
    assert.equal(await page.locator('#taskspane').isVisible(),true);
    assert.equal(await page.locator('.trace-row').count(),2);
    assert.equal(await page.locator('.trace-bar').count(),3);
    assert.equal(await page.locator('[data-trace-run="c"]').count(),0);
    assert.equal(await page.locator('.trace-bar.queued').count(),1);
    assert.equal(await page.locator('#tasklist script').count(),0);
    assert.match(await page.locator('#taskcontext').innerText(),/当前名下任务/);
    assert.match(await page.locator('#taskcontext').innerText(),/任务：进行中/);
    assert.equal(await page.locator('#roomstatus').innerText(),'待命中');
    const assignedOnly=page.locator('.trace-unmeasured-task[data-trace-task="assigned-only"]');
    assert.match(await assignedOnly.innerText(),/暂无 PL 的运行记录/);
    assert.match(await assignedOnly.innerText(),/QA · 已取消/);
    assert.equal(await page.locator('[data-trace-run="qa-cancelled"]').count(),0);
    assert.match(await page.locator('.trace-unmeasured-task[data-trace-task="two"]').innerText(),/已记录 PL 的 1 次运行，但缺少可用时间/);
    assert.equal(await page.locator('[data-trace-run="untimed"]').count(),0);
    await assignedOnly.click();
    assert.match(await page.locator('#detailcontent').innerText(),/暂无 PL 的运行记录/);
    assert.match(await page.locator('#detailcontent').innerText(),/QA · 已取消/);
    assert.equal(await page.locator('[data-process-run]').count(),0);
    await page.locator('#closepanel').click();
    await page.evaluate(()=>{
      const task=tasks.find(t=>t.id==='assigned-only');task.attempts[0].status='running';task.runs.active=1;
      roomEvents.push({id:'assigned-issue',kind:'issue',issueId:task.id,issue:task.identifier,title:task.title,status:task.status,ts:'2026-10-22T08:00:00Z'});
    });
    await page.locator('#tasks-filter').selectOption('active');
    assert.equal(await page.locator('[data-trace-task="assigned-only"]').count(),0);
    assert.equal(await page.locator('[data-trace-run="d"]').count(),1);
    await page.locator('#tasks-list-view').click();
    assert.equal(await page.locator('[data-issue-detail="assigned-only"]').count(),0);
    await page.evaluate(()=>{roomEvents=roomEvents.filter(e=>e.id!=='assigned-issue');const task=tasks.find(t=>t.id==='assigned-only');task.attempts[0].status='cancelled';task.runs.active=0;});
    await page.locator('#tasks-filter').selectOption('all');
    await page.locator('#tasks-trace-view').click();
    await page.locator('[data-trace-run="a"]').click();
    assert.equal(await page.locator('#sidepanel').isVisible(),true);
    assert.match(await page.locator('#detailcontent').innerText(),/运行：a/);
    assert.equal(await page.locator('#tasklist .trace-selected').count(),0);
    await page.locator('#closepanel').click();
    await page.locator('[data-trace-zoom="in"]').click();
    assert.equal(await page.locator('.trace-canvas').evaluate(el=>el.style.width),'200%');
    await page.locator('.trace-scroll').evaluate(el=>el.scrollLeft=120);
    await page.evaluate(()=>{tasksSignature=null;renderTasks();});
    assert.equal(await page.locator('.trace-scroll').evaluate(el=>el.scrollLeft),120);
    await page.locator('#tasks-list-view').click();
    assert.equal(await page.locator('#taskspane').isHidden(),true);
    await page.locator('[data-execution-detail]').click();
    assert.equal(await page.locator('#detailcontent .tool-step[open]').count(),1);
    await page.locator('#closepanel').click();
    await page.locator('#tasks-search').fill('missing');
    assert.equal(await page.locator('#stream [data-event]').count(),0);
    await page.locator('#tasks-search').fill('HER-1');
    assert.equal(await page.locator('#stream [data-event]').count(),3);
    await page.locator('#tasks-filter').selectOption('done');
    assert.equal(await page.locator('#stream [data-event]').count(),0);
    await page.locator('#tasks-filter').selectOption('all');
    await page.locator('#tasks-search').fill('');
    for(const width of [1440,1024,390,320]){
      await page.setViewportSize({width,height:900});
      for(const layout of ['list','trace']){
        await page.evaluate(layout=>setTaskLayout(layout),layout);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width}/${layout}`);
        const trigger=layout==='list' ? page.locator('.comm .comm-summary') : page.locator('[data-trace-run="a"]');
        await trigger.click();
        assert.equal(await page.locator('#sidepanel').isVisible(),true);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`detail overflow ${width}/${layout}`);
        if(width<=760) assert.equal(await page.locator('#conversation').isVisible(),false);
        await page.locator('#closepanel').click();
        assert.equal(await page.locator('#conversation').isVisible(),true);
      }
      await page.evaluate(()=>setTaskLayout('list'));
      const rows=await page.locator('#stream [data-event]').evaluateAll(els=>els.map(el=>({left:el.getBoundingClientRect().left,width:el.getBoundingClientRect().width})));
      assert.ok(rows.every(row=>Math.abs(row.width-rows[0].width)<1&&Math.abs(row.left-rows[0].left)<1));
      for(const kind of ['task','message','execution']) assert.equal(await page.locator(`#stream .event-icon.${kind}`).count(),1);
      assert.equal(await page.locator('#stream .tool-step,#stream .assistant-output').count(),0);
      assert.ok(await page.locator('.execution-summary').evaluate(el=>el.getBoundingClientRect().height<=60));
    }
    await page.evaluate(()=>{
      const task=tasks[0],start=Date.parse('2026-10-22T08:00:00Z');
      const attempt=(id,offset,end)=>({id,agentId:'pl',agentName:'PL',status:'succeeded',startedAt:new Date(start+offset).toISOString(),finishedAt:new Date(start+end).toISOString()});
      tasks=[{...task,attempts:[attempt('dense1',0,1000),attempt('dense2',1100,2000),attempt('far',86400000,86401000)]}];
      traceRange='1h';traceOffset=0;setTaskLayout('trace');
    });
    assert.equal(await page.locator('[data-trace-run="dense1"]').count(),0);
    await page.locator('[data-trace-range]').selectOption('all');
    for(const id of ['dense1','dense2']){
      await page.locator(`[data-trace-run="${id}"]`).click();
      assert.match(await page.locator('#detailcontent').innerText(),new RegExp(`运行：${id}`));
      if(id==='dense1'){
        await page.locator('[data-run-retry]').waitFor();
        await page.locator('[data-run-retry]').click();
        await page.getByText('重试后恢复执行过程',{exact:true}).waitFor();
      }
      await page.locator('#closepanel').click();
    }
    await page.locator('[data-trace-range]').selectOption('1h');
    await page.locator('[data-trace-window="previous"]').click();
    assert.equal(await page.locator('.trace-bar').count(),0);
    await page.locator('[data-trace-window="next"]').click();
    assert.equal(await page.locator('[data-trace-run="far"]').count(),1);
    await page.setViewportSize({width:1440,height:900});
    // Heartbeat/background runs must be named as such and explained in the task timeline.
    await page.evaluate(()=>{
      const agent=agents.find(a=>a.id==='pl');
      agent.running=1;
      agent.live={running:1,queued:0,task:0,background:1,taskRunning:0,taskQueued:0,backgroundRunning:1,backgroundQueued:0,runs:[{id:'live-bg',status:'running',startedAt:new Date(Date.now()-5*60000).toISOString(),createdAt:new Date(Date.now()-5*60000).toISOString(),issueId:null,issue:null,issueTitle:null,linked:false,unlisted:false,source:'timer',scope:'company'}]};
      renderRail();renderHead();tasksSignature=null;renderTasks();
    });
    const plRow=page.locator('#agents .agent[data-id="pl"]');
    assert.match(await plRow.innerText(),/1 后台运行/);
    assert.doesNotMatch(await plRow.innerText(),/1 活跃/);
    assert.equal(await page.locator('#roomstatus').innerText(),'1 个后台运行');
    assert.equal(await page.evaluate(()=>liveTotalsText({liveTaskRunning:0,liveBackgroundRunning:2,liveQueued:0,liveRuns:2})),'2 个后台运行');
    assert.equal(await page.evaluate(()=>liveTotalsText({liveTaskRunning:1,liveBackgroundRunning:1,liveQueued:1,liveRuns:3})),'1 个任务运行 · 1 个后台运行 · 1 个排队');
    assert.equal(await page.evaluate(()=>liveTotalsText({liveRuns:2})),'2 个活跃运行');
    assert.match(await page.locator('.trace-live').innerText(),/定时心跳/);
    assert.match(await page.locator('.trace-live').innerText(),/未出现在当前时间线/);
    await page.locator('[data-live-run="live-bg"]').click();
    assert.match(await page.locator('#detailcontent').innerText(),/运行详情/);
    assert.match(await page.locator('#detailcontent').innerText(),/未出现在当前任务查询范围/);
    await page.getByText('后台运行过程',{exact:true}).waitFor();
    await page.locator('#closepanel').click();
    // A member may have no current assignments/comments but still have historical executions.
    const historicalTask=await page.evaluate(()=>({...tasks[0],id:'reassigned',identifier:'HER-7',title:'已转派的任务',relation:'executed',status:'blocked',
      attempts:[{id:'analyst-run',agentId:'analyst',agentName:'Analyst',status:'failed',startedAt:'2026-10-20T08:00:00Z',finishedAt:'2026-10-20T08:05:00Z'}]}));
    await page.route('**/api/tasks?**',route=>route.fulfill({json:{state:'available',tasks:[historicalTask],groups:{assigned:0,open:0,executed:1},note:'含实际执行过的任务；非完整历史。'}}));
    await page.evaluate(()=>{
      selected='analyst';names.analyst='Analyst';roomEvents=[];tasks=[];tasksLoaded=false;tasksSignature=null;traceRange='1h';traceOffset=0;
      $('#tasklist').innerHTML='<div class="task-skeleton">正在读取任务进展…</div>';
      executionRuns=[{id:'analyst-run',agentId:'analyst',issue:'HER-7',issueTitle:'已转派的任务',status:'failed',state:'available',ts:'2026-10-20T08:00:00Z',entries:[{id:'analyst-output',kind:'assistant',text:'需求分析的历史输出'}]}];
      setTaskLayout('list');
    });
    assert.equal(await page.locator('[data-execution-detail="analyst-run"]').count(),1);
    await page.locator('#tasks-trace-view').click();
    await page.locator('[data-trace-run="analyst-run"]').waitFor();
    assert.doesNotMatch(await page.locator('#tasklist').innerText(),/暂无关联任务/);
    await page.locator('[data-trace-run="analyst-run"]').click();
    assert.match(await page.locator('#detailcontent').innerText(),/需求分析的历史输出/);
    assert.match(await page.locator('#detailcontent').innerText(),/曾执行过该任务/);
    await page.locator('#closepanel').click();
    await page.locator('#tasks-filter').selectOption('blocked');
    assert.equal(await page.locator('[data-trace-run="analyst-run"]').count(),1);
    await page.evaluate(()=>{tasks=[];tasksMeta.note='非完整历史';renderTasks();});
    assert.match(await page.locator('#tasklist').innerText(),/当前查询范围暂无关联任务/);
    await page.evaluate(()=>{
      agents=[{id:'analyst',name:'Analyst',status:'running',running:1,openCount:0,current:null,
        live:{running:1,queued:0,task:0,background:1,taskRunning:0,taskQueued:0,backgroundRunning:1,backgroundQueued:0,
          runs:[{id:'live-bg',status:'running',startedAt:new Date(Date.now()-5*60000).toISOString(),createdAt:new Date(Date.now()-5*60000).toISOString(),issueId:null,issue:null,issueTitle:null,linked:false,unlisted:false,source:'timer',scope:'company'}]}}];
      names.analyst='Analyst';tasksSignature=null;renderRail();renderHead();renderTasks();
    });
    assert.match(await page.locator('#agents .agent[data-id="analyst"]').innerText(),/1 后台运行/);
    assert.equal(await page.locator('#roomstatus').innerText(),'1 个后台运行');
    assert.match(await page.locator('#tasklist').innerText(),/成员有进行中的运行 · 当前查询范围没有关联任务/);
    assert.match(await page.locator('#tasklist').innerText(),/任务时间线只绘制与任务关联的运行/);
    assert.deepEqual(errors,[]);
    console.log('PASS: task ownership vs member execution, unmeasured task details and member-scoped active filters; historical executed/reassigned task hydration and scoped empty state; collapsed execution rows; sidebar tools/replies, history/pagination/dedup, live updates and scroll/expansion retention; central views, details, filters and 4 viewports');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
