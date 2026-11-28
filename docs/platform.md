# Platform adapter and group replay

The initial adapter is QQ via an authenticated OneBot v11 reverse WebSocket. `OneBotAdapter` implements the shared `PublisherPort`; the coordinator is platform-independent. Discord is not implemented in this first adapter.

## Starting the adapter

Creating the adapter does not start a connection. Construct it with `selfId`, a non-empty `accessToken`, and an `allowedGroupIds` list (which may be empty), then call `start()`. The adapter supports loopback `127.0.0.1` or `::1`; the CLI fixes the listener to `127.0.0.1`, default port `8083`, default path `/onebot/v11/ws`. NapCat must send `Authorization: Bearer …` and `X-Self-ID` matching the configured bot. The adapter does not log credentials or accept query-string tokens. Enable `qq.enabled` and supply the private configuration before starting the CLI service.

The adapter accepts every well-formed human message in allowed groups, including messages without mentions. It ignores self echoes, unauthorized private messages, temporary private sessions, other groups, wrong bot identities, and transport duplicates. Authorized friend messages use `qq:<botId>:private:<peerId>` and activate directly; see [private chat](private-chat.md). Plain text that resembles CQ code stays plain text. Structured mentions, replies, image references and sender roles remain separate data. A trusted room scope has the form `qq:<botId>:<groupId>`; message IDs add the platform message ID to that scope.

`onMessage` must persist/queue the normalized event before resolving. The adapter deduplicates successful/in-flight callbacks in memory; the coordinator's database provides durable deduplication across restarts. Errors or overflow are surfaced through `onError` and are not recorded as successfully handled. OneBot does not guarantee replay after receiver failure, so an operator must monitor these errors; do not describe every received packet as processed after an overflow.

## Sending and recovery

`send(outgoing, dedupeKey)` only targets the configured bot and allowed groups or currently authorized private peers. Private output rejects nonempty `recipientIds` and uses `send_private_msg` with `user_id`. It supports literal text, an optional reply segment, optional `recipientIds` (up to 50 explicit member IDs), and up to four host-validated image segments. QQ recipients must be positive decimal QQ IDs; duplicate IDs are mentioned once, and invalid IDs or `all` are rejected before sending. Recipients produce real OneBot `at` segments before the text. Literal `@name`, `@123` and CQ-looking text are never parsed as mentions. Mention-only messages are supported. Images are read from allowed task artifacts and validated before sending; each is limited to 10 MiB and their aggregate to 20 MiB. Image-only replies are supported. Text over 20,000 characters is rejected with `unsupported_output`; automatic splitting is not implemented. The publisher must preserve payload identity when retrying.

The method waits for the matching OneBot echo response:

- `sent` requires `status: ok`, `retcode: 0` and a returned message ID.
- `deferred` proves no platform send was attempted, for example when disconnected. Coordinator keeps the outbox pending and waits five seconds without consuming its send-attempt budget.
- `failed` means local output validation failed or the platform explicitly rejected the action. Coordinator permits a bounded retry, up to three send attempts.
- `unknown` means a request was sent but delivery cannot be established (timeout, disconnect, async receipt, malformed receipt). It must not be retried automatically.

The adapter keeps a bounded in-memory publication cache. Durable outbox state belongs to the coordinator. A changed payload with the same deduplication key is rejected. This API does not claim exactly-once delivery from OneBot.

### QQ group files

Worker replies may also contain up to four host-registered files, each at most 10 MiB and at most 20 MiB combined. These are uploaded to QQ group files before the reply text/images are sent; they are not image segments or links to server paths. The platform adapter validates the target bot/group, immutable artifact bytes and bridge receipt. The deployed bridge must support the group-file upload action and have permission to upload to the target group; a successful local artifact registration does not prove that QQ received it.

The coordinator persists a separate delivery record for every file. It skips confirmed uploads on retry and retries only actions with a definite failure or no attempted send. An uncertain upload stops further delivery. After a crash, an in-flight upload becomes `unknown`, never an automatic re-upload. A success response without a usable file ID is also uncertain. Parent Outbox `sent` means every file and the reply message have been confirmed. Partial uploads remain visible when the remaining files or the text fail.

Cancellation, superseding input and invalidated scheduled runs prevent subsequent uploads and the reply message. Already uploaded files are not removed; an upload already accepted by the bridge cannot be recalled by cancelling the task. Ordinary and scheduled Worker results use this same delivery path. The admin shows each file's name, size, upload status and failure reason, without exposing its local path or offering a file download endpoint.

