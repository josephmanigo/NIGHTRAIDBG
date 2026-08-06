import { TikTokProvider, SelfHostedTikTokProvider } from '../providers/tiktok-provider.js'

export class TikTokAdapter {
  constructor(config = {}) {
    this.provider = new TikTokProvider(config)
    this.selfHostedProvider = this.provider.selfHostedProvider || new SelfHostedTikTokProvider(config)
  }

  async getProfile(profileUrl, fetchImpl) {
    const username = profileUrl.includes('@')
      ? profileUrl.split('@')[1]?.split('/')[0]
      : profileUrl.split('/').filter(Boolean).pop()
    return this.provider.getProfileData(username, fetchImpl)
  }

  async getLiveStatus(profileData, fetchImpl) {
    if (profileData && profileData.live) return profileData.live
    const fresh = await this.getProfile(profileData.profileUrl || profileData.username, fetchImpl)
    return fresh.live || { isLive: false, liveId: null, viewers: 0 }
  }

  async getLatestContent(profileData, fetchImpl) {
    if (profileData && profileData.latestContent !== undefined) return profileData.latestContent
    const fresh = await this.getProfile(profileData.profileUrl || profileData.username, fetchImpl)
    return fresh.latestContent || null
  }
}
