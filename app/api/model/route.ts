import extractionSchema from '@/lib/data/extraction.schema.json';
import assessmentSchema from '@/lib/data/assessment.schema.json';
import contextSchema from '@/lib/data/employee_context.schema.json';
import cards from '@/lib/data/policy_cards.json';
import { PROMPT_A,PROMPT_C,CURRENCY_DECISION_GATE } from '@/lib/prompts';
import { PROMPT_B_V3 } from '@/lib/prompt_b_v3';
import { claimForPromptB,addDerived,CHECKS_SCHEMA,evidenceBlock,finalizeV3 } from '@/lib/member4_assess_v3';
import { detectMime,schemaErrors,retrieve,validation,human,validateCitations,guidanceFallback } from '@/lib/engine';
import { claimTextFromClaim,retrieveNaiveTop3 } from '@/lib/retrieve_naive';

const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
const validAssessmentRules=(output:any)=>output?.status==='passed'?Array.isArray(output.missing_evidence)&&output.missing_evidence.length===0:output?.status==='not_passed'?Array.isArray(output.policy_ids)&&output.policy_ids.length>0:false;
const PROMPT_B_BASELINE=`You are the policy checker of ClaimGuard, an expense pre-screening tool for Northstar Consulting.
You receive a CLAIM (fields read from the receipt and the submission) and EVIDENCE (policy cards).
Decide whether the claim complies with the EVIDENCE. Use only the EVIDENCE.
Return one JSON object: {"decision":"passed"|"not_passed","policy_ids":["policy IDs relied upon"],"reason":"1-3 short sentences","next_action":"what the employee should do next"}.`;

