export interface Attachment {
  kind: 'image'|'file';
  attachmentId?:string;
  name?:string;
  bytes?:number;
  sha256?:string;
  sourceInputId?:string;
  localFile?:string;
  downloadError?:string;
  url?: string;
  file?: string;
  mimeType?: string;
}
export interface GroupMessage {
  id: string;
  platform: 'qq' | 'replay';
  roomId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  text: string;
  timestamp: number;
  replyToMessageId?: string;
  mentions: string[];
  attachments: Attachment[];
  isMentioned: boolean;
  isAdmin: boolean;
  /** Host-verified platform role; absence is unknown, never an implicit member grant. */
  memberRoleGroup?: 'group_admin' | 'member' | 'unknown';
  roleVerifiedAt?: number;
}
export interface OutgoingMessage {
  roomId: string;
  replyToMessageId?: string;
  quoteReply?:boolean;
  sourceInputId?:string;
  text: string;
  /** Explicit platform member IDs to mention in the destination room. */
  recipientIds?: string[];
  attachments?: OutgoingImage[];
  files?: OutgoingFile[];
}
/** Host-created snapshot of a task file selected for delivery to its own room. */
export interface OutgoingFile {
  kind: 'file';
  artifactId: string;
  file: string;
  name: string;
  bytes: number;
  sha256: string;
}
/** Host-created immutable image artifact, never a model-supplied URL or file path. */
export interface OutgoingImage {
  kind: 'image';
  artifactId: string;
  file: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  bytes: number;
  sha256: string;
}
export interface SendReceipt {
  /** deferred proves no platform send was attempted; it does not use the retry budget. */
  status: 'sent' | 'unknown' | 'failed' | 'deferred';
  platformMessageId?: string;
  platformFileId?: string;
  reason?: string;
  /** Safe protocol diagnostics; never include raw platform response bodies. */
  platformCode?: number;
  retryable?: boolean;
}
/** A reply confirmed sent by the platform; no ID is invented when its receipt omits one. */
export interface BotReply {
  messageId?: string;
  replyToMessageId?: string;
  text: string;
  sentAt: number;
}
export interface PublisherPort {
  privateFileUrl?(roomId:string,attachment:Attachment):Promise<string|undefined>;
  readonly privateAccess?:import('./private-chat.js').PrivateChatAccess;
  verifyFriend?(roomId:string):Promise<boolean>;
  setDeliveryGuard?(guard:(key:string,roomId:string)=>boolean):void;
  send(message: OutgoingMessage, dedupeKey: string): Promise<SendReceipt>;
  uploadFile?(roomId: string, file: OutgoingFile, dedupeKey: string): Promise<SendReceipt>;
  resolveMemberRole?(roomId:string,memberId:string):Promise<{roleGroup:'group_admin'|'member'|'unknown';verifiedAt:number}>;
}
export type ThreadStatus = 'queued' | 'running' | 'needs_input' | 'idle' | 'failed' | 'cancelled';
export interface ThreadCard {
  followupOf?:{scheduleId:string;scheduleRunId:string;threadId:string};
  id: string;
  roomId: string;
  subject: string;
  ownerId: string;
  sourceMessageId: string;
  explicit: boolean;
  participants: string[];
  status: ThreadStatus;
  revision: number;
  latestInputSeq: number;
  sessionId: string;
  epoch: number;
  summary: string;
  lastFailure?:{runId:string;code:string;revision:number;steps:number;retryable:boolean};
  scheduledTask?: ScheduledTaskBinding;
}
export interface ScheduledTaskBinding {
  scheduleId:string; scheduleRunId:string; authority:'user'|'system'; generation:number; title:string; deliveryMode?:'room'|'local';
  /** Persisted hash only; retries must use the same operator execution configuration. */
  executionConfigRevision?:string;
}
/** Host-created execution input. This is not a platform message or a new user instruction. */
export interface ScheduledExecutionInput {
  attachmentRefs?:import('./attachments.js').AttachmentRef[];
  kind:'scheduled';scheduleId:string;scheduleRunId:string;authority:'user'|'system';
  ownerId:string|null;roomId:string;title:string;instructions:string;scheduledAt:number;sourceRefs:string[];
  recipientIds?:string[];
}
/** Router interpretation, always subordinate to the attributed original messages. */
export interface RoutingContext {
  resolvedRequest: string;
  /** Current request's calculation requirement, interpreted by Router and persisted by host. */
  routingMetadata?: Record<string,unknown>;
  sourceMessageIds: string[];
  contextMessageIds?: string[];
  contextReplyIds?: string[];
  correctionTarget?: string;
}
export interface ThreadInput {
  seq: number;
  revision: number;
  message: GroupMessage;
  /** Host-resolved context from the same room, preserving each original author and ID. */
  contextMessages?: GroupMessage[];
  contextReplies?: BotReply[];
  routingContext?: RoutingContext;
  kind: 'question' | 'supplement' | 'correction';
}
export interface WorkerRequirementState {
  byAuthor:Array<{authorId:string;text:string;sourceSeqs:number[]}>;
}
export interface WorkerRequirementSnapshot extends WorkerRequirementState {
  throughInputSeq:number;
  revision:number;
  inputDigest:string;
}
export interface WorkerReport {
  /** Trusted extension receipts; stripped from model JSON, rendered only at delivery. */
  hostLinks?:import('./tools/reply-links.js').ReplyLink[];
  /** Host-only baseline for refreshing unsent replies after explicit preference changes. */
  hostMemberMemory?:import('./memory/member-updates.js').MemberMemoryProjection[];
  threadId: string;
  runId: string;
  coveredInputSeq: number;
  basedOnRevision: number;
  status: 'ready' | 'needs_input' | 'failed';
  shortAnswer: string;
  details?: string;
  assumptions: string[];
  evidenceRefs: string[];
  openQuestions: string[];
  /** Model selects only IDs returned by this run's screenshot tools. */
  images?: string[];
  /** Model selects only IDs returned by this run's artifact_publish tool. */
  files?: string[];
  /** Resolved by the host; paths and file metadata from model JSON are ignored. */
  fileAttachments?: OutgoingFile[];
  /** Populated by the host after resolving images; never accepted from model JSON. */
  attachments?: OutgoingImage[];
  /** Model-maintained attributed current requirements; original inputs remain authoritative. */
  requirementState?:WorkerRequirementState;
  /** Host-stamped only after input coverage and source validation. */
  requirementSnapshot?:WorkerRequirementSnapshot;
  /** Proposed command IDs only; the host commits them after accepting the current ready report. */
  scheduleProposalIds?:string[];
}
interface RouteContext {
  contextMessageIds?: string[];
  contextReplyIds?: string[];
  resolvedRequest?: string;
  routingMetadata?: Record<string,unknown>;
  correctionTarget?: string;
  immediateReply?: {kind:'handoff';view:'current'|'changes'} | {kind:'answer';text:string};
}
type MemberMemoryProposal = { memoryUpdates?: import('./memory/types.js').MemberMemoryUpdate[] };
export type MessageRouteAction = (
  | { action: 'reply_direct' | 'clarify'; sourceMessageIds: string[]; text: string }
  | ({ action: 'open_thread'; sourceMessageIds: string[]; subject: string; acknowledgement?: string; scheduleOperations?:import('./scheduled-tasks/tools.js').ScheduleModelMutation[] } & RouteContext)
  | ({ action: 'append_thread'; sourceMessageIds: string[]; threadId: string; kind?: 'supplement' | 'correction'; acknowledgement?: string } & RouteContext)
  | { action: 'request_status' | 'request_cancel'; sourceMessageIds: string[]; threadId: string }
  | { action: 'request_handoff'; sourceMessageIds: string[]; threadId: string; view?:'current'|'previous'|'changes' }
  | {action:'resolve_delivery';sourceMessageIds:string[];outboxId:string;partIds?:string[];decision:'received'|'abandon';expectedResolutionVersion:number;resumeSchedule?:boolean}
  | {action:'resend_delivery';sourceMessageIds:string[];outboxId:string;confirmedUnknown?:boolean;all?:boolean}
  | { action:'manage_schedule';sourceMessageIds:string[];operation:import('./scheduled-tasks/tools.js').ScheduleModelMutation }
) & MemberMemoryProposal;
export type RouteAction =
  | { action: 'silence'; sourceMessageIds: string[]; reason?: string }
  | MessageRouteAction
  | { action: 'publish_result'; resultId: string }
  | { action: 'defer_result'; resultId: string; delayMs: number };
