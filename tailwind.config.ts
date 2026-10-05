import { tailwindBaseConfig } from '@bodyguard-ai/tailwind-config'
import type { Config } from 'tailwindcss'

/** Bodyguard's shared theme (Inter, palette, forms plugin): the same base the dashboard loads. */
export default { ...tailwindBaseConfig, content: [] } satisfies Config
