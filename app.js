(function () {
  "use strict";

  const catalog = Array.isArray(window.TRIGGER_CATALOG) ? window.TRIGGER_CATALOG.filter(Boolean) : [];
  const DAY_SECONDS = 24 * 60 * 60;
  const MIN_SLOT_SECONDS = 30 * 60;
  const OMNI_CONTROL_URL = "https://www-infinity4.github.io/Omni-Control/channels.json";

  const fallbackChannels = [
    ["Hermit TV","Hermit-TV"],["Star Launcher","Star-Launcher"],["HBO","HBO"],
    ["Cinemax","Cinemax"],["Showtime","Showtime"],["Starz","Starz"],["Encore","Encore"],
    ["Cartoon Network","Cartoon-Network"],["WGN","WGN"],["NBC","NBC"],["FOX","FOX"],
    ["PBS","PBS"],["TNT","TNT"],["History Channel","History-Channel"],["Disney Vintage","Disney"],
    ["Discovery","Discovery"],["Chiller","Chiller"],["Trump TV","Trump-TV"],["ShopLC","ShopLC"],
    ["Trigger TV","Trigger-TV"],["StarQuest","TV-Database"],["Astraflix","Astraflix"],
    ["Syncord","Syncord"],["Vintech","Vintech"],["Abstractia","Abstractia-"],
    ["Flix Blender","Flix-Blender"],["Animasync","Animasync"]
  ].map(([name, slug]) => ({name, slug, url:`https://www-infinity4.github.io/${slug}/`}));

  const $ = id => document.getElementById(id);
  const els = {
    clock: $("stationClock"), title: $("nowTitle"), meta: $("nowMeta"), time: $("programTime"),
    mode: $("modeLabel"), enter: $("enterButton"), station: $("stationCard"),
    stationTitle: $("stationCardTitle"), stationCountdown: $("stationCardCountdown"),
    position: $("positionLabel"), remaining: $("remainingLabel"), bar: $("progressBar"),
    next: $("nextCards"), guide: $("guideRows"), guideDate: $("guideDate"),
    share: $("shareButton"), shareStatus: $("shareStatus"), walletAmount: $("walletAmount"),
    walletButton: $("walletButton"), liveButton: $("liveButton"),
    startOverButton: $("startOverButton"), rewindButton: $("rewindButton")
  };

  let ytPlayer = null;
  let playerReady = false;
  let entered = false;
  let mode = "live";
  let manualOffset = 0;
  let lastSlotKey = "";
  let lastDayKey = "";
  let currentProgram = null;
  let currentBreakKey = "";
  let pendingLoad = null;

  function pad(n){ return String(n).padStart(2,"0"); }
  function dateKey(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
  function dayStart(d){ return new Date(d.getFullYear(),d.getMonth(),d.getDate()); }
  function fmtTime(d){ return d.toLocaleTimeString([], {hour:"numeric",minute:"2-digit"}); }
  function fmtDur(seconds){
    const value=Math.max(0,Math.floor(Number(seconds)||0));
    const h=Math.floor(value/3600), m=Math.floor((value%3600)/60), s=value%60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function hash(str){
    let h=2166136261;
    for(let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=Math.imul(h,16777619); }
    return h>>>0;
  }
  function rng(seed){
    let x=seed||123456789;
    return ()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return (x>>>0)/4294967296; };
  }
  function seededShuffle(items,seedText){
    const out=items.slice(), random=rng(hash(seedText));
    for(let i=out.length-1;i>0;i--){ const j=Math.floor(random()*(i+1)); [out[i],out[j]]=[out[j],out[i]]; }
    return out;
  }
  function safeJSON(key,fallback){
    try{ return JSON.parse(localStorage.getItem(key))||fallback; }catch(_){ return fallback; }
  }
  function imageFor(program){
    if(!program || !program.videoId) return "";
    return program.posterUrl || `https://i.ytimg.com/vi/${program.videoId}/hqdefault.jpg`;
  }
  function slotSeconds(program){
    return Math.max(60,Math.floor(Number(program && program.slotSeconds)||Number(program && program.runtimeSeconds)||1800));
  }
  function runtimeSeconds(program){
    return Math.max(60,Math.min(slotSeconds(program),Math.floor(Number(program && program.runtimeSeconds)||slotSeconds(program))));
  }

  async function loadChannels(){
    try{
      const response=await fetch(`${OMNI_CONTROL_URL}?v=20260913`,{cache:"no-store"});
      if(response.ok){
        const data=await response.json();
        const list=Array.isArray(data)?data:(Array.isArray(data.channels)?data.channels:[]);
        const normalized=list.map(item=>{
          if(typeof item==="string") return {name:item,slug:item,url:`https://www-infinity4.github.io/${item}/`};
          if(!item || !item.name) return null;
          const slug=item.slug||item.repo||item.name.replace(/\s+/g,"-");
          return {name:item.name,slug,url:item.url||`https://www-infinity4.github.io/${slug}/`};
        }).filter(Boolean);
        if(normalized.length) return normalized;
      }
    }catch(_){}
    return fallbackChannels;
  }

  async function renderRemote(){
    const channels=await loadChannels();
    const html=channels.map(channel=>{
      const current=channel.slug==="Trigger-TV"?' aria-current="page"':"";
      return `<a${current} href="${channel.url}">${channel.name}</a>`;
    }).join("");
    const top=$("channelNav"), bottom=$("directoryNav");
    if(top) top.innerHTML=html;
    if(bottom) bottom.innerHTML=html;
  }

  function buildDaySchedule(date){
    const start=dayStart(date);
    const dayKey=dateKey(date);
    const entries=[];
    let offset=0, previousId="", cycle=0;

    while(offset < DAY_SECONDS){
      const remaining=DAY_SECONDS-offset;
      if(remaining < MIN_SLOT_SECONDS){
        entries.push({
          key:`${dayKey}-station`,
          program:{id:"station",title:"Trail Intermission",series:"Trigger TV",year:"",rating:"",kind:"station",runtimeSeconds:0,slotSeconds:remaining},
          startsAtMs:start.getTime()+offset*1000,
          endsAtMs:start.getTime()+DAY_SECONDS*1000,
          offsetSeconds:offset,
          filler:true
        });
        offset=DAY_SECONDS;
        break;
      }

      const batch=seededShuffle(catalog,`TRIGGER|${dayKey}|${cycle}`);
      let candidates=batch.filter(item=>item.id!==previousId && slotSeconds(item)<=remaining);
      if(entries.length && entries[entries.length-1].program.kind==="movie"){
        const episodes=candidates.filter(item=>item.kind!=="movie");
        if(episodes.length) candidates=episodes;
      }
      const program=candidates[0] || batch.find(item=>slotSeconds(item)<=remaining);

      if(!program){
        entries.push({
          key:`${dayKey}-station`,
          program:{id:"station",title:"Trail Intermission",series:"Trigger TV",year:"",rating:"",kind:"station",runtimeSeconds:0,slotSeconds:remaining},
          startsAtMs:start.getTime()+offset*1000,
          endsAtMs:start.getTime()+DAY_SECONDS*1000,
          offsetSeconds:offset,
          filler:true
        });
        offset=DAY_SECONDS;
        break;
      }

      const duration=slotSeconds(program);
      entries.push({
        key:`${dayKey}-${String(entries.length).padStart(2,"0")}`,
        program,
        startsAtMs:start.getTime()+offset*1000,
        endsAtMs:start.getTime()+(offset+duration)*1000,
        offsetSeconds:offset,
        filler:false
      });
      offset+=duration;
      previousId=program.id;
      cycle++;
      if(cycle>200) break;
    }
    return entries;
  }

  function stateAt(now=new Date()){
    const start=dayStart(now);
    const schedule=buildDaySchedule(now);
    const elapsed=Math.max(0,Math.floor((now.getTime()-start.getTime())/1000));
    const entry=schedule.find(item=>elapsed>=item.offsetSeconds && elapsed<item.offsetSeconds+slotSeconds(item.program)) || schedule[schedule.length-1];
    if(!entry) return null;

    const slotElapsed=Math.max(0,Math.floor((now.getTime()-entry.startsAtMs)/1000));
    const program=entry.program;
    const runtime=entry.filler?0:runtimeSeconds(program);
    const inProgram=!entry.filler && slotElapsed<runtime;

    return {
      schedule, entry, program, start, slotElapsed, runtimeSeconds:runtime, inProgram,
      slotStart:new Date(entry.startsAtMs), slotEnd:new Date(entry.endsAtMs),
      slotRemaining:Math.max(0,Math.floor((entry.endsAtMs-now.getTime())/1000)),
      programRemaining:Math.max(0,runtime-slotElapsed),
      key:entry.key
    };
  }

  function futureEntries(state,count){
    const out=[];
    if(!state) return out;
    let schedule=state.schedule, index=schedule.indexOf(state.entry)+1, day=new Date(state.start);

    while(out.length<count){
      while(index<schedule.length && out.length<count){
        if(!schedule[index].filler) out.push(schedule[index]);
        index++;
      }
      if(out.length>=count) break;
      day=new Date(day.getFullYear(),day.getMonth(),day.getDate()+1);
      schedule=buildDaySchedule(day);
      index=0;
    }
    return out;
  }

  function renderNext(state){
    if(!els.next || !state) return;
    els.next.innerHTML="";
    futureEntries(state,4).forEach(entry=>{
      const program=entry.program;
      const card=document.createElement("article");
      card.className="program-card";
      card.style.setProperty("--art",`url('${imageFor(program)}')`);
      card.innerHTML=`<time>${fmtTime(new Date(entry.startsAtMs))}</time><b>${program.title}</b><span>${program.series} · ${program.year} · ${program.rating}</span>`;
      els.next.appendChild(card);
    });
  }

  function renderGuide(){
    if(!els.guide) return;
    els.guide.innerHTML="";
    const now=new Date();
    if(els.guideDate) els.guideDate.textContent="Viewer-local schedule";

    for(let day=0;day<7;day++){
      const d=new Date(now.getFullYear(),now.getMonth(),now.getDate()+day);
      const schedule=buildDaySchedule(d);
      const section=document.createElement("section");
      section.className="guide-day";
      const label=day===0?"Today":day===1?"Tomorrow":d.toLocaleDateString([],{weekday:"long",month:"short",day:"numeric"});
      section.innerHTML=`<h3>${label}</h3><div class="guide-slots"></div>`;
      const grid=section.querySelector(".guide-slots");

      schedule.forEach(entry=>{
        if(entry.filler) return;
        const program=entry.program;
        const current=day===0 && now.getTime()>=entry.startsAtMs && now.getTime()<entry.endsAtMs;
        const slot=document.createElement("article");
        slot.className=`guide-slot${current?" now":""}`;
        slot.innerHTML=`<div class="guide-slot-art"></div><div class="guide-slot-copy"><time>${fmtTime(new Date(entry.startsAtMs))}</time><b>${program.title}</b><span>${program.series} · ${program.year} · ${program.rating}</span></div>`;
        slot.style.setProperty("--art",`url('${imageFor(program)}')`);
        const art=slot.querySelector(".guide-slot-art");
        if(art) art.style.setProperty("--art",`url('${imageFor(program)}')`);
        grid.appendChild(slot);
      });
      els.guide.appendChild(section);
    }
  }

  function updateHeader(state){
    if(!state) return;
    currentProgram=state.program;
    if(els.clock) els.clock.textContent=`${fmtTime(new Date())} local`;
    if(els.title) els.title.textContent=state.program.title;
    if(els.meta) els.meta.textContent=state.entry.filler?"Station intermission":`${state.program.series} · ${state.program.year} · ${state.program.rating}`;
    if(els.time) els.time.textContent=`${fmtTime(state.slotStart)}–${fmtTime(state.slotEnd)}`;

    if(els.position){
      if(state.entry.filler) els.position.textContent="Station break · new daily lineup begins at midnight";
      else if(mode==="live") els.position.textContent=state.inProgram?"Synced with the Trigger TV schedule":"Intermission · next western remains synchronized";
      else els.position.textContent=`${fmtDur(manualOffset)} from program start`;
    }
    if(els.remaining){
      els.remaining.textContent=state.entry.filler?`${fmtDur(state.slotRemaining)} until midnight`:state.inProgram?`${fmtDur(state.programRemaining)} left in program`:`${fmtDur(state.slotRemaining)} until next program`;
    }
    if(els.bar) els.bar.style.width=`${Math.min(100,Math.max(0,(state.slotElapsed/slotSeconds(state.program))*100))}%`;
    document.body.style.setProperty("--current-art",`url('${imageFor(state.program)}')`);
  }

  function showMessage(title,subtitle,key=""){
    if(!els.station) return;
    els.station.hidden=false;
    if(els.stationTitle) els.stationTitle.textContent=title;
    if(els.stationCountdown) els.stationCountdown.textContent=subtitle;
    currentBreakKey=key;
  }
  function hideMessage(){ if(els.station) els.station.hidden=true; currentBreakKey=""; }
  function stopVideoOnce(){
    if(ytPlayer && playerReady && typeof ytPlayer.stopVideo==="function"){ try{ytPlayer.stopVideo();}catch(_){} }
  }

  function showBreak(state){
    const upcoming=futureEntries(state,1)[0];
    const nextTitle=upcoming?upcoming.program.title:"tomorrow's western lineup";
    showMessage(`Next: ${nextTitle}`,`Begins in ${fmtDur(state.slotRemaining)}`,`break:${state.key}`);
    stopVideoOnce();
  }

  function handlePlayerError(event){
    const state=stateAt();
    const code=event&&typeof event.data!=="undefined"?` · YouTube ${event.data}`:"";
    showMessage("This source is unavailable right now",`Trigger TV stays on schedule${code}. The next program begins automatically.`,`error:${state?state.key:"unknown"}`);
  }

  function handlePlayerState(event){
    if(!window.YT || !YT.PlayerState) return;
    if(event.data===YT.PlayerState.ENDED && mode==="live"){
      const state=stateAt();
      if(state) showBreak(state);
    }
  }

  function createOrLoad(program,offsetSeconds){
    if(!program || !program.videoId) return;
    const offset=Math.max(0,Math.min(Math.floor(Number(offsetSeconds)||0),runtimeSeconds(program)-1));
    const start=(Number(program.sourceStart)||0)+offset;
    const end=(Number(program.sourceStart)||0)+runtimeSeconds(program);
    pendingLoad={videoId:program.videoId,start,end};

    if(!window.YT || !YT.Player) return;

    if(!ytPlayer){
      ytPlayer=new YT.Player("player",{
        videoId:program.videoId,
        playerVars:{autoplay:1,start,end,playsinline:1,rel:0,modestbranding:1,origin:location.origin},
        events:{
          onReady:event=>{
            playerReady=true;
            if(pendingLoad && typeof event.target.loadVideoById==="function"){
              event.target.loadVideoById({videoId:pendingLoad.videoId,startSeconds:pendingLoad.start,endSeconds:pendingLoad.end});
            }else event.target.playVideo();
          },
          onError:handlePlayerError,
          onStateChange:handlePlayerState
        }
      });
      return;
    }

    if(playerReady && typeof ytPlayer.loadVideoById==="function"){
      hideMessage();
      ytPlayer.loadVideoById({videoId:program.videoId,startSeconds:start,endSeconds:end});
    }
  }

  function playLive(){
    const state=stateAt();
    mode="live";
    if(els.mode) els.mode.textContent="LIVE TRIGGER TV";
    if(!state || state.entry.filler){ if(state) showBreak(state); return; }
    if(!state.inProgram){ showBreak(state); return; }
    hideMessage();
    currentProgram=state.program;
    createOrLoad(state.program,state.slotElapsed);
  }

  function playAt(seconds,label){
    const state=stateAt();
    if(!state || state.entry.filler) return;
    mode="manual";
    manualOffset=Math.max(0,Math.min(Number(seconds)||0,state.runtimeSeconds-1));
    if(els.mode) els.mode.textContent=label;
    hideMessage();
    currentProgram=state.program;
    createOrLoad(state.program,manualOffset);
  }

  window.onYouTubeIframeAPIReady=function(){ if(entered) playLive(); };

  if(els.enter) els.enter.addEventListener("click",()=>{ entered=true; els.enter.hidden=true; playLive(); });
  if(els.liveButton) els.liveButton.addEventListener("click",playLive);
  if(els.startOverButton) els.startOverButton.addEventListener("click",()=>playAt(0,"STARTED OVER"));
  if(els.rewindButton) els.rewindButton.addEventListener("click",()=>{
    const state=stateAt();
    if(!state || state.entry.filler) return;
    const base=mode==="live"?Math.min(state.slotElapsed,state.runtimeSeconds-1):(ytPlayer&&playerReady&&typeof ytPlayer.getCurrentTime==="function"?Math.max(0,ytPlayer.getCurrentTime()-(Number(state.program.sourceStart)||0)):manualOffset);
    playAt(base-30,"REWOUND 30 SEC");
  });

  function walletProfile(){
    const session=safeJSON("starquest_session",null), users=safeJSON("starquest_users",{});
    if(session&&session.key&&users[session.key]){
      return{profile:users[session.key],save(profile){users[session.key]=profile;localStorage.setItem("starquest_users",JSON.stringify(users));}};
    }
    const guest=safeJSON("starquest_guest_profile_v1",{});
    return{profile:guest,save(profile){localStorage.setItem("starquest_guest_profile_v1",JSON.stringify(profile));}};
  }
  function refreshWallet(){
    if(!els.walletAmount) return;
    const wallet=walletProfile().profile;
    const tokens=Math.max(0,Number(wallet.tokens)||0), pending=Math.max(0,Number(wallet.pendingShareCredits)||0);
    els.walletAmount.textContent=(tokens+pending/10).toFixed(1);
  }
  function recordShare(){
    const wallet=walletProfile(), profile=Object.assign({},wallet.profile);
    profile.shareCount=(Number(profile.shareCount)||0)+1;
    profile.pendingShareCredits=(Number(profile.pendingShareCredits)||0)+1;
    while(profile.pendingShareCredits>=10){profile.pendingShareCredits-=10;profile.tokens=(Number(profile.tokens)||0)+1;}
    wallet.save(profile);
    refreshWallet();
    if(els.shareStatus) els.shareStatus.textContent=`Share counted · ${profile.pendingShareCredits}/10 toward next ⭐`;
  }

  if(els.share) els.share.addEventListener("click",async()=>{
    const data={title:"Trigger TV — Westerns Are Already Playing",text:"Classic western TV and movies are playing live on Trigger TV.",url:"https://www-infinity4.github.io/Trigger-TV/?card=20260913a"};
    try{
      if(navigator.share){await navigator.share(data);recordShare();}
      else if(navigator.clipboard){await navigator.clipboard.writeText(data.url);if(els.shareStatus)els.shareStatus.textContent="Link copied.";}
      else if(els.shareStatus) els.shareStatus.textContent=data.url;
    }catch(err){if(err&&err.name!=="AbortError"&&els.shareStatus)els.shareStatus.textContent="Share did not complete.";}
  });

  if(els.walletButton) els.walletButton.addEventListener("click",()=>{
    const wallet=walletProfile().profile;
    alert("Trigger TV wallet\n\n"+`StarCoins: ${Number(wallet.tokens)||0}\n`+`Share progress: ${Number(wallet.pendingShareCredits)||0}/10\n`+`Confirmed shares: ${Number(wallet.shareCount)||0}`);
  });

  function tick(){
    const now=new Date(), state=stateAt(now);
    if(!state) return;
    updateHeader(state);

    const todayKey=dateKey(now);
    if(todayKey!==lastDayKey){ lastDayKey=todayKey; renderGuide(); }

    if(state.key!==lastSlotKey){
      lastSlotKey=state.key;
      renderNext(state);
      if(entered && mode==="live") playLive();
      return;
    }

    if(entered && mode==="live" && (!state.inProgram || state.entry.filler)){
      const breakKey=`break:${state.key}`;
      if(currentBreakKey!==breakKey) showBreak(state);
      else if(els.stationCountdown) els.stationCountdown.textContent=`Begins in ${fmtDur(state.slotRemaining)}`;
    }
  }

  if(!catalog.length){
    if(els.title) els.title.textContent="No Trigger TV programs loaded";
    if(els.meta) els.meta.textContent="The western catalog is empty.";
    return;
  }

  renderRemote();
  refreshWallet();
  lastDayKey=dateKey(new Date());
  renderGuide();
  tick();
  setInterval(tick,1000);
})();