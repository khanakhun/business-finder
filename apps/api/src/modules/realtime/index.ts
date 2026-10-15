// Public surface of the realtime module (ARCHITECTURE.md §5.1).

export { NotificationService, type NotifyInput } from './application/notification.service.ts';
export { type PublishInput, RealtimePublisher } from './application/realtime-publisher.ts';
export { type SseMessage, type SseStreamOptions, serveSse } from './interface/sse.ts';
export { RealtimeModule } from './realtime.module.ts';
