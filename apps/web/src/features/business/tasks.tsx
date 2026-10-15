'use client';

import type { Task, TaskType } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import { Checkbox } from '@bf/ui/components/checkbox';
import { Input } from '@bf/ui/components/input';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { cn } from '@bf/ui/lib/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useFormatter, useNow, useTranslations } from 'next-intl';
import * as React from 'react';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { usePermission } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { useBusinessMutation, useBusinessTasks, useCrmErrorMessage, useTeammates } from './api.ts';

export const TASK_TYPE_OPTIONS: readonly TaskType[] = ['follow_up', 'call', 'email', 'visit', 'other'];

/** Completes (or reopens) a task, refreshing its business and every task list. */
export function useCompleteTask() {
  const client = useQueryClient();
  const t = useTranslations('business.tasks');
  const message = useCrmErrorMessage();
  return useMutation({
    mutationFn: async ({ task, done }: { task: Task; done: boolean }) =>
      (
        await apiClient().PATCH('/v1/tasks/{id}', {
          params: { path: { id: task.id } },
          body: { status: done ? 'done' : 'open' },
        })
      ).data as Task,
    onSuccess: async (task) => {
      if (task.status === 'done') (await getToast()).success(t('completed', { title: task.title }));
    },
    onError: async (error) => (await getToast()).error(message(error)),
    onSettled: async (_task, _error, { task }) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['business', task.businessId] }),
        client.invalidateQueries({ queryKey: queryKeys.crm.all }),
      ]);
    },
  });
}

/** One task: a checkbox to complete it, its due date (overdue in amber), and optionally its business. */
export function TaskRow({
  task,
  showBusiness = false,
}: {
  readonly task: Task;
  readonly showBusiness?: boolean;
}) {
  const t = useTranslations('business.tasks');
  const types = useTranslations('business.taskTypes');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const canWrite = usePermission('business:write');
  const { byUser } = useTeammates();
  const complete = useCompleteTask();
  const done = task.status === 'done';
  const due = task.dueAt ? new Date(task.dueAt) : null;
  const overdue = !done && due !== null && due < now;
  const id = `task-${task.id}`;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <Checkbox
        id={id}
        className="mt-0.5"
        checked={done}
        disabled={!canWrite || complete.isPending}
        aria-label={done ? t('reopen', { title: task.title }) : t('complete', { title: task.title })}
        onCheckedChange={(checked) => complete.mutate({ task, done: checked === true })}
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <label htmlFor={id} className={cn('block text-sm', done && 'text-muted-foreground line-through')}>
          {task.title}
        </label>
        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          <span>{types(task.type)}</span>
          {due ? (
            <span className={overdue ? 'font-medium text-buoy' : undefined}>
              {overdue
                ? t('overdue', { when: format.relativeTime(due, now) })
                : format.dateTime(due, { dateStyle: 'medium', timeStyle: 'short' })}
            </span>
          ) : (
            <span>{t('noDue')}</span>
          )}
          {task.assigneeId ? <span>{byUser.get(task.assigneeId)?.name ?? ''}</span> : null}
          {showBusiness ? (
            <Link href={`/businesses/${task.businessId}`} className="text-lagoon hover:underline">
              {task.businessName}
            </Link>
          ) : null}
        </p>
      </div>
    </li>
  );
}

/** The business's open tasks and a form to add one (assigned to me unless I pick someone). */
export function BusinessTasksPanel({ businessId }: { readonly businessId: string }) {
  const t = useTranslations('business.tasks');
  const types = useTranslations('business.taskTypes');
  const canWrite = usePermission('business:write');
  const tasks = useBusinessTasks(businessId);
  const teammates = useTeammates();
  const [title, setTitle] = React.useState('');
  const [type, setType] = React.useState<TaskType>('follow_up');
  const [due, setDue] = React.useState('');
  const [assignee, setAssignee] = React.useState('me');
  const id = React.useId();
  const add = useBusinessMutation(
    businessId,
    async () =>
      (
        await apiClient().POST('/v1/businesses/{id}/tasks', {
          params: { path: { id: businessId } },
          body: {
            title: title.trim(),
            type,
            ...(due ? { dueAt: new Date(due).toISOString() } : {}),
            ...(assignee !== 'me' ? { assigneeId: assignee } : {}),
          },
        })
      ).data as Task,
    { success: (task) => t('added', { title: task.title }) },
  );
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3">
      <h2 id={`${id}-title`} className="text-base font-semibold">
        {t('title')}
      </h2>
      {tasks.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : (tasks.data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y">
          {(tasks.data?.items ?? []).map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </ul>
      )}
      {canWrite ? (
        <form
          className="space-y-2 rounded-lg border bg-surface-sunken/50 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!title.trim()) return;
            add.mutate(undefined, {
              onSuccess: () => {
                setTitle('');
                setDue('');
              },
            });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={`${id}-name`}>{t('new')}</Label>
            <Input
              id={`${id}-name`}
              value={title}
              maxLength={200}
              placeholder={t('placeholder')}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Select value={type} onValueChange={(value) => setType(value as TaskType)}>
              <SelectTrigger size="sm" aria-label={t('type')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TASK_TYPE_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {types(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="datetime-local"
              aria-label={t('due')}
              value={due}
              className="h-8"
              onChange={(event) => setDue(event.target.value)}
            />
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger size="sm" aria-label={t('assignee')} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">{t('me')}</SelectItem>
                {(teammates.data?.items ?? []).map((teammate) => (
                  <SelectItem key={teammate.userId} value={teammate.userId}>
                    {teammate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={!title.trim() || add.isPending}>
              {t('add')}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
