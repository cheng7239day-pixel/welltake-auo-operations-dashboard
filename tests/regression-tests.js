// Synthetic-data tests only. No network or user storage is used.
async function runRegressionTests({html,repair,cloud,vm}){
 const results=[];
 const assert=(condition,message)=>{if(!condition)throw Error(message)};
 const elements=new Map();
 function element(){return {value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,children:[],classList:{toggle(){},add(){},remove(){}},replaceChildren(){this.children=[]},append(o){this.children.push(o)},appendChild(o){this.children.push(o)},prepend(){},addEventListener(){},removeEventListener(){},querySelectorAll(){return []}}}
 const el=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id)};
 const storage=new Map(),context=vm.createContext({console:{error(){}},document:{querySelector:el,querySelectorAll:()=>[],createElement:element,body:element(),addEventListener(){}},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},window:{},getComputedStyle:()=>({getPropertyValue:()=>''}),Blob,URL,Date,setTimeout,clearTimeout,confirm:()=>true,crypto:{randomUUID:()=> '00000000-0000-4000-8000-000000000001'}});
 const inline=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
 for(const s of inline)new vm.Script(s);
 new vm.Script(repair);new vm.Script(cloud);
 const main=inline.find(s=>s.includes('const DATA ='));
 vm.runInContext(main.slice(0,main.indexOf("$('#siteDisplay').addEventListener")),context);
 vm.runInContext(repair,context);vm.runInContext(cloud,context);
 const run=code=>vm.runInContext(code,context);
 run(`renderAll=()=>{};updateHandlerRoleOptions=()=>{};updateDataVersionBadge=()=>{};
 const fixture=(id,date,site='TEST-HC')=>({Ticket_No:id,Site:site,Handler:'Welltake demo',Handler_Group:'',Request_Type:'Incident',Handling_Status:'In Progress',Created_Date_Obj:parseAnyDate(date),Handling_Date_Obj:null,Closed_Date_Obj:null,Due_Date_Obj:null,Updated_Date_Obj:null,Snapshot_Date_Obj:null,Month:date.slice(0,7),Close_Days:null,Sub_Type:'Test',Sub_Type2:'',Problem_Description:'DO NOT UPLOAD',Overdue_Label:'',Ticket_Type:''});
 const november=fixture('N','2026-11-01');
 const october=fixture('O','2026-10-01');
 const oldSnapshot={id:'history-o',date:'2026-10-31',savedAt:1793404800000,file:'old.csv',scopeVersion:SCOPE_VERSION,rows:[{id:'O',site:'TEST-HC',owner:'Welltake demo',type:'Incident',status:'In Progress',created:'2026-10-01',handled:'',closed:''}]};
 historyRecords=[oldSnapshot];buildCurrentModel([november],'2026-11-10','new.csv');
 latestLocalRecord=rawRecord();`);
 assert(el('#monthSelect').children.some(o=>o.value==='2026-10'&&o.textContent.includes('歷史')),'Historical month missing');
 assert(run('DATA.monthly.length===1&&DATA.monthly[0].Month==="2026-11"'),'History was mixed into current model');results.push('舊月份可選，當期資料未混算');
 el('#monthSelect').value='2026-10';await run('chooseReportMonth()');
 assert(run('historicalView&&activeRows[0].Ticket_No==="O"&&IMPORT_STATE.snapshotDate==="2026-10-31"'),'Historical switch failed');
 await run('returnToLatest()');assert(run('!historicalView&&activeRows[0].Ticket_No==="N"'),'Return latest failed');results.push('歷史切換及回到目前 Raw');
 run("historyRecords=[{...oldSnapshot,scopeVersion:undefined}];refreshMonthOptions()");
 assert(!el('#monthSelect').children.some(o=>o.value==='2026-10'),'Legacy HC history leaked');results.push('舊 HC 範圍保持隔離');
 run("historyRecords=[oldSnapshot];selectedSite='TEST-KA';refreshMonthOptions()");
 assert(!el('#monthSelect').children.some(o=>o.value==='2026-10'),'Other site history leaked');run("selectedSite=''");results.push('歷史月份依廠區隔離');
 run('renderTrend()');assert(!el('#volumeTrend').innerHTML.includes('%'),'Count chart uses percent');assert(el('#volumeTrend').innerHTML.includes('<circle'),'Single-month point missing');results.push('單月圖表仍有資料點，件數不誤標百分比');
 run("november.Handling_Status='Resolved';november.Handling_Date_Obj=parseAnyDate('2026-11-03');november.Close_Days=2;buildCurrentModel([november],'2026-11-10','new.csv');renderOverview()");
 assert(el('#officialTrend').innerHTML.includes('<circle'),'Overview rate chart remains blank');assert(el('#handlerBars').innerHTML.includes('Welltake'),'Overview handler chart remains blank');assert(el('#management備註s').children.length===3,'Overview interpretation remains blank');results.push('首頁遺漏的完成率、人員圖表與管理判讀恢復');
 run("safeRender('Trend',()=>{throw Error('test')})");assert(!el('#renderErrors').hidden,'Render failure hidden');run("safeRender('Trend',()=>{})");assert(el('#renderErrors').hidden,'Recovered error not cleared');results.push('繪圖失敗與恢復提示');
 const safe=run('cloudPayload([november])[0]');assert(!('Problem_Description' in safe)&&!Object.values(safe).includes('DO NOT UPLOAD'),'Sensitive description uploaded');
 const roundtrip=run('cloudCanonical(cloudPayload([november]))[0]');assert(roundtrip.Month==='2026-11'&&roundtrip.Ticket_No==='N','Cloud row roundtrip');results.push('雲端欄位白名單與日期還原');
 run(`const validCache={...latestLocalRecord,savedAt:100};dbOperation=async()=>({...validCache,savedAt:200,scopeVersion:'legacy'});localStorage.getItem=()=>JSON.stringify(validCache);latestLocalRecord=null;`);
 await run('restoreRawSafely()');assert(run('latestLocalRecord===null'),'Invalid newest silently replaced');assert(!el('#recoverRaw').hidden,'Recovery action missing');el('#recoverRaw').onclick();assert(run('latestLocalRecord.savedAt===100'),'Recovery failed');results.push('無效新快取保留，可明確選擇有效備援');
 run("sourceMode='cloud';historyRecords=[oldSnapshot];cloudCatalog=[{months:['2026-10']}];clearCloudMemory()");
 assert(run('activeRows.length===0&&historyRecords.length===0&&cloudCatalog.length===0'),'Cloud data remains after logout');assert(run('latestLocalRecord.savedAt===100'),'Local record damaged on logout');results.push('登出清除雲端記憶體，保留本機資料');
 run(`cloudMember={role:'viewer',approval_status:'approved',display_name:'Synthetic viewer'};cloudUserId='synthetic-viewer';document.querySelector('#cloudSite').value='TEST-HC';
 const remote={id:'remote-new',site:'TEST-HC',snapshot_date:'2026-11-10',uploaded_at:'2026-11-10T01:00:00Z',source_filename:'remote.csv',row_count:1,rows:cloudPayload([november]),months:['2026-11']};
 cloudRpc=async name=>name==='dashboard_raw_catalog'?[remote]:remote;cloudDirty=false;historicalView=false;`);
 await run('cloudRefresh(true)');assert(run("sourceMode==='cloud'&&cloudCurrentId==='remote-new'&&latestLocalRecord.savedAt===100"),'Cloud latest load overwrote local data');results.push('雲端最新版本讀入，不覆蓋本機快取');
 run("cloudRpc=async()=>{throw Error('Site not authorized')}");await run('cloudRefresh()');assert(run('activeRows.length===0&&cloudCatalog.length===0'),'Denied cloud request left stale data');results.push('權限失效時移除雲端資料');
 return results;
}
