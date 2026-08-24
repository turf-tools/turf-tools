import type { SVGProps } from "react";
import type { IconName } from "~/lib/icon-names";

// Sprite-backed replacement for inline lucide-react components on
// row-repeated surfaces: two DOM nodes per icon instead of an inline
// path tree, which dominated SSR document size on big tables. Symbols
// live in /sprite.svg (see scripts/generate-sprite.mjs). Styling
// matches lucide-react — size/stroke utilities on the svg inherit into
// the symbol.
export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      <use href={`/sprite.svg#${name}`} />
    </svg>
  );
}
