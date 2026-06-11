export const PAGE_SIZE = 8
export const DEFAULT_IMAGE_ASPECT_RATIO = '4 / 3'

const CURRENT_IMAGE_REPO_BASE_URL = 'https://raw.githubusercontent.com/mrslimslim/awesome-prompt/main'
const EVOLINK_IMAGE_REPO_BASE_URL = 'https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts/main'

export const PROMPT_SOURCES = [
  {
    id: 'current' as const,
    label: 'MeiGen',
    description: '本地提示词集合',
    dataUrl: './data/prompts-images.json',
    chunkUrls: [
      './data/prompts-images-1.json',
      './data/prompts-images-2.json',
      './data/prompts-images-3.json',
      './data/prompts-images-4.json',
      './data/prompts-images-5.json',
      './data/prompts-images-6.json',
      './data/prompts-images-7.json',
    ],
    chunkSize: 500,
    repoUrl: 'https://github.com/mrslimslim/awesome-prompt',
    imageBaseUrl: CURRENT_IMAGE_REPO_BASE_URL,
  },
  {
    id: 'evolink' as const,
    label: 'EvoLinkAI',
    description: 'awesome-gpt-image-2-API-and-Prompts',
    dataUrl: './data/prompts-evolink.json',
    repoUrl: 'https://github.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts',
    imageBaseUrl: EVOLINK_IMAGE_REPO_BASE_URL,
  },
  {
    id: 'banana' as const,
    label: 'Banana',
    description: 'banana-prompt-quicker',
    dataUrl: './data/prompts-banana.json',
    repoUrl: 'https://github.com/glidea/banana-prompt-quicker',
    imageBaseUrl: 'https://raw.githubusercontent.com/glidea/banana-prompt-quicker/main',
  },
]

export type PromptSource = typeof PROMPT_SOURCES[number]
export type PromptSourceId = PromptSource['id']
export type SquareLanguage = 'zh' | 'en' | 'unknown'
export type SquareMode = 'generate' | 'edit'

export interface SquarePrompt {
  id: string
  title: string
  prompt: string
  imageUrl: string
  imageWidth?: number
  imageHeight?: number
  sourceUrl?: string
  sourceId: PromptSourceId
  sourceLabel: string
  tags: string[]
  category: string
  subCategory?: string
  language: SquareLanguage
  mode: SquareMode
  nsfw: boolean
  referenceImageUrls: string[]
  searchText?: string
}

export const FALLBACK_PROMPTS: SquarePrompt[] = [
  {
    id: 'fallback-campaign-key-visual',
    title: '夏季活动主视觉',
    prompt: 'A refreshing summer campaign key visual for an ecommerce homepage, bright natural light, clean product stage, citrus colors, premium commercial photography, high detail, no text.',
    imageUrl: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=900&q=80',
    sourceId: 'current',
    sourceLabel: '本地示例',
    tags: ['活动', '主视觉', '电商'],
    category: '活动',
    language: 'zh',
    mode: 'generate',
    nsfw: false,
    referenceImageUrls: [],
  },
  {
    id: 'fallback-product-lifestyle',
    title: '生活方式产品图',
    prompt: 'A minimalist lifestyle product photo on a warm kitchen counter, soft morning sunlight, elegant shadows, editorial composition, premium brand tone, realistic photography.',
    imageUrl: 'https://images.unsplash.com/photo-1498837167922-ddd27525d352?auto=format&fit=crop&w=900&q=80',
    sourceId: 'current',
    sourceLabel: '本地示例',
    tags: ['产品', '生活方式'],
    category: '产品',
    language: 'zh',
    mode: 'generate',
    nsfw: false,
    referenceImageUrls: [],
  },
  {
    id: 'fallback-social-poster',
    title: '社媒海报背景',
    prompt: 'A clean social media poster background with layered paper textures, subtle gradient lighting, modern retail campaign style, empty center space for copy, high resolution.',
    imageUrl: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=900&q=80',
    sourceId: 'current',
    sourceLabel: '本地示例',
    tags: ['社媒', '海报'],
    category: '社媒',
    language: 'zh',
    mode: 'generate',
    nsfw: false,
    referenceImageUrls: [],
  },
]

