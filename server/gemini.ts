import { aiTextEvaluationJsonSchema, aiTextEvaluationSchema, type AiTextEvaluation } from './ai-evaluation-schema.js'
import type { Json } from './database.types.js'
import { env } from './env.js'

interface GeminiSafetyRating {
  category?: string
  probability?: string
  blocked?: boolean
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> }
  finishReason?: string
  safetyRatings?: GeminiSafetyRating[]
}

interface GeminiResponse {
  candidates?: GeminiCandidate[]
  promptFeedback?: {
    blockReason?: string
    safetyRatings?: GeminiSafetyRating[]
  }
  error?: {
    message?: string
    status?: string
  }
}

export interface GeminiReviewResult {
  model: string
  review: AiTextEvaluation
  moderationFlagged: boolean
  moderationCategories: Json
}

function compactError(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 350)
}

function flaggedSafetyCategories(ratings: GeminiSafetyRating[]) {
  return Object.fromEntries(
    ratings
      .filter((rating) => rating.blocked || ['MEDIUM', 'HIGH'].includes(rating.probability ?? ''))
      .map((rating) => [
        (rating.category ?? 'UNSPECIFIED').replace(/^HARM_CATEGORY_/, ''),
        rating.probability ?? (rating.blocked ? 'BLOCKED' : 'UNSPECIFIED'),
      ]),
  ) as Json
}

export async function generateGeminiReview(
  instructions: string,
  application: Record<string, unknown>,
): Promise<GeminiReviewResult> {
  const model = env.geminiModel()
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.geminiApiKey(),
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: instructions }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: JSON.stringify(application) }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1_200,
          responseMimeType: 'application/json',
          responseJsonSchema: aiTextEvaluationJsonSchema,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    },
  )

  const payload = (await response.json().catch(() => ({}))) as GeminiResponse
  if (!response.ok) {
    const detail = payload.error?.message ? `: ${compactError(payload.error.message)}` : ''
    throw new Error(`Gemini API request failed with status ${response.status}${detail}`)
  }

  const candidate = payload.candidates?.[0]
  const ratings = [
    ...(payload.promptFeedback?.safetyRatings ?? []),
    ...(candidate?.safetyRatings ?? []),
  ]
  const moderationCategories = flaggedSafetyCategories(ratings)
  const promptBlock = payload.promptFeedback?.blockReason

  if (promptBlock) throw new Error(`Gemini safety screening blocked the application text: ${promptBlock}`)
  if (candidate?.finishReason === 'SAFETY') throw new Error('Gemini safety screening blocked the application text.')
  if (candidate?.finishReason === 'MAX_TOKENS') throw new Error('Gemini could not finish the structured evaluation within its output limit.')

  const text = candidate?.content?.parts
    ?.map((part) => part.text ?? '')
    .join('')
    .trim()
  if (!text) throw new Error('Gemini returned no structured evaluation.')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Gemini returned an invalid structured evaluation.')
  }

  return {
    model,
    review: aiTextEvaluationSchema.parse(parsed),
    moderationFlagged: Object.keys(moderationCategories as Record<string, unknown>).length > 0,
    moderationCategories,
  }
}
