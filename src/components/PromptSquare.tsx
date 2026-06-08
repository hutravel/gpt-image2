import { useEffect, useMemo, useState } from 'react'
import { copyTextToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { useStore } from '../store'
import { CloseIcon, CopyIcon, ExternalLinkIcon, RefreshIcon } from './icons'

const PROMPT_SOURCE_URL = './data/prompts-images.json'
const IMAGE_REPO_BASE_URL = 'https://raw.githubusercontent.com/mrslimslim/awesome-prompt/main'
const PAGE_SIZE = 40

interface SquarePrompt {
  id: string
  title: string
  prompt: string
  imageUrl: string
  sourceUrl?: string
  tags: string[]
}

const FALLBACK_PROMPTS: SquarePrompt[] = [
  {
    id: 'fallback-campaign-key-visual',
    title: '夏季活动主视觉',
    prompt: 'A refreshing summer campaign key visual for an ecommerce homepage, bright natural light, clean product stage, citrus colors, premium commercial photography, high detail, no text.',
    imageUrl: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=900&q=80',
    tags: ['活动', '主视觉', '电商'],
  },
  {
    id: 'fallback-product-lifestyle',
    title: '生活方式产品图',
    prompt: 'A minimalist lifestyle product photo on a warm kitchen counter, soft morning sunlight, elegant shadows, editorial composition, premium brand tone, realistic photography.',
    imageUrl: 'https://images.unsplash.com/photo-1498837167922-ddd27525d352?auto=format&fit=crop&w=900&q=80',
    tags: ['产品', '生活方式'],
  },
  {
    id: 'fallback-social-poster',
    title: '社媒海报背景',
    prompt: 'A clean social media poster background with layered paper textures, subtle gradient lighting, modern retail campaign style, empty center space for copy, high resolution.',
    imageUrl: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=900&q=80',
    tags: ['社媒', '海报'],
  },
]

function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(getString).filter(Boolean)
}

function getPromptFromMessages(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const messages = value as Array<Record<string, unknown>>
  const lastUser = [...messages]
    .reverse()
    .find((item) => getString(item.role).toLowerCase() === 'user' && getString(item.content))
  return getString(lastUser?.content) || getString(messages.find((item) => getString(item.content))?.content)
}

