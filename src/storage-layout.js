import fs from 'node:fs';
import path from 'node:path';
import {DateTime} from 'luxon';

const validName=name=>['calendar.json','state.json','history.json'].includes(name)||/^calendar\/\d{4}-\d{2}\.json$/.test(name);
export function partition(data,timeZone,knownMonths=[]) {
  const months=Object.fromEntries(knownMonths.map(month=>[month,{schemaVersion:1,month,items:{},occurrences:{}}]));
  const monthFor=iso=>{
    const month=DateTime.fromISO(iso).setZone(timeZone).toFormat('yyyy-MM');
    if(!/^\d{4}-\d{2}$/.test(month))throw Error('Invalid calendar month');
    return months[month]??={schemaVersion:1,month,items:{},occurrences:{}};
  };
  for(const [id,item] of Object.entries(data.items))monthFor(item.dueAt).items[id]=item;
  const occurrenceTexts={};
  for(const [key,occurrence] of Object.entries(data.occurrences)) {
    const {lastText,...state}=occurrence;
    monthFor(occurrence.dueAt).occurrences[key]=state;
    if(lastText!==undefined)occurrenceTexts[key]=lastText;
  }
  const {items,occurrences,memory=[],schemaVersion,...state}=data;
  const index={schemaVersion:2,revision:data.revision,timeZone,months:Object.keys(months).sort()};
  return {'calendar.json':index,'state.json':{schemaVersion:1,...state},'history.json':{schemaVersion:1,memory,occurrenceTexts},
    ...Object.fromEntries(Object.entries(months).map(([m,v])=>[`calendar/${m}.json`,v]))};
}
export function assemble(parts) {
  const index=parts['calendar.json'],state=parts['state.json'],history=parts['history.json'];
  if(index?.schemaVersion!==2 || !Array.isArray(index.months) || !Number.isInteger(index.revision)
    || state?.schemaVersion!==1 || state.revision!==index.revision || history?.schemaVersion!==1
    || !Array.isArray(history.memory) || !history.occurrenceTexts)throw Error('Invalid partitioned calendar state');
  const data={...state,schemaVersion:1,items:{},occurrences:{},memory:history.memory};
  for(const month of index.months) {
    if(!/^\d{4}-\d{2}$/.test(month))throw Error('Invalid calendar month index');
    const part=parts[`calendar/${month}.json`];
    if(part?.schemaVersion!==1 || part.month!==month || !part.items || !part.occurrences)throw Error('Missing or invalid monthly calendar');
    for(const [id,item] of Object.entries(part.items)) {
      if(Object.hasOwn(data.items,id))throw Error('Duplicate item across calendar months');
      data.items[id]=item;
    }
    for(const [key,value] of Object.entries(part.occurrences)) {
      if(Object.hasOwn(data.occurrences,key))throw Error('Duplicate reminder across calendar months');
      data.occurrences[key]={...value,...(Object.hasOwn(history.occurrenceTexts,key)?{lastText:history.occurrenceTexts[key]}:{})};
    }
  }
  return data;
}
export function validateJournal(journal) {
  if(journal?.schemaVersion!==1 || !journal.parts || Object.keys(journal.parts).some(name=>!validName(name)))throw Error('Invalid calendar transaction journal');
  assemble(journal.parts);
  return journal.parts;
}
// A durable redo journal is the publication point. Readers use its complete
// snapshot during a multi-file commit, or retry if the revision changed mid-read.
export function readStorageSync(directory) {
  const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
  for(let attempt=0;attempt<5;attempt++) {
    try {
      try {const parts=validateJournal(read('.transaction.json'));return {data:assemble(parts),parts};}
      catch(e){if(e.code!=='ENOENT')throw e;}
      const index=read('calendar.json');
      if(index.schemaVersion===1)return {data:index,parts:null};
      if(index.schemaVersion!==2 || !Array.isArray(index.months))throw Error('Unsupported calendar data schema');
      const parts={'calendar.json':index,'state.json':read('state.json'),'history.json':read('history.json')};
      for(const month of index.months) {
        if(!/^\d{4}-\d{2}$/.test(month))throw Error('Invalid month path');
        parts[`calendar/${month}.json`]=read(`calendar/${month}.json`);
      }
      try {const committed=validateJournal(read('.transaction.json'));return {data:assemble(committed),parts:committed};}
      catch(e){if(e.code!=='ENOENT')throw e;}
      if(read('calendar.json').revision!==index.revision)continue;
      return {data:assemble(parts),parts};
    }catch(e){if(attempt===4)throw e;}
  }
  throw Error('Calendar storage changed while reading');
}
