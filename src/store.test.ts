import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { DEFAULT_PARAMS } from './types'
import { createDefaultFalProfile, createDefaultOpenAIProfile, DEFAULT_RESPONSES_MODEL, DEFAULT_SETTINGS, normalizeSettings } from './lib/apiProfiles'
import type { ExportData, StoredImage, StoredImageThumbnail, TaskRecord } from './types'
import { getSelectedImageMentionLabel } from './lib/promptImageMentions'
import { hasActiveDataOperations, hasInterruptibleOperations, trackDataTransfer } from './lib/dataOperations'
import { cancelDataProgress, useDataProgress } from './lib/dataProgress'
import { ALL_FAVORITES_COLLECTION_ID } from './lib/favoriteState'
import { normalizePersistedState } from './lib/persistedState'
import { setPresetConfig } from './lib/presetConfig'
import { FetchConnectError } from './lib/platform'
vi.mock('./lib/db', () => {
  const tasks = new Map<string, TaskRecord>()
  const images = new Map<string, StoredImage>()
  const thumbnails = new Map<string, StoredImageThumbnail>()
  let imageSeq = 0

  return {
    CURRENT_THUMBNAIL_VERSION: 2,
    getAllTasks: async () => [...tasks.values()],
    putTask: async (task: TaskRecord) => {
      tasks.set(task.id, task)
      return task.id
    },
    deleteTask: vi.fn(async (id: string) => {
      tasks.delete(id)
    }),
    commitTaskDeletion: vi.fn(async (deletedTaskIds: string[], updatedTasks: TaskRecord[]) => {
      for (const id of deletedTaskIds) tasks.delete(id)
      for (const task of updatedTasks) tasks.set(task.id, task)
    }),
    clearTasks: async () => {
      tasks.clear()
    },
    getLegacyProtectedImageIds: async () => [],
    collectLegacyImageIds: () => [],
    getImage: async (id: string) => images.get(id),
    getStoredImageThumbnail: async (id: string) => thumbnails.get(id),
    getImageThumbnail: async (id: string) => thumbnails.get(id),
    getImageMeta: async (id: string) => images.get(id),
    getAllImageIds: async () => [...images.keys()],
    getAllImages: async () => [...images.values()],
    putImage: async (image: StoredImage) => {
      images.set(image.id, image)
      return image.id
    },
    putImageThumbnail: async (thumbnail: StoredImageThumbnail) => {
      thumbnails.set(thumbnail.id, thumbnail)
      return thumbnail.id
    },
    deleteImage: vi.fn(async (id: string) => {
      images.delete(id)
      thumbnails.delete(id)
    }),
    clearImages: async () => {
      images.clear()
      thumbnails.clear()
    },
    storeImage: async (dataUrl: string, source: StoredImage['source'] = 'upload') => {
      const id = `stored-image-${++imageSeq}`
      images.set(id, { id, dataUrl, source, createdAt: Date.now() })
      return id
    },
    storeImageWithSize: async (dataUrl: string, source: StoredImage['source'] = 'upload') => {
      const id = `stored-image-${++imageSeq}`
      const size = dataUrl.match(/(\d+)x(\d+)/)
      const width = size ? Number(size[1]) : undefined
      const height = size ? Number(size[2]) : undefined
      images.set(id, { id, dataUrl, source, createdAt: Date.now(), width, height })
      return { id, width, height }
    },
  }
})
vi.mock('./lib/api', () => ({
  callImageApi: vi.fn(async () => ({
    images: [],
    actualParams: {},
    actualParamsList: [],
    revisedPrompts: [],
  })),
}))
vi.mock('./lib/falAiImageApi', () => ({
  getFalErrorMessage: vi.fn((err: unknown) => err instanceof Error ? err.message : String(err)),
  getFalQueuedImageResult: vi.fn(async () => ({
    images: [],
    actualParams: {},
    actualParamsList: [],
    revisedPrompts: [],
  })),
}))
vi.mock('./lib/transparentImage', () => ({
  GREEN_KEY_COLOR: '#00FF00',
  MAGENTA_KEY_COLOR: '#FF00FF',
  createTransparentOutputMeta: vi.fn((prompt: string) => ({
    transparentOutput: true,
    effectivePrompt: `transparent:${prompt}`,
  })),
  getTransparentRequestParams: vi.fn((params: typeof DEFAULT_PARAMS) => ({
    ...params,
    output_format: params.output_format === 'webp' ? 'webp' : 'png',
    output_compression: params.output_format === 'webp' ? params.output_compression : null,
    transparent_output: true,
  })),
  removeKeyedBackgroundFromDataUrl: vi.fn(async (dataUrl: string) => `transparent:${dataUrl}`),
}))
import { clearImages, clearTasks, commitTaskDeletion, deleteImage as deleteDbImage, deleteTask as deleteDbTask, getAllImageIds, getAllTasks, getImage, getStoredImageThumbnail, putImage, putImageThumbnail, putTask as putDbTask } from './lib/db'
import { callImageApi } from './lib/api'
vi.mock('./lib/browserNotification', async (importOriginal) => ({
  ...await importOriginal<typeof import('./lib/browserNotification')>(),
  showBrowserNotification: vi.fn(() => true),
}))
import { showBrowserNotification } from './lib/browserNotification'
import { getFalQueuedImageResult } from './lib/falAiImageApi'
import { removeKeyedBackgroundFromDataUrl } from './lib/transparentImage'
import { clearData, clearFailedTasks, deleteFavoriteCollection, editOutputs, getErrorToastMessage, getPersistedState, getTaskApiProfile, importData, initStore, removeMultipleTasks, removeTask, restoreExplicitPresetConfig, retryTask, reuseConfig, submitTask, taskMatchesFilterStatus, taskMatchesSearchQuery, useStore } from './store'

const commitTaskDeletionImplementation = vi.mocked(commitTaskDeletion).getMockImplementation()!
const deleteDbImageImplementation = vi.mocked(deleteDbImage).getMockImplementation()!
const deleteDbTaskImplementation = vi.mocked(deleteDbTask).getMockImplementation()!

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }
const imageB = { id: 'image-b', dataUrl: 'data:image/png;base64,b' }

describe('error toast messages', () => {
  it('drops long error detail after the failure title', () => {
    expect(getErrorToastMessage('Agent 请求失败：接口拒绝了很长的提示词内容')).toBe('Agent 请求失败')
  })

  it('uses a generic message for long raw errors without a title', () => {
    expect(getErrorToastMessage(`invalid request ${'x'.repeat(90)}`)).toBe('操作失败，请查看详情')
  })
})

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function importFile(data: ExportData, files: Record<string, Uint8Array> = {}): File {
  const zipped = zipSync({ ...files, 'manifest.json': strToU8(JSON.stringify(data)) })
  const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength)
  return { name: 'backup.zip', size: zipped.byteLength, arrayBuffer: async () => buffer.slice(0) } as File
}

describe('data operation locking', () => {
  it('detects running and recoverable gallery work', () => {
    expect(hasActiveDataOperations([task({ status: 'running' })])).toBe(true)
    expect(hasActiveDataOperations([task({ falRecoverable: true })])).toBe(true)
    expect(hasActiveDataOperations([task({ customRecoverable: true })])).toBe(true)
    expect(hasActiveDataOperations([task()])).toBe(false)
  })

  it('closing the client only warns about work that cannot resume after restart', async () => {
    expect(hasInterruptibleOperations([task({ status: 'running' })], null)).toBe(true)
    expect(hasInterruptibleOperations([task({ status: 'running', apiProvider: 'fal', falRequestId: 'req', falEndpoint: 'fal-ai/x' })], null)).toBe(false)
    expect(hasInterruptibleOperations([task({ status: 'running', apiProvider: 'fal', falRequestId: 'req' })], null)).toBe(true)
    expect(hasInterruptibleOperations([task({ status: 'running', customTaskId: 'job' })], null)).toBe(false)
    expect(hasInterruptibleOperations([task({ falRecoverable: true, apiProvider: 'fal', falRequestId: 'req', falEndpoint: 'fal-ai/x' })], null)).toBe(false)
    expect(hasInterruptibleOperations([task({ status: 'running' })], null)).toBe(true)

    let release = () => {}
    const transfer = trackDataTransfer(() => new Promise<void>((resolve) => { release = resolve }))
    expect(hasInterruptibleOperations([], null)).toBe(true)
    release()
    await transfer
    expect(hasInterruptibleOperations([], null)).toBe(false)

    // 批量中尚未开始的提示词只在内存中，即使已开始的任务都可恢复也要提示
    const recoverable = [task({ status: 'running', customTaskId: 'job' })]
    expect(hasInterruptibleOperations(recoverable, { total: 3, started: 1, finished: 0 })).toBe(true)
    expect(hasInterruptibleOperations(recoverable, { total: 3, started: 3, finished: 2 })).toBe(false)
    expect(hasInterruptibleOperations(recoverable, null)).toBe(false)
  })
})

describe('favorite collection deletion', () => {
  const collectionA = { id: 'collection-a', name: '收藏夹 A', createdAt: 1, updatedAt: 1 }
  const collectionB = { id: 'collection-b', name: '收藏夹 B', createdAt: 1, updatedAt: 1 }

  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    useStore.setState({
      tasks: [],
      favoriteCollections: [collectionA, collectionB],
      defaultFavoriteCollectionId: collectionA.id,
      activeFavoriteCollectionId: collectionA.id,
      selectedFavoriteCollectionIds: [collectionA.id],
      selectedTaskIds: [],
      inputImages: [],
      galleryInputDraft: null,

      showToast: vi.fn(),
    })
  })

  it('keeps tasks that are still referenced by another collection when deleting collection tasks', async () => {
    const sharedTask = task({
      id: 'shared-task',
      isFavorite: true,
      favoriteCollectionIds: [collectionA.id, collectionB.id],
    })
    const collectionOnlyTask = task({
      id: 'collection-only-task',
      isFavorite: true,
      favoriteCollectionIds: [collectionA.id],
    })
    useStore.setState({ tasks: [sharedTask, collectionOnlyTask] })
    await putDbTask(sharedTask)
    await putDbTask(collectionOnlyTask)

    await deleteFavoriteCollection(collectionA.id, true)

    const state = useStore.getState()
    expect(state.favoriteCollections.map((collection) => collection.id)).toEqual([collectionB.id])
    expect(state.activeFavoriteCollectionId).toBeNull()
    expect(state.selectedFavoriteCollectionIds).toEqual([])
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({
      id: sharedTask.id,
      isFavorite: true,
      favoriteCollectionIds: [collectionB.id],
    })
    expect((await getAllTasks()).map((item) => item.id)).toEqual([sharedTask.id])
  })
})

