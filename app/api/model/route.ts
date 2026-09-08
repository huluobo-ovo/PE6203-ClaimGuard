import extractionSchema from '@/lib/data/extraction.schema.json';
import assessmentSchema from '@/lib/data/assessment.schema.json';
import contextSchema from '@/lib/data/employee_context.schema.json';
import cards from '@/lib/data/policy_cards.json';
import { PROMPT_A,PROMPT_B,PROMPT_C } from '@/lib/prompts';
import { detectMime,schemaErrors,retrieve,validation,human,validateCitations,guidanceFallback } from '@/lib/engine';

const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});

export async function POST(req:Request){
 try{
  const origin=req.headers.get('origin');
  if(origin&&origin!==new URL(req.url).origin)return json({error:'Cross-site requests are not allowed.'},403);
  if(Number(req.headers.get('content-length')||0)>15_000_000)return json({error:'The request is too large.'},413);
  const bodyText=await req.text();
  if(bodyText.length>15_000_000)return json({error:'The request is too large.'},413);
  const b=JSON.parse(bodyText);
  const key=req.headers.get('x-session-openai-key')||'';
  if(!key.trim())return json({error:'Enter your OpenAI API key in Model settings before using Live mode.'},401);
  if(b.model!=='gpt-4o-mini')return json({error:'This site is configured for gpt-4o-mini.'},400);
  if(!['extract','assess','guidance','baselineA','baselineB'].includes(b.action))return json({error:'Invalid action.'},400);

  const traces:any[]=[];let schema:any,instruction='',input:any={},file:any=null;
  const composite={type:'object',additionalProperties:false,required:['extraction','assessment','guidance'],properties:{extraction:extractionSchema,assessment:assessmentSchema,guidance:{type:'string'}}};
  if(['extract','baselineA','baselineB'].includes(b.action)){
   if(!b.file||typeof b.file.data!=='string'||b.file.data.length>14_000_000)return json({error:'Provide a receipt no larger than 10 MB.'},400);
   let binary:string;try{binary=atob(b.file.data)}catch{return json({error:'The receipt encoding is invalid.'},400)}
   if(binary.length>10*1024*1024||binary.length<12)return json({error:'The receipt is empty or exceeds 10 MB.'},400);
   const bytes=Uint8Array.from(binary.slice(0,16),c=>c.charCodeAt(0));const mime=detectMime(bytes);
   if(!mime||mime!==b.file.mime)return json({error:'The receipt content does not match its file type.'},400);
   if(mime==='application/pdf')return json({error:'Live OpenAI mode currently accepts PNG or JPG receipts. Please upload an image instead of a PDF.'},400);
   file={type:'image_url',image_url:{url:`data:${mime};base64,${b.file.data}`,detail:'high'}};
   if(b.action==='extract'){schema=extractionSchema;instruction=PROMPT_A;input={task:'Extract the attached receipt. Do not infer facts from employee context.'}}
   else{const err=schemaErrors(b.context,contextSchema);if(err.length)return json({error:err.join('; ')},400);schema=composite;input={EMPLOYEE_CONTEXT:b.context};instruction='Read the receipt and pre-screen this expense claim. Return extraction, assessment and English guidance in the supplied JSON format.';if(b.action==='baselineB'){instruction+=' Use the supplied teaching policies as evidence. Do not invent facts or policies; uncertain cases require human review.';input.POLICIES=cards}}
  }else if(b.action==='assess'){
   const errs=[...schemaErrors(b.claim,extractionSchema),...schemaErrors(b.original,extractionSchema),...schemaErrors(b.context,contextSchema)];if(errs.length)return json({error:errs.join('; ')},400);
   const issues=validation(b.claim,b.context,b.original);if(issues.length)return json({output:human(issues),traces:[],model_used:false});
   const retrieval=retrieve(b.claim,b.context,cards);if(retrieval.flags.length)return json({output:human(retrieval.flags),traces:[],retrieval,model_used:false});
   schema=assessmentSchema;instruction=PROMPT_B;input={CLAIM_JSON:b.claim,EMPLOYEE_CONTEXT:b.context,VALIDATION_RESULT:{blocked:false},RETRIEVAL_RESULT:retrieval};
  }else{
   if(schemaErrors(b.assessment,assessmentSchema).length)return json({error:'The pre-screen result is invalid.'},400);
   schema={type:'object',additionalProperties:false,required:['guidance'],properties:{guidance:{type:'string'}}};instruction=PROMPT_C;input={ASSESSMENT_JSON:b.assessment,policy_cards:cards.filter(p=>b.assessment.policy_ids.includes(p.policy_id))};
  }

  for(let attempt=0;attempt<2;attempt++){
   const started=Date.now();const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),60000);
   let response:Response;try{response=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify({model:'gpt-4o-mini',temperature:0,max_tokens:8192,response_format:{type:'json_schema',json_schema:{name:'claimguard_response',strict:true,schema}},messages:[{role:'system',content:instruction+'\nReturn only JSON that matches the supplied schema.'},{role:'user',content:[{type:'text',text:JSON.stringify(input)},...(file?[file]:[])]}]})})}finally{clearTimeout(timer)}
   if(!response.ok)return json({error:`OpenAI returned ${response.status}. Check your API key, billing, and project permissions.`,provider_status:response.status,traces},502);
   const payload:any=await response.json();const raw=payload.choices?.[0]?.message?.content||'';
   const trace={module:b.action,attempt:attempt+1,model_id:'gpt-4o-mini',model_version:payload.model||'gpt-4o-mini',parameters:{temperature:0,max_tokens:8192},timestamp:new Date().toISOString(),latency_ms:Date.now()-started,usage:payload.usage||null,raw_output:raw,prompt_version:'1.0',policy_version:'1.0'};traces.push(trace);
   try{const output=JSON.parse(raw);if(schemaErrors(output,schema).length)continue;if(b.action==='assess'&&!validateCitations(output,input.RETRIEVAL_RESULT.policy_ids))continue;if(b.action==='guidance'&&(output.guidance.trim().split(/\s+/).length>100||!/Pre-screening result:/i.test(output.guidance)||/payment approved|officially approved/i.test(output.guidance)||!output.guidance.includes(b.assessment.status)))continue;return json({output,traces,model_used:true});}catch{/* one bounded retry */}
  }
  if(b.action==='guidance')return json({output:{guidance:guidanceFallback(b.assessment)},traces,fallback:true,model_used:true});
  return json({error:'The response did not pass format or evidence checks. Send this case for human review.',traces,output:human(['Output did not pass validation'])},422);
 }catch(e){return json({error:e instanceof Error&&e.name==='AbortError'?'The request timed out. Try again or send it for human review.':'The request could not be processed. Check the input and try again.'},400)}
}
