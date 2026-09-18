import { z } from "zod";
import { OFFER_POLICY } from "../domain/rules";

/**
 * Second validation boundary. Structured output from the provider is still
 * treated as untrusted text until it parses here.
 */
export const plannerOutputSchema = z.object({
  comparison_explanation: z.string().min(10).max(300),
  audience_label: z.string().min(3).max(120),
  offer: z.object({
    kind: z.enum(OFFER_POLICY.allowedKinds),
    amount_minor: z.number().int().nonnegative().max(1_000_000),
    valid_days: z.number().int().positive().max(60),
    weekday_only: z.boolean(),
  }),
  timing: z.object({
    local_start: z.string().regex(/^\d{2}:\d{2}$/),
    local_end: z.string().regex(/^\d{2}:\d{2}$/),
  }),
  rationale: z.array(z.string().min(3).max(200)).min(1).max(5),
  copy: z.object({
    headline: z.string().min(3).max(200),
    body: z.string().min(3).max(500),
    cta: z.string().min(2).max(80),
  }),
  estimated_cost_minor: z.number().int().nonnegative().max(100_000_000),
  exclusions: z.array(z.string().min(3).max(200)).max(6),
});

export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

/** JSON Schema mirror for the provider's structured-output mode. */
export const plannerJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "comparison_explanation",
    "audience_label",
    "offer",
    "timing",
    "rationale",
    "copy",
    "estimated_cost_minor",
    "exclusions",
  ],
  properties: {
    comparison_explanation: { type: "string", maxLength: 300 },
    audience_label: { type: "string" },
    offer: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "amount_minor", "valid_days", "weekday_only"],
      properties: {
        kind: { type: "string", enum: ["fixed_reward"] },
        amount_minor: { type: "integer" },
        valid_days: { type: "integer" },
        weekday_only: { type: "boolean" },
      },
    },
    timing: {
      type: "object",
      additionalProperties: false,
      required: ["local_start", "local_end"],
      properties: {
        local_start: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
        local_end: { type: "string", pattern: "^\\d{2}:\\d{2}$" },
      },
    },
    rationale: { type: "array", items: { type: "string" } },
    copy: {
      type: "object",
      additionalProperties: false,
      required: ["headline", "body", "cta"],
      properties: {
        headline: { type: "string" },
        body: { type: "string" },
        cta: { type: "string" },
      },
    },
    estimated_cost_minor: { type: "integer" },
    exclusions: { type: "array", items: { type: "string" } },
  },
} as const;
