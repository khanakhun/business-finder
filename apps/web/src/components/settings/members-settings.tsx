'use client';

import type { Invitation, Member, Role } from '@bf/contracts';
import { Button } from '@bf/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@bf/ui/components/dialog';
import { ErrorState } from '@bf/ui/components/error-state';
import { Label } from '@bf/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@bf/ui/components/select';
import { Skeleton } from '@bf/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@bf/ui/components/table';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlusIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';
import { Field, FormError, useErrorMessage } from '@/components/auth/fields.tsx';
import { toProblemLike, useErrorLabels } from '@/components/states/problem.ts';
import { apiClient, queryKeys } from '@/lib/api.ts';
import { usePermission, useSession } from '@/lib/session.tsx';
import { getToast } from '@/lib/toast.tsx';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { Forbidden } from './forbidden.tsx';
import { SettingsSection } from './section.tsx';

const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'viewer'];

/** Mirrors the API's rule (membership-policy.ts) so the UI only offers what will succeed. */
const assignable = (actor: Role | null): readonly Role[] =>
  actor === 'owner' ? ROLES : actor === 'admin' ? ['admin', 'member', 'viewer'] : [];

export function MembersSettings() {
  const t = useTranslations();
  const canManage = usePermission('members:manage');
  const labels = useErrorLabels();
  const query = useQuery({
    queryKey: queryKeys.identity.members(),
    queryFn: async () => (await apiClient().GET('/v1/members')).data,
    enabled: canManage,
  });
  const [inviting, setInviting] = React.useState(false);

  if (!canManage) return <Forbidden />;
  if (query.isError) {
    return (
      <ErrorState
        problem={toProblemLike(query.error, t('errors.pageTitle'))}
        labels={labels}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return (
    <div className="grid gap-6">
      <SettingsSection
        id="members"
        title={t('members.title')}
        action={
          <Button onClick={() => setInviting(true)}>
            <UserPlusIcon aria-hidden />
            {t('members.invite')}
          </Button>
        }
      >
        {query.data ? <MembersTable members={query.data.members} /> : <Skeleton className="h-24" />}
      </SettingsSection>
      <SettingsSection id="pending" title={t('members.pending')}>
        {query.data ? (
          <PendingInvitations invitations={query.data.invitations} />
        ) : (
          <Skeleton className="h-12" />
        )}
      </SettingsSection>
      {inviting ? <InviteDialog open={inviting} onOpenChange={setInviting} /> : null}
    </div>
  );
}

function useMembersMutation<T>(
  fn: (input: T) => Promise<unknown>,
  success: string | ((input: T) => string),
  { toastErrors = true } = {},
) {
  const client = useQueryClient();
  const errorMessage = useErrorMessage();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (_data, input) => {
      await client.invalidateQueries({ queryKey: queryKeys.identity.members() });
      (await getToast()).success(typeof success === 'function' ? success(input) : success);
    },
    onError: async (error) => {
      if (toastErrors) (await getToast()).error(errorMessage(error));
    },
  });
}

