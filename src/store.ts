import type { ReactNode } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type {
  InputDraft,
  ApiMode,
  ApiProfile,
  AppSettings,
  BatchProgress,
  PresetConfig,
  AppMode,
  TaskParams,
  InputImage,
  MaskDraft,
  SketchBoardRequest,
  TaskRecord,
  FavoriteCollection,
  StoredImage,
  StoredImageThumbnail,
} from './types'
import { DEFAULT_PARAMS } from './types'
import { DEFAULT_SETTINGS, createSettingsForApiProfile, getActiveApiProfile, getCustomProviderDefinition, mergeImportedSettings, mergePresetImportedSettings, normalizeSettings, resolveApiProfileModel, splitModelList, validateApiProfile } from './lib/apiProfiles'
import { enforcePresetConfigPolicy, getPresetConfig, getPresetProfileIds, getPresetProviderIds, isPresetConfigDeletionPrevented, isPresetConfigOnlyEnabled, isPresetConfigParamsLocked, isPresetProfile, isPresetProviderDeletionPrevented } from './lib/presetConfig'
import { dismissAllTooltips } from './lib/tooltipDismiss'
import { getTaskPromptText, remapImageMentionsForOrder, replaceImageMentionsForApi, stripImageMentionMarkers } from './lib/promptImageMentions'
import {
  getAllTasks,
  getLegacyProtectedImageIds,
  collectLegacyImageIds,
  putTask as dbPutTask,
  commitTaskDeletion,
  clearTasks as dbClearTasks,
  getImage,
  getStoredImageThumbnail,
  getAllImageIds,
  putImage,
  putImageThumbnail,
  deleteImage,
  storeImage,
  storeImageWithSize,
} from './lib/db'
import { callImageApi } from './lib/api'
import { showBrowserNotification } from './lib/browserNotification'
import { IMAGE_FETCH_CORS_HINT, isHttpUrl } from './lib/imageApiShared'
import { getFalErrorMessage, getFalQueuedImageResult } from './lib/falAiImageApi'
import { getCustomQueuedImageResult } from './lib/openaiCompatibleImageApi'
import { OPENAI_IMAGE_TASK_PROVIDER, resolveCustomProviderModel } from './lib/imageProviderMappings'
import { toApiInputImageDataUrl, validateMaskMatchesImage } from './lib/canvasImage'
import { persistTaskInputImages, toReferenceImage } from './lib/inputImages'
import { orderInputImagesForMask } from './lib/mask'
import { getChangedParams, getTaskParamSupport, normalizeParamsForSettings, supportsTransparentOutput } from './lib/paramCompatibility'
import { getImageModelFamily, isVectorOrAnimatedFormat } from './lib/imageModels'
import { runWithConcurrency, splitBatchPrompts } from './lib/batchPrompts'
import { createTransparentOutputMeta, getTransparentRequestParams, removeKeyedBackgroundFromDataUrl } from './lib/transparentImage'
import { blobToDataUrl, fileToDataUrl } from './lib/dataUrl'
import { cacheImage, cacheThumbnail, clearImageCaches, deleteCachedImage, deleteImageCacheEntry, ensureImageCached, scheduleMissingThumbnailBackfill } from './lib/imageCache'
import { migrateImagesToBlob } from './lib/imageBlob'
import { hasActiveDataOperations, isCustomRecoverableTask, isFalRecoverableTask } from './lib/dataOperations'
import { formatExportFileTime } from './lib/exportFileName'
import { buildExportZip, createExportBlob, getExportFileEstimatedBytes, getExportZipPlan, MAX_EXPORT_ZIP_BYTES, readExportZip, readExportZipFileAsDataUrl, readExportZipManifest } from './lib/exportZip'
import { getExportImageSizes, readExportImages } from './lib/exportImages'
import { clearInputDraftState, isEmptyInputDraft, restoreGalleryInputDraftState, saveGalleryInputDraft, syncActiveInputDraft, updateInputDraftImages } from './lib/inputDraftState'
import { ALL_FAVORITES_COLLECTION_ID, DEFAULT_FAVORITE_COLLECTION_ID, createDefaultFavoriteCollection, deleteFavoriteCollectionState, ensureDefaultFavoriteCollection, getNewTaskFavoritePatch, getTaskFavoriteCollectionIds, mergeFavoriteCollections, normalizeFavoriteCollectionIds, normalizeFavoriteCollectionName, normalizeFavoriteCollections, normalizeFavoritePatch, normalizeLoadedFavoriteState, resolveDefaultFavoriteCollectionId, sameFavoriteCollectionIds } from './lib/favoriteState'
import { createPersistedState, migratePersistedState, normalizePersistedState } from './lib/persistedState'
import { addImageSizeParam, createTaskDonePatch, createTaskErrorPatch, deriveGalleryActualParams, firstActualParams, hasActualParams, hasActualSizeParam, mapActualParamsByImage, mapRevisedPromptsByImage, markInterruptedOpenAIRunningTasks } from './lib/taskState'
import { getPersistableRawResponsePayload } from './lib/taskResponsePayload'
import { stripInjectedCodexCliSizePrompt } from './lib/size'
import { apiFetch, FetchConnectError, isTauri } from './lib/platform'
import { pickSaveDir, saveFile, saveFileToDir, type SaveOptions } from './lib/saveFile'
import { endDataProgress, setDataProgressCancelable, startDataProgress, updateDataProgress, useSettingsDataTransfer } from './lib/dataProgress'
import { throwIfAborted } from './lib/serverSentEvents'
import { tauriStorage } from './lib/tauriStorage'
import { createPrivacyModeState, getPrivacySnapshotImageIds, isPrivacyHiddenTask, restorePrivacyInputState, type PrivacyModeState } from './lib/privacyMode'

const FAL_RECOVERY_POLL_MS = 10_000
const CUSTOM_RECOVERY_POLL_MS = 10_000
const SUPPORT_PROMPT_IMAGE_THRESHOLD = 50
const falRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const customRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
const openAIWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>()
const taskExecutions = new Map<string, symbol>()
const ERROR_TOAST_MAX_LENGTH = 80
type ToastType = 'info' | 'success' | 'error'

export function getErrorToastMessage(message: string): string {
  const text = message.trim()
  if (!text) return '操作失败'

  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? ''
  const separatorIndex = firstLine.search(/[：:]/)
  if (separatorIndex > 0) {
    const title = firstLine.slice(0, separatorIndex).trim()
    if (isErrorToastTitle(title)) return title
  }

  if (firstLine.length > ERROR_TOAST_MAX_LENGTH) return '操作失败，请查看详情'
  return firstLine || '操作失败'
}

function getToastMessage(message: string, type: ToastType): string {
  return type === 'error' ? getErrorToastMessage(message) : message
}

function isErrorToastTitle(title: string): boolean {
  return /(?:失败|错误|异常|报错|无法|不能|超时|中断|断开|请先|请输入|已达上限|不存在|已丢失)$/.test(title)
}

export type SettingsTab = 'general' | 'appearance' | 'skill' | 'api' | 'data' | 'about'

const TIMEOUT_STREAMING_HINT = '也可尝试打开「流式传输」，并提高「请求中间步骤图像数」来维持连接。'
const TIMEOUT_PARTIAL_IMAGES_ZERO_HINT = '官方流式接口不发送心跳，当前「请求中间步骤图像数」为 0，连接可能因无数据传输而断开。建议提高到 2 或 3。'
const TIMEOUT_PARTIAL_IMAGES_LOW_HINT = '也可尝试提高「请求中间步骤图像数」来维持连接，避免长时间无数据传输导致断开。'

type TimeoutStreamingHintProfile = Pick<ApiProfile, 'provider' | 'streamImages' | 'streamPartialImages'>

function getTimeoutStreamingHint(profile?: TimeoutStreamingHintProfile | null) {
  if (profile?.provider !== 'openai') return ''
  const partialImages = profile.streamPartialImages ?? DEFAULT_SETTINGS.streamPartialImages ?? 0
  if (profile.streamImages !== true) return TIMEOUT_STREAMING_HINT
  if (partialImages === 0) return TIMEOUT_PARTIAL_IMAGES_ZERO_HINT
  return partialImages < 3 ? TIMEOUT_PARTIAL_IMAGES_LOW_HINT : ''
}

function createOpenAITimeoutError(timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
  return `请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。${getTimeoutStreamingHint(profile)}`
}

function orderImagesWithMaskFirst(images: InputImage[], maskTargetImageId: string | null | undefined) {
  if (!maskTargetImageId) return images
  const maskIdx = images.findIndex((img) => img.id === maskTargetImageId)
  if (maskIdx <= 0) return images
  const next = [...images]
  const [maskImage] = next.splice(maskIdx, 1)
  next.unshift(maskImage)
  return next
}

export function isAgentTask(task: TaskRecord) {
  return task.sourceMode === 'agent'
}

// 失败通知用独立 tag，避免与成功通知互相覆盖
function showTaskCompletionNotification(title: string, body: string, tag = 'task-completion') {
  const settings = normalizeSettings(useStore.getState().settings)
  if (!settings.taskCompletionNotification) return
  showBrowserNotification(title, { body, tag })
}

// 隐私模式中丢弃进入前已开始的任务和对话的提示与通知，退出后也不补发
function isTaskHiddenByPrivacyMode(task: TaskRecord) {
  return isPrivacyHiddenTask(useStore.getState().privacyMode, task)
}


function showTaskFailureNotification(task: TaskRecord) {
  // Agent 任务由所在回合统一通知，批量任务在整批结束时汇总失败数量
  if (isAgentTask(task) || batchTaskIds.has(task.id) || isTaskHiddenByPrivacyMode(task)) return
  showTaskCompletionNotification('图像生成失败', '请回到应用查看详情。', 'task-failure')
}

export function countSuccessfulOutputImages(tasks: TaskRecord[]) {
  return tasks.reduce((count, task) => count + (task.status === 'done' && !isAgentTask(task) ? task.outputImages.length : 0), 0)
}

function skipSupportPromptForImportedData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptOpen) return {}
    return { supportPromptSkippedForImportedData: true }
  })
}

function showSupportPromptForExistingLocalData(tasks: TaskRecord[]) {
  const count = countSuccessfulOutputImages(tasks)
  useStore.setState((state) => {
    if (state.supportPromptDismissed || state.supportPromptOpen) return {}
    if (count <= SUPPORT_PROMPT_IMAGE_THRESHOLD) {
      return { supportPromptSkippedForImportedData: false }
    }
    if (state.supportPromptSkippedForImportedData) return {}
    return { supportPromptOpen: true }
  })
}

function maybeOpenSupportPrompt(previousTasks: TaskRecord[], nextTasks: TaskRecord[], taskId: string) {
  const state = useStore.getState()
  if (state.supportPromptDismissed || state.supportPromptOpen || state.supportPromptSkippedForImportedData) return

  const previousTask = previousTasks.find((task) => task.id === taskId)
  const nextTask = nextTasks.find((task) => task.id === taskId)
  if (!nextTask || previousTask?.status === 'done' || nextTask.status !== 'done' || nextTask.outputImages.length === 0) return

  const previousCount = countSuccessfulOutputImages(previousTasks)
  const nextCount = countSuccessfulOutputImages(nextTasks)
  if (previousCount <= SUPPORT_PROMPT_IMAGE_THRESHOLD && nextCount > SUPPORT_PROMPT_IMAGE_THRESHOLD) {
    useStore.setState({ supportPromptOpen: true })
  }
}

export function getPersistedState(state: AppState) {
  // 隐私模式中输入框已清空，仍保存进入前的输入，刷新后不丢失
  const source = state.privacyMode ? { ...state, ...state.privacyMode.inputSnapshot } : state
  return createPersistedState(source)
}

function mergePersistedState(persistedState: unknown, currentState: AppState): AppState {
  const plan = normalizePersistedState(persistedState, currentState)
  if (!plan) return currentState
  return {
    ...currentState,
    ...plan.state,
    activeFavoriteCollectionId: null,
    favoritePickerTaskIds: null,
  }
}

// ===== Store 类型 =====

let legacyImageIds = new Set<string>()

interface AppState {
  legacyAgentData?: Record<string, unknown>
  // 模式
  appMode: AppMode
  setAppMode: (mode: AppMode) => void

  // 设置
  settings: AppSettings
  previousPresetConfig: PresetConfig | null
  setSettings: (s: Partial<AppSettings>) => void
  setPresetImportedSettings: (
    importedSettings: Partial<AppSettings> | unknown,
    transform?: (settings: AppSettings) => Partial<AppSettings>,
  ) => Promise<void>
  dismissedPresetProfileIds: string[]
  dismissPresetProfile: (id: string) => void
  restorePresetProfile: (id: string) => void
  dismissedPresetProviderIds: string[]
  dismissPresetProvider: (id: string) => void
  restorePresetProvider: (id: string) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void

  // 输入
  prompt: string
  setPrompt: (p: string) => void
  /**
   * 输入框最后一次的选区（可见文本偏移），供画板等外部入口插入胶囊并覆盖选中内容；未聚焦过时为 null。
   * 同时记下当时的提示词，提示词被其他途径替换后选区即失效，使用前需比对。
   */
  promptSelection: { start: number; end: number; prompt: string } | null
  setPromptSelection: (selection: { start: number; end: number }) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  replaceInputImage: (idx: number, img: InputImage) => void
  /** 设置或清除参考图上的 markup 标注层 */
  setInputImageMarkup: (imageId: string, markupImageId: string | undefined) => void
  removeInputImage: (idx: number) => void
  clearInputImages: () => void
  setInputImages: (imgs: InputImage[], options?: { equivalentImageIds?: Record<string, string> }) => void
  moveInputImage: (fromIdx: number, toIdx: number) => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void
  galleryInputDraft: InputDraft | null

  // 参数
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void
  reusedTaskApiProfileId: string | null
  reusedTaskApiProfileName: string | null
  reusedTaskApiProfileMissing: boolean
  /** 临时复用其他配置时使用的模型，只在本次复用中生效，不写入该配置 */
  reusedTaskApiModel: string | null
  setReusedTaskApiProfile: (profileId: string | null, missing?: boolean, profileName?: string | null, model?: string | null) => void
  setReusedTaskApiModel: (model: string) => void
  /** 正在进行的批量提交进度，仅保存在内存中 */
  batchProgress: BatchProgress | null
  setBatchProgress: (progress: BatchProgress | null) => void

  // 任务列表
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void
  favoriteCollections: FavoriteCollection[]
  setFavoriteCollections: (collections: FavoriteCollection[]) => void
  defaultFavoriteCollectionId: string | null
  setDefaultFavoriteCollectionId: (id: string | null) => void
  activeFavoriteCollectionId: string | null
  isManageCollectionsModalOpen: boolean
  setActiveFavoriteCollectionId: (id: string | null) => void
  openManageCollectionsModal: () => void
  closeManageCollectionsModal: () => void
  favoritePickerTaskIds: string[] | null
  openFavoritePicker: (taskIds: string[]) => void
  closeFavoritePicker: () => void
  streamPreviews: Record<string, string>
  streamPreviewSlots: Record<string, Record<string, string>>
  setTaskStreamPreview: (taskId: string, image?: string, requestIndex?: number) => void

