import type { AppMode, BatchProgress, InputDraft, InputImage, MaskDraft, TaskRecord } from '../types'
import { restoreGalleryInputDraftState, saveGalleryInputDraft } from './inputDraftState'

/** 进入隐私模式前的输入框，退出时恢复；隐私模式期间持久化也使用它，刷新后不丢失 */
export interface PrivacyInputSnapshot {
  appMode: AppMode
  prompt: string
  inputImages: InputImage[]
  maskDraft: MaskDraft | null
  maskEditorImageId: string | null
  galleryInputDraft: InputDraft | null
  reusedTaskApiProfileId: string | null
  reusedTaskApiProfileName: string | null
  reusedTaskApiProfileMissing: boolean
  reusedTaskApiModel: string | null
}

export interface PrivacyModeState {
  startedAt: number
  hiddenTaskIds: Set<string>
  inputSnapshot: PrivacyInputSnapshot
  /** 进入时停止的批量提交中尚未提交的提示词数，退出时提示 */
  stoppedBatchPrompts: number
}

type PrivacySourceState = PrivacyInputSnapshot & { tasks: TaskRecord[]; batchProgress: BatchProgress | null }

export function createPrivacyModeState(state: PrivacySourceState, now: number): PrivacyModeState {
  return {
    startedAt: now,
    hiddenTaskIds: new Set(state.tasks.map((task) => task.id)),
    inputSnapshot: {
      appMode: state.appMode,
      prompt: state.prompt,
      inputImages: state.inputImages,
      maskDraft: state.maskDraft,
      // 退出时不重新打开遮罩编辑器
      maskEditorImageId: null,
      galleryInputDraft: state.galleryInputDraft,
      reusedTaskApiProfileId: state.reusedTaskApiProfileId,
      reusedTaskApiProfileName: state.reusedTaskApiProfileName,
      reusedTaskApiProfileMissing: state.reusedTaskApiProfileMissing,
      reusedTaskApiModel: state.reusedTaskApiModel,
    },
    stoppedBatchPrompts: state.batchProgress ? state.batchProgress.total - state.batchProgress.started : 0,
  }
}

// 导入的旧数据创建时间早于进入时间，也一并隐藏
export function isPrivacyHiddenTask(privacy: PrivacyModeState | null, task: Pick<TaskRecord, 'id' | 'createdAt'>) {
  if (!privacy) return false
  return task.createdAt < privacy.startedAt || privacy.hiddenTaskIds.has(task.id)
}

export function getPrivacySnapshotImageIds(privacy: PrivacyModeState | null) {
  if (!privacy) return []
  const snapshot = privacy.inputSnapshot
  return [snapshot, snapshot.galleryInputDraft]
    .flatMap((draft) => draft?.inputImages.map((img) => img.id) ?? [])
}

/** 退出隐私模式时的输入框：恢复进入前的草稿，丢弃隐私模式中未提交的输入 */
export function restorePrivacyInputState(snapshot: PrivacyInputSnapshot) {
  const galleryInputDraft = saveGalleryInputDraft(snapshot)
  return {
    galleryInputDraft,
    ...restoreGalleryInputDraftState(galleryInputDraft),
    maskEditorImageId: null,
    reusedTaskApiProfileId: snapshot.reusedTaskApiProfileId,
    reusedTaskApiProfileName: snapshot.reusedTaskApiProfileName,
    reusedTaskApiProfileMissing: snapshot.reusedTaskApiProfileMissing,
    reusedTaskApiModel: snapshot.reusedTaskApiModel,
  }
}
