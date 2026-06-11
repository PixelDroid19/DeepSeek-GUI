import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'
import {
  Archive,
  GitFork,
  ListTodo,
  MessageCircleMore,
  Minimize2,
  RotateCcw,
  SearchCode,
  Sparkles,
  Target,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ModelProviderModelGroup } from '@shared/ds-gui-api'
import type { AttachmentReference, ReviewTarget } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'
import { normalizeWorkspaceRoot } from '../../lib/workspace-path'
import {
  removeComposerFileMentionToken,
  replaceFileMentionInInput,
  type ComposerFileReference
} from '../../lib/composer-file-references'
import {
  getGoalPanelDraftObjective,
  getSlashQuery,
  type GoalCommand,
  type SlashCommand,
  type SlashCommandId
} from './floating-composer-commands'
export { parseBtwCommand, parseCompactCommand, parseGoalCommand, parseReviewCommand } from './floating-composer-commands'
import {
  buildFloatingComposerSlashCommands,
  type FloatingComposerSkillCommand
} from './floating-composer-slash-catalog'
import {
  resolveComposerCapabilityState,
  resolveComposerFooterHint,
  resolveComposerPlaceholder
} from './floating-composer-capabilities'
import { formatGoalElapsedSeconds } from './floating-composer-goal-format'
export { formatGoalElapsedSeconds } from './floating-composer-goal-format'
import {
  resolveComposerImageDrop,
  resolveComposerPasteImageTransfer,
  shouldAcceptComposerImageDrag
} from './floating-composer-image-transfer'
export {
  imageFilesFromTransfer,
  imageTransferHasImages,
  type ComposerImageTransferSource
} from './floating-composer-image-transfer'
import {
  getNextFileMentionSelectionIndex,
  loadFloatingComposerFileMentionSuggestions,
  resolveFloatingComposerFileMentionState
} from './floating-composer-file-mentions'
import { resolveFloatingComposerPrimaryAction } from './floating-composer-primary-action'
import { resolveFloatingComposerKeyboardAction } from './floating-composer-keyboard'
import { resolveFloatingComposerSlashCommandAction } from './floating-composer-slash-action'
import type { ComposerReasoningEffort } from './FloatingComposerModelPicker'
import {
  FloatingComposerQueuedMessages,
  type QueuedComposerMessage
} from './FloatingComposerQueuedMessages'
import {
  FloatingComposerFileMentionMenu,
  FloatingComposerOptionsMenu,
  FloatingComposerSlashMenu
} from './FloatingComposerMenus'
import {
  FloatingComposerGoalBanner,
  FloatingComposerGoalPanel
} from './FloatingComposerGoalControls'
import { FloatingComposerAttachmentTray } from './FloatingComposerAttachmentTray'
import { FloatingComposerFooter } from './FloatingComposerFooter'
import { FloatingComposerActionControls } from './FloatingComposerActionControls'
import { FloatingComposerToolbarStartControls } from './FloatingComposerToolbarStartControls'
import { useComposerDraft } from './use-composer-draft'

export type { ComposerFileReference } from '../../lib/composer-file-references'

type Props = {
  variant?: 'default' | 'compact'
  workspaceRootOverride?: string
  input: string
  setInput: (v: string) => void
  mode: 'plan' | 'agent'
  setMode: (m: 'plan' | 'agent') => void
  busy: boolean
  runtimeReady: boolean
  hasActiveThread: boolean
  composerModel: string
  composerPickList: string[]
  composerModelGroups?: ModelProviderModelGroup[]
  composerReasoningEffort?: string
  onComposerModelChange: (modelId: string) => void
  onComposerReasoningEffortChange?: (effort: ComposerReasoningEffort) => void
  hideModelPicker?: boolean
  modelPickerMode?: 'select' | 'combobox'
  queuedMessages: QueuedComposerMessage[]
  onRemoveQueuedMessage: (id: string) => void
  attachments?: AttachmentReference[]
  attachmentUploadEnabled?: boolean
  attachmentUploadBusy?: boolean
  attachmentUploadError?: string | null
  fileReferenceEnabled?: boolean
  fileReferences?: ComposerFileReference[]
  webAccessAvailable?: boolean
  skillCommands?: FloatingComposerSkillCommand[]
  onPickAttachments?: (files: File[]) => void
  onPasteClipboardImage?: (options?: { silentNoImage?: boolean }) => void | Promise<void>
  onRemoveAttachment?: (id: string) => void
  onAddFileReference?: (reference: ComposerFileReference) => void
  onRemoveFileReference?: (relativePath: string) => void
  onSend: () => void
  onInterrupt: (options?: { discard?: boolean }) => void
  onPlanCommand?: () => void
  onReviewCommand?: (target: ReviewTarget) => void
  /**
   * When set, the `/btw` slash command is offered. It is omitted from
   * side-conversation composers (non-goal: no nested `/btw`).
   */
  onBtwCommand?: (seedText?: string) => void
  /**
   * Hide the `/btw` slash entry (e.g. inside a side conversation).
   */
  hideBtwCommand?: boolean
}

