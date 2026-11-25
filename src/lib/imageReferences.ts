import type { InputDraft, InputImage, TaskRecord } from '../types'
import { getPrivacySnapshotImageIds, type PrivacyModeState } from './privacyMode'

type ImageReferenceState = {
  tasks: TaskRecord[]
  inputImages: InputImage[]
  galleryInputDraft: InputDraft | null
  privacyMode: PrivacyModeState | null
}

export function addTaskReferencedImageIds(ids: Set<string>, task: TaskRecord) {
  for (const id of [
    ...task.inputImageIds,
    ...task.outputImages,
    ...task.transparentOriginalImages ?? [],
    ...task.streamPartialImageIds ?? [],
    task.maskTargetImageId,
    task.maskImageId,
    task.markupImageId,
  ]) {
    if (id) ids.add(id)
  }
}

export function getReferencedImageIds(state: ImageReferenceState) {
  const ids = new Set(getPrivacySnapshotImageIds(state.privacyMode))
  for (const task of state.tasks) addTaskReferencedImageIds(ids, task)
  const inputs = [state.inputImages, state.galleryInputDraft?.inputImages ?? []]
  for (const images of inputs) {
    for (const img of images) {
      ids.add(img.id)
      if (img.markupImageId) ids.add(img.markupImageId)
    }
  }
  return ids
}
