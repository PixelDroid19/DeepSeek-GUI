import {
  RuntimeEvent as RuntimeEventSchema,
  type RuntimeEvent
} from '../contracts/events.js'
import type { EventBus } from '../ports/event-bus.js'
import type { SessionStore } from '../ports/session-store.js'
import {
  getThreadEventCoordinator,
  type ThreadMutationCoordinator
} from './thread-mutation.js'

type RuntimeEventWithoutStamp<Event extends RuntimeEvent> = Omit<Event, 'seq' | 'timestamp'> &
  Partial<Pick<Event, 'seq' | 'timestamp'>>

export type RuntimeEventDraft = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent
    ? RuntimeEventWithoutStamp<Event>
    : never
  : never

export type RuntimeEventRecorderOptions = {
  eventBus: EventBus
  sessionStore: SessionStore
  /** Cheap durable deletion check used inside the event fence. */
  threadDeleted?: (threadId: string) => Promise<boolean>
  allocateSeq: (threadId: string) => number
  nowIso: () => string
  /** Optional shared state fence; lease-backed coordinators derive an event fence. */
  threadMutations?: ThreadMutationCoordinator
  /** Preferred separate fence for event sequence read/append operations. */
  eventMutations?: ThreadMutationCoordinator
}

/**
 * Application-level event boundary.
 *
 * Services and loops produce semantic event drafts; this recorder
 * stamps ordering/time, validates the public contract, fans out to
 * live subscribers, and persists the same event for SSE replay.
 */
export class RuntimeEventRecorder {
  private readonly options: RuntimeEventRecorderOptions
  private eventMutations?: ThreadMutationCoordinator
  private threadDeleted?: (threadId: string) => Promise<boolean>

  constructor(options: RuntimeEventRecorderOptions) {
    this.options = options
    this.eventMutations = getThreadEventCoordinator(options)
    this.threadDeleted = options.threadDeleted
  }

  /**
   * Lets ThreadService bind a recorder that was constructed before the
   * service. This closes the legacy-construction gap without silently
   * creating a second event fence for the same thread store.
   */
  bindEventCoordinator(coordinator: ThreadMutationCoordinator): ThreadMutationCoordinator {
    if (this.eventMutations && this.eventMutations !== coordinator) {
      throw new Error('event recorder is already bound to a different event coordinator')
    }
    this.eventMutations ??= coordinator
    return this.eventMutations
  }

  getEventCoordinator(): ThreadMutationCoordinator | undefined {
    return this.eventMutations
  }

  /** Binds the store's durable deletion marker for legacy construction paths. */
  bindThreadDeletedChecker(checker: (threadId: string) => Promise<boolean>): void {
    this.threadDeleted ??= checker
  }

  async record(draft: RuntimeEventDraft): Promise<RuntimeEvent> {
    const persist = async (): Promise<RuntimeEvent> => {
      if (this.threadDeleted && await this.threadDeleted(draft.threadId)) {
        throw new Error(`cannot record event for deleted thread: ${draft.threadId}`)
      }
      const allocatedSeq = this.options.allocateSeq(draft.threadId)
      const persistedSeq = await this.options.sessionStore.highestSeq(draft.threadId)
      const event = RuntimeEventSchema.parse({
        ...draft,
        seq: draft.seq ?? Math.max(allocatedSeq, persistedSeq + 1),
        timestamp: draft.timestamp ?? this.options.nowIso()
      })
      await this.options.sessionStore.appendEvent(event.threadId, event)
      this.options.eventBus.publish(event)
      return event
    }
    const coordinator = this.eventMutations
    return coordinator
      ? coordinator.run(draft.threadId, persist)
      : persist()
  }
}
