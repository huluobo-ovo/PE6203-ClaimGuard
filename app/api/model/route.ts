import extractionSchema from '@/lib/data/extraction.schema.json';
import assessmentSchema from '@/lib/data/assessment.schema.json';
import contextSchema from '@/lib/data/employee_context.schema.json';
import cards from '@/lib/data/policy_cards.json';
import { PROMPT_A,PROMPT_B,PROMPT_C } from '@/lib/prompts';
import { detectMime,schemaErrors,retrieve,validation,human,validateCitations,guidanceFallback } from '@/lib/engine';
const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
export async function POST(req:Request){
 try{
  const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)return json({error:'不允许跨站调用。'},403);
  if(Number(req.headers.get('content-length')||0)>15_000_000)return json({error:'文件超过限制。'},413);
  const bodyText=await req.text();if(bodyText.length>15_000_000)return json({error:'请求超过限制。'},413);
  const b=JSON.parse(bodyText);const key=req.headers.get('x-session-gemini-key')||'';
  if(!key.trim())return json({error:'请先在模型设置中输入本次会话的 Gemini API key。'},401);
  if(!/^gemini-[a-zA-Z0-9.\-]+$/.test(b.model||''))return json({error:'模型ID格式无效。'},400);
  if(!['extract','assess','guidance','baselineA','baselineB'].includes(b.action))return json({error:'无效操作。'},400);
  const traces:any[]=[];let schema:any, instruction='',input:any={},file:any=null;
  const composite={type:'object',additionalProperties:false,required:['extraction','assessment','guidance'],properties:{extraction:extractionSchema,assessment:assessmentSchema,guidance:{type:'string'}}};
  if(['extract','baselineA','baselineB'].includes(b.action)){
   if(!b.file||typeof b.file.data!=='string'||b.file.data.length>14_000_000)return json({error:'请提供不超过10 MB的票据。'},400);
   let binary:string;try{binary=atob(b.file.data)}catch{return json({error:'文件编码无效。'},400)}
   if(binary.length>10*1024*1024||binary.length<12)return json({error:'票据为空或超过10 MB。'},400);
   const bytes=Uint8Array.from(binary.slice(0,16),c=>c.charCodeAt(0));const mime=detectMime(bytes);if(!mime||mime!==b.file.mime)return json({error:'文件内容与类型不符。'},400);
   file={inlineData:{mimeType:mime,data:b.file.data}};
   if(b.action==='extract'){schema=extractionSchema;instruction=PROMPT_A;input={task:'Extract the attached receipt. Do not infer facts from employee context.'}}
   else{const err=schemaErrors(b.context,contextSchema);if(err.length)return json({error:err.join('; ')},400);schema=composite;input={EMPLOYEE_CONTEXT:b.context};instruction='Read the receipt and pre-screen this expense claim. Return extraction, assessment and English guidance in the supplied JSON format. This is not final approval.';if(b.action==='baselineB'){instruction+=' Use the supplied teaching policies as evidence. Do not invent facts or policies; uncertain cases require human review.';input.POLICIES=cards}}
  }else if(b.action==='assess'){
   const errs=[...schemaErrors(b.claim,extractionSchema),...schemaErrors(b.original,extractionSchema),...schemaErrors(b.context,contextSchema)];if(errs.length)return json({error:errs.join('; ')},400);
   const issues=validation(b.claim,b.context,b.original);if(issues.length)return json({output:human(issues),traces:[],model_used:false});
   const retrieval=retrieve(b.claim,b.context,cards);if(retrieval.flags.length)return json({output:human(retrieval.flags),traces:[],retrieval,model_used:false});
   schema=assessmentSchema;instruction=PROMPT_B;input={CLAIM_JSON:b.claim,EMPLOYEE_CONTEXT:b.context,VALIDATION_RESULT:{blocked:false},RETRIEVAL_RESULT:retrieval};
  }else{
   if(schemaErrors(b.assessment,assessmentSchema).length)return json({error:'预审结果格式无效。'},400);
   schema={type:'object',additionalProperties:false,required:['guidance'],properties:{guidance:{type:'string'}}};instruction=PROMPT_C;input={ASSESSMENT_JSON:b.assessment,policy_cards:cards.filter(p=>b.assessment.policy_ids.includes(p.policy_id))};
  }
  for(let attempt=0;attempt<2;attempt++){
   const started=Date.now();const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),60000);
   let response:Response;try{response=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${b.model}:generateContent`,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','x-goog-api-key':key},body:JSON.stringify({systemInstruction:{parts:[{text:instruction+'\nExact output JSON contract:\n'+JSON.stringify(schema)+(attempt?'\nPrevious output did not meet the contract. Return valid complete JSON only.':'')}]},contents:[{role:'user',parts:[{text:JSON.stringify(input)},...(file?[file]:[])]}],generationConfig:{temperature:0,responseMimeType:'application/json',maxOutputTokens:8192}})})}finally{clearTimeout(timer)}
   if(!response.ok)return json({error:`模型服务返回 ${response.status}。请检查密钥权限、模型名称或额度。`,provider_status:response.status,traces},502);
   const payload:any=await response.json();const raw=(payload.candidates?.[0]?.content?.parts||[]).filter((p:any)=>p.text&&!p.thought).map((p:any)=>p.text).join('');
   const trace={module:b.action,attempt:attempt+1,model_id:b.model,model_version:payload.modelVersion||b.model,parameters:{temperature:0,maxOutputTokens:8192},timestamp:new Date().toISOString(),latency_ms:Date.now()-started,usage:payload.usageMetadata||null,raw_output:raw,prompt_version:'1.0',policy_version:'1.0'};traces.push(trace);
   try{const output=JSON.parse(raw);if(schemaErrors(output,schema).length)continue;
    if(b.action==='assess'&&!validateCitations(output,input.RETRIEVAL_RESULT.policy_ids))continue;
    if(b.action==='guidance'&&(output.guidance.trim().split(/\s+/).length>100||!/Pre-screening result:/i.test(output.guidance)||/payment approved|officially approved/i.test(output.guidance)||!output.guidance.includes(b.assessment.status)))continue;
    return json({output,traces,model_used:true});
   }catch{/* bounded format retry */}
  }
  if(b.action==='guidance')return json({output:{guidance:guidanceFallback(b.assessment)},traces,fallback:true,model_used:true});
  return json({error:'模型两次输出未通过格式或引用校验，需人工复核。',traces,output:human(['模型输出未通过校验'])},422);
 }catch(e){return json({error:e instanceof Error&&e.name==='AbortError'?'模型请求超时，请重试或转人工审核。':'请求无法处理，请检查输入后重试。'},400)}
}
