import type { ApiEnv } from '@bf/config';
import {
  type ChangeRequest,
  type Clock,
  ConflictError,
  type CreateChangeRequest,
  CreateChangeRequestSchema,
  type DecideApproval,
  DecideApprovalSchema,
  ForbiddenError,
  type InvitePortalClientRequest,
  InvitePortalClientRequestSchema,
  NotFoundError,
  newId,
  type PortalAttachmentUpload,
  type PortalAttachmentUploadRequest,
  PortalAttachmentUploadRequestSchema,
  type PortalGrant,
  type PortalLead,
  type PortalSite,
  type PortalStats,
  type RequestApproval,
  RequestApprovalSchema,
  type SiteApproval,
  ValidationError,
} from '@bf/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CrmPipeline } from '../../../crm/index.ts';
import { MemberDirectory, SYSTEM_MAILER, type SystemMailer } from '../../../identity/index.ts';
import { CLOCK } from '../../../platform/clock/clock.module.ts';
import { APP_ENV, type AppEnv } from '../../../platform/config/app-env.ts';
import type { AuthContext } from '../../../platform/security/auth-context.ts';
import { OBJECT_PRESIGNER, type ObjectPresigner } from '../../../platform/storage/s3-presigner.ts';
import { AuditLogger } from '../../../workspace/index.ts';
import { publicationUrl } from '../mappers.ts';
import { UPLOAD_SIGNER, type UploadSigner } from '../ports.ts';
import type { SiteActor } from '../sites.commands.ts';
import {
  type ApprovalRecord,
  type ChangeRequestRecord,
  PORTAL_REPOSITORY,
  type PortalRepository,
  type PortalSiteRecord,
} from './ports.ts';

// The client handover portal (BF-062). The agency invites the business owner per site; the owner signs in with a
// magic link (Better Auth; staff accounts never do) and sees only the sites granted to them. A client has no
// workspace membership, so every workspace route keeps refusing them; portal routes check the grant on each call
// (a revoked grant takes effect at once) and answer 404 for a site that is not theirs.
//
// DECISION(BF-062): the "client role scoped to site ids" is a per-site grant rather than a workspace role. A
// workspace role would give clients an organization context, and with it every route a role matrix mistake opens;
// with grants, isolation is the absence of membership (fail closed).

const STATS_DAYS = 30;
const LIST_LIMIT = 100;
const ATTACHMENT_UPLOAD_SECONDS = 5 * 60;
const ATTACHMENT_LINK_SECONDS = 3_600;

@Injectable()
export class PortalService {
  constructor(
    @Inject(PORTAL_REPOSITORY) private readonly repository: PortalRepository,
    @Inject(UPLOAD_SIGNER) private readonly uploads: UploadSigner,
    @Inject(OBJECT_PRESIGNER) private readonly presigner: ObjectPresigner,
    @Inject(SYSTEM_MAILER) private readonly mailer: SystemMailer,
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly members: MemberDirectory,
    private readonly crm: CrmPipeline,
    private readonly audit: AuditLogger,
  ) {}

  // ── Agency ────────────────────────────────────────────────────────────────────────────────────────────────────

