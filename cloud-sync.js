/* Authenticated, site-scoped synchronization. Customer rows stay in memory. */
const CLOUD_URL='https://xaipuzdewphyznjysrla.supabase.co';
// Publishable browser key; all access is enforced by database membership checks.
const CLOUD_KEY='sb_publishable_z6oDWrWKsuDQknVIk0Xkhg_i28WP4F0';
let cloudClient=null,cloudMember=null,cloudBusy=false,cloudEpoch=0,cloudDirty=false,cloudUserId=null;
let shareToken=null;
let pendingUpload=null;
let cloudProfileBusy=false;
const cloudText=text=>{$('#cloudStatus').textContent=text};
async function cloudRpc(name,args={}){const {data,error}=await (shareToken?cloudClient.rpc('dashboard_shared_raw',{p_token:shareToken,p_action:name,p_args:args}):cloudClient.rpc(name,args));if(error)throw Error(error.message);return data}
function cloudCanonical(rows){return rows.map(r=>{const created=parseAnyDate(r.created),handled=parseAnyDate(r.handled);return {
 Ticket_No:r.id,Site:r.site,Handler:r.owner,Handler_Group:r.group||'',Request_Type:r.type,Request_Type_Missing:r.type==='未分類',Handling_Status:r.status,
 Created_Date_Obj:created,Handling_Date_Obj:handled,Closed_Date_Obj:parseAnyDate(r.closed),Due_Date_Obj:parseAnyDate(r.due),Updated_Date_Obj:null,Snapshot_Date_Obj:null,
 Month:isoMonth(created),Close_Days:dayDiff(created,handled),Sub_Type:r.sub_type||'未分類',Sub_Type2:r.sub_type2||'',Ticket_Type:r.ticket_type||'',
 Problem_Description:'雲端未上傳問題描述與聯絡個資',Overdue_Label:''};})}