Worker answers, clarification requests and reported failures quote the platform message ID of the last input covered by that report (`coveredInputSeq`). After a follow-up, they quote that follow-up instead of the thread's original question. A terminal Worker exception quotes the latest input in that thread. Referenced images and unrelated room messages do not become reply targets. The thread retains its original `sourceMessageId`; the chosen reply target is saved with the outgoing message and remains fixed during delivery retries. Superseded answers are still suppressed before sending.

## Private files and receipt resolution

Private file input, bridge version contracts, snapshot retention, personal schedules and receipt resolution are described in [private chat](private-chat.md). File contracts are explicit startup configuration. `unknown` remains a platform fact after a user or administrator resolves the corresponding delivery; resends create new outboxes with fixed per-part associations. Real QQ integration remains an operator verification step.

## Images

Keep image references on inbound messages; do not fetch every group image. Router and Worker both receive real images. The Router checks group activation first; authorized private inputs do not require a mention. It selects up to four images, prioritizing current addressed messages, then explicit quotes. Other historical images are loaded only on an exact source read. Images retain their source message and attachment index. Exact historical message reads through `router_context` can also attach up to four images from the current author or an explicit quote; broad searches return markers only. An unrelated sticker does not justify appending to a running task. Simple visual replies can finish in the Router; substantive analysis still goes to the Worker with original image context.

Persistent Router requests store attachment markers. The host resolves those markers against the original same-room message before downloading; URLs and base64 bytes are not added to the routing JSON. Format repairs resend the selected images, and download failures and capacity omissions are reported separately. Router image preparation uses the turn cancellation/deadline, and image telemetry identifies the router or worker role. The configured Router model must support image input.

For selected Router and Worker inputs, `resolveOneBotImage()` first tries validated persistent cached bytes, then the message's trusted HTTPS CDN URL, and then authenticated `get_image`. The bridge response may supply base64 content, a file strictly inside an explicitly configured cache root, or a refreshed trusted URL. URL access is restricted to three QQ image CDN hosts; downloads have byte/time bounds and disallow redirects. Supported signatures are PNG, JPEG, GIF and WebP. Validated bytes are cached privately under `stateDir/incoming-images` and converted to attachments for a vision-capable model. Unsupported or unavailable images are reported explicitly. `fixture-item.png` in routing fixtures is a marker, not a real image.

The default WebSocket payload limit allows the base64 encoding of one 10 MiB image plus 64 KiB for the JSON envelope. The image resolver separately enforces its 10 MiB decoded-byte limit. `OneBotOptions.maxMessageBytes` can override the transport limit; a smaller limit may reject otherwise supported image replies before decoding.

## Replay fixture contract

`fixtures/group-replay.json` currently contains 16 synthetic discussion scenarios / 48 messages. They cover ordinary chat, premise-only arithmetic, retrieval tasks, corrections, separate authors and explicit references, missing information, image requests, independent activation, status and cancellation. These are hand-labelled examples for offline checks, not evidence of real-group quality or a statistically established success rate. Recount scenarios and messages when changing the fixture.

Each scenario has `id`, `title`, `tags`, `split`, `messages: GroupMessage[]`, and `expected`. Evaluate messages in chronological order and update Thread cards between decisions. Each expectation provides:

- `messageId`: the full normalized message ID corresponding to `sourceMessageIds`.
- `actions`: accepted routing actions. This allows appropriate silence vs a brief social reply without asserting exact wording.
- `threadFrom` (optional): the full ID of the earlier message that created the required Thread. Resolve it through the evaluator's newly-created Thread mapping.

Do not use the expected labels as runtime input. A new explicit task should open a Thread; later supplements should append to the matching Thread when the context supports it.

The CLI replay calls `runtime.route` with synthetic recent messages and task cards. It does not construct a Coordinator, run Workers, send replies, or exercise the durable turn manager, even if the deployment has `persistentRouter: true`. It measures action selection under the supplied context, not production recovery or end-to-end delivery. Its synthetic room IDs use the default business profile rather than real QQ room bindings. Use the persistent Router/Coordinator tests for transaction and recovery coverage; see [verification](verification.md).

## Verification

`npx vitest run tests/platform.test.ts tests/platform-fixtures.test.ts` uses only local WebSocket clients and mock action responses. Tests cover unmentioned intake, scope checks, plain-text CQ handling, mentions/replies/images, duplicate delivery, callback failure, handshake authentication, definitive vs uncertain delivery, publication deduplication, disconnects, and image-source restrictions. No test connects to an actual QQ account or sends a real group message.