  // 搜索和筛选
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | 'running' | 'done' | 'error'
  setFilterStatus: (status: AppState['filterStatus']) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void

  // 多选
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void
  selectedFavoriteCollectionIds: string[]
  setSelectedFavoriteCollectionIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleFavoriteCollectionSelection: (id: string, force?: boolean) => void
  clearFavoriteCollectionSelection: () => void

  // UI
  detailTaskId: string | null
  setDetailTaskId: (id: string | null) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  /** 预览参考图时对应的提示词，按图片在列表中的位置取其评论；为空时不显示评论 */
  lightboxCommentPrompt: string | null
  /** 预览参考图时各图片对应的 markup 标注层 image store id；同一参考图在不同任务中的标注不同，需随预览传入 */
  lightboxMarkupIds: Record<string, string | undefined>
  setLightboxImageId: (id: string | null, list?: string[], commentPrompt?: string | null, markupIds?: Record<string, string | undefined>) => void
  /** 画板；baseImageSrc 为画布底图，replaceImageId 为完成后要替换的参考图 */
  sketchBoard: SketchBoardRequest | null
  setSketchBoard: (board: SketchBoardRequest | null) => void
  showSettings: boolean
  settingsTabRequest: SettingsTab | null
  setShowSettings: (v: boolean, tab?: SettingsTab) => void
  supportPromptOpen: boolean
  supportPromptDismissed: boolean
  supportPromptSkippedForImportedData: boolean
  /** 通过链接添加的参考图 id 到原链接，供只接受链接参考图的自定义服务商使用 */
  imageSourceUrls: Record<string, string>
  setSupportPromptOpen: (v: boolean) => void
  dismissSupportPrompt: () => void

  // Toast
  toast: { message: string; type: ToastType } | null
  showToast: (message: string, type?: ToastType) => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    /** 显示在 message 下方的自定义内容，过长时可滚动 */
    content?: ReactNode
    checkbox?: {
      label: string
      defaultChecked?: boolean
      disabled?: boolean
      tone?: 'primary' | 'danger'
    }
    confirmText?: string
    cancelText?: string
    showCancel?: boolean
    buttons?: Array<{
      label: string
      tone?: 'primary' | 'secondary' | 'danger' | 'warning'
      action: (checkboxChecked?: boolean) => void
    }>
    icon?: 'info' | 'copy'
    minConfirmDelayMs?: number
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    awaitAction?: boolean
    /** awaitAction 执行期间确认按钮显示的文字 */
    busyText?: string
    action?: (checkboxChecked?: boolean) => void | boolean | Promise<void | boolean>
    cancelAction?: (checkboxChecked?: boolean) => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void

  // 隐私模式：不持久化，刷新页面后自然退出
  privacyMode: PrivacyModeState | null
  /** 每次进入隐私模式时递增，作为弹窗组件的 key，丢弃组件内部打开的弹窗和未保存内容 */
  privacyModeEpoch: number
  /** 设置弹窗的 key；导入导出中进入隐私模式时不变，保留进行中的传输状态 */
  settingsModalEpoch: number
  togglePrivacyMode: () => void
}

function isImageReferencedByState(state: AppState, imageId: string) {
  if (state.inputImages.some((img) => img.id === imageId || img.markupImageId === imageId)) return true
  if (state.galleryInputDraft?.inputImages.some((img) => img.id === imageId || img.markupImageId === imageId)) return true
  if (getPrivacySnapshotImageIds(state.privacyMode).includes(imageId)) return true
  if (state.tasks.some((task) =>
    task.inputImageIds.includes(imageId) ||
    task.outputImages.includes(imageId) ||
    task.transparentOriginalImages?.includes(imageId) ||
    task.streamPartialImageIds?.includes(imageId) ||
    task.maskTargetImageId === imageId ||
    task.maskImageId === imageId ||
    task.markupImageId === imageId
  )) return true
  return legacyImageIds.has(imageId)
}

export async function deleteImageIfUnreferenced(imageId: string) {
  if (isImageReferencedByState(useStore.getState(), imageId)) return
  try {
    await deleteStoredImageIfUnreferenced(imageId)
  } catch {
    // 清理是内存/存储优化，失败不影响替换结果。
  }
}

function forgetImageSourceUrl(imageId: string) {
  if (!(imageId in useStore.getState().imageSourceUrls)) return
  useStore.setState((s) => {
    const imageSourceUrls = { ...s.imageSourceUrls }
    delete imageSourceUrls[imageId]
    return { imageSourceUrls }
  })
}

async function deleteStoredImageIfUnreferenced(imageId: string) {
  if (isImageReferencedByState(useStore.getState(), imageId)) return
  const [image, thumbnail] = await Promise.all([getImage(imageId), getStoredImageThumbnail(imageId)])
  if (isImageReferencedByState(useStore.getState(), imageId)) return

  await deleteImage(imageId)
  if (!isImageReferencedByState(useStore.getState(), imageId)) {
    deleteImageCacheEntry(imageId)
    forgetImageSourceUrl(imageId)
    return
  }

  if (image) {
    await putImage(image)
    cacheImage(image.id, image.dataUrl)
  }
  if (thumbnail) {
    await putImageThumbnail(thumbnail)
    cacheThumbnail(thumbnail.id, {
      src: thumbnail.thumbnailDataUrl,
      width: thumbnail.width,
      height: thumbnail.height,
      thumbnailVersion: thumbnail.thumbnailVersion,
    })
  }
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Mode
      appMode: 'gallery',
      setAppMode: (appMode) => set((state) => ({
        appMode,
        galleryInputDraft: saveGalleryInputDraft(state),
        selectedTaskIds: [],
        selectedFavoriteCollectionIds: [],
      })),

      // Settings
      settings: { ...DEFAULT_SETTINGS },
      previousPresetConfig: null,
      dismissedPresetProfileIds: [],
      dismissPresetProfile: (id) => set((state) => ({
        dismissedPresetProfileIds: state.dismissedPresetProfileIds.includes(id)
          ? state.dismissedPresetProfileIds
          : [...state.dismissedPresetProfileIds, id],
      })),
      restorePresetProfile: (id) => set((state) => ({
        dismissedPresetProfileIds: state.dismissedPresetProfileIds.filter((item) => item !== id),
      })),
      dismissedPresetProviderIds: [],
      dismissPresetProvider: (id) => set((state) => ({
        dismissedPresetProviderIds: state.dismissedPresetProviderIds.includes(id)
          ? state.dismissedPresetProviderIds
          : [...state.dismissedPresetProviderIds, id],
      })),
      restorePresetProvider: (id) => set((state) => ({
        dismissedPresetProviderIds: state.dismissedPresetProviderIds.filter((item) => item !== id),
      })),
      setSettings: (s) => set((st) => {
        const previous = normalizeSettings(st.settings)
        const incoming = s as Partial<AppSettings>
        const hasLegacyOverrides =
          incoming.baseUrl !== undefined ||
          incoming.apiKey !== undefined ||
          incoming.model !== undefined ||
          incoming.timeout !== undefined ||
          incoming.apiMode !== undefined ||
          incoming.codexCli !== undefined ||
          incoming.apiProxy !== undefined ||
          incoming.streamImages !== undefined ||
          incoming.streamPartialImages !== undefined
        const merged = normalizeSettings({ ...previous, ...incoming })
        if (hasLegacyOverrides && incoming.profiles === undefined) {
          merged.profiles = merged.profiles.map((profile) =>
            profile.id === merged.activeProfileId
              ? {
                  ...profile,
                  baseUrl: incoming.baseUrl ?? profile.baseUrl,
                  apiKey: incoming.apiKey ?? profile.apiKey,
                  model: incoming.model ?? profile.model,
                  timeout: incoming.timeout ?? profile.timeout,
                  apiMode: incoming.apiMode === 'images' || incoming.apiMode === 'responses' ? incoming.apiMode : profile.apiMode,
                  codexCli: incoming.codexCli ?? profile.codexCli,
                  apiProxy: incoming.apiProxy ?? profile.apiProxy,
                  streamImages: incoming.streamImages ?? profile.streamImages,
                  streamPartialImages: incoming.streamPartialImages ?? profile.streamPartialImages,
                }
              : profile,
          )
        }
        const effectiveDismissedPresetProviderIds = st.dismissedPresetProviderIds.filter((id) =>
          !isPresetProviderDeletionPrevented(id, previous.profiles),
        )
        const settings = normalizeSettings(enforcePresetConfigPolicy(merged, {
          dismissedPresetProviderIds: effectiveDismissedPresetProviderIds,
        }))
        const shouldClearReusedProfile = st.reusedTaskApiProfileId && settings.activeProfileId === st.reusedTaskApiProfileId
        return {
          settings,
          ...(shouldClearReusedProfile
            ? { reusedTaskApiProfileId: null, reusedTaskApiProfileName: null, reusedTaskApiProfileMissing: false, reusedTaskApiModel: null }
            : {}),
        }
      }),
      setPresetImportedSettings: async (importedSettings, transform) => {
        set((state) => {
          const presetIds = getPresetProfileIds()
          const presetProviderIds = getPresetProviderIds()
          const dismissedPresetProfileIds = state.dismissedPresetProfileIds.filter((id) => presetIds.has(id))
          const deletionPrevented = isPresetConfigDeletionPrevented()
          const remainingPresetProfiles = (getPresetConfig()?.profiles ?? state.settings.profiles)
            .filter((profile) => !dismissedPresetProfileIds.includes(profile.id))
          const dismissedPresetProviderIds = state.dismissedPresetProviderIds
            .filter((id) => presetProviderIds.has(id))
          const effectiveDismissedPresetProviderIds = dismissedPresetProviderIds
            .filter((id) => !isPresetProviderDeletionPrevented(id, remainingPresetProfiles))
          const merged = mergePresetImportedSettings(state.settings, importedSettings, {
            lockPresetParams: isPresetConfigParamsLocked(),
            dismissedPresetProfileIds: deletionPrevented ? [] : dismissedPresetProfileIds,
            dismissedPresetProviderIds: effectiveDismissedPresetProviderIds,
            previousPresetConfig: state.previousPresetConfig,
            usedPresetProfileIds: state.tasks.flatMap((task) => task.apiProfileId ? [task.apiProfileId] : []),
          })
          const settings = normalizeSettings(enforcePresetConfigPolicy(
            normalizeSettings(transform?.(merged.settings) ?? merged.settings),
            { dismissedPresetProviderIds: effectiveDismissedPresetProviderIds },
          ))
          const shouldClearReusedProfile = state.reusedTaskApiProfileId && settings.activeProfileId === state.reusedTaskApiProfileId
          return {
            settings,
            previousPresetConfig: getPresetConfig() ? merged.presetConfig : null,
            dismissedPresetProfileIds,
            dismissedPresetProviderIds,
            reusedTaskApiProfileId: shouldClearReusedProfile ? null : state.reusedTaskApiProfileId,
            ...(shouldClearReusedProfile
              ? { reusedTaskApiProfileName: null, reusedTaskApiProfileMissing: false, reusedTaskApiModel: null }
              : {}),
          }
        })
      },
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => ({
        dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key],
      })),

      // Input
      prompt: '',
      setPrompt: (prompt) => set((s) => syncActiveInputDraft(s, { prompt })),
      promptSelection: null,
      setPromptSelection: (selection) => set((s) => ({ promptSelection: { ...selection, prompt: s.prompt } })),
      inputImages: [],
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return syncActiveInputDraft(s, { inputImages: [...s.inputImages, img] })
        }),
      replaceInputImage: (idx, img) => {
        let removed = null as InputImage | null
        set((s) => {
          if (idx < 0 || idx >= s.inputImages.length) return s
          const previous = s.inputImages[idx]
          if (!previous || previous.id === img.id) return s
          if (s.inputImages.some((item, itemIdx) => itemIdx !== idx && item.id === img.id)) return s
          removed = previous
          const inputImages = s.inputImages.map((item, itemIdx) => itemIdx === idx ? img : item)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            equivalentImageIds: { [previous.id]: img.id },
            clearMissingMask: previous.id === s.maskDraft?.targetImageId,
          }))
        })
        // 换了图片后旧标注对不上新图，随旧图一起清理
        for (const id of [removed?.id, removed?.markupImageId]) {
          if (id) void deleteImageIfUnreferenced(id)
        }
      },
      setInputImageMarkup: (imageId, markupImageId) => {
        let previousMarkupId: string | undefined
        set((s) => {
          const target = s.inputImages.find((img) => img.id === imageId)
          if (!target || target.markupImageId === markupImageId) return s
          previousMarkupId = target.markupImageId
          const inputImages = s.inputImages.map((img) => {
            if (img.id !== imageId) return img
            const { markupImageId: _previous, ...rest } = img
            return markupImageId ? { ...rest, markupImageId } : rest
          })
          return syncActiveInputDraft(s, { inputImages })
        })
        if (previousMarkupId) void deleteImageIfUnreferenced(previousMarkupId)
      },
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const inputImages = s.inputImages.filter((_, i) => i !== idx)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            clearMissingMask: removed?.id === s.maskDraft?.targetImageId,
          }))
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) deleteCachedImage(img.id)
          return syncActiveInputDraft(s, {
            ...updateInputDraftImages(s, []),
            maskDraft: null,
            maskEditorImageId: null,
          })
        }),
      setInputImages: (imgs, options) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(imgs, s.maskDraft?.targetImageId)
          return syncActiveInputDraft(s, updateInputDraftImages(s, inputImages, {
            equivalentImageIds: options?.equivalentImageIds,
          }))
        }),
      moveInputImage: (fromIdx, toIdx) =>
        set((s) => {
          const images = [...s.inputImages]
          if (fromIdx < 0 || fromIdx >= images.length) return s
          const maskTargetImageId = s.maskDraft?.targetImageId
          if (maskTargetImageId && images[fromIdx]?.id === maskTargetImageId) return s
          const minTargetIdx = maskTargetImageId && images.some((img) => img.id === maskTargetImageId) ? 1 : 0
          const targetIdx = Math.max(minTargetIdx, Math.min(images.length, toIdx))
          const insertIdx = fromIdx < targetIdx ? targetIdx - 1 : targetIdx
          if (insertIdx === fromIdx) return s
          const [moved] = images.splice(fromIdx, 1)
          images.splice(insertIdx, 0, moved)
          return syncActiveInputDraft(s, updateInputDraftImages(s, images, { clearMissingMask: false }))
        }),
      maskDraft: null,
      setMaskDraft: (maskDraft) =>
        set((s) => {
          const inputImages = orderImagesWithMaskFirst(s.inputImages, maskDraft?.targetImageId)
          return syncActiveInputDraft(s, {
            maskDraft,
            inputImages,
            prompt: remapImageMentionsForOrder(s.prompt, s.inputImages, inputImages),
          })
        }),
      clearMaskDraft: () => set((s) => syncActiveInputDraft(s, { maskDraft: null })),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => {
        if (maskEditorImageId) dismissAllTooltips()
        set((s) => syncActiveInputDraft(s, { maskEditorImageId }))
      },
      galleryInputDraft: null,

      // Params
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      reusedTaskApiModel: null,
      setReusedTaskApiProfile: (profileId, missing = false, profileName = null, model = null) => set({
        reusedTaskApiProfileId: profileId,
        reusedTaskApiProfileName: profileName,
        reusedTaskApiProfileMissing: missing,
        reusedTaskApiModel: profileId ? model : null,
      }),
      setReusedTaskApiModel: (reusedTaskApiModel) => set({ reusedTaskApiModel }),
      batchProgress: null,
      setBatchProgress: (batchProgress) => set({ batchProgress }),

      // Tasks
      tasks: [],
      setTasks: (tasks) => set(() => ({
        tasks,
        ...(countSuccessfulOutputImages(tasks) <= SUPPORT_PROMPT_IMAGE_THRESHOLD
          ? { supportPromptSkippedForImportedData: false }
          : {}),
      })),
      favoriteCollections: [createDefaultFavoriteCollection()],
      setFavoriteCollections: (favoriteCollections) => set((state) => {
        const nextCollections = ensureDefaultFavoriteCollection(normalizeFavoriteCollections(favoriteCollections))
        return {
          favoriteCollections: nextCollections,
          defaultFavoriteCollectionId: resolveDefaultFavoriteCollectionId(nextCollections, state.defaultFavoriteCollectionId),
        }
      }),
      defaultFavoriteCollectionId: DEFAULT_FAVORITE_COLLECTION_ID,
      setDefaultFavoriteCollectionId: (defaultFavoriteCollectionId) => set((state) => (
        defaultFavoriteCollectionId === null || state.favoriteCollections.some((collection) => collection.id === defaultFavoriteCollectionId)
          ? { defaultFavoriteCollectionId }
          : state
      )),
      activeFavoriteCollectionId: null,
      isManageCollectionsModalOpen: false,
      setActiveFavoriteCollectionId: (activeFavoriteCollectionId) => set({ activeFavoriteCollectionId, selectedTaskIds: [], selectedFavoriteCollectionIds: [] }),
      openManageCollectionsModal: () => set({ isManageCollectionsModalOpen: true }),
      closeManageCollectionsModal: () => set({ isManageCollectionsModalOpen: false }),
      favoritePickerTaskIds: null,
      openFavoritePicker: (taskIds) => {
        if (!taskIds.length) return
        dismissAllTooltips()
        set({ favoritePickerTaskIds: Array.from(new Set(taskIds)).filter(Boolean) })
      },
      closeFavoritePicker: () => set({ favoritePickerTaskIds: null }),
      streamPreviews: {},
      streamPreviewSlots: {},
      setTaskStreamPreview: (taskId, image, requestIndex = 0) => set((s) => {
        if (image) {
          if (!s.tasks.some((task) => task.id === taskId)) return s
          const slotKey = String(requestIndex)
          const currentSlots = s.streamPreviewSlots[taskId] ?? {}
          if (s.streamPreviews[taskId] === image && currentSlots[slotKey] === image) return s
          return {
            streamPreviews: { ...s.streamPreviews, [taskId]: image },
            streamPreviewSlots: {
              ...s.streamPreviewSlots,
              [taskId]: { ...currentSlots, [slotKey]: image },
            },
          }
        }

        if (!(taskId in s.streamPreviews) && !(taskId in s.streamPreviewSlots)) return s
        const next = { ...s.streamPreviews }
        const nextSlots = { ...s.streamPreviewSlots }
        delete next[taskId]
        delete nextSlots[taskId]
        return { streamPreviews: next, streamPreviewSlots: nextSlots }
      }),

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set(filterFavorite ? { filterFavorite, selectedTaskIds: [], selectedFavoriteCollectionIds: [] } : { filterFavorite, activeFavoriteCollectionId: null, selectedTaskIds: [], selectedFavoriteCollectionIds: [] }),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) => set((s) => ({
        selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater
      })),
      toggleTaskSelection: (id, force) => set((s) => {
        const isSelected = s.selectedTaskIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedTaskIds: shouldSelect
            ? [...s.selectedTaskIds, id]
            : s.selectedTaskIds.filter((x) => x !== id)
        }
      }),
      clearSelection: () => set({ selectedTaskIds: [] }),
      selectedFavoriteCollectionIds: [],
      setSelectedFavoriteCollectionIds: (updater) => set((s) => ({
        selectedFavoriteCollectionIds: typeof updater === 'function' ? updater(s.selectedFavoriteCollectionIds) : updater
      })),
      toggleFavoriteCollectionSelection: (id, force) => set((s) => {
        const isSelected = s.selectedFavoriteCollectionIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedFavoriteCollectionIds: shouldSelect
            ? [...s.selectedFavoriteCollectionIds, id]
            : s.selectedFavoriteCollectionIds.filter((x) => x !== id)
        }
      }),
      clearFavoriteCollectionSelection: () => set({ selectedFavoriteCollectionIds: [] }),

      // UI
      detailTaskId: null,
      setDetailTaskId: (detailTaskId) => {
        if (detailTaskId) dismissAllTooltips()
        set({ detailTaskId })
      },
      lightboxImageId: null,
      lightboxImageList: [],
      lightboxCommentPrompt: null,
      lightboxMarkupIds: {},
      setLightboxImageId: (lightboxImageId, list, commentPrompt = null, markupIds = {}) => {
        if (lightboxImageId) dismissAllTooltips()
        set({
          lightboxImageId,
          lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []),
          lightboxCommentPrompt: lightboxImageId ? commentPrompt : null,
          lightboxMarkupIds: lightboxImageId ? markupIds : {},
        })
      },
      sketchBoard: null,
      setSketchBoard: (sketchBoard) => {
        if (sketchBoard) dismissAllTooltips()
        set({ sketchBoard })
      },
      showSettings: false,
      settingsTabRequest: null,
      setShowSettings: (showSettings, settingsTabRequest) => {
        if (showSettings) dismissAllTooltips()
        set({
          showSettings,
          ...(settingsTabRequest ? { settingsTabRequest } : {}),
          ...(!showSettings ? { settingsTabRequest: null } : {}),
        })
      },
      supportPromptOpen: false,
      supportPromptDismissed: false,
      supportPromptSkippedForImportedData: false,
      imageSourceUrls: {},
      setSupportPromptOpen: (supportPromptOpen) => set({ supportPromptOpen }),
      dismissSupportPrompt: () => set({ supportPromptOpen: false, supportPromptDismissed: true }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        const toastMessage = getToastMessage(message, type)
        const toast = { message: toastMessage, type }
        set({ toast })
        setTimeout(() => {
          set((s) => (s.toast === toast ? { toast: null } : s))
        }, 3000)
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => {
        if (confirmDialog) dismissAllTooltips()
        set({ confirmDialog })
      },

      privacyMode: null,
      privacyModeEpoch: 0,
      settingsModalEpoch: 0,
      togglePrivacyMode: () => {
        const state = get()
        if (state.privacyMode) {
          set({
            privacyMode: null,
            ...restorePrivacyInputState(state.privacyMode.inputSnapshot),
          })
          const stopped = state.privacyMode.stoppedBatchPrompts
          if (stopped > 0) get().showToast(`进入隐私模式时停止了批量提交，${stopped} 条提示词未提交`, 'info')
          return
        }

        const privacyMode = createPrivacyModeState(state, Date.now())
        // 继续批量会用旧提示词创建新的可见任务；已开始的任务继续执行
        if (state.batchProgress) endBatch(activeBatchId)
        dismissAllTooltips()
        // 导入导出进行中保留设置弹窗和其中的确认框，传输期间的限制与提示照旧，其余照常进入隐私模式
        const keepSettings = Boolean(useSettingsDataTransfer.getState().mode)
        set({
          privacyMode,
          privacyModeEpoch: state.privacyModeEpoch + 1,
          appMode: 'gallery',
          ...clearInputDraftState(),
          galleryInputDraft: null,
          reusedTaskApiProfileId: null,
          reusedTaskApiProfileName: null,
          reusedTaskApiProfileMissing: false,
          reusedTaskApiModel: null,
          searchQuery: '',
          filterStatus: 'all',
          filterFavorite: false,
          activeFavoriteCollectionId: null,
          selectedTaskIds: [],
          selectedFavoriteCollectionIds: [],
          // 直接关闭，不经过各弹窗的关闭流程，不保存草稿也不弹出确认
          ...(keepSettings ? {} : {
            showSettings: false,
            settingsTabRequest: null,
            confirmDialog: null,
            settingsModalEpoch: state.settingsModalEpoch + 1,
          }),
          detailTaskId: null,
          lightboxImageId: null,
          lightboxImageList: [],
          lightboxCommentPrompt: null,
          lightboxMarkupIds: {},
          sketchBoard: null,
          favoritePickerTaskIds: null,
          isManageCollectionsModalOpen: false,
          toast: null,
        })
      },
    }),
    {
      name: 'gpt-image-playground',
      // 与 zustand 默认存储（window.localStorage）一致；客户端改用预加载到内存的 SQLite kv
      storage: createJSONStorage(() => isTauri ? tauriStorage : window.localStorage),
      version: 2,
      migrate: migratePersistedState,
      partialize: getPersistedState,
      merge: mergePersistedState,
    },
  ),
)