describe('task retry', () => {
  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    vi.mocked(callImageApi).mockReset()
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, baseUrl: 'https://api.example.com/v1', apiKey: 'test-key', retryMode: 'overwriteFailed' },
      tasks: [],
      showToast: vi.fn(),
      detailTaskId: null,
      filterFavorite: false,
      activeFavoriteCollectionId: null,
    })
  })

  it('persists prompt hints and clears them when retrying without hints', async () => {
    const hints = { prefix: '生成图像：', suffix: '请使用 google:search 搜索相关信息。' }
    useStore.setState({ appMode: 'gallery', prompt: 'example', inputImages: [], params: { ...DEFAULT_PARAMS } })
    vi.mocked(callImageApi).mockImplementationOnce(async (opts) => {
      opts.onPromptHintsPrepared?.(hints)
      throw new Error('example failure')
    })
    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('error'))
    expect((await getAllTasks())[0].promptHints).toEqual(hints)
    useStore.setState({ settings: { ...useStore.getState().settings, imagePromptHints: false } })
    expect(useStore.getState().tasks[0].promptHints).toEqual(hints)
    vi.mocked(callImageApi).mockImplementationOnce(async (opts) => {
      opts.onPromptHintsPrepared?.(undefined)
      return { images: [] }
    })
    await retryTask(useStore.getState().tasks[0])
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).not.toBe('running'))
    expect((await getAllTasks())[0].promptHints).toBeUndefined()
  })

  it('adds a new task created on a favorites page to the active collection', async () => {
    const collection = { id: 'collection-a', name: '收藏夹 A', createdAt: 1, updatedAt: 1 }
    const failed = task({ status: 'error', error: '上次失败' })
    useStore.setState({
      appMode: 'gallery',
      filterFavorite: true,
      activeFavoriteCollectionId: collection.id,
      favoriteCollections: [collection],
      defaultFavoriteCollectionId: collection.id,
      settings: { ...useStore.getState().settings, retryMode: 'new' },
      tasks: [failed],
      prompt: 'prompt',
      inputImages: [],
      params: { ...DEFAULT_PARAMS },
    })
    vi.mocked(callImageApi).mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })

    await retryTask(failed)
    expect(useStore.getState().tasks[0]).toMatchObject({ favoriteCollectionIds: [collection.id], isFavorite: true })
    await submitTask()
    expect(useStore.getState().tasks[0]).toMatchObject({ favoriteCollectionIds: [collection.id], isFavorite: true })

    useStore.setState({ settings: { ...useStore.getState().settings, saveTasksToActiveFavoriteCollection: false } })
    await submitTask()
    expect(useStore.getState().tasks[0].isFavorite).toBeUndefined()
    await vi.waitFor(() => expect(useStore.getState().tasks.every((item) => item.status !== 'running')).toBe(true))
  })

  it('keeps the source collections when retrying on the all favorites page', async () => {
    const collectionA = { id: 'collection-a', name: '收藏夹 A', createdAt: 1, updatedAt: 1 }
    const collectionB = { id: 'collection-b', name: '收藏夹 B', createdAt: 1, updatedAt: 1 }
    const failed = task({ status: 'error', error: '上次失败', favoriteCollectionIds: [collectionB.id], isFavorite: true })
    useStore.setState({
      appMode: 'gallery',
      filterFavorite: true,
      activeFavoriteCollectionId: ALL_FAVORITES_COLLECTION_ID,
      favoriteCollections: [collectionA, collectionB],
      defaultFavoriteCollectionId: collectionA.id,
      settings: { ...useStore.getState().settings, retryMode: 'new' },
      tasks: [failed],
    })
    vi.mocked(callImageApi).mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })

    await retryTask(failed)
    expect(useStore.getState().tasks[0]).toMatchObject({ favoriteCollectionIds: [collectionB.id], isFavorite: true })
    await vi.waitFor(() => expect(useStore.getState().tasks[0].status).not.toBe('running'))
  })

  it('uses the default collection when the active one is deleted before a queued task starts', async () => {
    const collectionA = { id: 'collection-a', name: '收藏夹 A', createdAt: 1, updatedAt: 1 }
    const collectionB = { id: 'collection-b', name: '收藏夹 B', createdAt: 1, updatedAt: 1 }
    const firstRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi)
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    useStore.setState({
      appMode: 'gallery',
      filterFavorite: true,
      activeFavoriteCollectionId: collectionB.id,
      favoriteCollections: [collectionA, collectionB],
      defaultFavoriteCollectionId: collectionA.id,
      settings: { ...useStore.getState().settings, showBatchPrompt: true, batchPromptEnabled: true, batchPromptMode: 'queue' },
      prompt: 'first\n\n\nsecond',
      inputImages: [],
      params: { ...DEFAULT_PARAMS },
    })

    void submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledOnce())
    expect(useStore.getState().tasks[0]).toMatchObject({ prompt: 'first', favoriteCollectionIds: [collectionB.id] })
    await deleteFavoriteCollection(collectionB.id)
    firstRequest.resolve({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })

    await vi.waitFor(() => expect(useStore.getState().batchProgress).toBeNull())
    expect(useStore.getState().tasks.find((item) => item.prompt === 'second')).toMatchObject({ favoriteCollectionIds: [collectionA.id], isFavorite: true })
  })

  it('creates a separate task for a failed one by default', async () => {
    const failed = task({ status: 'error', error: '上次失败' })
    useStore.setState({ settings: { ...useStore.getState().settings, retryMode: DEFAULT_SETTINGS.retryMode }, tasks: [failed] })
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce(() => request.promise)

    await retryTask(failed)
    expect(useStore.getState().tasks).toHaveLength(2)
    expect(useStore.getState().tasks[0].id).not.toBe(failed.id)
    expect(useStore.getState().tasks[1]).toEqual(failed)
    request.resolve({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    await vi.waitFor(() => expect(useStore.getState().tasks[0].status).toBe('done'))
  })

  it('always creates a gallery task when retrying an Agent task', async () => {
    const failed = task({ status: 'error', error: '上次失败', sourceMode: 'agent' as const })
    useStore.setState({ settings: { ...useStore.getState().settings, retryMode: 'overwriteAll' }, tasks: [failed] })
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce(() => request.promise)

    await retryTask(failed)
    expect(useStore.getState().tasks).toHaveLength(2)
    expect(useStore.getState().tasks[0].sourceMode).toBeUndefined()
    expect(useStore.getState().tasks[1]).toEqual(failed)
    request.resolve({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    await vi.waitFor(() => expect(useStore.getState().tasks[0].status).toBe('done'))
  })

  it('overwrites a successful task when retry mode allows any task', async () => {
    const original = task({ outputImages: ['old-output'], isFavorite: true })
    await putImage({ id: 'old-output', dataUrl: 'data:image/png;base64,old', source: 'generated', createdAt: 1 })
    useStore.setState({ settings: { ...useStore.getState().settings, alwaysShowRetryButton: true, retryMode: 'overwriteAll' }, tasks: [original] })
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce(() => request.promise)

    await retryTask(original)
    expect(useStore.getState().tasks).toHaveLength(1)
    expect(useStore.getState().tasks[0]).toMatchObject({ id: original.id, status: 'running', createdAt: original.createdAt, outputImages: [], isFavorite: true, elapsed: null })
    await vi.waitFor(async () => expect(await getImage('old-output')).toBeUndefined())
    request.resolve({ images: ['data:image/png;base64,new'], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    await vi.waitFor(() => expect(useStore.getState().tasks[0].status).toBe('done'))
    expect(useStore.getState().tasks[0].outputImages).toHaveLength(1)
    expect(useStore.getState().tasks[0].outputImages[0]).not.toBe('old-output')
  })

  it('retries a failed task in place without losing its metadata', async () => {
    const failed = task({
      status: 'error',
      error: '上次失败',
      outputErrors: [{ requestIndex: 0, error: '上次失败' }],
      rawResponsePayload: '旧响应',
      falRequestId: '旧请求',
      falEndpoint: '旧 endpoint',
      favoriteCollectionIds: ['collection-1'],
      isFavorite: true,
    })
    await putDbTask(failed)
    useStore.setState({ tasks: [failed] })
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce(() => request.promise)

    await retryTask(failed)
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledOnce())
    expect(useStore.getState().tasks).toHaveLength(1)
    expect(useStore.getState().tasks[0]).toMatchObject({ id: failed.id, status: 'running', error: null, createdAt: failed.createdAt, favoriteCollectionIds: ['collection-1'], isFavorite: true })
    expect(useStore.getState().tasks[0].startedAt).toBeGreaterThan(failed.createdAt)
    expect(useStore.getState().tasks[0].rawResponsePayload).toBeUndefined()
    expect(useStore.getState().tasks[0].falRequestId).toBeUndefined()
    await retryTask(failed)
    expect(callImageApi).toHaveBeenCalledOnce()

    request.resolve({ images: ['data:image/png;base64,retried'], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    await vi.waitFor(() => expect(useStore.getState().tasks[0].status).toBe('done'))
    expect(useStore.getState().tasks).toHaveLength(1)
    expect(useStore.getState().tasks[0].outputImages).toHaveLength(1)
    await vi.waitFor(async () => expect((await getAllTasks()).map((item) => item.id)).toEqual([failed.id]))
  })

  it('ignores a late response from the failed attempt after an in-place retry', async () => {
    const oldRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    const newRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce(() => oldRequest.promise).mockImplementationOnce(() => newRequest.promise)
    // 第一轮仍在网络层执行，但界面已经判定超时。
    useStore.setState({ prompt: 'prompt', inputImages: [], params: { ...DEFAULT_PARAMS } })
    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledOnce())
    const original = useStore.getState().tasks[0]
    useStore.setState({ tasks: useStore.getState().tasks.map((item) => item.id === original.id ? { ...item, status: 'error', error: '超时' } : item) })
    await retryTask(original)
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(2))
    oldRequest.resolve({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    await vi.waitFor(() => expect(useStore.getState().tasks.find((item) => item.id === original.id)?.status).toBe('running'))
    newRequest.resolve({ images: ['data:image/png;base64,new'], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    await vi.waitFor(() => expect(useStore.getState().tasks.find((item) => item.id === original.id)?.status).toBe('done'))
    expect(useStore.getState().tasks.find((item) => item.id === original.id)?.outputImages).toHaveLength(1)
  })

  it('ignores a late failure and late stream previews from the replaced attempt', async () => {
    let emitOldPartial: () => void = () => {}
    const oldRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    const newRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi)
      .mockImplementationOnce((opts) => {
        emitOldPartial = () => opts.onPartialImage?.({ image: 'data:image/png;base64,old-partial', requestIndex: 0 })
        return oldRequest.promise
      })
      .mockImplementationOnce(() => newRequest.promise)
    useStore.setState({ appMode: 'gallery', prompt: 'prompt', inputImages: [], params: { ...DEFAULT_PARAMS } })
    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledOnce())
    const original = useStore.getState().tasks[0]
    useStore.setState({ tasks: useStore.getState().tasks.map((item) => item.id === original.id ? { ...item, status: 'error', error: '超时' } : item) })
    await retryTask(original)
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(2))

    emitOldPartial()
    expect(useStore.getState().streamPreviews[original.id]).toBeUndefined()
    oldRequest.reject(new Error('旧请求失败'))
    await oldRequest.promise.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useStore.getState().tasks[0]).toMatchObject({ id: original.id, status: 'running', error: null })
    expect(useStore.getState().tasks[0].streamPartialImageIds).toBeUndefined()
    expect(await getAllImageIds()).toEqual([])

    newRequest.resolve({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    await vi.waitFor(() => expect(useStore.getState().tasks[0].status).toBe('done'))
  })

  it('does not show the Codex CLI prompt for a replaced attempt', async () => {
    const postProcess = deferred<string>()
    const newRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    const setConfirmDialog = vi.fn()
    vi.mocked(callImageApi)
      .mockResolvedValueOnce({ images: ['data:image/png;base64,old'], actualParams: {}, actualParamsList: [], revisedPrompts: ['完全不同的提示词'] })
      .mockImplementationOnce(() => newRequest.promise)
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockImplementationOnce(() => postProcess.promise)
    useStore.setState({
      settings: {
        ...useStore.getState().settings,
        profiles: useStore.getState().settings.profiles.map((profile) => ({ ...profile, apiMode: 'responses', codexCli: false, transparentBackgroundMethod: 'local' })),
      },
      appMode: 'gallery',
      prompt: 'prompt',
      inputImages: [],
      params: { ...DEFAULT_PARAMS, output_format: 'png', transparent_output: true },
      dismissedCodexCliPrompts: [],
      setConfirmDialog,
    })
    await submitTask()
    // 旧请求已通过成功前检查，正在做透明背景后处理时被判定失败并重试
    await vi.waitFor(() => expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledOnce())
    const original = useStore.getState().tasks[0]
    useStore.setState({ tasks: useStore.getState().tasks.map((item) => item.id === original.id ? { ...item, status: 'error', error: '超时' } : item) })
    await retryTask(original)
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(2))

    postProcess.resolve('data:image/png;base64,old-transparent')
    await vi.waitFor(async () => expect(await getAllImageIds()).toEqual([]))
    expect(setConfirmDialog).not.toHaveBeenCalled()
    expect(useStore.getState().tasks[0]).toMatchObject({ id: original.id, status: 'running' })

    newRequest.resolve({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    await vi.waitFor(() => expect(useStore.getState().tasks[0].status).toBe('done'))
  })

  it('shows a normal completion toast after retrying a batch task in place', async () => {
    const showToast = vi.fn()
    const secondRequest = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi)
      .mockRejectedValueOnce(new Error('第一条失败'))
      .mockImplementationOnce(() => secondRequest.promise)
      .mockResolvedValueOnce({ images: ['data:image/png;base64,retried'], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    useStore.setState({
      settings: { ...useStore.getState().settings, showBatchPrompt: true, batchPromptEnabled: true, batchPromptMode: 'queue' },
      appMode: 'gallery',
      prompt: 'first\n\n\nsecond',
      inputImages: [],
      params: { ...DEFAULT_PARAMS },
      showToast,
    })
    void submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(2))
    const failed = useStore.getState().tasks.find((item) => item.status === 'error')!
    expect(useStore.getState().batchProgress).not.toBeNull()

    await retryTask(failed)
    await vi.waitFor(() => expect(useStore.getState().tasks.find((item) => item.id === failed.id)?.status).toBe('done'))
    expect(showToast).toHaveBeenCalledWith('生成完成，共 1 张图片', 'success')

    secondRequest.resolve({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    await vi.waitFor(() => expect(useStore.getState().batchProgress).toBeNull())
  })

  it('still creates a separate task when retrying a successful one in failed-only mode', async () => {
    const original = task()
    useStore.setState({ tasks: [original] })
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce(() => request.promise)

    await retryTask(original)
    expect(useStore.getState().tasks).toHaveLength(2)
    expect(useStore.getState().tasks[0].id).not.toBe(original.id)
    expect(useStore.getState().tasks[1]).toEqual(original)
    request.resolve({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    await vi.waitFor(() => expect(useStore.getState().tasks[0].status).toBe('done'))
  })
})

describe('mask draft lifecycle in store actions', () => {
  beforeEach(() => {
    vi.mocked(callImageApi).mockReset().mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockReset().mockImplementation(async (dataUrl) => `transparent:${dataUrl}`)
    useStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile, transparentBackgroundMethod: 'local' })),
      },
      prompt: 'prompt',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      detailTaskId: null,
      lightboxImageId: null,
      lightboxImageList: [],
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('preserves an existing mask when quick edit-output adds outputs as references', async () => {
    const maskDraft = {
      targetImageId: imageA.id,
      maskDataUrl: 'data:image/png;base64,mask',
      updatedAt: 1,
    }
    useStore.setState({
      inputImages: [imageA],
      maskDraft,
    })

    await editOutputs(task({ outputImages: [imageA.id] }))

    expect(useStore.getState().maskDraft).toEqual(maskDraft)
  })

  it('clears an invalid mask draft when submit cannot find the mask target image', async () => {
    useStore.setState({
      inputImages: [imageA],
      maskDraft: {
        targetImageId: 'missing-image',
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
    })

    await submitTask()

    expect(useStore.getState().maskDraft).toBeNull()
  })

  it('shows a submitted toast after creating a gallery task', async () => {
    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const state = useStore.getState()
    expect(state.tasks).toHaveLength(1)
    expect(state.showToast).toHaveBeenCalledWith('任务已提交', 'success')
  })

  it('does not apply the outer watchdog to concurrent Codex CLI custom requests', async () => {
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce(() => request.promise)
    const profile = {
      ...createDefaultOpenAIProfile({ id: 'custom-sync-profile', apiKey: 'custom-key', timeout: 1, codexCli: true }),
      provider: 'custom-sync',
    }
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        customProviders: [{
          id: 'custom-sync',
          name: 'Custom Sync',
          submit: { path: 'images/generations' },
        }],
        profiles: [profile],
        activeProfileId: profile.id,
      }),
      params: { ...DEFAULT_PARAMS, n: 2 },
    })
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledOnce())

    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 1000)).toBe(false)
    request.resolve({
      images: ['data:image/png;base64,success'],
      actualParams: { n: 1 },
      actualParamsList: [{ n: 1 }],
      revisedPrompts: [],
      failedRequests: [{ requestIndex: 1, error: 'The operation was aborted' }],
    })
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(useStore.getState().tasks[0]).toMatchObject({
      outputErrors: [{ requestIndex: 1, error: 'The operation was aborted' }],
    })
    expect(useStore.getState().tasks[0].outputImages).toHaveLength(1)
    setTimeoutSpy.mockRestore()
  })

  it('stores decoded image size as actual size when the API omits size', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,actual-1254x1254'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '2048x2048' },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const [task] = useStore.getState().tasks
    expect(task.actualParams).toMatchObject({ size: '1254x1254', output_format: 'png', n: 1 })
    expect(task.actualParamsByImage?.[task.outputImages[0]]).toMatchObject({ size: '1254x1254', output_format: 'png' })
    await clearTasks()
    await clearImages()
  })

  it('keeps API-returned actual size over decoded image size', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,actual-1254x1254'],
      actualParams: { output_format: 'png', size: '1024x1024' },
      actualParamsList: [{ output_format: 'png', size: '1024x1024' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, size: '2048x2048' },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const [task] = useStore.getState().tasks
    expect(task.actualParams?.size).toBe('1024x1024')
    expect(task.actualParamsByImage?.[task.outputImages[0]].size).toBe('1024x1024')
    await clearTasks()
    await clearImages()
  })

  it('stores transparent background output after local post-processing', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,generated'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: '单主体贴纸素材',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        output_compression: null,
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'transparent:单主体贴纸素材',
      params: expect.objectContaining({
        output_format: 'png',
        output_compression: null,
        transparent_output: true,
      }),
    }))
    expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledWith('data:image/png;base64,generated')
    const [task] = useStore.getState().tasks
    expect(task).toMatchObject({
      prompt: '单主体贴纸素材',
      transparentOutput: true,
      transparentPrompt: 'transparent:单主体贴纸素材',
      status: 'done',
    })
    expect(task.transparentOriginalImages).toHaveLength(1)
    const outputImage = await getImage(task.outputImages[0])
    const originalImage = await getImage(task.transparentOriginalImages![0])
    expect(outputImage?.dataUrl).toBe('transparent:data:image/png;base64,generated')
    expect(originalImage?.dataUrl).toBe('data:image/png;base64,generated')
    await clearTasks()
    await clearImages()
  })

  it('stores locally post-processed transparent output as WebP', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/webp;base64,generated'],
      actualParams: { output_format: 'webp' },
      actualParamsList: [{ output_format: 'webp' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: '单主体贴纸素材',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'webp',
        output_compression: 25,
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        output_format: 'webp',
        output_compression: 25,
        transparent_output: true,
      }),
    }))
    expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledWith(
      'data:image/webp;base64,generated',
      undefined,
      'webp',
      25,
    )
    await clearTasks()
    await clearImages()
  })

  it('keeps native transparent output unchanged and requests API transparency', async () => {
    const { callImageApi } = await import('./lib/api')
    vi.mocked(callImageApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,native-transparent'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, baseUrl: 'https://api.example.com/v1', apiKey: 'test-key' },
      prompt: '透明玻璃瓶',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '透明玻璃瓶',
      nativeTransparentBackground: true,
    }))
    expect(removeKeyedBackgroundFromDataUrl).not.toHaveBeenCalled()
    const [task] = useStore.getState().tasks
    expect(task.transparentOutput).toBeUndefined()
    expect(task.transparentPrompt).toBeUndefined()
    expect(task.transparentOriginalImages).toBeUndefined()
    expect((await getImage(task.outputImages[0]))?.dataUrl).toBe('data:image/png;base64,native-transparent')
    await clearTasks()
    await clearImages()
  })

  it('falls back to the original output when transparent post-processing fails', async () => {
    const { callImageApi } = await import('./lib/api')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(callImageApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockRejectedValueOnce(new Error('post-process failed'))
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,generated'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      prompt: '单主体贴纸素材',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        output_compression: null,
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    const [task] = useStore.getState().tasks
    expect(task).toMatchObject({
      transparentOutput: true,
      status: 'done',
    })
    expect(task.transparentOriginalImages).toEqual([''])
    const outputImage = await getImage(task.outputImages[0])
    expect(outputImage?.dataUrl).toBe('data:image/png;base64,generated')
    warnSpy.mockRestore()
    await clearTasks()
    await clearImages()
  })

  it('supports transparent background post-processing for fal gallery tasks', async () => {
    const { callImageApi } = await import('./lib/api')
    const falProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    vi.mocked(callImageApi).mockClear()
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockClear()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,fal-generated'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [{ ...falProfile, transparentBackgroundMethod: 'local' }],
        activeProfileId: falProfile.id,
      }),
      prompt: '单主体图标素材',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        transparent_output: true,
      },
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('done'))

    expect(callImageApi).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({
        output_format: 'png',
        transparent_output: true,
      }),
    }))
    expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledWith('data:image/png;base64,fal-generated')
    const [task] = useStore.getState().tasks
    expect(task.apiProvider).toBe('fal')
    expect(task.transparentOutput).toBe(true)
    expect(task.transparentOriginalImages).toHaveLength(1)
    await clearTasks()
    await clearImages()
  })

  it('preserves selected image mentions when replacing a mask target with an equivalent image id', () => {
    const replacement = { id: 'image-a-replacement', dataUrl: imageA.dataUrl }
    const prompt = `参考 ${getSelectedImageMentionLabel(0)} 生成`
    useStore.setState({
      prompt,
      inputImages: [imageA, imageB],
    })

    useStore.getState().setInputImages([replacement, imageB], {
      equivalentImageIds: { [imageA.id]: replacement.id },
    })

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([replacement.id, imageB.id])
    expect(state.prompt).toBe(prompt)
  })
})

