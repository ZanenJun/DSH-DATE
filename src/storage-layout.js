import fs from 'node:fs';
import path from 'node:path';
import {DateTime} from 'luxon';

const oldCollectionFiles=['daily-tasks.json','habits.json'];
const collectionFiles=[...oldCollectionFiles,'goals.json'];
const validName=name=>['calendar.json','state.json','history.json',...collectionFiles].includes(name)||/^calendar\/\d{4}-\d{2}\.json$/.test(name);
const dictionary=value=>value!==null && typeof value==='object' && !Array.isArray(value);
function validateLayout(index) {
  if(index.layoutVersion===undefined && index.collections===undefined)return [];
  const expected=index.layoutVersion===2?oldCollectionFiles:index.layoutVersion===3?collectionFiles:null;
  if(!expected || !Array.isArray(index.collections)
    || JSON.stringify(index.collections)!==JSON.stringify(expected))throw Error('Unsupported calendar collection layout');
  return expected;
}
export function partition(data,timeZone,knownMonths=[]) {
  const months=Object.fromEntries(knownMonths.map(month=>[month,{schemaVersion:1,month,items:{},occurrences:{}}]));
  const monthFor=iso=>{
    const month=DateTime.fromISO(iso).setZone(timeZone).toFormat('yyyy-MM');
    if(!/^\d{4}-\d{2}$/.test(month))throw Error('Invalid calendar month');
    return months[month]??={schemaVersion:1,month,items:{},occurrences:{}};
  };
  const habits={schemaVersion:1,items:{},occurrences:{}};
  for(const [id,item] of Object.entries(data.items)) {
    if(item.kind==='habit')habits.items[id]=item;
    else monthFor(item.dueAt).items[id]=item;
  }
  const occurrenceTexts={};
  for(const [key,occurrence] of Object.entries(data.occurrences)) {
    const {lastText,...state}=occurrence;
    if(data.items[occurrence.itemId]?.kind==='habit')habits.occurrences[key]=state;
    else monthFor(occurrence.dueAt).occurrences[key]=state;
    if(lastText!==undefined)occurrenceTexts[key]=lastText;
  }
  const {items,occurrences,dailyTasks={},goals={},memory=[],schemaVersion,...state}=data;
  const index={schemaVersion:2,layoutVersion:3,collections:collectionFiles,revision:data.revision,timeZone,months:Object.keys(months).sort()};
  return {'calendar.json':index,'state.json':{schemaVersion:1,...state},'history.json':{schemaVersion:1,memory,occurrenceTexts},
    'daily-tasks.json':{schemaVersion:1,items:dailyTasks},'habits.json':habits,'goals.json':{schemaVersion:1,items:goals},
    ...Object.fromEntries(Object.entries(months).map(([m,v])=>[`calendar/${m}.json`,v]))};
}
export function assemble(parts) {
  const index=parts['calendar.json'],state=parts['state.json'],history=parts['history.json'];
  if(index?.schemaVersion!==2 || !Array.isArray(index.months) || !Number.isInteger(index.revision)
    || state?.schemaVersion!==1 || state.revision!==index.revision || history?.schemaVersion!==1
    || !Array.isArray(history.memory) || !history.occurrenceTexts)throw Error('Invalid partitioned calendar state');
  const collections=validateLayout(index),separated=collections.length>0;
  const data={...state,schemaVersion:1,items:{},occurrences:{},dailyTasks:{},goals:{},memory:history.memory};
  const addPart=part=>{
    for(const [id,item] of Object.entries(part.items)) {
      if(Object.hasOwn(data.items,id))throw Error('Duplicate item across calendar collections');
      data.items[id]=item;
    }
    for(const [key,value] of Object.entries(part.occurrences)) {
      if(Object.hasOwn(data.occurrences,key))throw Error('Duplicate reminder across calendar collections');
      data.occurrences[key]={...value,...(Object.hasOwn(history.occurrenceTexts,key)?{lastText:history.occurrenceTexts[key]}:{})};
    }
  };
  for(const month of index.months) {
    if(!/^\d{4}-\d{2}$/.test(month))throw Error('Invalid calendar month index');
    const part=parts[`calendar/${month}.json`];
    if(part?.schemaVersion!==1 || part.month!==month || !part.items || !part.occurrences)throw Error('Missing or invalid monthly calendar');
    if(separated && Object.values(part.items).some(item=>item.kind==='habit'))throw Error('Habit stored outside habits.json');
    addPart(part);
  }
  if(separated) {
    const daily=parts['daily-tasks.json'],habits=parts['habits.json'];
    if(daily?.schemaVersion!==1 || !dictionary(daily.items) || habits?.schemaVersion!==1
      || !dictionary(habits.items) || !dictionary(habits.occurrences)
      || Object.values(habits.items).some(item=>item.kind!=='habit'))throw Error('Missing or invalid routine collection');
    addPart(habits);
    if(Object.keys(daily.items).some(id=>Object.hasOwn(data.items,id)))throw Error('Duplicate item across calendar and daily tasks');
    data.dailyTasks=daily.items;
  }
  if(collections.includes('goals.json')) {
    const goals=parts['goals.json'];
    if(goals?.schemaVersion!==1 || !dictionary(goals.items))throw Error('Missing or invalid goal collection');
    if(Object.keys(goals.items).some(id=>Object.hasOwn(data.items,id) || Object.hasOwn(data.dailyTasks,id)))throw Error('Duplicate item across goal collections');
    data.goals=goals.items;
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
      for(const file of validateLayout(index))parts[file]=read(file);
      for(const month of index.months) {
        if(!/^\d{4}-\d{2}$/.test(month))throw Error('Invalid month path');
        parts[`calendar/${month}.json`]=read(`calendar/${month}.json`);
      }
      try {const committed=validateJournal(read('.transaction.json'));return {data:assemble(committed),parts:committed};}
      catch(e){if(e.code!=='ENOENT')throw e;}
      if(JSON.stringify(read('calendar.json'))!==JSON.stringify(index))continue;
      return {data:assemble(parts),parts};
    }catch(e){if(attempt===4)throw e;}
  }
  throw Error('Calendar storage changed while reading');
}