// ===== Actions =====

let uid = 0
function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

function getPersistableTask(task: TaskRecord): TaskRecord {
  const rawResponsePayload = getPersistableRawResponsePayload(task.rawResponsePayload)
  return rawResponsePayload === task.rawResponsePayload ? task : { ...task, rawResponsePayload }
}

function putTask(task: TaskRecord): Promise<IDBValidKey> {
  return dbPutTask(getPersistableTask(task))
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  const profile = getActiveApiProfile(settings)
  return `${profile.baseUrl}\n${profile.apiKey}`
}

function isRunningOpenAITask(task: TaskRecord) {
  return task.status === 'running' && (task.apiProvider ?? 'openai') !== 'fal' && !task.customTaskId
}

function isAsyncCustomProviderTask(settings: AppSettings, profile: ApiProfile, hasInputImages: boolean) {
  const definition = getCustomProviderDefinition(settings, profile.provider)
  if (!definition) return false
  const customProvider = resolveCustomProviderModel(definition, profile.model)
  if (!customProvider.poll) return false
  const submitMapping = hasInputImages && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
  return Boolean(submitMapping.taskIdPath)
}

function clearOpenAIWatchdogTimer(taskId: string) {
  const timer = openAIWatchdogTimers.get(taskId)
  if (timer) clearTimeout(timer)
  openAIWatchdogTimers.delete(taskId)
}

function failOpenAITaskIfStillRunning(taskId: string, error: string, now = Date.now()) {
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return false

  updateTaskInStore(taskId, {
    ...createTaskErrorPatch(task, error, now),
    falRecoverable: false,
    elapsed: Math.max(0, now - (task.startedAt ?? task.createdAt)),
  })
  showTaskFailureNotification(task)
  return true
}

function scheduleOpenAIWatchdog(taskId: string, timeoutSeconds: number, profile?: TimeoutStreamingHintProfile | null) {
  clearOpenAIWatchdogTimer(taskId)
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task || !isRunningOpenAITask(task)) return

  const timeoutMs = Math.max(0, timeoutSeconds * 1000)
  const remainingMs = Math.max(0, timeoutMs - (Date.now() - (task.startedAt ?? task.createdAt)))
  const timer = setTimeout(() => {
    openAIWatchdogTimers.delete(taskId)
    const failed = failOpenAITaskIfStillRunning(taskId, createOpenAITimeoutError(timeoutSeconds, profile))
    if (failed && !isTaskHiddenByPrivacyMode(task)) useStore.getState().showToast('OpenAI 任务请求超时', 'error')
  }, remainingMs)
  openAIWatchdogTimers.set(taskId, timer)
}

function usesConcurrentImageRequests(settings: AppSettings, profile: ApiProfile, params: TaskParams, hasInputImages: boolean) {
  const n = params.n > 0 ? params.n : 1
  if (n <= 1) return false
  if (profile.provider === 'google') return true
  if (getImageModelFamily(profile)) return false
  if (profile.provider === 'openai') {
    if (profile.apiMode === 'responses') return true
    return profile.apiMode === 'images' && (profile.codexCli || params.output_format === 'svg' || (profile.streamImages && params.output_format !== 'gif'))
  }
  return profile.provider !== 'fal' && (profile.codexCli || params.output_format === 'svg') && !isAsyncCustomProviderTask(settings, profile, hasInputImages)
}

export function taskHasOutputErrors(task: Pick<TaskRecord, 'outputErrors'>) {
  return Boolean(task.outputErrors?.length)
}

export function taskMatchesFilterStatus(task: TaskRecord, filterStatus: AppState['filterStatus']) {
  if (filterStatus === 'all') return true
  if (filterStatus === 'error') return task.status === 'error' || taskHasOutputErrors(task)
  return task.status === filterStatus
}

export function taskMatchesSearchQuery(task: TaskRecord, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const prompt = getTaskPromptText(task.prompt || '', task.inputImageIds.length).toLowerCase()
  const paramStr = JSON.stringify(task.params).toLowerCase()
  const errorStr = [task.error, ...(task.outputErrors ?? []).map((item) => item.error)].filter(Boolean).join('\n').toLowerCase()
  return prompt.includes(q) || paramStr.includes(q) || errorStr.includes(q)
}

export function showCodexCliPrompt(force = false, reason = '接口返回的提示词已被改写') {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)
  if (!force && (settings.codexCli || state.dismissedCodexCliPrompts.includes(promptKey))) return
  const promptRewriteGuardMessage = settings.allowPromptRewrite
    ? '当前已允许模型改写优化提示词，因此不会额外加入不改写要求。'
    : '同时，提示词文本开头会加入简短的不改写要求，避免模型重写提示词，偏离原意。'

  state.setConfirmDialog({
    title: '检测到 Codex CLI API',
    message: `${reason}，当前 API 来源很可能是 Codex CLI。\n\n是否开启 Codex CLI 兼容模式？开启后会禁用在此处无效的质量参数，并在 Images API 多图生成时使用并发请求，解决该 API 数量参数无效的问题。${promptRewriteGuardMessage}`,
    confirmText: '开启',
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      state.setSettings({ codexCli: true })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

function getFalRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile?.provider === 'fal' && task.apiProvider === 'fal') return taskProfile
  return null
}

function getCustomRecoveryProfile(settings: AppSettings, task: TaskRecord) {
  const taskProfile = getTaskApiProfile(settings, task)
  if (taskProfile && taskProfile.provider === task.apiProvider && taskProfile.provider !== 'fal') return { ...taskProfile, model: task.apiModel || taskProfile.model }
  return null
}

export function getTaskApiProfile(settings: AppSettings, task: TaskRecord): ApiProfile | null {
  const normalized = normalizeSettings(settings)
  if (!task.apiProfileId) return null
  const profile = normalized.profiles.find((item) => item.id === task.apiProfileId)
  // 任务记录的模型仍在配置的模型列表中时，沿用任务提交时的模型
  return profile ? resolveApiProfileModel(profile, task.apiModel, getCustomProviderDefinition(normalized, profile.provider)) : null
}