describe('input persistence setting', () => {
  beforeEach(() => {
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      appMode: 'gallery',
      prompt: 'prompt',
      inputImages: [imageA],
      galleryInputDraft: null,



      dismissedCodexCliPrompts: [],
    })
  })

  it('persists input when restart input restore is enabled', () => {
    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('prompt')
    expect(persisted.inputImages).toEqual([{ id: imageA.id, dataUrl: '' }])
  })

  it('writes empty input when persisted input is cleared', () => {
    useStore.setState({ prompt: '', inputImages: [] })

    const persisted = getPersistedState(useStore.getState())

    expect(persisted.prompt).toBe('')
    expect(persisted.inputImages).toEqual([])
  })

  it('persists and restores normalized dismissed preset provider IDs', () => {
    useStore.setState({
      dismissedPresetProfileIds: ['profile-a'],
      dismissedPresetProviderIds: ['provider-a'],
    })

    const persisted = getPersistedState(useStore.getState())
    const restored = normalizePersistedState({
      ...persisted,
      dismissedPresetProviderIds: ['provider-a', 1, null, 'provider-b'],
    }, useStore.getState())!

    expect(persisted.dismissedPresetProviderIds).toEqual(['provider-a'])
    expect(restored.state.dismissedPresetProviderIds).toEqual(['provider-a', 'provider-b'])
  })
})

