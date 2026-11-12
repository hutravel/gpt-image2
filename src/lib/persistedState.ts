import { GIF_FRAME_COUNT_RANGE, GIF_FRAME_DURATION_RANGE, IMAGE_COMPLEXITIES, OUTPUT_FORMATS, type AppMode, type InputDraft, type AppSettings, type FavoriteCollection, type InputImage, type MaskDraft, type PresetConfig, type TaskParams } from '../types'
import { normalizeSettings } from './apiProfiles'
import { ensureDefaultFavoriteCollection, normalizeFavoriteCollections, resolveDefaultFavoriteCollectionId } from './favoriteState'
import { isEmptyInputDraft, normalizeInputDraft, saveGalleryInputDraft } from './inputDraftState'
import { isHttpUrl } from './imageApiShared'


export interface PersistedAppState {
  settings: AppSettings
  previousPresetConfig?: PresetConfig | null
  dismissedPresetProfileIds?: string[]
  dismissedPresetProviderIds?: string[]
  params: TaskParams
  prompt?: string
  inputImages?: InputImage[]
  dismissedCodexCliPrompts: string[]
  appMode: AppMode
  galleryInputDraft: InputDraft | null
  /** 仅保留旧数据供恢复，不再作为应用功能读取。 */
  legacyAgentData?: Record<string, unknown>
  favoriteCollections: FavoriteCollection[]
  defaultFavoriteCollectionId: string | null
  supportPromptDismissed: boolean
  supportPromptOpen: boolean
  supportPromptSkippedForImportedData: boolean
  imageSourceUrls: Record<string, string>
}

type PersistedStateSource = Omit<PersistedAppState, 'prompt' | 'inputImages'> & {
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
}

type PersistedStateFallback = Pick<
  PersistedAppState,
  'settings' | 'params' | 'dismissedPresetProfileIds' | 'dismissedPresetProviderIds' | 'dismissedCodexCliPrompts' | 'favoriteCollections' | 'defaultFavoriteCollectionId'
>

export type NormalizedPersistedAppState = PersistedAppState & {
  previousPresetConfig: PresetConfig | null
  dismissedPresetProfileIds: string[]
  dismissedPresetProviderIds: string[]
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
}