function getReusedTaskApiProfile(settings: AppSettings, profileId: string | null, model: string | null): ApiProfile | null {
  if (!profileId) return null
  const profile = normalizeSettings(settings).profiles.find((item) => item.id === profileId)
  return profile ? resolveApiProfileModel(profile, model ?? undefined, getCustomProviderDefinition(settings, profile.provider)) : null
}

function getTaskApiProfileName(task: TaskRecord) {
  return task.apiProfileName || task.apiModel || '未知配置'
}

function isNetworkRecoverableError(err: unknown) {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof FetchConnectError) return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

function isApiRequestNetworkError(err: unknown): boolean {
  if (err instanceof FetchConnectError) return true
  if (err instanceof TypeError) {
    const message = err.message.toLowerCase()
    return /failed to fetch|fetch failed|load failed|networkerror|network request failed/i.test(message)
  }
  return false
}

function getApiModeApiName(apiMode: ApiMode) {
  return apiMode === 'responses' ? 'Responses API' : 'Image API'
}

function getApiRequestNetworkErrorHint(
  err: unknown,
  createdAt: number,
  usesApiProxy: boolean,
  profile?: Pick<ApiProfile, 'provider' | 'apiMode' | 'streamImages' | 'streamPartialImages'> | null,
): string | null {
  if (!isApiRequestNetworkError(err)) return null

  const elapsedSeconds = Math.max(0, (Date.now() - createdAt) / 1000)

  // 客户端的连接错误已由 Rust 侧给出具体原因，只有兜底的“无法连接到服务器”仍追加通用提示；
  // 超时、域名解析等发生在建立连接时，与网关超时无关，只有连接被重置或未响应就关闭才可能是等待较久后被网关断开
  if (err instanceof FetchConnectError && !err.message.startsWith('无法连接到服务器')) {
    if (elapsedSeconds <= 15 || !/^(连接被服务器重置|服务器未返回响应就关闭了连接)/.test(err.message)) return null
  }

  if (elapsedSeconds <= 15) {
    // 客户端忽略已保存的代理设置
    if (usesApiProxy && !isTauri) {
      return '提示：请求立即失败，请检查 API 代理服务是否正常运行。'
    }
    const unsupportedApiHint = profile?.provider === 'openai'
      ? `\n· API 不支持 ${getApiModeApiName(profile.apiMode)}`
      : ''
    // 客户端不受跨域限制，不提示跨域原因
    const corsHint = isTauri ? '' : '\n· 接口不支持浏览器跨域请求，可使用 Docker 部署版或本地运行版并配置 API 代理解决'
    return `提示：请求立即失败，可能原因：\n· API 服务器不可达或地址有误，请检查 API URL 是否正确、服务是否正常运行${unsupportedApiHint}${corsHint}`
  }

  if (elapsedSeconds >= 55 && elapsedSeconds <= 75) {
    return `提示：请求等待约 60 秒后被断开，这通常是 Nginx 等反向代理的默认超时，而非接口本身报错。可调大代理的超时时间（如 proxy_read_timeout），或降低图片尺寸/质量后重试。${getTimeoutStreamingHint(profile)}`
  }

  if (elapsedSeconds >= 110 && elapsedSeconds <= 140) {
    return `提示：请求等待约 120 秒后被断开，这通常是 Cloudflare 等 CDN/网关的超时限制，而非接口本身报错。如果使用 Cloudflare，可考虑升级套餐或使用不经过 CDN 的直连地址。${getTimeoutStreamingHint(profile)}`
  }

  return `提示：请求等待较长时间后被断开，通常是反向代理或网关的超时限制，而非接口本身报错。可检查代理超时设置，或降低图片尺寸/质量后重试。${getTimeoutStreamingHint(profile)}`
}

function getRawErrorPayload(err: unknown): Pick<Partial<TaskRecord>, 'rawImageUrls' | 'rawResponsePayload'> {
  if (!(err instanceof Error)) return {}

  const rawImageUrls = 'rawImageUrls' in err ? (err as { rawImageUrls?: unknown }).rawImageUrls : undefined
  const rawResponsePayload = 'rawResponsePayload' in err ? (err as { rawResponsePayload?: unknown }).rawResponsePayload : undefined
  return {
    rawImageUrls: Array.isArray(rawImageUrls) && rawImageUrls.length ? rawImageUrls.filter((url): url is string => typeof url === 'string') : undefined,
    rawResponsePayload: typeof rawResponsePayload === 'string' ? rawResponsePayload : undefined,
  }
}

function clearFalRecoveryTimer(taskId: string) {
  const timer = falRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  falRecoveryTimers.delete(taskId)
}

function scheduleFalRecovery(taskId: string, delayMs = FAL_RECOVERY_POLL_MS) {
  if (falRecoveryTimers.has(taskId)) return
  if (!useStore.getState().tasks.some((task) => task.id === taskId)) return
  const timer = setTimeout(() => {
    falRecoveryTimers.delete(taskId)
    recoverFalTask(taskId)
  }, delayMs)
  falRecoveryTimers.set(taskId, timer)
}

function clearCustomRecoveryTimer(taskId: string) {
  const timer = customRecoveryTimers.get(taskId)
  if (timer) clearTimeout(timer)
  customRecoveryTimers.delete(taskId)
}

function scheduleCustomRecovery(taskId: string, delayMs = CUSTOM_RECOVERY_POLL_MS) {
  if (customRecoveryTimers.has(taskId)) return
  if (!useStore.getState().tasks.some((task) => task.id === taskId)) return
  const timer = setTimeout(() => {
    customRecoveryTimers.delete(taskId)
    recoverCustomTask(taskId)
  }, delayMs)
  customRecoveryTimers.set(taskId, timer)
}

async function readImageSizeParam(dataUrl: string): Promise<Partial<TaskParams> | undefined> {
  if (typeof Image === 'undefined') return undefined

  return new Promise((resolve) => {
    let settled = false
    const image = new Image()
    const finish = (params: Partial<TaskParams> | undefined) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(params)
    }
    const timer = setTimeout(() => finish(undefined), 2000)
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
      } else {
        finish(undefined)
      }
    }
    image.onerror = () => finish(undefined)
    image.src = dataUrl
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      finish({ size: `${image.naturalWidth}x${image.naturalHeight}` })
    }
  })
}

async function readImageSizeParamsList(images: string[]): Promise<Array<Partial<TaskParams> | undefined>> {
  return Promise.all(images.map((image) => readImageSizeParam(image)))
}

async function resolveImageSizeParamsList(
  images: string[],
  preferred?: Array<Partial<TaskParams> | undefined>,
  sizes?: Array<{ width?: number; height?: number } | undefined>,
): Promise<Array<Partial<TaskParams> | undefined>> {
  const withStoredSizes = images.map((_, index) => addImageSizeParam(preferred?.[index], sizes?.[index]))
  if (withStoredSizes.every(hasActualSizeParam)) {
    return withStoredSizes
  }
  const fallback = await readImageSizeParamsList(images)
  return images.map((_, index) => {
    const params = withStoredSizes[index]
    const fallbackParams = fallback[index]
    if (hasActualSizeParam(params)) return params
    if (fallbackParams?.size) return { ...(params ?? {}), size: fallbackParams.size }
    return hasActualParams(params) ? params : fallbackParams
  })
}

async function completeRecoveredFalTask(task: TaskRecord, result: Awaited<ReturnType<typeof getFalQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return
  if (latest.status !== 'running' && !latest.falRecoverable) return

  const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
  const actualParamsList = await resolveImageSizeParamsList(outputDataUrls, result.actualParamsList, outputImageSizes)
  const latestBeforeUpdate = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latestBeforeUpdate || latestBeforeUpdate.status === 'done' || (latestBeforeUpdate.status !== 'running' && !latestBeforeUpdate.falRecoverable)) {
    await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? [])])
    return
  }

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    transparentOriginalImages: transparentOriginalImageIds,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    ...createTaskDonePatch(task, Date.now()),
    falRecoverable: false,
  })
  if (!isTaskHiddenByPrivacyMode(task)) {
    useStore.getState().showToast(`fal.ai 任务已恢复，共 ${outputIds.length} 张图片`, 'success')
    if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `fal.ai 任务已恢复，共 ${outputIds.length} 张图片。`)
  }
}

async function recoverFalTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || task.apiProvider !== 'fal' || !task.falRequestId || !task.falEndpoint || task.status === 'done') return

  const profile = getFalRecoveryProfile(settings, task)
  if (!profile) {
    scheduleFalRecovery(taskId)
    return
  }

  try {
    const result = await getFalQueuedImageResult(profile, task.falEndpoint, task.falRequestId, task.params)
    clearFalRecoveryTimer(taskId)
    await completeRecoveredFalTask(task, result)
    return
  } catch (err) {
    if (!useStore.getState().tasks.some((item) => item.id === taskId)) return
    if (isNetworkRecoverableError(err)) {
      scheduleFalRecovery(taskId)
      return
    }

    clearFalRecoveryTimer(taskId)
    const error = getFalErrorMessage(err) ?? (err instanceof Error ? err.message : String(err))
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, error, Date.now()),
      ...getRawErrorPayload(err),
      falRecoverable: false,
    })
    showTaskFailureNotification(task)
  }
}

/** 初始化：从 IndexedDB 加载任务，按需恢复输入图片，并清理孤立图片 */
export async function initStore() {
  const storedTasks = await getAllTasks()
  legacyImageIds = new Set(await getLegacyProtectedImageIds())
  for (const id of collectLegacyImageIds(useStore.getState().legacyAgentData)) legacyImageIds.add(id)
  const { tasks: markedTasks, interruptedTasks } = markInterruptedOpenAIRunningTasks(storedTasks, Date.now())
  const interruptedTaskIds = new Set(interruptedTasks.map((task) => task.id))
  const favoriteState = useStore.getState()
  const normalizedFavorites = normalizeLoadedFavoriteState(markedTasks.map(getPersistableTask), favoriteState.favoriteCollections, favoriteState.defaultFavoriteCollectionId)
  const tasks = normalizedFavorites.tasks
  if (normalizedFavorites.collections !== favoriteState.favoriteCollections) {
    favoriteState.setFavoriteCollections(normalizedFavorites.collections)
  }
  if (normalizedFavorites.defaultFavoriteCollectionId !== favoriteState.defaultFavoriteCollectionId) {
    useStore.getState().setDefaultFavoriteCollectionId(normalizedFavorites.defaultFavoriteCollectionId)
  }
  await Promise.all(tasks
    .filter((task, index) => normalizedFavorites.changed || interruptedTaskIds.has(task.id) || task.rawResponsePayload !== markedTasks[index]?.rawResponsePayload)
    .map((task) => putTask(task)))
  useStore.getState().setTasks(tasks)
  showSupportPromptForExistingLocalData(tasks)
  // 客户端关闭确认用同样的判断跳过这些任务，它们重启后会继续查询结果
  for (const task of tasks) {
    if (isFalRecoverableTask(task)) scheduleFalRecovery(task.id, 0)
    if (isCustomRecoverableTask(task)) scheduleCustomRecovery(task.id, 0)
  }

  // 收集所有任务引用的图片 id
  const referencedIds = new Set<string>()
  const state = useStore.getState()
  const persistedInputImages = state.inputImages
  const galleryInputDraft = state.galleryInputDraft
  for (const img of persistedInputImages) referencedIds.add(img.id)
  addInputDraftReferencedImageIds(referencedIds, galleryInputDraft)
  for (const id of legacyImageIds) referencedIds.add(id)
  for (const t of tasks) {
    addTaskReferencedImageIds(referencedIds, t)
  }

  // 只枚举 key 清理孤立图片，避免启动时把所有 4K 原图读进内存。
  const imageIds = await getAllImageIds()
  const referencedImageIds: string[] = []
  for (const imgId of imageIds) {
    if (referencedIds.has(imgId)) {
      referencedImageIds.push(imgId)
    } else {
      await deleteImage(imgId)
    }
  }
  const imageSourceUrls = useStore.getState().imageSourceUrls
  if (Object.keys(imageSourceUrls).some((id) => !referencedIds.has(id))) {
    useStore.setState({ imageSourceUrls: Object.fromEntries(Object.entries(imageSourceUrls).filter(([id]) => referencedIds.has(id))) })
  }
  void scheduleMissingThumbnailBackfill(referencedImageIds)
  // 网页版旧数据的原图和缩略图以 dataUrl 字符串保存，首屏加载后在后台逐条转成 Blob
  if (!isTauri) setTimeout(() => void migrateImagesToBlob(), 2_000)

  const restoredInputImages: InputImage[] = []
  for (const img of persistedInputImages) {
    if (img.dataUrl) {
      restoredInputImages.push(img)
      cacheImage(img.id, img.dataUrl)
      continue
    }
    const storedImage = await getImage(img.id)
    if (storedImage?.dataUrl) {
      restoredInputImages.push({ ...img, dataUrl: storedImage.dataUrl })
      cacheImage(img.id, storedImage.dataUrl)
    }
  }
  if (restoredInputImages.length !== persistedInputImages.length || restoredInputImages.some((img, index) => img.dataUrl !== persistedInputImages[index]?.dataUrl)) {
    useStore.getState().setInputImages(restoredInputImages)
  }

  if (galleryInputDraft) {
    const restoredGalleryImages: InputImage[] = []
    for (const img of galleryInputDraft.inputImages) {
      if (img.dataUrl) {
        restoredGalleryImages.push(img)
        cacheImage(img.id, img.dataUrl)
        continue
      }
      const storedImage = await getImage(img.id)
      if (storedImage?.dataUrl) {
        restoredGalleryImages.push({ ...img, dataUrl: storedImage.dataUrl })
        cacheImage(img.id, storedImage.dataUrl)
      }
    }
    const restoredGalleryDraft: InputDraft = {
      ...galleryInputDraft,
      ...updateInputDraftImages(galleryInputDraft, restoredGalleryImages),
    }
    const shouldClearMask = galleryInputDraft.maskDraft !== restoredGalleryDraft.maskDraft
    const galleryDraftsChanged =
      restoredGalleryImages.length !== galleryInputDraft.inputImages.length ||
      restoredGalleryImages.some((img, index) => img.dataUrl !== galleryInputDraft.inputImages[index]?.dataUrl) ||
      shouldClearMask
    if (galleryDraftsChanged) {
      const latestState = useStore.getState()
      const nextGalleryInputDraft = isEmptyInputDraft(restoredGalleryDraft) ? null : restoredGalleryDraft
      useStore.setState({
        galleryInputDraft: nextGalleryInputDraft,
        ...(latestState.appMode === 'gallery'
          ? restoreGalleryInputDraftState(nextGalleryInputDraft)
          : {}),
      })
    }
  }

}

/** 命令行直接给出的提示词和参考图：提交时不读写输入区、遮罩和复用配置状态；多条提示词按批量提交 */
export interface SubmitInput {
  prompts: string[]
  inputImages: InputImage[]
}

