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
