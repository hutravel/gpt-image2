import { describe, expect, it } from 'vitest'
import type { AppSettings, FavoriteCollection } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { DEFAULT_IMAGES_MODEL, DEFAULT_SETTINGS, switchApiProfileProvider } from './apiProfiles'
import { DEFAULT_FAVORITE_COLLECTION_ID } from './favoriteState'
import { createPersistedState, migratePersistedState, normalizePersistedState } from './persistedState'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,image-a' }
const collectionA: FavoriteCollection = { id: 'collection-a', name: '收藏夹 A', createdAt: 1, updatedAt: 1 }

function source(settings: AppSettings = DEFAULT_SETTINGS) {
  return {
    settings,
    params: { ...DEFAULT_PARAMS },
    prompt: '画廊输入',
    inputImages: [imageA],
    maskDraft: null,
    maskEditorImageId: null,
    dismissedCodexCliPrompts: [],
    appMode: 'gallery' as const,
    galleryInputDraft: null,
    favoriteCollections: [collectionA],
    defaultFavoriteCollectionId: collectionA.id,
    supportPromptDismissed: false,
    supportPromptOpen: false,
    supportPromptSkippedForImportedData: false,
  }
}

function fallback() {
  return {
    settings: DEFAULT_SETTINGS,
    params: { ...DEFAULT_PARAMS },
    dismissedCodexCliPrompts: ['current'],
    favoriteCollections: [collectionA],
    defaultFavoriteCollectionId: collectionA.id,
  }
}

