// Only a fixed activity name crosses into the meeting stream. Never forward tool
// arguments, command output, model reasoning, private file contents or credentials.
export function activityFromEvent(provider,event){
  if(provider==='gpt'){
    if(event.type==='thread.started'||event.type==='turn.started')return 'waiting';
    if(event.type==='error'&&/reconnect|connection|routing discovery|timed out/i.test(event.message||event.error?.message||''))return 'retrying';
    if(!['item.started','item.updated','item.completed'].includes(event.type))return;
    const type=event.item?.type;
    if(type==='web_search')return event.type==='item.completed'?'working':'searching';
    if(type==='file_change')return 'editing';
    if(type==='command_execution')return event.type==='item.completed'?'working':'command';
    if(type==='agent_message')return 'responding';
  }
  if(provider==='claude'){
    if(event.type==='system'&&event.subtype==='init')return 'waiting';
    const tools={WebSearch:'searching',WebFetch:'fetching',Read:'reading',Glob:'reading',Grep:'reading',Edit:'editing',Write:'editing',Bash:'command'};
    if(event.type==='assistant'){
      const tool=event.message?.content?.find(c=>c.type==='tool_use');
      if(tool)return tools[tool.name]||'working';
      if(event.message?.content?.some(c=>c.type==='text'))return 'responding';
    }
    if(event.type==='user'&&event.message?.content?.some(c=>c.type==='tool_result'))return 'working';
    if(event.type==='stream_event'){
      const block=event.event?.content_block;
      if(block?.type==='tool_use')return tools[block.name]||'working';
      if(block?.type==='text'||event.event?.delta?.type==='text_delta')return 'responding';
    }
  }
}
export function createActivityReporter(provider,onActivity,{now=Date.now}={}){
  let buffer='',discard=false,last=0,lastKind;
  return chunk=>{
    if(!onActivity)return;
    buffer+=chunk;
    let index;
    while((index=buffer.indexOf('\n'))>=0){
      const line=buffer.slice(0,index);buffer=buffer.slice(index+1);
      if(discard){discard=false;continue;}
      let event;try{event=JSON.parse(line);}catch{continue;}
      const activity=activityFromEvent(provider,event),time=now();
      if(!activity||activity===lastKind&&time-last<2000)continue;
      last=time;lastKind=activity;
      onActivity({activity,at:new Date(time).toISOString()});
    }
    if(buffer.length>1_000_000){buffer='';discard=true;}
  };
}