const NSFW_RE = /nsfw|adult|sexy|nude|naked|lingerie|onlyfans|erotic|porn|成人|色情|性感|裸|内衣/i
const EDIT_RE = /reference image|provided image|source image|input image|use the image|edit this|based on the image|参考图|参考图片|使用图片|基于这张图|编辑这张/i

export function getString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(getString).filter(Boolean)
}

function getNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function getPromptFromMessages(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const messages = value as Array<Record<string, unknown>>
  const lastUser = [...messages]
    .reverse()
    .find((item) => getString(item.role).toLowerCase() === 'user' && getString(item.content))
  return getString(lastUser?.content) || getString(messages.find((item) => getString(item.content))?.content)
}

export function resolvePromptImageUrl(value: string, source: PromptSource): string {
  if (!value) return ''
  if (/^https?:\/\//i.test(value) || value.startsWith('data:') || value.startsWith('blob:')) return value
  const normalized = value.replace(/^\.?\//, '')
  return `${source.imageBaseUrl}/${normalized}`
}

function resolveSourceUrl(record: Record<string, unknown>, source: PromptSource): string | undefined {
  const directUrl =
    getString(record.sourceUrl) ||
    getString(record.tweet_url) ||
    getString(record.link)
  if (directUrl) return directUrl

  const readmeFile = getString(record.readme_file)
  const caseAnchor = getString(record.case_anchor)
  if (readmeFile && caseAnchor) {
    const normalizedFile = readmeFile.replace(/^\.?\//, '')
    return `${source.repoUrl}/blob/main/${normalizedFile}${caseAnchor}`
  }

  return undefined
}

function getPromptText(record: Record<string, unknown>): string {
  return (
    getString(record.prompt) ||
    getString(record.prompt_text) ||
    getString(record.extracted_prompt) ||
    getString(record.positivePrompt) ||
    getString(record.description) ||
    getPromptFromMessages(record.messages) ||
    getString(record.title) ||
    getString(record.suggested_title)
  )
}

function getImagePath(record: Record<string, unknown>): string {
  const imageDir = getString(record.image_dir)
  return (
    getString(record.preview) ||
    getString(record.image) ||
    getString(record.imageUrl) ||
    getString(record.media_url) ||
    getString(record.url) ||
    getString(record.cover) ||
    getString(record.cdnImage) ||
    getString(record.rawImage) ||
    getString(record.image_path) ||
    getStringArray(record.media_urls)[0] ||
    getStringArray(record.image_urls)[0] ||
    getStringArray(record.images)[0] ||
    getStringArray(record.cdnImages)[0] ||
    getStringArray(record.rawImages)[0] ||
    (imageDir ? `${imageDir.replace(/\/+$/, '')}/output.jpg` : '')
  )
}

function getReferenceImagePaths(record: Record<string, unknown>): string[] {
  return [
    ...getStringArray(record.reference_image_urls),
    ...getStringArray(record.referenceImages),
    ...getStringArray(record.input_images),
  ]
}

function inferLanguage(title: string, prompt: string): SquareLanguage {
  const text = `${title} ${prompt}`
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh'
  if (/[A-Za-z]/.test(text)) return 'en'
  return 'unknown'
}

function inferCategory(record: Record<string, unknown>, tags: string[]): string {
  return (
    getString(record.category) ||
    getString(record.suggested_category) ||
    getString(record.sub_category) ||
    tags[0] ||
    '未分类'
  )
}

function inferMode(record: Record<string, unknown>, prompt: string, referenceImageUrls: string[]): SquareMode {
  const rawMode = getString(record.mode).toLowerCase()
  if (/edit|image[-_\s]?to[-_\s]?image|i2i|img2img|编辑/.test(rawMode)) return 'edit'
  if (/generate|text[-_\s]?to[-_\s]?image|t2i|txt2img|文生图/.test(rawMode)) return 'generate'
  const mediaUrls = getStringArray(record.media_urls)
  if (referenceImageUrls.length > 0 || mediaUrls.length > 1 || EDIT_RE.test(prompt)) return 'edit'
  return 'generate'
}

function inferNsfw(record: Record<string, unknown>, title: string, prompt: string, tags: string[], category: string): boolean {
  if (typeof record.nsfw === 'boolean') return record.nsfw
  const rawNsfw = getString(record.nsfw)
  if (rawNsfw) return rawNsfw.toLowerCase() === 'true' || rawNsfw === '1'
  return NSFW_RE.test(`${title} ${prompt} ${category} ${tags.join(' ')}`)
}

export function getPromptSearchText(item: Pick<SquarePrompt, 'title' | 'prompt' | 'sourceLabel' | 'category' | 'subCategory' | 'tags'>): string {
  return `${item.title} ${item.prompt} ${item.sourceLabel} ${item.category} ${item.subCategory ?? ''} ${item.tags.join(' ')}`.toLowerCase()
}

export function getPromptSource(id: PromptSourceId): PromptSource {
  return PROMPT_SOURCES.find((source) => source.id === id) ?? PROMPT_SOURCES[0]
}

export function normalizePromptItem(item: unknown, index: number, source: PromptSource): SquarePrompt | null {
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const prompt = getPromptText(record)
  const image = getImagePath(record)

  if (!prompt || !image) return null

  const referenceImageUrls = getReferenceImagePaths(record).map((url) => resolvePromptImageUrl(url, source))
  const rawTags = [
    ...getStringArray(record.tags),
    getString(record.category),
    getString(record.sub_category),
    getString(record.suggested_category),
    getString(record.model),
  ].filter(Boolean)
  const tags = Array.from(new Set(rawTags))
  const title = getString(record.title) || getString(record.suggested_title) || getString(record.name) || `灵感 ${index + 1}`
  const category = inferCategory(record, tags)
  const mode = inferMode(record, prompt, referenceImageUrls)

  const normalized: SquarePrompt = {
    id: `${source.id}-${getString(record.id) || getString(record.slug) || getString(record.tweet_url) || index}`,
    title,
    prompt,
    imageUrl: resolvePromptImageUrl(image, source),
    imageWidth: getNumber(record.imageWidth) ?? getNumber(record.width),
    imageHeight: getNumber(record.imageHeight) ?? getNumber(record.height),
    sourceUrl: resolveSourceUrl(record, source),
    sourceId: source.id,
    sourceLabel: source.label,
    tags: tags.slice(0, 4),
    category,
    subCategory: getString(record.sub_category) || undefined,
    language: inferLanguage(title, prompt),
    mode,
    nsfw: inferNsfw(record, title, prompt, tags, category),
    referenceImageUrls,
  }
  normalized.searchText = getPromptSearchText(normalized)
  return normalized
}

function seededShuffle<T>(array: T[], seed: number): T[] {
  const result = [...array]
  let random = seed
  for (let i = result.length - 1; i > 0; i--) {
    random = (random * 9301 + 49297) % 233280
    const j = Math.floor((random / 233280) * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function getDailySeed(): number {
  const today = new Date()
  return today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate()
}

export function dedupePromptItems(items: SquarePrompt[]): SquarePrompt[] {
  const seen = new Set<string>()
  const deduped = items.filter((item) => {
    const key = `${item.imageUrl}\n${item.prompt}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return seededShuffle(deduped, getDailySeed())
}

export function normalizePromptData(data: unknown, source: PromptSource, options?: { startIndex?: number }): SquarePrompt[] {
  const rawItems = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? Object.values(data as Record<string, unknown>).flatMap((value) => Array.isArray(value) ? value : [])
      : []

  const items = rawItems
    .map((item, index) => normalizePromptItem(item, index + (options?.startIndex ?? 0), source))
    .filter((item): item is SquarePrompt => Boolean(item))

  return dedupePromptItems(items)
}

export function getImageAspectRatio(item: SquarePrompt): string {
  return item.imageWidth && item.imageHeight ? `${item.imageWidth} / ${item.imageHeight}` : DEFAULT_IMAGE_ASPECT_RATIO
}
