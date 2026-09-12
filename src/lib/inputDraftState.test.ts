import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InputDraft } from '../types'
import { getSelectedImageMentionLabel } from './promptImageMentions'
import {
  normalizeInputDraft,
  restoreGalleryInputDraftState,
  saveGalleryInputDraft,
  syncActiveInputDraft,
  updateInputDraftImages,
} from './inputDraftState'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('input draft normalization', () => {
  it('normalizes old external data and rejects invalid image and mask fields', () => {
    vi.spyOn(Date, 'now').mockReturnValue(90)

    expect(normalizeInputDraft({
      prompt: 123,
      inputImages: [
        imageA,
        { id: 'image-b', dataUrl: 123 },
        { id: 123, dataUrl: 'invalid' },
        null,
      ],
      maskDraft: { targetImageId: 'image-a', maskDataUrl: 123, updatedAt: 5 },
      maskEditorImageId: 123,
      updatedAt: Number.NaN,
    }, 50)).toEqual({
      prompt: '',
      inputImages: [imageA, { id: 'image-b', dataUrl: '' }],
      maskDraft: null,
      maskEditorImageId: null,
      updatedAt: 50,
    })

    expect(normalizeInputDraft({
      prompt: '旧草稿',
      maskDraft: { targetImageId: 'image-a', maskDataUrl: 'data:image/png;base64,mask' },
    }, 50)).toMatchObject({
      prompt: '旧草稿',
      maskDraft: {
        targetImageId: 'image-a',
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 90,
      },
      updatedAt: 50,
    })
  })


})


describe('input draft image and mention transforms', () => {
  it('renumbers retained image mentions and clears a mask whose target was removed', () => {
    const draft: InputDraft = {
      prompt: `保留 ${getSelectedImageMentionLabel(1)}，删除 ${getSelectedImageMentionLabel(0)}`,
      inputImages: [imageA, imageB],
      maskDraft: {
        targetImageId: imageA.id,
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
      maskEditorImageId: imageA.id,
      updatedAt: 2,
    }

    expect({ ...draft, ...updateInputDraftImages(draft, [imageB]) }).toEqual({
      prompt: `保留 ${getSelectedImageMentionLabel(0)}，删除 @已移除图片`,
      inputImages: [imageB],
      maskDraft: null,
      maskEditorImageId: null,
      updatedAt: 2,
    })
  })

  it('preserves mention position when an image id is replaced by an equivalent image', () => {
    const draft: InputDraft = {
      prompt: `修改 ${getSelectedImageMentionLabel(0)}`,
      inputImages: [imageA],
      maskDraft: null,
      maskEditorImageId: null,
    }

    expect(updateInputDraftImages(draft, [imageB], { equivalentImageIds: { [imageA.id]: imageB.id } })).toMatchObject({
      prompt: `修改 ${getSelectedImageMentionLabel(0)}`,
      inputImages: [imageB],
    })
  })

})


describe('gallery draft mode transitions', () => {
  it('keeps gallery input isolated while browsing square and restores independent copies', () => {
    const state = { appMode: 'gallery' as const, galleryInputDraft: null, prompt: '画廊草稿', inputImages: [imageA], maskDraft: null, maskEditorImageId: null }
    const draft = saveGalleryInputDraft(state)!
    expect(saveGalleryInputDraft({ ...state, appMode: 'square', galleryInputDraft: draft, prompt: '广场' })).toBe(draft)
    const restored = restoreGalleryInputDraftState(draft)
    expect(restored).toMatchObject({ prompt: '画廊草稿', inputImages: [imageA] })
    expect(restored.inputImages).not.toBe(draft.inputImages)
    expect(restored.inputImages[0]).not.toBe(imageA)
    expect(syncActiveInputDraft(state, { prompt: '新提示词' }).galleryInputDraft?.prompt).toBe('新提示词')
    expect(syncActiveInputDraft({ ...state, appMode: 'square' }, { prompt: '广场' })).not.toHaveProperty('galleryInputDraft')
  })
})
