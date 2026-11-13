import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { InputImage } from '../types'
import { ensureImageThumbnailCached, subscribeImageThumbnail } from '../lib/imageCache'
import { useNearViewport } from '../hooks/useNearViewport'
import { expandImageCommentMentions, getPromptMentionParts } from '../lib/promptImageMentions'

interface Props {
  prompt: string
  /** 与 prompt 中 @图N 序号对应的输入图 id 列表 */
  inputImageIds: string[]
  /** 已知图片地址（如弹框已加载的原图），未提供时走缩略图缓存 */
  knownSources?: Record<string, string>
  onImageClick?: (imageId: string) => void
}

/**
 * 任务提示词的胶囊渲染：与输入框一致，@图N 显示为「图片N」胶囊（内嵌小缩略图），
 * 评论胶囊展开为备注文本。不用 contentEditable，仅作展示。
 */
export default function TaskPromptMentions({ prompt, inputImageIds, knownSources, onImageClick }: Props) {
  const placeholders = inputImageIds.map((id) => ({ id, dataUrl: '' }))
  const parts = getPromptMentionParts(expandImageCommentMentions(prompt), placeholders as InputImage[])

  return (
    <>
      {parts.map((part, i) =>
        part.type === 'text' ? (
          <span key={i}>{part.text}</span>
        ) : part.imageIndex != null ? (
          <ImageMentionTag
            key={i}
            imageId={inputImageIds[part.imageIndex]}
            imageIndex={part.imageIndex}
            knownSrc={part.imageIndex != null ? knownSources?.[inputImageIds[part.imageIndex]] : undefined}
            onClick={onImageClick}
          />
        ) : (
          <span key={i} className="mention-tag">{part.text}</span>
        )
      )}
    </>
  )
}

function ImageMentionTag({
  imageId,
  imageIndex,
  knownSrc,
  onClick,
}: {
  imageId: string
  imageIndex: number
  knownSrc?: string
  onClick?: (imageId: string) => void
}) {
  // 弹框等场景已传入原图地址时不读缩略图缓存
  const { src: lazySrc, ref } = useImageThumbnail(knownSrc ? '' : imageId)
  const cachedSrc = knownSrc || lazySrc
  const displayLabel = `图片${imageIndex + 1}`

  return (
    <span
      ref={ref}
      className="mention-tag mention-image-tag"
      onClick={onClick && imageId ? () => onClick(imageId) : undefined}
      role={onClick && imageId ? 'button' : undefined}
    >
      {cachedSrc && <img className="mention-image-thumbnail" src={cachedSrc} alt="" draggable="false" />}
      <span className="mention-image-label" data-display-label={displayLabel}>{`@图${imageIndex + 1}`}</span>
    </span>
  )
}

/** 懒加载缩略图：接近可视区域才读取，未加载完成时返回空（胶囊先显示文本） */
function useImageThumbnail(imageId: string) {
  const [src, setSrc] = useState('')
  const ref = useRef<HTMLSpanElement>(null)
  const nearViewport = useNearViewport(ref)

  useEffect(() => {
    if (!imageId || !nearViewport) return
    let cancelled = false
    const apply = (thumbnail: { src: string }) => {
      if (!cancelled) setSrc(thumbnail.src)
    }
    const unsubscribe = subscribeImageThumbnail(imageId, apply)
    ensureImageThumbnailCached(imageId).then((thumbnail) => {
      if (!cancelled && thumbnail) apply(thumbnail)
    }).catch(() => {})
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [imageId, nearViewport])

  return { src, ref }
}
