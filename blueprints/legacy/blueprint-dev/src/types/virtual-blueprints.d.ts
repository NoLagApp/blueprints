declare module 'virtual:blueprints' {
  import type { Blueprint } from './blueprint'

  export function getBlueprint(id: string): Blueprint | null
  export function getAllBlueprints(): Blueprint[]
  export const blueprintIds: string[]
}

declare module 'virtual:blueprint-registry' {
  import type { BlueprintEntry } from './blueprint'

  export const registry: BlueprintEntry[]
}

declare module 'virtual:blueprint:*' {
  import type { Blueprint } from './blueprint'
  const blueprint: Blueprint | null
  export default blueprint
}