function cloudPayload(rows){return rows.map(r=>({id:r.Ticket_No,site:String(r.Site||'').trim(),owner:r.Handler,group:r.Handler_Group||'',type:r.Request_Type,status:r.Handling_Status,created:isoDate(r.Created_Date_Obj),handled:isoDate(r.Handling_Date_Obj),closed:isoDate(r.Closed_Date_Obj),due:isoDate(r.Due_Date_Obj),sub_type:r.Sub_Type||'',sub_type2:r.Sub_Type2||'',ticket_type:r.Ticket_Type||''})).sort((a,b)=>a.site.localeCompare(b.site)||a.id.localeCompare(b.id))}
function cloudHistory(record){return {id:record.id,date:record.snapshot_date,savedAt:Date.parse(record.uploaded_at),file:record.source_filename,scopeVersion:SCOPE_VERSION,rows:record.rows}}
function cloudControls(){
 const approved=cloudMember?.approval_status==='approved';
 $('#cloudSignOut').hidden=!cloudUserId;$('#cloudLogin').hidden=!!cloudUserId||!!shareToken;
 $('#cloudRequest').hidden=!cloudUserId||!!cloudMember;
 $('#cloudRefresh').disabled=!approved||cloudBusy;
 $('#cloudUpload').disabled=!approved||!['admin','leader'].includes(cloudMember?.role)||cloudBusy||!allWelltakeRows.length||historicalView||sourceMode!=='local';
 $('#cloudAdmin').hidden=!(approved&&cloudMember.role==='admin');
}
function clearCloudMemory(){
 cloudEpoch++;cloudCatalog=[];cloudCurrentId=null;
 $('#cloudMembers').replaceChildren();
 if(sourceMode==='cloud'){
  historyRecords=[];historyReady=false;allWelltakeRows=[];activeRows=[];activeFileName='';selectedSite='';TICKETS.length=0;DATA.monthly=[];DATA.handlers=[];DATA.issues=[];DATA.officialSnapshot={};window.__currentActionRows=[];Object.keys(HANDLER_ROLE_MAP).forEach(k=>delete HANDLER_ROLE_MAP[k]);
  Object.assign(IMPORT_STATE,{snapshotDate:null,appliedMonth:null,actionAll:[],actionIncident:[],actionResolved:[]});
  setHistoricalView(false);updateSiteOptions();refreshMonthOptions();renderAll();notice('雲端資料已從畫面移除。本機快取未變動；可按「回到本機資料」。');
 }
}
async function cloudProfile(force=false){
 if(cloudProfileBusy)return;cloudProfileBusy=true;
 let profileEpoch=cloudEpoch;
 try{
 if(!shareToken){
 const {data,error}=await cloudClient.auth.getUser();if(error)throw Error(error.message);
 if(profileEpoch!==cloudEpoch)return;
 const id=data.user?.id;if(!id){cloudUserId=null;cloudMember=null;clearCloudMemory();cloudControls();return}
 if(cloudUserId&&cloudUserId!==id){clearCloudMemory();profileEpoch=cloudEpoch}cloudUserId=id;
 const result=await cloudClient.from('dashboard_members').select('user_id,display_name,role,approval_status,allowed_sites').eq('user_id',id).maybeSingle();
 if(profileEpoch!==cloudEpoch)return;
 if(result.error)throw Error(result.error.message);cloudMember=result.data;
 if(cloudMember?.approval_status!=='approved'){clearCloudMemory();cloudText(cloudMember?'帳號尚未核准或已停用；無法讀取雲端資料。':'已登入，請填寫顯示名稱並申請存取。');cloudControls();return}
 }
 const sites=await cloudRpc('dashboard_raw_sites');
 if(profileEpoch!==cloudEpoch)return;
 if(shareToken)cloudMember={role:'leader',approval_status:'approved'};
 cloudControls();
 const sel=$('#cloudSite'),prev=sel.value;sel.replaceChildren();for(const s of sites){const o=document.createElement('option');o.value=s;o.textContent=s;sel.append(o)}
 sel.value=sites.includes(prev)?prev:sites[0]||'';
 if(!sites.length)cloudText('尚無已上傳資料，請先匯入第一份 Raw。');
 else if(!cloudDirty)await cloudRefresh(force);
 if(cloudMember?.role==='admin')await cloudListMembers();
 }catch(e){if(shareToken){cloudMember=null;clearCloudMemory()}throw e}finally{cloudProfileBusy=false}
}
async function cloudLoadRecord(id,historical=false){
 const epoch=cloudEpoch,site=$('#cloudSite').value;
 const record=await cloudRpc('dashboard_raw_read',{p_id:id,p_site:site});
 if(epoch!==cloudEpoch||site!==$('#cloudSite').value)return;
 const rows=selectLatestRows(cloudCanonical(record.rows));validateSnapshot(rows,record.snapshot_date);
 const loadedHistory=[cloudHistory(record)];
 // Only another snapshot from this same site is eligible for interval comparison.
 const loadedDates=new Set([record.snapshot_date]);
 for(const entry of cloudCatalog){
  if(entry.snapshot_date>record.snapshot_date||loadedDates.has(entry.snapshot_date))continue;
  loadedDates.add(entry.snapshot_date);
  const cached=sourceMode==='cloud'&&selectedSite===site&&historyRecords.find(s=>s.id===entry.id);
  if(cached){loadedHistory.push(cached);continue}
  const past=await cloudRpc('dashboard_raw_read',{p_id:entry.id,p_site:site});
  if(epoch!==cloudEpoch||site!==$('#cloudSite').value)return;
  loadedHistory.push(cloudHistory(past));
 }
 sourceMode='cloud';cloudDirty=false;selectedSite=site;cloudCurrentId=record.id;
 historyRecords=loadedHistory;historyReady=true;
 setHistoricalView(historical);buildCurrentModel(rows,record.snapshot_date,record.source_filename);
 notice(`雲端${historical?'歷史':'最新'}版本｜${site}｜資料日期 ${record.snapshot_date}｜上傳時間 ${new Date(record.uploaded_at).toLocaleString('zh-TW')}｜${record.row_count} 件。雲端資料不寫入本機 Raw 快取。`);
 cloudText(`已同步｜${cloudMember?.display_name||(shareToken?'分享連結':'已核准帳號')}｜${site}。最新依資料日期排序，同日取最後成功上傳版本；補傳舊日期不覆蓋較新現況。`);cloudControls();
}
async function cloudRefresh(force=false){
 if(cloudBusy||!cloudMember||cloudMember.approval_status!=='approved'||!$('#cloudSite').value)return;
 if((cloudDirty||historicalView)&&!force){cloudText('正在檢視本機新匯入或歷史資料，暫不自動切換；按「讀取雲端最新」可回到最新版本。');return}
 if(force&&cloudDirty&&!confirm('目前本機 Raw 尚未上傳。切換雲端檢視？本機已保存資料保留，但尚未保存的匯入預覽不會上傳。'))return;
 cloudBusy=true;cloudControls();const epoch=++cloudEpoch,site=$('#cloudSite').value;
 try{
  const catalog=await cloudRpc('dashboard_raw_catalog',{p_site:site});if(epoch!==cloudEpoch)return;
  const changed=catalog.length!==cloudCatalog.length||catalog.some((e,i)=>e.id!==cloudCatalog[i]?.id);
  cloudCatalog=catalog;const latest=catalog[0];
  if(!latest){clearCloudMemory();cloudText('此廠區尚無正式資料。');return}
  if(force||changed||sourceMode!=='cloud'||latest.id!==cloudCurrentId)await cloudLoadRecord(latest.id);
  else cloudText(`已確認最新版本｜${site}｜${new Date().toLocaleTimeString('zh-TW')}。每 60 秒檢查一次。`);
 }catch(e){if(epoch===cloudEpoch){clearCloudMemory();cloudText('雲端讀取失敗，未顯示未驗證的舊雲端資料：'+e.message)}}
 finally{cloudBusy=false;cloudControls()}
}
async function cloudUpload(confirmed=false){
 if(cloudBusy||sourceMode!=='local'||historicalView||!allWelltakeRows.length)throw Error('請等候同步完成並確認本機匯入資料後再試');
 const rows=cloudPayload(allWelltakeRows),sites=[...new Set(rows.map(r=>r.site))].sort();
 if(sites.includes(''))throw Error('有案件缺少 Site，請先補齊廠區再上傳');
 const snapshot=IMPORT_STATE.snapshotDate,file=activeFileName;
 if(!confirmed&&!confirm(`上傳至公司 Supabase 專案：${file}\n資料日期 ${snapshot}｜${rows.length} 件｜廠區 ${sites.join('、')}\n包含案件編號、承辦人、狀態、日期與分類；不含問題描述及聯絡個資。全廠區分享連結啟用時，持有人可讀取。確認上傳？`))return;
 const fingerprint=JSON.stringify({snapshot,file,rows});if(!pendingUpload||pendingUpload.fingerprint!==fingerprint)pendingUpload={fingerprint,id:crypto.randomUUID()};
 cloudBusy=true;cloudControls();const epoch=cloudEpoch;
 try{
  const batches=await cloudRpc('dashboard_raw_upload',{p_upload_id:pendingUpload.id,p_snapshot:snapshot,p_filename:file,p_rows:rows});
  if(!Array.isArray(batches)||batches.length!==sites.length)throw Error('資料庫未回傳完整上傳結果');
  for(const batch of batches){
   const saved=await cloudRpc('dashboard_raw_read',{p_id:batch.id,p_site:batch.site});
   if(saved.snapshot_date!==snapshot||saved.row_count!==rows.filter(r=>r.site===batch.site).length)throw Error('資料庫回讀日期或件數不符，請重試');
  }
  notice('資料庫已確認保存｜資料日期 '+snapshot+'｜'+rows.length+' 件｜'+sites.join('、'));
  if(epoch!==cloudEpoch)throw Error('檢視範圍已變更，請重新讀取雲端確認上傳結果');cloudDirty=false;pendingUpload=null;cloudText('上傳交易完成，正在讀取最新版本。');
 }finally{cloudBusy=false;cloudControls()}
 await cloudProfile();
}
async function useLocalData(){
 clearCloudMemory();sourceMode='local';historyRecords=await hDB();localHistoryRecords=historyRecords;historyReady=true;
 allWelltakeRows=[];activeRows=[];TICKETS.length=0;DATA.monthly=[];DATA.handlers=[];DATA.issues=[];selectedSite='';
 Object.assign(IMPORT_STATE,{snapshotDate:null,appliedMonth:null,actionAll:[],actionIncident:[],actionResolved:[]});setHistoricalView(false);updateSiteOptions();renderAll();
 await restoreRawSafely();cloudDirty=!!latestLocalRecord;cloudControls();
}
async function cloudListMembers(){
 const epoch=cloudEpoch;
 const {data,error}=await cloudClient.from('dashboard_members').select('user_id,display_name,role,approval_status,allowed_sites').order('created_at');if(error)throw Error(error.message);
 if(epoch!==cloudEpoch||cloudMember?.role!=='admin')return;
 const box=$('#cloudMembers');box.replaceChildren();
 for(const m of data.filter(m=>m.role!=='admin')){
  const row=document.createElement('div');row.className='data-note';
  const name=document.createElement('span');name.textContent=`${m.display_name}｜${m.approval_status}｜`;row.append(name);
  const role=document.createElement('select');for(const [value,label] of [['viewer','僅檢視'],['leader','可上傳']]){const o=document.createElement('option');o.value=value;o.textContent=label;role.append(o)}role.value=m.role;row.append(role);
  const sites=document.createElement('input');sites.placeholder='授權 Site，以逗號分隔';sites.value=m.allowed_sites.join(',');row.append(sites);
  for(const [status,label] of [['approved','核准／更新'],['disabled','停用']]){const btn=document.createElement('button');btn.textContent=label;btn.onclick=()=>cloudAction(async()=>{const allowed=sites.value.split(',').map(s=>s.trim()).filter(Boolean);if(!confirm(`${label} ${m.display_name}？角色 ${role.value}，廠區 ${allowed.join('、')||'無'}。`))return;await cloudRpc('dashboard_raw_review_member',{p_user:m.user_id,p_role:role.value,p_status:status,p_sites:allowed});await cloudListMembers()});row.append(btn)}
  box.append(row);
 }
 if(!box.children.length)box.textContent='尚無待審核的一般帳號。';
}
async function cloudAction(fn){try{await fn()}catch(e){cloudText('未完成：'+e.message)}finally{cloudControls()}}
async function cloudInit(){
 $('#cloudLocal').onclick=()=>cloudAction(useLocalData);
 shareToken=new URLSearchParams(location.hash.slice(1)).get('share');
 if(shareToken){await initSharedAccess();return}
 notice('本機模式｜請使用完整分享連結，才能將匯入資料上傳並跨電腦查看。');
 $('#applyRawBtn').textContent='僅套用本機資料';
 if(!window.supabase){cloudText('雲端登入元件未載入；本機功能仍可使用。請確認網路後重新整理。');return}
 shareToken=new URLSearchParams(location.hash.slice(1)).get('share');
 if(shareToken)$('#applyRawBtn').textContent='確認匯入並上傳';
 if(shareToken&&!/^[a-f0-9]{64}$/.test(shareToken)){cloudText('分享連結格式錯誤');return}
 cloudClient=supabase.createClient(CLOUD_URL,CLOUD_KEY,{auth:{storageKey:'welltake-dashboard-auth-v1',persistSession:!shareToken,detectSessionInUrl:!shareToken,flowType:'pkce'}});
 $('#cloudLogin').onclick=()=>cloudAction(async()=>{const email=$('#cloudEmail').value.trim();if(!email)throw Error('請輸入登入信箱');const redirect=new URL(location.href);redirect.search='';redirect.hash='';const {error}=await cloudClient.auth.signInWithOtp({email,options:{emailRedirectTo:redirect.href}});if(error)throw Error(error.message);cloudText('已寄出登入連結，請在同一瀏覽器開啟。信件有寄送頻率限制，請勿連續重寄。')});
 $('#cloudSignOut').onclick=()=>cloudAction(async()=>{clearCloudMemory();const {error}=await cloudClient.auth.signOut();if(error)throw Error(error.message);cloudUserId=null;cloudMember=null;cloudText('已登出。')});
 $('#cloudRequest').onclick=()=>cloudAction(async()=>{await cloudRpc('request_dashboard_access',{p_name:$('#cloudName').value.trim()});await cloudProfile()});
 $('#cloudRefresh').onclick=()=>cloudAction(()=>cloudRefresh(true));
 $('#cloudUpload').onclick=()=>cloudAction(cloudUpload);
 $('#cloudSite').onchange=()=>{cloudEpoch++;clearCloudMemory();cloudAction(()=>cloudRefresh(true))};
 if(shareToken){
  $('#cloudEmail').parentElement.hidden=true;$('#cloudName').parentElement.hidden=true;
  cloudDirty=false;
  await cloudAction(cloudProfile);
 }else{
  for(const [id,enable] of [['issueShare',true],['revokeShare',false]]){
   $('#'+id).onclick=()=>cloudAction(async()=>{
    if(!confirm(enable?'建立新連結？先前連結將失效。':'停用全廠區分享連結？'))return;
    const token=await cloudRpc('dashboard_manage_share',{p_enable:enable});
    const field=$('#shareResult');field.value=token?location.origin+location.pathname+'#share='+token:'';
    field.hidden=!token;if(token){field.focus();field.select()}cloudText(token?'請複製全廠區分享網址。':'分享連結已停用。');
   });
  }
 cloudClient.auth.onAuthStateChange((event)=>{if(event==='SIGNED_OUT'){cloudUserId=null;cloudMember=null;clearCloudMemory();cloudControls()}else if(event==='SIGNED_IN')setTimeout(()=>cloudAction(cloudProfile),0)});
 const session=await cloudClient.auth.getSession();
 if(session.error)cloudText('登入狀態無法讀取：'+session.error.message);
 else if(session.data.session)await cloudAction(cloudProfile);
 else{cloudText('尚未登入雲端；本機資料可繼續使用。');cloudControls()}
 }
 const refreshVisible=()=>{if(document.hidden)return;
  if(shareToken&&!cloudDirty&&!historicalView)cloudAction(cloudProfile);
  else if(sourceMode==='cloud')cloudAction(()=>cloudRefresh());
 };
 setInterval(refreshVisible,60000);
 document.addEventListener('visibilitychange',refreshVisible);
}