function resolveImageUrl(value: string): string {
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  const normalized = value.replace(/^\.?\//, '')
  return `${IMAGE_REPO_BASE_URL}/${normalized}`
}

function normalizePromptItem(item: unknown, index: number): SquarePrompt | null {
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const prompt =
    getString(record.prompt) ||
    getString(record.positivePrompt) ||
    getString(record.description) ||
    getPromptFromMessages(record.messages)
  const image =
    getString(record.image) ||
    getString(record.imageUrl) ||
    getString(record.url) ||
    getString(record.cover) ||
    getStringArray(record.images)[0] ||
    getStringArray(record.cdnImages)[0]

  if (!prompt || !image) return null

  return {
    id: getString(record.id) || getString(record.slug) || `prompt-${index}`,
    title: getString(record.title) || getString(record.name) || `灵感 ${index + 1}`,
    prompt,
    imageUrl: resolveImageUrl(image),
    sourceUrl: getString(record.sourceUrl) || getString(record.link) || undefined,
    tags: getStringArray(record.tags).slice(0, 4),
  }
}

function normalizePromptData(data: unknown): SquarePrompt[] {
  const rawItems = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? Object.values(data as Record<string, unknown>).flatMap((value) => Array.isArray(value) ? value : [])
      : []

  const items = rawItems
    .map(normalizePromptItem)
    .filter((item): item is SquarePrompt => Boolean(item))

  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.imageUrl}\n${item.prompt}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function SquareImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading')
  const [retryKey, setRetryKey] = useState(0)
  const imageSrc = retryKey === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}retry=${retryKey}`

  useEffect(() => {
    setStatus('loading')
    setRetryKey(0)
  }, [src])

  return (
    <div className="relative overflow-hidden bg-gray-100 dark:bg-white/[0.04]">
      {status !== 'loaded' && (
        <div className="absolute inset-0 flex min-h-[180px] items-center justify-center p-4 text-center text-xs text-gray-400 dark:text-gray-500">
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
            <span>图片加载中</span>
          )}
        </div>
      )}
      <img
        key={imageSrc}
        src={imageSrc}
        alt={alt}
        className={`${className ?? ''} ${status === 'loaded' ? 'opacity-100' : 'opacity-0'} transition-opacity duration-300`}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setStatus('loaded')}
        onError={() => setStatus('error')}
      />
    </div>
  )
}

export default function PromptSquare() {
  const showToast = useStore((s) => s.showToast)
  const [items, setItems] = useState<SquarePrompt[]>([])
  const [selected, setSelected] = useState<SquarePrompt | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const loadPrompts = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(PROMPT_SOURCE_URL)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const normalized = normalizePromptData(await response.json())
      if (normalized.length === 0) throw new Error('没有解析到可展示的提示词')
      setItems(normalized)
      setVisibleCount(PAGE_SIZE)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setItems(FALLBACK_PROMPTS)
      setVisibleCount(PAGE_SIZE)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadPrompts()
  }, [])

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return items
    return items.filter((item) =>
      `${item.title} ${item.prompt} ${item.tags.join(' ')}`.toLowerCase().includes(keyword)
    )
  }, [items, query])
  const visibleItems = filteredItems.slice(0, visibleCount)
  const hasMore = visibleCount < filteredItems.length

  useEffect(() => {
    setVisibleCount(PAGE_SIZE)
  }, [query])

  useEffect(() => {
    if (!hasMore) return

    const onScroll = () => {
      const remaining = document.documentElement.scrollHeight - window.innerHeight - window.scrollY
      if (remaining < 900) setVisibleCount((count) => Math.min(count + PAGE_SIZE, filteredItems.length))
    }

    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [filteredItems.length, hasMore])

  useEffect(() => {
    if (!selected) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [selected])

  const copyPrompt = async (prompt: string) => {
    try {
      await copyTextToClipboard(prompt)
      showToast('提示词已复制', 'success')
    } catch (err) {
      showToast(getClipboardFailureMessage('复制提示词失败', err), 'error')
    }
  }

  return (
    <main className="safe-area-x mx-auto max-w-7xl pb-16">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">广场</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">浏览可复用的生图提示词和参考图。</p>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            已展示 {Math.min(visibleCount, filteredItems.length)} / {filteredItems.length}
          </p>
        </div>
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索提示词"
            className="h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 sm:w-64"
          />
          <button
            type="button"
            onClick={() => void loadPrompts()}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition hover:bg-gray-50 hover:text-gray-800 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            title="刷新"
            aria-label="刷新广场"
          >
            <RefreshIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-700 dark:border-yellow-500/20 dark:bg-yellow-500/10 dark:text-yellow-200">
          远程数据暂不可用，当前展示本地示例：{error}
        </div>
      )}

      <div className="columns-1 gap-4 sm:columns-2 lg:columns-3 xl:columns-4">
        {visibleItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSelected(item)}
            className="mb-4 block w-full break-inside-avoid overflow-hidden rounded-lg border border-gray-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.03]"
          >
            <SquareImage
              src={item.imageUrl}
              alt={item.title}
              className="w-full bg-gray-100 object-cover dark:bg-white/[0.04]"
            />
            <div className="p-3">
              <div className="line-clamp-1 text-sm font-semibold text-gray-800 dark:text-gray-100">{item.title}</div>
              <div className="mt-1 line-clamp-3 text-xs leading-5 text-gray-500 dark:text-gray-400">{item.prompt}</div>
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

      {!loading && filteredItems.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400">
          没有匹配的提示词
        </div>
      )}

      {hasMore && (
        <div className="mt-2 flex justify-center pb-4">
          <button
            type="button"
            onClick={() => setVisibleCount((count) => Math.min(count + PAGE_SIZE, filteredItems.length))}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-50 hover:text-gray-900 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.06] dark:hover:text-white"
          >
            加载更多
          </button>
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="absolute inset-0 bg-black/35 backdrop-blur-sm" />
          <div
            className="relative z-10 grid h-[88vh] w-full max-w-5xl grid-rows-[minmax(0,44vh)_minmax(0,1fr)] overflow-hidden rounded-2xl border border-white/50 bg-white shadow-2xl dark:border-white/[0.08] dark:bg-gray-900 md:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)] md:grid-rows-none"
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onTouchMove={(event) => event.stopPropagation()}
          >
            <div className="min-h-0 overflow-hidden bg-gray-100 dark:bg-white/[0.04]">
              <SquareImage src={selected.imageUrl} alt={selected.title} className="h-full w-full object-contain" />
            </div>
            <div className="flex min-h-0 flex-col overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-4 dark:border-white/[0.08]">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-bold text-gray-900 dark:text-gray-100">{selected.title}</h3>
                  <div className="mt-1 text-xs text-gray-500 dark:text-gray-400">提示词详情</div>
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
                {selected.tags.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {selected.tags.map((tag) => (
                      <span key={tag} className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">{tag}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap justify-end gap-2 border-t border-gray-100 p-4 dark:border-white/[0.08]">
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
                  className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
                >
                  <CopyIcon className="h-4 w-4" />
                  复制提示词
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
