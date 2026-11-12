import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { setUpdateModalOpen, useReleaseUpdates } from '../hooks/useReleaseUpdates'
import { useTooltip } from '../hooks/useTooltip'
import { detectOs } from '../lib/announcements'
import { getPageScroller, getPageScrollTop } from '../lib/pageScroll'
import { isTauri } from '../lib/platform'
import { RELEASES_PAGE_URL, shouldShowUpdate } from '../lib/releaseUpdates'
import { dismissAllTooltips } from '../lib/tooltipDismiss'
import ViewportTooltip from './ViewportTooltip'
import HelpModal from './HelpModal'
import { useFavoriteCollectionTitle } from './FavoriteCollections'
import { DesktopDownloadIcon, HelpCircleIcon, InstallIcon, SettingsIcon } from './icons'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

// 客户端目前只有 Windows 版，只向网页版的 Windows 用户显示下载入口
const SHOW_CLIENT_DOWNLOAD = !isTauri
  && detectOs(navigator.userAgent, (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform, navigator.maxTouchPoints) === 'windows'

function isInstalledPwa() {
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true
}

export default function Header() {
  const appMode = useStore((s) => s.appMode)
  const setAppMode = useStore((s) => s.setAppMode)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const activeFavoriteCollectionId = useStore((s) => s.activeFavoriteCollectionId)
  const favoriteCollectionTitle = useFavoriteCollectionTitle()
  const showFavoriteCollectionTitle = appMode === 'gallery' && Boolean(activeFavoriteCollectionId)
  const latestRelease = useReleaseUpdates((s) => s.releases[0])
  const hasUpdate = useReleaseUpdates((s) => shouldShowUpdate(s.releases[0], __APP_VERSION__, s.ignoredVersion))
  const [showHelp, setShowHelp] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [isPwaInstalled, setIsPwaInstalled] = useState(isInstalledPwa)
  const [scrollDirection, setScrollDirection] = useState<'up' | 'down'>('up')


  // 页面滚动条的起点随顶栏实际高度变化（index.css 的 --header-height），窄屏以外 CSS 不使用这个标记
  const headerState = appMode === 'gallery' && scrollDirection === 'down' ? 'compact' : undefined
  useEffect(() => {
    const root = document.documentElement
    if (headerState) root.dataset.header = headerState
    else delete root.dataset.header
  }, [headerState])

  useEffect(() => {
    let lastScrollY = getPageScrollTop()
    let ticking = false

    const handleScroll = () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          const currentScrollY = getPageScrollTop()
          if (currentScrollY < 20) {
            setScrollDirection('up')
          } else if (currentScrollY > lastScrollY + 10) {
            setScrollDirection('down')
          } else if (currentScrollY < lastScrollY - 10) {
            setScrollDirection('up')
          }
          lastScrollY = currentScrollY
          ticking = false
        })
        ticking = true
      }
    }

    const scroller = getPageScroller()
    scroller.addEventListener('scroll', handleScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', handleScroll)
  }, [appMode])

  const installTooltip = useTooltip()
  const clientTooltip = useTooltip()
  const helpTooltip = useTooltip()
  const settingsTooltip = useTooltip()

  useEffect(() => {
    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as BeforeInstallPromptEvent)
      setIsPwaInstalled(false)
    }

    const handleAppInstalled = () => {
      setInstallPrompt(null)
      setIsPwaInstalled(true)
    }

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    window.addEventListener('appinstalled', handleAppInstalled)

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
      window.removeEventListener('appinstalled', handleAppInstalled)
    }
  }, [])

  const handleInstallClick = async () => {
    if (installPrompt) {
      const promptEvent = installPrompt
      setInstallPrompt(null)

      try {
        await promptEvent.prompt()
        const choice = await promptEvent.userChoice
        setIsPwaInstalled(choice.outcome === 'accepted')
      } catch {
        setIsPwaInstalled(isInstalledPwa())
      }
    } else {
      const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      if (isIos) {
        setConfirmDialog({
          title: '安装为应用',
          message: '在 Safari 浏览器中，点击底部「分享」按钮，选择「添加到主屏幕」即可安装此应用。',
          showCancel: false,
          confirmText: '我知道了',
          icon: 'info',
          action: () => {},
        })
      } else {
        setConfirmDialog({
          title: '安装为应用',
          message: '请在浏览器的菜单中选择「添加到主屏幕」或「安装应用」。\n\n（如果在微信等内置浏览器中，请先在外部浏览器打开）',
          showCancel: false,
          confirmText: '我知道了',
          icon: 'info',
          action: () => {},
        })
      }
    }
  }

  return (
    <>
      <header data-no-drag-select className={`safe-area-top pr-[var(--page-scrollbar-width)] fixed top-0 left-0 right-0 z-40 bg-white/80 dark:bg-gray-950/80 backdrop-blur border-b border-gray-200 dark:border-white/[0.08] transition-transform duration-300 ease-in-out translate-y-0`}>
        <div className="safe-area-x safe-header-inner max-w-7xl mx-auto flex items-center justify-between relative">
          <div className="flex-1 min-w-0 pr-2 flex items-center gap-2">
            <h1 className="inline-flex min-w-0 items-start relative mr-2">
              {showFavoriteCollectionTitle ? (
                <>
                  <span className="min-w-0 truncate text-[17px] font-bold tracking-tight text-gray-800 dark:text-gray-100 sm:hidden" title={favoriteCollectionTitle}>{favoriteCollectionTitle}</span>
                  <span
                    className="hidden text-lg font-bold tracking-tight text-gray-800 transition-colors hover:text-gray-600 dark:text-gray-100 dark:hover:text-gray-300 sm:inline"
                  >
                    Image Paint
                  </span>
                </>
              ) : (
                <span
                  className="text-[17px] sm:text-lg font-bold tracking-tight text-gray-800 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                >
                  Image Paint
                </span>
              )}
              {/* 透明伪元素把点击区域扩大到 32px 以上，外观不变 */}
              {hasUpdate && latestRelease && (
                <button
                  type="button"
                  onClick={() => setUpdateModalOpen(true)}
                  className="absolute -right-1 -top-1 translate-x-full -translate-y-1/4 px-1 py-0.5 rounded-[4px] border border-red-500/30 text-[9px] font-black bg-red-500 text-white hover:bg-red-600 transition-all animate-fade-in leading-none shadow-sm before:absolute before:left-0 before:-right-[9px] before:-inset-y-[9px] before:content-['']"
                  title={`新版本 ${latestRelease.tag}`}
                >
                  NEW
                </button>
              )}
            </h1>

          </div>
          {showFavoriteCollectionTitle && (
            <div className="absolute left-1/2 top-1/2 hidden max-w-[30%] -translate-x-1/2 -translate-y-1/2 sm:flex">
              <div className="truncate rounded px-2 py-1 text-sm font-semibold text-gray-700 dark:text-gray-300" title={favoriteCollectionTitle}>
                {favoriteCollectionTitle}
              </div>
            </div>
          )}
          <div className="hidden sm:flex items-center gap-1 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06] p-1 mr-4">
            <button
              type="button"
              onClick={() => setAppMode('gallery')}
              className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${appMode === 'gallery' ? 'bg-white dark:bg-white/[0.12] text-gray-900 dark:text-white shadow-sm font-medium' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              画廊
            </button>
            <button
              type="button"
              onClick={() => setAppMode('square')}
              className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${appMode === 'square' ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm font-medium' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              广场
            </button>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {/* 客户端本身就是安装版，不显示 PWA 安装入口 */}
            {!isTauri && !isPwaInstalled && (
              <div
                className="relative"
                {...installTooltip.handlers}
              >
                <button
                  onClick={() => {
                    dismissAllTooltips()
                    handleInstallClick()
                  }}
                  className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
                  aria-label="安装为应用"
                >
                  <InstallIcon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                </button>
                <ViewportTooltip visible={installTooltip.visible} className="whitespace-nowrap">
                  安装为应用
                </ViewportTooltip>
              </div>
            )}
            {/* 窄屏时按钮区空间不足，同样不显示 */}
            {SHOW_CLIENT_DOWNLOAD && (
              <div
                className="relative hidden sm:block"
                {...clientTooltip.handlers}
              >
                <a
                  href={`${RELEASES_PAGE_URL}/latest`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => dismissAllTooltips()}
                  className="block p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
                  aria-label="下载客户端"
                >
                  <DesktopDownloadIcon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                </a>
                <ViewportTooltip visible={clientTooltip.visible} className="whitespace-nowrap">
                  下载客户端
                </ViewportTooltip>
              </div>
            )}
            <div
              className="relative"
              {...helpTooltip.handlers}
            >
              <button
                onClick={() => {
                  dismissAllTooltips()
                  setShowHelp(true)
                }}
                className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
                aria-label="操作指南"
              >
                <HelpCircleIcon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
              </button>
              <ViewportTooltip visible={helpTooltip.visible} className="whitespace-nowrap">
                操作指南
              </ViewportTooltip>
            </div>
            <div
              className="relative"
              {...settingsTooltip.handlers}
            >
              <button
                onClick={() => setShowSettings(true)}
                className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
                aria-label="设置"
              >
                <SettingsIcon className="w-5 h-5 text-gray-600 dark:text-gray-400" />
              </button>
              <ViewportTooltip visible={settingsTooltip.visible} className="whitespace-nowrap">
                设置
              </ViewportTooltip>
            </div>
          </div>
        </div>
        {/* 这一行的高度与 index.css 的 --header-row2-height、下方占位块的第二行一致，改动尺寸时需同步 */}
        <div className={`safe-area-x sm:hidden overflow-hidden transition-all duration-300 ease-in-out ${appMode === 'gallery' && scrollDirection === 'down' ? 'max-h-0 opacity-0 pb-0' : 'max-h-20 opacity-100 pb-2'}`}>
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-transparent bg-black/[0.04] dark:bg-white/[0.06] p-1 mx-2">
            <button
              type="button"
              onClick={() => setAppMode('gallery')}
              className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${appMode === 'gallery' ? 'bg-white dark:bg-white/[0.12] text-gray-900 dark:text-white shadow-sm font-medium' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              画廊
            </button>
            <button
              type="button"
              onClick={() => setAppMode('square')}
              className={`px-4 py-1.5 rounded-lg text-sm transition-colors ${appMode === 'square' ? 'bg-white dark:bg-white/10 text-gray-900 dark:text-white shadow-sm font-medium' : 'text-gray-500 hover:text-gray-800 dark:hover:text-gray-200'}`}
            >
              广场
            </button>
          </div>
        </div>
      </header>
      
      <div className="safe-area-top invisible pointer-events-none transition-all duration-300 ease-in-out max-h-[500px] opacity-100" aria-hidden="true">
        <div className="safe-header-inner" />
        <div className={`safe-area-x sm:hidden overflow-hidden transition-all duration-300 ease-in-out ${scrollDirection === 'down' ? 'max-h-0 pb-0' : 'max-h-20 pb-2'}`}>
          <div className="p-1">
            <div className="py-1.5 text-sm">占位</div>
          </div>
        </div>
      </div>
      {showHelp && <HelpModal appMode={appMode} isFavoriteCollectionOverview={appMode === 'gallery' && filterFavorite && !activeFavoriteCollectionId} onClose={() => setShowHelp(false)} />}
    </>
  )
}
