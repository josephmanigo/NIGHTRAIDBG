import { z } from 'zod'

export const allowedGames = [
  'Mobile Legends',
  'Bloodstrike',
] as const

const trimmed = (minimum: number, maximum: number) => z.string().trim().min(minimum).max(maximum)

const facebookUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  .refine((value) => {
    const url = new URL(value)
    return url.protocol === 'https:' && ['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(url.hostname.toLowerCase())
  }, 'A valid HTTPS Facebook profile URL is required.')

export const clanApplicationSchema = z
  .object({
    inGameName: trimmed(2, 50),
    ageGroup: z.enum(['UNDER_18', 'AGE_18_OR_ABOVE']),
    sex: z.enum(['Male', 'Female', 'Other']),
    device: z.enum(['PC', 'Mobile']),
    games: z.array(z.enum(allowedGames)).min(1).max(allowedGames.length),
    willingToUseClanTag: z.boolean(),
    playFrequency: z.enum(['Everyday', '3 times a week', 'Once a week']),
    previousClan: trimmed(1, 100),
    previousClanLeavingReason: trimmed(1, 2000),
    facebookProfileUrl: facebookUrl,
    discoverySource: z.enum(['Facebook', 'TikTok', 'Discord', 'Others']),
    discoverySourceOther: z.string().trim().max(100).optional(),
    alreadyJoinedDiscord: z.boolean(),
    reasonForJoining: trimmed(1, 2500),
    consents: z.object({
      accurate: z.literal(true),
      rules: z.literal(true),
      falseInfo: z.literal(true),
      processing: z.literal(true),
    }),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.discoverySource === 'Others' && !value.discoverySourceOther) {
      context.addIssue({
        code: 'custom',
        path: ['discoverySourceOther'],
        message: 'Please specify where you found NightRaid.',
      })
    }
  })

export type ClanApplicationInput = z.infer<typeof clanApplicationSchema>
