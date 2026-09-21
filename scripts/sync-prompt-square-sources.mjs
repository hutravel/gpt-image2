import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDirectory = path.join(workspaceRoot, 'public', 'data')

const sources = {
  freestyleFly: {
    url: 'https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main/data/cases.json',
    outputFile: 'prompts-freestylefly.json',
  },
  youMind: {
    collections: [
      {
        id: 'gpt-image-2',
        label: 'GPT Image 2',
        url: 'https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main/README_zh.md',
        imageBaseUrl: 'https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main',
      },
      {
        id: 'nano-banana-pro',
        label: 'Nano Banana Pro',
        url: 'https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main/README_zh.md',
        imageBaseUrl: 'https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main',
      },
    ],
    outputFile: 'prompts-youmind.json',
  },
  zeroLu: {
    urls: [
      'https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main/README.zh-CN.md',
      'https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main/README.md',
    ],
    imageBaseUrl: 'https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main',
    outputFile: 'prompts-zerolu.json',
  },
  shuiXian: {
    // 水仙提示词：5430 条，数据已为结构化 JSON，图片走 Cloudflare R2
    base: 'https://cdn.jsdelivr.net/gh/BaYue-SYJ/shuixian-prompts@main/shuixian-unified/data',
    parts: ['prompts.part1.json', 'prompts.part2.json', 'prompts.part3.json'],
    meta: 'meta.json',
    outputFile: 'prompts-shuixian.json',
  },
}

