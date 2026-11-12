import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { createPrivacyModeState, getPrivacySnapshotImageIds, isPrivacyHiddenTask, restorePrivacyInputState } from './privacyMode'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    ...overrides,
  }
}

function sourceState() {
  return {
    appMode: 'gallery' as const,
    prompt: 'secret',
    inputImages: [imageA],
    maskDraft: null,
    maskEditorImageId: 'image-a',
    galleryInputDraft: null,
    reusedTaskApiProfileId: 'profile',
    reusedTaskApiProfileName: '配置',
    reusedTaskApiProfileMissing: false,
    reusedTaskApiModel: null,
    tasks: [task({ id: 'old', createdAt: 100 })],
    batchProgress: { total: 5, started: 2, finished: 1 },
  }
}

describe('privacy mode visibility', () => {
  const privacy = createPrivacyModeState(sourceState(), 100)

  it('hides nothing when privacy mode is off', () => {
    expect(isPrivacyHiddenTask(null, task())).toBe(false)
  })

  it('hides tasks created before entry', () => {
    const visible = [
      task({ id: 'old', createdAt: 100 }),
      task({ id: 'imported', createdAt: 10 }),
      task({ id: 'new', createdAt: 200 }),
    ].filter((item) => !isPrivacyHiddenTask(privacy, item))
    expect(visible.map((item) => item.id)).toEqual(['new'])
  })

  it('records the batch prompts that were not submitted', () => {
    expect(privacy.stoppedBatchPrompts).toBe(3)
  })

  it('keeps snapshot images referenced', () => {
    expect(getPrivacySnapshotImageIds(privacy)).toEqual(['image-a'])
    expect(getPrivacySnapshotImageIds(null)).toEqual([])
  })
})

describe('restorePrivacyInputState', () => {
  const privacy = createPrivacyModeState(sourceState(), 100)

  it('restores the gallery input without reopening the mask editor', () => {
    const restored = restorePrivacyInputState(privacy.inputSnapshot)
    expect(restored).toMatchObject({
      prompt: 'secret',
      inputImages: [imageA],
      maskEditorImageId: null,
      reusedTaskApiProfileId: 'profile',
    })
    expect(restored.galleryInputDraft?.prompt).toBe('secret')
  })
})