describe('preset deletion state', () => {
  afterEach(() => {
    setPresetConfig(null)
    useStore.setState({ previousPresetConfig: null })
  })

  it('removes an untouched preset after deployment removes it', async () => {
    const providers = [
      { id: 'preset-provider-a', name: 'Provider A', submit: { path: 'a' } },
      { id: 'preset-provider-b', name: 'Provider B', submit: { path: 'b' } },
    ]
    const profiles = [
      createDefaultOpenAIProfile({ id: 'preset-profile-a', provider: providers[0].id, isDefault: true }),
      createDefaultOpenAIProfile({ id: 'preset-profile-b', provider: providers[1].id }),
    ]
    const previous = { customProviders: providers, profiles }
    const next = { customProviders: [providers[0]], profiles: [profiles[0]] }
    useStore.setState({
      settings: normalizeSettings(DEFAULT_SETTINGS),
      previousPresetConfig: null,
      tasks: [],
    })
    setPresetConfig(previous)
    await useStore.getState().setPresetImportedSettings(previous)

    setPresetConfig(next)
    await useStore.getState().setPresetImportedSettings(next)

    const state = useStore.getState()
    expect(state.settings.profiles.map((profile) => profile.id)).toEqual(['preset-profile-a'])
    expect(state.settings.customProviders.map((provider) => provider.id)).toEqual(['preset-provider-a'])
  })

  it('removes untouched presets when deployment removes the entire preset config', async () => {
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'preset-profile', provider: provider.id, isDefault: true })
    const preset = { customProviders: [provider], profiles: [profile] }
    useStore.setState({
      settings: normalizeSettings(DEFAULT_SETTINGS),
      previousPresetConfig: null,
      tasks: [],
    })
    setPresetConfig(preset)
    await useStore.getState().setPresetImportedSettings(preset)

    setPresetConfig(null)
    await useStore.getState().setPresetImportedSettings({ customProviders: [], profiles: [] })

    const state = useStore.getState()
    expect(state.settings.profiles.map((item) => item.id)).toEqual([DEFAULT_SETTINGS.profiles[0].id])
    expect(state.settings.customProviders).toEqual([])
    expect(state.previousPresetConfig).toBeNull()
  })

  it('clearData clears both dismissal lists and reapplies the current preset', async () => {
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({
      id: 'preset-profile',
      isDefault: true,
      provider: provider.id,
      model: 'preset-model',
    })
    const preset = { customProviders: [provider], profiles: [profile] }
    setPresetConfig(preset)
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        customProviders: [],
        profiles: [createDefaultFalProfile({ id: 'user-profile' })],
        activeProfileId: 'user-profile',
      }),
      dismissedPresetProfileIds: [profile.id],
      dismissedPresetProviderIds: [provider.id],
      dismissedCodexCliPrompts: ['prompt-a'],
    })

    await clearData({ clearConfig: true, clearTasks: false })

    const state = useStore.getState()
    expect(state.dismissedPresetProfileIds).toEqual([])
    expect(state.dismissedPresetProviderIds).toEqual([])
    expect(state.dismissedCodexCliPrompts).toEqual([])
    expect(state.settings.customProviders).toEqual([expect.objectContaining({ id: provider.id })])
    expect(state.settings.profiles).toEqual([expect.objectContaining({ id: profile.id, provider: provider.id })])
  })

  it('restores an explicitly reimported preset provider', () => {
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'preset-profile', provider: provider.id })
    setPresetConfig({ customProviders: [provider], profiles: [profile] })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        customProviders: [],
        profiles: [{ ...profile, provider: 'openai' }],
      }),
      dismissedPresetProviderIds: [provider.id],
    })

    const state = useStore.getState()
    state.restorePresetProvider(provider.id)
    state.setSettings({ customProviders: [provider], profiles: [profile] })

    expect(useStore.getState().dismissedPresetProviderIds).toEqual([])
    expect(useStore.getState().settings.customProviders).toEqual([expect.objectContaining({ id: provider.id })])
    expect(useStore.getState().settings.profiles[0].provider).toBe(provider.id)
  })

  it('restores only preset IDs explicitly selected by a URL import', async () => {
    const providers = [
      { id: 'preset-provider-a', name: 'Preset Provider A', submit: { path: 'generate-a' } },
      { id: 'preset-provider-b', name: 'Preset Provider B', submit: { path: 'generate-b' } },
    ]
    const profiles = [
      createDefaultOpenAIProfile({ id: 'preset-profile-a', provider: providers[0].id, isDefault: true }),
      createDefaultOpenAIProfile({ id: 'preset-profile-b', provider: providers[1].id }),
    ]
    setPresetConfig({ customProviders: providers, profiles })
    useStore.setState({
      settings: normalizeSettings(DEFAULT_SETTINGS),
      dismissedPresetProviderIds: providers.map((provider) => provider.id),
      dismissedPresetProfileIds: profiles.map((profile) => profile.id),
    })

    const restored = await restoreExplicitPresetConfig({
      providerIds: [providers[0].id, 'not-a-preset'],
      profileIds: [profiles[0].id, 'not-a-preset'],
    })

    const state = useStore.getState()
    expect(restored).toBe(true)
    expect(state.dismissedPresetProviderIds).toEqual([providers[1].id])
    expect(state.dismissedPresetProfileIds).toEqual([profiles[1].id])
    expect(state.settings.customProviders).toEqual([expect.objectContaining({ id: providers[0].id })])
    expect(state.settings.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: profiles[0].id })]))
  })
})

