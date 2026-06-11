import type { ReactElement } from 'react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AttachmentReference } from '../agent/types'
import type { CoreRuntimeInfoJson, CoreRuntimeSkillJson } from '../agent/kun-contract'
import { getProvider } from '../agent/registry'
import { useChatStore } from '../store/chat-store'
import {
  composerReasoningEffortRequestValue,
  type ComposerReasoningEffort
} from './chat/FloatingComposerModelPicker'
import { SideConversationPanel } from './chat/SideConversationPanel'
import { WriteWorkspaceView } from './write/WriteWorkspaceView'
import { SddDraftEditorView } from './sdd/SddDraftEditorView'
import { SidebarTitlebarToggleButton } from './sidebar/SidebarPrimitives'
import { composeWritePrompt } from '../write/quoted-selection'
import { useWriteWorkspaceStore } from '../write/write-workspace-store'
import { createSddDraft, useSddDraftStore } from '../sdd/sdd-draft-store'
import type { SddDraft } from '../sdd/sdd-draft-store'
import { saveActiveSddDraftToDisk } from '../sdd/sdd-draft-actions'
import { composeSddAssistantPrompt } from '../sdd/sdd-assistant-prompt'
import { collectSddDraftImages } from '../sdd/sdd-draft-images'
import {
  markSddAssistantThread,
  releaseSddAssistantThread,
  sddAssistantThreadIdForDraft
} from '../sdd/sdd-thread-registry'
import { RuntimeBanner } from './RuntimeBanner'
import { useWorkbenchLayout } from './workbench-layout'
import { useWorkbenchPlanController } from './workbench-plan-controller'
import {
  WorkbenchRightPanel,
  resolveWorkbenchRightPanelContent
} from './workbench-right-panel'
import {
  resolveWorkbenchSidebarView,
  resolveWriteRuntimeBannerMessage
} from './workbench-route-view'
import { isChatAttachmentUploadEnabled } from '../lib/attachment-upload-availability'
import { normalizeWorkspaceRoot } from '../lib/workspace-path'
import {
  mergeComposerFileReferences,
  type ComposerFileReference
} from '../lib/composer-file-references'
import {
  buildSddDraftPlanTurn,
  clipboardImageToFile,
  sddPlanMatchesPendingTarget,
  type PendingSddPlanTarget
} from './workbench-sdd-helpers'
import {
  prepareWorkbenchChatComposerMessage
} from './workbench-composer-message'
import { handleWorkbenchClawComposer } from './workbench-claw-composer'
import {
  mergeWorkbenchComposerAttachments,
  prepareWorkbenchSddPlanImages,
  uploadWorkbenchComposerImages
} from './workbench-attachment-upload'
import {
  buildWorkbenchSendMessageOptions,
  resolveWorkbenchSendRoute
} from './workbench-send-routing'
import { WorkbenchLeftSidebar } from './workbench-left-sidebar'
import { buildWorkbenchWriteAssistantPickList } from './workbench-write-assistant-models'
import { WorkbenchChatStage } from './workbench-chat-stage'
import { prepareWorkbenchChatNavigation } from './workbench-navigation-actions'
import { buildWorkbenchDevPreviewState } from './workbench-dev-preview'
import { loadWorkbenchRuntimeMetadata } from './workbench-runtime-metadata'
import { buildWorkbenchThreadContext } from './workbench-thread-context'

const PluginMarketplaceView = lazy(() =>
  import('./PluginMarketplaceView').then((module) => ({ default: module.PluginMarketplaceView }))
)
const ScheduleTasksView = lazy(() =>
  import('./schedule/ScheduleTasksView').then((module) => ({ default: module.ScheduleTasksView }))
)

