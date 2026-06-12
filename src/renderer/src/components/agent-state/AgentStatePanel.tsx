import type { ReactElement } from 'react'
import {
  Activity,
  Brain,
  CheckCircle2,
  CircleDashed,
  Gauge,
  Layers,
  ListChecks,
  PanelRightClose,
  Target,
  XCircle
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chat-store'
import { useThreadUsageState } from '../../hooks/use-thread-usage'
import type { PipelineStageInfo } from '../../agent/types'

type Props = {
  className?: string
  onCollapse: () => void
}

export function AgentStatePanel({ className = '', onCollapse }: Props): ReactElement {
  const { t } = useTranslation('common')
  const goal = useChatStore((s) => s.activeThreadGoal)
  const todos = useChatStore((s) => s.activeThreadTodos)
  const agentState = useChatStore((s) => s.activeAgentState)
  const pipelineStages = useChatStore((s) => s.pipelineStages)
  const activeThreadId = useChatStore((s) => s.activeThreadId)
  const usageRefreshKey = useChatStore((s) => s.usageRefreshKey)
  const usageState = useThreadUsageState(activeThreadId, Boolean(activeThreadId), usageRefreshKey)
  const usage = usageState.usage

  const todoItems = todos?.items ?? []
  const todoCompleted = todoItems.filter((item) => item.status === 'completed').length
  const hasAnything = Boolean(goal || todoItems.length || agentState || pipelineStages.length || usage)

  return (
    <aside
      className={`ds-no-drag flex min-h-0 flex-col border-l border-ds-border-muted bg-white dark:bg-ds-canvas ${className}`}
    >
      <div className="shrink-0 border-b border-ds-border-muted bg-white/92 dark:bg-ds-card">
        <div className="flex h-12 min-w-0 items-center gap-2 px-4">
          <button
            type="button"
            onClick={onCollapse}
            className="ds-sidebar-toggle-button shrink-0"
            aria-label={t('rightPanelCollapse')}
            title={t('rightPanelCollapse')}
          >
            <PanelRightClose className="h-4 w-4" strokeWidth={1.85} />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Activity className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.85} />
            <span className="truncate text-[13px] font-semibold text-ds-ink">
              {t('rightPanelAgentState', 'Agent State')}
            </span>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {!hasAnything ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <Activity className="h-6 w-6 text-ds-faint" strokeWidth={1.5} />
            <p className="text-[13px] font-medium text-ds-muted">
              {t('agentStateEmptyTitle', 'No agent activity yet')}
            </p>
            <p className="text-[12px] text-ds-faint">
              {t('agentStateEmptyHint', 'State appears here while the agent works on a turn.')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {goal ? (
              <Section icon={<Target className="h-3.5 w-3.5" strokeWidth={1.85} />} title={t('agentStateGoal', 'Goal')}>
                <p className="text-[12px] text-ds-ink">{goal.objective}</p>
                <p className="mt-1 text-[11px] text-ds-faint">
                  {goal.status}
                  {goal.tokenBudget ? ` · ${goal.tokensUsed.toLocaleString()} / ${goal.tokenBudget.toLocaleString()} tokens` : ''}
                </p>
              </Section>
            ) : null}

            {agentState ? (
              <Section icon={<Gauge className="h-3.5 w-3.5" strokeWidth={1.85} />} title={t('agentStatePressure', 'Context pressure')}>
                <PressureBar pressure={agentState.contextPressure} />
                <p className="mt-1 text-[11px] text-ds-faint">
                  ~{agentState.promptTokensEstimated.toLocaleString()} / {agentState.compactionSoftThreshold.toLocaleString()} tokens
                  {' · '}{agentState.model}
                  {agentState.reasoningEffort ? ` (${agentState.reasoningEffort})` : ''}
                </p>
              </Section>
            ) : null}

            {agentState?.injection ? (
              <Section icon={<Layers className="h-3.5 w-3.5" strokeWidth={1.85} />} title={t('agentStateContext', 'Injected context')}>
                <div className="flex flex-wrap gap-1">
                  {agentState.injection.included.map((name) => (
                    <span key={name} className="rounded-full border border-ds-border-muted bg-ds-hover px-2 py-0.5 text-[11px] text-ds-ink">
                      {name}
                    </span>
                  ))}
                  {agentState.injection.droppedByBudget.map((name) => (
                    <span
                      key={`dropped-${name}`}
                      className="rounded-full border border-dashed border-ds-border-muted px-2 py-0.5 text-[11px] text-ds-faint line-through"
                      title={t('agentStateDropped', 'Dropped to fit the token budget')}
                    >
                      {name}
                    </span>
                  ))}
                </div>
              </Section>
            ) : null}

            {agentState?.memories && (agentState.memories.factIds.length || agentState.memories.hypothesisIds.length) ? (
              <Section icon={<Brain className="h-3.5 w-3.5" strokeWidth={1.85} />} title={t('agentStateMemories', 'Memories in context')}>
                {agentState.memories.factIds.length ? (
                  <p className="text-[11px] text-ds-muted">
                    {t('agentStateFacts', 'Verified')}: {agentState.memories.factIds.length}
                  </p>
                ) : null}
                {agentState.memories.hypothesisIds.length ? (
                  <p className="text-[11px] italic text-amber-600 dark:text-amber-400">
                    {t('agentStateHypotheses', 'Unverified hypotheses')}: {agentState.memories.hypothesisIds.length}
                  </p>
                ) : null}
              </Section>
            ) : null}

            {pipelineStages.length ? (
              <Section icon={<ListChecks className="h-3.5 w-3.5" strokeWidth={1.85} />} title={t('agentStatePipeline', 'Rigorous pipeline')}>
                <ul className="flex flex-col gap-1">
                  {pipelineStages.map((stage, index) => (
                    <li key={`${stage.role}-${index}`} className="flex items-center gap-2 text-[12px] text-ds-ink">
                      <StageIcon status={stage.status} />
                      <span className="font-medium">{stage.role}</span>
                      <span className="text-[11px] text-ds-faint">
                        {stage.status}
                        {stage.model ? ` · ${stage.model}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {usage ? (
              <Section icon={<Gauge className="h-3.5 w-3.5" strokeWidth={1.85} />} title={t('agentStateUsage', 'Token usage')}>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] text-ds-muted">
                  <span>{t('agentStateUsageInput', 'Input')}</span>
                  <span className="text-right text-ds-ink">{usage.inputTokens.toLocaleString()}</span>
                  <span>{t('agentStateUsageOutput', 'Output')}</span>
                  <span className="text-right text-ds-ink">{usage.outputTokens.toLocaleString()}</span>
                  <span>{t('agentStateUsageCached', 'Cached')}</span>
                  <span className="text-right text-ds-ink">{usage.cachedTokens.toLocaleString()}</span>
                  <span>{t('agentStateUsageTotal', 'Total')}</span>
                  <span className="text-right font-medium text-ds-ink">{usage.totalTokens.toLocaleString()}</span>
                </div>
                {usage.cacheHitRate !== null ? (
                  <p className="mt-1 text-[11px] text-ds-faint">
                    {t('agentStateUsageCacheHit', 'Cache hit rate')}: {Math.round(usage.cacheHitRate * 100)}%
                  </p>
                ) : null}
              </Section>
            ) : null}

            {todoItems.length ? (
              <Section icon={<ListChecks className="h-3.5 w-3.5" strokeWidth={1.85} />} title={t('rightPanelTodo')}>
                <p className="text-[11px] text-ds-faint">
                  {todoCompleted}/{todoItems.length} {t('agentStateTodosDone', 'done')}
                </p>
              </Section>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  )
}

function Section({
  icon,
  title,
  children
}: {
  icon: ReactElement
  title: string
  children: React.ReactNode
}): ReactElement {
  return (
    <section className="rounded-lg border border-ds-border-muted bg-white p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:bg-ds-card">
      <div className="mb-1.5 flex items-center gap-1.5 text-ds-muted">
        {icon}
        <h3 className="text-[12px] font-semibold text-ds-ink">{title}</h3>
      </div>
      {children}
    </section>
  )
}

function PressureBar({ pressure }: { pressure: number }): ReactElement {
  const percent = Math.round(Math.min(1, Math.max(0, pressure)) * 100)
  const color = percent >= 85 ? 'bg-danger' : percent >= 60 ? 'bg-amber-500' : 'bg-success'
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ds-hover" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full ${color}`} style={{ width: `${percent}%` }} />
    </div>
  )
}

function StageIcon({ status }: { status: PipelineStageInfo['status'] }): ReactElement {
  if (status === 'running') return <CircleDashed className="h-3.5 w-3.5 animate-spin text-accent" strokeWidth={1.85} />
  if (status === 'completed') return <CheckCircle2 className="h-3.5 w-3.5 text-success" strokeWidth={1.85} />
  if (status === 'degraded' || status === 'skipped') return <CircleDashed className="h-3.5 w-3.5 text-amber-500" strokeWidth={1.85} />
  return <XCircle className="h-3.5 w-3.5 text-danger" strokeWidth={1.85} />
}