/** 提交新任务，返回已开始的任务 id；批量提交时等全部任务结束后才返回 */
export async function submitTask(options: { allowFullMask?: boolean; useCurrentApiProfileWhenReusedMissing?: boolean; input?: SubmitInput } = {}): Promise<string[]> {
  const state = useStore.getState()
  const { settings, params, showToast, setConfirmDialog } = state
  const input = options.input
  const prompt = input ? input.prompts[0] ?? '' : state.prompt
  const inputImages = input?.inputImages ?? state.inputImages
  const maskDraft = input ? null : state.maskDraft
  const { reusedTaskApiProfileId, reusedTaskApiProfileName, reusedTaskApiProfileMissing, reusedTaskApiModel } = input
    ? { reusedTaskApiProfileId: null, reusedTaskApiProfileName: null, reusedTaskApiProfileMissing: false, reusedTaskApiModel: null }
    : state

  const normalizedSettings = normalizeSettings(settings)
  let activeProfile = getActiveApiProfile(settings)
  let requestSettings = createSettingsForApiProfile(normalizedSettings, activeProfile)
  if (normalizedSettings.reuseTaskApiProfileTemporarily && (reusedTaskApiProfileId || reusedTaskApiProfileMissing)) {
    const reusedProfile = getReusedTaskApiProfile(normalizedSettings, reusedTaskApiProfileId, reusedTaskApiModel)
    if (!reusedProfile) {
      if (options.useCurrentApiProfileWhenReusedMissing) {
        useStore.getState().setReusedTaskApiProfile(null)
      } else {
        setConfirmDialog({
          title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${reusedTaskApiProfileName || '未知配置'}」，要使用当前的 API 配置「${activeProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ ...options, useCurrentApiProfileWhenReusedMissing: true })
      },
        })
        return []
      }
    } else {
      activeProfile = reusedProfile
      requestSettings = createSettingsForApiProfile(normalizedSettings, reusedProfile)
    }
  }

  if (validateApiProfile(activeProfile)) {
    showToast(`请先完善请求 API 配置：${validateApiProfile(activeProfile)}`, 'error')
    useStore.getState().setShowSettings(true)
    return []
  }

  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return []
  }

  const normalizedParams = normalizeParamsForSettings(params, requestSettings, { hasInputImages: inputImages.length > 0 })
  // 编辑接口不接受 SVG 参数；GIF 实测在编辑时也能正常生成
  if (inputImages.length > 0 && normalizedParams.output_format === 'svg') {
    showToast('SVG 只能用于文生图，请移除参考图或切换输出格式', 'error')
    return []
  }

  const batchPrompts = input && input.prompts.length > 1
    ? input.prompts
    : normalizedSettings.showBatchPrompt && normalizedSettings.batchPromptEnabled ? splitBatchPrompts(prompt) : []
  if (useStore.getState().batchProgress) {
    showToast('批量任务进行中，请等待完成或停止后再提交', 'error')
    return []
  }
  // 检查通过后立即占位，避免后续 await 期间重复提交启动第二批
  const batchId = batchPrompts.length ? beginBatch(batchPrompts.length) : 0

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: '确认编辑整张图片？',
          message: '当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？',
          confirmText: '继续提交',
          tone: 'warning',
          action: () => {
            void submitTask({ allowFullMask: true })
          },
        })
        endBatch(batchId)
        return []
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      cacheImage(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      endBatch(batchId)
      return []
    }
  }

  // 持久化输入图片到 IndexedDB（此前只在内存缓存中）
  let taskInputImages = orderedInputImages
  try {
    taskInputImages = await persistTaskInputImages(orderedInputImages, true)
  } catch (err) {
    console.error('保存参考图失败', err)
    endBatch(batchId)
    showToast(`保存参考图失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    return []
  }

  const shouldUseTransparentOutput = normalizedParams.transparent_output && supportsTransparentOutput(requestSettings, activeProfile, normalizedParams.output_format)
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const normalizedParamPatch = getChangedParams(params, taskParams)
  if (Object.keys(normalizedParamPatch).length) {
    useStore.getState().setParams(normalizedParamPatch)
  }

  // 命令行提交与当前界面无关，不加入收藏夹
  const saveToFavorite = !input && normalizedSettings.saveTasksToActiveFavoriteCollection
  const taskIds: string[] = []
  const startTask = async (taskPrompt: string) => {
    // 按点击提交时所在的收藏夹页决定；创建时该收藏夹已被删除则加入默认收藏夹
    const favoritePatch = saveToFavorite
      ? getNewTaskFavoritePatch({
        filterFavorite: state.filterFavorite,
        activeFavoriteCollectionId: state.activeFavoriteCollectionId,
        favoriteCollections: useStore.getState().favoriteCollections,
        defaultFavoriteCollectionId: useStore.getState().defaultFavoriteCollectionId,
      })
      : null
    // SVG 和 GIF 无法本地抠图，只能使用接口原生透明背景
    const transparentMeta = taskParams.transparent_output && activeProfile.transparentBackgroundMethod === 'local' && !isVectorOrAnimatedFormat(taskParams.output_format)
      ? createTransparentOutputMeta(taskPrompt)
      : null
    const task: TaskRecord = {
      id: genId(),
      prompt: taskPrompt,
      params: taskParams,
      paramSupport: getTaskParamSupport(requestSettings, activeProfile),
      apiProvider: activeProfile.provider,
      apiProfileId: activeProfile.id,
      apiProfileName: activeProfile.name,
      apiMode: activeProfile.apiMode,
      apiModel: activeProfile.model,
      inputImageIds: taskInputImages.map((i) => i.id),
      maskTargetImageId,
      maskImageId,
      markupImageId: taskInputImages[0]?.markupImageId ?? null,
      transparentOutput: transparentMeta?.transparentOutput,
      transparentPrompt: transparentMeta?.effectivePrompt,
      outputImages: [],
      status: 'running',
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      elapsed: null,
      ...favoritePatch,
    }

    useStore.getState().setTasks([task, ...useStore.getState().tasks])
    await putTask(task)
    if (batchId) batchTaskIds.add(task.id)
    taskIds.push(task.id)
    // 异步调用 API
    executeTask(task.id)
    return task.id
  }

  if (batchPrompts.length) {
    useStore.getState().showToast(`已开始批量提交 ${batchPrompts.length} 条提示词`, 'success')
  } else {
    await startTask(prompt.trim())
    useStore.getState().showToast('任务已提交', 'success')
  }

  if (!input) {
    if (settings.clearInputAfterSubmit) {
      useStore.getState().setPrompt('')
      useStore.getState().clearInputImages()
    }
    useStore.getState().setReusedTaskApiProfile(null)
  }

  if (batchPrompts.length) {
    const limit = normalizedSettings.batchPromptMode === 'queue'
      ? 1
      : normalizedSettings.batchPromptConcurrencyLimited ? normalizedSettings.batchPromptConcurrency : batchPrompts.length
    await runBatchPrompts(batchId, batchPrompts, limit, startTask)
  }
  return taskIds
}

// 当前批量的标识，停止或结束时递增使旧批量失效；批量任务不单独弹出完成提示和失败详情
let activeBatchId = 0
const batchTaskIds = new Set<string>()

function beginBatch(total: number) {
  activeBatchId += 1
  useStore.getState().setBatchProgress({ total, started: 0, finished: 0 })
  return activeBatchId
}

function endBatch(batchId: number) {
  if (!batchId || batchId !== activeBatchId) return
  activeBatchId += 1
  // 停止后仍在运行的任务恢复单独的完成提示和失败详情
  batchTaskIds.clear()
  useStore.getState().setBatchProgress(null)
}

/** 等待任务结束（完成、失败或被删除）或批量被停止；断线待恢复的任务也视为结束，避免卡住队列 */
export function waitForTaskSettled(taskId: string, isCancelled: () => boolean) {
  const isSettled = (tasks: TaskRecord[]) => isCancelled() || tasks.find((item) => item.id === taskId)?.status !== 'running'
  return new Promise<void>((resolve) => {
    if (isSettled(useStore.getState().tasks)) {
      resolve()
      return
    }
    const unsubscribe = useStore.subscribe((state) => {
      if (!isSettled(state.tasks)) return
      unsubscribe()
      resolve()
    })
  })
}

async function runBatchPrompts(batchId: number, prompts: string[], limit: number, startTask: (taskPrompt: string) => Promise<string>) {
  const isStopped = () => batchId !== activeBatchId
  const total = prompts.length
  let started = 0
  let finished = 0
  let failed = 0
  await runWithConcurrency(prompts, limit, async (taskPrompt) => {
    started += 1
    useStore.getState().setBatchProgress({ total, started, finished })
    try {
      const taskId = await startTask(taskPrompt)
      await waitForTaskSettled(taskId, isStopped)
      if (useStore.getState().tasks.find((item) => item.id === taskId)?.status === 'error') failed += 1
    } catch (err) {
      failed += 1
      console.error('批量提交任务失败', err)
    }
    finished += 1
    if (!isStopped()) useStore.getState().setBatchProgress({ total, started, finished })
  }, isStopped)
  if (isStopped()) return

  endBatch(batchId)
  const message = failed > 0 ? `批量生成完成：成功 ${total - failed} 条，失败 ${failed} 条` : `批量生成完成，共 ${total} 条`
  useStore.getState().showToast(message, failed > 0 ? 'error' : 'success')
  showTaskCompletionNotification('批量生成完成', `${message}。`)
}

/** 停止批量提交：立即结束批量状态，不再启动剩余提示词，已开始的任务继续执行 */
export function stopBatchPrompts() {
  const progress = useStore.getState().batchProgress
  if (!progress) return
  endBatch(activeBatchId)
  useStore.getState().showToast(`已停止批量提交，共提交 ${progress.started} / ${progress.total} 条，已开始的任务会继续完成`, 'info')
}

function addInputImageReferencedIds(target: Set<string>, img: InputImage) {
  target.add(img.id)
  if (img.markupImageId) target.add(img.markupImageId)
}

function addInputDraftReferencedImageIds(target: Set<string>, draft: InputDraft | null) {
  if (!draft) return
  for (const img of draft.inputImages) addInputImageReferencedIds(target, img)
}

function addTaskReferencedImageIds(target: Set<string>, task: TaskRecord) {
  for (const id of task.inputImageIds || []) target.add(id)
  if (task.maskImageId) target.add(task.maskImageId)
  if (task.markupImageId) target.add(task.markupImageId)
  for (const id of task.outputImages || []) target.add(id)
  for (const id of task.transparentOriginalImages || []) {
    if (id) target.add(id)
  }
  for (const id of task.streamPartialImageIds || []) target.add(id)
}

async function storeTaskOutputImages(task: TaskRecord, images: string[]) {
  const outputIds: string[] = []
  const outputDataUrls: string[] = []
  const outputImageSizes: Array<{ width?: number; height?: number }> = []
  const transparentOriginalImageIds: string[] = []
  const storedImageIds: string[] = []

  try {
    for (const dataUrl of images) {
      let outputDataUrl = dataUrl
      if (task.transparentOutput) {
        const original = await storeImageWithSize(dataUrl, 'generated')
        storedImageIds.push(original.id)
        cacheImage(original.id, dataUrl)

        try {
          outputDataUrl = task.params.output_format === 'webp'
            ? await removeKeyedBackgroundFromDataUrl(dataUrl, undefined, 'webp', task.params.output_compression)
            : await removeKeyedBackgroundFromDataUrl(dataUrl)
          transparentOriginalImageIds.push(original.id)
        } catch (err) {
          console.warn('透明背景后处理失败，已回退为原始输出', err)
          outputIds.push(original.id)
          outputDataUrls.push(dataUrl)
          outputImageSizes.push(original)
          transparentOriginalImageIds.push('')
          continue
        }
      }

      const stored = await storeImageWithSize(outputDataUrl, 'generated')
      storedImageIds.push(stored.id)
      cacheImage(stored.id, outputDataUrl)
      outputIds.push(stored.id)
      outputDataUrls.push(outputDataUrl)
      outputImageSizes.push(stored)
    }

    return {
      outputIds,
      outputDataUrls,
      outputImageSizes,
      transparentOriginalImageIds: transparentOriginalImageIds.length ? transparentOriginalImageIds : undefined,
    }
  } catch (err) {
    await deleteUnreferencedImageIds(storedImageIds)
    throw err
  }
}

async function deleteUnreferencedImageIds(imageIds: Iterable<string>) {
  const candidates = Array.from(new Set(Array.from(imageIds).filter(Boolean)))
  if (candidates.length === 0) return

  const { tasks, inputImages, galleryInputDraft, privacyMode } = useStore.getState()
  const stillUsed = new Set<string>(getPrivacySnapshotImageIds(privacyMode))
  for (const task of tasks) addTaskReferencedImageIds(stillUsed, task)
  addInputDraftReferencedImageIds(stillUsed, galleryInputDraft)
  for (const img of inputImages) addInputImageReferencedIds(stillUsed, img)

  for (const imgId of candidates) {
    if (stillUsed.has(imgId)) continue
    await deleteStoredImageIfUnreferenced(imgId)
  }
}

async function persistTaskStreamPartialImage(taskId: string, dataUrl: string, execution?: symbol) {
  try {
    const imgId = await storeImage(dataUrl, 'generated')
    cacheImage(imgId, dataUrl)

    const latestTask = useStore.getState().tasks.find((task) => task.id === taskId)
    if (!latestTask || latestTask.status === 'done' || (execution && taskExecutions.get(taskId) !== execution)) {
      await deleteUnreferencedImageIds([imgId])
      return
    }

    const currentIds = latestTask.streamPartialImageIds || []
    if (currentIds.includes(imgId)) return
    updateTaskInStore(taskId, { streamPartialImageIds: [...currentIds, imgId] })
  } catch (err) {
    console.error(err)
  }
}

async function executeTask(taskId: string) {
  const { settings } = useStore.getState()
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return
  const execution = Symbol(taskId)
  taskExecutions.set(taskId, execution)
  const taskProfile = getTaskApiProfile(settings, task)
  if (!taskProfile && task.apiProfileId) {
    const error = '找不到此任务所使用的 API 配置。'
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, error, Date.now()),
      falRecoverable: false,
      customRecoverable: false,
    })
    showTaskFailureNotification(task)
    taskExecutions.delete(taskId)
    return
  }
  const activeProfile = taskProfile ?? getActiveApiProfile(settings)
  const requestSettings = createSettingsForApiProfile(settings, activeProfile)
  const taskProvider = taskProfile?.provider ?? task.apiProvider ?? activeProfile.provider
  let falRequestInfo: { requestId: string; endpoint: string } | null = task.falRequestId && task.falEndpoint
        ? { requestId: task.falRequestId, endpoint: task.falEndpoint }
    : null
  let customTaskInfo: { taskId: string } | null = task.customTaskId
    ? { taskId: task.customTaskId }
    : null

  if (
    taskProvider !== 'fal' &&
    !isAsyncCustomProviderTask(requestSettings, activeProfile, task.inputImageIds.length > 0) &&
    !usesConcurrentImageRequests(requestSettings, activeProfile, task.params, task.inputImageIds.length > 0)
  ) {
    scheduleOpenAIWatchdog(taskId, activeProfile.timeout, activeProfile)
  }

  try {
    // 获取输入图片 data URLs
    const inputDataUrls: string[] = []
    for (const imgId of task.inputImageIds) {
      const dataUrl = await ensureImageCached(imgId)
      if (!dataUrl) throw new Error('输入图片已不存在')
      inputDataUrls.push(dataUrl)
    }
    let maskDataUrl: string | undefined
    if (task.maskImageId) {
      maskDataUrl = await ensureImageCached(task.maskImageId)
      if (!maskDataUrl) throw new Error('遮罩图片已不存在')
    }
    const markupDataUrl = task.markupImageId ? await ensureImageCached(task.markupImageId) : undefined
    if (task.markupImageId && !markupDataUrl) throw new Error('标注图片已不存在')

    const requestPrompt = task.transparentOutput && task.transparentPrompt
      ? task.transparentPrompt
      : task.prompt

    const result = await callImageApi({
      settings: requestSettings,
      prompt: replaceImageMentionsForApi(requestPrompt, inputDataUrls.length),
      params: task.params,
      nativeTransparentBackground: task.params.transparent_output && !task.transparentOutput,
      inputImageDataUrls: inputDataUrls,
      inputImageUrls: task.inputImageIds.map((id) => useStore.getState().imageSourceUrls[id] ?? null),
      maskDataUrl,
      markupDataUrl,
      skipCodexCliSizePrompt: task.sourceMode === 'agent',
      onPromptHintsPrepared: (promptHints) => {
        if (taskExecutions.get(taskId) !== execution) return
        updateTaskInStore(taskId, { promptHints })
      },
      onFalRequestEnqueued: (request) => {
        if (taskExecutions.get(taskId) !== execution) return
        falRequestInfo = request
        updateTaskInStore(taskId, {
          falRequestId: request.requestId,
          falEndpoint: request.endpoint,
          falRecoverable: false,
        })
      },
      onCustomTaskEnqueued: (request) => {
        if (taskExecutions.get(taskId) !== execution) return
        customTaskInfo = request
        updateTaskInStore(taskId, {
          customTaskId: request.taskId,
          customRecoverable: false,
        })
      },
      onPartialImage: (partial) => {
        if (taskExecutions.get(taskId) !== execution) return
        useStore.getState().setTaskStreamPreview(taskId, partial.image, partial.requestIndex)
        void persistTaskStreamPartialImage(taskId, partial.image, execution)
      },
    })

    const latestBeforeSuccess = useStore.getState().tasks.find((t) => t.id === taskId)
    if (taskExecutions.get(taskId) !== execution) return
    if (!latestBeforeSuccess || latestBeforeSuccess.status !== 'running') {
      useStore.getState().setTaskStreamPreview(taskId)
      return
    }

    // 存储输出图片
    const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
    const isAsyncCustomTask = taskProvider !== 'fal' && taskProvider !== 'openai' && Boolean(customTaskInfo)
    const actualParamsList = await resolveImageSizeParamsList(
      outputDataUrls,
      isAsyncCustomTask ? undefined : result.actualParamsList,
      outputImageSizes,
    )
    const actualParams = deriveGalleryActualParams(taskProvider, isAsyncCustomTask, result.actualParams, actualParamsList, outputIds.length)
    const shouldStoreRevisedPrompts = taskProvider !== 'fal' && !isAsyncCustomTask
    const actualParamsByImage = mapActualParamsByImage(outputIds, actualParamsList)
    const revisedPrompts = activeProfile.codexCli && task.sourceMode !== 'agent'
      ? result.revisedPrompts?.map((prompt) => prompt == null ? prompt : stripInjectedCodexCliSizePrompt(prompt, requestPrompt, task.params.size))
      : result.revisedPrompts
    const revisedPromptByImage = shouldStoreRevisedPrompts ? mapRevisedPromptsByImage(outputIds, revisedPrompts) : undefined
    const promptWasRevised = shouldStoreRevisedPrompts && revisedPrompts?.some(
      (revisedPrompt) => revisedPrompt?.trim() && revisedPrompt.trim() !== requestPrompt.trim(),
    )
    const hasRevisedPromptValue = shouldStoreRevisedPrompts && revisedPrompts?.some((revisedPrompt) => revisedPrompt?.trim())
    if (taskExecutions.get(taskId) === execution && taskProvider === 'openai' && activeProfile.apiMode === 'responses' && !activeProfile.codexCli) {
      if (promptWasRevised) {
        showCodexCliPrompt()
      } else if (!hasRevisedPromptValue) {
        showCodexCliPrompt(false, '接口没有返回官方 API 会返回的部分信息')
      }
    }

    // 更新任务
    const latestBeforeUpdate = useStore.getState().tasks.find((t) => t.id === taskId)
    if (taskExecutions.get(taskId) !== execution || !latestBeforeUpdate || latestBeforeUpdate.status !== 'running') {
      if (taskExecutions.get(taskId) === execution) useStore.getState().setTaskStreamPreview(taskId)
      await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? [])])
      return
    }
    const partialImageIdsToClean = latestBeforeUpdate.streamPartialImageIds || []
    clearOpenAIWatchdogTimer(taskId)
    useStore.getState().setTaskStreamPreview(taskId)
    updateTaskInStore(taskId, {
      outputImages: outputIds,
      transparentOriginalImages: transparentOriginalImageIds,
      outputErrors: result.failedRequests?.length ? result.failedRequests : undefined,
      streamPartialImageIds: undefined,
      rawImageUrls: result.rawImageUrls?.length ? result.rawImageUrls : undefined,
      searchGrounding: result.searchGrounding,
      actualParams,
      actualParamsByImage,
      revisedPromptByImage,
      ...createTaskDonePatch(task, Date.now()),
      falRecoverable: false,
      customRecoverable: false,
    })
    void deleteUnreferencedImageIds(partialImageIdsToClean)

    const failedCount = result.failedRequests?.length ?? 0
    const completionMessage = failedCount > 0
      ? `生成完成：成功 ${outputIds.length} 张，失败 ${failedCount} 张`
      : `生成完成，共 ${outputIds.length} 张图片`
    // 批量任务只在整批结束时统一提示
    if (!batchTaskIds.has(taskId) && !isTaskHiddenByPrivacyMode(task)) {
      useStore.getState().showToast(completionMessage, failedCount > 0 ? 'error' : 'success')
      if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `${completionMessage}。`)
    }
    const currentMask = useStore.getState().maskDraft
    if (
      maskDataUrl &&
      currentMask &&
      currentMask.targetImageId === task.maskTargetImageId &&
      currentMask.maskDataUrl === maskDataUrl
    ) {
      useStore.getState().clearMaskDraft()
    }
  } catch (err) {
    if (taskExecutions.get(taskId) !== execution) return
    clearOpenAIWatchdogTimer(taskId)
    const latestTask = useStore.getState().tasks.find((t) => t.id === taskId)
    if (!latestTask || latestTask.status !== 'running') return
    useStore.getState().setTaskStreamPreview(taskId)
    const latestFalRequestInfo = falRequestInfo ?? (latestTask.falRequestId && latestTask.falEndpoint
      ? { requestId: latestTask.falRequestId, endpoint: latestTask.falEndpoint }
      : null)
    const latestCustomTaskInfo = customTaskInfo ?? (latestTask.customTaskId ? { taskId: latestTask.customTaskId } : null)
    if (latestTask.apiProvider === 'fal' && latestFalRequestInfo && isNetworkRecoverableError(err)) {
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, '与 fal.ai 的连接已断开，之后会继续查询任务结果。', Date.now()),
        falRequestId: latestFalRequestInfo.requestId,
        falEndpoint: latestFalRequestInfo.endpoint,
        falRecoverable: true,
      })
      scheduleFalRecovery(taskId)
    } else if (latestCustomTaskInfo && isNetworkRecoverableError(err)) {
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, '与自定义异步任务的连接已断开，之后会继续查询任务结果。', Date.now()),
        customTaskId: latestCustomTaskInfo.taskId,
        customRecoverable: true,
      })
      scheduleCustomRecovery(taskId)
    } else {
      let errorMessage = err instanceof Error ? err.message : String(err)
      const settings = useStore.getState().settings
      const profile = getTaskApiProfile(settings, latestTask)
      const usesApiProxy = profile?.apiProxy ?? settings.apiProxy
      const activeProfile = getActiveApiProfile(settings)
      const hintProfile = profile ?? {
        provider: latestTask.apiProvider ?? activeProfile.provider,
        apiMode: settings.apiMode,
        streamImages: activeProfile.streamImages,
        streamPartialImages: activeProfile.streamPartialImages,
      }
      const networkErrorHint = getApiRequestNetworkErrorHint(err, latestTask.startedAt ?? latestTask.createdAt, usesApiProxy, hintProfile)
      if (networkErrorHint && !errorMessage.includes(IMAGE_FETCH_CORS_HINT)) {
        errorMessage += `\n${networkErrorHint}`
      }
      updateTaskInStore(taskId, {
        ...createTaskErrorPatch(task, errorMessage, Date.now()),
        ...getRawErrorPayload(err),
        falRecoverable: false,
        customRecoverable: false,
      })
      // 批量任务不自动打开失败详情，避免连续弹窗打断
      if (!batchTaskIds.has(taskId) && !isTaskHiddenByPrivacyMode(task)) useStore.getState().setDetailTaskId(taskId)
      showTaskFailureNotification(task)
    }
  } finally {
    if (taskExecutions.get(taskId) === execution) taskExecutions.delete(taskId)
    // 释放输入图片的内存缓存（已持久化到 IndexedDB，后续按需从 DB 加载）
    if (!taskExecutions.has(taskId)) {
      for (const imgId of task.inputImageIds) deleteCachedImage(imgId)
    }
  }
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks, defaultFavoriteCollectionId } = useStore.getState()
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...normalizeFavoritePatch(t, patch, defaultFavoriteCollectionId) } : t,
  )
  const task = updated.find((t) => t.id === taskId)
  setTasks(updated)
  maybeOpenSupportPrompt(tasks, updated, taskId)
  if (task) putTask(task)
}

export function createFavoriteCollection(name: string) {
  const normalizedName = normalizeFavoriteCollectionName(name)
  if (!normalizedName) return null
  if (Array.from(normalizedName).length > 60) {
    useStore.getState().showToast('收藏夹名称最多 60 个字符', 'error')
    return null
  }
  const state = useStore.getState()
  const existing = state.favoriteCollections.find((collection) => collection.name === normalizedName)
  if (existing) return existing
  const now = Date.now()
  const collection: FavoriteCollection = { id: genId(), name: normalizedName, createdAt: now, updatedAt: now }
  state.setFavoriteCollections([...state.favoriteCollections, collection])
  state.showToast(`已创建收藏夹「${normalizedName}」`, 'success')
  return collection
}

export function renameFavoriteCollection(collectionId: string, name: string) {
  const normalizedName = normalizeFavoriteCollectionName(name)
  if (!normalizedName || collectionId === ALL_FAVORITES_COLLECTION_ID) return
  if (Array.from(normalizedName).length > 60) {
    useStore.getState().showToast('收藏夹名称最多 60 个字符', 'error')
    return
  }
  const { favoriteCollections, setFavoriteCollections, showToast } = useStore.getState()
  setFavoriteCollections(favoriteCollections.map((collection) =>
    collection.id === collectionId ? { ...collection, name: normalizedName, updatedAt: Date.now() } : collection,
  ))
  showToast('收藏夹名称已更新', 'success')
}

export async function updateTasksFavoriteCollections(taskIds: string[], collectionIds: string[]) {
  const ids = normalizeFavoriteCollectionIds(collectionIds)
  const uniqueTaskIds = Array.from(new Set(taskIds)).filter(Boolean)
  if (!uniqueTaskIds.length) return
  const { tasks, setTasks, clearSelection, showToast, defaultFavoriteCollectionId } = useStore.getState()
  const idSet = new Set(uniqueTaskIds)
  const changedTaskIds = new Set<string>()
  const updated = tasks.map((task) => {
    if (!idSet.has(task.id)) return task
    if (sameFavoriteCollectionIds(getTaskFavoriteCollectionIds(task, defaultFavoriteCollectionId), ids)) return task
    changedTaskIds.add(task.id)
    return { ...task, favoriteCollectionIds: ids, isFavorite: ids.length > 0 }
  })
  if (!changedTaskIds.size) {
    clearSelection()
    return
  }
  setTasks(updated)
  await Promise.all(updated.filter((task) => changedTaskIds.has(task.id)).map((task) => putTask(task)))
  clearSelection()
  showToast(ids.length ? '收藏夹已更新' : '已取消收藏', 'success')
}

export async function deleteFavoriteCollection(collectionId: string, deleteTasks = false) {
  const state = useStore.getState()
  const collection = state.favoriteCollections.find((item) => item.id === collectionId)
  const result = deleteFavoriteCollectionState({
    collections: state.favoriteCollections,
    defaultFavoriteCollectionId: state.defaultFavoriteCollectionId,
    activeFavoriteCollectionId: state.activeFavoriteCollectionId,
    selectedFavoriteCollectionIds: state.selectedFavoriteCollectionIds,
    selectedTaskIds: state.selectedTaskIds,
    tasks: state.tasks,
    collectionId,
    deleteTasks,
  })
  if (!collection || !result) return

  useStore.setState({
    favoriteCollections: result.collections,
    defaultFavoriteCollectionId: result.defaultFavoriteCollectionId,
    activeFavoriteCollectionId: result.activeFavoriteCollectionId,
    selectedFavoriteCollectionIds: result.selectedFavoriteCollectionIds,
    selectedTaskIds: result.selectedTaskIds,
  })
  if (result.updatedTasks.length) {
    const patches = new Map(result.updatedTasks.map((task) => [task.id, task]))
    const updated = useStore.getState().tasks.map((task) => {
      const patch = patches.get(task.id)
      return patch ? { ...task, favoriteCollectionIds: patch.favoriteCollectionIds, isFavorite: patch.isFavorite } : task
    })
    useStore.getState().setTasks(updated)
    await Promise.all(updated.filter((task) => patches.has(task.id)).map((task) => putTask(task)))
  }
  if (result.taskIdsToDelete.length) await removeMultipleTasks(result.taskIdsToDelete)
  useStore.getState().showToast(`已删除收藏夹「${collection.name}」`, 'success')
}

/** 按重试方式新建任务或覆盖原任务；Agent 对话中的任务始终新建 */
export async function retryTask(task: TaskRecord) {
  const state = useStore.getState()
  const { settings, tasks } = state
  const source = tasks.find((item) => item.id === task.id)
  if (!source || source.status === 'running' || source.falRecoverable || source.customRecoverable) return
  const activeProfile = getActiveApiProfile(settings)
  const normalizedParams = normalizeParamsForSettings(source.params, settings, { hasInputImages: source.inputImageIds.length > 0 })
  const shouldUseTransparentOutput = normalizedParams.transparent_output && supportsTransparentOutput(settings, activeProfile, normalizedParams.output_format)
  const taskParams = shouldUseTransparentOutput
    ? getTransparentRequestParams(normalizedParams)
    : { ...normalizedParams, transparent_output: false }
  const transparentMeta = taskParams.transparent_output && activeProfile.transparentBackgroundMethod === 'local' && !isVectorOrAnimatedFormat(taskParams.output_format)
    ? createTransparentOutputMeta(source.prompt.trim())
    : null
  const overwrite = !isAgentTask(source) && (
    settings.retryMode === 'overwriteAll' || (settings.retryMode === 'overwriteFailed' && source.status === 'error')
  )
  const taskId = overwrite ? source.id : genId()
  const startedAt = Date.now()
  const favoritePatch = !overwrite && settings.saveTasksToActiveFavoriteCollection && state.appMode === 'gallery'
    ? getNewTaskFavoritePatch(state, getTaskFavoriteCollectionIds(source, state.defaultFavoriteCollectionId))
    : null
  const newTask: TaskRecord = {
    ...(overwrite ? source : {}),
    ...favoritePatch,
    id: taskId,
    prompt: source.prompt,
    params: taskParams,
    paramSupport: getTaskParamSupport(settings, activeProfile),
    apiProvider: activeProfile.provider,
    apiProfileId: activeProfile.id,
    apiProfileName: activeProfile.name,
    apiMode: activeProfile.apiMode,
    apiModel: activeProfile.model,
    inputImageIds: [...source.inputImageIds],
    maskTargetImageId: source.maskTargetImageId ?? null,
    maskImageId: source.maskImageId ?? null,
    markupImageId: source.markupImageId ?? null,
    transparentOutput: transparentMeta?.transparentOutput,
    transparentPrompt: transparentMeta?.effectivePrompt,
    outputImages: [],
    outputErrors: undefined,
    transparentOriginalImages: undefined,
    actualParams: undefined,
    actualParamsByImage: undefined,
    revisedPromptByImage: undefined,
    rawImageUrls: undefined,
    searchGrounding: undefined,
    promptHints: undefined,
    rawResponsePayload: undefined,
    streamPartialImageIds: undefined,
    falRequestId: undefined,
    falEndpoint: undefined,
    falRecoverable: false,
    customTaskId: undefined,
    customRecoverable: false,
    status: 'running',
    error: null,
    createdAt: overwrite ? source.createdAt : startedAt,
    startedAt,
    finishedAt: null,
    elapsed: null,
  }

  if (overwrite) {
    taskExecutions.delete(taskId)
    // 覆盖后不再属于原批量，完成时应正常提示
    batchTaskIds.delete(taskId)
    clearOpenAIWatchdogTimer(taskId)
    clearFalRecoveryTimer(taskId)
    clearCustomRecoveryTimer(taskId)
    useStore.getState().setTaskStreamPreview(taskId)
  }
  useStore.getState().setTasks(overwrite
    ? tasks.map((item) => item.id === taskId ? newTask : item)
    : [newTask, ...tasks])
  await putTask(newTask)
  if (overwrite) {
    void deleteUnreferencedImageIds([
      ...source.outputImages,
      ...(source.transparentOriginalImages ?? []),
      ...(source.streamPartialImageIds ?? []),
    ])
  }

  executeTask(taskId)
}

/** 复用配置 */
export async function reuseConfig(task: TaskRecord) {
  const { settings, setPrompt, setParams, setInputImages, setMaskDraft, clearMaskDraft, showToast, setConfirmDialog, setReusedTaskApiProfile } = useStore.getState()
  const normalizedSettings = normalizeSettings(settings)
  const currentProfile = getActiveApiProfile(settings)
  const taskProfile = normalizedSettings.reuseTaskApiProfileTemporarily ? getTaskApiProfile(normalizedSettings, task) : null
  const matchedProfile = taskProfile && (!isPresetConfigOnlyEnabled() || isPresetProfile(taskProfile.id)) ? taskProfile : null
  const shouldTemporarilyReuseProfile = Boolean(matchedProfile && matchedProfile.id !== currentProfile.id)
  const missingReusedProfile = normalizedSettings.reuseTaskApiProfileTemporarily && !matchedProfile
  const taskProfileName = matchedProfile?.name ?? getTaskApiProfileName(task)
  // 复用当前配置时，任务所用模型仍在模型列表中则同步切换首页选中的模型；临时复用其他配置时模型只随复用状态生效
  const currentProfileRecord = normalizedSettings.profiles.find((item) => item.id === currentProfile.id)
  if (!shouldTemporarilyReuseProfile && task.apiModel && currentProfileRecord && currentProfileRecord.selectedModel !== task.apiModel && splitModelList(currentProfileRecord.model).includes(task.apiModel)) {
    useStore.getState().setSettings({
      profiles: normalizedSettings.profiles.map((item) => item.id === currentProfile.id ? { ...item, selectedModel: task.apiModel } : item),
    })
  }
  const reuseSettings = normalizeSettings(useStore.getState().settings)
  const paramsSettings = shouldTemporarilyReuseProfile && matchedProfile ? createSettingsForApiProfile(reuseSettings, matchedProfile) : reuseSettings

  setParams(normalizeParamsForSettings(task.params, paramsSettings, { hasInputImages: task.inputImageIds.length > 0 }))
  setReusedTaskApiProfile(
    shouldTemporarilyReuseProfile && matchedProfile ? matchedProfile.id : null,
    missingReusedProfile,
    taskProfileName,
    shouldTemporarilyReuseProfile && matchedProfile ? matchedProfile.model : null,
  )
  clearMaskDraft()

  // 恢复输入图片
  const imgs: InputImage[] = []
  for (const [idx, imgId] of task.inputImageIds.entries()) {
    const dataUrl = await ensureImageCached(imgId)
    if (!dataUrl) continue
    // 标注层始终属于第一张参考图
    const markupImageId = idx === 0 && task.markupImageId && await ensureImageCached(task.markupImageId) ? task.markupImageId : undefined
    imgs.push(markupImageId ? { id: imgId, dataUrl, markupImageId } : { id: imgId, dataUrl })
  }
  setInputImages(imgs)
  // 部分参考图可能已被删除，按图片 id 重新对齐提示词中的图片序号，避免评论和提及错位到其他图片
  setPrompt(remapImageMentionsForOrder(task.prompt, task.inputImageIds.map((id) => ({ id, dataUrl: '' })), useStore.getState().inputImages))
  const maskTargetImageId = task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && imgs.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await ensureImageCached(task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  if (missingReusedProfile) {
    setConfirmDialog({
      title: '找不到 API 配置',
      message: `找不到复用任务所使用的 API 配置「${taskProfileName}」，要使用当前的 API 配置「${currentProfile.name}」提交任务吗？`,
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
      action: () => {
        void submitTask({ useCurrentApiProfileWhenReusedMissing: true })
      },
    })
    return
  }

  showToast(
    shouldTemporarilyReuseProfile && matchedProfile
      ? `已临时复用该任务的 API 配置「${matchedProfile.name}」`
      : '已复用配置到输入框',
    'success',
  )
}

/** 编辑输出：将输出图加入输入 */
export async function editOutputs(task: TaskRecord) {
  const { inputImages, addInputImage, showToast } = useStore.getState()
  if (!task.outputImages?.length) return

  let added = 0
  for (const imgId of task.outputImages) {
    const dataUrl = await ensureImageCached(imgId)
    if (!dataUrl) continue
    const image = await toReferenceImage(imgId, dataUrl)
    if (inputImages.some((i) => i.id === image.id)) continue
    addInputImage(image)
    added++
  }
  showToast(`已添加 ${added} 张输出图到输入`, 'success')
}

async function removeTasks(taskIds: string[]) {
  const toDelete = new Set(taskIds)
  const deletedTasks = useStore.getState().tasks.filter((task) => toDelete.has(task.id))
  await commitTaskDeletion(deletedTasks.map((task) => task.id), [], [])
  useStore.setState((state) => ({
    tasks: state.tasks.filter((task) => !toDelete.has(task.id)),
    selectedTaskIds: state.selectedTaskIds.filter((id) => !toDelete.has(id)),
    streamPreviews: Object.fromEntries(Object.entries(state.streamPreviews).filter(([id]) => !toDelete.has(id))),
    streamPreviewSlots: Object.fromEntries(Object.entries(state.streamPreviewSlots).filter(([id]) => !toDelete.has(id))),
  }))
  const deletedImageIds = new Set<string>()
  for (const task of deletedTasks) {
    addTaskReferencedImageIds(deletedImageIds, task)
    clearFalRecoveryTimer(task.id)
    clearCustomRecoveryTimer(task.id)
    clearOpenAIWatchdogTimer(task.id)
    taskExecutions.delete(task.id)
  }
  await deleteUnreferencedImageIds(deletedImageIds)
  return deletedTasks.length
}

/** 删除多条任务 */
export async function removeMultipleTasks(taskIds: string[]) {
  if (!taskIds.length) return

  const deletedCount = await removeTasks(taskIds)
  if (deletedCount === 0) return
  useStore.getState().showToast(`已删除 ${deletedCount} 个任务`, 'success')
}

/** 删除所有失败任务 */
export async function clearFailedTasks(taskIds?: string[]) {
  const targetTaskIds = taskIds ? new Set(taskIds) : null
  const failedTasks = useStore.getState().tasks
    .filter((task) => taskMatchesFilterStatus(task, 'error') && (!targetTaskIds || targetTaskIds.has(task.id)))
  const failedTaskIds = failedTasks
    .filter((task) => task.status === 'error')
    .map((task) => task.id)
  const partialFailedTaskIds = new Set(
    failedTasks
      .filter((task) => task.status !== 'error' && taskHasOutputErrors(task))
      .map((task) => task.id),
  )

  if (failedTaskIds.length) await removeMultipleTasks(failedTaskIds)
  if (partialFailedTaskIds.size) {
    const { tasks, setTasks, selectedTaskIds, setSelectedTaskIds, showToast } = useStore.getState()
    const updated = tasks.map((task) => partialFailedTaskIds.has(task.id) ? { ...task, outputErrors: undefined } : task)
    setTasks(updated)
    const nextSelectedTaskIds = selectedTaskIds.filter((id) => !partialFailedTaskIds.has(id))
    if (nextSelectedTaskIds.length !== selectedTaskIds.length) setSelectedTaskIds(nextSelectedTaskIds)
    await Promise.all(updated.filter((task) => partialFailedTaskIds.has(task.id)).map((task) => putTask(task)))
    showToast(`已清除 ${partialFailedTaskIds.size} 条部分失败记录`, 'success')
  }
}

/** 删除单条任务 */
export async function removeTask(task: TaskRecord) {
  const deletedCount = await removeTasks([task.id])
  if (deletedCount === 0) return
  useStore.getState().showToast('任务已删除', 'success')
}

/** 清空数据选项 */
export interface ClearOptions {
  clearConfig?: boolean
  clearTasks?: boolean
}

/** 清空数据 */
export async function clearData(options: ClearOptions = { clearConfig: true, clearTasks: true }) {
  const { setTasks, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } = useStore.getState()
  // 清空后剩余的批量提示词已没有对应的任务、配置或图片，直接结束批量
  if (useStore.getState().batchProgress) endBatch(activeBatchId)

  if (options.clearTasks) {
    await dbClearTasks()
    for (const id of await getAllImageIds()) {
      if (!legacyImageIds.has(id)) await deleteImage(id)
    }
    clearImageCaches()
    setTasks([])
    useStore.setState({
      supportPromptOpen: false,
      supportPromptSkippedForImportedData: false,
      imageSourceUrls: {},
    })
    clearInputImages()
    clearMaskDraft()
  }

  if (options.clearConfig) {
    const presetConfig = getPresetConfig()
    useStore.setState({
      dismissedPresetProfileIds: [],
      dismissedPresetProviderIds: [],
      dismissedCodexCliPrompts: [],
      supportPromptDismissed: false,
    })
    if (presetConfig) {
      useStore.setState({ settings: { ...DEFAULT_SETTINGS } })
      await useStore.getState().setPresetImportedSettings(presetConfig)
    } else {
      setSettings({ ...DEFAULT_SETTINGS })
    }
    setParams({ ...DEFAULT_PARAMS })
  }

  showToast('所选数据已清空', 'success')
}

async function completeRecoveredCustomTask(task: TaskRecord, result: Awaited<ReturnType<typeof getCustomQueuedImageResult>>) {
  const latest = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latest || latest.status === 'done') return
  if (latest.status !== 'running' && !latest.customRecoverable) return

  const { outputIds, outputDataUrls, outputImageSizes, transparentOriginalImageIds } = await storeTaskOutputImages(task, result.images)
  const actualParamsList = await resolveImageSizeParamsList(outputDataUrls, undefined, outputImageSizes)
  const latestBeforeUpdate = useStore.getState().tasks.find((item) => item.id === task.id)
  if (!latestBeforeUpdate || latestBeforeUpdate.status === 'done' || (latestBeforeUpdate.status !== 'running' && !latestBeforeUpdate.customRecoverable)) {
    await deleteUnreferencedImageIds([...outputIds, ...(transparentOriginalImageIds ?? [])])
    return
  }

  updateTaskInStore(task.id, {
    outputImages: outputIds,
    transparentOriginalImages: transparentOriginalImageIds,
    actualParams: firstActualParams(actualParamsList),
    actualParamsByImage: mapActualParamsByImage(outputIds, actualParamsList),
    revisedPromptByImage: undefined,
    ...createTaskDonePatch(task, Date.now()),
    customRecoverable: false,
  })
  if (!isTaskHiddenByPrivacyMode(task)) {
    useStore.getState().showToast(`自定义异步任务已恢复，共 ${outputIds.length} 张图片`, 'success')
    if (!isAgentTask(task)) showTaskCompletionNotification('图像生成完成', `自定义异步任务已恢复，共 ${outputIds.length} 张图片。`)
  }
}

async function recoverCustomTask(taskId: string) {
  const { settings, tasks } = useStore.getState()
  const task = tasks.find((item) => item.id === taskId)
  if (!task || !task.customTaskId || task.status === 'done') return

  const profile = getCustomRecoveryProfile(settings, task)
  const definition = profile ? getCustomProviderDefinition(settings, profile.provider) ?? (profile.provider === 'openai' || profile.provider === 'xai' ? OPENAI_IMAGE_TASK_PROVIDER : null) : null
  const customProvider = profile && definition ? resolveCustomProviderModel(definition, profile.model) : null
  if (!profile || !customProvider?.poll) {
    scheduleCustomRecovery(taskId)
    return
  }

  try {
    const result = await getCustomQueuedImageResult(profile, customProvider, task.customTaskId, task.params)
    clearCustomRecoveryTimer(taskId)
    await completeRecoveredCustomTask(task, result)
  } catch (err) {
    clearCustomRecoveryTimer(taskId)
    if (!useStore.getState().tasks.some((item) => item.id === taskId)) return
    const error = err instanceof Error ? err.message : String(err)
    updateTaskInStore(taskId, {
      ...createTaskErrorPatch(task, error, Date.now()),
      ...getRawErrorPayload(err),
      customRecoverable: false,
    })
    showTaskFailureNotification(task)
  }
}

/** 导出选项 */
export interface ExportOptions {
  exportConfig?: boolean
  exportTasks?: boolean
}

/** 导出数据为 ZIP */
export async function exportData(options: ExportOptions = { exportConfig: true, exportTasks: true }) {
  // 导出全程可取消：网页版放弃后续下载，客户端丢弃正在写入的临时文件
  const signal = startDataProgress('export', true)
  let savedParts = 0
  try {
    const state = useStore.getState()
    if (options.exportTasks && hasActiveDataOperations(state.tasks)) throw new Error('当前有任务正在进行，请完成或停止后再导出。')
    const tasks = options.exportTasks ? await getAllTasks() : []
    const imageIds = options.exportTasks ? await getAllImageIds() : []
    const { settings, favoriteCollections, defaultFavoriteCollectionId } = state
    const exportedAt = Date.now()
    const params = {
      options,
      exportedAt,
      settings,
      tasks,
      imageTasks: tasks,
      imageSourceUrls: state.imageSourceUrls,
      favoriteCollections,
      defaultFavoriteCollectionId,
    }
    // 进度回调中检查取消，逐张读取时也能及时中断
    const imageSizes = await getExportImageSizes(imageIds, (done) => {
      throwIfAborted(signal)
      updateDataProgress('统计图片', done, imageIds.length, 'image')
    })
    throwIfAborted(signal)
    const plan = getExportZipPlan(params, imageSizes)
    const backupId = `${exportedAt}`
    // 客户端分卷备份时先选择目录，一次写入全部分卷，替代浏览器的多文件下载
    if (isTauri && plan.length > 1) updateDataProgress('选择保存位置')
    const dir = isTauri && plan.length > 1 ? await pickSaveDir() : null
    if (isTauri && plan.length > 1 && !dir) return
    let savedPath = ''
    const imageTotal = plan.reduce((sum, part) => sum + part.imageIds.length, 0)
    let imagesRead = 0

    for (let index = 0; index < plan.length; index++) {
      const partNumber = index + 1
      const partLabel = plan.length > 1 ? `（第 ${partNumber} / ${plan.length} 卷）` : ''
      throwIfAborted(signal)
      const { images, thumbnailsByImageId } = await readExportImages(plan[index].imageIds, (done) => {
        throwIfAborted(signal)
        updateDataProgress(`读取图片${partLabel}`, imagesRead + done, imageTotal, 'image')
      })
      imagesRead += plan[index].imageIds.length
      throwIfAborted(signal)
      updateDataProgress(`打包${partLabel}`)

      const result = await buildExportZip({
        ...params,
        tasks: plan[index].tasks,
        images,
        thumbnailsByImageId,
        includeManifestData: plan[index].includeBaseData,
        backupPart: plan.length > 1 ? { id: backupId, index: partNumber, total: plan.length } : undefined,
      })
      const suffix = plan.length > 1 ? `_${String(plan.length).padStart(2, '0')}parts_part${String(partNumber).padStart(2, '0')}` : ''
      const fileName = `gpt-image-playground-backup_${formatExportFileTime(new Date(exportedAt))}${suffix}.zip`
      throwIfAborted(signal)
      updateDataProgress(`保存文件${partLabel}`)
      const saveOpts: SaveOptions = { signal, onProgress: (written, total) => updateDataProgress(`保存文件${partLabel}`, written, total, 'byte') }
      if (dir) {
        await saveFileToDir(dir, result.bytes, fileName, saveOpts)
        savedParts++
        continue
      }
      // 客户端直接传字节给 Rust 写入，不再复制一份 Blob
      const saved = await saveFile(isTauri ? result.bytes : createExportBlob(result.bytes), fileName, saveOpts)
      if (!saved) return
      savedParts++
      savedPath = saved
      if (partNumber < plan.length) await new Promise((resolve) => setTimeout(resolve, 150))
    }
    const msg = dir
      ? `已导出 ${plan.length} 个 ZIP 到 ${dir.path}`
      : plan.length > 1 ? `正在下载 ${plan.length} 个 ZIP，如被浏览器拦截，请允许多文件下载` : isTauri ? `已导出到 ${savedPath}` : '数据已导出'
    useStore.getState().showToast(msg, 'success')
  } catch (e) {
    if (signal.aborted) {
      useStore.getState().showToast(savedParts ? `已取消导出，已${isTauri ? '保存' : '下载'}的 ${savedParts} 个分卷不完整，可以删除` : '已取消导出', 'info')
      return
    }
    console.error('exportData failed', e)
    const detail = e instanceof Error ? e.message.trim() : String(e).trim()
    useStore.getState().showToast(detail ? `导出失败，${detail}` : '导出失败', 'error')
  } finally {
    endDataProgress()
  }
}

/** 导入选项 */
export interface ImportOptions {
  importConfig?: boolean
  importTasks?: boolean
}

export async function restoreExplicitPresetConfig(ids: { providerIds: string[], profileIds: string[] }) {
  const presetProviderIds = getPresetProviderIds()
  const presetProfileIds = getPresetProfileIds()
  const providerIds = ids.providerIds.filter((id) => presetProviderIds.has(id))
  const profileIds = ids.profileIds.filter((id) => presetProfileIds.has(id))
  if (!providerIds.length && !profileIds.length) return false

  const state = useStore.getState()
  for (const id of providerIds) state.restorePresetProvider(id)
  for (const id of profileIds) state.restorePresetProfile(id)
  const presetConfig = getPresetConfig()
  if (presetConfig) await useStore.getState().setPresetImportedSettings(presetConfig)
  return true
}

/** 导入 ZIP 数据 */
export async function importData(input: File | File[], options: ImportOptions = { importConfig: true, importTasks: true }): Promise<boolean> {
  // 只允许在解析备份阶段取消；开始写入后取消会留下半份数据
  const signal = startDataProgress('import', true)
  try {
    const state = useStore.getState()
    if (options.importTasks && hasActiveDataOperations(state.tasks)) throw new Error('当前有任务正在进行，请完成或停止后再导入。')
    const files = Array.isArray(input) ? input : [input]
    if (!files.length) throw new Error('没有选择备份文件。')
    if (files.some((file) => file.size >= MAX_EXPORT_ZIP_BYTES)) {
      throw new Error('单个 ZIP 不能超过 2 GB，请使用分卷备份。')
    }

    const selected = [] as Array<{ file: File; manifest: Awaited<ReturnType<typeof readExportZipManifest>> }>
    for (const [idx, file] of files.entries()) {
      updateDataProgress('解析备份', idx, files.length > 1 ? files.length : 0, files.length > 1 ? 'file' : undefined)
      const manifest = await readExportZipManifest(new Uint8Array(await file.arrayBuffer()), options.importTasks)
      selected.push({ file, manifest })
      throwIfAborted(signal)
    }
    const multipart = selected.some((part) => part.manifest.backupPart != null)
    if (multipart) {
      if (selected.some((part) => !part.manifest.backupPart)) throw new Error('不能同时选择分卷备份和普通备份。')
      const first = selected[0].manifest.backupPart!
      const indexes = new Set(selected.map((part) => part.manifest.backupPart!.index))
      const validSet = selected.every((part) => {
        const backupPart = part.manifest.backupPart!
        return backupPart.id === first.id && backupPart.total === first.total && backupPart.index >= 1 && backupPart.index <= first.total
      })
      if (!validSet || indexes.size !== selected.length) throw new Error('所选分卷不属于同一份备份，或有重复。')
      if (options.importTasks && (selected.length !== first.total || indexes.size !== first.total)) {
        throw new Error(`分卷不全，请一次选择全部 ${first.total} 个 ZIP。`)
      }
      selected.sort((a, b) => a.manifest.backupPart!.index - b.manifest.backupPart!.index)
    }

    const settingsManifests = selected.filter((part) => part.manifest.settings)
    if (options.importConfig && !options.importTasks && !settingsManifests.length) throw new Error('这份备份里没有配置。')
    const importedTasks = selected.flatMap((part) => part.manifest.tasks ?? [])
    const hasTaskData = selected.some((part) => part.manifest.tasks != null || part.manifest.imageFiles != null)

    // 先关闭取消再检查，确保点了取消就不会进入写入阶段
    setDataProgressCancelable(false)
    throwIfAborted(signal)

    const importedImageIds: string[] = []
    if (options.importTasks && hasTaskData) {
      // 原图和缩略图合并计数，分片交替写入时进度条也只增不减
      const fileTotal = selected.reduce((sum, part) => sum + Object.keys(part.manifest.imageFiles ?? {}).length + Object.keys(part.manifest.thumbnailFiles ?? {}).length, 0)
      let filesDone = 0
      for (const [idx, part] of selected.entries()) {
        updateDataProgress(selected.length > 1 ? `读取备份（第 ${idx + 1} / ${selected.length} 个）` : '读取备份', filesDone, fileTotal, 'file')
        const { manifest, files: zipFiles } = await readExportZip(new Uint8Array(await part.file.arrayBuffer()))
        for (const [id, info] of Object.entries(manifest.imageFiles ?? {})) {
          // 先计入当前文件，写到最后一个时进度到 100%
          updateDataProgress('写入图片和缩略图', ++filesDone, fileTotal, 'file')
          const dataUrl = readExportZipFileAsDataUrl(zipFiles, info.path)
          if (!dataUrl) continue
          await putImage({
            id,
            dataUrl,
            createdAt: info.createdAt,
            source: info.source,
            width: info.width,
            height: info.height,
          })
          cacheImage(id, dataUrl)
          // 备份文件来自外部，只接受 http(s) 链接
          if (isHttpUrl(info.sourceUrl)) {
            const sourceUrl = info.sourceUrl
            useStore.setState((s) => ({ imageSourceUrls: { ...s.imageSourceUrls, [id]: sourceUrl } }))
          }
          importedImageIds.push(id)
        }

        for (const [id, info] of Object.entries(manifest.thumbnailFiles ?? {})) {
          updateDataProgress('写入图片和缩略图', ++filesDone, fileTotal, 'file')
          const thumbnailDataUrl = readExportZipFileAsDataUrl(zipFiles, info.path)
          if (!thumbnailDataUrl) continue
          await putImageThumbnail({
            id,
            thumbnailDataUrl,
            width: info.width,
            height: info.height,
            thumbnailVersion: info.thumbnailVersion,
          })
          cacheThumbnail(id, {
            src: thumbnailDataUrl,
            width: info.width,
            height: info.height,
            thumbnailVersion: info.thumbnailVersion,
          })
        }
      }

      updateDataProgress('写入任务和会话')
      for (const task of importedTasks) {
        // startedAt 来自导入文件，非法值会让计时和“重试于”显示异常
        await putTask(Number.isFinite(task.startedAt) || task.startedAt === undefined ? task : { ...task, startedAt: undefined })
      }

      const tasks = await getAllTasks()
      const state = useStore.getState()
      const importedFavoriteCollections = selected.flatMap((part) => part.manifest.favoriteCollections ?? [])
      const mergedFavorites = mergeFavoriteCollections(state.favoriteCollections, importedFavoriteCollections)
      const favoriteCollections = mergedFavorites.collections
      const importedDefaultFavoriteCollectionId = selected
        .map((part) => part.manifest.defaultFavoriteCollectionId)
        .find((id) => id != null && favoriteCollections.some((collection) => collection.id === id))
      const defaultFavoriteCollectionId = mergedFavorites.importedCollections.length
        ? resolveDefaultFavoriteCollectionId(favoriteCollections, importedDefaultFavoriteCollectionId)
        : state.defaultFavoriteCollectionId
      const normalizedFavorites = normalizeLoadedFavoriteState(tasks, favoriteCollections, defaultFavoriteCollectionId)
      useStore.setState({
        tasks: normalizedFavorites.tasks,
        favoriteCollections: normalizedFavorites.collections,
        defaultFavoriteCollectionId: normalizedFavorites.defaultFavoriteCollectionId,
      })
      if (normalizedFavorites.changed) await Promise.all(normalizedFavorites.tasks.map((task) => putTask(task)))
      skipSupportPromptForImportedData(tasks)
      void scheduleMissingThumbnailBackfill(importedImageIds)
    }

    if (options.importConfig && settingsManifests.length) {
      const state = useStore.getState()
      const providerIds = new Set(settingsManifests.flatMap((part) =>
        part.manifest.settings?.customProviders?.map((provider) => provider.id) ?? [],
      ))
      const profileIds = new Set(settingsManifests.flatMap((part) =>
        part.manifest.settings?.profiles.map((profile) => profile.id) ?? [],
      ))
      const presetProviderIds = getPresetProviderIds()
      const presetProfileIds = getPresetProfileIds()
      for (const id of providerIds) {
        if (presetProviderIds.has(id)) state.restorePresetProvider(id)
      }
      for (const id of profileIds) {
        if (presetProfileIds.has(id)) state.restorePresetProfile(id)
      }
      const current = useStore.getState()
      const settings = settingsManifests.reduce(
        (current, part) => mergeImportedSettings(current, part.manifest.settings, { preserveInternalIds: true }),
        current.settings,
      )
      current.setSettings(settings)
    }

    let msg = '导入完成'
    if (options.importTasks && hasTaskData) {
      msg = `已导入 ${importedTasks.length} 个任务`
    } else if (options.importConfig && settingsManifests.length) {
      msg = '配置已导入'
    }

    useStore.getState().showToast(msg, 'success')
    return true
  } catch (e) {
    if (signal.aborted) {
      useStore.getState().showToast('已取消导入', 'info')
      return false
    }
    console.error('importData failed', e)
    const detail = e instanceof Error ? e.message.trim() : String(e).trim()
    useStore.getState().showToast(detail ? `导入失败，${detail}` : '导入失败', 'error')
    return false
  } finally {
    endDataProgress()
  }
}

/** 添加图片到输入（文件上传） */
export async function addImageFromFile(file: File): Promise<void> {
  const image = await createInputImageFromFile(file)
  if (!image) return
  useStore.getState().addInputImage(image)
}

export async function createInputImageFromFile(file: File): Promise<InputImage | null> {
  if (!file.type.startsWith('image/')) return null
  // 图像接口不接受 SVG 和 GIF，加入时就转成 PNG
  const dataUrl = await toApiInputImageDataUrl(await fileToDataUrl(file))
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  // 本地添加的图片即使与链接添加的内容相同，也不再沿用当时的链接，以免提交已过期的链接
  forgetImageSourceUrl(id)
  return { id, dataUrl }
}

/** 添加图片到输入（右键菜单、添加链接）—— 支持 data/blob/http URL */
export async function createInputImageFromUrl(src: string): Promise<InputImage> {
  const res = await apiFetch(src)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('不是有效的图片')
  // 图像接口不接受 SVG 和 GIF，加入时就转成 PNG
  const dataUrl = await toApiInputImageDataUrl(await blobToDataUrl(blob))
  const id = await storeImage(dataUrl, 'upload')
  cacheImage(id, dataUrl)
  // 内容相同的图片共用一个 id，记录最近一次添加的链接
  if (isHttpUrl(src)) useStore.setState((s) => ({ imageSourceUrls: { ...s.imageSourceUrls, [id]: src } }))
  return { id, dataUrl }
}

export async function addImageFromUrl(src: string): Promise<void> {
  useStore.getState().addInputImage(await createInputImageFromUrl(src))
}
