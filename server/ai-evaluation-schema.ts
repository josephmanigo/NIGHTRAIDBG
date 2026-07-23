import { z } from 'zod'

export const aiTextEvaluationSchema = z
  .object({
    motivationScore: z.number().int().min(0).max(25),
    teamworkScore: z.number().int().min(0).max(20),
    consistencyScore: z.number().int().min(0).max(10),
    communicationScore: z.number().int().min(0).max(10),
    confidence: z.number().min(0).max(1),
    strengths: z.array(z.string().min(1).max(160)).max(5),
    concerns: z.array(z.string().min(1).max(160)).max(5),
    summary: z.string().min(1).max(700),
  })
  .strict()

export type AiTextEvaluation = z.infer<typeof aiTextEvaluationSchema>

export const aiTextEvaluationJsonSchema = {
  type: 'object',
  properties: {
    motivationScore: { type: 'integer', minimum: 0, maximum: 25 },
    teamworkScore: { type: 'integer', minimum: 0, maximum: 20 },
    consistencyScore: { type: 'integer', minimum: 0, maximum: 10 },
    communicationScore: { type: 'integer', minimum: 0, maximum: 10 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    strengths: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 5,
    },
    concerns: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 5,
    },
    summary: { type: 'string' },
  },
  required: [
    'motivationScore',
    'teamworkScore',
    'consistencyScore',
    'communicationScore',
    'confidence',
    'strengths',
    'concerns',
    'summary',
  ],
  additionalProperties: false,
} as const
