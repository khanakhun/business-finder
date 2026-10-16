import type { SiteImageProps, SiteLinkProps } from './types.ts';

/** The default image: a responsive `<img>` with explicit dimensions (no layout shift), lazy unless a priority. */
export function ResponsiveImage({
  src,
  srcSet,
  sizes,
  alt,
  width,
  height,
  priority,
  className,
  style,
}: SiteImageProps) {
  return (
    <img
      src={src}
      srcSet={srcSet}
      sizes={srcSet ? sizes : undefined}
      alt={alt}
      width={width}
      height={height}
      loading={priority ? 'eager' : 'lazy'}
      decoding={priority ? 'auto' : 'async'}
      fetchPriority={priority ? 'high' : undefined}
      className={className}
      style={style}
    />
  );
}

/** The default link: a plain anchor. */
export function PlainLink({ href, children, ...rest }: SiteLinkProps) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