describe('fal task recovery', () => {
  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    vi.mocked(getFalQueuedImageResult).mockReset().mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockReset().mockImplementation(async (dataUrl) => `transparent:${dataUrl}`)
    const falProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [falProfile],
        activeProfileId: falProfile.id,
      }),
      tasks: [],
      inputImages: [],
      galleryInputDraft: null,

      showToast: vi.fn(),
    })
  })

  it('applies transparent post-processing when a fal task recovers', async () => {
    const falTask = task({
      id: 'fal-transparent-task',
      apiProvider: 'fal',
      apiProfileId: 'fal-profile',
      apiProfileName: 'fal',
      apiModel: 'fal-model',
      params: {
        ...DEFAULT_PARAMS,
        output_format: 'png',
        transparent_output: true,
      },
      transparentOutput: true,
      transparentPrompt: 'transparent:prompt',
      status: 'error',
      error: '连接已断开，等待自动恢复',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      finishedAt: null,
      elapsed: null,
    })
    await putDbTask(falTask)
    vi.mocked(getFalQueuedImageResult).mockResolvedValueOnce({
      images: ['data:image/png;base64,fal-recovered'],
      actualParams: { output_format: 'png' },
      actualParamsList: [{ output_format: 'png' }],
      revisedPrompts: [],
    })

    await initStore()
    await vi.waitFor(() => {
      expect(useStore.getState().tasks.find((item) => item.id === falTask.id)).toMatchObject({ status: 'done', falRecoverable: false })
    })

    expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledWith('data:image/png;base64,fal-recovered')
    const recovered = useStore.getState().tasks.find((item) => item.id === falTask.id)
    expect(recovered).toMatchObject({
      status: 'done',
      falRecoverable: false,
      transparentOutput: true,
    })
    expect(recovered?.transparentOriginalImages).toHaveLength(1)
    const outputImage = await getImage(recovered!.outputImages[0])
    const originalImage = await getImage(recovered!.transparentOriginalImages![0])
    expect(outputImage?.dataUrl).toBe('transparent:data:image/png;base64,fal-recovered')
    expect(originalImage?.dataUrl).toBe('data:image/png;base64,fal-recovered')
  })
})

describe('data import', () => {
  beforeEach(async () => {
    useStore.setState({
      tasks: [],


      showToast: vi.fn(),
    })
  })

  it('restores favorite collections and default collection when importing task data', async () => {
    await clearTasks()
    const importedCollections = [
      { id: 'imported-collection-a', name: '导入收藏夹 A', createdAt: 1, updatedAt: 1 },
      { id: 'imported-collection-b', name: '导入收藏夹 B', createdAt: 2, updatedAt: 2 },
    ]
    const importedTask = task({
      id: 'imported-favorite-task',
      isFavorite: true,
      favoriteCollectionIds: [importedCollections[1].id],
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [importedTask],
      favoriteCollections: importedCollections,
      defaultFavoriteCollectionId: importedCollections[1].id,
      imageFiles: {},
    }), { importConfig: false, importTasks: true })

    const state = useStore.getState()
    expect(imported).toBe(true)
    expect(state.favoriteCollections).toEqual(expect.arrayContaining(importedCollections))
    expect(state.defaultFavoriteCollectionId).toBe(importedCollections[1].id)
    expect(state.tasks.find((item) => item.id === importedTask.id)).toMatchObject({
      favoriteCollectionIds: [importedCollections[1].id],
      isFavorite: true,
    })
    expect((await getAllTasks()).find((item) => item.id === importedTask.id)).toMatchObject({
      favoriteCollectionIds: [importedCollections[1].id],
      isFavorite: true,
    })
  })

  it('cancels import during parsing without writing any data', async () => {
    await clearTasks()
    const importing = importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [task({ id: 'imported-canceled-task' })],
      imageFiles: {},
    }), { importConfig: false, importTasks: true })
    cancelDataProgress()

    expect(await importing).toBe(false)
    expect(await getAllTasks()).toEqual([])
    expect(useStore.getState().showToast).toHaveBeenCalledWith('已取消导入', 'info')
    expect(useDataProgress.getState().progress).toBeNull()
  })

  it('drops invalid retry start times when importing tasks', async () => {
    const valid = task({ id: 'imported-valid-start', createdAt: 1, startedAt: 5 })
    const invalid = { ...task({ id: 'imported-invalid-start' }), startedAt: 'bad' } as unknown as TaskRecord

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [valid, invalid],
      imageFiles: {},
    }), { importConfig: false, importTasks: true })

    expect(imported).toBe(true)
    const stored = await getAllTasks()
    expect(stored.find((item) => item.id === valid.id)?.startedAt).toBe(5)
    expect(stored.find((item) => item.id === invalid.id)?.startedAt).toBeUndefined()
  })
  it('imports multiple regular backups together', async () => {
    await clearTasks()
    await clearImages()
    const sharedCollection = { id: 'regular-collection-shared', name: '共享收藏夹', createdAt: 1, updatedAt: 1 }
    const collectionA = { id: 'regular-collection-a', name: '普通备份 A', createdAt: 1, updatedAt: 1 }
    const collectionB = { id: 'regular-collection-b', name: '普通备份 B', createdAt: 2, updatedAt: 2 }
    const sharedTask = task({ id: 'regular-task-shared', outputImages: ['regular-image-shared'] })
    const backupA = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      tasks: [sharedTask, task({ id: 'regular-task-a', outputImages: ['regular-image-a'], favoriteCollectionIds: [collectionA.id], isFavorite: true })],
      favoriteCollections: [sharedCollection, collectionA],
      defaultFavoriteCollectionId: collectionA.id,
      imageFiles: {
        'regular-image-shared': { path: 'images/shared.png' },
        'regular-image-a': { path: 'images/image-a.png' },
      },
    }, {
      'images/shared.png': new Uint8Array([5, 6]),
      'images/image-a.png': new Uint8Array([1, 2]),
    })
    const backupB = importFile({
      version: 3,
      exportedAt: new Date(1).toISOString(),
      tasks: [sharedTask, task({ id: 'regular-task-b', outputImages: ['regular-image-b'], favoriteCollectionIds: [collectionB.id], isFavorite: true })],
      favoriteCollections: [sharedCollection, collectionB],
      defaultFavoriteCollectionId: collectionB.id,
      imageFiles: {
        'regular-image-shared': { path: 'images/shared.png' },
        'regular-image-b': { path: 'images/image-b.png' },
      },
    }, {
      'images/shared.png': new Uint8Array([5, 6]),
      'images/image-b.png': new Uint8Array([3, 4]),
    })

    const imported = await importData([backupA, backupB], { importConfig: false, importTasks: true })

    const state = useStore.getState()
    const taskIds = (await getAllTasks()).map((item) => item.id)
    const collectionIds = state.favoriteCollections.map((collection) => collection.id)
    expect(imported).toBe(true)
    expect(taskIds).toEqual(expect.arrayContaining(['regular-task-shared', 'regular-task-a', 'regular-task-b']))
    expect(taskIds.filter((id) => id === sharedTask.id)).toHaveLength(1)
    expect(await getImage('regular-image-shared')).toMatchObject({ dataUrl: 'data:image/png;base64,BQY=' })
    expect(await getImage('regular-image-a')).toMatchObject({ dataUrl: 'data:image/png;base64,AQI=' })
    expect(await getImage('regular-image-b')).toMatchObject({ dataUrl: 'data:image/png;base64,AwQ=' })
    expect(collectionIds).toEqual(expect.arrayContaining([sharedCollection.id, collectionA.id, collectionB.id]))
    expect(collectionIds.filter((id) => id === sharedCollection.id)).toHaveLength(1)
  })

  it('deduplicates shared config when merging multiple regular backups', async () => {
    const sharedProfile = createDefaultOpenAIProfile({ id: 'regular-profile-shared', name: '共享配置', apiKey: 'shared-key' })
    const profileA = createDefaultOpenAIProfile({ id: 'regular-profile-a', name: '普通配置 A', apiKey: 'key-a' })
    const profileB = createDefaultOpenAIProfile({ id: 'regular-profile-b', name: '普通配置 B', apiKey: 'key-b' })
    const backupA = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [sharedProfile, profileA], activeProfileId: profileA.id }),
    })
    const backupB = importFile({
      version: 3,
      exportedAt: new Date(1).toISOString(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [sharedProfile, profileB], activeProfileId: profileB.id }),
    })

    const imported = await importData([backupA, backupB], { importConfig: true, importTasks: false })

    const apiKeys = useStore.getState().settings.profiles.map((profile) => profile.apiKey)
    expect(imported).toBe(true)
    expect(apiKeys).toEqual(expect.arrayContaining(['shared-key', 'key-a', 'key-b']))
    expect(apiKeys.filter((apiKey) => apiKey === 'shared-key')).toHaveLength(1)
  })

  it('preserves internal IDs when restoring config', async () => {
    const provider = {
      id: 'backup-provider-id',
      name: 'Backup Provider',
      submit: { path: 'v1/generate' },
    }
    const profile = createDefaultOpenAIProfile({
      id: 'backup-profile-id',
      isDefault: true,
      provider: provider.id,
      model: 'model-v1',
    })
    useStore.setState({ settings: DEFAULT_SETTINGS })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, customProviders: [provider], profiles: [profile], activeProfileId: profile.id }),
    }), { importConfig: true, importTasks: false })
    await useStore.getState().setPresetImportedSettings({
      customProviders: [{ id: provider.id, name: 'Backup Provider', submit: { path: 'v2/generate' } }],
      profiles: [{ ...profile, provider: provider.id, model: 'model-v2' }],
    })

    const settings = useStore.getState().settings
    expect(imported).toBe(true)
    expect(settings.customProviders[0]).toMatchObject({ id: provider.id })
    expect(settings.profiles[0]).toMatchObject({ id: profile.id })
  })

  it('restores dismissed preset provider and profile IDs explicitly included in a backup', async () => {
    const provider = { id: 'preset-provider', name: 'Preset Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'preset-profile', provider: provider.id })
    const otherProfile = createDefaultOpenAIProfile({ id: 'other-preset-profile' })
    setPresetConfig({ customProviders: [provider], profiles: [profile, otherProfile] })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        customProviders: [],
        profiles: [{ ...profile, provider: 'openai' }],
      }),
      dismissedPresetProviderIds: [provider.id],
      dismissedPresetProfileIds: [profile.id, 'other-preset-profile'],
    })

    try {
      const imported = await importData(importFile({
        version: 3,
        exportedAt: new Date(0).toISOString(),
        settings: normalizeSettings({
          ...DEFAULT_SETTINGS,
          customProviders: [provider],
          profiles: [profile],
          activeProfileId: profile.id,
        }),
      }), { importConfig: true, importTasks: false })

      expect(imported).toBe(true)
      expect(useStore.getState().dismissedPresetProviderIds).toEqual([])
      expect(useStore.getState().dismissedPresetProfileIds).toEqual(['other-preset-profile'])
      expect(useStore.getState().settings.customProviders).toEqual([expect.objectContaining({ id: provider.id })])
      expect(useStore.getState().settings.profiles[0].provider).toBe(provider.id)
    } finally {
      setPresetConfig(null)
    }
  })

  it('preserves imported task references when restoring config into a non-empty workspace', async () => {
    await clearTasks()
    const localProfile = createDefaultFalProfile({ id: 'local-profile', apiKey: 'local-key' })
    const provider = { id: 'backup-provider', name: 'Backup Provider', submit: { path: 'generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'backup-profile', provider: provider.id, apiKey: 'backup-key' })
    const importedTask = task({ id: 'backup-task', apiProfileId: profile.id, apiProvider: provider.id })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [localProfile], activeProfileId: localProfile.id }),
      tasks: [],
    })

    const imported = await importData(importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, customProviders: [provider], profiles: [profile], activeProfileId: profile.id }),
      tasks: [importedTask],
      imageFiles: {},
    }), { importConfig: true, importTasks: true })

    const state = useStore.getState()
    expect(imported).toBe(true)
    expect(state.settings.profiles.map((item) => item.id)).toEqual(expect.arrayContaining([localProfile.id, profile.id]))
    expect(getTaskApiProfile(state.settings, state.tasks.find((item) => item.id === importedTask.id)!)).toMatchObject({ id: profile.id, provider: provider.id })
  })

  it('rejects an incomplete multipart backup before importing data', async () => {
    await clearTasks()
    const part1 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'backup-a', index: 1, total: 2 },
      tasks: [task({ id: 'incomplete-task' })],
      imageFiles: {},
    })

    const imported = await importData([part1], { importConfig: false, importTasks: true })

    expect(imported).toBe(false)
    expect((await getAllTasks()).some((item) => item.id === 'incomplete-task')).toBe(false)
  })

  it('validates image entries in every part before writing earlier parts', async () => {
    await clearImages()
    const part1 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'backup-a', index: 1, total: 2 },
      tasks: [],
      imageFiles: { 'preflight-image-a': { path: 'images/image-a.png' } },
    }, { 'images/image-a.png': new Uint8Array([1, 2]) })
    const part2 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'backup-a', index: 2, total: 2 },
      imageFiles: { 'preflight-image-b': { path: 'images/missing.png' } },
    })

    const imported = await importData([part1, part2], { importConfig: false, importTasks: true })

    expect(imported).toBe(false)
    expect(await getImage('preflight-image-a')).toBeUndefined()
  })

  it('imports config with running tasks without requiring image parts', async () => {
    useStore.setState({ tasks: [task({ status: 'running' })] })
    const part1 = importFile({
      version: 3,
      exportedAt: new Date(0).toISOString(),
      backupPart: { id: 'config-backup', index: 1, total: 3 },
      settings: DEFAULT_SETTINGS,
      tasks: [],
      imageFiles: { 'unused-image': { path: 'images/missing.png' } },
    })

    const imported = await importData([part1], { importConfig: true, importTasks: false })

    expect(imported).toBe(true)
  })

})

