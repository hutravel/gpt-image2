import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { ApiProfile, AppSettings, CustomProviderDefinition } from '../../types'
import { DEFAULT_IMAGES_MODEL, DEFAULT_FAL_MODEL, DEFAULT_RESPONSES_MODEL, switchApiProfileProvider } from '../../lib/apiProfiles'
import { useCloseOnEscape } from '../../hooks/useCloseOnEscape'
import { CloseIcon } from '../icons'

function readApiProfileJson(text: string) {
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON 必须是对象')
  }

  const record = parsed as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const apiUrl = typeof record.apiUrl === 'string'
    ? record.apiUrl.trim()
    : typeof record.baseUrl === 'string'
      ? record.baseUrl.trim()
      : ''
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : ''

  if (!name) throw new Error('缺少 name')
  if (!apiUrl) throw new Error('缺少 apiUrl')
  if (!apiKey) throw new Error('缺少 apiKey')

  return { name, apiUrl, apiKey }
}

function decodeBase64Text(value: string) {
  const normalized = value.trim().replace(/^data:[^,]+,/, '').replace(/\s+/g, '')
  if (!normalized) throw new Error('Base64 内容为空')

  try {
    const binary = atob(normalized)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    throw new Error('Base64 内容无法解码')
  }
}

const CUSTOM_ASYNC_ENDPOINT_PROVIDER_ID = 'custom-async-endpoint'
const LEGACY_FAST_AI_TASKS_PROVIDER_ID = 'custom-fast-ai-tasks'

function createCustomAsyncEndpointProvider(endpointPath: string): CustomProviderDefinition {
  return {
    id: CUSTOM_ASYNC_ENDPOINT_PROVIDER_ID,
    name: '自定义异步端点',
    submit: {
      path: `${endpointPath}/generations`,
      method: 'POST',
      contentType: 'json',
      body: {
        model: '$profile.model',
        prompt: '$prompt',
        size: '$params.size',
        quality: '$params.quality',
        output_format: '$params.output_format',
        output_compression: '$params.output_compression',
        moderation: '$params.moderation',
        n: '$params.n',
        image_urls: '$inputImages.dataUrls',
      },
      taskIdPath: 'id',
    },
    editSubmit: {
      path: `${endpointPath}/edits`,
      method: 'POST',
      contentType: 'multipart',
      body: {
        model: '$profile.model',
        prompt: '$prompt',
        size: '$params.size',
        quality: '$params.quality',
        output_format: '$params.output_format',
        output_compression: '$params.output_compression',
        moderation: '$params.moderation',
        n: '$params.n',
      },
      files: [
        { field: 'image[]', source: 'inputImages', array: true },
        { field: 'mask', source: 'mask' },
      ],
      taskIdPath: 'id',
    },
    poll: {
      path: `${endpointPath}/{task_id}`,
      method: 'GET',
      intervalSeconds: 2,
      statusPath: 'status',
      successValues: ['succeeded'],
      failureValues: ['failed'],
      errorPath: 'error',
      result: {
        imageUrlPaths: ['result.*.file_url'],
        b64JsonPaths: [],
      },
    },
  }
}


interface ForkApiSettingsProps {
  draft: AppSettings
  activeProfile: ApiProfile
  locked: boolean
  commitSettings: (settings: AppSettings) => void
  updateActiveProfile: (patch: Partial<ApiProfile>, commit?: boolean) => void
  showToast: (message: string, type: 'success' | 'error') => void
}

