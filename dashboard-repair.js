/* V6.23: non-destructive local recovery and explicit historical views. */
let latestLocalRecord=null, historicalView=false, sourceMode='local';
let localHistoryRecords=[], cloudCatalog=[], cloudCurrentId=null;
const repairErrors=new Map();
function notice(text){$('#dataSourceStatus').textContent=text}
function recordMonths(rows,site=selectedSite){return [...new Set(rows.filter(r=>!site||siteKey(r)===site).map(r=>r.Month).filter(Boolean))].sort()}
function compatibleHistory(){return historyRecords.filter(s=>s.scopeVersion===SCOPE_VERSION)}
function historicalMonths(){
 if(sourceMode==='cloud')return [...new Set(cloudCatalog.flatMap(s=>s.months))].sort();
 return [...new Set(compatibleHistory().flatMap(s=>s.rows.filter(r=>!selectedSite||r.site===selectedSite).map(r=>r.created.slice(0,7))))].sort();
}
const originalRefreshMonthOptions=refreshMonthOptions;
refreshMonthOptions=function(preferred=null){
 originalRefreshMonthOptions(preferred);
 const current=monthSelect.value,latestMonths=sourceMode==='cloud'?(cloudCatalog[0]?.months||[]):latestLocalRecord?recordMonths(latestLocalRecord.rows):[];
 const available=[...new Set([...months,...historicalMonths(),...latestMonths])].sort();
 monthSelect.replaceChildren();
 for(const m of available){const o=document.createElement('option');o.value=m;o.textContent=monthName(m)+(months.includes(m)?'':latestMonths.includes(m)?'（最新版本）':'（歷史快照）');monthSelect.append(o)}
 if(!available.length){const o=document.createElement('option');o.value='';o.textContent='等待匯入';monthSelect.append(o)}
 monthSelect.disabled=!available.length;monthSelect.value=available.includes(preferred)?preferred:current||available.at(-1)||'';
};
function historyRows(s){
 return s.rows.map(r=>{const created=parseAnyDate(r.created),handled=parseAnyDate(r.handled);return {
 Ticket_No:r.id,Site:r.site,Handler:r.owner,Handler_Group:'',Request_Type:r.type,Request_Type_Missing:r.type==='未分類',
 Handling_Status:r.status,Created_Date_Obj:created,Handling_Date_Obj:handled,Closed_Date_Obj:parseAnyDate(r.closed),
 Due_Date_Obj:null,Updated_Date_Obj:null,Snapshot_Date_Obj:null,Month:isoMonth(created),Close_Days:dayDiff(created,handled),
 Sub_Type:'歷史快照未保存分類',Sub_Type2:'',Problem_Description:'歷史快照未保存問題描述',Overdue_Label:'',Ticket_Type:''};});
}
function setHistoricalView(value){historicalView=value;$('#returnLatest').hidden=!value;$('#recalcSnapshot').disabled=value||sourceMode==='cloud';$('#clearRawCache').disabled=value||sourceMode==='cloud';$('#resetAllData').disabled=value||sourceMode==='cloud';for(const id of ['historyClear','historyBackup','historyExport'])$('#'+id).disabled=sourceMode==='cloud'}
async function chooseReportMonth(){
 const wanted=monthSelect.value;
 try{
  if(sourceMode==='cloud'){
   const entry=cloudCatalog.find(s=>s.months.includes(wanted));if(!entry)throw Error('沒有可讀取的歷史月份');
   if(entry.id===cloudCurrentId){renderAll();return}
   cloudEpoch++;setHistoricalView(entry.id!==cloudCatalog[0]?.id);await cloudLoadRecord(entry.id,entry.id!==cloudCatalog[0]?.id);
  }
  else{
   if(latestLocalRecord&&recordMonths(latestLocalRecord.rows).includes(wanted)){
    if(historicalView)await returnToLatest();monthSelect.value=wanted;renderAll();return;
   }
   const s=compatibleHistory().filter(s=>s.rows.some(r=>(!selectedSite||r.site===selectedSite)&&r.created.startsWith(wanted))).sort((a,b)=>b.date.localeCompare(a.date)||b.savedAt-a.savedAt)[0];
   if(!s)throw Error('沒有符合廠區與資料範圍的歷史快照');
   const rows=historyRows(s);validateSnapshot(rows,s.date);setHistoricalView(true);buildCurrentModel(rows,s.date,s.file);
   notice(`歷史檢視｜資料日期 ${s.date}｜${s.file}。僅讀取該版本，未與目前 Raw 混算；分類、問題描述等未保存欄位無法還原。`);
  }
  monthSelect.value=wanted;renderAll();
 }catch(e){if(sourceMode==='cloud')clearCloudMemory();notice('月份切換失敗：'+e.message);refreshMonthOptions();}
}
async function returnToLatest(){
 if(sourceMode==='cloud'){await cloudRefresh(true);return}
 if(!latestLocalRecord){notice('沒有可還原的目前 Raw；歷史仍保留，請先備份再匯入完整 Raw。');return}
 setHistoricalView(false);const r=latestLocalRecord;buildCurrentModel(reviveRows(r.rows),r.snapshot,r.fileName);notice(`本機目前 Raw｜資料日期 ${r.snapshot}｜${r.fileName}`);
}
const originalRenderTrend=renderTrend;
renderTrend=function(){
 originalRenderTrend();
 $('#trendSourceNote').textContent=`資料日期 ${IMPORT_STATE.snapshotDate||'尚無'}｜${scopeLabel()}｜${historicalView?'歷史版本':'目前版本'}。`+
 (months.length===1?'目前版本僅有一個建立月份，圖表顯示單點；其他月份可從右上角「歷史快照」選取。':months.length?'依目前版本的建立月份分組；不合併不同日期的案件。':'尚未載入 Raw；如有同範圍歷史，可從月份選單選取。');
};
// V6.21 retained these overview panels but removed their rendering calls.
const originalRenderOverview=renderOverview;
renderOverview=function(){
 originalRenderOverview();
 lineChart($('#officialTrend'),months.map(monthName),[{values:DATA.monthly.map(r=>r.Raw_7D_Rate)}],null,'pct');
 const month=monthSelect.value,row=DATA.monthly.find(r=>r.Month===month),index=months.indexOf(month),previous=index>0?DATA.monthly.find(r=>r.Month===months[index-1]):null;
 barChart($('#handlerBars'),DATA.handlers.filter(r=>r.Month===month),'Handler','7D_Rate','pct',8);
 barChart($('#issueBars'),DATA.issues.filter(r=>r.Month===month),'Sub_Type','Incident_Cases','num',8);
 const notes=$('#management備註s');notes.replaceChildren();
 const messages=row?[
  `${monthName(month)}：Incident ${row.Incident_Cases} 件；有效 IT 完成 ${row.Closed_Incident_Cohort} 件，7 天內 ${row.Closed_Within_7D} 件，完成率 ${pct(row.Raw_7D_Rate)}。`,
  previous?`較 ${monthName(previous.Month)} 的完成率差異：${pp(ppDelta(row.Raw_7D_Rate,previous.Raw_7D_Rate))}。兩者依同一版本的建立月份分組。`:'目前版本沒有可比較的前一月份；可從報告月份選取其他歷史版本。',
  '此處是 Raw Data 分析，不是官方 Tableau KPI；未完成案件與缺少有效 Handling Date 的案件不在完成率分母。'
 ]:['尚無可分析的 Raw Data。'];
 for(const message of messages){const p=document.createElement('p');p.textContent=message;notes.append(p)}
};
safeRender=function(label,fn){
 try{fn();repairErrors.delete(label);return true}
 catch(e){console.error(`[Dashboard Render Error] ${label}`,e);repairErrors.set(label,'畫面載入失敗，請記錄頁面名稱後重試；資料未被清除。');return false}
 finally{const el=$('#renderErrors');if(el){el.hidden=!repairErrors.size;el.textContent=[...repairErrors].map(([name,msg])=>`${name}：${msg}`).join(' ');}}
};
function checkedRawRecord(record){
 if(!record||record.schema!==615)throw Error('不支援的 Raw 格式');
 if(record.scopeVersion!==SCOPE_VERSION)throw Error('舊 HC 範圍已隔離，資料仍保留；請先備份，再匯入完整威策 Raw');
 if(!Array.isArray(record.rows)||!Number.isFinite(record.savedAt))throw Error('快取結構不完整');
 const rows=selectLatestRows(reviveRows(record.rows));validateSnapshot(rows,record.snapshot);
 return {...record,rows};
}
async function restoreRawSafely(){
 const candidates=[],issues=[];
 try{const r=await dbOperation('get');if(r)candidates.push({name:'IndexedDB',record:r})}catch(e){issues.push('IndexedDB 讀取失敗：'+e.message)}
 try{const text=localStorage.getItem(RAW_FALLBACK);if(text)candidates.push({name:'localStorage 備援',record:JSON.parse(text)})}catch(e){issues.push('備援讀取失敗：'+e.message)}
 candidates.sort((a,b)=>(Number(b.record?.savedAt)||0)-(Number(a.record?.savedAt)||0));
 let valid=null;
 for(const candidate of candidates){try{valid={...candidate,record:checkedRawRecord(candidate.record)};break}catch(e){issues.push(candidate.name+'：'+e.message)}}
 const apply=()=>{latestLocalRecord=valid.record;setHistoricalView(false);buildCurrentModel(valid.record.rows,valid.record.snapshot,valid.record.fileName);notice(`本機 Raw｜${valid.record.fileName}｜資料日期 ${valid.record.snapshot}｜保存時間 ${new Date(valid.record.savedAt).toLocaleString('zh-TW')}`)};
 if(valid&&!issues.length){apply();cacheMessage('已恢復 '+valid.name+'，未更動任何快取。')}
 else if(valid){cacheMessage(issues.join('；')+'。另有可用版本，尚未自動套用。');const btn=$('#recoverRaw');btn.hidden=false;btn.textContent=`檢視可用備援（${valid.record.snapshot}）`;btn.onclick=()=>{apply();btn.hidden=true;cacheMessage('已讀取可用備援；較新但無效的快取仍保留。')}}
 else{cacheMessage(issues.length?issues.join('；')+'。請勿清除資料。':'目前沒有 Raw 快取；可選歷史月份或匯入完整檔案。');notice(issues.length?'本機快取尚未恢復，請先備份；詳細原因見資料匯入頁。':'尚無目前 Raw；可選取歷史月份或匯入完整檔案。');refreshMonthOptions();}
}
async function exportLocalRecovery(){
 const results=await Promise.allSettled([dbOperation('get'),hDB()]);
 let fallback=null;try{fallback=localStorage.getItem(RAW_FALLBACK)}catch(e){throw Error('備援無法讀取，請先確認瀏覽器儲存權限')}
 const data={format:'welltake-recovery-v1',exportedAt:new Date().toISOString(),raw:results[0].status==='fulfilled'?results[0].value:null,fallback,history:results[1].status==='fulfilled'?results[1].value:null,errors:results.flatMap((r,i)=>r.status==='rejected'?[['Raw','歷史'][i]+' 讀取失敗']:[])};
 const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='welltake-recovery-'+localToday()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 notice('已匯出本機救援備份'+(data.errors.length?'（部分儲存無法讀取，請保留原始檔）':'')+'。備份含案件資料，請存放於公司核准位置。');
}
async function startDashboard(){
 monthSelect.removeEventListener('change',renderAll);monthSelect.addEventListener('change',chooseReportMonth);
 $('#returnLatest').onclick=()=>returnToLatest().catch(e=>notice(e.message));
 $('#backupRecovery').onclick=()=>exportLocalRecovery().catch(e=>notice('備份失敗：'+e.message));
 await hInit();localHistoryRecords=historyRecords;
 $('#rawSnapshotDate').value=localToday();refreshMonthOptions();renderAll();renderPresetMenu();
 $('#clearRawCache').onclick=()=>resetData('raw');$('#resetAllData').onclick=()=>resetData('all');
 $('#recalcSnapshot').onclick=async()=>{if(historicalView||sourceMode!=='local'||!activeRows.length||cacheBusy)return;cacheBusy=true;try{const date=$('#rawSnapshotDate').value;validateSnapshot(allWelltakeRows,date);buildCurrentModel(allWelltakeRows,date,activeFileName);const record=rawRecord();await persistRaw(record);latestLocalRecord=record;cacheMessage('已保存本機重算日期；尚未上傳雲端。')}catch(e){cacheMessage(e.message)}finally{cacheBusy=false}};
 cacheBusy=true;$('#rawFileInput').disabled=true;try{await restoreRawSafely()}finally{cacheBusy=false;$('#rawFileInput').disabled=false}
 await cloudInit();
}
