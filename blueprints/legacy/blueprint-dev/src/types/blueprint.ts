/**
 * Blueprint topic configuration
 */
export interface BlueprintTopic {
  name: string;
  description: string;
  messageRetention?: string;
}

/**
 * Blueprint config settings
 */
export interface BlueprintConfig {
  topics: BlueprintTopic[];
  settings?: {
    rateLimit?: string;
    maxPayloadSize?: number;
  };
}

/**
 * Blueprint format matching Titus export format
 */
export interface Blueprint {
  blueprintId: string;
  name: string;
  description: string;
  version: string;
  category: string;
  framework: 'vue' | 'react';
  files: Record<string, string>;
  dependencies?: Record<string, string>;
  config: BlueprintConfig;
  exportedAt?: string;
}

/**
 * Blueprint registry entry (minimal info for listing)
 */
export interface BlueprintEntry {
  blueprintId: string;
  name: string;
  description: string;
  framework: 'vue' | 'react';
}