describe('persisted state codec', () => {
  it.each([undefined, 'custom-image-model', '', '   '])('restores profile and legacy top-level tool model %s without autofilling', (imageGenerationModel) => {
    const profile = { apiMode: 'responses', model: 'legacy-text-model', ...(imageGenerationModel === undefined ? {} : { imageGenerationModel }) }
    for (const settings of [profile, { profiles: [profile] }]) {
      const result = normalizePersistedState({ settings }, fallback(), 100)!
      expect(result.state.settings.profiles[0]).toMatchObject({
        model: 'legacy-text-model',
        imageGenerationModel: imageGenerationModel?.trim() ?? '',
      })
    }
  })

  it.each([undefined, 'draft-image-model', ''])('restores saved provider tool model %s instead of inheriting the active model', (imageGenerationModel) => {
    const result = normalizePersistedState({ settings: { profiles: [{
      provider: 'fal',
      imageGenerationModel: DEFAULT_IMAGES_MODEL,
      providerDrafts: { openai: { apiMode: 'responses', model: 'saved-text-model', ...(imageGenerationModel === undefined ? {} : { imageGenerationModel }) } },
    }] } }, fallback(), 100)!
    expect(switchApiProfileProvider(result.state.settings.profiles[0], 'openai')).toMatchObject({
      apiMode: 'responses',
      model: 'saved-text-model',
      imageGenerationModel: imageGenerationModel ?? '',
    })
  })

  it('retains new defaults when no settings were persisted', () => {
    expect(normalizePersistedState({}, fallback(), 100)!.state.settings.profiles[0].imageGenerationModel).toBe(DEFAULT_IMAGES_MODEL)
  })

  it.each(['xhigh', 'max'] as const)('restores the %s GPT Image 2.5 quality level', (quality) => {
    const result = normalizePersistedState({ params: { ...DEFAULT_PARAMS, quality } }, fallback(), 100)!

    expect(result.state.params.quality).toBe(quality)
  })

  it('rejects non-record unknown data and falls back field-by-field for an invalid record', () => {
    class ExternalState {}

    expect(normalizePersistedState(null, fallback(), 100)).toBeNull()
    expect(normalizePersistedState([], fallback(), 100)).toBeNull()
    expect(normalizePersistedState(new Date(), fallback(), 100)).toBeNull()
    expect(normalizePersistedState(new Map(), fallback(), 100)).toBeNull()
    expect(normalizePersistedState(new ExternalState(), fallback(), 100)).toBeNull()

    const result = normalizePersistedState({
      params: { quality: 'invalid', n: Number.NaN },
      dismissedCodexCliPrompts: 'invalid',
      favoriteCollections: 'invalid',
      appMode: 'invalid',
      setPrompt: 'external action must not escape the codec',
    }, fallback(), 100)!

    expect(result.state.params).toEqual(DEFAULT_PARAMS)
    expect(result.state.dismissedCodexCliPrompts).toEqual(['current'])
    expect(result.state.favoriteCollections).toEqual([collectionA])
    expect(result.state.appMode).toBe('gallery')
    expect(result.state).not.toHaveProperty('setPrompt')
  })




  it('preserves an empty deployed profile snapshot when restoring persisted state', () => {
    const result = normalizePersistedState({
      previousPresetConfig: {
        customProviders: [{ id: 'provider-a', name: 'Provider A', submit: { path: 'generate' } }],
        profiles: [],
      },
    }, fallback())!

    expect(result.state.previousPresetConfig?.profiles).toEqual([])
    expect(result.state.previousPresetConfig?.customProviders).toEqual([
      expect.objectContaining({ id: 'provider-a' }),
    ])
  })




  it('preserves old conversation payloads without activating or mixing their drafts into gallery', () => {
    const legacy = {
      settings: { ...DEFAULT_SETTINGS, agentMaxToolRounds: 8 },
      appMode: 'agent',
      prompt: '旧会话输入',
      inputImages: [imageA],
      agentConversations: [{ id: 'legacy', rounds: [{ responseOutput: [{ result: 'original-base64' }] }] }],
      agentInputDrafts: { legacy: { prompt: '旧草稿', inputImages: [imageA] } },
    }
    const migrated = migratePersistedState(legacy, 1)
    expect(migrated).toBe(legacy)
    const result = normalizePersistedState(migrated, fallback(), 100)!.state
    expect(result.appMode).toBe('gallery')
    expect(result.prompt).toBe('')
    expect(result.inputImages).toEqual([])
    expect(result).not.toHaveProperty('agentConversations')
    expect(result.legacyAgentData).toMatchObject({
      agentConversations: legacy.agentConversations,
      agentInputDrafts: legacy.agentInputDrafts,
      prompt: legacy.prompt,
      inputImages: legacy.inputImages,
      settings: { agentMaxToolRounds: 8 },
    })
    const saved = createPersistedState({ ...source(), ...result })
    expect(saved.legacyAgentData).toEqual(result.legacyAgentData)
    expect(normalizePersistedState(saved, fallback())!.state.legacyAgentData).toEqual(result.legacyAgentData)
  })

  it('restores an explicit gallery draft when upgrading from the removed mode', () => {
    const result = normalizePersistedState({
      appMode: 'agent',
      prompt: '旧会话输入',
      galleryInputDraft: { prompt: '画廊草稿', inputImages: [imageA] },
    }, fallback(), 100)!.state
    expect(result.prompt).toBe('画廊草稿')
    expect(result.inputImages).toEqual([imageA])
  })

  it('persists the gallery draft from square and strips image payloads', () => {
    const saved = createPersistedState({
      ...source(),
      appMode: 'square',
      prompt: '',
      inputImages: [],
      galleryInputDraft: { prompt: '画廊草稿', inputImages: [imageA], maskDraft: null, maskEditorImageId: null },
    })
    expect(saved.appMode).toBe('square')
    expect(saved.prompt).toBe('画廊草稿')
    expect(saved.galleryInputDraft?.inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
    expect(normalizePersistedState(saved, fallback())!.state.prompt).toBe('画廊草稿')
  })

  it('disables gallery draft persistence while retaining historical backup', () => {
    const saved = createPersistedState({
      ...source({ ...DEFAULT_SETTINGS, persistInputOnRestart: false }),
      legacyAgentData: { agentInputDrafts: { legacy: { prompt: '旧草稿' } } },
    })
    expect(saved).not.toHaveProperty('prompt')
    expect(saved).not.toHaveProperty('inputImages')
    expect(saved.galleryInputDraft).toBeNull()
    expect(saved.legacyAgentData).toBeDefined()
    const restored = normalizePersistedState({ ...saved, prompt: '不恢复', inputImages: [imageA] }, fallback())!.state
    expect(restored.prompt).toBe('')
    expect(restored.inputImages).toEqual([])
  })

  it('restores old gallery input and favorite collections without changing their identity', () => {
    const result = normalizePersistedState({
      prompt: '旧画廊草稿',
      inputImages: [{ id: imageA.id, dataUrl: 123 }],
      favoriteCollections: [{ id: 'collection-b', name: '  收藏夹 B  ', createdAt: 2, updatedAt: 3 }],
      defaultFavoriteCollectionId: 'missing',
    }, fallback(), 100)!.state
    expect(result.galleryInputDraft).toMatchObject({ prompt: '旧画廊草稿', inputImages: [{ id: imageA.id, dataUrl: '' }] })
    expect(result.favoriteCollections).toEqual([{ id: 'collection-b', name: '收藏夹 B', createdAt: 2, updatedAt: 3 }])
    expect(result.defaultFavoriteCollectionId).toBe('collection-b')
    expect(normalizePersistedState({ favoriteCollections: [] }, fallback(), 100)!.state.defaultFavoriteCollectionId).toBe(DEFAULT_FAVORITE_COLLECTION_ID)
  })
})
