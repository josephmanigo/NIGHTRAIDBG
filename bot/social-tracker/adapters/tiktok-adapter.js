import { TikTokProvider } from '../providers/tiktok-provider.js'

export class TikTokAdapter {
  constructor(config = {}) {
    this.provider = new TikTokProvider(config)
  }

  async getProfile(profileUrl, fetchImpl) {
    const username = profileUrl.split('@')[1]?.split('/')[0] || profileUrl.split('/').filter(Boolean).pop()
    return this.provider.getProfileData(username, fetchImpl)
  }

  async getLiveStatus(profileData, fetchImpl) {
    if (profileData && profileData.live) return profileData.live
    const fresh = await this.getProfile(profileData.profileUrl, fetchImpl)
    return fresh.live
  }

  async getLatestContent(profileData, fetchImpl) {
    if (profileData && profileData.latestContent) return profileData.latestContent
    const fresh = await this.getProfile(profileData.profileUrl, fetchImpl)
    return fresh.latestContent
  }
}
