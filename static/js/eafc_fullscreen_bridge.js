/* EAFC only: route program layer 5 through the persistent fullscreen player. */
(function(){
 'use strict';
 const names=new Set(['h2h','player','program','bracket','results','roadmap','rundens-maal','rundens-maal-vinder']);
 let selected=null,serial=0,loading=null,host=null,error='';
 const fields=raw=>{try{const v=typeof raw==='string'?JSON.parse(raw):raw;if(!Array.isArray(v))return v&&typeof v==='object'?v:{};const out={};for(const x of v){if(!x||typeof x!=='object')continue;if(x.field)out[x.field]=x.value;else Object.assign(out,x);}return out;}catch{return {};}};
 const itemID=data=>String(data?.itemID||'');
 function resolve(data,context){try{const root=new URL(context.templateRoot,location.href),url=new URL(String(data.relpath||'').replace(/^\//,''),root),parts=url.pathname.split('/'),name=parts.at(-1).replace(/\.html$/,'');if(url.origin!==location.origin||decodeURIComponent(parts.at(-2)).toLowerCase()!=='eafc'||!names.has(name))return null;return {name,url:new URL('fullscreen.html',url)};}catch{return null;}}
 function current(){const frame=document.getElementById('layer5');return frame===host&&frame?.contentWindow?.EAFCFullscreen?frame.contentWindow:null;}
 function reset(clear=true){++serial;selected=null;loading=null;if(clear)current()?.EAFCFullscreen.clear();error='';}
 async function ensure(spec){
  if(current())return current();if(loading)return loading;
  const frame=document.getElementById('layer5');if(!frame)throw Error('BSPX layer 5 is missing.');host=frame;
  loading=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{frame.onload=null;loading=null;reject(Error('EAFC player timed out.'));},15000);frame.onload=()=>{clearTimeout(timer);frame.onload=null;loading=null;const w=frame.contentWindow;if(w?.EAFCFullscreen)resolve(w);else reject(Error('EAFC player is unavailable.'));};
   const params=new URLSearchParams(location.search);if(params.get('eafcWipeSound')==='0')spec.url.searchParams.set('sound','0');frame.allow='autoplay';frame.src=spec.url.href;
  });return loading;
 }
 function handle(data,context){
  if(data.spxcmd==='clearAllLayers'||data.spxcmd==='clearLayer'&&Number(data.layerno)===5){reset();return false;}
  if(context.preview||Number(data.webplayout)!==5||context.validateLayer(data.webplayout)!==5)return false;
  if(data.modify==='autoPlayLocal'&&!context.local)return false;
  const spec=(data.projectFormat||'SPX')==='SPX'?resolve(data,context):null;
  if(data.spxcmd==='playTemplate'){
   if(!spec){if(selected)reset();return false;}
   // The normal PGL handler would reset its pending take when handed a non-PGL template.
   window.PGLFullscreenTransitions?.reset();
   const ticket=++serial;selected={...data};error='';
   ensure(spec).then(async w=>{if(ticket!==serial)return;const result=await w.EAFCFullscreen.select(spec.name,fields(selected.fields));if(ticket!==serial)return;if(!result){error=w.EAFCFullscreen.getState().error||'EAFC take failed.';return;}if(selected.queuedFields){await w.update(fields(selected.queuedFields));delete selected.queuedFields;}}).catch(e=>{if(ticket===serial){error=e.message;console.warn('[EAFC]',error);}});
   return true;
  }
  if(data.spxcmd==='loadTemplate'&&spec&&selected)return true;
  if(!selected)return false;
  if(!spec&&data.relpath)return false;
  if(itemID(data)&&itemID(selected)&&itemID(data)!==itemID(selected))return ['stopTemplate','updateTemplate','nextTemplate'].includes(data.spxcmd);
  const win=current();
  if(data.spxcmd==='stopTemplate'){++serial;win?.stop();return true;}
  if(data.spxcmd==='nextTemplate'){win?.next();return true;}
  if(data.spxcmd==='updateTemplate'){selected.fields=data.fields;const state=win?.EAFCFullscreen.getState();if(!win||state?.busy)selected.queuedFields=data.fields;else Promise.resolve(win.update(fields(data.fields))).catch(e=>console.warn('[EAFC]',e.message));return true;}
  return false;
 }
 window.EAFCFullscreenBridge={handle,reset,getState:()=>({selected:selected?.relpath||'',error,player:current()?.EAFCFullscreen.getState()||null})};
})();
