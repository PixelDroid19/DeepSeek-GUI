import type { ReactElement } from 'react'
import { BarChart3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppRoute } from '../../store/chat-store-types'
import {
  formatCompactNumber,
  formatCost,
  formatPercent,
  useThreadUsageState
} from '../../hooks/use-thread-usage'
import { GitBranchPicker } from './GitBranchPicker'

export function shouldShowFloatingComposerUsageFooter({
  activeThreadId,
  compact,
  route,
  runtimeReady
}: {
  activeThreadId: string | null
  compact: boolean
  route: AppRoute
  runtimeReady: boolean
}): boolean {
  return !compact && route === 'chat' && Boolean(activeThreadId) && runtimeReady
}

export function FloatingComposerFooter({
  activeThreadId,
  activeThreadUpdatedAt,
  busy,
  compact,
  footerHint,
  route,
  runtimeReady,
  usageRefreshKey,
  workspaceRoot
}: {
  activeThreadId: string | null
  activeThreadUpdatedAt: string
  busy: boolean
  compact: boolean
  footerHint: string
  route: AppRoute
  runtimeReady: boolean
  usageRefreshKey: unknown
  workspaceRoot: string
}): ReactElement | null {
  const { t, i18n } = useTranslation('common')
  const showThreadUsageFooter = shouldShowFloatingComposerUsageFooter({
    activeThreadId,
    compact,
    route,
    runtimeReady
  })
  const threadUsageState = useThreadUsageState(
    activeThreadId,
    showThreadUsageFooter,
    `${activeThreadUpdatedAt}:${busy ? 'busy' : 'idle'}:${usageRefreshKey}`
  )
  const threadUsage = threadUsageState.usage

  if (compact) return null

  return (
    <div className="ds-composer-footer mt-1 flex min-h-7 flex-wrap items-center justify-between gap-x-2.5 gap-y-1.5 px-3">
      <div className="ds-composer-footer-left flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <GitBranchPicker workspaceRoot={workspaceRoot} />
        {showThreadUsageFooter ? (
          <div
            className="ds-composer-usage ds-no-drag inline-flex min-h-7 max-w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 overflow-visible rounded-lg border border-ds-border-muted bg-ds-card/72 px-2.5 py-0.5 text-[12.5px] font-medium leading-5 text-ds-muted shadow-sm"
            title={
              threadUsage
                ? t('sessionUsageDetailsTitle', {
                    tokens: formatCompactNumber(threadUsage.totalTokens),
                    cost: formatCost(threadUsage.costUsd, i18n.language, threadUsage.costCny),
                    saved: formatCost(
                      threadUsage.tokenEconomySavingsUsd,
                      i18n.language,
                      threadUsage.tokenEconomySavingsCny
                    ),
                    cache: formatPercent(threadUsage.cacheHitRate),
                    cached: formatCompactNumber(threadUsage.cachedTokens),
                    miss: formatCompactNumber(threadUsage.cacheMissTokens),
                    turns: threadUsage.turns
                  })
                : t('sessionUsageUnavailable')
            }
          >
            <BarChart3 className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={1.9} />
            {threadUsage ? (
              <>
                <span className="ds-composer-usage-tokens shrink-0 truncate tabular-nums">
                  {t('sessionUsageTokens', {
                    tokens: formatCompactNumber(threadUsage.totalTokens)
                  })}
                </span>
                <span className="ds-composer-usage-cost-separator text-ds-faint">·</span>
                <span className="ds-composer-usage-cost shrink-0 truncate tabular-nums">
                  {t('sessionUsageCost', {
                    cost: formatCost(threadUsage.costUsd, i18n.language, threadUsage.costCny)
                  })}
                </span>
                {threadUsage.tokenEconomySavingsTokens > 0 ? (
                  <>
                    <span className="ds-composer-usage-context-savings-separator text-ds-faint">·</span>
                    <span
                      className="ds-composer-usage-context-savings shrink-0 tabular-nums text-emerald-700 dark:text-emerald-300"
                      title={t('sessionUsageContextSavingsTitle', {
                        tokens: formatCompactNumber(threadUsage.tokenEconomySavingsTokens)
                      })}
                    >
                      {t('sessionUsageContextSavings', {
                        cost: formatCost(
                          threadUsage.tokenEconomySavingsUsd,
                          i18n.language,
                          threadUsage.tokenEconomySavingsCny
                        )
                      })}
                    </span>
                  </>
                ) : null}
                <span className="ds-composer-usage-cache-separator text-ds-faint">·</span>
                <span className="ds-composer-usage-cache shrink-0 truncate tabular-nums">
                  {t('sessionUsageCache', {
                    cache: formatPercent(threadUsage.cacheHitRate)
                  })}
                </span>
                <span className="ds-composer-usage-turns-separator text-ds-faint">·</span>
                <span className="ds-composer-usage-turns shrink-0 truncate tabular-nums">
                  {t('sessionUsageTurns', { turns: threadUsage.turns })}
                </span>
              </>
            ) : (
              <span className="shrink-0 text-ds-faint">
                {threadUsageState.loading
                  ? t('sessionUsageLoading')
                  : t('sessionUsageUnavailable')}
              </span>
            )}
          </div>
        ) : null}
      </div>
      {footerHint ? (
        <div className="ds-composer-footer-hint min-w-0 flex-1 text-right text-[12.5px] font-medium text-ds-faint">
          <span className="block truncate">{footerHint}</span>
        </div>
      ) : null}
    </div>
  )
}