function MembersTable({ members }: { readonly members: readonly Member[] }) {
  const t = useTranslations();
  const format = useFormatter();
  const me = useSession();
  const actorRole = me.role;
  const [confirm, setConfirm] = React.useState<{ kind: 'remove' | 'transfer'; member: Member } | null>(null);
  const changeRole = useMembersMutation(
    ({ id, role }: { id: string; role: Role }) =>
      apiClient().PATCH('/v1/members/{memberId}', { params: { path: { memberId: id } }, body: { role } }),
    t('members.roleChanged'),
  );
  const remove = useMembersMutation(
    (id: string) => apiClient().DELETE('/v1/members/{memberId}', { params: { path: { memberId: id } } }),
    t('members.removed'),
    { toastErrors: false },
  );
  const transfer = useMembersMutation(
    (id: string) => apiClient().POST('/v1/members/transfer-ownership', { body: { memberId: id } }),
    t('members.roleChanged'),
    { toastErrors: false },
  );

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('members.name')}</TableHead>
            <TableHead>{t('members.role')}</TableHead>
            <TableHead className="hidden sm:table-cell">{t('members.joined')}</TableHead>
            <TableHead className="text-right">{t('members.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => {
            const self = member.userId === me.user.id;
            const protectedOwner = member.role === 'owner' && actorRole !== 'owner';
            const options = assignable(actorRole);
            return (
              <TableRow key={member.id}>
                <TableCell>
                  <div className="font-medium">
                    {member.name}
                    {self ? <span className="ml-1 text-muted-foreground">({t('members.you')})</span> : null}
                  </div>
                  <div className="text-sm text-muted-foreground">{member.email}</div>
                </TableCell>
                <TableCell>
                  {protectedOwner || options.length === 0 ? (
                    t(`roles.${member.role}`)
                  ) : (
                    <Select
                      value={member.role}
                      onValueChange={(role) => changeRole.mutate({ id: member.id, role: role as Role })}
                    >
                      <SelectTrigger className="w-36" aria-label={t('members.role')}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.filter((role) => options.includes(role) || role === member.role).map(
                          (role) => (
                            <SelectItem key={role} value={role}>
                              {t(`roles.${role}`)}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                  )}
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {format.dateTime(new Date(member.joinedAt), { dateStyle: 'medium' })}
                </TableCell>
                <TableCell className="text-right">
                  {actorRole === 'owner' && !self ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirm({ kind: 'transfer', member })}
                    >
                      {t('members.transfer')}
                    </Button>
                  ) : null}
                  {protectedOwner ? null : (
                    <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: 'remove', member })}>
                      {t('members.remove')}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {confirm ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => (open ? undefined : setConfirm(null))}
          title={
            confirm.kind === 'remove'
              ? t('members.removeConfirm', { name: confirm.member.name })
              : t('members.transferConfirm', { name: confirm.member.name })
          }
          confirmLabel={confirm.kind === 'remove' ? t('members.remove') : t('members.transfer')}
          onConfirm={async () => {
            if (confirm.kind === 'remove') await remove.mutateAsync(confirm.member.id);
            else {
              await transfer.mutateAsync(confirm.member.id);
              // The caller's own role changed: reload so permissions everywhere follow.
              window.location.reload();
            }
          }}
        />
      ) : null}
    </>
  );
}

function PendingInvitations({ invitations }: { readonly invitations: readonly Invitation[] }) {
  const t = useTranslations();
  const format = useFormatter();
  const resend = useMembersMutation(
    (invitation: Invitation) =>
      apiClient().POST('/v1/invitations/{invitationId}/resend', {
        params: { path: { invitationId: invitation.id } },
      }),
    (invitation) => t('members.invited', { email: invitation.email }),
  );
  const revoke = useMembersMutation(
    (invitation: Invitation) =>
      apiClient().DELETE('/v1/invitations/{invitationId}', {
        params: { path: { invitationId: invitation.id } },
      }),
    t('members.inviteRevoked'),
  );
  if (invitations.length === 0) return <p className="text-muted-foreground">{t('members.noPending')}</p>;
  return (
    <ul className="grid gap-2">
      {invitations.map((invitation) => (
        <li
          key={invitation.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
        >
          <div>
            <p className="font-medium">{invitation.email}</p>
            <p className="text-sm text-muted-foreground">
              {t(`roles.${invitation.role}`)} ·{' '}
              {t('members.expires', {
                date: format.dateTime(new Date(invitation.expiresAt), { dateStyle: 'medium' }),
              })}
            </p>
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => resend.mutate(invitation)}>
              {t('members.resend')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => revoke.mutate(invitation)}>
              {t('members.revoke')}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function InviteDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations();
  const me = useSession();
  const client = useQueryClient();
  const errorMessage = useErrorMessage();
  const options = assignable(me.role);
  const [role, setRole] = React.useState<Role>(
    options.includes('member') ? 'member' : (options[0] ?? 'viewer'),
  );
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email'));
    setError(null);
    setPending(true);
    try {
      await apiClient().POST('/v1/invitations', { body: { email, role } });
      await client.invalidateQueries({ queryKey: queryKeys.identity.members() });
      (await getToast()).success(t('members.invited', { email }));
      onOpenChange(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('members.inviteTitle')}</DialogTitle>
          <DialogDescription>{t('members.inviteDescription')}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <FormError message={error} />
          <Field label={t('auth.email')} name="email" type="email" required autoFocus />
          <div className="grid gap-1.5">
            <Label htmlFor="invite-role">{t('members.role')}</Label>
            <Select value={role} onValueChange={(value) => setRole(value as Role)}>
              <SelectTrigger id="invite-role" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(`roles.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {t('members.sendInvite')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
