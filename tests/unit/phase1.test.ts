import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { buildPlannerInput, runPlanner, templateProposal } from "../../src/server/ai/planner";
import { config } from "../../src/server/config";
import { compareOffers, rewardPromise, validateProposal } from "../../src/server/domain/rules";
import { RETENTION_POLICY, type SignalSummary } from "../../src/server/domain/signal";
import { isValidDateString } from "../../src/server/domain/time";
import { handle, readJson } from "../../src/server/http";

const signal = { eligibleCount: 20, eligible: [], policy: RETENTION_POLICY, excluded: { consent_false: 2, consent_unknown: 2, no_contact_ref: 0, over_cohort_cap: 0 } } as unknown as SignalSummary;
const input = buildPlannerInput({ intent: "Welcome back our regulars", signal, budgetCapMinor: 30000, timezone: "Asia/Kolkata" });

test("comparison uses bounded whole paise, distinct options and campaign-only exposure", () => {
  assert.deepEqual(compareOffers(20, 30000).map(o => [o.reward_minor, o.conservative_exposure_minor, o.campaign_exposure_minor]), [[750,15000,7500],[1125,22500,11250],[1500,30000,15000]]);
  assert.deepEqual(compareOffers(20, 2000).map(o=>o.reward_minor), [100]);
  for (const cap of [0, -1, 1999, NaN, Infinity, 1.5]) assert.deepEqual(compareOffers(20, cap), []);
  for (const size of [0, 1, -1, 1.5]) assert.deepEqual(compareOffers(size, 30000), []);
  assert.equal(compareOffers(3, 1001).at(-1)?.reward_minor, 333);
  assert.equal(compareOffers(20, 1_000_000).at(-1)?.reward_minor, 10000);
  for (const option of compareOffers(20, 30000)) {
    const proposal=templateProposal(input); proposal.offer.amount_minor=option.reward_minor;
    assert.equal(validateProposal({proposal,signal,budgetCapMinor:30000}).eligible,true);
    assert.match(rewardPromise(proposal.offer), new RegExp((option.reward_minor/100).toFixed(2).replace('.', '\\.')));
  }
});

test("separate offer terms reject amounts in introductory copy; legacy proposals still validate", () => {
  const proposal=templateProposal(input); proposal.offer.amount_minor=1500;
  proposal.copy.body="Get ₹25 off and ₹15 later";
  assert.ok(validateProposal({proposal,signal,budgetCapMinor:30000}).errors.some(e=>e.code==='COPY_OFFER_MISMATCH'));
  delete proposal.copy_format; proposal.copy.body="Get ₹15 off";
  assert.equal(validateProposal({proposal,signal,budgetCapMinor:30000}).eligible,true);
  assert.equal(isValidDateString('2026-02-30'),false);
});

test("Gemini structured output is validated; aggregate options stay authoritative", async t => {
  const old=config.geminiApiKey; config.geminiApiKey='test-key'; t.after(()=>{config.geminiApiKey=old;});
  const proposal=templateProposal(input);
  t.mock.method(globalThis,'fetch',async (url: unknown, init: RequestInit) => {
    assert.match(String(url), /^https:\/\/generativelanguage.googleapis.com\/v1beta\/openai\//);
    const body=JSON.parse(String(init.body));
    assert.equal(body.response_format.type,'json_schema');
    assert.ok(!String(init.body).includes('synthetic-sms'));
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...proposal,comparison_explanation:"Smaller rewards limit expenditure; larger rewards offer more generosity.",estimated_cost_minor:999,offer_options:[{reward_minor:1}]})}}]}),{headers:{'content-type':'application/json'}});
  });
  const result=await runPlanner(input);
  assert.equal(result.source,'model');
  assert.equal(result.proposal.copy_source,'model');
  assert.equal(result.proposal.comparison_source,'model');
  assert.equal('offer_options' in result.proposal,false);
  assert.deepEqual(input.offer_options,compareOffers(20,30000));
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...proposal,comparison_explanation:"A generous reward might attract more customers."})}}]}),{headers:{'content-type':'application/json'}}));
  assert.equal((await runPlanner(input)).proposal.comparison_source,'template_fallback');
});

test("missing key, invalid model output and network errors fall back without exposing errors", async t => {
  const old=config.geminiApiKey; t.after(()=>{config.geminiApiKey=old;});
  config.geminiApiKey=null;
  assert.equal((await runPlanner(input)).fallbackReason,'no_api_key');
  config.geminiApiKey='test-key';
  const logs: string[]=[]; t.mock.method(console,'log',(line:string)=>logs.push(line));
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({choices:[{message:{content:'{"broken":true}'}}]}),{headers:{'content-type':'application/json'}}));
  assert.equal((await runPlanner(input)).fallbackReason,'invalid_model_output');
  fetchMock.mock.mockImplementation(async()=>new Response(JSON.stringify({error:{message:'secret-credential-DO-NOT-LEAK'}}),{status:401,headers:{'content-type':'application/json'}}));
  assert.equal((await runPlanner(input)).fallbackReason,'authentication_failed');
  fetchMock.mock.mockImplementation(async()=>{throw new Error('secret-credential-DO-NOT-LEAK');});
  const fallback=await runPlanner(input);
  assert.equal(fallback.source,'template_fallback');
  assert.equal(fallback.fallbackReason,'planner_unavailable');
  assert.equal(JSON.stringify(logs).includes('secret-credential'),false);
});

test("JSON trust boundary rejects scalars, wrong types, malformed JSON and content types", async () => {
  const schema=z.object({name:z.string()}).strict();
  for(const body of ['null','[]','true','{"name":4}','{']) {
    await assert.rejects(readJson(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body}),schema));
  }
  await assert.rejects(readJson(new Request('http://localhost/api',{method:'POST',body:'{"name":"ok"}'}),schema));
  assert.deepEqual(await readJson(new Request('http://localhost/api',{method:'POST',headers:{'content-type':'application/json'},body:'{"name":"ok"}'}),schema),{name:'ok'});
  const response=await handle(new Request('http://localhost/api'),()=>{throw new Error('postgres://secret-password');});
  assert.equal(response.status,503);
  assert.equal((await response.text()).includes('secret-password'),false);
});