describe('task deletion', () => {
  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    vi.mocked(callImageApi).mockReset().mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    vi.mocked(commitTaskDeletion).mockReset().mockImplementation(commitTaskDeletionImplementation)
    vi.mocked(deleteDbImage).mockReset().mockImplementation(deleteDbImageImplementation)
    vi.mocked(getFalQueuedImageResult).mockReset().mockResolvedValue({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockReset().mockImplementation(async (dataUrl) => `transparent:${dataUrl}`)
    useStore.setState({
      tasks: [],
      selectedTaskIds: [],
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      galleryInputDraft: null,


      streamPreviews: {},
      streamPreviewSlots: {},
      detailTaskId: null,
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('removes a deleted task from the current selection', async () => {
    const deleted = task({ id: 'task-deleted' })
    const remaining = task({ id: 'task-remaining' })
    await putDbTask(deleted)
    await putDbTask(remaining)
    useStore.setState({ tasks: [deleted, remaining], selectedTaskIds: [deleted.id, remaining.id] })

    await removeTask(deleted)

    const state = useStore.getState()
    expect(state.tasks.map((item) => item.id)).toEqual([remaining.id])
    expect(state.selectedTaskIds).toEqual([remaining.id])
    expect((await getAllTasks()).map((item) => item.id)).toEqual([remaining.id])
    expect(state.showToast).toHaveBeenCalledWith('任务已删除', 'success')
  })

  it('restores an orphan image and thumbnail referenced during the check-delete window', async () => {
    const deleteImage = vi.mocked(deleteDbImage).getMockImplementation()!
    vi.mocked(deleteDbImage).mockImplementationOnce(async (id) => {
      await deleteImage(id)
      useStore.setState({ tasks: [task({ id: 'new-task', inputImageIds: [id] })] })
    })
    await putImage({ id: 'referenced-late', dataUrl: 'data:image/png;base64,second', createdAt: 1 })
    await putImageThumbnail({
      id: 'referenced-late',
      thumbnailDataUrl: 'data:image/webp;base64,thumb',
      width: 10,
      height: 10,
      thumbnailVersion: 2,
    })
    const deleted = task({ id: 'task-deleted', outputImages: ['referenced-late'] })
    useStore.setState({ tasks: [deleted] })

    await removeTask(deleted)

    await expect(getImage('referenced-late')).resolves.toMatchObject({ dataUrl: 'data:image/png;base64,second' })
    await expect(getStoredImageThumbnail('referenced-late')).resolves.toMatchObject({ thumbnailDataUrl: 'data:image/webp;base64,thumb', thumbnailVersion: 2 })
    expect(deleteDbImage).toHaveBeenCalledTimes(1)
  })

  it('does not open deleted gallery task details after a late rejection', async () => {
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce(() => request.promise)
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
    })

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(1))
    await removeTask(useStore.getState().tasks[0])
    request.reject(new Error('late gallery rejection'))
    await request.promise.catch(() => {})

    expect(useStore.getState().tasks).toEqual([])
    expect(useStore.getState().detailTaskId).toBeNull()
  })

  it('does not schedule fal recovery after a deleted task rejects late', async () => {
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    const falProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    vi.mocked(callImageApi).mockImplementationOnce((opts) => {
      opts.onFalRequestEnqueued?.({ requestId: 'fal-request', endpoint: 'fal-endpoint' })
      return request.promise
    })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [falProfile], activeProfileId: falProfile.id }),
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
    })

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(1))
    await removeTask(useStore.getState().tasks[0])
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    request.reject(new Error('Failed to fetch'))
    await request.promise.catch(() => {})

    expect(useStore.getState().tasks).toEqual([])
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    setTimeoutSpy.mockRestore()
  })

  it('does not schedule custom recovery after a deleted task rejects late', async () => {
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    const customProfile = {
      ...createDefaultOpenAIProfile({ id: 'custom-profile', apiKey: 'custom-key', apiMode: 'images' }),
      provider: 'custom-async',
    }
    vi.mocked(callImageApi).mockImplementationOnce((opts) => {
      opts.onCustomTaskEnqueued?.({ taskId: 'custom-task' })
      return request.promise
    })
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [customProfile],
        activeProfileId: customProfile.id,
        customProviders: [{
          id: 'custom-async',
          name: 'Custom Async',
          submit: { path: 'submit', taskIdPath: 'data.id' },
          poll: {
            path: 'tasks/{task_id}',
            statusPath: 'data.status',
            successValues: ['done'],
            failureValues: ['failed'],
            result: { imageUrlPaths: ['data.images.*.url'] },
          },
        }],
      }),
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
    })

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(1))
    await removeTask(useStore.getState().tasks[0])
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    request.reject(new Error('Failed to fetch'))
    await request.promise.catch(() => {})

    expect(useStore.getState().tasks).toEqual([])
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(useStore.getState().detailTaskId).toBeNull()
    setTimeoutSpy.mockRestore()
  })

  it('counts duplicate and missing ids only when they match an existing task', async () => {
    const deleted = task({ id: 'task-deleted' })
    const remaining = task({ id: 'task-remaining' })
    await putDbTask(deleted)
    await putDbTask(remaining)
    useStore.setState({ tasks: [deleted, remaining], selectedTaskIds: [deleted.id, 'task-missing'] })

    await removeMultipleTasks([deleted.id, deleted.id, 'task-missing'])

    const state = useStore.getState()
    expect(state.tasks.map((item) => item.id)).toEqual([remaining.id])
    expect(state.selectedTaskIds).toEqual([])
    expect((await getAllTasks()).map((item) => item.id)).toEqual([remaining.id])
    expect(state.showToast).toHaveBeenCalledWith('已删除 1 个任务', 'success')
  })

  it('does not show a success toast when no task id exists', async () => {
    const showToast = vi.fn()
    useStore.setState({ selectedTaskIds: ['task-missing'], showToast })

    await removeMultipleTasks(['task-missing', 'task-missing'])
    await removeTask(task({ id: 'another-missing-task' }))

    expect(useStore.getState().selectedTaskIds).toEqual([])
    expect(showToast).not.toHaveBeenCalled()
  })

  it('removes gallery output images stored while the task is being deleted', async () => {
    const { callImageApi } = await import('./lib/api')
    const postProcess = deferred<string>()
    vi.mocked(callImageApi).mockResolvedValueOnce({
      images: ['data:image/png;base64,late-gallery-output'],
      actualParams: {},
      actualParamsList: [],
      revisedPrompts: [],
    })
    vi.mocked(removeKeyedBackgroundFromDataUrl).mockImplementationOnce(() => postProcess.promise)
    useStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        apiKey: 'test-key',
        profiles: DEFAULT_SETTINGS.profiles.map((profile) => ({ ...profile, transparentBackgroundMethod: 'local' })),
      },
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS, output_format: 'png', transparent_output: true },
    })

    await submitTask()
    await vi.waitFor(() => expect(removeKeyedBackgroundFromDataUrl).toHaveBeenCalledTimes(1))
    const runningTask = useStore.getState().tasks[0]
    expect(runningTask?.status).toBe('running')
    expect(await getAllImageIds()).toHaveLength(1)

    await removeTask(runningTask)
    postProcess.resolve('data:image/png;base64,late-transparent-output')
    await postProcess.promise
    await vi.waitFor(async () => expect(await getAllImageIds()).toEqual([]))

    expect(useStore.getState().tasks).toEqual([])
    expect(await getAllImageIds()).toEqual([])
  })

  it('clears stream previews and ignores partial images arriving after deletion', async () => {
    const { callImageApi } = await import('./lib/api')
    let emitPartialImage: () => void = () => {}
    const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
    vi.mocked(callImageApi).mockImplementationOnce((opts) => {
      emitPartialImage = () => opts.onPartialImage?.({ image: 'data:image/png;base64,partial', requestIndex: 1 })
      return request.promise
    })
    useStore.setState({
      settings: { ...DEFAULT_SETTINGS, apiKey: 'test-key' },
      appMode: 'gallery',
      prompt: 'prompt',
      params: { ...DEFAULT_PARAMS },
    })

    await submitTask()
    await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledTimes(1))
    const runningTask = useStore.getState().tasks[0]
    emitPartialImage()
    expect(useStore.getState().streamPreviews[runningTask.id]).toContain('partial')
    expect(useStore.getState().streamPreviewSlots[runningTask.id]?.['1']).toContain('partial')

    await removeTask(runningTask)
    expect(useStore.getState().streamPreviews[runningTask.id]).toBeUndefined()
    expect(useStore.getState().streamPreviewSlots[runningTask.id]).toBeUndefined()
    emitPartialImage()
    expect(useStore.getState().streamPreviews[runningTask.id]).toBeUndefined()
    expect(useStore.getState().streamPreviewSlots[runningTask.id]).toBeUndefined()

    request.resolve({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    await request.promise
    await vi.waitFor(() => {
      expect(useStore.getState().tasks).toEqual([])
      expect(useStore.getState().streamPreviews[runningTask.id]).toBeUndefined()
      expect(useStore.getState().streamPreviewSlots[runningTask.id]).toBeUndefined()
    })
  })
})

