import type { BlockProps } from '../renderer/types.ts';
import { cx, itemHeading, Media, Section, SectionHead } from './shared.tsx';

/** The people the business presents publicly. */
export function Team({ block, ctx, tone }: BlockProps<'team'>) {
  const { props, variant } = block;
  const members = props.members;
  const Name = itemHeading(props.heading);
  const initials = (name: string) =>
    name
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  return (
    <Section id={block.id} type="team" variant={variant} tone={tone} labelled={Boolean(props.heading)}>
      <div className="bf-container">
        <SectionHead blockId={block.id} heading={props.heading} ctx={ctx} />
        <ul
          className={cx(
            variant === 'grid'
              ? 'grid justify-center gap-[var(--bf-gap)] [grid-template-columns:repeat(auto-fit,minmax(13rem,17rem))]'
              : 'bf-divided mx-auto max-w-3xl',
          )}
        >
          {members.map((member) => {
            const photo = ctx.image(member.photoAssetId);
            return (
              <li
                key={member.factId}
                className={cx(
                  variant === 'grid' ? 'flex flex-col gap-4' : 'flex items-center gap-5 py-5',
                  variant === 'grid' && !photo && 'bf-card items-center text-center',
                )}
              >
                {photo ? (
                  <Media
                    assetId={member.photoAssetId}
                    ctx={ctx}
                    ratio={variant === 'grid' ? 'portrait' : 'square'}
                    sizes={variant === 'grid' ? '(min-width: 64rem) 25vw, 50vw' : '5rem'}
                    className={variant === 'list' ? 'w-20 shrink-0' : undefined}
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="bf-icon-badge !h-20 !w-20 shrink-0 !rounded-full font-heading text-2xl"
                  >
                    {initials(member.name)}
                  </span>
                )}
                <div className="flex flex-col gap-1">
                  <Name className="bf-h3">{member.name}</Name>
                  {member.role ? <p className="bf-muted">{ctx.t(member.role)}</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Section>
  );
}
