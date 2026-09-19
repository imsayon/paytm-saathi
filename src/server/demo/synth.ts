import { z } from "zod";
import { config } from "../config";
import type { MerchantContext } from "../auth/context";
import { newId, type Db } from "../db/client";
import { addDays, isWeekday, localDate } from "../domain/time";
import { RETENTION_POLICY } from "../domain/signal";
import { importCsv } from "../importer/import";
import { rememberFact } from "../memory/store";
import { log } from "../observability/log";
import { resetDemoData } from "./fixture";
import { DEMO_AS_OF } from "./fixture";

/**
 * Synthetic merchants that are different every time. The persona (shop name,
 * neighbourhood, category, customer names) may come from Gemini; every number
 * (visits, dates, amounts, consent mix, refunds) comes from a seeded generator
 * so the retention signal stays explainable and the model never touches data.
 */

export type Persona = {
  merchant_name: string;
  area: string;
  city: string;
  category: "chai_cafe" | "restaurant" | "salon" | "pharmacy" | "grocery" | "bakery";
  customer_names: string[];
};

const CATEGORY_AMOUNTS: Record<Persona["category"], [number, number]> = {
  chai_cafe: [8_000, 35_000],
  restaurant: [25_000, 120_000],
  salon: [30_000, 150_000],
  pharmacy: [12_000, 90_000],
  grocery: [15_000, 200_000],
  bakery: [10_000, 60_000],
};

const FIRST = ["Aarav", "Ananya", "Arjun", "Bhavana", "Chetan", "Deepa", "Farhan", "Gauri", "Harish", "Ishita", "Jyoti", "Karthik", "Lakshmi", "Manoj", "Nandini", "Omkar", "Pooja", "Rahul", "Sanjana", "Tarun", "Uma", "Vikram", "Yamini", "Zoya", "Meera", "Nikhil", "Priya", "Rohan", "Shreya", "Varun"];
const LAST = ["Rao", "Sharma", "Iyer", "Reddy", "Nair", "Gowda", "Khan", "Patel", "Menon", "Shetty", "Kulkarni", "Hegde", "Das", "Pillai", "Verma", "Bose", "Joshi", "Naik", "Mishra", "Singh"];
const AREAS = ["Koramangala", "Indiranagar", "Jayanagar", "HSR Layout", "Whitefield", "Malleshwaram", "BTM Layout", "Rajajinagar", "Yelahanka", "Basavanagudi"];
const SHOP = { chai_cafe: ["Chai Point", "Filter Kaapi Corner", "Cutting Chai Co."], restaurant: ["Annapoorna Mess", "Nandhini Deluxe", "Meghana Bites"], salon: ["Glow Studio", "Naturals Lite", "Mirror & Comb"], pharmacy: ["Apollo Lite Pharmacy", "MedPlus Corner", "Care Chemists"], grocery: ["Daily Needs Mart", "Fresh Basket", "Namma Kirana"], bakery: ["Iyengar Bakery", "Sweet Crumbs", "Bun & Butter"] } as const;

/** Deterministic LCG so a seed reproduces the exact dataset. */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

export function fallbackPersona(seed: number, wanted: number): Persona {
  const random = makeRandom(seed ^ 0x9e3779b9);
  const categories = Object.keys(CATEGORY_AMOUNTS) as Persona["category"][];
  const category = categories[Math.floor(random() * categories.length)]!;
  const names = new Set<string>();
  while (names.size < wanted) {
    names.add(`${FIRST[Math.floor(random() * FIRST.length)]} ${LAST[Math.floor(random() * LAST.length)]}`);
  }
  return {
    merchant_name: SHOP[category][Math.floor(random() * SHOP[category].length)]!,
    area: AREAS[Math.floor(random() * AREAS.length)]!,
    city: "Bengaluru",
    category,
    customer_names: [...names],
  };
}

const personaSchema = z.object({
  merchant_name: z.string().min(3).max(60),
  area: z.string().min(2).max(40),
  city: z.string().min(2).max(40),
  category: z.enum(["chai_cafe", "restaurant", "salon", "pharmacy", "grocery", "bakery"]),
  customer_names: z.array(z.string().min(2).max(40)).min(10).max(400),
});

/**
 * Asks Gemini for a plausible small-merchant persona and a list of Indian
 * customer names. Fiction only: the model receives no data. Falls back to
 * the built-in lists on any error so generation never blocks on the network.
 */