  private async agencySite(actor: SiteActor, siteId: string): Promise<PortalSiteRecord> {
    const site = await this.repository.agencySite(actor.organizationId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    return site;
  }

  async grants(actor: SiteActor, siteId: string): Promise<PortalGrant[]> {
    await this.agencySite(actor, siteId);
    return (await this.repository.grants(actor.organizationId, siteId)).map((grant) => ({
      id: grant.id,
      siteId: grant.siteId,
      email: grant.email,
      acceptedAt: grant.acceptedAt?.toISOString() ?? null,
      invitedAt: grant.createdAt.toISOString(),
    }));
  }

  async invite(actor: SiteActor, siteId: string, input: InvitePortalClientRequest): Promise<PortalGrant[]> {
    const request = InvitePortalClientRequestSchema.parse(input);
    const site = await this.agencySite(actor, siteId);
    const email = request.email.trim().toLowerCase();
    if (await this.repository.isStaff(email))
      throw new ConflictError(
        'This address belongs to a workspace member; invite the business owner instead.',
      );
    const grant = await this.repository.grant({
      id: newId(),
      organizationId: actor.organizationId,
      siteId,
      email,
      invitedBy: actor.userId,
    });
    const fr = request.locale === 'fr';
    await this.mailer.sendNotification({
      to: email,
      locale: request.locale,
      title: fr ? `Votre espace pour le site ${site.name}` : `Your portal for the ${site.name} website`,
      body: fr
        ? 'Suivez les visites et les demandes de contact de votre site, demandez des modifications et validez les nouvelles versions. Connectez-vous avec cette adresse e-mail : un lien de connexion vous sera envoyé.'
        : 'Follow your website’s visits and contact requests, ask for changes and approve new versions. Sign in with this email address: a sign-in link will be sent to you.',
      url: `${(this.env as ApiEnv).APP_URL}/portal/sign-in`,
    });
    await this.audit.record({
      action: 'sites.portal_invited',
      organizationId: actor.organizationId,
      entityType: 'site',
      entityId: siteId,
      metadata: { grantId: grant.id },
    });
    return this.grants(actor, siteId);
  }

  async revoke(actor: SiteActor, siteId: string, grantId: string): Promise<void> {
    await this.agencySite(actor, siteId);
    if (!(await this.repository.revoke(actor.organizationId, siteId, grantId, this.clock.now())))
      throw new NotFoundError('PortalGrant', grantId);
    await this.audit.record({
      action: 'sites.portal_revoked',
      organizationId: actor.organizationId,
      entityType: 'site',
      entityId: siteId,
      metadata: { grantId },
    });
  }

  async requestApproval(actor: SiteActor, siteId: string, input: RequestApproval): Promise<SiteApproval[]> {
    const request = RequestApprovalSchema.parse(input);
    const site = await this.agencySite(actor, siteId);
    if ((await this.repository.versionNumber(siteId, request.versionId)) === undefined)
      throw new NotFoundError('SiteVersion', request.versionId);
    await this.repository.requestApproval({
      id: newId(),
      organizationId: actor.organizationId,
      siteId,
      versionId: request.versionId,
      note: request.note,
      requestedBy: actor.userId,
    });
    for (const grant of await this.repository.grants(actor.organizationId, siteId)) {
      const contact = grant.userId ? await this.members.contact(grant.userId) : undefined;
      const fr = (contact?.locale ?? 'fr') === 'fr';
      await this.mailer.sendNotification({
        to: grant.email,
        locale: fr ? 'fr' : 'en',
        title: fr
          ? `Une nouvelle version de ${site.name} attend votre validation`
          : `A new version of ${site.name} is waiting for your approval`,
        body: fr
          ? 'Consultez-la depuis votre espace, puis validez-la ou demandez des modifications.'
          : 'Look at it from your portal, then approve it or ask for changes.',
        url: `${(this.env as ApiEnv).APP_URL}/portal/sites/${siteId}`,
      });
    }
    return this.approvalsOf(site);
  }

  async agencyApprovals(actor: SiteActor, siteId: string): Promise<SiteApproval[]> {
    return this.approvalsOf(await this.agencySite(actor, siteId));
  }

  async agencyChangeRequests(actor: SiteActor, siteId: string): Promise<ChangeRequest[]> {
    await this.agencySite(actor, siteId);
    const bucket = (this.env as ApiEnv).S3_BUCKET_ASSETS;
    return Promise.all(
      (await this.repository.changeRequests(siteId, LIST_LIMIT)).map(async (request) =>
        this.toChangeRequest(request, (key) =>
          this.presigner.presignGet(bucket, key, ATTACHMENT_LINK_SECONDS),
        ),
      ),
    );
  }

  // ── Client ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** The signed-in client (sessions only: API keys belong to workspaces). Links new grants on the way. */
  private async client(auth: AuthContext): Promise<string> {
    if (auth.method !== 'session' || !auth.userId)
      throw new ForbiddenError('The portal needs a signed-in user.');
    const contact = await this.members.contact(auth.userId);
    if (contact) await this.repository.claim(auth.userId, contact.email, this.clock.now());
    return auth.userId;
  }

  private async clientSite(
    auth: AuthContext,
    siteId: string,
  ): Promise<{ userId: string; site: PortalSiteRecord }> {
    const userId = await this.client(auth);
    const site = await this.repository.site(userId, siteId);
    if (!site) throw new NotFoundError('Site', siteId);
    return { userId, site };
  }

  async sites(auth: AuthContext): Promise<PortalSite[]> {
    const userId = await this.client(auth);
    return (await this.repository.sites(userId)).map((site) => this.toPortalSite(site));
  }

  async site(auth: AuthContext, siteId: string): Promise<PortalSite> {
    return this.toPortalSite((await this.clientSite(auth, siteId)).site);
  }

  async stats(auth: AuthContext, siteId: string): Promise<PortalStats> {
    const { site } = await this.clientSite(auth, siteId);
    const now = this.clock.now();
    const since = new Date(now.getTime() - (STATS_DAYS - 1) * 86_400_000);
    const [views, leads] = await Promise.all([
      this.repository.views(site.siteId, since.toISOString().slice(0, 10)),
      this.repository.leadCount(site.siteId, since),
    ]);
    return { days: STATS_DAYS, ...views, leads };
  }

  async leads(auth: AuthContext, siteId: string): Promise<PortalLead[]> {
    const { site } = await this.clientSite(auth, siteId);
    return this.repository.leads(site.siteId, LIST_LIMIT);
  }

  async uploadAttachment(
    auth: AuthContext,
    siteId: string,
    input: PortalAttachmentUploadRequest,
  ): Promise<PortalAttachmentUpload> {
    const request = PortalAttachmentUploadRequestSchema.parse(input);
    const { userId, site } = await this.clientSite(auth, siteId);
    const id = newId();
    const objectKey = `portal/${site.organizationId}/${site.siteId}/${id}`;
    const signed = await this.uploads.presignPut(
      objectKey,
      request.contentType,
      request.bytes,
      ATTACHMENT_UPLOAD_SECONDS,
    );
    await this.repository.addAttachment({
      id,
      organizationId: site.organizationId,
      siteId: site.siteId,
      uploadedBy: userId,
      objectKey,
      contentType: request.contentType,
      bytes: request.bytes,
    });
    return { id, uploadUrl: signed.url, headers: signed.headers };
  }

  async createChangeRequest(
    auth: AuthContext,
    siteId: string,
    input: CreateChangeRequest,
  ): Promise<ChangeRequest> {
    const request = CreateChangeRequestSchema.parse(input);
    const { userId, site } = await this.clientSite(auth, siteId);
    const attachments = await this.repository.attachments(site.siteId, request.attachmentIds);
    const usable = attachments.filter((file) => file.uploadedBy === userId && file.changeRequestId === null);
    if (usable.length !== new Set(request.attachmentIds).size)
      throw new ValidationError('Some screenshots are unknown or already sent.', [
        { path: ['attachmentIds'], message: 'Upload the screenshots again' },
      ]);
    const id = newId();
    await this.repository.addChangeRequest(
      {
        id,
        organizationId: site.organizationId,
        siteId: site.siteId,
        requestedBy: userId,
        message: request.message,
        pageHint: request.pageHint,
      },
      request.attachmentIds,
    );
    const taskId = await this.crm.followUp(site.organizationId, site.businessId, {
      title: `Change request (${site.name}): ${request.message.replace(/\s+/g, ' ').slice(0, 140)}`,
      type: 'other',
      dueAt: null,
      assigneeId: await this.crm.ownerOf(site.organizationId, site.businessId),
    });
    if (taskId) await this.repository.setChangeRequestTask(id, taskId);
    const [created] = await this.repository.changeRequests(site.siteId, 1);
    return this.toChangeRequest(created as ChangeRequestRecord, async () => null);
  }

  async changeRequests(auth: AuthContext, siteId: string): Promise<ChangeRequest[]> {
    const { site } = await this.clientSite(auth, siteId);
    return Promise.all(
      (await this.repository.changeRequests(site.siteId, LIST_LIMIT)).map((request) =>
        this.toChangeRequest(request, async () => null),
      ),
    );
  }

  async approvals(auth: AuthContext, siteId: string): Promise<SiteApproval[]> {
    return this.approvalsOf((await this.clientSite(auth, siteId)).site);
  }

  async decide(
    auth: AuthContext,
    siteId: string,
    approvalId: string,
    input: DecideApproval,
  ): Promise<SiteApproval> {
    const request = DecideApprovalSchema.parse(input);
    const { userId, site } = await this.clientSite(auth, siteId);
    const decided = await this.repository.decide(site.siteId, approvalId, {
      status: request.decision,
      comment: request.comment,
      userId,
      now: this.clock.now(),
    });
    if (!decided) throw new ConflictError('This version was already decided or withdrawn.');
    await this.crm.followUp(site.organizationId, site.businessId, {
      title:
        request.decision === 'approved'
          ? `Client approved version ${decided.versionNumber} of ${site.name}`
          : `Client asked for changes to version ${decided.versionNumber} of ${site.name}`,
      type: 'follow_up',
      dueAt: null,
      assigneeId: await this.crm.ownerOf(site.organizationId, site.businessId),
    });
    return this.toApproval(decided, site);
  }

  // ── Mapping ───────────────────────────────────────────────────────────────────────────────────────────────────

  private toPortalSite(site: PortalSiteRecord): PortalSite {
    return {
      siteId: site.siteId,
      name: site.name,
      status: site.status,
      liveUrl: site.liveHostname ? publicationUrl(site.liveHostname) : null,
      previewUrl: site.previewHostname ? publicationUrl(site.previewHostname) : null,
      pendingApprovals: site.pendingApprovals,
    };
  }

  private async approvalsOf(site: PortalSiteRecord): Promise<SiteApproval[]> {
    return (await this.repository.approvals(site.siteId, LIST_LIMIT)).map((approval) =>
      this.toApproval(approval, site),
    );
  }

  private toApproval(approval: ApprovalRecord, site: PortalSiteRecord): SiteApproval {
    return {
      id: approval.id,
      siteId: approval.siteId,
      versionId: approval.versionId,
      versionNumber: approval.versionNumber,
      // DECISION(BF-062): the proposed version is looked at on the site's active preview; the agency publishes it
      // there before asking (the link is null when no preview is up).
      previewUrl: site.previewHostname ? publicationUrl(site.previewHostname) : null,
      note: approval.note,
      status: approval.status,
      comment: approval.comment,
      requestedAt: approval.requestedAt.toISOString(),
      decidedAt: approval.decidedAt?.toISOString() ?? null,
    };
  }

  private async toChangeRequest(
    request: ChangeRequestRecord,
    link: (key: string) => Promise<string | null>,
  ): Promise<ChangeRequest> {
    return {
      id: request.id,
      siteId: request.siteId,
      message: request.message,
      pageHint: request.pageHint,
      attachments: await Promise.all(
        request.attachments.map(async (file) => ({
          id: file.id,
          url: await link(file.objectKey),
          contentType: file.contentType,
        })),
      ),
      taskId: request.taskId,
      createdAt: request.createdAt.toISOString(),
    };
  }
}