export default function ForkApiSettings({ draft, activeProfile, locked, commitSettings, updateActiveProfile, showToast }: ForkApiSettingsProps) {
  const [apiProfileBase64Input, setApiProfileBase64Input] = useState('')
  const [showEndpointSettings, setShowEndpointSettings] = useState(false)
  const [endpointSettingsSelection, setEndpointSettingsSelection] = useState<'images' | 'custom'>('images')
  const [customEndpointPathInput, setCustomEndpointPathInput] = useState('tasks')
  const [showModelSettings, setShowModelSettings] = useState(false)
  const [customModelInput, setCustomModelInput] = useState('')
  const activeCustomProvider = draft.customProviders.find((provider) => provider.id === activeProfile.provider)
  const activeEndpoint = activeProfile.provider === CUSTOM_ASYNC_ENDPOINT_PROVIDER_ID || activeProfile.provider === LEGACY_FAST_AI_TASKS_PROVIDER_ID ? 'custom' : 'images'
  const activeApiEndpointLabel = activeCustomProvider
    ? `自定义 API (/${activeCustomProvider.submit.path.replace(/^\/+/, '')})`
    : activeProfile.apiMode === 'responses' ? 'Responses API (/v1/responses)' : 'Images API (/v1/images)'
  const getDefaultModelForMode = (apiMode: AppSettings['apiMode']) =>
    apiMode === 'responses' ? DEFAULT_RESPONSES_MODEL : DEFAULT_IMAGES_MODEL

  const handleApiProfileBase64Import = () => {
    if (locked) return
    try {
      const imported = readApiProfileJson(decodeBase64Text(apiProfileBase64Input))
      updateActiveProfile({ name: imported.name, baseUrl: imported.apiUrl, apiKey: imported.apiKey }, true)
      setApiProfileBase64Input('')
      showToast('API 配置已导入', 'success')
    } catch (err) {
      showToast(`导入失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const openEndpointSettings = () => {
    const savedEndpointPath = activeCustomProvider?.submit.path.replace(/\/generations\/?$/, '').replace(/^\/+|\/+$/g, '')
    setEndpointSettingsSelection(activeEndpoint)
    setCustomEndpointPathInput(savedEndpointPath || 'tasks')
    setShowEndpointSettings(true)
  }

  const openModelSettings = () => {
    setCustomModelInput(activeProfile.model || '')
    setShowModelSettings(true)
  }

  const applyCustomModel = () => {
    const trimmed = customModelInput.trim()
    const fallbackModel = activeProfile.provider === 'fal' ? DEFAULT_FAL_MODEL : getDefaultModelForMode(activeProfile.apiMode)
    const nextModel = trimmed || fallbackModel
    updateActiveProfile({ model: nextModel }, true)
    setShowModelSettings(false)
    showToast('模型 ID 已更新', 'success')
  }

  const selectImagesEndpoint = () => {
    const nextProfile = { ...switchApiProfileProvider(activeProfile, 'openai'), apiMode: 'images' as const }
    commitSettings({
      ...draft,
      profiles: draft.profiles.map((profile) => profile.id === activeProfile.id ? nextProfile : profile),
    })
    setShowEndpointSettings(false)
  }

  const applyCustomEndpoint = () => {
    const endpointPath = customEndpointPathInput.trim().replace(/^\/+|\/+$/g, '')
    if (!endpointPath) {
      showToast('请输入自定义端点', 'error')
      return
    }

    const customEndpointProvider = createCustomAsyncEndpointProvider(endpointPath)
    const existingProvider = draft.customProviders.find((provider) => provider.id === CUSTOM_ASYNC_ENDPOINT_PROVIDER_ID)
    const nextCustomProviders = existingProvider
      ? draft.customProviders.map((provider) => provider.id === CUSTOM_ASYNC_ENDPOINT_PROVIDER_ID ? customEndpointProvider : provider)
      : [...draft.customProviders, customEndpointProvider]
    const nextProfile = {
      ...switchApiProfileProvider(activeProfile, CUSTOM_ASYNC_ENDPOINT_PROVIDER_ID, customEndpointProvider),
      model: activeProfile.model,
      responseFormatB64Json: activeProfile.responseFormatB64Json,
      responseFormatUrl: activeProfile.responseFormatUrl,
      apiMode: 'images' as const,
      apiProxy: false,
    }
    commitSettings({
      ...draft,
      customProviders: nextCustomProviders,
      profiles: draft.profiles.map((profile) => profile.id === activeProfile.id ? nextProfile : profile),
    })
    setShowEndpointSettings(false)
  }

  const selectApiEndpoint = (endpoint: 'images' | 'tasks') => {
    if (endpoint === 'images') {
      selectImagesEndpoint()
      return
    }
    setEndpointSettingsSelection('custom')
  }


  useCloseOnEscape(showModelSettings || showEndpointSettings, () => {
    setShowModelSettings(false)
    setShowEndpointSettings(false)
  })

  return (
    <>
      <fieldset disabled={locked} className="space-y-4 disabled:opacity-60">
              <div className="block">
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <span className="block text-sm text-gray-600 dark:text-gray-300">导入 API 配置</span>
                </div>
                <div className="rounded-xl border border-gray-200/70 bg-gray-50/70 px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <div className="text-xs text-gray-500 dark:text-gray-500">当前配置</div>
                  <div className="mt-1 truncate text-sm font-medium text-gray-800 dark:text-gray-100" title={activeProfile.name}>
                    {activeProfile.name}
                  </div>
                </div>
                <textarea
                  value={apiProfileBase64Input}
                  onChange={(e) => setApiProfileBase64Input(e.target.value)}
                  rows={4}
                  spellCheck={false}
                  placeholder="粘贴请求密钥"
                  className="mt-3 w-full resize-none rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2.5 font-mono text-xs leading-relaxed text-gray-700 outline-none transition placeholder:text-gray-400 focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:placeholder:text-gray-600 dark:focus:border-blue-500/50"
                />
                <button
                  type="button"
                  onClick={handleApiProfileBase64Import}
                  className="mt-3 w-full rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                >
                  导入配置
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-gray-200/70 bg-gray-50/70 px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs text-gray-500 dark:text-gray-500">API 接口</div>
                    <button
                      type="button"
                      onClick={openEndpointSettings}
                      className="min-h-8 shrink-0 cursor-pointer rounded-lg border border-gray-200/80 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
                    >
                      设置
                    </button>
                  </div>
                  <div className="mt-1 break-all text-sm font-medium text-gray-800 dark:text-gray-100">
                    {activeApiEndpointLabel}
                  </div>
                </div>
                <div className="rounded-xl border border-gray-200/70 bg-gray-50/70 px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs text-gray-500 dark:text-gray-500">模型 ID</div>
                    <button
                      type="button"
                      onClick={openModelSettings}
                      className="min-h-8 shrink-0 cursor-pointer rounded-lg border border-gray-200/80 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-gray-300 dark:hover:bg-white/[0.08] dark:hover:text-white"
                    >
                      设置
                    </button>
                  </div>
                  <div className="mt-1 break-all text-sm font-medium text-gray-800 dark:text-gray-100">{activeProfile.model || DEFAULT_IMAGES_MODEL}</div>
                </div>
              </div>


      </fieldset>
      {showEndpointSettings && createPortal(
          <div
            data-no-drag-select
            className="fixed inset-0 z-[110] flex items-center justify-center p-4"
            onClick={() => setShowEndpointSettings(false)}
          >
            <div className="absolute inset-0 bg-black/20 backdrop-blur-md animate-overlay-in dark:bg-black/40" />
            <div
              className="relative z-10 w-full max-w-sm rounded-3xl border border-white/50 bg-white/95 p-6 shadow-2xl ring-1 ring-black/5 animate-confirm-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mb-5 flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-base font-bold text-gray-800 dark:text-gray-100">设置 API 接口</h3>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">选择当前配置使用的图片生成端点。</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowEndpointSettings(false)}
                  className="min-h-11 min-w-11 shrink-0 rounded-full p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                  aria-label="关闭接口设置"
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => selectApiEndpoint('images')}
                  className={`flex min-h-14 w-full cursor-pointer items-center justify-between rounded-2xl border px-4 py-3 text-left transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${endpointSettingsSelection === 'images' ? 'border-blue-500/40 bg-blue-50 text-blue-700 dark:border-blue-400/40 dark:bg-blue-500/10 dark:text-blue-300' : 'border-gray-200/80 bg-gray-50/70 text-gray-700 hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]'}`}
                >
                  <span>
                    <span className="block text-sm font-semibold">Images</span>
                    <span className="mt-0.5 block text-xs font-normal opacity-70">默认 · /v1/images</span>
                  </span>
                  <span className={`h-4 w-4 rounded-full border-2 ${endpointSettingsSelection === 'images' ? 'border-blue-500 bg-blue-500 ring-4 ring-blue-500/10' : 'border-gray-300 dark:border-gray-600'}`} />
                </button>

                <div
                  role="radio"
                  aria-checked={endpointSettingsSelection === 'custom'}
                  tabIndex={0}
                  onClick={() => setEndpointSettingsSelection('custom')}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    setEndpointSettingsSelection('custom')
                  }}
                  className={`cursor-pointer rounded-2xl border px-4 py-3 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/20 ${endpointSettingsSelection === 'custom' ? 'border-blue-500/40 bg-blue-50 text-blue-700 dark:border-blue-400/40 dark:bg-blue-500/10 dark:text-blue-300' : 'border-gray-200/80 bg-gray-50/70 text-gray-700 hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:hover:bg-white/[0.06]'}`}
                >
                  <div className="flex min-h-8 items-center justify-between gap-3">
                    <span>
                      <span className="block text-sm font-semibold">自定义</span>
                      <span className="mt-0.5 block text-xs font-normal opacity-70">异步任务端点</span>
                    </span>
                    <span className={`h-4 w-4 rounded-full border-2 ${endpointSettingsSelection === 'custom' ? 'border-blue-500 bg-blue-500 ring-4 ring-blue-500/10' : 'border-gray-300 dark:border-gray-600'}`} />
                  </div>

                  {endpointSettingsSelection === 'custom' && (
                    <label className="mt-3 block" onClick={(event) => event.stopPropagation()}>
                      <span className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-300">相对端点</span>
                      <div className="flex items-center rounded-xl border border-blue-300/70 bg-white px-3 shadow-sm focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-blue-400/30 dark:bg-gray-900/70">
                        <input
                          value={customEndpointPathInput}
                          onChange={(event) => setCustomEndpointPathInput(event.target.value)}
                          placeholder="tasks"
                          autoFocus
                          className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100"
                        />
                      </div>
                    </label>
                  )}
                </div>
              </div>

              {endpointSettingsSelection === 'custom' && (
                <button
                  type="button"
                  onClick={applyCustomEndpoint}
                  className="mt-4 min-h-11 w-full cursor-pointer rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:ring-offset-2 dark:focus:ring-offset-gray-900"
                >
                  应用自定义端点
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}

        {showModelSettings && createPortal(
          <div
            data-no-drag-select
            className="fixed inset-0 z-[110] flex items-center justify-center p-4"
            onClick={() => setShowModelSettings(false)}
          >
            <div className="absolute inset-0 bg-black/20 backdrop-blur-md animate-overlay-in dark:bg-black/40" />
            <div
              className="relative z-10 w-full max-w-sm rounded-3xl border border-white/50 bg-white/95 p-6 shadow-2xl ring-1 ring-black/5 animate-confirm-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mb-5 flex items-center justify-between gap-4">
                <div>
                  <h3 className="text-base font-bold text-gray-800 dark:text-gray-100">设置模型 ID</h3>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">填写当前配置使用的模型 ID，留空使用默认值。</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowModelSettings(false)}
                  className="min-h-11 min-w-11 shrink-0 rounded-full p-2 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                  aria-label="关闭模型设置"
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              </div>

              <div className="space-y-3">
                <label className="block" onClick={(event) => event.stopPropagation()}>
                  <span className="mb-1.5 block text-xs font-medium text-gray-600 dark:text-gray-300">模型 ID</span>
                  <div className="flex items-center rounded-xl border border-blue-300/70 bg-white px-3 shadow-sm focus-within:ring-2 focus-within:ring-blue-500/20 dark:border-blue-400/30 dark:bg-gray-900/70">
                    <input
                      value={customModelInput}
                      onChange={(event) => setCustomModelInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          applyCustomModel()
                        }
                      }}
                      placeholder={activeProfile.provider === 'fal' ? DEFAULT_FAL_MODEL : getDefaultModelForMode(activeProfile.apiMode)}
                      autoFocus
                      className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100"
                    />
                  </div>
                  <div data-selectable-text className="mt-1.5 text-xs leading-relaxed text-gray-500 dark:text-gray-500">
                    发送请求时使用的模型标识。留空将使用对应模式的默认模型。
                  </div>
                </label>
              </div>

              <button
                type="button"
                onClick={applyCustomModel}
                className="mt-4 min-h-11 w-full cursor-pointer rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:ring-offset-2 dark:focus:ring-offset-gray-900"
              >
                应用模型 ID
              </button>
            </div>
          </div>,
          document.body,
        )}


    </>
  )
}