export async function generatePersona(seed: number, wanted: number): Promise<{ persona: Persona; source: "model" | "template_fallback" }> {
  const fallback = fallbackPersona(seed, wanted);
  if (!config.geminiApiKey) return { persona: fallback, source: "template_fallback" };
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: config.geminiApiKey, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", maxRetries: 0, timeout: 20_000 });
    const response = await client.chat.completions.create({
      model: config.geminiModel,
      messages: [
        {
          role: "system",
          content: "You invent a fictional small neighbourhood merchant in an Indian city for a software demo. Return only JSON. Names must be plausible, varied Indian names and must not be real public figures. No phone numbers, no addresses.",
        },
        {
          role: "user",
          content: JSON.stringify({ seed, wanted_customer_names: wanted, categories: Object.keys(CATEGORY_AMOUNTS), city_hint: "Bengaluru or another Indian city" }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "saathi_persona",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["merchant_name", "area", "city", "category", "customer_names"],
            properties: {
              merchant_name: { type: "string" },
              area: { type: "string" },
              city: { type: "string" },
              category: { type: "string", enum: Object.keys(CATEGORY_AMOUNTS) },
              customer_names: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    });
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("empty");
    const parsed = personaSchema.parse(JSON.parse(content));
    const names = [...new Set(parsed.customer_names)];
    while (names.length < wanted) names.push(fallback.customer_names[names.length % fallback.customer_names.length]!);
    return { persona: { ...parsed, customer_names: names.slice(0, wanted) }, source: "model" };
  } catch (error) {
    log("warn", "synth.persona_fallback", { reason: error instanceof Error ? error.name : "unknown" });
    return { persona: fallback, source: "template_fallback" };
  }
}

export type SynthOptions = {
  merchantId: string;
  asOf: string;
  seed: number;
  customers: number;
  /** Share of customers who were regulars and then went quiet (the audience). */
  absentShare: number;
  persona: Persona;
};

export type SynthResult = { csv: string; rows: number; customers: number; expected: { absent_regulars: number; consent_false: number; consent_unknown: number; no_contact_ref: number } };

function weekdaysBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    if (isWeekday(cursor)) dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Builds a CSV the importer accepts. Every choice is a function of the seed. */
export function generateSyntheticCsv(options: SynthOptions): SynthResult {
  const random = makeRandom(options.seed);
  const [minAmount, maxAmount] = CATEGORY_AMOUNTS[options.persona.category];
  const amount = () => minAmount + Math.floor(random() * (maxAmount - minAmount));
  const pick = <T,>(items: T[], count: number): T[] => {
    const pool = [...items];
    const chosen: T[] = [];
    for (let i = 0; i < count && pool.length > 0; i += 1) chosen.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
    return chosen.sort();
  };
  const { lookbackDays, inactivityDays } = RETENTION_POLICY;
  const absentWindow = weekdaysBetween(addDays(options.asOf, -lookbackDays + 2), addDays(options.asOf, -inactivityDays - 4));
  const recentWindow = weekdaysBetween(addDays(options.asOf, -inactivityDays + 2), options.asOf);
  const olderWindow = weekdaysBetween(addDays(options.asOf, -lookbackDays - 40), addDays(options.asOf, -lookbackDays - 5));

  const lines: string[] = ["merchant_id,customer_id,customer_name,contact_ref,consent,payment_id,paid_at,amount_minor,status"];
  let paymentSeq = 0;
  const expected = { absent_regulars: 0, consent_false: 0, consent_unknown: 0, no_contact_ref: 0 };
  const stamp = (date: string) => `${date}T${String(8 + Math.floor(random() * 12)).padStart(2, "0")}:${String(Math.floor(random() * 60)).padStart(2, "0")}:00+05:30`;
  const push = (customer: { id: string; name: string; contact: string; consent: string }, date: string, status = "settled") => {
    paymentSeq += 1;
    lines.push(
      [options.merchantId, customer.id, csvCell(customer.name), customer.contact, customer.consent, `PAY-${String(options.seed % 100000).padStart(5, "0")}-${String(paymentSeq).padStart(5, "0")}`, stamp(date), String(amount()), status].join(","),
    );
  };

  const absentCount = Math.max(2, Math.round(options.customers * options.absentShare));
  const activeCount = Math.round(options.customers * 0.45);
  const casualCount = Math.max(0, options.customers - absentCount - activeCount);
  let index = 0;
  const nextCustomer = (prefix: string, consent: string, contact: boolean) => {
    index += 1;
    const name = options.persona.customer_names[(index - 1) % options.persona.customer_names.length] ?? `Customer ${index}`;
    return {
      id: `${prefix}-${String(index).padStart(3, "0")}`,
      name,
      contact: contact ? `synthetic-sms:+91-${String(5550 + Math.floor(random() * 40))}-${String(1000 + index)}` : "",
      consent,
    };
  };

  for (let i = 0; i < absentCount; i += 1) {
    const roll = random();
    const consent = roll < 0.08 ? "false" : roll < 0.16 ? "unknown" : "true";
    const contact = random() > 0.03;
    const customer = nextCustomer("CUST-A", consent, contact);
    expected.absent_regulars += 1;
    if (consent === "false") expected.consent_false += 1;
    else if (consent === "unknown") expected.consent_unknown += 1;
    else if (!contact) expected.no_contact_ref += 1;
    for (const date of pick(absentWindow, 3 + Math.floor(random() * 3))) push(customer, date);
    if (random() < 0.15) push(customer, addDays(options.asOf, -Math.floor(random() * 10) - 2), random() < 0.5 ? "refunded" : "duplicate");
  }
  for (let i = 0; i < activeCount; i += 1) {
    const customer = nextCustomer("CUST-B", random() < 0.1 ? "unknown" : "true", true);
    for (const date of pick(absentWindow, 1 + Math.floor(random() * 3))) push(customer, date);
    for (const date of pick(recentWindow, 1 + Math.floor(random() * 3))) push(customer, date);
    if (random() < 0.08) push(customer, addDays(options.asOf, -Math.floor(random() * 14) - 1), "refunded");
  }
  for (let i = 0; i < casualCount; i += 1) {
    const customer = nextCustomer("CUST-C", random() < 0.2 ? "unknown" : "true", random() > 0.1);
    const visits = random() < 0.5 ? pick(olderWindow, 1 + Math.floor(random() * 3)) : pick([...absentWindow, ...recentWindow], 1);
    for (const date of visits) push(customer, date);
  }

  return { csv: lines.join("\n"), rows: lines.length - 1, customers: index, expected };
}

export function asOfFor(ctx: MerchantContext): string {
  return ctx.isDemoSession ? DEMO_AS_OF : localDate(new Date().toISOString(), ctx.timezone);
}

/**
 * Generates, optionally replaces the merchant's data, imports through the
 * same validated path as an upload, and records the dataset. The model's only
 * contribution is the persona.
 */
export async function generateAndImport(
  db: Db,
  ctx: MerchantContext,
  input: { seed?: number; customers?: number; absentShare?: number; replace?: boolean; requestId?: string },
) {
  const seed = input.seed ?? Math.floor(Math.random() * 2_147_483_647);
  const customers = Math.min(Math.max(input.customers ?? 60 + Math.floor(makeRandom(seed)() * 80), 20), 400);
  const absentShare = Math.min(Math.max(input.absentShare ?? 0.25 + makeRandom(seed + 1)() * 0.15, 0.1), 0.5);
  const { persona, source } = await generatePersona(seed, customers);
  const asOf = asOfFor(ctx);
  const generated = generateSyntheticCsv({ merchantId: ctx.merchantId, asOf, seed, customers, absentShare, persona });

  if (input.replace) await resetDemoData(db, ctx.merchantId);
  const result = await importCsv(db, ctx, { content: generated.csv, sourceName: `synthetic-${seed}.csv`, requestId: input.requestId });
  await db.run(
    `INSERT INTO synthetic_dataset (id, merchant_id, seed, persona, persona_source, row_count, customer_count, import_batch_id, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
    [newId("syn"), ctx.merchantId, seed, JSON.stringify({ ...persona, customer_names: undefined }), source, generated.rows, generated.customers, result.batchId, new Date().toISOString()],
  );
  if (!ctx.isDemoSession) {
    await db.run(`UPDATE merchant SET name = $1 WHERE id = $2 AND created_via = 'supabase'`, [`${persona.merchant_name}, ${persona.area}`, ctx.merchantId]);
  }
  await rememberFact(db, {
    merchantId: ctx.merchantId,
    kind: "dataset",
    fact: `Loaded a synthetic ${persona.category.replace("_", " ")} dataset for ${persona.merchant_name} (${persona.area}, ${persona.city}): ${generated.customers} customers, ${generated.rows} payments, seed ${seed}.`,
    details: { seed, category: persona.category, customers: generated.customers, rows: generated.rows, persona_source: source },
    source: source === "model" ? "model_persona" : "rules",
  });
  return { seed, persona: { ...persona, customer_names: undefined }, persona_source: source, as_of: asOf, expected: generated.expected, import: result };
}