async function initSharedAccess(){
 const status=$('#cloudStatus');
 status.closest('details').open=true;
 $('#applyRawBtn').textContent='確認匯入並上傳';
 if(!/^[a-f0-9]{64}$/.test(shareToken)){notice('分享連結格式錯誤，尚未連接資料庫。');return}
 // Shared access uses the native browser request API, independent of the login SDK.
 cloudClient={rpc:async(name,args)=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
  try{
   const response=await fetch(CLOUD_URL+'/rest/v1/rpc/'+name,{
    method:'POST',headers:{apikey:CLOUD_KEY,'Content-Type':'application/json'},
    body:JSON.stringify(args),signal:controller.signal
   });
   const result=await response.json();
   if(!response.ok)return {error:{message:result.message||'資料庫連線失敗 ('+response.status+')'}};
   return {data:result};
  }finally{clearTimeout(timer)}
 }};
 $('#cloudEmail').parentElement.hidden=true;
 $('#cloudName').parentElement.hidden=true;
 $('#cloudRefresh').onclick=()=>cloudAction(()=>cloudProfile(true));
 $('#cloudUpload').onclick=()=>cloudAction(()=>cloudUpload());
 $('#cloudSite').onchange=()=>{clearCloudMemory();cloudAction(()=>cloudRefresh(true))};
 cloudDirty=false;
 notice('正在連接共享資料庫…');
 await cloudAction(cloudProfile);
 if(sourceMode!=='cloud'){
  notice(cloudMember?'資料庫已連線｜目前顯示本機資料，請按「上傳目前 Raw」同步。':'資料庫連線失敗｜'+status.textContent);
 }
 const refresh=()=>{if(!document.hidden&&!cloudDirty&&!historicalView)cloudAction(cloudProfile)};
 setInterval(refresh,60000);
 document.addEventListener('visibilitychange',refresh);
}
