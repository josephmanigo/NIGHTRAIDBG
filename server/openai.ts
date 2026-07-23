import OpenAI from 'openai'
import { env } from './env.js'

let openAiClient: OpenAI | undefined

export function getOpenAiClient() {
  if (!openAiClient) {
    openAiClient = new OpenAI({
      apiKey: env.openAiApiKey(),
      timeout: 20_000,
      maxRetries: 1,
    })
  }
  return openAiClient
}