export interface PersistedStateMergePlan {
  state: NormalizedPersistedAppState
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function normalizeStringArray(value: unknown, fallback: string[]) {
  if (!Array.isArray(value)) return fallback
  return value.filter((item): item is string => typeof item === 'string')
}

function normalizeGifParam(value: unknown, range: { min: number; max: number }, fallback: number) {
  return typeof value === 'number' && Number.isInteger(value) && value >= range.min && value <= range.max ? value : fallback
}

function normalizeParams(value: unknown, fallback: TaskParams): TaskParams {
  if (!isRecord(value)) return fallback
  return {
    size: typeof value.size === 'string' ? value.size : fallback.size,
    aspect_ratio: typeof value.aspect_ratio === 'string' ? value.aspect_ratio : fallback.aspect_ratio,
    resolution: typeof value.resolution === 'string' ? value.resolution : fallback.resolution,
    google_search: typeof value.google_search === 'boolean' ? value.google_search : fallback.google_search,
    image_search: typeof value.image_search === 'boolean' ? value.image_search : fallback.image_search,
    thinking_level: value.thinking_level === 'auto' || value.thinking_level === 'minimal' || value.thinking_level === 'low' || value.thinking_level === 'medium' || value.thinking_level === 'high' ? value.thinking_level : fallback.thinking_level,
    quality: value.quality === 'auto' || value.quality === 'low' || value.quality === 'medium' || value.quality === 'high' || value.quality === 'xhigh' || value.quality === 'max'
      ? value.quality
      : fallback.quality,
    complexity: IMAGE_COMPLEXITIES.includes(value.complexity as TaskParams['complexity'])
      ? value.complexity as TaskParams['complexity']
      : fallback.complexity,
    output_format: OUTPUT_FORMATS.includes(value.output_format as TaskParams['output_format'])
      ? value.output_format as TaskParams['output_format']
      : fallback.output_format,
    output_compression: value.output_compression === null || (typeof value.output_compression === 'number' && Number.isFinite(value.output_compression))
      ? value.output_compression
      : fallback.output_compression,
    moderation: value.moderation === 'auto' || value.moderation === 'low' ? value.moderation : fallback.moderation,
    n: typeof value.n === 'number' && Number.isFinite(value.n) ? value.n : fallback.n,
    transparent_output: typeof value.transparent_output === 'boolean' ? value.transparent_output : fallback.transparent_output,
    frame_count: normalizeGifParam(value.frame_count, GIF_FRAME_COUNT_RANGE, fallback.frame_count),
    frame_duration_ms: normalizeGifParam(value.frame_duration_ms, GIF_FRAME_DURATION_RANGE, fallback.frame_duration_ms),
  }
}

export function createPersistedState(state: PersistedStateSource): PersistedAppState {
  const settings = normalizeSettings(state.settings)
  const galleryInputDraft = saveGalleryInputDraft(state)
  return {
    settings,
    previousPresetConfig: state.previousPresetConfig ?? null,
    dismissedPresetProfileIds: state.dismissedPresetProfileIds ?? [],
    dismissedPresetProviderIds: state.dismissedPresetProviderIds ?? [],
    params: state.params,
    ...(settings.persistInputOnRestart && (state.appMode === 'gallery' || galleryInputDraft)
      ? {
          prompt: galleryInputDraft?.prompt ?? '',
          inputImages: galleryInputDraft?.inputImages.map((img) => ({ id: img.id, dataUrl: '', markupImageId: img.markupImageId })) ?? [],
        }
      : {}),
    dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
    appMode: state.appMode,
    galleryInputDraft: settings.persistInputOnRestart && galleryInputDraft
      ? { ...galleryInputDraft, inputImages: galleryInputDraft.inputImages.map((img) => ({ id: img.id, dataUrl: '', markupImageId: img.markupImageId })) }
      : null,
    ...(state.legacyAgentData ? { legacyAgentData: state.legacyAgentData } : {}),
    favoriteCollections: state.favoriteCollections,
    defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
    supportPromptDismissed: state.supportPromptDismissed,
    supportPromptOpen: state.supportPromptOpen,
    supportPromptSkippedForImportedData: state.supportPromptSkippedForImportedData,
    imageSourceUrls: state.imageSourceUrls,
  }
}

export function migratePersistedState(persistedState: unknown, _version?: number): unknown {
  // 合并时会隔离旧字段；迁移本身不裁剪用户历史数据。
  return persistedState
}

export function normalizePersistedState(
  persistedState: unknown,
  fallback: PersistedStateFallback,
  now = Date.now(),
): PersistedStateMergePlan | null {
  if (!isRecord(persistedState)) return null

  const settings = normalizeSettings(persistedState.settings ?? fallback.settings)
  const previousPresetConfig = isRecord(persistedState.previousPresetConfig) && Array.isArray(persistedState.previousPresetConfig.profiles)
    ? (() => {
        const normalized = normalizeSettings(persistedState.previousPresetConfig)
        return {
          customProviders: normalized.customProviders,
          profiles: persistedState.previousPresetConfig.profiles.length ? normalized.profiles : [],
        }
      })()
    : null
  const legacyAgentData: Record<string, unknown> = isRecord(persistedState.legacyAgentData) ? { ...persistedState.legacyAgentData } : {}
  for (const [key, value] of Object.entries(persistedState)) {
    if (/^(agent|activeAgent)/.test(key)) legacyAgentData[key] = value
  }
  if (isRecord(persistedState.settings)) {
    const legacySettings = Object.fromEntries(Object.entries(persistedState.settings).filter(([key]) => key.startsWith('agent')))
    if (Object.keys(legacySettings).length) legacyAgentData.settings = legacySettings
  }
  if (persistedState.appMode === 'agent') {
    legacyAgentData.appMode = persistedState.appMode
    legacyAgentData.prompt = persistedState.prompt
    legacyAgentData.inputImages = persistedState.inputImages
  }
  const appMode = persistedState.appMode === 'square' ? 'square' : 'gallery'
  const galleryInputDraft = settings.persistInputOnRestart
    ? normalizeInputDraft(persistedState.galleryInputDraft ?? {
        prompt: persistedState.appMode === 'agent' ? '' : persistedState.prompt,
        inputImages: persistedState.appMode === 'agent' ? [] : persistedState.inputImages,
        maskDraft: null,
        maskEditorImageId: null,
      }, now)
    : null
  const favoriteCollections = Array.isArray(persistedState.favoriteCollections)
    ? ensureDefaultFavoriteCollection(normalizeFavoriteCollections(persistedState.favoriteCollections, now), now)
    : fallback.favoriteCollections
  const preferredDefaultFavoriteCollectionId = persistedState.defaultFavoriteCollectionId === null || typeof persistedState.defaultFavoriteCollectionId === 'string'
    ? persistedState.defaultFavoriteCollectionId
    : fallback.defaultFavoriteCollectionId

  return {
    state: {
      settings,
      previousPresetConfig,
      dismissedPresetProfileIds: normalizeStringArray(persistedState.dismissedPresetProfileIds, fallback.dismissedPresetProfileIds ?? []),
      dismissedPresetProviderIds: normalizeStringArray(persistedState.dismissedPresetProviderIds, fallback.dismissedPresetProviderIds ?? []),
      params: normalizeParams(persistedState.params, fallback.params),
      dismissedCodexCliPrompts: normalizeStringArray(persistedState.dismissedCodexCliPrompts, fallback.dismissedCodexCliPrompts),
      appMode,
      galleryInputDraft: galleryInputDraft && !isEmptyInputDraft(galleryInputDraft) ? galleryInputDraft : null,
      ...(Object.keys(legacyAgentData).length ? { legacyAgentData } : {}),
      favoriteCollections,
      defaultFavoriteCollectionId: resolveDefaultFavoriteCollectionId(favoriteCollections, preferredDefaultFavoriteCollectionId),
      supportPromptDismissed: Boolean(persistedState.supportPromptDismissed),
      supportPromptOpen: Boolean(persistedState.supportPromptOpen),
      supportPromptSkippedForImportedData: Boolean(persistedState.supportPromptSkippedForImportedData),
      imageSourceUrls: isRecord(persistedState.imageSourceUrls)
        ? Object.fromEntries(Object.entries(persistedState.imageSourceUrls).filter((entry): entry is [string, string] => isHttpUrl(entry[1])))
        : {},
      prompt: galleryInputDraft?.prompt ?? '',
      inputImages: galleryInputDraft?.inputImages ?? [],
      maskDraft: galleryInputDraft?.maskDraft ?? null,
      maskEditorImageId: galleryInputDraft?.maskEditorImageId ?? null,
    },
  }
}