export function FloatingComposer({
  variant = 'default',
  workspaceRootOverride,
  input,
  setInput,
  mode,
  setMode,
  busy,
  runtimeReady,
  hasActiveThread,
  composerModel,
  composerPickList,
  composerModelGroups = [],
  composerReasoningEffort,
  onComposerModelChange,
  onComposerReasoningEffortChange,
  hideModelPicker = false,
  modelPickerMode = 'select',
  queuedMessages,
  onRemoveQueuedMessage,
  attachments = [],
  attachmentUploadEnabled = false,
  attachmentUploadBusy = false,
  attachmentUploadError = null,
  fileReferenceEnabled = false,
  fileReferences = [],
  skillCommands = [],
  onPickAttachments,
  onPasteClipboardImage,
  onRemoveAttachment,
  onAddFileReference,
  onRemoveFileReference,
  onSend,
  onInterrupt,
  onPlanCommand,
  onReviewCommand,
  onBtwCommand,
  hideBtwCommand = false
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const route = useChatStore((s) => s.route)
  const workspaceRoot = useChatStore((s) => s.workspaceRoot)
  const activeThreadId = useChatStore((s) => s.activeThreadId)
  const usageRefreshKey = useChatStore((s) => s.usageRefreshKey)
  const threads = useChatStore((s) => s.threads)
  const compactActiveThread = useChatStore((s) => s.compactActiveThread)
  const forkActiveThread = useChatStore((s) => s.forkActiveThread)
  const archiveThread = useChatStore((s) => s.archiveThread)
  const activeThreadGoal = useChatStore((s) => s.activeThreadGoal)
  const setActiveThreadGoal = useChatStore((s) => s.setActiveThreadGoal)
  const setActiveThreadGoalStatus = useChatStore((s) => s.setActiveThreadGoalStatus)
  const clearActiveThreadGoal = useChatStore((s) => s.clearActiveThreadGoal)
  const clawChannels = useChatStore((s) => s.clawChannels)
  const activeClawChannelId = useChatStore((s) => s.activeClawChannelId)
  const compact = variant === 'compact'
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const activeClawChannel = useMemo(
    () => clawChannels.find((channel) => channel.id === activeClawChannelId) ?? null,
    [activeClawChannelId, clawChannels]
  )
  const activeThreadWorkspace = activeThreadId
    ? threads.find((thread) => thread.id === activeThreadId)?.workspace
    : ''
  const activeThread = activeThreadId
    ? threads.find((thread) => thread.id === activeThreadId) ?? null
    : null
  const activeThreadArchived = activeThread?.archived === true
  const effectiveWorkspaceRoot = normalizeWorkspaceRoot(activeThreadWorkspace || workspaceRootOverride || workspaceRoot)
  const clawAgentName =
    activeClawChannel?.agentProfile.name.trim()
    || activeClawChannel?.label.trim()
    || t('clawEmptyHeroFallbackName')
  const clawHasInboundConversation = Boolean(
    activeThreadId ||
    activeClawChannel?.threadId.trim() ||
    activeClawChannel?.conversations.some((conversation) => conversation.localThreadId.trim()) ||
    activeClawChannel?.conversations.length ||
    activeClawChannel?.remoteSession?.chatId?.trim()
  )

  const {
    canCompose,
    canChangeModel,
    canSend,
    canPickAttachment,
    canTogglePlanMode,
    canOpenGoalPanel,
    canRunReview,
    canOpenComposerMenu,
    showComposerMenuButton,
    showToolbarStartControls,
    stretchModelPicker
  } = resolveComposerCapabilityState({
    route,
    runtimeReady,
    busy,
    hasActiveThread,
    effectiveWorkspaceRoot,
    clawHasInboundConversation,
    input,
    attachmentUploadEnabled,
    attachmentUploadBusy,
    attachmentCount: attachments.length,
    fileReferenceEnabled,
    fileReferenceCount: fileReferences.length,
    compact,
    modelPickerMode,
    hideModelPicker,
    hasPlanCommand: Boolean(onPlanCommand),
    hasReviewCommand: Boolean(onReviewCommand)
  })
  const draft = useComposerDraft({ input, canCompose })
  const slashQuery = getSlashQuery(input)
  const [composerCursor, setComposerCursor] = useState(() => input.length)
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  const [fileMentionSuggestions, setFileMentionSuggestions] = useState<ComposerFileReference[]>([])
  const [fileMentionLoading, setFileMentionLoading] = useState(false)
  const [selectedFileMentionIndex, setSelectedFileMentionIndex] = useState(0)
  const [dismissedFileMentionKey, setDismissedFileMentionKey] = useState<string | null>(null)
  const [composerMenuOpen, setComposerMenuOpen] = useState(false)
  const [goalPanelOpen, setGoalPanelOpen] = useState(false)
  const [goalRuntimeNowMs, setGoalRuntimeNowMs] = useState(() => Date.now())
  const composerMenuButtonRef = useRef<HTMLButtonElement | null>(null)
  const composerMenuPanelRef = useRef<HTMLDivElement | null>(null)
  const goalPanelRef = useRef<HTMLDivElement | null>(null)
  const goalRuntimeStartedAtRef = useRef<number | null>(null)
  const placeholderDescriptor = resolveComposerPlaceholder({
    route,
    runtimeReady,
    busy,
    hasActiveThread,
    effectiveWorkspaceRoot,
    goalPanelOpen,
    mode,
    clawHasInboundConversation,
    clawAgentName
  })
  const placeholder = t(placeholderDescriptor.key, placeholderDescriptor.values)
  const footerHintDescriptor = resolveComposerFooterHint({
    route,
    runtimeReady,
    hasActiveThread,
    effectiveWorkspaceRoot,
    clawHasInboundConversation
  })
  const footerHint = t(footerHintDescriptor.key, footerHintDescriptor.values)
  const slashCommands = useMemo<SlashCommand[]>(() => {
    return buildFloatingComposerSlashCommands({
      activeThreadArchived,
      activeThreadId,
      busy,
      canOpenGoalPanel,
      effectiveWorkspaceRoot,
      hideBtwCommand,
      hasBtwCommand: Boolean(onBtwCommand),
      hasPlanCommand: Boolean(onPlanCommand),
      hasReviewCommand: Boolean(onReviewCommand),
      icons: {
        archive: <Archive className="h-4 w-4" strokeWidth={1.9} />,
        btw: <MessageCircleMore className="h-4 w-4" strokeWidth={1.9} />,
        compact: <Minimize2 className="h-4 w-4" strokeWidth={1.9} />,
        fork: <GitFork className="h-4 w-4" strokeWidth={1.9} />,
        goal: <Target className="h-4 w-4" strokeWidth={1.9} />,
        plan: <ListTodo className="h-4 w-4" strokeWidth={1.9} />,
        restore: <RotateCcw className="h-4 w-4" strokeWidth={1.9} />,
        review: <SearchCode className="h-4 w-4" strokeWidth={1.9} />,
        skill: <Sparkles className="h-4 w-4" strokeWidth={1.9} />
      },
      labels: {
        planTitle: t('slashCommandPlanTitle'),
        planDescription: t('slashCommandPlanDescription'),
        goalTitle: t('slashCommandGoalTitle'),
        goalDescription: t('slashCommandGoalDescription'),
        btwTitle: t('slashCommandBtwTitle'),
        btwDescription: t('slashCommandBtwDescription'),
        reviewTitle: t('slashCommandReviewTitle'),
        reviewDescription: t('slashCommandReviewDescription'),
        compactTitle: t('slashCommandCompactTitle'),
        compactDescription: t('slashCommandCompactDescription'),
        forkTitle: t('slashCommandForkTitle'),
        forkDescription: t('slashCommandForkDescription'),
        archiveTitle: t('slashCommandArchiveTitle'),
        archiveDescription: t('slashCommandArchiveDescription'),
        restoreTitle: t('slashCommandRestoreTitle'),
        restoreDescription: t('slashCommandRestoreDescription'),
        skillDescriptionFallback: t('slashSkillDescriptionFallback'),
        skillScopeProject: t('slashSkillScopeProject'),
        skillScopeGlobal: t('slashSkillScopeGlobal')
      },
      route,
      runtimeReady,
      skillCommands
    })
  }, [
    activeThreadArchived,
    activeThreadId,
    busy,
    canOpenGoalPanel,
    effectiveWorkspaceRoot,
    hideBtwCommand,
    onBtwCommand,
    onPlanCommand,
    onReviewCommand,
    route,
    runtimeReady,
    skillCommands,
    t
  ])

  const filteredSlashCommands = useMemo(() => {
    if (slashQuery == null) return []
    if (!slashQuery) return slashCommands
    return slashCommands.filter((command) => {
      const haystack = [command.id, command.title, command.description, ...command.keywords]
      return haystack.some((part) => part.toLowerCase().includes(slashQuery))
    })
  }, [slashCommands, slashQuery])

  const highlightedSlashCommand =
    filteredSlashCommands.length > 0
      ? filteredSlashCommands[Math.min(selectedCommandIndex, filteredSlashCommands.length - 1)]
      : null
  const {
    activeMention: activeFileMention,
    activeMentionKey: activeFileMentionKey,
    highlightedReference: highlightedFileMention,
    showMenu: showFileMentionMenu
  } = resolveFloatingComposerFileMentionState({
    canCompose,
    composerMenuOpen,
    cursor: composerCursor,
    dismissedFileMentionKey,
    effectiveWorkspaceRoot,
    fileReferenceEnabled,
    goalPanelOpen,
    input,
    selectedIndex: selectedFileMentionIndex,
    slashQuery,
    suggestions: fileMentionSuggestions
  })
  const goalPanelDraftObjective = getGoalPanelDraftObjective(input, goalPanelOpen)
  const canSetGoalPanelDraft =
    route !== 'claw'
    && runtimeReady
    && canOpenGoalPanel
    && goalPanelDraftObjective.length > 0
  const primaryActionLabel = highlightedSlashCommand
    ? t('slashCommandApply')
    : canSetGoalPanelDraft
      ? t('goalSetCurrentInput')
    : busy
      ? t('queueMessage')
      : t('send')
  const primaryActionDisabled = highlightedSlashCommand
    ? highlightedSlashCommand.disabled === true
    : canSetGoalPanelDraft
      ? false
    : !canSend
  const goalRuntimeStartedAtMs = goalRuntimeStartedAtRef.current
  const liveGoalElapsedSeconds =
    busy && activeThreadGoal?.status === 'active' && goalRuntimeStartedAtMs != null
      ? Math.max(0, Math.floor((goalRuntimeNowMs - goalRuntimeStartedAtMs) / 1000))
      : 0
  const goalElapsedLabel = activeThreadGoal
    ? formatGoalElapsedSeconds((activeThreadGoal.timeUsedSeconds ?? 0) + liveGoalElapsedSeconds)
    : ''
  const goalBannerLabel = activeThreadGoal
    ? activeThreadGoal.status === 'active'
      ? t('goalActiveHeading')
      : t(`goalStatusShort.${activeThreadGoal.status}`)
    : ''
  const goalMenuChecked = activeThreadGoal?.status === 'active'

  useEffect(() => {
    setSelectedCommandIndex(0)
  }, [slashQuery])

  useEffect(() => {
    setSelectedFileMentionIndex(0)
  }, [activeFileMentionKey])

  useEffect(() => {
    if (slashQuery != null || goalPanelOpen) setComposerMenuOpen(false)
  }, [goalPanelOpen, slashQuery])

  useEffect(() => {
    if (!showFileMentionMenu || !activeFileMention || !effectiveWorkspaceRoot) {
      setFileMentionSuggestions([])
      setFileMentionLoading(false)
      return
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      setFileMentionLoading(true)
      void loadFloatingComposerFileMentionSuggestions({
        fileReferences,
        query: activeFileMention.query,
        workspaceRoot: effectiveWorkspaceRoot
      })
        .then((suggestions) => {
          if (cancelled) return
          setFileMentionSuggestions(suggestions)
        })
        .catch(() => {
          if (!cancelled) setFileMentionSuggestions([])
        })
        .finally(() => {
          if (!cancelled) setFileMentionLoading(false)
        })
    }, 80)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeFileMention, effectiveWorkspaceRoot, fileReferences, showFileMentionMenu])

  useEffect(() => {
    if (!composerMenuOpen && !goalPanelOpen) return

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (composerMenuButtonRef.current?.contains(target)) return
      if (composerMenuPanelRef.current?.contains(target)) return
      if (goalPanelRef.current?.contains(target)) return
      setComposerMenuOpen(false)
      setGoalPanelOpen(false)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setComposerMenuOpen(false)
      setGoalPanelOpen(false)
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [composerMenuOpen, goalPanelOpen])

  useEffect(() => {
    const shouldTimeGoal = busy && activeThreadGoal?.status === 'active'
    if (!shouldTimeGoal) {
      goalRuntimeStartedAtRef.current = null
      setGoalRuntimeNowMs(Date.now())
      return
    }

    if (goalRuntimeStartedAtRef.current == null) {
      const startedAt = Date.now()
      goalRuntimeStartedAtRef.current = startedAt
      setGoalRuntimeNowMs(startedAt)
    }

    const interval = window.setInterval(() => {
      setGoalRuntimeNowMs(Date.now())
    }, 1000)
    return () => window.clearInterval(interval)
  }, [busy, activeThreadGoal?.createdAt, activeThreadGoal?.objective, activeThreadGoal?.status])

  const applySlashCommand = (commandId: SlashCommandId): void => {
    const action = resolveFloatingComposerSlashCommandAction({
      activeThreadId,
      commandId,
      hasBtwCommand: Boolean(onBtwCommand),
      hasReviewCommand: Boolean(onReviewCommand),
      slashCommands
    })

    if (action.kind === 'ignore') return
    if (action.kind === 'set-input') {
      setInput(action.value)
      if (action.focusComposer) draft.focusComposer()
      return
    }
    if (action.kind === 'open-plan-mode') {
      setInput('')
      setMode('plan')
      onPlanCommand?.()
      draft.focusComposer()
      return
    }
    if (action.kind === 'compact-thread') {
      setInput('')
      void compactActiveThread()
      draft.focusComposer()
      return
    }
    if (action.kind === 'open-goal-panel') {
      setInput('')
      setGoalPanelOpen(true)
      draft.focusComposer()
      return
    }
    if (action.kind === 'review-uncommitted-changes') {
      setInput('')
      void onReviewCommand?.({ kind: 'uncommittedChanges' })
      draft.focusComposer()
      return
    }
    if (action.kind === 'fork-thread') {
      setInput('')
      void forkActiveThread()
      draft.focusComposer()
      return
    }
    if (action.kind === 'set-thread-archived') {
      setInput('')
      void archiveThread(action.threadId, action.archived)
      draft.focusComposer()
      return
    }
    if (action.kind === 'btw-empty') {
      // Empty aside — open a side conversation without a seed question.
      setInput('')
      void onBtwCommand?.()
    }
  }

  const runGoalCommand = (command: GoalCommand): void => {
    if (!canOpenGoalPanel) return
    setInput('')
    setGoalPanelOpen(false)
    if (command.action === 'menu') {
      setGoalPanelOpen(true)
      draft.focusComposer()
      return
    }
    if (command.action === 'set') {
      void setActiveThreadGoal(command.objective)
      return
    }
    if (command.action === 'pause') {
      void setActiveThreadGoalStatus('paused')
      return
    }
    if (command.action === 'resume') {
      void setActiveThreadGoalStatus('active')
      return
    }
    if (command.action === 'clear') {
      void clearActiveThreadGoal()
    }
  }

  const setGoalFromComposerInput = (): boolean => {
    if (!canSetGoalPanelDraft) return false
    setInput('')
    setGoalPanelOpen(false)
    void setActiveThreadGoal(goalPanelDraftObjective)
    draft.focusComposer()
    return true
  }

  const handleComposerMenuButtonClick = (): void => {
    if (!canOpenComposerMenu) return
    setGoalPanelOpen(false)
    setComposerMenuOpen((open) => !open)
    draft.focusComposer()
  }

  const handlePlanToolbarClick = (): void => {
    if (!canTogglePlanMode) return
    setComposerMenuOpen(false)
    if (mode === 'plan') {
      setMode('agent')
    } else {
      setMode('plan')
      onPlanCommand?.()
    }
    draft.focusComposer()
  }

  const handleGoalMenuClick = (): void => {
    if (!canOpenGoalPanel) return
    setComposerMenuOpen(false)
    if (activeThreadGoal?.status === 'active') {
      void setActiveThreadGoalStatus('paused')
    } else if (activeThreadGoal) {
      void setActiveThreadGoalStatus('active')
    } else {
      setGoalPanelOpen(true)
    }
    draft.focusComposer()
  }

  const syncComposerCursor = (element = draft.textareaRef.current): void => {
    if (!element) return
    setComposerCursor(element.selectionStart ?? input.length)
  }

  const applyFileMention = (reference: ComposerFileReference | null): void => {
    if (!reference || !activeFileMention) return
    const next = replaceFileMentionInInput(input, activeFileMention, reference)
    setInput(next.input)
    onAddFileReference?.(reference)
    setDismissedFileMentionKey(null)
    window.requestAnimationFrame(() => {
      const textarea = draft.textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(next.cursor, next.cursor)
      setComposerCursor(next.cursor)
    })
  }

  const removeFileReference = (relativePath: string): void => {
    onRemoveFileReference?.(relativePath)
    const nextInput = removeComposerFileMentionToken(input, relativePath)
    if (nextInput !== input) {
      setInput(nextInput)
      window.requestAnimationFrame(() => syncComposerCursor())
    }
    draft.focusComposer()
  }

  const handlePrimaryAction = (): void => {
    const action = resolveFloatingComposerPrimaryAction({
      canOpenGoalPanel,
      canSetGoalPanelDraft,
      hasBtwCommand: Boolean(onBtwCommand),
      hasReviewCommand: Boolean(onReviewCommand),
      hideBtwCommand,
      highlightedSlashCommand,
      input,
      slashCommands
    })

    if (action.kind === 'ignore') return
    if (action.kind === 'apply-slash-command') {
      applySlashCommand(action.commandId)
      return
    }
    if (action.kind === 'set-goal-from-draft') {
      setGoalFromComposerInput()
      return
    }
    if (action.kind === 'run-goal-command') {
      runGoalCommand(action.command)
      return
    }
    if (action.kind === 'compact-thread') {
      setInput('')
      void compactActiveThread(action.reason)
      draft.focusComposer()
      return
    }
    if (action.kind === 'review') {
      setInput('')
      void onReviewCommand?.(action.target)
      draft.focusComposer()
      return
    }
    if (action.kind === 'btw') {
      setInput('')
      void onBtwCommand?.(action.question)
      return
    }
    onSend()
  }

  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    const action = resolveFloatingComposerKeyboardAction({
      activeFileMentionKey,
      composing: draft.isComposingEvent(event),
      ctrlKey: event.ctrlKey,
      fileMentionSuggestionCount: fileMentionSuggestions.length,
      filteredSlashCommandCount: filteredSlashCommands.length,
      hasHighlightedFileMention: highlightedFileMention !== null,
      key: event.key,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      showFileMentionMenu,
      slashQuery
    })
    if (action.preventDefault) event.preventDefault()

    if (action.kind === 'none') return
    if (action.kind === 'select-file-mention') {
      setSelectedFileMentionIndex((current) =>
        getNextFileMentionSelectionIndex(current, fileMentionSuggestions.length, action.direction)
      )
      return
    }
    if (action.kind === 'apply-file-mention') {
      applyFileMention(highlightedFileMention)
      return
    }
    if (action.kind === 'dismiss-file-mention') {
      setDismissedFileMentionKey(action.dismissedKey)
      setFileMentionSuggestions([])
      return
    }
    if (action.kind === 'select-slash-command') {
      if (action.direction === 'next') {
        setSelectedCommandIndex((current) => (current + 1) % filteredSlashCommands.length)
        return
      }
      setSelectedCommandIndex((current) =>
        current === 0 ? filteredSlashCommands.length - 1 : current - 1
      )
      return
    }
    if (action.kind === 'clear-slash-input') {
      setInput('')
      return
    }
    handlePrimaryAction()
  }

  const handleAttachmentInput = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0 || !onPickAttachments) return
    onPickAttachments(files)
  }

  const handleComposerPaste = (event: ReactClipboardEvent<HTMLElement>): void => {
    const decision = resolveComposerPasteImageTransfer({
      canPickAttachment,
      hasPasteClipboardImageHandler: Boolean(onPasteClipboardImage),
      hasPickAttachmentHandler: Boolean(onPickAttachments),
      plainText: event.clipboardData.getData('text/plain'),
      source: event.clipboardData
    })
    if (decision.preventDefault) event.preventDefault()
    if (decision.action === 'pick-files') {
      onPickAttachments?.(decision.files)
      return
    }
    if (decision.action === 'paste-clipboard-image') {
      void onPasteClipboardImage?.({ silentNoImage: decision.silentNoImage })
    }
  }

  const handleComposerDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!shouldAcceptComposerImageDrag({ canPickAttachment, source: event.dataTransfer })) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleComposerDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    const decision = resolveComposerImageDrop({
      canPickAttachment,
      hasPickAttachmentHandler: Boolean(onPickAttachments),
      source: event.dataTransfer
    })
    if (decision.preventDefault) event.preventDefault()
    if (decision.action !== 'pick-files') return
    onPickAttachments?.(decision.files)
    draft.focusComposer()
  }

  return (
    <div className={compact
      ? 'ds-floating-composer pointer-events-auto w-full pb-0 pt-0'
      : 'ds-floating-composer ds-chat-column-inset pointer-events-auto w-full max-w-4xl pb-3 pt-0'}
    >
      <FloatingComposerQueuedMessages
        messages={queuedMessages}
        onRemove={onRemoveQueuedMessage}
      />

      <div className="relative">
        {!compact && activeThreadGoal && slashQuery == null && !goalPanelOpen && !composerMenuOpen ? (
          <FloatingComposerGoalBanner
            clearLabel={t('goalActionClear')}
            editLabel={t('goalActionEdit')}
            elapsedLabel={goalElapsedLabel}
            goal={activeThreadGoal}
            heading={goalBannerLabel}
            onClear={() => {
              void clearActiveThreadGoal()
            }}
            onEdit={() => {
              setGoalPanelOpen(true)
              draft.focusComposer()
            }}
            onToggleStatus={() => {
              void setActiveThreadGoalStatus(activeThreadGoal.status === 'active' ? 'paused' : 'active')
            }}
            pauseLabel={t('goalActionPause')}
            resumeLabel={t('goalActionResume')}
          />
        ) : null}

        {composerMenuOpen && slashQuery == null ? (
          <FloatingComposerOptionsMenu
            panelRef={composerMenuPanelRef}
            canOpenGoalPanel={canOpenGoalPanel}
            canTogglePlanMode={canTogglePlanMode}
            goalChecked={goalMenuChecked}
            mode={mode}
            planModeLabel={t('composerMenuPlanMode')}
            pursueGoalLabel={t('composerMenuPursueGoal')}
            onGoalClick={handleGoalMenuClick}
            onPlanClick={handlePlanToolbarClick}
          />
        ) : null}

        {slashQuery != null ? (
          <FloatingComposerSlashMenu
            commands={filteredSlashCommands}
            emptyLabel={t('slashCommandEmpty')}
            highlightedCommandId={highlightedSlashCommand?.id ?? null}
            menuTitle={t('slashCommandMenuTitle')}
            onApplyCommand={applySlashCommand}
          />
        ) : null}

        {showFileMentionMenu ? (
          <FloatingComposerFileMentionMenu
            emptyLabel={t('composerFileMentionEmpty')}
            highlightedRelativePath={highlightedFileMention?.relativePath ?? null}
            loading={fileMentionLoading}
            loadingLabel={t('composerFileMentionLoading')}
            menuTitle={t('composerFileMentionMenuTitle')}
            onApplyFileMention={applyFileMention}
            suggestions={fileMentionSuggestions}
          />
        ) : null}

        {goalPanelOpen && slashQuery == null ? (
          <FloatingComposerGoalPanel
            ref={goalPanelRef}
            canSetDraft={canSetGoalPanelDraft}
            clearLabel={t('goalActionClear')}
            closeLabel={t('close')}
            goal={activeThreadGoal}
            noActiveTitle={t('goalNoActiveTitle')}
            onClear={() => {
              setGoalPanelOpen(false)
              void clearActiveThreadGoal()
            }}
            onClose={() => setGoalPanelOpen(false)}
            onPause={() => {
              setGoalPanelOpen(false)
              void setActiveThreadGoalStatus('paused')
            }}
            onResume={() => {
              setGoalPanelOpen(false)
              void setActiveThreadGoalStatus('active')
            }}
            onSetDraft={setGoalFromComposerInput}
            pauseLabel={t('goalActionPause')}
            resumeLabel={t('goalActionResume')}
            setCurrentInputLabel={t('goalSetCurrentInput')}
            statusLabel={activeThreadGoal ? t(`goalStatusShort.${activeThreadGoal.status}`) : ''}
          />
        ) : null}

        <div
          className={`ds-composer-shell ds-chat-composer ds-frosted flex flex-col gap-1 px-3 pb-2 pt-2 transition ${
            draft.focused ? 'ds-chat-composer-focus' : ''
          } ${compact ? 'rounded-[24px] px-3 py-2 shadow-none' : ''}`}
          onPaste={handleComposerPaste}
          onDragOver={handleComposerDragOver}
          onDrop={handleComposerDrop}
        >
          <textarea
            ref={draft.textareaRef}
            rows={1}
            className={`ds-no-drag block min-w-0 resize-none break-words bg-transparent px-1 py-0.5 text-[15px] leading-[1.45] text-ds-ink placeholder:text-ds-faint focus:outline-none [overflow-wrap:anywhere] ${
              canCompose ? '' : 'opacity-80'
            } ${compact ? 'text-[14px]' : 'min-h-[40px]'}`}
            placeholder={placeholder}
            value={input}
            disabled={!canCompose}
            onChange={(e) => {
              setInput(e.target.value)
              setComposerCursor(e.target.selectionStart ?? e.target.value.length)
              setDismissedFileMentionKey(null)
            }}
            onSelect={(e) => syncComposerCursor(e.currentTarget)}
            onFocus={draft.onFocus}
            onBlur={draft.onBlur}
            onCompositionStart={draft.onCompositionStart}
            onCompositionEnd={draft.onCompositionEnd}
            onKeyDown={handleComposerKeyDown}
          />
          <FloatingComposerAttachmentTray
            attachments={attachments}
            attachmentUploadError={attachmentUploadError}
            fileReferences={fileReferences}
            onRemoveAttachment={onRemoveAttachment}
            onRemoveFileReference={onRemoveFileReference ? removeFileReference : undefined}
            removeAttachmentLabel={t('composerRemoveAttachment')}
            removeFileReferenceLabel={t('composerRemoveFileReference')}
          />
          <div
            className={`ds-composer-toolbar flex min-h-9 items-center gap-2 ${
              showToolbarStartControls ? 'justify-between' : 'justify-end'
            }`}
          >
            {showToolbarStartControls ? (
              <FloatingComposerToolbarStartControls
                activeGoal={activeThreadGoal?.status === 'active'}
                addImageLabel={t('composerAddImage')}
                attachmentUploadBusy={attachmentUploadBusy}
                attachmentUploadEnabled={attachmentUploadEnabled}
                canOpenComposerMenu={canOpenComposerMenu}
                canPickAttachment={canPickAttachment}
                composerMenuButtonRef={composerMenuButtonRef}
                composerMenuLabel={t('composerMenuTitle')}
                composerMenuOpen={composerMenuOpen}
                fileInputRef={fileInputRef}
                goalBadgeLabel={t('slashCommandGoalTitle')}
                mode={mode}
                planBadgeLabel={t('slashCommandPlanTitle')}
                showComposerMenuButton={showComposerMenuButton}
                onAttachmentInput={handleAttachmentInput}
                onComposerMenuClick={handleComposerMenuButtonClick}
                onOpenFilePicker={() => fileInputRef.current?.click()}
              />
            ) : null}
            <FloatingComposerActionControls
              busy={busy}
              canChangeModel={canChangeModel}
              compact={compact}
              composerModel={composerModel}
              composerModelGroups={composerModelGroups}
              composerPickList={composerPickList}
              composerReasoningEffort={composerReasoningEffort}
              hideModelPicker={hideModelPicker}
              interruptLabel={t('interrupt')}
              modelPickerMode={modelPickerMode}
              primaryActionDisabled={primaryActionDisabled}
              primaryActionLabel={primaryActionLabel}
              stretchModelPicker={stretchModelPicker}
              onComposerModelChange={onComposerModelChange}
              onComposerReasoningEffortChange={onComposerReasoningEffortChange}
              onInterrupt={() => onInterrupt()}
              onPrimaryAction={handlePrimaryAction}
            />
          </div>
        </div>
      </div>
      <FloatingComposerFooter
        activeThreadId={activeThreadId}
        activeThreadUpdatedAt={activeThread?.updatedAt ?? ''}
        busy={busy}
        compact={compact}
        footerHint={footerHint}
        route={route}
        runtimeReady={runtimeReady}
        usageRefreshKey={usageRefreshKey}
        workspaceRoot={effectiveWorkspaceRoot}
      />
    </div>
  )
}