async function baselineB(body:any,key:string){
 const contextErrors=schemaErrors(body.context,contextSchema);if(contextErrors.length)return json({error:contextErrors.join('; ')},400);
 if(!body.file||typeof body.file.data!=='string'||body.file.data.length>14_000_000)return json({error:'Provide a receipt no larger than 10 MB.'},400);
 let binary:string;try{binary=atob(body.file.data)}catch{return json({error:'The receipt encoding is invalid.'},400)}
 if(binary.length>10*1024*1024||binary.length<12)return json({error:'The receipt is empty or exceeds 10 MB.'},400);
 const bytes=Uint8Array.from(binary.slice(0,16),c=>c.charCodeAt(0));const mime=detectMime(bytes);
 if(!mime||mime!==body.file.mime)return json({error:'The receipt content does not match its file type.'},400);
 if(mime==='application/pdf')return json({error:'Live OpenAI mode currently accepts PNG or JPG receipts. Please upload an image instead of a PDF.'},400);
 const image={type:'image_url',image_url:{url:`data:${mime};base64,${body.file.data}`,detail:'high'}};
 const traces:any[]=[];
 const ask=async(module:string,instruction:string,input:any,responseFormat:any,includeImage=false)=>{
  const started=Date.now();const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),60000);
  let response:Response;try{response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`,'HTTP-Referer':'https://pe6203-a-06.yangruijia216.chatgpt.site','X-OpenRouter-Title':'ClaimGuard'},body:JSON.stringify({model:'openai/gpt-4o-mini',temperature:0,max_tokens:8192,response_format:responseFormat,messages:[{role:'system',content:instruction},{role:'user',content:[{type:'text',text:JSON.stringify(input)},...(includeImage?[image]:[])]}]})})}finally{clearTimeout(timer)}
  if(!response.ok)throw Error(`OpenRouter returned ${response.status}: ${(await response.text()).slice(0,300)}`);
  const payload:any=await response.json();const raw=payload.choices?.[0]?.message?.content||'';
  traces.push({module,attempt:1,model_id:'openai/gpt-4o-mini',model_version:payload.model||'openai/gpt-4o-mini',parameters:{temperature:0,max_tokens:8192},timestamp:new Date().toISOString(),latency_ms:Date.now()-started,usage:payload.usage||null,raw_output:raw,prompt_version:'1.0',policy_version:'1.0'});
  return JSON.parse(raw);
 };
 try{
  const claim=await ask('baselineB_extract',PROMPT_A,{task:'Extract the attached receipt. Do not infer facts from employee context.'},{type:'json_schema',json_schema:{name:'claimguard_extraction',strict:true,schema:extractionSchema}},true);
  const extractionErrors=schemaErrors(claim,extractionSchema);if(extractionErrors.length)return json({error:extractionErrors.join('; '),traces},422);
  const retrieval=await retrieveNaiveTop3(claimTextFromClaim(claim),cards,key,3);
  const evidence=retrieval.policy_cards.map(card=>`[${card.policy_id}] (${card.status}) ${card.title}: ${card.rule}`).join('\n');
  const decision=await ask('baselineB_assess',PROMPT_B_BASELINE,{CLAIM:claim,EVIDENCE:evidence},{type:'json_object'});
  const assessment={status:decision.decision==='passed'?'passed':'not_passed',policy_ids:Array.isArray(decision.policy_ids)?decision.policy_ids.filter((id:string)=>retrieval.policy_ids.includes(id)):[],rationale:decision.reason||'',missing_evidence:[],uncertainty:[],next_action:decision.next_action||'Submit the claim and supporting evidence to Finance. Finance makes the final decision.'};
  if(!assessment.policy_ids.length)assessment.policy_ids=retrieval.policy_ids;
  const guidance=guidanceFallback(assessment);
  return json({output:{extraction:claim,assessment,guidance},retrieval,retriever:retrieval.retriever,traces,model_used:true});
 }catch(error:any){return json({error:error?.name==='AbortError'?'The request timed out. Try again or send it for human review.':error?.message||'The request could not be processed.',traces},502)}
}

export async function POST(req:Request){
 try{
  const origin=req.headers.get('origin');
  if(origin&&origin!==new URL(req.url).origin)return json({error:'Cross-site requests are not allowed.'},403);
  if(Number(req.headers.get('content-length')||0)>15_000_000)return json({error:'The request is too large.'},413);
  const bodyText=await req.text();
  if(bodyText.length>15_000_000)return json({error:'The request is too large.'},413);
  const b=JSON.parse(bodyText);
  const key=process.env.OPENROUTER_API_KEY||req.headers.get('x-session-openrouter-key')||'';
  if(!key.trim())return json({error:'The site administrator has not configured the OpenRouter API key yet.'},503);
  if(b.model!=='openai/gpt-4o-mini')return json({error:'This site is configured for openai/gpt-4o-mini.'},400);
  if(!['extract','assess','guidance','baselineA','baselineB'].includes(b.action))return json({error:'Invalid action.'},400);
  if(b.action==='baselineB')return baselineB(b,key);

  const traces:any[]=[];let schema:any,instruction='',input:any={},file:any=null,claimB:any=null,retrievalForAssess:any=null;
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
   else{const err=schemaErrors(b.context,contextSchema);if(err.length)return json({error:err.join('; ')},400);schema=composite;input={EMPLOYEE_CONTEXT:b.context};instruction=`Read the receipt and pre-screen this expense claim. Return one JSON object matching this schema: ${JSON.stringify(composite)}. Use English guidance. ${CURRENCY_DECISION_GATE}`;if(b.action==='baselineB'){instruction+=' Use the supplied teaching policies as evidence. Do not invent facts or policies; uncertain cases require human review.';input.POLICIES=cards}}
  }else if(b.action==='assess'){
   const errs=[...schemaErrors(b.claim,extractionSchema),...schemaErrors(b.original,extractionSchema),...schemaErrors(b.context,contextSchema)];if(errs.length)return json({error:errs.join('; ')},400);
   const issues=validation(b.claim,b.context,b.original);if(issues.length)return json({output:human(issues),traces:[],model_used:false});
   const retrieval=retrieve(b.claim,b.context,cards);if(retrieval.flags.length)return json({output:human(retrieval.flags),traces:[],retrieval,model_used:false});
   claimB=addDerived(claimForPromptB(b.claim,b.context));retrievalForAssess=retrieval;schema=CHECKS_SCHEMA;instruction=PROMPT_B_V3;input={CLAIM:claimB,EVIDENCE:evidenceBlock(retrieval.policy_cards)};
  }else{
   if(schemaErrors(b.assessment,assessmentSchema).length)return json({error:'The pre-screen result is invalid.'},400);
   schema={type:'object',additionalProperties:false,required:['guidance'],properties:{guidance:{type:'string'}}};instruction=PROMPT_C;input={ASSESSMENT_JSON:b.assessment,policy_cards:cards.filter(p=>b.assessment.policy_ids.includes(p.policy_id))};
  }

  for(let attempt=0;attempt<2;attempt++){
   const started=Date.now();const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),60000);
   const responseFormat=['baselineA','baselineB'].includes(b.action)?{type:'json_object'}:{type:'json_schema',json_schema:{name:'claimguard_response',strict:true,schema}};
   let response:Response;try{response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`,'HTTP-Referer':'https://pe6203-a-06.yangruijia216.chatgpt.site','X-OpenRouter-Title':'ClaimGuard'},body:JSON.stringify({model:'openai/gpt-4o-mini',temperature:0,max_tokens:8192,response_format:responseFormat,messages:[{role:'system',content:instruction+'\nReturn only JSON that matches the supplied schema.'},{role:'user',content:[{type:'text',text:JSON.stringify(input)},...(file?[file]:[])]}]})})}finally{clearTimeout(timer)}
   if(!response.ok){const providerError=await response.text();return json({error:`OpenRouter returned ${response.status}: ${providerError.slice(0,300)}`,provider_status:response.status,traces},502)}
   const payload:any=await response.json();const raw=payload.choices?.[0]?.message?.content||'';
   const trace={module:b.action,attempt:attempt+1,model_id:'openai/gpt-4o-mini',model_version:payload.model||'openai/gpt-4o-mini',parameters:{temperature:0,max_tokens:8192},timestamp:new Date().toISOString(),latency_ms:Date.now()-started,usage:payload.usage||null,raw_output:raw,prompt_version:'1.0',policy_version:'1.0'};traces.push(trace);
   try{const output=JSON.parse(raw);if(schemaErrors(output,schema).length)continue;if(b.action==='assess'){const {assessment,checks}=finalizeV3(output,claimB,retrievalForAssess.policy_cards);if(!validateCitations(assessment,retrievalForAssess.policy_ids))continue;return json({output:assessment,checks,retrieval:retrievalForAssess,traces,model_used:true})}if(b.action==='guidance'&&(output.guidance.trim().split(/\s+/).length>100||!/Pre-screening result:/i.test(output.guidance)||/payment approved|officially approved/i.test(output.guidance)||!output.guidance.includes(b.assessment.status)))continue;return json({output,traces,model_used:true});}catch{/* one bounded retry */}
  }
  if(b.action==='guidance')return json({output:{guidance:guidanceFallback(b.assessment)},traces,fallback:true,model_used:true});
  return json({error:'The response did not pass format or evidence checks. Send this case for human review.',traces,output:human(['Output did not pass validation'])},422);
 }catch(e){return json({error:e instanceof Error&&e.name==='AbortError'?'The request timed out. Try again or send it for human review.':'The request could not be processed. Check the input and try again.'},400)}
}
