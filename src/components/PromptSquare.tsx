import { useEffect, useMemo, useRef, useState } from 'react'
import { copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import {
  FALLBACK_PROMPTS,
  PAGE_SIZE,
  PROMPT_SOURCES,
  dedupePromptItems,
  getImageAspectRatio,
  getPromptSearchText,
  getPromptSource,
  normalizePromptData,
  type PromptSource,
  type PromptSourceId,
  type SquareLanguage,
  type SquareMode,
  type SquarePrompt,
} from '../lib/promptSquareData'
import { createInputImageFromUrl, useStore } from '../store'
import { ArrowDownIcon, CloseIcon, CopyIcon, EditIcon, ExternalLinkIcon, RefreshIcon } from './icons'
import Select from './Select'

type LanguageFilter = 'all' | Exclude<SquareLanguage, 'unknown'>
type ModeFilter = 'all' | SquareMode
type NsfwFilter = 'show' | 'hide' | 'only'
type PromptCacheEntry = {
  items: SquarePrompt[]
  loadedAt: number
}

const LANGUAGE_OPTIONS: Array<{ value: LanguageFilter; label: string }> = [
  { value: 'all', label: '全部语言' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

const MODE_OPTIONS: Array<{ value: ModeFilter; label: string }> = [
  { value: 'all', label: '全部模式' },
  { value: 'generate', label: '文生图' },
  { value: 'edit', label: '编辑' },
]

const NSFW_OPTIONS: Array<{ value: NsfwFilter; label: string }> = [
  { value: 'show', label: '显示 NSFW' },
  { value: 'hide', label: '隐藏 NSFW' },
  { value: 'only', label: '仅 NSFW' },
]

const promptCache = new Map<PromptSourceId, PromptCacheEntry>()
const PROMPT_CACHE_TTL = 5 * 60 * 1000
const LOAD_MORE_SIZE = 8

function getSourceChunkUrls(source: PromptSource): string[] {
  return 'chunkUrls' in source && Array.isArray(source.chunkUrls) ? source.chunkUrls : []
}

function SquareImage({
  src,
  alt,
  aspectRatio,
  className,
  imgClassName,
}: {
  src: string
  alt: string
  aspectRatio?: string
  className?: string
  imgClassName?: string
}) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [retryKey, setRetryKey] = useState(0)
  const imageSrc = retryKey === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}retry=${retryKey}`

  useEffect(() => {
    setStatus('loading')
    setRetryKey(0)
  }, [src])

  return (
    <div
      className={`relative overflow-hidden bg-gray-100 dark:bg-white/[0.04] ${className ?? ''}`}
      style={aspectRatio ? { aspectRatio } : undefined}
    >
      {status !== 'loaded' && (
        <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-gray-400 dark:text-gray-500">
          {status === 'error' ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                setStatus('loading')
                setRetryKey((key) => key + 1)
              }}
              className="rounded-md border border-gray-200 bg-white/80 px-3 py-1.5 text-gray-500 transition hover:bg-white hover:text-gray-800 dark:border-white/[0.08] dark:bg-gray-900/80 dark:text-gray-400 dark:hover:text-gray-100"
              >
              图片加载失败，点击重试
              </button>
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gray-200/70 dark:bg-white/[0.06]">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500 dark:border-white/25 dark:border-t-white" />
            </div>
          )}
        </div>
      )}
      <img
        key={imageSrc}
        src={imageSrc}
        alt={alt}
        className={`absolute inset-0 h-full w-full ${imgClassName ?? 'object-cover'} ${status === 'loaded' ? 'opacity-100' : 'opacity-0'} transition-opacity duration-300`}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setStatus('loaded')}
        onError={() => setStatus('error')}
      />
    </div>
  )
}

function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-medium text-gray-400 dark:text-gray-500">{label}</div>
      <div className="flex h-10 w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-50 p-1 dark:border-white/[0.08] dark:bg-white/[0.03]">
        {options.map((option) => {
          const active = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={`h-8 min-w-0 flex-1 rounded-md px-2 text-xs font-medium transition ${active ? 'bg-white text-gray-900 shadow-sm dark:bg-white/[0.10] dark:text-white' : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'}`}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function getModeLabel(mode: SquareMode) {
  return mode === 'edit' ? '编辑' : '文生图'
}

export default function PromptSquare() {
  const showToast = useStore((s) => s.showToast)
  const setAppMode = useStore((s) => s.setAppMode)
  const setPrompt = useStore((s) => s.setPrompt)
  const setInputImages = useStore((s) => s.setInputImages)
  const [items, setItems] = useState<SquarePrompt[]>([])
  const [selected, setSelected] = useState<SquarePrompt | null>(null)
  const [activeSourceId, setActiveSourceId] = useState<PromptSourceId>('current')
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [deferredQuery, setDeferredQuery] = useState('')
  const [languageFilter, setLanguageFilter] = useState<LanguageFilter>('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all')
  const [nsfwFilter, setNsfwFilter] = useState<NsfwFilter>('show')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [showBackToTop, setShowBackToTop] = useState(false)
  const loadAbortRef = useRef<AbortController | null>(null)
  const loadRequestIdRef = useRef(0)
  const loadMoreRef = useRef<HTMLDivElement | null>(null)
  const activeSource = getPromptSource(activeSourceId)

  const resetSourceState = () => {
    setSelected(null)
    setQuery('')
    setLanguageFilter('all')
    setCategoryFilter('all')
    setModeFilter('all')
    setNsfwFilter('show')
    setVisibleCount(PAGE_SIZE)
  }

  const loadPrompts = async (source: PromptSource = activeSource, options?: { clear?: boolean; force?: boolean }) => {
    const requestId = loadRequestIdRef.current + 1
    loadRequestIdRef.current = requestId
    loadAbortRef.current?.abort()
    loadAbortRef.current = null

    setError(null)
    if (options?.clear) {
      setItems([])
      resetSourceState()
    }

    const cached = promptCache.get(source.id)
    if (!options?.force && cached && Date.now() - cached.loadedAt < PROMPT_CACHE_TTL) {
      setItems(cached.items)
      setVisibleCount(PAGE_SIZE)
      setLoading(false)
      return
    }

    const controller = new AbortController()
    loadAbortRef.current = controller
    setLoading(true)

    try {
      const chunkUrls = getSourceChunkUrls(source)
      if (chunkUrls.length > 0) {
        const firstResponse = await fetch(chunkUrls[0], { signal: controller.signal })
        if (!firstResponse.ok) throw new Error(`HTTP ${firstResponse.status}`)
        const chunkSize = 'chunkSize' in source && typeof source.chunkSize === 'number' ? source.chunkSize : 0
        const firstItems = normalizePromptData(await firstResponse.json(), source)
        if (firstItems.length === 0) throw new Error('没有解析到可展示的提示词')
        if (requestId !== loadRequestIdRef.current) return
        setItems(firstItems)
        setVisibleCount(PAGE_SIZE)
        setLoading(false)

        try {
          const restItems = await Promise.all(
            chunkUrls.slice(1).map(async (url, index) => {
              const response = await fetch(url, { signal: controller.signal })
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              return normalizePromptData(await response.json(), source, {
                startIndex: chunkSize > 0 ? (index + 1) * chunkSize : firstItems.length,
              })
            }),
          )
          const normalized = dedupePromptItems([...firstItems, ...restItems.flat()])
          if (requestId !== loadRequestIdRef.current) return
          promptCache.set(source.id, { items: normalized, loadedAt: Date.now() })
          setItems(normalized)
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError' || requestId !== loadRequestIdRef.current) return
          promptCache.set(source.id, { items: firstItems, loadedAt: Date.now() })
          setError(`部分数据加载失败：${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }

      const response = await fetch(source.dataUrl, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const normalized = normalizePromptData(await response.json(), source)
      if (normalized.length === 0) throw new Error('没有解析到可展示的提示词')
      if (requestId !== loadRequestIdRef.current) return
      promptCache.set(source.id, { items: normalized, loadedAt: Date.now() })
      setItems(normalized)
      setVisibleCount(PAGE_SIZE)
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError' || requestId !== loadRequestIdRef.current) return
      setError(err instanceof Error ? err.message : String(err))
      const fallbackItems = FALLBACK_PROMPTS.map((item) => ({
        ...item,
        searchText: item.searchText ?? getPromptSearchText(item),
      }))
      setItems(fallbackItems)
      setVisibleCount(PAGE_SIZE)
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setLoading(false)
        if (loadAbortRef.current === controller) loadAbortRef.current = null
      }
    }
  }

  useEffect(() => {
    void loadPrompts(activeSource, { clear: true })
  }, [activeSourceId])

  useEffect(() => {
    return () => loadAbortRef.current?.abort()
  }, [])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDeferredQuery(query), 180)
    return () => window.clearTimeout(timeoutId)
  }, [query])

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [activeSourceId])

  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([category]) => category)
  }, [items])
  const categorySelectOptions = useMemo(
    () => [
      { label: '全部分类', value: 'all' },
      ...categoryOptions.map((category) => ({ label: category, value: category })),
    ],
    [categoryOptions],
  )

  useEffect(() => {
    if (categoryFilter !== 'all' && !categoryOptions.includes(categoryFilter)) setCategoryFilter('all')
  }, [categoryFilter, categoryOptions])

  const filteredItems = useMemo(() => {
    const keyword = deferredQuery.trim().toLowerCase()
    return items.filter((item) => {
      if (keyword && !(item.searchText ?? getPromptSearchText(item)).includes(keyword)) return false
      if (languageFilter !== 'all' && item.language !== languageFilter) return false
      if (categoryFilter !== 'all' && item.category !== categoryFilter) return false
      if (modeFilter !== 'all' && item.mode !== modeFilter) return false
      if (nsfwFilter === 'hide' && item.nsfw) return false
      if (nsfwFilter === 'only' && !item.nsfw) return false
      return true
    })
  }, [items, deferredQuery, languageFilter, categoryFilter, modeFilter, nsfwFilter])
  const visibleItems = filteredItems.slice(0, visibleCount)
  const hasMore = visibleCount < filteredItems.length

  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [deferredQuery, languageFilter, categoryFilter, modeFilter, nsfwFilter, activeSourceId])

  useEffect(() => {
    if (!selected) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [selected])

  useEffect(() => {
    const onScroll = () => setShowBackToTop(window.scrollY > 600)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const target = loadMoreRef.current
    if (!target || !hasMore || loading) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setVisibleCount((count) => Math.min(count + LOAD_MORE_SIZE, filteredItems.length))
      },
      { rootMargin: '480px 0px' },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [filteredItems.length, hasMore, loading, visibleCount])

  const copyPrompt = async (prompt: string) => {
    try {
      await copyTextToClipboard(prompt)
      showToast('提示词已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制提示词失败', err), 'error')
    }
  }

  const applyPrompt = async (item: SquarePrompt) => {
    if (applying) return

    if (item.mode === 'generate') {
      setAppMode('gallery')
      setInputImages([])
      setPrompt(item.prompt)
      setSelected(null)
      showToast('已套用到生图输入框', 'success')
      return
    }

    setApplying(true)
    try {
      const referenceUrl = item.referenceImageUrls[0] || item.imageUrl
      const image = await createInputImageFromUrl(referenceUrl)
      setAppMode('gallery')
      setInputImages([image])
      setPrompt(item.prompt)
      setSelected(null)
      showToast('已套用提示词和参考图', 'success')
    } catch (err) {
      setAppMode('gallery')
      setInputImages([])
      setPrompt(item.prompt)
      setSelected(null)
      const reason = err instanceof Error ? err.message : String(err)
      showToast(`参考图加载失败，已仅套用提示词：${reason}`, 'info')
    } finally {
      setApplying(false)
    }
  }

  return (
    <main className="safe-area-x mx-auto max-w-7xl pt-4 pb-16">
      <div className="mb-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">广场</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">浏览可复用的生图提示词和参考图。</p>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            已展示 {Math.min(visibleCount, filteredItems.length)} / {filteredItems.length}
          </p>
        </div>
      </div>

      <div className="sticky top-[calc(env(safe-area-inset-top,0px)+4.5rem)] z-30 mb-5 rounded-lg border border-gray-200 bg-white/95 px-3 py-2.5 shadow-sm backdrop-blur dark:border-white/[0.08] dark:bg-gray-950/90 md:py-3">
        <div className="grid gap-2.5 md:gap-3">
          <div className="grid gap-3 md:grid-cols-12 md:gap-4">
            <div className="contents">
              <div className="min-w-0 md:order-1 md:col-span-6">
                <div className="mb-1 text-[11px] font-medium text-gray-400 dark:text-gray-500">来源</div>
                <div className="w-full rounded-lg border border-gray-200 bg-gray-50 p-1 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  <div className="grid grid-cols-3 gap-1 sm:grid-cols-6" role="tablist" aria-label="提示词来源">
                    {PROMPT_SOURCES.map((source) => {
                      const active = source.id === activeSourceId
                      return (
                        <button
                          key={source.id}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => setActiveSourceId(source.id)}
                          title={source.description}
                          className={`h-8 min-w-0 whitespace-nowrap rounded-md px-1 text-[11px] font-medium transition ${active ? 'bg-white text-gray-900 shadow-sm dark:bg-white/[0.10] dark:text-white' : 'text-gray-500 hover:bg-white/70 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200'}`}
                        >
                          {source.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
              <div className="min-w-0 md:order-6 md:col-span-4">
                <div className="mb-1 text-[11px] font-medium text-gray-400 dark:text-gray-500">搜索</div>
                <div className="flex gap-2">
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索提示词"
                    className="h-9 min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-gray-950/40 dark:text-gray-200 md:h-10"
                  />
                  <button
                    type="button"
                    onClick={() => void loadPrompts(activeSource, { force: true })}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition hover:bg-gray-50 hover:text-gray-800 dark:border-white/[0.08] dark:bg-gray-950/40 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200 md:h-10 md:w-10"
                    title="刷新"
                    aria-label="刷新广场"
                  >
                    <RefreshIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>
            </div>
            <div className="hidden md:contents">
              <div className="min-w-0 md:order-2 md:col-span-3">
                <SegmentedControl label="语言" options={LANGUAGE_OPTIONS} value={languageFilter} onChange={setLanguageFilter} />
              </div>
              <div className="min-w-0 md:order-3 md:col-span-3">
                <SegmentedControl label="模式" options={MODE_OPTIONS} value={modeFilter} onChange={setModeFilter} />
              </div>
              <div className="min-w-0 md:order-4 md:col-span-4">
                <SegmentedControl label="NSFW" options={NSFW_OPTIONS} value={nsfwFilter} onChange={setNsfwFilter} />
              </div>
              <div className="min-w-0 md:order-5 md:col-span-4">
                <div className="mb-1 text-[11px] font-medium text-gray-400 dark:text-gray-500">分类</div>
                <Select
                  value={categoryFilter}
                  onChange={(value) => setCategoryFilter(String(value))}
                  options={categorySelectOptions}
                  className="h-10 rounded-lg border border-gray-200 bg-gray-50 px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.06]"
                />
              </div>
            </div>
          </div>
          <details className="md:hidden">
            <summary className="flex h-9 cursor-pointer items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.06]">
              <span>筛选条件</span>
              <svg className="h-4 w-4 transition-transform [[open]>&]:rotate-180" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
            </summary>
            <div className="mt-2.5 grid gap-2.5">
              <SegmentedControl label="语言" options={LANGUAGE_OPTIONS} value={languageFilter} onChange={setLanguageFilter} />
              <SegmentedControl label="模式" options={MODE_OPTIONS} value={modeFilter} onChange={setModeFilter} />
              <SegmentedControl label="NSFW" options={NSFW_OPTIONS} value={nsfwFilter} onChange={setNsfwFilter} />
              <div className="min-w-0">
                <div className="mb-1 text-[11px] font-medium text-gray-400 dark:text-gray-500">分类</div>
                <Select
                  value={categoryFilter}
                  onChange={(value) => setCategoryFilter(String(value))}
                  options={categorySelectOptions}
                  className="h-9 rounded-lg border border-gray-200 bg-gray-50 px-3 text-xs font-medium text-gray-600 transition hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.06]"
                />
              </div>
            </div>
          </details>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-700 dark:border-yellow-500/20 dark:bg-yellow-500/10 dark:text-yellow-200">
          远程数据暂不可用，当前展示本地示例：{error}
        </div>
      )}

      {loading && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-sm text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200">
          <RefreshIcon className="h-4 w-4 animate-spin" />
          正在加载 {activeSource.label} 来源...
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true" aria-label="提示词加载中">
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.03]"
            >
              <div className="h-56 w-full animate-pulse bg-gray-200/70 dark:bg-white/[0.06] sm:h-52 xl:h-48" />
              <div className="space-y-3 p-3">
                <div className="h-4 w-3/4 animate-pulse rounded bg-gray-200/70 dark:bg-white/[0.06]" />
                <div className="flex gap-2">
                  <div className="h-5 w-14 animate-pulse rounded bg-gray-200/70 dark:bg-white/[0.06]" />
                  <div className="h-5 w-20 animate-pulse rounded bg-gray-200/70 dark:bg-white/[0.06]" />
                </div>
                <div className="space-y-2">
                  <div className="h-3 w-full animate-pulse rounded bg-gray-200/70 dark:bg-white/[0.06]" />
                  <div className="h-3 w-5/6 animate-pulse rounded bg-gray-200/70 dark:bg-white/[0.06]" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-gray-200/70 dark:bg-white/[0.06]" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 ${loading ? 'pointer-events-none opacity-60' : ''}`}>
          {visibleItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelected(item)}
              className="block w-full overflow-hidden rounded-lg border border-gray-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.03]"
            >
              <SquareImage
                src={item.imageUrl}
                alt={item.title}
                aspectRatio={getImageAspectRatio(item)}
                className="h-56 w-full sm:h-52 xl:h-48"
                imgClassName="object-cover"
              />
              <div className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="line-clamp-1 min-w-0 text-sm font-semibold text-gray-800 dark:text-gray-100">{item.title}</div>
                  <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">{item.sourceLabel}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">{getModeLabel(item.mode)}</span>
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">{item.category}</span>
                  {item.nsfw && <span className="rounded bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">NSFW</span>}
                </div>
                <div className="mt-2 line-clamp-3 text-xs leading-5 text-gray-500 dark:text-gray-400">{item.prompt}</div>
                {item.tags.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {item.tags.map((tag) => (
                      <span key={tag} className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {!loading && filteredItems.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400">
          没有匹配的提示词
        </div>
      )}

      <div ref={loadMoreRef} className="flex h-10 items-center justify-center pb-4">
        {hasMore && !loading && (
          <span className="text-xs text-gray-400 dark:text-gray-500">下拉继续加载</span>
        )}
      </div>

      {selected && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="absolute inset-0 bg-black/35 backdrop-blur-sm" />
          <div
            className="relative z-10 grid h-[88vh] w-full max-w-5xl grid-rows-[minmax(0,44vh)_minmax(0,1fr)] overflow-hidden rounded-lg border border-white/50 bg-white shadow-2xl dark:border-white/[0.08] dark:bg-gray-900 md:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)] md:grid-rows-none"
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onTouchMove={(event) => event.stopPropagation()}
          >
            <div className="min-h-0 overflow-hidden bg-gray-100 dark:bg-white/[0.04]">
              <SquareImage src={selected.imageUrl} alt={selected.title} className="h-full w-full" imgClassName="object-contain" />
            </div>
            <div className="flex min-h-0 flex-col overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-4 dark:border-white/[0.08]">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-bold text-gray-900 dark:text-gray-100">{selected.title}</h3>
                  <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">{selected.sourceLabel} · {getModeLabel(selected.mode)} · {selected.category}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="shrink-0 rounded-full p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                  aria-label="关闭"
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
                <div className="whitespace-pre-wrap rounded-lg bg-gray-50 p-4 text-sm leading-7 text-gray-700 dark:bg-white/[0.04] dark:text-gray-200">
                  {selected.prompt}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">{getModeLabel(selected.mode)}</span>
                  <span className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">{selected.language === 'zh' ? '中文' : selected.language === 'en' ? 'English' : '未知语言'}</span>
                  {selected.nsfw && <span className="rounded bg-rose-50 px-2 py-1 text-xs text-rose-600 dark:bg-rose-500/10 dark:text-rose-300">NSFW</span>}
                  {selected.tags.map((tag) => (
                    <span key={tag} className="rounded bg-gray-100 px-2 py-1 text-xs text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">{tag}</span>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2 border-t border-gray-100 p-4 dark:border-white/[0.08]">
                <a
                  href={activeSource.repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50 hover:text-gray-900 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                >
                  <ExternalLinkIcon className="h-4 w-4" />
                  来源仓库
                </a>
                {selected.sourceUrl && (
                  <a
                    href={selected.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50 hover:text-gray-900 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                  >
                    <ExternalLinkIcon className="h-4 w-4" />
                    来源
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => void copyPrompt(selected.prompt)}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50 hover:text-gray-900 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
                >
                  <CopyIcon className="h-4 w-4" />
                  复制提示词
                </button>
                <button
                  type="button"
                  onClick={() => void applyPrompt(selected)}
                  disabled={applying}
                  className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                >
                  <EditIcon className="h-4 w-4" />
                  {applying ? '套用中' : '套用'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        className={`fixed bottom-5 right-5 z-40 inline-flex h-11 w-11 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 shadow-lg transition hover:bg-gray-50 hover:text-gray-900 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 ${showBackToTop ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'}`}
        title="回到顶部"
        aria-label="回到顶部"
      >
        <ArrowDownIcon className="h-5 w-5 rotate-180" />
      </button>
    </main>
  )
}