export function Workbench(): ReactElement {
  const { t } = useTranslation('common')
  const {
    threads,
    threadSearch,
    showArchivedThreads,
    activeThreadId,
    selectThread,
    createThread,
    blocks,
    liveReasoning,
    liveAssistant,
    error,
    busy,
    route,
    pluginHostRoute,
    workspaceRoot,
    runtimeConnection,
    setRoute,
    openCode,
    openWrite,
    ensureWriteThreadForWorkspace,
    createWriteThread,
    openSettings,
    openPlugins,
    openClaw,
    openSchedule,
    chooseWorkspace,
    clawChannels,
    activeClawChannelId,
    selectClawChannel,
    resetClawChannelSession,
    setClawChannelModel,
    appendLocalClawTurn,
    setError,
    sendMessage,
    reviewActiveThread,
    queuedMessages,
    removeQueuedMessage,
    interrupt,
    probeRuntime,
    composerModel,
    composerPickList,
    composerModelGroups,
    setComposerModel,
    setThreadSearch,
    setShowArchivedThreads,
    renameThread,
    archiveThread,
    deleteThread,
    spawnSideConversation
  } = useChatStore(
    useShallow((s) => ({
      threads: s.threads,
      threadSearch: s.threadSearch,
      showArchivedThreads: s.showArchivedThreads,
      activeThreadId: s.activeThreadId,
      selectThread: s.selectThread,
      createThread: s.createThread,
      blocks: s.blocks,
      liveReasoning: s.liveReasoning,
      liveAssistant: s.liveAssistant,
      error: s.error,
      busy: s.busy,
      route: s.route,
      pluginHostRoute: s.pluginHostRoute,
      workspaceRoot: s.workspaceRoot,
      runtimeConnection: s.runtimeConnection,
      setRoute: s.setRoute,
      openCode: s.openCode,
      openWrite: s.openWrite,
      ensureWriteThreadForWorkspace: s.ensureWriteThreadForWorkspace,
      createWriteThread: s.createWriteThread,
      openSettings: s.openSettings,
      openPlugins: s.openPlugins,
      openClaw: s.openClaw,
      openSchedule: s.openSchedule,
      chooseWorkspace: s.chooseWorkspace,
      clawChannels: s.clawChannels,
      activeClawChannelId: s.activeClawChannelId,
      selectClawChannel: s.selectClawChannel,
      resetClawChannelSession: s.resetClawChannelSession,
      setClawChannelModel: s.setClawChannelModel,
      appendLocalClawTurn: s.appendLocalClawTurn,
      setError: s.setError,
      sendMessage: s.sendMessage,
      reviewActiveThread: s.reviewActiveThread,
      queuedMessages: s.queuedMessages,
      removeQueuedMessage: s.removeQueuedMessage,
      interrupt: s.interrupt,
      probeRuntime: s.probeRuntime,
      composerModel: s.composerModel,
      composerPickList: s.composerPickList,
      composerModelGroups: s.composerModelGroups,
      setComposerModel: s.setComposerModel,
      setThreadSearch: s.setThreadSearch,
      setShowArchivedThreads: s.setShowArchivedThreads,
      renameThread: s.renameThread,
      archiveThread: s.archiveThread,
      deleteThread: s.deleteThread,
      spawnSideConversation: s.spawnSideConversation
    }))
  )
  const [input, setInput] = useState('')
  const [mode, setMode] = useState<'plan' | 'agent'>('agent')
  const [composerReasoningEffort, setComposerReasoningEffort] =
    useState<ComposerReasoningEffort>('max')
  const [runtimeInfo, setRuntimeInfo] = useState<CoreRuntimeInfoJson | null>(null)
  const [runtimeSkills, setRuntimeSkills] = useState<CoreRuntimeSkillJson[]>([])
  const [composerAttachments, setComposerAttachments] = useState<AttachmentReference[]>([])
  const [composerFileReferences, setComposerFileReferences] = useState<ComposerFileReference[]>([])
  const [attachmentUploadBusy, setAttachmentUploadBusy] = useState(false)
  const [attachmentUploadError, setAttachmentUploadError] = useState<string | null>(null)
  const [connectPhoneSidebarOpen, setConnectPhoneSidebarOpen] = useState(false)
  const writeAssistantOpen = useWriteWorkspaceStore((s) => s.assistantOpen)
  const setWriteAssistantOpen = useWriteWorkspaceStore((s) => s.setAssistantOpen)
  const writeAssistantModel = useWriteWorkspaceStore((s) => s.assistantModel)
  const setWriteAssistantModel = useWriteWorkspaceStore((s) => s.setAssistantModel)
  const activeSddDraft = useSddDraftStore((s) => s.activeDraft)
  const sddDraftOperationStatus = useSddDraftStore((s) => s.operationStatus)
  const writeAssistantPickList = useMemo(
    () => buildWorkbenchWriteAssistantPickList({ composerPickList, writeAssistantModel }),
    [composerPickList, writeAssistantModel]
  )
  const stageInsetClass = 'ds-stage-inset'

  const draftByThread = useRef<Record<string, string>>({})
  const prevThreadId = useRef<string | null>(null)
  const inputRef = useRef('')
  const sddUpgradeInFlightRef = useRef(false)
  const sddUpgradeTargetRef = useRef<PendingSddPlanTarget | null>(null)
  const timelineBlocks = blocks
  const timelineLiveReasoning = liveReasoning
  const timelineLiveAssistant = liveAssistant
  const {
    devPreviewBlocks,
    latestAutoOpenDevPreviewUrl,
    latestDevPreviewUrl,
    showDevPreviewCard
  } = useMemo(
    () => buildWorkbenchDevPreviewState({
      blocks: timelineBlocks,
      liveAssistant: timelineLiveAssistant,
      route
    }),
    [route, timelineBlocks, timelineLiveAssistant]
  )
  const {
    activeClawChannel,
    activeSkillWorkspace,
    codeThreads
  } = useMemo(
    () => buildWorkbenchThreadContext({
      activeClawChannelId,
      activeThreadId,
      clawChannels,
      threads,
      workspaceRoot
    }),
    [activeClawChannelId, activeThreadId, clawChannels, threads, workspaceRoot]
  )
  const {
    beginLeftResize,
    beginRightResize,
    filePreviewTarget,
    leftSidebarCollapsed,
    leftSidebarWidth,
    openDevPreview,
    rightPanelMode,
    rightSidebarWidth,
    setFilePreviewTarget,
    setRightPanelMode,
    setRightSidebarWidth,
    shellRef,
    toggleLeftSidebar,
    toggleRightPanelMode,
  } = useWorkbenchLayout({
    activeThreadId,
    latestAutoOpenDevPreviewUrl,
    latestDevPreviewUrl,
    route,
    workspaceRoot,
    writeAssistantOpen
  })
  const {
    activeGuiPlan,
    buildGuiPlan,
    handleGuiPlanCommand,
    openGuiPlanPanel,
    sendPlanTurn
  } = useWorkbenchPlanController({
    blocks,
    busy,
    mode,
    route,
    sendMessage,
    setError,
    setMode,
    setRightPanelMode,
    setRightSidebarWidth,
    t,
    workspaceRoot,
    onPlanBuildStarted: async (plan) => {
      const threadId = plan.threadId?.trim() || useChatStore.getState().activeThreadId
      if (!threadId || !releaseSddAssistantThread(threadId)) return
      await useChatStore.getState().refreshThreads()
    }
  })
  const mirrorClawCommand = async (userText: string, replyText: string): Promise<void> => {
    if (!activeThreadId || typeof window.dsGui?.mirrorClawChannelMessage !== 'function') return
    const userResult = await window.dsGui.mirrorClawChannelMessage(
      activeThreadId,
      userText,
      'user'
    )
    if (!userResult.ok) return
    await window.dsGui.mirrorClawChannelMessage(
      activeThreadId,
      replyText,
      'assistant'
    )
  }

  useEffect(() => {
    inputRef.current = input
  }, [input])

  useEffect(() => {
    if (rightPanelMode === 'plan' && !activeGuiPlan) {
      setRightPanelMode(null)
    }
  }, [activeGuiPlan, rightPanelMode, setRightPanelMode])

  useEffect(() => {
    if (
      !activeGuiPlan ||
      !sddUpgradeInFlightRef.current ||
      !sddPlanMatchesPendingTarget(activeGuiPlan, sddUpgradeTargetRef.current)
    ) {
      return
    }
    sddUpgradeInFlightRef.current = false
    sddUpgradeTargetRef.current = null
    useSddDraftStore.getState().setOperationStatus('idle')
    useSddDraftStore.getState().clearActiveDraft()
  }, [activeGuiPlan])

  useEffect(() => {
    if (
      busy ||
      !sddUpgradeInFlightRef.current ||
      sddDraftOperationStatus !== 'upgrading' ||
      sddPlanMatchesPendingTarget(activeGuiPlan, sddUpgradeTargetRef.current)
    ) {
      return
    }
    const timeout = window.setTimeout(() => {
      if (!sddUpgradeInFlightRef.current) return
      if (useSddDraftStore.getState().operationStatus !== 'upgrading') return
      sddUpgradeInFlightRef.current = false
      sddUpgradeTargetRef.current = null
      useSddDraftStore.getState().setOperationStatus('error', t('planToolResultMissing'))
    }, 800)
    return () => window.clearTimeout(timeout)
  }, [activeGuiPlan, busy, sddDraftOperationStatus, t])

  useEffect(() => {
    let cancelled = false
    const runtimeReady = runtimeConnection === 'ready'
    if (!runtimeReady) setRuntimeInfo(null)
    const provider = getProvider()
    void loadWorkbenchRuntimeMetadata({
      runtimeReady,
      getRuntimeInfo: provider.getRuntimeInfo ? () => provider.getRuntimeInfo!() : undefined,
      listRuntimeSkills: provider.listSkills ? () => provider.listSkills!() : undefined,
      listLocalSkills: typeof window !== 'undefined' && typeof window.dsGui?.listSkills === 'function'
        ? () => window.dsGui!.listSkills!(activeSkillWorkspace || undefined)
        : undefined
    })
      .then((metadata) => {
        if (cancelled) return
        setRuntimeInfo(metadata.runtimeInfo)
        setRuntimeSkills(metadata.runtimeSkills)
      })
      .catch(() => {
        if (!cancelled) {
          if (!runtimeReady) setRuntimeInfo(null)
          setRuntimeSkills([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeSkillWorkspace, runtimeConnection])

  const attachmentUploadEnabled = isChatAttachmentUploadEnabled({
    runtimeConnection,
    route,
    mode,
    attachmentStoreAvailable: runtimeInfo?.capabilities.attachments.available
  })
  const webAccessAvailable =
    runtimeInfo?.capabilities.web.fetch.available === true ||
    runtimeInfo?.capabilities.web.search.available === true

  const clearComposerAttachments = (): void => {
    setComposerAttachments([])
  }

  const clearComposerFileReferences = (): void => {
    setComposerFileReferences([])
  }

  const addComposerFileReference = (reference: ComposerFileReference): void => {
    setComposerFileReferences((current) => mergeComposerFileReferences(current, reference))
  }

  const removeComposerFileReference = (relativePath: string): void => {
    const key = relativePath.trim().replaceAll('\\', '/').replace(/\/+/g, '/').toLowerCase()
    setComposerFileReferences((current) =>
      current.filter((reference) =>
        reference.relativePath.trim().replaceAll('\\', '/').replace(/\/+/g, '/').toLowerCase() !== key
      )
    )
  }

  useEffect(() => {
    if (route !== 'chat') setComposerFileReferences([])
  }, [route])

  const handlePickAttachments = async (files: File[]): Promise<void> => {
    if (!files.length || !attachmentUploadEnabled) return
    const provider = getProvider()
    setAttachmentUploadBusy(true)
    setAttachmentUploadError(null)
    try {
      const workspace = threads.find((thread) => thread.id === activeThreadId)?.workspace || workspaceRoot || undefined
      const result = await uploadWorkbenchComposerImages({
        files,
        attachmentUploadEnabled,
        uploadAttachment: provider.uploadAttachment,
        attachmentCapabilities: runtimeInfo?.capabilities.attachments,
        ...(activeThreadId ? { threadId: activeThreadId } : {}),
        ...(workspace ? { workspace } : {}),
        unavailableMessage: t('composerAttachmentUnavailable')
      })
      if (result.status === 'error') {
        setAttachmentUploadError(result.message)
        return
      }
      if (result.status === 'uploaded' && result.attachments.length > 0) {
        setComposerAttachments((current) =>
          mergeWorkbenchComposerAttachments(current, result.attachments)
        )
      }
    } catch (error) {
      setAttachmentUploadError(error instanceof Error ? error.message : String(error))
    } finally {
      setAttachmentUploadBusy(false)
    }
  }

  const removeComposerAttachment = (id: string): void => {
    setComposerAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }

  const handlePasteClipboardImage = async (options: { silentNoImage?: boolean } = {}): Promise<void> => {
    if (!attachmentUploadEnabled) return
    if (typeof window.dsGui?.readClipboardImage !== 'function') {
      setAttachmentUploadError(t('composerAttachmentUnavailable'))
      return
    }
    const image = await window.dsGui.readClipboardImage()
    if (!image.ok) {
      if (options.silentNoImage) return
      setAttachmentUploadError(image.message)
      return
    }
    await handlePickAttachments([clipboardImageToFile(image)])
  }

  const sendWritePrompt = (value: string): void => {
    const v = value.trim()
    if (!v) return
    const writeState = useWriteWorkspaceStore.getState()
    const writeWorkspaceRoot = writeState.workspaceRoot || workspaceRoot
    const prompt = composeWritePrompt(v, writeState.quotedSelections, {
      workspaceRoot: writeWorkspaceRoot,
      activeFilePath: writeState.activeFilePath
    })
    setInput('')
    void (async () => {
      const threadId = await ensureWriteThreadForWorkspace(writeWorkspaceRoot)
      if (!threadId) {
        setInput(v)
        return
      }
      const model = writeState.assistantModel.trim()
      const reasoningEffort = composerReasoningEffortRequestValue(composerReasoningEffort)
      const sent = await sendMessage(prompt, mode === 'plan' ? 'plan' : 'agent', {
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {})
      })
      if (sent) {
        useWriteWorkspaceStore.getState().clearQuotedSelections()
      }
    })()
  }

  const createSddAssistantThreadForDraft = async (draft: SddDraft): Promise<string | null> => {
    const normalizedWorkspace = normalizeWorkspaceRoot(draft.workspaceRoot)
    if (!normalizedWorkspace) {
      setError(t('workspaceRequiredToCreateThread'))
      return null
    }
    if (runtimeConnection !== 'ready') {
      setError(t('runtimeActionNeedsConnection'))
      return null
    }
    try {
      const provider = getProvider()
      const thread = await provider.createThread({
        workspace: normalizedWorkspace,
        title: t('sddAssistant'),
        mode: 'agent'
      })
      const normalizedThread = {
        ...thread,
        workspace: normalizeWorkspaceRoot(thread.workspace) || normalizedWorkspace
      }
      markSddAssistantThread(draft, normalizedThread.id)
      useChatStore.setState((state) => ({
        activeThreadId: normalizedThread.id,
        threads: state.threads.some((item) => item.id === normalizedThread.id)
          ? state.threads
          : [normalizedThread, ...state.threads]
      }))
      setRoute('chat')
      await selectThread(normalizedThread.id)
      void useChatStore.getState().refreshThreads()
      return normalizedThread.id
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  const ensureSddAssistantThreadForDraft = async (draft: SddDraft): Promise<string | null> => {
    const registeredThreadId = sddAssistantThreadIdForDraft(draft)
    if (registeredThreadId) {
      setRoute('chat')
      if (useChatStore.getState().activeThreadId !== registeredThreadId) {
        await selectThread(registeredThreadId)
      }
      if (useChatStore.getState().activeThreadId === registeredThreadId) {
        return registeredThreadId
      }
    }
    return createSddAssistantThreadForDraft(draft)
  }

  const startNewSddRequirement = async (): Promise<void> => {
    const activeCodeWorkspace = activeThreadId
      ? normalizeWorkspaceRoot(codeThreads.find((thread) => thread.id === activeThreadId)?.workspace ?? '')
      : ''
    let targetWorkspace = activeCodeWorkspace || normalizeWorkspaceRoot(workspaceRoot)
    if (!targetWorkspace) {
      const picked = await chooseWorkspace({ selectThreadAfter: false })
      targetWorkspace = normalizeWorkspaceRoot(picked ?? useChatStore.getState().workspaceRoot)
    }
    if (!targetWorkspace) {
      setError(t('workspaceRequiredToCreateThread'))
      return
    }
    const draftUuid = globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now()}`
    const draft = createSddDraft({ id: draftUuid, workspaceRoot: targetWorkspace })
    const initialContent = [
      `# ${t('sddUntitledRequirement')}`,
      '',
      `## ${t('sddTemplateBackground')}`,
      '',
      `## ${t('sddTemplateGoal')}`,
      '',
      `## ${t('sddTemplateAcceptance')}`,
      ''
    ].join('\n')
    const result = await window.dsGui.createWorkspaceFile({
      workspaceRoot: targetWorkspace,
      path: draft.relativePath,
      content: initialContent
    })
    if (!result.ok) {
      setError(result.message)
      return
    }
    const activeDraft = { ...draft, absolutePath: result.path }
    useSddDraftStore.getState().setActiveDraft(activeDraft, initialContent)
    setInput('')
    setMode('agent')
    setRoute('chat')
    setRightSidebarWidth((width) => Math.max(width, 420))
    const sddThreadId = await createSddAssistantThreadForDraft(activeDraft)
    if (!sddThreadId) return
    setRightPanelMode('sdd-ai')
  }

  const sendSddAssistantPrompt = async (value: string): Promise<void> => {
    const v = value.trim()
    const draft = useSddDraftStore.getState().activeDraft
    if (!v || !draft) return
    const threadId = await ensureSddAssistantThreadForDraft(draft)
    if (!threadId) return
    const snapshot = useSddDraftStore.getState()
    void saveActiveSddDraftToDisk()
    const prompt = composeSddAssistantPrompt({
      userPrompt: v,
      draftMarkdown: snapshot.content,
      draftRelativePath: draft.relativePath,
      workspaceRoot: draft.workspaceRoot
    })
    setInput('')
    const model = writeAssistantModel.trim()
    const reasoningEffort = composerReasoningEffortRequestValue(composerReasoningEffort)
    const sent = await sendMessage(prompt, mode === 'plan' ? 'plan' : 'agent', {
      displayText: v,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {})
    })
    if (!sent) setInput(v)
  }

  const handleSddNextStep = async (): Promise<void> => {
    const snapshot = useSddDraftStore.getState()
    const draft = snapshot.activeDraft
    if (!draft) return
    if (!snapshot.content.trim()) {
      useSddDraftStore.getState().setOperationStatus('error', t('sddEmptyDraftError'))
      return
    }
    if (busy) {
      setError(t('composerQueuePlaceholder'))
      return
    }
    if (runtimeConnection !== 'ready') {
      setError(t('runtimeActionNeedsConnection'))
      return
    }
    useSddDraftStore.getState().setOperationStatus('upgrading')
    const saved = await saveActiveSddDraftToDisk()
    if (!saved) {
      useSddDraftStore.getState().setOperationStatus('error', useSddDraftStore.getState().error)
      return
    }

    const threadId = await ensureSddAssistantThreadForDraft(draft)
    if (!threadId) {
      useSddDraftStore.getState().setOperationStatus('idle')
      return
    }

    const collected = await collectSddDraftImages({
      markdown: useSddDraftStore.getState().content,
      draftRelativePath: draft.relativePath,
      workspaceRoot: draft.workspaceRoot
    })
    if (collected.errors.length > 0) {
      useSddDraftStore.getState().setOperationStatus('error', collected.errors.join('\n'))
      return
    }

    const provider = getProvider()
    const planImages = await prepareWorkbenchSddPlanImages({
      images: collected.images,
      modelSupportsImages: runtimeInfo?.capabilities.model.inputModalities.includes('image') === true,
      attachmentCapabilities: runtimeInfo?.capabilities.attachments,
      uploadAttachment: provider.uploadAttachment,
      threadId,
      workspace: draft.workspaceRoot
    })
    if (planImages.status === 'error') {
      useSddDraftStore.getState().setOperationStatus('error', planImages.message)
      return
    }

    const planTurn = buildSddDraftPlanTurn({
      assistantBlocks: blocks,
      draft,
      imageMode: planImages.imageMode,
      images: planImages.images,
      latestDraftContent: useSddDraftStore.getState().content
    })
    sddUpgradeInFlightRef.current = true
    sddUpgradeTargetRef.current = planTurn.pendingTarget
    setMode('plan')
    const sent = await sendPlanTurn(planTurn.prompt, {
      displayText: t('sddGeneratePlanAction'),
      workspaceRoot: draft.workspaceRoot,
      guiPlan: planTurn.guiPlan,
      ...(planImages.attachmentIds.length ? { attachmentIds: planImages.attachmentIds } : {})
    })
    if (!sent) {
      sddUpgradeInFlightRef.current = false
      sddUpgradeTargetRef.current = null
      useSddDraftStore.getState().setOperationStatus('idle')
    }
  }

  const handleSend = (): void => {
    void handleSendAsync()
  }

  const handleSendAsync = async (): Promise<void> => {
    const v = input.trim()
    const attachments = route === 'chat' ? composerAttachments : []
    const attachmentIds = attachments.map((attachment) => attachment.id)
    const fileReferences = route === 'chat' ? composerFileReferences : []
    const reasoningEffort = composerReasoningEffortRequestValue(composerReasoningEffort)
    const sendRoute = resolveWorkbenchSendRoute({
      activeSddDraft: Boolean(activeSddDraft),
      attachmentCount: attachmentIds.length,
      fileReferenceCount: fileReferences.length,
      input: v,
      mode,
      rightPanelMode,
      route
    })
    if (sendRoute.kind === 'ignore') return
    const prepareChatMessage = async (): Promise<{ text: string; displayText?: string } | null> => {
      const result = await prepareWorkbenchChatComposerMessage({
        activeThreadWorkspace: threads.find((thread) => thread.id === activeThreadId)?.workspace,
        attachmentIds,
        fileReferences,
        readWorkspaceFile: window.dsGui.readWorkspaceFile,
        t,
        userText: v,
        workspaceRoot
      })
      if (!result.ok) {
        if (result.error) setError(result.error)
        return null
      }
      return result.message
    }

    if (sendRoute.kind === 'sdd-assistant') {
      void sendSddAssistantPrompt(v)
      return
    }
    if (sendRoute.kind === 'gui-plan-command') {
      setInput('')
      void handleGuiPlanCommand(sendRoute.request)
      return
    }
    if (sendRoute.kind === 'chat-plan') {
      const prepared = await prepareChatMessage()
      if (!prepared) return
      setInput('')
      clearComposerAttachments()
      clearComposerFileReferences()
      void sendPlanTurn(prepared.text, buildWorkbenchSendMessageOptions({
        attachmentIds,
        attachments,
        displayText: prepared.displayText,
        reasoningEffort
      }))
      return
    }
    if (sendRoute.kind === 'write') {
      sendWritePrompt(v)
      return
    }
    if (sendRoute.kind === 'claw') {
      void handleWorkbenchClawComposer({
        value: v,
        mode: mode === 'plan' ? 'plan' : 'agent',
        activeClawChannelId,
        activeClawChannelModel: activeClawChannel?.model,
        activeThreadId,
        reasoningEffort,
        labels: {
          helpTitle: t('clawHelpTitle'),
          helpCommandHelp: t('clawHelpCommandHelp'),
          helpCommandNew: t('clawHelpCommandNew'),
          helpCommandModelAuto: t('clawHelpCommandModelAuto'),
          helpCommandModelPro: t('clawHelpCommandModelPro'),
          helpCommandModelFlash: t('clawHelpCommandModelFlash'),
          helpCommandModelShow: t('clawHelpCommandModelShow'),
          noActiveChannel: t('clawNoActiveIm'),
          newSessionStarted: t('clawNewSessionStarted'),
          modelChanged: (model) => t('clawModelChanged', { model }),
          modelCurrent: (model) => t('clawModelCurrent', { model }),
          modelCommandHint: t('clawModelCommandHint'),
          taskCreateFailed: (message) => `Failed to create scheduled task: ${message}`
        },
        clearInput: () => setInput(''),
        setError,
        appendLocalClawTurn,
        mirrorClawCommand,
        resetClawChannelSession,
        setClawChannelModel,
        createClawTaskFromText: typeof window.dsGui?.createClawTaskFromText === 'function'
          ? window.dsGui.createClawTaskFromText
          : undefined,
        selectClawChannel,
        sendMessage: async (text, sendMode, options) => {
          if (!activeThreadId) {
            return useChatStore.getState().sendMessage(text, sendMode, options)
          }
          return sendMessage(text, sendMode, options)
        }
      })
      return
    }
    const prepared = await prepareChatMessage()
    if (!prepared) return
    setInput('')
    clearComposerAttachments()
    clearComposerFileReferences()
    void sendMessage(prepared.text, mode === 'plan' ? 'plan' : 'agent', buildWorkbenchSendMessageOptions({
      attachmentIds,
      attachments,
      displayText: prepared.displayText,
      reasoningEffort
    }))
  }

  const prepareChatNavigation = (): void => {
    prepareWorkbenchChatNavigation({
      hasActiveSddDraft: Boolean(activeSddDraft),
      saveActiveSddDraft: saveActiveSddDraftToDisk,
      clearActiveSddDraft: () => useSddDraftStore.getState().clearActiveDraft(),
      closeConnectPhoneSidebar: () => setConnectPhoneSidebarOpen(false),
      setRouteToChat: () => setRoute('chat')
    })
  }

  const openThread = (id: string): void => {
    prepareChatNavigation()
    void selectThread(id)
  }

  const startNewChat = (): void => {
    prepareChatNavigation()
    void createThread()
  }

  const startNewChatInWorkspace = (workspaceRoot: string): void => {
    prepareChatNavigation()
    void createThread({ workspaceRoot })
  }

  const openCodeMode = (): void => {
    setConnectPhoneSidebarOpen(false)
    void openCode()
  }

  const openWriteMode = (): void => {
    setConnectPhoneSidebarOpen(false)
    void openWrite()
  }

  const openPluginsView = (): void => {
    setConnectPhoneSidebarOpen(false)
    openPlugins(sidebarView === 'claw' ? 'claw' : 'chat')
  }

  const openScheduleView = (): void => {
    setConnectPhoneSidebarOpen(false)
    openSchedule()
  }

  const toggleConnectPhone = (): void => {
    if (activeSddDraft) {
      void saveActiveSddDraftToDisk()
      useSddDraftStore.getState().clearActiveDraft()
      if (rightPanelMode === 'sdd-ai') setRightPanelMode(null)
    }
    openClaw()
    setConnectPhoneSidebarOpen((open) => !open)
  }

  const sidebarView = resolveWorkbenchSidebarView({ pluginHostRoute, route })

  const closeRightPanel = (): void => {
    if (route === 'write') {
      setWriteAssistantOpen(false)
      return
    }
    setRightPanelMode(null)
    setFilePreviewTarget(null)
  }

  const startNewWriteAssistantConversation = (): void => {
    const writeState = useWriteWorkspaceStore.getState()
    const writeWorkspaceRoot = writeState.workspaceRoot || workspaceRoot
    setInput('')
    writeState.clearQuotedSelections()
    void createWriteThread(writeWorkspaceRoot)
  }

  const renderRuntimeBanner = (message: string): ReactElement => (
    <RuntimeBanner
      message={message}
      runtimeReady={runtimeConnection === 'ready'}
      stageInsetClass={stageInsetClass}
      t={t}
      onOpenSettings={() => openSettings('agents')}
      onRetryConnection={() => void probeRuntime('user')}
    />
  )

  const writeRuntimeBannerMessage = resolveWriteRuntimeBannerMessage({
    error,
    runtimeConnection,
    unavailableLabel: t('writeRuntimeUnavailable')
  })
  const rightPanelContent = resolveWorkbenchRightPanelContent({
    hasActiveSddDraft: Boolean(activeSddDraft),
    rightPanelMode,
    route,
    writeAssistantOpen
  })

  const renderRightPanel = (): ReactElement | null => {
    return (
      <WorkbenchRightPanel
        activeSddDraft={activeSddDraft}
        activeThreadId={activeThreadId}
        blocks={blocks}
        busy={busy}
        composerModel={writeAssistantModel}
        composerPickList={writeAssistantPickList}
        composerModelGroups={composerModelGroups}
        composerReasoningEffort={composerReasoningEffort}
        content={rightPanelContent}
        devPreviewBlocks={devPreviewBlocks}
        filePreviewTarget={filePreviewTarget}
        input={input}
        latestDevPreviewUrl={latestDevPreviewUrl}
        liveAssistant={liveAssistant}
        liveReasoning={liveReasoning}
        mode={mode}
        onBeginResize={beginRightResize}
        onBuildPlan={() => void buildGuiPlan()}
        onCollapse={closeRightPanel}
        onInterrupt={(options) => void interrupt(options)}
        onNewSddConversation={() => {
          if (!activeSddDraft) return
          setInput('')
          void createSddAssistantThreadForDraft(activeSddDraft)
        }}
        onNewWriteConversation={startNewWriteAssistantConversation}
        onOpenPlan={openGuiPlanPanel}
        onOpenSettings={() => openSettings('agents')}
        onRetryConnection={() => void probeRuntime('user')}
        onSend={handleSend}
        queuedMessages={queuedMessages}
        removeQueuedMessage={removeQueuedMessage}
        runtimeConnection={runtimeConnection}
        setComposerModel={setWriteAssistantModel}
        setComposerReasoningEffort={setComposerReasoningEffort}
        setInput={setInput}
        setMode={setMode}
        width={rightSidebarWidth}
        workspaceRoot={workspaceRoot}
      />
    )
  }

  return (
    <div
      ref={shellRef}
      className="ds-workbench-shell ds-drag flex h-full min-h-0 w-full min-w-0 bg-ds-main"
    >
      <WorkbenchLeftSidebar
        activeThreadId={activeThreadId}
        collapsed={leftSidebarCollapsed}
        connectPhoneSidebarOpen={connectPhoneSidebarOpen}
        leftSidebarWidth={leftSidebarWidth}
        onArchiveThread={(id) => archiveThread(id, true)}
        onBeginResize={beginLeftResize}
        onCodeOpen={openCodeMode}
        onDeleteThread={deleteThread}
        onNewChat={startNewChat}
        onNewChatInWorkspace={startNewChatInWorkspace}
        onNewRequirement={() => void startNewSddRequirement()}
        onOpenPlugins={openPluginsView}
        onOpenSettings={(section) => openSettings(section)}
        onRenameThread={renameThread}
        onRestoreThread={(id) => archiveThread(id, false)}
        onScheduleOpen={openScheduleView}
        onSelectThread={openThread}
        onShowArchivedThreadsChange={setShowArchivedThreads}
        onThreadSearchChange={setThreadSearch}
        onToggleConnectPhone={toggleConnectPhone}
        onToggleSidebar={toggleLeftSidebar}
        onWriteOpen={openWriteMode}
        pluginsActive={route === 'plugins'}
        runtimeReady={runtimeConnection === 'ready'}
        route={route}
        showArchivedThreads={showArchivedThreads}
        sidebarView={sidebarView}
        threadSearch={threadSearch}
        threads={codeThreads}
      />

      <main
        className={`ds-drag ds-stage-surface relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
          route === 'plugins' ? 'px-0' : ''
        }`}
      >
        {route === 'plugins' ? (
          <>
            <div className="ds-no-drag shrink-0 px-4 pt-4">
              <SidebarTitlebarToggleButton
                onClick={toggleLeftSidebar}
                title={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
                ariaLabel={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
              />
            </div>
            <Suspense fallback={<div className="h-full bg-ds-main" />}>
              <PluginMarketplaceView />
            </Suspense>
          </>
        ) : route === 'schedule' ? (
          <Suspense fallback={<div className="h-full bg-ds-main" />}>
            <ScheduleTasksView
              leftSidebarCollapsed={leftSidebarCollapsed}
              onToggleLeftSidebar={toggleLeftSidebar}
              onOpenThread={openThread}
            />
          </Suspense>
        ) : route === 'write' ? (
          <>
            {writeRuntimeBannerMessage ? renderRuntimeBanner(writeRuntimeBannerMessage) : null}
            <div className="flex min-h-0 flex-1">
              <WriteWorkspaceView
                leftSidebarCollapsed={leftSidebarCollapsed}
                onToggleLeftSidebar={toggleLeftSidebar}
                input={input}
                setInput={setInput}
                onSubmitPrompt={sendWritePrompt}
              />
              {renderRightPanel()}
            </div>
          </>
        ) : (
          <>
        {error && !(runtimeConnection !== 'ready' && !activeThreadId) ? renderRuntimeBanner(error) : null}

        <div className="flex min-h-0 flex-1">
          <div className={`flex min-h-0 min-w-0 flex-1 ${activeSddDraft ? '' : stageInsetClass}`}>
          {activeSddDraft ? (
            <SddDraftEditorView
              leftSidebarCollapsed={leftSidebarCollapsed}
              onToggleLeftSidebar={toggleLeftSidebar}
              onNext={() => void handleSddNextStep()}
              onClose={() => {
                void saveActiveSddDraftToDisk()
                useSddDraftStore.getState().clearActiveDraft()
                if (rightPanelMode === 'sdd-ai') setRightPanelMode(null)
              }}
              nextDisabled={busy || runtimeConnection !== 'ready' || sddDraftOperationStatus === 'upgrading'}
            />
          ) : (
            <WorkbenchChatStage
              activeClawChannelId={activeClawChannelId}
              activeThreadId={activeThreadId}
              attachmentUploadBusy={attachmentUploadBusy}
              attachmentUploadEnabled={attachmentUploadEnabled}
              attachmentUploadError={attachmentUploadError}
              attachments={composerAttachments}
              blocks={timelineBlocks}
              busy={busy}
              clawChannels={clawChannels}
              composerFileReferences={composerFileReferences}
              composerModel={composerModel}
              composerModelGroups={composerModelGroups}
              composerPickList={composerPickList}
              composerReasoningEffort={composerReasoningEffort}
              hasActiveSddDraft={Boolean(activeSddDraft)}
              input={input}
              leftSidebarCollapsed={leftSidebarCollapsed}
              latestDevPreviewUrl={latestDevPreviewUrl}
              liveAssistant={timelineLiveAssistant}
              liveReasoning={timelineLiveReasoning}
              mode={mode}
              planPanelEnabled={Boolean(activeGuiPlan)}
              queuedMessages={queuedMessages}
              rightPanelMode={rightPanelMode}
              route={route}
              runtimeConnection={runtimeConnection}
              runtimeSkills={runtimeSkills}
              showDevPreviewCard={showDevPreviewCard}
              webAccessAvailable={webAccessAvailable}
              onAddFileReference={addComposerFileReference}
              onBuildPlan={() => void buildGuiPlan()}
              onBtwCommand={(seedText) => void spawnSideConversation(seedText)}
              onInterrupt={(options) => void interrupt(options)}
              onOpenDevPreview={openDevPreview}
              onOpenPlan={openGuiPlanPanel}
              onOpenSettings={() => openSettings('agents')}
              onPasteClipboardImage={(options) => void handlePasteClipboardImage(options)}
              onPickAttachments={(files) => void handlePickAttachments(files)}
              onPlanCommand={() => void handleGuiPlanCommand()}
              onRemoveAttachment={removeComposerAttachment}
              onRemoveFileReference={removeComposerFileReference}
              onRemoveQueuedMessage={removeQueuedMessage}
              onRetryConnection={() => void probeRuntime('user')}
              onReviewCommand={(target) => void reviewActiveThread(target)}
              onSelectSuggestion={(text) => setInput(text)}
              onSend={handleSend}
              onSetClawChannelModel={setClawChannelModel}
              onSetComposerModel={setComposerModel}
              onSetComposerReasoningEffort={setComposerReasoningEffort}
              onSetInput={setInput}
              onSetMode={setMode}
              onToggleLeftSidebar={toggleLeftSidebar}
              onToggleRightPanelMode={toggleRightPanelMode}
            />
          )}
          </div>

          {route === 'chat' && !activeSddDraft ? <SideConversationPanel /> : null}

          {renderRightPanel()}
        </div>

          </>
        )}
      </main>
    </div>
  )
}
