import type { CSSProperties } from 'react'

interface LogoProps {
  className?: string
  size?: number
  style?: CSSProperties
}

/** 视口展示原始品牌资产的无限环；不重绘、不改色，保留 size 接口。 */
export function Logo({ className, size = 32, style }: LogoProps) {
  return (
    <svg viewBox="24 132 526 300" width={size} height={size}
      className={className} style={style} role="img" aria-label="天玑实验室">
      <image href="/brand/tianji-original.png" width="1550" height="546" />
    </svg>
  )
}