describe('reused task API profile', () => {
  const openaiProfile = createDefaultOpenAIProfile({ id: 'openai-profile', apiKey: 'openai-key' })
  const falProfile = createDefaultFalProfile({ id: 'fal-profile', name: 'fal 配置', apiKey: 'fal-key' })

  beforeEach(async () => {
    await clearTasks()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [openaiProfile, falProfile],
        activeProfileId: openaiProfile.id,
        reuseTaskApiProfileTemporarily: true,
      }),
      prompt: '',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      showSettings: false,
      toast: null,
      reusedTaskApiProfileId: null,
      reusedTaskApiProfileName: null,
      reusedTaskApiProfileMissing: false,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
    })
  })

  it('resolves a task API profile by stored profile id', () => {
    const resolved = getTaskApiProfile(useStore.getState().settings, task({ apiProvider: 'fal', apiProfileId: falProfile.id }))

    expect(resolved?.id).toBe(falProfile.id)
  })

  it('does not resolve a task API profile by stored name or model', () => {
    const resolved = getTaskApiProfile(useStore.getState().settings, task({
      apiProvider: 'fal',
      apiProfileName: falProfile.name,
      apiModel: falProfile.model,
    }))

    expect(resolved).toBeNull()
  })

  it('keeps unlocked preset settings and task profile references on refresh', async () => {
    const provider = { id: 'provider-internal', name: 'Custom Provider', submit: { path: 'v1/generate' } }
    const profile = createDefaultOpenAIProfile({ id: 'profile-internal', isDefault: true, provider: provider.id, model: 'model-v1' })
    const sourceTask = task({ apiProvider: provider.id, apiProfileId: profile.id })
    await putDbTask(sourceTask)
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        profiles: [profile, openaiProfile],
        customProviders: [provider],
        activeProfileId: openaiProfile.id,
      }),
      tasks: [sourceTask],
      reusedTaskApiProfileId: profile.id,
    })

    await useStore.getState().setPresetImportedSettings({
      customProviders: [{ id: provider.id, name: provider.name, submit: { path: 'v2/generate' } }],
      profiles: [{ ...profile, provider: provider.id, model: 'model-v2' }],
    })

    const state = useStore.getState()
    expect(state.tasks[0]).toMatchObject({
      apiProfileId: profile.id,
      apiProvider: provider.id,
    })
    expect(state.settings.profiles[0]).toMatchObject({ id: profile.id, model: 'model-v1' })
    expect(state.settings.customProviders[0]).toMatchObject({ id: provider.id, submit: { path: 'generate' } })
    expect(state.reusedTaskApiProfileId).toBe(profile.id)
    expect((await getAllTasks())[0]).toMatchObject({
      apiProfileId: profile.id,
      apiProvider: provider.id,
    })
  })

  it('does not change an unlocked preset provider on refresh', async () => {
    const oldProvider = { id: 'provider-old', name: 'Old Provider', submit: { path: 'old' } }
    const profile = createDefaultOpenAIProfile({ id: 'stable-profile', isDefault: true, provider: oldProvider.id })
    const sourceTask = task({ apiProvider: oldProvider.id, apiProfileId: profile.id })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, customProviders: [oldProvider], profiles: [profile] }),
      tasks: [sourceTask],
    })

    await useStore.getState().setPresetImportedSettings({
      customProviders: [{ id: 'provider-new', name: 'New Provider', submit: { path: 'new' } }],
      profiles: [{ ...profile, provider: 'provider-new', model: 'model-new' }],
    })

    expect(getTaskApiProfile(useStore.getState().settings, sourceTask)).toMatchObject({
      id: profile.id,
      provider: 'provider-old',
      model: 'gpt-image-2',
    })
  })

  it('reuses the task API profile temporarily without switching the active profile', async () => {
    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBe(falProfile.id)
    expect(state.params).toMatchObject({ n: 4, size: '1360x1024', quality: 'high' })
    expect(state.showToast).toHaveBeenCalledWith('已临时复用该任务的 API 配置「fal 配置」', 'success')
  })

  it('keeps selected image mentions when reusing a task with different current input images', async () => {
    await clearImages()
    await putImage(imageA)
    await putImage(imageB)
    const taskPrompt = `参考 ${getSelectedImageMentionLabel(1)} 生成`

    useStore.setState({
      prompt: `当前 ${getSelectedImageMentionLabel(1)}`,
      inputImages: [
        { id: 'current-x', dataUrl: 'data:image/png;base64,x' },
        { id: 'current-y', dataUrl: 'data:image/png;base64,y' },
      ],
    })

    await reuseConfig(task({
      apiProvider: 'openai',
      apiProfileId: openaiProfile.id,
      prompt: taskPrompt,
      inputImageIds: [imageA.id, imageB.id],
    }))

    const state = useStore.getState()
    expect(state.inputImages.map((img) => img.id)).toEqual([imageA.id, imageB.id])
    expect(state.prompt).toBe(taskPrompt)
  })

  it('clears temporary reuse when switching current settings to the reused API profile', async () => {
    await reuseConfig(task({ apiProvider: 'fal', apiProfileId: falProfile.id }))

    useStore.getState().setSettings({ activeProfileId: falProfile.id })

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(falProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.reusedTaskApiProfileMissing).toBe(false)
  })

  it('normalizes reused params to the current API profile when temporary reuse is disabled', async () => {
    useStore.setState({
      settings: normalizeSettings({
        ...useStore.getState().settings,
        reuseTaskApiProfileTemporarily: false,
      }),
    })

    await reuseConfig(task({
      apiProvider: 'fal',
      apiProfileId: falProfile.id,
      params: { ...DEFAULT_PARAMS, n: 8, size: 'auto', quality: 'auto' },
    }))

    const state = useStore.getState()
    expect(state.settings.activeProfileId).toBe(openaiProfile.id)
    expect(state.reusedTaskApiProfileId).toBeNull()
    expect(state.params).toMatchObject({ n: 8, size: 'auto', quality: 'auto' })
  })

  it('asks whether to submit with current API profile when the reused API profile is missing', async () => {
    await reuseConfig(task({ apiProvider: 'fal', apiProfileId: 'missing-profile' }))

    const state = useStore.getState()
    expect(state.tasks).toEqual([])
    expect(state.setConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '找不到 API 配置',
      message: '找不到复用任务所使用的 API 配置「未知配置」，要使用当前的 API 配置「默认」提交任务吗？',
      confirmText: '使用当前配置提交',
      cancelText: '放弃提交',
    }))
    expect(state.showSettings).toBe(false)
  })
})