async function fetchText(url, maximumAttempts = 3) {
  let lastError

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'gpt-image-playground-source-sync' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      lastError = error
      if (attempt < maximumAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
      }
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Unable to download ${url} after ${maximumAttempts} attempts: ${reason}`)
}

async function fetchJson(url) {
  const text = await fetchText(url)
  return JSON.parse(text)
}

function getMarkdownImageUrl(markdown) {
  const htmlImageMatch = markdown.match(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/i)
  if (htmlImageMatch?.[1]) return htmlImageMatch[1]

  for (const match of markdown.matchAll(/!\[[^\]]*]\((https?:\/\/[^)\s]+|[^)\s]+)\)/gi)) {
    const imageUrl = match[1]
    if (!imageUrl.includes('img.shields.io') && !imageUrl.includes('awesome.re/badge')) return imageUrl
  }
  return ''
}

function getFirstMarkdownLink(markdown) {
  return markdown.match(/\[[^\]]+]\((https?:\/\/[^)]+)\)/)?.[1] ?? ''
}

function resolveMarkdownImageUrl(imageUrl, imageBaseUrl) {
  if (!imageUrl || /^https?:\/\//i.test(imageUrl)) return imageUrl
  return `${imageBaseUrl}/${imageUrl.replace(/^\.?\//, '')}`
}

function dedupePrompts(prompts) {
  const seenImages = new Set()
  const seenPrompts = new Set()

  return prompts.filter((prompt) => {
    const imageKey = prompt.image.trim().toLowerCase()
    const promptKey = prompt.prompt.replace(/\s+/g, ' ').trim().toLowerCase()
    if (seenImages.has(imageKey) || seenPrompts.has(promptKey)) return false
    seenImages.add(imageKey)
    seenPrompts.add(promptKey)
    return true
  })
}

function parseYouMindReadme(markdown, collection) {
  const promptHeadingPattern = /^### No\.\s*(\d+):\s*(.+)$/gm
  const headings = [...markdown.matchAll(promptHeadingPattern)]

  return headings.flatMap((heading, headingIndex) => {
    const sectionStart = heading.index ?? 0
    const sectionEnd = headings[headingIndex + 1]?.index ?? markdown.length
    const section = markdown.slice(sectionStart, sectionEnd)
    const prompt = section.match(/####\s*📝\s*提示词\s*\r?\n+```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/i)?.[1]?.trim() ?? ''
    const imageSection = section.match(/####\s*🖼️\s*生成图片([\s\S]*?)(?:\r?\n####\s*📌|\r?\n---|$)/i)?.[1] ?? ''
    const imageUrl = resolveMarkdownImageUrl(getMarkdownImageUrl(imageSection), collection.imageBaseUrl)
    if (!prompt || !imageUrl) return []

    const details = section.match(/####\s*📌\s*详情([\s\S]*?)(?:\r?\n---|$)/i)?.[1] ?? ''
    const sourceLine = details.match(/^-\s*\*\*来源:\*\*\s*(.+)$/im)?.[1] ?? ''
    return [{
      id: `youmind-${collection.id}-${headingIndex + 1}`,
      title: heading[2].trim(),
      prompt,
      image: imageUrl,
      sourceUrl: getFirstMarkdownLink(sourceLine),
      category: `YouMind · ${collection.label}`,
    }]
  })
}

function parseZeroLuReadme(markdown, languageId, imageBaseUrl) {
  const entryHeadingPattern = /^###\s+(.+)$/gm
  const headings = [...markdown.matchAll(entryHeadingPattern)]

  return headings.flatMap((heading, headingIndex) => {
    const sectionStart = heading.index ?? 0
    const sectionEnd = headings[headingIndex + 1]?.index ?? markdown.length
    const section = markdown.slice(sectionStart, sectionEnd)
    const promptMarker = section.match(/\*\*(?:提示词|Prompt):\*\*/i)
    const prompt = section.match(/\*\*(?:提示词|Prompt):\*\*\s*\r?\n+```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/i)?.[1]?.trim() ?? ''
    const imageUrl = resolveMarkdownImageUrl(
      getMarkdownImageUrl(section.slice(0, promptMarker?.index ?? section.length)),
      imageBaseUrl,
    )
    if (!prompt || !imageUrl) return []

    const sourceLine = section.match(/\*\*(?:来源|Source):\*\*\s*(.+)$/im)?.[1] ?? ''
    const previousCategoryHeading = markdown.slice(0, sectionStart).match(/^##\s+(.+)$/gm)?.at(-1)
    const category = previousCategoryHeading?.replace(/^##\s+/, '').trim() || '未分类'
    return [{
      id: `zerolu-${languageId}-${headingIndex + 1}`,
      title: heading[1].trim(),
      prompt,
      image: imageUrl,
      sourceUrl: getFirstMarkdownLink(sourceLine),
      category,
    }]
  })
}

async function writeJson(fileName, value) {
  const outputPath = path.join(dataDirectory, fileName)
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return outputPath
}

function buildShuiXianMajorMap(meta) {
  const map = new Map()
  for (const major of meta.majors) {
    map.set(major.name, major.name)
    for (const sub of major.subs) map.set(sub.name, major.name)
  }
  return map
}

function transformShuiXianItem(item, majorMap) {
  const sub = String(item.category ?? '').trim()
  const major = majorMap.get(sub) ?? sub ?? '未分类'
  return {
    id: item.id,
    title: item.title,
    prompt: item.prompt,
    image: item.image || item.thumb,
    category: major,
    sub_category: sub,
    sourceUrl: item.tweet || undefined,
    likes: item.likes,
    themes: item.themes,
    styles: item.styles,
  }
}

async function syncShuiXian() {
  const { base, parts, meta, outputFile } = sources.shuiXian
  const [metaJson, ...partsJson] = await Promise.all([
    fetchJson(`${base}/${meta}`),
    ...parts.map((part) => fetchJson(`${base}/${part}`)),
  ])
  const majorMap = buildShuiXianMajorMap(metaJson)
  const raw = partsJson.flat()
  const seen = new Set()
  const items = []
  for (const item of raw) {
    if (!item.prompt || !item.image) continue
    const key = `${item.image}\n${item.prompt}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push(transformShuiXianItem(item, majorMap))
  }
  if (items.length === 0) throw new Error('ShuiXian source did not contain any prompts')
  await writeJson(outputFile, items)
  return items.length
}

async function syncSources() {
  const [freestyleFlyText, youMindReadmes, zeroLuReadmes, shuiXianCount] = await Promise.all([
    fetchText(sources.freestyleFly.url),
    Promise.all(sources.youMind.collections.map(async (collection) => ({
      collection,
      markdown: await fetchText(collection.url),
    }))),
    Promise.all(sources.zeroLu.urls.map((url) => fetchText(url))),
    syncShuiXian(),
  ])

  const freestyleFlyData = JSON.parse(freestyleFlyText)
  const youMindPrompts = dedupePrompts(
    youMindReadmes.flatMap(({ collection, markdown }) => parseYouMindReadme(markdown, collection)),
  )
  const zeroLuPrompts = dedupePrompts(
    zeroLuReadmes.flatMap((markdown, index) => (
      parseZeroLuReadme(markdown, index === 0 ? 'zh' : 'en', sources.zeroLu.imageBaseUrl)
    )),
  )

  if (!Array.isArray(freestyleFlyData.cases) || freestyleFlyData.cases.length === 0) {
    throw new Error('FreestyleFly source did not contain any cases')
  }
  if (youMindPrompts.length === 0) throw new Error('YouMind README did not contain parsable prompts')
  if (zeroLuPrompts.length === 0) throw new Error('ZeroLu README did not contain parsable prompts')

  await Promise.all([
    writeJson(sources.freestyleFly.outputFile, freestyleFlyData),
    writeJson(sources.youMind.outputFile, youMindPrompts),
    writeJson(sources.zeroLu.outputFile, zeroLuPrompts),
  ])

  console.log(`FreestyleFly: ${freestyleFlyData.cases.length} prompts`)
  console.log(`YouMind: ${youMindPrompts.length} prompts`)
  console.log(`ZeroLu: ${zeroLuPrompts.length} prompts`)
  console.log(`ShuiXian: ${shuiXianCount} prompts`)
}

await syncSources()
