import {z} from 'zod';
import {HOUR_MS,ScheduleError,type ScheduleSpec} from './types.js';
const timestamp=z.number().int().min(0).max(8_640_000_000_000_000);
export const scheduleSpecSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('once'),at:timestamp}),
  z.strictObject({kind:z.literal('interval'),anchorAt:timestamp,intervalMs:z.number().int().min(HOUR_MS).max(366*24*HOUR_MS)}),
  z.strictObject({kind:z.literal('cron'),expression:z.string().trim().min(9).max(160)}),
]);
const formatters=new Map<string,Intl.DateTimeFormat>();
function formatter(zone:string){
  let f=formatters.get(zone);if(f)return f;
  try {f=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});f.format(0);}
  catch {throw new ScheduleError('INVALID_TIMEZONE','时区无效，请使用 IANA 时区名称。');}
  if(formatters.size>128)formatters.clear();formatters.set(zone,f);return f;
}
function parts(at:number,zone:string){const p=Object.fromEntries(formatter(zone).formatToParts(at).map(x=>[x.type,x.value]));return {year:+p.year,month:+p.month,day:+p.day,hour:+p.hour,minute:+p.minute};}
function stamp(at:number,zone:string){const p=parts(at,zone);return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;}
function field(raw:string,min:number,max:number):Set<number>{
  const result=new Set<number>();
  for(const section of raw.split(',')){
    const match=/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(section);if(!match)throw new ScheduleError('INVALID_CRON','cron 字段无效。');
    const step=match[2]?+match[2]:1;if(step<1||step>max-min+1)throw new ScheduleError('INVALID_CRON','cron 步长无效。');
    const range=match[1]==='*'?[min,max]:match[1].split('-').map(Number);const a=range[0],b=range[1]??(match[2]?max:a);
    if(a<min||b>max||a>b)throw new ScheduleError('INVALID_CRON','cron 数值超出范围。');
    for(let n=a;n<=b;n+=step)result.add(n);
  }
  return result;
}
function parseCron(expression:string){
  const f=expression.trim().split(/\s+/);if(f.length!==5)throw new ScheduleError('INVALID_CRON','使用五字段 cron：分 时 日 月 星期。');
  if(!/^\d+$/.test(f[0])||+f[0]>59)throw new ScheduleError('FREQUENCY_LIMIT','周期任务最多每小时执行一次；分钟字段必须为单个 0–59 数值。');
  if(f[2]!=='*'&&f[4]!=='*')throw new ScheduleError('INVALID_CRON','日期和星期不可同时指定。');
  const days=field(f[4],0,7);if(days.delete(7))days.add(0);
  return {minute:+f[0],hours:field(f[1],0,23),dates:field(f[2],1,31),months:field(f[3],1,12),days};
}
export function validateScheduleSpec(value:unknown,timezone='Asia/Shanghai',minIntervalMs=HOUR_MS):ScheduleSpec{
  formatter(timezone);let spec:ScheduleSpec;
  try{spec=scheduleSpecSchema.parse(value);}catch{throw new ScheduleError('INVALID_SCHEDULE','时间规则无效，周期任务至少间隔 60 分钟。');}
  if(spec.kind==='interval'&&spec.intervalMs<Math.max(HOUR_MS,minIntervalMs))throw new ScheduleError('FREQUENCY_LIMIT','周期任务间隔小于部署允许的最小周期。');
  if(spec.kind==='cron')parseCron(spec.expression);
  return spec;
}
/** Strictly after the supplied instant; UTC storage and local-calendar matching are separate. */
export function nextOccurrence(spec:ScheduleSpec,timezone:string,after:number):number|null{
  if(spec.kind==='once')return spec.at>after?spec.at:null;
  if(spec.kind==='interval'){const n=Math.max(0,Math.floor((after-spec.anchorAt)/spec.intervalMs)+1);return spec.anchorAt+n*spec.intervalMs;}
  const c=parseCron(spec.expression);formatter(timezone);
  const end=after+8*366*24*HOUR_MS;
  for(let hour=Math.floor(after/HOUR_MS)*HOUR_MS;hour<=end;hour+=HOUR_MS){
    // A zone offset can change inside a UTC hour (for example Lord Howe's
    // half-hour DST transition). Consider offsets on both sides before matching.
    const candidates=new Set<number>();
    for(const minute of [0,30,59]){const local=parts(hour+minute*60_000,timezone);candidates.add(hour+((c.minute-local.minute+minute+120)%60)*60_000);}
    for(const at of [...candidates].sort((a,b)=>a-b)){
      if(at<=after)continue;
      const p=parts(at,timezone);if(p.minute!==c.minute||!c.hours.has(p.hour)||!c.dates.has(p.day)||!c.months.has(p.month)||!c.days.has(new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay()))continue;
      // DST fold: only the earliest occurrence of a repeated local wall time.
      const current=stamp(at,timezone);let repeated=false;
      for(let back=30*60_000;back<=3*HOUR_MS;back+=30*60_000)if(stamp(at-back,timezone)===current){repeated=true;break;}
      if(!repeated)return at;
    }
  }
  throw new ScheduleError('NO_FUTURE_OCCURRENCE','此规则在未来八年内没有有效执行时间。');
}
export function previewSchedule(value:unknown,timezone='Asia/Shanghai',after=Date.now(),count=5,minIntervalMs=HOUR_MS):number[]{
  const spec=validateScheduleSpec(value,timezone,minIntervalMs);if(!Number.isInteger(count)||count<1||count>20)throw new ScheduleError('INVALID_PREVIEW','预览数量应在 1 到 20 之间。');
  const result:number[]=[];for(let n=0;n<count;n++){const at=nextOccurrence(spec,timezone,after);if(at===null)break;result.push(at);after=at;}return result;
}
/** Resolve a datetime-local value in the selected zone; gaps reject and folds use the first instant. */
export function resolveLocalTime(local:string,timezone:string):number{
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);if(!m)throw new ScheduleError('INVALID_LOCAL_TIME','日期格式无效。');
  const [year,month,day,hour,minute,second]=m.slice(1).map(x=>+(x??0));
  const wall=Date.UTC(year,month-1,day,hour,minute,second);formatter(timezone);const candidates=new Set<number>();
  for(let delta=-36;delta<=36;delta+=6){const sample=wall+delta*HOUR_MS,p=parts(sample,timezone);const offset=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)-Math.floor(sample/60_000)*60_000;candidates.add(wall-offset);}
  const match=[...candidates].filter(at=>{const p=parts(at,timezone);return p.year===year&&p.month===month&&p.day===day&&p.hour===hour&&p.minute===minute;}).sort((a,b)=>a-b);
  if(!match.length||second>59)throw new ScheduleError('INVALID_LOCAL_TIME','该日期时间在所选时区不存在。');return match[0];
}
