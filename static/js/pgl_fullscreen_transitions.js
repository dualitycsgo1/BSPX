/* PGL full-screen takes: keep the current frame until its successor is ready.
 * Only the six PGL full-screen templates on PROGRAM layer 5 are managed.
 * No server, controller, CITO, ticker or other layer is changed here.
 */
(function () {
  'use strict';
  const settings={enabled:true,layer:5,sound:true,wipe:true,
    templateFolders:['pgl-masters','PGL TEST'],
    video:'',cover:'', // empty = resolve next to the actual template, including renamed packs
    // Measured from the supplied alpha channel, not a wall-clock delay.
    cutSeconds:1.1,coverStart:62/60,coverEnd:70/60,
    readyTimeoutMs:20000,mediaTimeoutMs:4000,stallTimeoutMs:3000};
  const names=new Set(['next-match.html','schedule.html','swiss.html','player.html','h2h.html','team.html']);
  const query=new URLSearchParams(location.search);
  if(query.get('pglTransitions')==='0')settings.enabled=false;
  if(query.get('pglWipeSound')==='0')settings.sound=false;
  let active=null,pending=null,queued=null,selected=null,serial=0,phase='idle',lastError=null,video=null,cover=null;

  function fields(raw){
    if(typeof raw==='string'){try{return JSON.parse(raw);}catch{return {};}}
    if(!Array.isArray(raw))return raw&&typeof raw==='object'?{...raw}:{};
    const out={};for(const item of raw){if(!item||typeof item!=='object')continue;
      if(item.field)out[item.field]=item.value;else Object.assign(out,item);}
    return out;
  }
  function itemID(data){return String(data?.itemID||fields(data?.fields).epochID||'');}
  function sameItem(a,b){const x=itemID(a),y=itemID(b);return x&&y?x===y:a?.relpath===b?.relpath;}
  function notify(state,extra={}){
    phase=state;window.dispatchEvent(new CustomEvent('pgl-fullscreen-transition',{detail:{phase:state,
      active:active?.data?.relpath||null,pending:pending?.data?.relpath||null,...extra}}));
  }
  function warn(message){lastError=message;console.warn('[PGL transition] '+message);}
  function resolveTemplate(data,context){
    try{
      const root=new URL(context.templateRoot,location.href);
      const url=new URL(String(data.relpath||'').replace(/^\/+/,''),root);
      const parts=url.pathname.split('/');
      if(url.origin!==location.origin||!settings.templateFolders.includes(decodeURIComponent(parts[parts.length-2]||''))||!names.has(parts[parts.length-1]))return null;
      for(const [key,value] of query)if(!['preview','play','random'].includes(key))url.searchParams.set(key,value);
      url.searchParams.set('random',Date.now()+'-'+serial);
      return url.href;
    }catch{return null;}
  }
  function timeout(job,ms,label,tx){
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error(label)),ms);
      tx?.cleanups.push(()=>{clearTimeout(timer);reject(Error('Transition cancelled.'));});
      Promise.resolve(job).then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});
    });
  }
  function valid(tx){return pending===tx&&!tx.cancelled;}
  function resource(tx,key){
    return settings[key]||new URL('assets/video/'+(key==='video'?'general-wipe-60.webm':'general-wipe-cover.png'),tx.url).href;
  }
  function media(tx){
    if(video)return;
    const root=document.getElementById('root');
    video=document.createElement('video');video.id='pglFullscreenWipe';video.preload='auto';video.playsInline=true;
    video.setAttribute('aria-hidden','true');video.style.cssText='position:absolute;inset:0;width:100%;height:100%;object-fit:fill;pointer-events:none;z-index:900;visibility:hidden';
    cover=new Image();cover.id='pglFullscreenCover';cover.alt='';cover.style.cssText=video.style.cssText+';z-index:901';
    root.append(video,cover);video.src=resource(tx,'video');cover.src=resource(tx,'cover');
  }
  function hideMedia(){
    if(video){video.pause();video.style.visibility='hidden';}
    if(cover){cover.getAnimations().forEach(a=>a.cancel());cover.style.visibility='hidden';}
  }
  function cancelPending(){
    const tx=pending;if(!tx)return;
    tx.cancelled=true;pending=null;
    for(const cleanup of tx.cleanups.splice(0))cleanup();
    if(!tx.committed)tx.frame.remove();
    hideMedia();
  }
  function reset(){queued=null;selected=null;cancelPending();active=null;hideMedia();notify('idle');}
  function loaded(frame,url){
    return new Promise((resolve,reject)=>{
      frame.onload=()=>{frame.onload=null;try{
        const win=frame.contentWindow;
        if(win?.PGLPlayout?.version!==1)throw Error('The new PGL template runtime is missing.');
        resolve(win);
      }catch(e){reject(e);}};
      frame.onerror=()=>reject(Error('The next template could not be loaded.'));
      frame.src=url;
    });
  }
  function retire(frame){
    if(!frame)return;
    try{frame.contentDocument?.querySelectorAll('video,audio').forEach(v=>v.pause());}catch{}
    frame.onload=null;frame.remove();
  }
  function commit(tx){
    if(!valid(tx)||tx.committed)return;
    const old=document.getElementById('layer'+settings.layer);
    if(old)old.id='pglRetired-'+tx.id;
    tx.frame.id='layer'+settings.layer;tx.frame.className='frame htmlFrame';
    tx.frame.style.opacity='1';tx.frame.removeAttribute('aria-hidden');
    active={frame:tx.frame,data:tx.data,onAir:true};tx.committed=true;
    tx.frame.contentWindow.PGLPlayout?.activate?.();
    retire(old);notify('take',{mediaTime:video?.currentTime||0,safeCover:tx.safeCover||false});
  }
  function complete(tx){
    if(!valid(tx))return;
    const update=tx.queuedUpdate;
    pending=null;for(const cleanup of tx.cleanups.splice(0))cleanup();hideMedia();notify('idle');
    if(update&&active){active.data={...active.data,fields:update.fields};
      Promise.resolve(active.frame.contentWindow.update(JSON.stringify(fields(update.fields)))).catch(e=>warn(e.message));}
    if(queued){const next=queued;queued=null;start(next.data,next.context,next.url);}
  }
  async function fallback(tx,reason){
    if(!valid(tx)||tx.fallingBack)return;tx.fallingBack=true;warn(reason);
    // If a decoder skips the entire opaque window, a frame extracted from that
    // window covers the swap. Never swap underneath a transparent wipe frame.
    if(reason==='The decoder skipped the covered cut point.'&&cover?.complete&&cover.naturalWidth){
      video.pause();cover.style.visibility='visible';
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(!valid(tx))return;tx.safeCover=true;commit(tx);video.style.visibility='hidden';
      const fade=cover.animate([{opacity:1},{opacity:0}],{duration:180,fill:'forwards'});
      await fade.finished.catch(()=>{});if(!valid(tx))return;
    }else commit(tx); // prepared full-screen frame replaces the old frame atomically
    complete(tx);
  }
  async function wipe(tx){
    media(tx);
    if(!settings.wipe){commit(tx);complete(tx);return;}
    try{
      const videoUrl=resource(tx,'video'),coverUrl=resource(tx,'cover');
      if(video.getAttribute('src')!==videoUrl){video.src=videoUrl;video.load();}
      if(cover.getAttribute('src')!==coverUrl)cover.src=coverUrl;
      await timeout(new Promise((resolve,reject)=>{
        if(video.error){reject(Error('The transition video is unavailable.'));return;}
        if(video.readyState>=2){resolve();return;}
        const good=()=>{cleanup();resolve();},bad=()=>{cleanup();reject(Error('The transition video is unavailable.'));};
        const cleanup=()=>{video.removeEventListener('loadeddata',good);video.removeEventListener('error',bad);};
        tx.cleanups.push(cleanup);video.addEventListener('loadeddata',good);video.addEventListener('error',bad);
      }),settings.mediaTimeoutMs,'The transition video did not become ready.',tx);
      if(!valid(tx))return;
      video.pause();video.currentTime=0;video.muted=!settings.sound;
      let callback=null,mode='',lastTime=-1,lastProgress=performance.now();
      const ended=()=>{if(!valid(tx))return;if(!tx.committed){fallback(tx,'The decoder skipped the covered cut point.');return;}complete(tx);};
      const error=()=>fallback(tx,'The transition video could not be played.');
      video.addEventListener('ended',ended);video.addEventListener('error',error);
      tx.cleanups.push(()=>{video.removeEventListener('ended',ended);video.removeEventListener('error',error);
        if(callback!==null){if(mode==='video')video.cancelVideoFrameCallback?.(callback);else cancelAnimationFrame(callback);}});
      const watch=(_,metadata)=>{
        if(!valid(tx)||tx.fallingBack)return;
        const t=metadata?.mediaTime??video.currentTime;
        if(!tx.committed&&t>=settings.cutSeconds-.001){
          if(t>=settings.coverStart-.001&&t<=settings.coverEnd+.001){tx.safeCover=true;commit(tx);}
          else{fallback(tx,'The decoder skipped the covered cut point.');return;}
        }
        if(video.requestVideoFrameCallback){mode='video';callback=video.requestVideoFrameCallback(watch);}
        else{mode='raf';callback=requestAnimationFrame(watch);}
      };
      const watchdog=setInterval(()=>{
        if(!valid(tx))return;
        if(video.currentTime!==lastTime){lastTime=video.currentTime;lastProgress=performance.now();}
        else if(performance.now()-lastProgress>settings.stallTimeoutMs)fallback(tx,'The transition video stalled.');
      },200);tx.cleanups.push(()=>clearInterval(watchdog));
      notify('wipe');video.style.visibility='visible';watch();
      try{await video.play();}catch(e){
        if(!valid(tx))return;video.muted=true;await video.play();
      }
    }catch(e){if(valid(tx))fallback(tx,e.message);}
  }
  async function start(data,context,url){
    cancelPending();lastError=null;
    const old=active?.onAir&&active.frame===document.getElementById('layer'+settings.layer)&&active.frame.contentWindow.PGLPlayout?.isOn()?active:null;
    const frame=document.createElement('iframe');frame.id='pglStaging-'+(++serial);frame.className='frame pgl-staging-frame';
    frame.allow='autoplay';frame.setAttribute('aria-hidden','true');frame.style.cssText='z-index:'+(100+settings.layer)+';opacity:0;pointer-events:none';
    const tx={id:serial,data:{...data,fields:data.fields},context,url,frame,old,cleanups:[],committed:false,cancelled:false};
    pending=tx;document.getElementById('root').append(frame);notify('preparing');
    try{
      const win=await timeout(loaded(frame,url),settings.readyTimeoutMs,'The next template did not load in time.',tx);
      if(!valid(tx))return;
      const ready=await timeout(win.PGLPlayout.prepare(JSON.stringify(fields(data.fields))),settings.readyTimeoutMs,'The next graphic did not become ready in time.',tx);
      if(!valid(tx))return;
      if(old&&!ready?.ready)throw Error('The next graphic is waiting for data. The current graphic remains on air.');
      if(!old){commit(tx);await win.PGLPlayout.take({instant:false});if(valid(tx))complete(tx);media(tx);return;}
      await timeout(win.PGLPlayout.take({instant:true,deferVideo:true}),settings.readyTimeoutMs,'The next graphic could not be drawn.',tx);
      if(valid(tx))wipe(tx);
    }catch(e){if(valid(tx)){warn(e.message);cancelPending();notify('error',{message:e.message});}}
  }

  function handle(data,context){
    if(data.spxcmd==='clearAllLayers'){
      reset();document.querySelectorAll('.htmlFrame').forEach(frame=>{frame.onload=null;});return false;
    }
    if(data.spxcmd==='clearLayer'&&Number(data.layerno)===settings.layer){
      reset();const frame=document.getElementById('layer'+settings.layer);if(frame)frame.onload=null;return false;
    }
    if(!settings.enabled||context.preview)return false;
    if(Number(data.webplayout)!==settings.layer||context.validateLayer(data.webplayout)!==settings.layer)return false;
    if(data.modify==='autoPlayLocal'&&!context.local)return false;
    const format=data.projectFormat||'SPX';
    if(data.spxcmd==='playTemplate'){
      const url=format==='SPX'?resolveTemplate(data,context):null;
      if(!url){reset();return false;}
      selected={...data};
      if(pending&&(phase==='wipe'||phase==='take')){queued={data:{...data},context,url};notify(phase,{queued:data.relpath});return true;}
      start(data,context,url);return true;
    }
    if(data.spxcmd==='loadTemplate'&&active?.onAir&&format==='SPX'&&resolveTemplate(data,context))return true;
    if(data.spxcmd==='stopTemplate'&&(active||pending)){
      // Follow the operator's latest selected item, even if its load failed and
      // we are deliberately holding the old picture. STOP must still work.
      // Conversely, an old auto-out may not interrupt a successor being loaded.
      if(itemID(data)&&itemID(selected)&&itemID(data)!==itemID(selected))return true;
      queued=null;cancelPending();
      if(active){active.onAir=false;active.frame.contentWindow.stop?.();}
      notify('stopped');return true;
    }
    if(data.spxcmd==='updateTemplate'&&(active||pending)){
      if(pending&&(!data.relpath||sameItem(pending.data,data))){
        if(phase==='preparing'){start({...pending.data,fields:data.fields},pending.context,pending.url);}
        else pending.queuedUpdate=data;
        return true;
      }
      if(active&&(!data.relpath||sameItem(active.data,data))){active.data={...active.data,fields:data.fields};
        Promise.resolve(active.frame.contentWindow.update(JSON.stringify(fields(data.fields)))).catch(e=>warn(e.message));return true;}
      return true; // do not apply an update for an old item to the new graphic
    }
    return false;
  }
  window.PGLFullscreenTransitions={handle,reset,
    configure:options=>{Object.assign(settings,options);},
    getState:()=>({phase,active:active?{relpath:active.data.relpath,itemID:itemID(active.data),onAir:active.onAir}:null,
      pending:pending?{relpath:pending.data.relpath,committed:pending.committed}:null,queued:queued?.data?.relpath||null,lastError,
      selected:selected?.relpath||null,mediaTime:video?.currentTime||0,sound:settings.sound})};
})();