describe('task failure notification', () => {
  const responsesProfile = createDefaultOpenAIProfile({
    id: 'responses-profile',
    apiKey: 'test-key',
    apiMode: 'responses',
    model: DEFAULT_RESPONSES_MODEL,
  })

  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    vi.mocked(callImageApi).mockReset()
    vi.mocked(showBrowserNotification).mockClear()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [responsesProfile],
        activeProfileId: responsesProfile.id,
        taskCompletionNotification: true,
      }),
      appMode: 'gallery',
      prompt: 'prompt',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      detailTaskId: null,
      showToast: vi.fn(),
    })
  })

  it('notifies a gallery failure once without the error detail', async () => {
    vi.mocked(callImageApi).mockRejectedValueOnce(new Error('接口报错'))

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('error'))

    expect(showBrowserNotification).toHaveBeenCalledOnce()
    expect(showBrowserNotification).toHaveBeenCalledWith('图像生成失败', { body: '请回到应用查看详情。', tag: 'task-failure' })
  })

  it('does not notify a failure when the setting is off', async () => {
    useStore.setState({ settings: { ...useStore.getState().settings, taskCompletionNotification: false } })
    vi.mocked(callImageApi).mockRejectedValueOnce(new Error('接口报错'))

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('error'))

    expect(showBrowserNotification).not.toHaveBeenCalled()
  })

  it('reports batch failures once in the batch summary', async () => {
    vi.mocked(callImageApi)
      .mockRejectedValueOnce(new Error('第一条失败'))
      .mockResolvedValueOnce({ images: [], actualParams: {}, actualParamsList: [], revisedPrompts: [] })
    useStore.setState({
      settings: { ...useStore.getState().settings, showBatchPrompt: true, batchPromptEnabled: true, batchPromptMode: 'queue' },
      prompt: 'first\n\n\nsecond',
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().batchProgress).toBeNull())

    expect(showBrowserNotification).toHaveBeenCalledOnce()
    expect(showBrowserNotification).toHaveBeenCalledWith('批量生成完成', { body: '批量生成完成：成功 1 条，失败 1 条。', tag: 'task-completion' })
  })

  it('notifies when a recovered fal task finally fails', async () => {
    const falProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    useStore.setState({ settings: normalizeSettings({ ...useStore.getState().settings, profiles: [falProfile], activeProfileId: falProfile.id }) })
    await putDbTask(task({
      id: 'fal-task',
      apiProvider: 'fal',
      apiProfileId: 'fal-profile',
      status: 'error',
      error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。',
      falRequestId: 'fal-request-id',
      falEndpoint: 'fal-endpoint',
      falRecoverable: true,
      finishedAt: null,
      elapsed: null,
    }))
    vi.mocked(getFalQueuedImageResult).mockRejectedValueOnce(new Error('quota exceeded'))

    await initStore()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]).toMatchObject({ status: 'error', error: 'quota exceeded', falRecoverable: false }))

    expect(showBrowserNotification).toHaveBeenCalledOnce()
    expect(showBrowserNotification).toHaveBeenCalledWith('图像生成失败', { body: '请回到应用查看详情。', tag: 'task-failure' })
  })

  it('notifies a watchdog timeout once and ignores the late request failure', async () => {
    vi.useFakeTimers()
    try {
      const timeoutProfile = createDefaultOpenAIProfile({ id: 'timeout-profile', apiKey: 'test-key', timeout: 1 })
      useStore.setState({ settings: normalizeSettings({ ...useStore.getState().settings, profiles: [timeoutProfile], activeProfileId: timeoutProfile.id }) })
      const request = deferred<Awaited<ReturnType<typeof callImageApi>>>()
      vi.mocked(callImageApi).mockImplementationOnce(() => request.promise)

      await submitTask()
      await vi.waitFor(() => expect(callImageApi).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(1000)
      expect(useStore.getState().tasks[0]).toMatchObject({ status: 'error' })
      request.reject(new Error('late failure'))
      await vi.advanceTimersByTimeAsync(0)

      expect(showBrowserNotification).toHaveBeenCalledOnce()
      expect(showBrowserNotification).toHaveBeenCalledWith('图像生成失败', expect.objectContaining({ tag: 'task-failure' }))
    } finally {
      vi.useRealTimers()
    }
  })

})

describe('client connection errors', () => {
  beforeEach(async () => {
    await clearTasks()
    vi.mocked(callImageApi).mockReset()
    const profile = createDefaultOpenAIProfile({ id: 'client-profile', apiKey: 'test-key', apiMode: 'images' })
    useStore.setState({
      settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }),
      appMode: 'gallery',
      prompt: 'prompt',
      inputImages: [],
      maskDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      showToast: vi.fn(),
    })
  })

  it('shows an identified reason without the immediate failure hint', async () => {
    vi.mocked(callImageApi).mockRejectedValueOnce(new FetchConnectError('无法解析域名，请检查 API 地址是否正确。（错误码 11001）'))

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('error'))

    expect(useStore.getState().tasks[0].error).toBe('无法解析域名，请检查 API 地址是否正确。（错误码 11001）')
  })

  it('keeps the immediate failure hint for the fallback reason', async () => {
    vi.mocked(callImageApi).mockRejectedValueOnce(new FetchConnectError('无法连接到服务器。（unexpected eof）'))

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('error'))

    const error = useStore.getState().tasks[0].error!
    expect(error.startsWith('无法连接到服务器。（unexpected eof）\n提示：请求立即失败，可能原因：')).toBe(true)
    expect(error).not.toContain('Failed to fetch')
  })

  it('treats a connection error as recoverable for queued fal requests', async () => {
    const falProfile = createDefaultFalProfile({ id: 'fal-profile', apiKey: 'fal-key' })
    useStore.setState({ settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [falProfile], activeProfileId: falProfile.id }) })
    vi.mocked(callImageApi).mockImplementationOnce(async (opts) => {
      opts.onFalRequestEnqueued?.({ requestId: 'fal-request', endpoint: 'fal-endpoint' })
      // 消息不含“连接”“断开”等字样，只能靠错误类型判断为可恢复
      throw new FetchConnectError('无法解析域名，请检查 API 地址是否正确。（错误码 11001）')
    })

    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('error'))

    expect(useStore.getState().tasks[0]).toMatchObject({ falRecoverable: true, error: '与 fal.ai 的连接已断开，之后会继续查询任务结果。' })
    await removeTask(useStore.getState().tasks[0])
  })

  it.each([
    ['连接被服务器重置。（错误码 10054）', true],
    ['无法解析域名，请检查 API 地址是否正确。（错误码 11001）', false],
  ])('adds the gateway timeout hint after about 60 seconds only when the connection was dropped: %s', async (reason, hinted) => {
    const now = Date.now()
    const dateNow = vi.spyOn(Date, 'now')
    vi.mocked(callImageApi).mockImplementationOnce(async () => {
      dateNow.mockReturnValue(now + 60_000)
      throw new FetchConnectError(reason)
    })

    try {
      await submitTask()
      await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('error'))
    } finally {
      dateNow.mockRestore()
    }

    const error = useStore.getState().tasks[0].error!
    if (hinted) expect(error.startsWith(`${reason}\n提示：请求等待约 60 秒后被断开`)).toBe(true)
    else expect(error).toBe(reason)
  })
})

describe('privacy mode', () => {
  const responsesProfile = createDefaultOpenAIProfile({
    id: 'responses-profile',
    apiKey: 'test-key',
    apiMode: 'responses',
    model: DEFAULT_RESPONSES_MODEL,
  })

  beforeEach(async () => {
    await clearTasks()
    await clearImages()
    vi.mocked(callImageApi).mockReset()
    vi.mocked(showBrowserNotification).mockClear()
    useStore.setState({
      settings: normalizeSettings({
        ...DEFAULT_SETTINGS,
        profiles: [responsesProfile],
        activeProfileId: responsesProfile.id,
        taskCompletionNotification: true,
      }),
      privacyMode: null,
      appMode: 'gallery',
      prompt: 'secret prompt',
      inputImages: [imageA],
      maskDraft: null,
      maskEditorImageId: null,
      galleryInputDraft: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [task({ id: 'old-task', createdAt: 1 })],
      searchQuery: 'secret',
      filterFavorite: true,
      showSettings: true,
      detailTaskId: 'old-task',
      confirmDialog: { title: '确认', message: '内容' },
      showToast: vi.fn(),
    })
  })

  afterEach(() => {
    useStore.setState({ privacyMode: null })
  })

  it('clears views and input on entry, keeps the previous input persisted, and restores it on exit', () => {
    const epoch = useStore.getState().privacyModeEpoch
    useStore.getState().togglePrivacyMode()

    const state = useStore.getState()
    expect(state.privacyMode).not.toBeNull()
    expect(state.privacyModeEpoch).toBe(epoch + 1)
    expect(state).toMatchObject({
      prompt: '',
      inputImages: [],
      searchQuery: '',
      filterFavorite: false,
      showSettings: false,
      detailTaskId: null,
      confirmDialog: null,
    })
    const persisted = getPersistedState(state)
    expect(persisted.prompt).toBe('secret prompt')

    useStore.getState().setPrompt('typed in privacy mode')
    useStore.getState().togglePrivacyMode()

    expect(useStore.getState().privacyMode).toBeNull()
    expect(useStore.getState().prompt).toBe('secret prompt')
    expect(useStore.getState().inputImages).toEqual([imageA])
  })

  it('drops notifications of tasks started before entry and keeps those of new tasks', async () => {
    const pending = deferred<never>()
    vi.mocked(callImageApi).mockReturnValueOnce(pending.promise)
    useStore.setState({ tasks: [], inputImages: [] })
    await submitTask()
    const oldTaskId = useStore.getState().tasks[0].id

    useStore.getState().togglePrivacyMode()
    pending.reject(new Error('接口报错'))
    await vi.waitFor(() => expect(useStore.getState().tasks.find((item) => item.id === oldTaskId)?.status).toBe('error'))
    expect(showBrowserNotification).not.toHaveBeenCalled()
    expect(useStore.getState().detailTaskId).toBeNull()

    vi.mocked(callImageApi).mockRejectedValueOnce(new Error('接口报错'))
    useStore.getState().setPrompt('new prompt')
    await submitTask()
    await vi.waitFor(() => expect(useStore.getState().tasks[0]?.status).toBe('error'))
    expect(showBrowserNotification).toHaveBeenCalledOnce()
    expect(useStore.getState().detailTaskId).toBe(useStore.getState().tasks[0].id)
  })
})

describe('lightbox reference context', () => {
  afterEach(() => useStore.getState().setLightboxImageId(null))

  it('keeps markup and comments per task for the same image, and plain previews inherit no markup', () => {
    const open = useStore.getState().setLightboxImageId
    open('original', ['original'], 'comment A', { original: 'markup-a' })
    expect(useStore.getState().lightboxMarkupIds).toEqual({ original: 'markup-a' })
    open('original', ['original'], 'comment B', { original: 'markup-b' })
    expect(useStore.getState().lightboxMarkupIds).toEqual({ original: 'markup-b' })
    expect(useStore.getState().lightboxCommentPrompt).toBe('comment B')
    open('original')
    expect(useStore.getState().lightboxMarkupIds).toEqual({})
    expect(useStore.getState().lightboxCommentPrompt).toBeNull()
  })

  it('clears markup context when the lightbox closes', () => {
    useStore.getState().setLightboxImageId('original', ['original'], null, { original: 'markup' })
    useStore.getState().setLightboxImageId(null)
    expect(useStore.getState().lightboxMarkupIds).toEqual({})
  })
})