export interface RouterAddressing {
  mentionsOthers: string[];
  replyTo?: { kind: 'bot' | 'member' | 'unknown'; authorId?: string; threadId?: string };
}
export interface RouterContextQuery {
  kind:'messages'|'threads'|'replies'|'memory'|'task_inputs'|'handoffs';
  id?:string;
  query?:string;
  authorId?:string;
  offset?:number;
  limit?:number;
  textOffset?:number;
}
export interface RouterContextPage {
  handoffs?:Array<ReturnType<typeof import('./task-handoff.js').handoffRecord>>;
  messages?:GroupMessage[];
  threads?:ThreadCard[];
  replies?:BotReply[];
  memories?:RouterMemoryNote[];
  taskInputs?:Array<{threadId:string;seq:number;revision:number;kind:ThreadInput['kind'];message:GroupMessage}>;
  hasMore:boolean;
  nextOffset?:number;
}
/** Trusted host callback scoped to one room and one intake boundary; never serialized. */
export type RouterContextReader=(query:RouterContextQuery)=>Promise<RouterContextPage>;
export type RouterMemoryNote=import('./room-memory-store.js').MemoryNote & {
  sources:Array<{seq:number;kind:'message'|'reply';id:string;authorId:string|null}>;
};
export interface RouterRequest {
  /** Prepared by the host session manager; never accepted from model output. */
  routing?:import('./runtime/persistent-router.js').PersistentRouterMetadata;
  routeTriggerKey?:string;
  roomId: string;
  currentTime?: number;
  currentTimeContext?:{date:string;time:string;weekday:string;timeZone:string;utcOffset:string;iso8601:string};
  outputContract?:{format:'json_array';allowedActions:string[];sourceMessageIds:string[];scheduleSourceGroups:{authorId:string;sourceMessageIds:string[]}[];resultId?:string};
  botUserId?: string;
  /** Host-confirmed addressing facts, keyed by each current message's full ID. */
  addressing?: Record<string, RouterAddressing>;
  /** Direct quote and unique thread binding resolved by the host, never by a model. */
  references?: Record<string, {
    status: string;
    threadId?: string;
    message?: GroupMessage;
    reply?: BotReply;
    chain: string[];
  }>;
  event: 'messages' | 'worker_result' | 'timer';
  messages: GroupMessage[];
  recentMessages: GroupMessage[];
  recentReplies?: BotReply[];
  threads: ThreadCard[];
  /** Current attributed task requirements; omitted inputs remain available through task_inputs. */
  taskStates?:Array<{threadId:string;revision:number;epoch:number;snapshot?:WorkerRequirementSnapshot;
    updates:Array<{seq:number;revision:number;kind:ThreadInput['kind'];message:GroupMessage}>;needsRecall:boolean;throughInputSeq:number;nextInputSeq:number}>;
  /** Explicit current fields from the shared memory backend, never task authorization. */
  memberMemory?: import('./memory/member-updates.js').MemberMemoryProjection[];
  memoryAvailable?: boolean;
  /** Persistent semantic hints; source IDs here do not authorize task actions. */
  workingMemory?: {
    epoch:number;version:number;coveredSeq:number;cutoffSeq:number;
    notes:RouterMemoryNote[];
    gap?:{fromSeq:number;toSeq:number};
    omittedContext?:boolean;
    omittedNotes?:boolean;
    availableNotes?:number;
  };
  result?: { id: string; threadId: string; report: WorkerReport; explicit: boolean };
}
export interface ModelSelection {
  provider: string;
  model: string;
  api?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  reasoningEffort?: string;
  maxTokens?: number;
}
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: unknown, signal?: AbortSignal): Promise<unknown>;
}
export interface WorkerRequest {
  attachmentWriter?:import('./attachments.js').ManagedFileWriter;
  budget?:{remainingSteps:number;deadlineAt:number};
  thread: ThreadCard;
  runId: string;
  inputs: ThreadInput[];
  workspace: string;
  signal?: AbortSignal;
  previousRequirementSnapshot?:WorkerRequirementSnapshot;
  scheduledInput?:ScheduledExecutionInput;
  /** Host-only tools, never serialized as part of the input snapshot. */
  taskTools?:ToolDefinition[];
}
/** Host-only execution controls; never serialized into model context. */
export interface RouterExecution {
  signal:AbortSignal;
  consumeModelCall:(summary:boolean)=>void;
  onModelCall?:(event:{purpose:string;code?:string;inputTokens:number;outputTokens:number;elapsedMs:number})=>void;
}
export interface RuntimePort {
  /** Host-owned single service, shared across both roles; never serialized into prompts. */
  readonly sharedMemory?:import('./memory/shared-memory.js').SharedMemoryService;
  route(request: RouterRequest,readContext?:RouterContextReader,execution?:RouterExecution,taskTools?:ToolDefinition[]): Promise<RouteAction[]>;
  runWorker(request: WorkerRequest): Promise<WorkerReport>;
  refreshReplyPreferences?(input:{roomId:string;text:string;memberMemory:import('./memory/member-updates.js').MemberMemoryProjection[];
    previousMemberMemory?:import('./memory/member-updates.js').MemberMemoryProjection[];replyToMemberId?:string;sourceText?:string}):Promise<string>;
  steer(threadId: string, input: ThreadInput): Promise<void>;
  /** Stop only this run; its durable inputs continue through the normal resume path. */
  supersede?(request:{threadId:string;runId:string;fromRevision:number;toRevision:number}):Promise<void>;
  cancel(threadId: string): Promise<void>;
  close(): Promise<void>;
  routerContextBudget?(roomId?:string):Promise<number>;
  routerConfigurationHash?(roomId:string):string;
  roomMemoryBudget?(request:import('./room-memory-worker.js').MemoryBudgetRequest,signal:AbortSignal):Promise<import('./room-memory-worker.js').MemoryBudget>;
  summarizeRoomMemory?(input:import('./room-memory-worker.js').MemorySummaryInput,signal:AbortSignal):Promise<import('./room-memory-store.js').MemoryNote[]>;
}
