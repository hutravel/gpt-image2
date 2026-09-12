import type { ApiProfile } from '../types'

export const DEFAULT_IMAGES_MODEL = 'gpt-image-2'

export function getImageGenerationModel(profile: ApiProfile) {
  return profile.model.trim()
}

export function isGptImage25Model(model: string) {
  return /(?:^|[/-])gpt-image-2\.5(?:$|[/-])/i.test(model.trim())
}
